import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, mkdirSync, writeFileSync, renameSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { BridgeError } from './member-control.js';

const fail = (code, details, status = 409) => {
  const error = new BridgeError(code, status); error.details = details; throw error;
};
const same = (a, b) => a.current_preset === b.current_preset
  && a.sandbox === b.sandbox && a.approval === b.approval && a.revision === b.revision
  && a.workspace === b.workspace;
const requestedSpec = (view, preset) => preset === null
  ? { preset: view.current_preset, sandbox: view.sandbox, approval: view.approval }
  : { preset, ...view.preset_specs?.[preset] };
const matches = (view, spec) => view.current_preset === spec.preset
  && view.sandbox === spec.sandbox && view.approval === spec.approval;

/** Bridge-owned preferences only. Loading/reading this store never sets permissions. */
export function connectionStore(file) {
  let value = file && existsSync(file) ? JSON.parse(readFileSync(file, 'utf8'))
    : { schema: 'bridge-connection-preferences/1', sessions: {} };
  if (value.schema !== 'bridge-connection-preferences/1' || !value.sessions
    || typeof value.sessions !== 'object' || Array.isArray(value.sessions)
    || Object.values(value.sessions).some(row => !row || (row.workspace !== undefined
      && (typeof row.workspace !== 'string' || !isAbsolute(row.workspace)))))
    fail('CONNECTION_STORE_INVALID', undefined, 503);
  return {
    get: id => value.sessions[id] ?? null,
    entries: () => Object.entries(structuredClone(value.sessions)),
    set(id, preference) {
      const next = structuredClone(value); next.sessions[id] = preference;
      if (file) {
        mkdirSync(dirname(file), { recursive: true });
        const temporary = file + '.' + randomBytes(8).toString('hex') + '.tmp';
        writeFileSync(temporary, JSON.stringify(next, null, 2), { encoding: 'utf8', flag: 'wx', flush: true });
        renameSync(temporary, file);
      }
      value = next;
    },
  };
}

/** Explicit prepare -> user confirmation -> native set -> readback -> connection. */
export function createConnectionControl(permissions, life, options = {}) {
  const store = options.store ?? connectionStore(options.file);
  const plans = new Map(); const settling = new Set();
  const now = options.now ?? Date.now;
  const alive = () => { if (life.closed) fail('BRIDGE_UNLOADED', undefined, 503); };
  function select(view, preset) {
    if (preset !== null && (typeof preset !== 'string' || !Object.hasOwn(view.preset_specs ?? {}, preset)))
      fail('NATIVE_PRESET_UNAVAILABLE', { session_id: view.session_id });
    const spec = requestedSpec(view, preset);
    if (!view.native_state_known || typeof spec.sandbox !== 'string' || typeof spec.approval !== 'string')
      fail('NATIVE_PERMISSION_STATE_UNAVAILABLE', { session_id: view.session_id,
        current: view, permission_changed: false }, 503);
    return spec;
  }
  async function currentForConnection(sessionId) {
    alive(); let current = await permissions.query(sessionId);
    if (!current.native_state_known && typeof permissions.load === 'function')
      current = await permissions.load(sessionId);
    alive(); return current;
  }
  function snapshotOf(sessionId, current) {
    const saved = store.get(sessionId);
    const desired = saved?.preset ?? null;
    const spec = desired === null ? requestedSpec(current, null) : requestedSpec(current, desired);
    const matched = current.native_state_known && matches(current, spec);
    return { session_id: sessionId, current, selected_preset: desired,
      required: spec, preference_saved: saved?.binding_enabled !== false && Boolean(saved),
      matched, state: !current.native_state_known ? 'permission_state_unknown'
        : matched ? 'matched' : 'permission_confirmation_required',
      connected: saved?.binding_enabled === true && matched,
      connection_requirement: 'user-selected official preset; null means keep current',
      permission_changes_on_read: false };
  }
  async function snapshot(sessionId) {
    alive(); return snapshotOf(sessionId, await permissions.query(sessionId));
  }
  async function prepare(sessionId, preset = null) {
    alive(); const current = await currentForConnection(sessionId); const desired = select(current, preset);
    const id = 'codex-connect-' + randomBytes(12).toString('hex');
    const plan = { plan_id: id, session_id: sessionId, selected_preset: preset,
      before: current, desired, confirmation_required: !matches(current, desired),
      expires_at: now() + 120000, state: 'prepared' };
    plans.set(id, plan); return structuredClone(plan);
  }
  function getPlan(sessionId, id) {
    const plan = plans.get(id);
    if (!plan || plan.session_id !== sessionId) fail('CONNECTION_PLAN_NOT_FOUND');
    if (plan.state !== 'prepared') fail('CONNECTION_PLAN_ALREADY_SETTLED');
    if (plan.expires_at < now()) { plans.delete(id); fail('CONNECTION_CONFIRMATION_EXPIRED'); }
    return plan;
  }
  function cancel(sessionId, id) {
    alive(); const plan = getPlan(sessionId, id); plan.state = 'cancelled'; plans.delete(id);
    return { session_id: sessionId, cancelled: true, permission_changed: false, preference_changed: false };
  }
  async function confirm(sessionId, id, confirmation = null) {
    alive(); const plan = getPlan(sessionId, id);
    if (plan.confirmation_required && (!confirmation || confirmation.accepted !== true
      || confirmation.session_id !== sessionId || confirmation.from_preset !== plan.before.current_preset
      || confirmation.to_preset !== plan.desired.preset
      || confirmation.expected_revision !== plan.before.revision))
      fail('SPECIFIC_PERMISSION_CONFIRMATION_REQUIRED', { plan: structuredClone(plan) });
    // Claim before the first await so two confirmations cannot consume one plan.
    plan.state = 'checking';
    if (settling.has(sessionId)) fail('CONNECTION_CHANGE_IN_PROGRESS');
    settling.add(sessionId);
    try {
      const before = await currentForConnection(sessionId);
      if (!same(plan.before, before)) fail('PERMISSION_CHANGED_REFRESH_REQUIRED', { current: before });
      plan.state = 'applying';
      if (plan.confirmation_required) await permissions.change({ session_id: sessionId,
        request_id: plan.plan_id, preset: plan.desired.preset, expected_revision: before.revision });
      const after = await permissions.query(sessionId);
      if (!matches(after, plan.desired) || after.workspace !== plan.before.workspace) fail('CONNECTION_PERMISSION_READBACK_MISMATCH',
        { current: after, connection_established: false, native_change_may_have_applied: plan.confirmation_required });
      if (typeof after.workspace !== 'string' || !isAbsolute(after.workspace))
        fail('CONNECTION_WORKSPACE_UNAVAILABLE', { connection_established: false }, 503);
      const preference = { preset: plan.selected_preset, workspace: resolve(after.workspace), saved_at: new Date(now()).toISOString(),
        binding_enabled: true,
        ...(typeof after.title === 'string' ? { expected_title: after.title } : {}) };
      try { store.set(sessionId, preference); }
      catch { fail('CONNECTION_PREFERENCE_SAVE_FAILED', { current: after,
        connection_established: false, native_change_may_have_applied: plan.confirmation_required }, 503); }
      plan.state = 'completed'; plans.delete(id);
      return { saved: true, session_id: sessionId, selected_preset: plan.selected_preset,
        connected: true, matched: true, before, after, permission_changed: plan.confirmation_required };
    } catch (error) {
      plan.state = 'failed'; plans.delete(id);
      // Never restore a previous, possibly broader mode behind the user's back.
      if (error instanceof BridgeError) throw error;
      fail('OFFICIAL_PERMISSION_API_FAILED', { connection_established: false,
        original_state_not_silently_overwritten: true, native_change_may_have_applied: plan.confirmation_required }, 503);
    } finally { settling.delete(sessionId); }
  }
  function unbind(sessionId) {
    alive();
    if (settling.has(sessionId)) fail('CONNECTION_CHANGE_IN_PROGRESS');
    // A tombstone also overrides a legacy/static binding after a restart.
    // It changes only bridge admission; native permissions/history are untouched.
    store.set(sessionId, { ...store.get(sessionId), binding_enabled: false,
      unbound_at: new Date(now()).toISOString() });
    for (const [id, plan] of plans) if (plan.session_id === sessionId) plans.delete(id);
    return { session_id: sessionId, bound: false, permission_changed: false,
      other_bindings_unchanged: true };
  }
  async function admission(sessionId) {
    // Preserve legacy callers: no saved requirement means no new implicit permission policy.
    if (!store.get(sessionId)) return { matched: true, inherited_current: true };
    const view = snapshotOf(sessionId, await currentForConnection(sessionId));
    if (view.matched) return { matched: true, current: view.current };
    if (!view.current.native_state_known) return { matched: false, state: 'permission_state_unknown',
      session_id: sessionId, current: view.current, required: view.required,
      permission_changed: false, automatic_retry: false };
    return { matched: false, state: 'permission_confirmation_required', session_id: sessionId,
      current: view.current, required: view.required,
      resolution: { panel: 'settings.section/codex-bridge-connection', prepare: '/sessions/connection/prepare' },
      permission_changed: false, automatic_retry: false };
  }
  const binding = id => {
    const preference = store.get(id);
    return preference?.binding_enabled === true ? { session_id: id,
      ...(preference.workspace === undefined ? {} : { workspace: preference.workspace }),
      ...(typeof preference.expected_title === 'string' ? { expected_title: preference.expected_title } : {}) } : null;
  };
  return { snapshot, prepare, confirm, cancel, admission, binding, unbind,
    bindingRecord: id => structuredClone(store.get(id)),
    changing: id => settling.has(id),
    bindingDisabled: id => store.get(id)?.binding_enabled === false,
    bindings: () => (store.entries?.() ?? []).filter(([, row]) => row.binding_enabled === true)
      .map(([id]) => binding(id)) };
}
