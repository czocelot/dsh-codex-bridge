import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync, statSync, unlinkSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { BridgeError, nativeServices, sameWorkspace } from './member-control.js';
import { permissionChoice, selectPermission, applyRotationPermission } from './rotation-permission.js';

const requestIdOK = value => typeof value === 'string' && /^codex-[a-zA-Z0-9_-]{1,100}$/.test(value);
const sessionIdOK = value => typeof value === 'string' && /^session-[a-zA-Z0-9-]{8,100}$/.test(value);
const fail = (code, status = 409) => { throw new BridgeError(code, status); };
const phases = ['prepared', 'creation_started', 'creation_uncertain', 'created', 'completed'];

function readRows(file) {
  if (!file || !existsSync(file)) return new Map();
  if (statSync(file).size > 20000000) fail('CREATE_LEDGER_LIMIT', 503);
  let data;
  try { data = JSON.parse(readFileSync(file, 'utf8')); }
  catch { fail('CREATE_LEDGER_INVALID', 503); }
  if (data?.version !== 1 || !Array.isArray(data.requests) || data.requests.length > 10000)
    fail('CREATE_LEDGER_INVALID', 503);
  const rows = new Map();
  for (const row of data.requests) {
    if (!requestIdOK(row?.request_id) || rows.has(row.request_id)
      || !/^[a-f0-9]{64}$/.test(row.digest ?? '') || !phases.includes(row.phase)
      || typeof row.workspace_id !== 'string' || !row.workspace_id
      || typeof row.workspace_path !== 'string' || !isAbsolute(row.workspace_path)
      || !['native', 'follow', 'explicit'].includes(row.desired_permission?.mode)
      || (row.session_id !== undefined && !sessionIdOK(row.session_id))
      || (['created', 'completed'].includes(row.phase) && !row.session_id))
      fail('CREATE_LEDGER_INVALID', 503);
    rows.set(row.request_id, row);
  }
  return rows;
}

/** Create an empty ordinary native session; no prompt, binding or global selection. */
export function createStandaloneSessions(ctx, life, internals, options = {}) {
  const { settingsPermissions: settings, inspectTarget } = internals;
  const file = options.file, rows = readRows(file), flights = new Map();
  life.active ??= new Set();
  const host = () => nativeServices(ctx, ['workspaceRegistry', 'sessionController']);
  const alive = () => { if (life.closed) fail('BRIDGE_UNLOADED', 503); };
  function save() {
    if (!file) return;
    mkdirSync(dirname(file), { recursive: true });
    const temp = file + '.' + randomBytes(6).toString('hex') + '.tmp';
    try {
      writeFileSync(temp, JSON.stringify({ version: 1, requests: [...rows.values()] }, null, 2),
        { flag: 'wx', flush: true });
      renameSync(temp, file);
    } finally { try { unlinkSync(temp); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
  }
  function workspaces() {
    alive();
    return host().workspaceRegistry.list().map(w => ({ workspace_id: w.id, title: w.title, path: w.path }));
  }
  function status(id) {
    alive();
    if (!requestIdOK(id)) fail('INVALID_CREATE_REQUEST_ID', 400);
    const row = rows.get(id);
    if (!row) fail('CREATE_REQUEST_NOT_FOUND', 404);
    // Digests and the permission plan are private implementation state.
    const { digest, desired_permission, ...result } = row;
    return structuredClone({ ...result, permission_mode: desired_permission.mode });
  }
  function workspaceFor(row) {
    alive();
    const w = host().workspaceRegistry.get(row.workspace_id);
    if (!w || w.id !== row.workspace_id || !sameWorkspace(w.path, row.workspace_path, resolve))
      fail('CREATE_WORKSPACE_CHANGED');
    return w;
  }
  async function inspectCreated(row) {
    const w = workspaceFor(row);
    if (!w.sessionIds.includes(row.session_id)) fail('CREATED_SESSION_WORKSPACE_MISMATCH');
    const target = await inspectTarget(row.session_id, false, row.workspace_path);
    alive();
    if (target.header.id !== row.session_id || target.header.origin === 'subagent'
      || !sameWorkspace(target.header.cwd, row.workspace_path, resolve)
      || !workspaceFor(row).sessionIds.includes(row.session_id)) fail('CREATED_SESSION_WORKSPACE_MISMATCH');
    return target;
  }
  function create(request) {
    alive();
    if (!request || typeof request !== 'object' || Array.isArray(request)
      || Object.keys(request).some(k => !['request_id', 'workspace_id', 'title', 'permission_mode',
        'permission_preset', 'source_session_id'].includes(k))
      || !requestIdOK(request.request_id) || typeof request.workspace_id !== 'string'
      || !request.workspace_id.trim() || request.workspace_id.length > 200
      || (request.title !== undefined && (typeof request.title !== 'string'
        || !request.title.trim() || request.title.length > 200))) fail('INVALID_SESSION_CREATE', 400);
    const choice = permissionChoice(request);
    if (choice.mode === 'follow' && !sessionIdOK(request.source_session_id)) fail('FOLLOW_SOURCE_REQUIRED', 400);
    if (choice.mode !== 'follow' && request.source_session_id !== undefined) fail('SOURCE_ONLY_VALID_FOR_FOLLOW', 400);
    const digest = createHash('sha256').update(JSON.stringify(Object.fromEntries(
      Object.entries(request).sort(([a], [b]) => a.localeCompare(b))))).digest('hex');
    let row = rows.get(request.request_id);
    const flight = flights.get(request.request_id);
    if ((row && row.digest !== digest) || (flight && flight.digest !== digest)) fail('CREATE_REQUEST_CONTENT_MISMATCH');
    if (row?.phase === 'completed') return Promise.resolve(status(request.request_id));
    if (flight) return flight.promise;

    // Register before any awaited source read: concurrent retries share one creation.
    const work = Promise.resolve().then(async () => {
      alive();
      const native = host(), workspace = native.workspaceRegistry.get(request.workspace_id);
      if (!workspace || workspace.id !== request.workspace_id || typeof workspace.path !== 'string'
        || !isAbsolute(workspace.path)) fail('WORKSPACE_NOT_FOUND', 404);
      const workspacePath = workspace.path;
      if (!row) {
        if (rows.size >= 10000) fail('CREATE_LEDGER_LIMIT', 503);
        let desired = { mode: 'native' };
        if (choice.mode === 'follow') desired = selectPermission(request, await settings.query(request.source_session_id));
        else if (choice.mode === 'explicit') {
          const service = nativeServices(ctx, ['permissionPresets']).permissionPresets;
          let spec;
          try { spec = service.resolve(choice.preset); } catch { fail('NATIVE_PRESET_UNAVAILABLE'); }
          desired = selectPermission(request, { preset_specs: { [choice.preset]: spec } });
        }
        alive();
        row = { request_id: request.request_id, digest, workspace_id: workspace.id,
          workspace_path: workspacePath, desired_permission: desired, phase: 'prepared',
          created_at: new Date().toISOString(), initial_message_sent: false, bridge_bound: false };
        rows.set(request.request_id, row);
        save();
      }
      workspaceFor(row);
      if (!row.session_id) {
        // Persist the fence first. An unknown native outcome must never create a second session.
        if (row.phase !== 'prepared') fail('UNCERTAIN_CREATION_DO_NOT_RESUBMIT');
        row.phase = 'creation_started'; save();
        try {
          const made = await native.sessionController.create({ workspaceId: row.workspace_id });
          if (!sessionIdOK(made?.sessionId)) fail('NATIVE_CREATE_IDENTITY_INVALID', 503);
          row.session_id = made.sessionId; row.phase = 'created'; save();
        } catch (error) {
          if (!row.session_id) row.phase = 'creation_uncertain';
          save(); throw error;
        }
      }
      await inspectCreated(row);
      if (request.title !== undefined) {
        const renamed = await native.sessionController.rename({ sessionId: row.session_id, title: request.title });
        const current = await inspectCreated(row);
        if (current.title !== (renamed?.title ?? request.title.trim())) fail('CREATED_SESSION_TITLE_READBACK_FAILED');
      }
      const current = await settings.load(row.session_id);
      await inspectCreated(row);
      let permission = current;
      if (row.desired_permission.mode !== 'native') {
        const guardedSettings = {
          async query(id) { await inspectCreated(row); return settings.query(id); },
          async change(value) { await inspectCreated(row); return settings.change(value); },
        };
        permission = await applyRotationPermission(guardedSettings, row.session_id,
          'codex-create-' + digest.slice(0, 48), row.desired_permission);
      }
      // Native mode deliberately does not resolve, normalize or set a preset.
      const final = await inspectCreated(row);
      row.title = final.title;
      row.permission = { preset: permission.current_preset, sandbox: permission.sandbox, approval: permission.approval };
      row.phase = 'completed'; delete row.error; save();
      return status(request.request_id);
    }).catch(error => {
      if (row) { row.error = { code: error instanceof BridgeError ? error.code : 'NATIVE_SESSION_CREATE_FAILED' }; save(); }
      throw error;
    }).finally(() => { flights.delete(request.request_id); life.active.delete(work); });
    flights.set(request.request_id, { digest, promise: work });
    life.active.add(work);
    return work;
  }
  return { create, status, workspaces };
}
