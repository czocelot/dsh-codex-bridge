import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { BridgeError, nativeServices } from './member-control.js';

const permissionEvents = new Set(['permission/preset', 'sandbox/mode', 'approval/policy']);
const hash = value => createHash('sha256').update(value).digest('hex');
const fail = (code, status = 400, details) => {
  const error = new BridgeError(code, status);
  if (details) error.details = details;
  throw error;
};
const revisionOf = events => events.filter(event => permissionEvents.has(event.type))
  .reduce((latest, event) => Math.max(latest, Number.isSafeInteger(event.seq) ? event.seq : -1), -1);
const functionText = value => {
  if (typeof value !== 'function') return '';
  const text = Function.prototype.toString.call(value);
  return text.includes('[native code]') ? '' : text;
};

/** Read existing official services. This module never registers a preset or reviewer. */
export function nativePermissionDiagnostics(ctx) {
  const root = ctx.root ?? ctx;
  const { permissionPresets } = nativeServices(ctx, ['permissionPresets']);
  const constructor = functionText(permissionPresets.constructor);
  let loader;
  try { loader = typeof root.get === 'function' ? root.get('loader') : root.loader; } catch {}
  const names = ['@deepseek-ai/dsh-permission-presets', '@deepseek-ai/dsh-experimental-auto-review'];
  const entries = loader?.entries ? [...loader.entries()].filter(entry => !entry.options?.group
    && names.includes(entry.options?.name)) : [];
  const components = names.map(name => {
    const matches = entries.filter(entry => entry.options.name === name);
    return { module_name: name, registered_entries: matches.length,
      active_entries: matches.filter(entry => !entry.disabled && entry.fiber?.state === 2).length,
      entries: matches.map(entry => {
        const plugin = entry.fiber?.runtime?.plugin;
        const apply = functionText(typeof plugin === 'function' ? plugin : plugin?.apply);
        return { entry_key: hash(String(entry.id)).slice(0, 16), enabled: !entry.disabled,
          fiber_state: entry.fiber?.state ?? null,
          loaded_apply_inspectable: Boolean(apply),
          loaded_apply_sha256: apply ? hash(apply) : null,
          official_review_call_present: apply ? apply.includes('classifyRisk(ctx, agent, exec') : null,
          unsafe_auto_release_present: apply ? /permissionPresets\.set\(session, ["']danger-full-access/.test(apply) : null };
      }) };
  });
  return { source: 'existing-native-services-and-loader', registry_inspectable: Boolean(loader?.entries),
    root_permission_service_present: true,
    root_permission_service_class: permissionPresets.constructor?.name ?? null,
    permission_constructor_inspectable: Boolean(constructor),
    loaded_permission_constructor_sha256: constructor ? hash(constructor) : null,
    reload_gap_guard_present: constructor ? constructor.includes('Auto review is unavailable or its permission state is inconsistent') : null,
    auto_available: permissionPresets.names.includes('auto'), components };
}

/** Session-scoped adapter over PermissionPresetService.current/resolve/set. */
export function createPermissionControl(ctx, life, target, pending, options = {}) {
  const completed = new Map();
  const loading = new Map();
  const auditFile = options.auditFile ?? fileURLToPath(new URL('../permission-audit.jsonl', import.meta.url));
  const audit = options.audit ?? (record => {
    mkdirSync(dirname(auditFile), { recursive: true });
    appendFileSync(auditFile, JSON.stringify({ schema: 'bridge-permission-request/1', ...record }) + '\n', { encoding: 'utf8', flush: true });
  });
  const native = () => nativeServices(ctx, ['permissionPresets']).permissionPresets;
  const alive = () => { if (life.closed) fail('BRIDGE_UNLOADED', 503); };
  function view(session, service) {
    const { sessionProjections } = nativeServices(ctx, ['sessionProjections']);
    const state = sessionProjections.stateOf(session, 'permissions');
    if (!state) fail('NATIVE_PERMISSION_STATE_UNAVAILABLE', 503);
    return { current_preset: service.current(session), sandbox: state.sandbox, approval: state.approval,
      revision: revisionOf(session.snapshotEvents()), native_state_known: true };
  }
  function catalog(service) {
    return service.catalog().options;
  }

  async function query(sessionId) {
    alive();
    const host = await target(sessionId);
    const service = native();
    const session = host.sessions.get(sessionId);
    let state;
    if (session) state = view(session, service);
    else {
      // Observation is read-only: never resume an Agent merely to read settings.
      const observation = await host.sessionQuery.observeSession(sessionId);
      try {
        const preset = observation.projections?.values?.permissions?.currentValue;
        if (typeof preset !== 'string') fail('NATIVE_COLD_PERMISSION_VIEW_UNAVAILABLE', 503);
        state = { current_preset: preset, sandbox: null, approval: null,
          revision: revisionOf(observation.events ?? []), native_state_known: false };
      } finally { observation[Symbol.dispose]?.(); }
    }
    return { session_id: sessionId, attached: Boolean(session), ...state,
      auto_available: service.names.includes('auto'), presets: catalog(service),
      preset_specs: Object.fromEntries(service.names.map(name => {
        const spec = service.resolve(name);
        return [name, { sandbox: spec.sandbox, approval: spec.approval }];
      })),
      native_components: nativePermissionDiagnostics(ctx), permission_source: 'official-permission-presets',
      ...(options.persistence ? { bridge_persistence: options.persistence.status(sessionId) } : {}) };
  }

  // Only an explicit connection operation or an already-authorized prompt uses
  // this path. Passive reads above remain passive. Resolve through the same
  // official controller as normal session opening; never manufacture permission
  // values from the saved bridge preference or submit a model prompt here.
  async function load(sessionId) {
    alive();
    if (loading.has(sessionId)) return loading.get(sessionId);
    const work = (async () => {
      const host = await target(sessionId);
      if (!host.sessions.get(sessionId)) {
        if (typeof host.sessionController?.resolveAgent !== 'function')
          fail('NATIVE_SESSION_LOAD_UNAVAILABLE', 503);
        let found;
        try { found = await host.sessionController.resolveAgent(sessionId); }
        catch (error) {
          fail('NATIVE_SESSION_LOAD_FAILED', 503, { session_id: sessionId,
            native_code: typeof error?.code === 'string' ? error.code : null,
            permission_changed: false });
        }
        alive();
        if (found?.error) fail('NATIVE_SESSION_LOAD_FAILED', 503, {
          session_id: sessionId, native_code: found.error.code ?? null, permission_changed: false });
        const session = host.sessions.get(sessionId), agent = found?.agent ?? found;
        if (!session || session.id !== sessionId || (agent?.id && agent.id !== sessionId))
          fail('NATIVE_SESSION_LOAD_IDENTITY_MISMATCH', 503);
        // Revalidate the stable ID/workspace after the awaited native activation.
        await target(sessionId);
      }
      alive();
      const current = await query(sessionId);
      if (!current.native_state_known) fail('NATIVE_PERMISSION_STATE_UNAVAILABLE', 503,
        { session_id: sessionId, permission_changed: false });
      return current;
    })();
    loading.set(sessionId, work);
    try { return await work; } finally { loading.delete(sessionId); }
  }

  async function change(request) {
    alive();
    if (!request || typeof request !== 'object' || Array.isArray(request)
      || Object.keys(request).some(key => !['session_id', 'request_id', 'preset', 'expected_revision'].includes(key))
      || typeof request.request_id !== 'string' || !/^codex-[a-zA-Z0-9_-]{1,100}$/.test(request.request_id)
      || typeof request.preset !== 'string' || request.preset.length > 100
      || !Number.isSafeInteger(request.expected_revision) || request.expected_revision < -1)
      fail('INVALID_PERMISSION_REQUEST');
    const signature = JSON.stringify([request.session_id, request.preset, request.expected_revision]);
    const previous = completed.get(request.request_id);
    if (previous && previous.signature !== signature) fail('PERMISSION_REQUEST_ID_CONFLICT', 409);
    if (previous) return { ...previous.result, duplicate: true, current: await query(request.session_id) };
    const host = await target(request.session_id);
    const service = native();
    let spec;
    try { spec = service.resolve(request.preset); }
    catch { fail('NATIVE_PRESET_UNAVAILABLE', 409); }
    const session = host.sessions.get(request.session_id);
    // Agent.resume starts a loop. Do not start a model task as a settings side effect.
    if (!session) fail('SESSION_NOT_RESIDENT_OPEN_IN_NATIVE_UI', 409);
    const agent = host.agents.get(request.session_id);
    const inbox = pending(host, request.session_id);
    if ((agent && agent.status !== 'idle') || Object.values(inbox).some(items => items.length))
      fail('SESSION_BUSY_NO_PERMISSION_CHANGE', 409);
    const before = view(session, service);
    const noChange = before.current_preset === request.preset
      && before.sandbox === spec.sandbox && before.approval === spec.approval;
    if (!noChange && before.revision !== request.expected_revision) fail('PERMISSION_REVISION_CONFLICT', 409);
    const record = { source: 'explicit-bridge-permission-request', session_id: request.session_id,
      request_id: request.request_id, preset: request.preset, before, utc: new Date().toISOString() };
    try { audit({ ...record, phase: 'accepted' }); }
    catch { fail('PERMISSION_AUDIT_UNAVAILABLE_NO_CHANGE', 503); }
    if (!noChange) {
      try { service.set(session, request.preset); }
      catch {
        // The native setter owns persistence. Never roll back to greater privilege.
        let current;
        try { current = view(session, service); } catch { current = null; }
        try { audit({ ...record, phase: 'native-failed', current }); } catch {}
        fail('NATIVE_PERMISSION_CHANGE_NOT_CONFIRMED', 503,
          { session_id: request.session_id, request_id: request.request_id, current });
      }
    }
    const after = view(session, service);
    if (after.current_preset !== request.preset || after.sandbox !== spec.sandbox || after.approval !== spec.approval)
      fail('NATIVE_PERMISSION_READBACK_MISMATCH', 503, { session_id: request.session_id, current: after });
    if (options.persistence) {
      try { options.persistence.remember(request.session_id, request.preset, session, request.request_id); }
      catch { fail('PERMISSION_APPLIED_BRIDGE_PERSISTENCE_UNCONFIRMED', 503,
        { session_id: request.session_id, request_id: request.request_id, current: after, applied: !noChange }); }
    }
    const result = { session_id: request.session_id, request_id: request.request_id,
      changed: !noChange, persisted_by: 'official-permission-presets', before, after,
      ...(options.persistence ? { bridge_persistence: options.persistence.status(request.session_id) } : {}) };
    try { audit({ ...record, phase: 'completed', after, changed: !noChange }); }
    catch { fail('PERMISSION_APPLIED_AUDIT_UNCONFIRMED', 503, { ...result, applied: true }); }
    completed.set(request.request_id, { signature, result });
    return result;
  }
  return { query, load, change };
}
