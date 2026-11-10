import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync,
  renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { BridgeError, nativeServices } from './member-control.js';

const AUTO = '@deepseek-ai/dsh-experimental-auto-review';
const events = new Set(['permission/preset', 'sandbox/mode', 'approval/policy']);
const digest = value => createHash('sha256').update(value).digest('hex');
const fail = code => { throw new BridgeError(code, 503); };
const sessionOK = id => /^session-[a-zA-Z0-9-]{8,100}$/.test(id);

/** Own-plugin data only. A second loaded bridge cannot become another writer. */
export function openPermissionStore(file) {
  mkdirSync(dirname(file), { recursive: true });
  const lock = file + '.lock', token = randomUUID();
  if (existsSync(lock)) {
    if (lstatSync(lock).isSymbolicLink()) fail('PERMISSION_STORE_LOCK_UNSAFE');
    let prior;
    try { prior = JSON.parse(readFileSync(lock, 'utf8')); } catch { fail('PERMISSION_STORE_LOCK_INVALID'); }
    if (!Number.isSafeInteger(prior.pid) || prior.pid <= 0) fail('PERMISSION_STORE_LOCK_INVALID');
    let gone = false;
    try { process.kill(prior.pid, 0); } // Signal zero checks existence; it never terminates a process.
    catch (error) { gone = error.code === 'ESRCH'; }
    if (!gone) fail('PERMISSION_STORE_ALREADY_OWNED');
    renameSync(lock, lock + '.stale-' + randomUUID());
  }
  const fd = openSync(lock, 'wx', 0o600);
  writeFileSync(fd, JSON.stringify({ pid: process.pid, token })); fsyncSync(fd);
  let closed = false, previous = null;
  const close = () => {
    if (closed) return;
    closed = true; closeSync(fd);
    if (JSON.parse(readFileSync(lock, 'utf8')).token === token) unlinkSync(lock);
  };
  try {
    if (existsSync(file)) {
      if (lstatSync(file).isSymbolicLink() || lstatSync(file).size > 2000000) fail('PERMISSION_STORE_UNSAFE');
      previous = readFileSync(file, 'utf8');
    }
    const data = previous === null ? { version: 1, sessions: {} } : JSON.parse(previous);
    if (data.version !== 1 || !data.sessions || typeof data.sessions !== 'object'
      || Array.isArray(data.sessions) || Object.keys(data.sessions).length > 64
      || Object.entries(data.sessions).some(([id, row]) => !sessionOK(id) || !row
        || typeof row.preset !== 'string' || !row.seen || !Number.isSafeInteger(row.seen.revision)
        || !/^[a-f0-9]{64}$/.test(row.seen.fingerprint))) fail('PERMISSION_STORE_INVALID');
    return { data, write() {
      if (closed) fail('PERMISSION_STORE_CLOSED');
      const actual = existsSync(file) ? readFileSync(file, 'utf8') : null;
      if (actual !== previous) fail('PERMISSION_STORE_EXTERNAL_EDIT');
      const text = JSON.stringify(data, null, 2) + '\n';
      const temporary = file + '.tmp-' + randomUUID();
      const out = openSync(temporary, 'wx', 0o600);
      try { writeFileSync(out, text); fsyncSync(out); } finally { closeSync(out); }
      renameSync(temporary, file); previous = text;
    }, close };
  } catch (error) { close(); throw error; }
}

function facts(ctx, session) {
  const { permissionPresets, sessionProjections } = nativeServices(ctx, ['permissionPresets', 'sessionProjections']);
  const raw = sessionProjections.stateOf(session, 'permissions');
  if (!raw || typeof permissionPresets.current !== 'function' || typeof permissionPresets.set !== 'function'
    || typeof permissionPresets.resolve !== 'function' || !Array.isArray(permissionPresets.names))
    fail('NATIVE_PERMISSION_API_INCOMPATIBLE');
  const stream = session.snapshotEvents().filter(event => events.has(event.type)).map(event => ({
    seq: event.seq, type: event.type, value: event.type === 'permission/preset' ? event.data.preset
      : event.type === 'sandbox/mode' ? event.data.mode : event.data.policy }));
  const revision = stream.at(-1)?.seq ?? -1;
  return { preset: permissionPresets.current(session), raw_preset: raw.preset,
    sandbox: raw.sandbox, approval: raw.approval, revision,
    fingerprint: digest(JSON.stringify(stream)), stream };
}
const snapshot = view => Object.fromEntries(Object.entries(view).filter(([key]) => key !== 'stream'));
const same = (a, b) => a.revision === b.revision && a.fingerprint === b.fingerprint;
function officialRelease(view, before) {
  const prefix = view.stream.filter(event => event.seq <= before.revision);
  if (digest(JSON.stringify(prefix)) !== before.fingerprint) return false;
  const tail = view.stream.filter(event => event.seq > before.revision);
  const expected = [['permission/preset', 'danger-full-access'],
    ...(before.approval === 'never' ? [] : [['approval/policy', 'never']])];
  return tail.length === expected.length && tail.every((event, i) => event.type === expected[i][0]
    && event.value === expected[i][1]) && view.raw_preset === 'danger-full-access'
    && view.sandbox === before.sandbox && view.approval === 'never';
}

/** Uses official setters and lifecycle notifications; registers no preset/reviewer. */
export function createPermissionPersistence(ctx, life, target, pending, options) {
  const store = options.store ?? openPermissionStore(options.file);
  const rows = store.data.sessions, queued = new Set(), stopping = new Set();
  const disposers = [];
  let closed = false, lastError = null;
  const native = () => nativeServices(ctx, ['permissionPresets', 'sessions', 'loader']);
  const autoFibers = () => [...native().loader.entries()].filter(entry => !entry.options?.group
    && entry.options?.name === AUTO && !entry.disabled).map(entry => entry.fiber).filter(Boolean);
  const ready = () => {
    const fibers = autoFibers();
    return fibers.length === 1 && fibers[0].state === 2 && !stopping.has(fibers[0])
      && native().permissionPresets.names.includes('auto');
  };
  function save() { store.write(); }
  function adopt(row, view, source) {
    row.preset = view.preset; row.seen = snapshot(view); row.source = source;
    row.updated_at = new Date().toISOString(); delete row.release;
    row.status = 'synced'; save();
  }
  async function reconcile(id) {
    if (closed || life.closed || !rows[id]) return;
    const host = await target(id); // Exact bound ID, workspace and title checks; never resumes an Agent.
      if (closed || life.closed || !rows[id]) return;
    const row = rows[id], session = host.sessions.get(id);
    if (!session) { row.status = 'waiting-resident-session'; return; }
    const view = facts(ctx, session);
    if (!row.release) {
      if (!same(row.seen, view)) adopt(row, view, 'newer-native-selection');
      return;
    }
    if (same(row.release.before, view)) {
      if (ready()) { delete row.release; row.status = 'synced'; save(); }
      return;
    }
    if (!officialRelease(view, row.release.before)) {
      adopt(row, view, 'newer-native-selection-or-unmatched-release');
      return;
    }
    row.status = 'waiting-official-auto';
    if (!ready()) return;
    if ((host.agents.get(id)?.status ?? 'idle') !== 'idle'
      || Object.values(pending(host, id)).some(items => items.length)) {
      row.status = 'waiting-idle-session'; return;
    }
    const service = native().permissionPresets;
    let spec;
    try { spec = service.resolve(row.preset); } catch { row.status = 'native-preset-unavailable'; return; }
    // Restore only the recorded Auto lifecycle loss. No arbitrary old settings overwrite and no fallback.
    if (row.preset !== 'auto' || spec.sandbox !== row.release.before.sandbox || spec.approval !== 'ask') {
      row.status = 'native-preset-contract-changed'; return;
    }
    const check = facts(ctx, session);
    if (!same(view, check) || !ready()) { queue(id); return; }
    service.set(session, row.preset);
    const after = facts(ctx, session);
    if (after.preset !== row.preset || after.sandbox !== spec.sandbox || after.approval !== spec.approval)
      fail('NATIVE_PERMISSION_RESTORE_READBACK_MISMATCH');
    adopt(row, after, 'official-api-lifecycle-restore');
  }
  function queue(id) {
    if (closed || life.closed || queued.has(id) || !rows[id]) return;
    queued.add(id);
    queueMicrotask(() => {
      queued.delete(id);
      const work = reconcile(id).catch(error => { lastError = error.code ?? 'NATIVE_PERMISSION_RESTORE_FAILED'; });
      life.active.add(work); void work.finally(() => life.active.delete(work));
    });
  }
  function capture() {
    const { sessions } = native();
    for (const [id, row] of Object.entries(rows)) {
      const session = sessions.get(id);
      if (!session) continue;
      const view = facts(ctx, session);
      if (row.release && (same(row.release.before, view) || officialRelease(view, row.release.before))) continue;
      // A newer visible manual choice always supersedes the stored one before teardown.
      if (!same(row.seen, view)) adopt(row, view, 'newer-native-selection');
      if (row.preset !== 'auto' || view.raw_preset !== 'auto' || view.sandbox !== 'danger-full-access') continue;
      row.release = { before: snapshot(view), at: new Date().toISOString(), source: 'native-auto-ancestor-lifecycle' };
      row.status = 'official-auto-releasing'; save();
    }
  }
  function ancestor(candidate, child) {
    const seen = new Set();
    for (let current = child; current && !seen.has(current); current = current.parent?.fiber) {
      if (candidate === current) return true;
      seen.add(current);
    }
    return false;
  }
  function lifecycle(fiber, oldState) {
    if (closed || !fiber) return;
    const relevant = autoFibers().filter(auto => ancestor(fiber, auto));
    if (relevant.length && ((oldState === 2 && fiber.state !== 2) || fiber.uid === null)) {
      for (const auto of relevant) stopping.add(auto);
      capture();
    }
    if (fiber.state === 2) {
      stopping.delete(fiber);
      if (ready()) for (const id of Object.keys(rows)) queue(id);
    }
  }
  function listen(name, callback, config) {
    if (typeof ctx.on !== 'function') fail('NATIVE_LIFECYCLE_API_INCOMPATIBLE');
    disposers.push(ctx.on(name, (...args) => {
      try { return callback(...args); }
      catch (error) { lastError = error.code ?? 'BRIDGE_PERMISSION_OBSERVER_FAILED'; }
    }, config));
  }
  try {
    listen('session/event', (session, event) => { if (events.has(event.type) || rows[session.id]?.release) queue(session.id); });
    listen('session/created', session => queue(session.id));
    listen('permission-presets/catalog-changed', () => { for (const id of Object.keys(rows)) queue(id); });
    listen('internal/status', lifecycle, { global: true, prepend: true });
    listen('internal/plugin', fiber => { if (fiber?.uid === null) lifecycle(fiber); }, { global: true, prepend: true });
    for (const id of Object.keys(rows)) queue(id);
  } catch (error) { for (const dispose of disposers.reverse()) dispose?.(); store.close(); throw error; }
  return {
    forget(id) {
      if (!rows[id]) return;
      const previous = rows[id]; delete rows[id];
      try { save(); } catch (error) { rows[id] = previous; throw error; }
    },
    remember(id, preset, session, requestId) {
      if (closed || life.closed) fail('BRIDGE_UNLOADED');
      const view = facts(ctx, session);
      if (view.preset !== preset) fail('PERMISSION_SELECTION_READBACK_MISMATCH');
      rows[id] = { preset, seen: snapshot(view), request_id: requestId,
        source: 'explicit-bridge-selection', status: 'synced', updated_at: new Date().toISOString() };
      save();
    },
    status(id) { const row = rows[id]; return { enabled: true, managed: Boolean(row),
      selected_preset: row?.preset ?? null, status: row?.status ?? 'not-enrolled',
      source: row?.source ?? null, error: lastError, data_location: 'bridge-owned-plugin-data' }; },
    retry: id => queue(id),
    async settle() { await new Promise(resolve => queueMicrotask(resolve)); await Promise.allSettled([...life.active]); },
    dispose() {
      if (closed) return;
      closed = true;
      for (const dispose of disposers.reverse()) dispose?.();
      store.close();
    },
  };
}
