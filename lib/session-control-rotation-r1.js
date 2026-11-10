import { createHash } from 'node:crypto';
import { existsSync, readFileSync, mkdirSync, openSync, writeSync, fsyncSync, closeSync, statSync } from 'node:fs';
import { resolve, dirname, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BridgeError, nativeServices, sameWorkspace } from './member-control.js';
import { createPermissionControl } from './permission-control.js';
import { createPermissionPersistence } from './permission-persistence.js';
import { createConnectionControl } from './connection-control.js';

const sessionIdOK = value => typeof value === 'string' && /^session-[a-zA-Z0-9-]{8,100}$/.test(value);
const requestIdOK = value => typeof value === 'string' && /^codex-[a-zA-Z0-9_-]{1,100}$/.test(value);
const fail = (code, status = 400) => { throw new BridgeError(code, status); };
const alias = (value, snake, camel) => {
  if (value[snake] !== undefined && value[camel] !== undefined && value[snake] !== value[camel])
    fail('CONFLICTING_ID_ALIASES');
  return Object.hasOwn(value, snake) ? value[snake] : value[camel];
};
const identity = row => ({ session_id: row.session_id, request_id: row.request_id,
  sessionId: row.session_id, requestId: row.request_id });

// Each additional ID may pin its own workspace; all other IDs retain the configured scope.
// It never supplies providers, model settings, credentials, or a global selection.
export function readSessionBindings(additionalBindings = []) {
  if (!Array.isArray(additionalBindings) || additionalBindings.length > 8) fail('INVALID_SESSION_BINDINGS');
  const seen = new Set();
  return additionalBindings.map(item => {
    if (!item || !sessionIdOK(item.session_id) || seen.has(item.session_id)
      || typeof item.expected_title !== 'string' || !item.expected_title || item.expected_title.length > 200
      || (item.workspace !== undefined && (typeof item.workspace !== 'string' || !isAbsolute(item.workspace))))
      fail('INVALID_SESSION_BINDINGS');
    seen.add(item.session_id);
    return { session_id: item.session_id, expected_title: item.expected_title,
      ...(item.workspace === undefined ? {} : { workspace: resolve(item.workspace) }) };
  });
}

export function redactText(value) {
  return String(value)
    .replace(/\b[A-Za-z]:[\\/][^\r\n<>"|]*/g, '[LOCAL_PATH]')
    .replace(/\/(?:Users|home)\/[^\s<>"']+/g, '[LOCAL_PATH]')
    .replace(/\b(?:sk|sess)-[A-Za-z0-9_-]{16,}/g, '[REDACTED]')
    .replace(/\bBearer\s+\S+/gi, 'Bearer [REDACTED]')
    .replace(/((?:api[_ -]?key|access[_ -]?token|authorization|password|secret)\s*[=:]\s*)[^\s,;}]+/gi, '$1[REDACTED]');
}

function validateLedger(value) {
  if (value?.version !== 1 || !Array.isArray(value.requests) || value.requests.length > 10000)
    fail('REQUEST_LEDGER_INVALID', 503);
  const seen = new Set();
  for (const row of value.requests) {
    if (!sessionIdOK(row.session_id) || !requestIdOK(row.request_id) || seen.has(row.request_id)
      || !/^[a-f0-9]{64}$/.test(row.digest) || typeof row.state !== 'string'
      || (row.workspace !== undefined && (typeof row.workspace !== 'string' || !isAbsolute(row.workspace))))
      fail('REQUEST_LEDGER_INVALID', 503);
    seen.add(row.request_id);
  }
  return value;
}

function loadLedger(file) {
  if (!existsSync(file)) return { version: 1, requests: [] };
  if (statSync(file).size > 20000000) fail('REQUEST_LEDGER_LIMIT', 503);
  const text = readFileSync(file, 'utf8');
  // An interrupted final write is uncertain, never an excuse to resubmit work.
  if (text && !text.endsWith('\n')) fail('REQUEST_LEDGER_INCOMPLETE', 503);
  const latest = new Map();
  for (const line of text.split('\n').filter(Boolean)) {
    const event = JSON.parse(line);
    validateLedger({ version: event.version, requests: [event.request] });
    const row = event.request, prior = latest.get(row.request_id);
    if (prior && (prior.session_id !== row.session_id || prior.digest !== row.digest))
      fail('REQUEST_LEDGER_BINDING_CHANGED', 503);
    latest.set(row.request_id, row);
  }
  return validateLedger({ version: 1, requests: [...latest.values()] });
}

function appendLedger(file, row) {
  mkdirSync(dirname(file), { recursive: true });
  const bytes = Buffer.from(JSON.stringify({ version: 1, request: row }) + '\n');
  const fd = openSync(file, 'a');
  try {
    let offset = 0;
    while (offset < bytes.length) offset += writeSync(fd, bytes, offset, bytes.length - offset);
    fsyncSync(fd);
  } finally { closeSync(fd); }
}

export function createSessionControl(ctx, config, life, options = {}) {
  const ledgerFile = options.ledgerFile ?? fileURLToPath(new URL('../request-ledger.jsonl', import.meta.url));
  const ledger = options.initialLedger ? validateLedger(structuredClone(options.initialLedger))
    : loadLedger(ledgerFile);
  const rows = new Map(ledger.requests.map(row => [row.request_id, row]));
  const admitting = new Set();
  const bindings = new Map([...(config.sessionId ? [[config.sessionId, { session_id: config.sessionId }]] : []),
    ...(config.sessionBindings ?? []).map(item => [item.session_id, item])]);
  function pinnedWorkspace(id) {
    const fixed = bindings.get(id), saved = connection.bindingRecord(id);
    const workspace = fixed ? fixed.workspace ?? config.workspace : saved ? saved.workspace ?? config.workspace : undefined;
    if (fixed && saved?.workspace && !sameWorkspace(workspace, saved.workspace, resolve))
      fail('SESSION_BINDING_SCOPE_CONFLICT', 409);
    return workspace;
  }
  const save = row => options.write
    ? options.write(ledgerFile, { version: 1, requests: [...rows.values()] }) : appendLedger(ledgerFile, row);
  const signal = () => AbortSignal.any([life.signal, AbortSignal.timeout(20000)]);
  const services = () => nativeServices(ctx, ['sessions', 'agents', 'sessionProjections', 'sessionQuery', 'sessionController']);
  const checkLife = () => { if (life.closed) fail('BRIDGE_UNLOADED', 503); };
  const bindingFor = id => connection.bindingDisabled(id) ? undefined
    : connection.binding(id) ?? bindings.get(id);

  async function inspectTarget(sessionId, requireBinding = false, expectedWorkspace) {
    checkLife();
    if (!sessionIdOK(sessionId)) fail('EXPLICIT_SESSION_ID_REQUIRED');
    if (requireBinding && !bindingFor(sessionId)) fail('SESSION_NOT_BOUND', 403);
    const binding = connection.binding(sessionId) ?? bindings.get(sessionId);
    const host = services();
    const records = await host.sessionQuery.listSessions(signal());
    const matches = records.filter(record => record.header.id === sessionId);
    if (matches.length !== 1) fail('SESSION_NOT_FOUND_OR_AMBIGUOUS', 404);
    const header = matches[0].header;
    const pinned = pinnedWorkspace(sessionId);
    if (header.origin === 'subagent' || typeof header.cwd !== 'string' || !isAbsolute(header.cwd)
      || (pinned !== undefined && !sameWorkspace(header.cwd, pinned, resolve))
      || (expectedWorkspace !== undefined && !sameWorkspace(header.cwd, expectedWorkspace, resolve)))
      fail('SESSION_SCOPE_MISMATCH', 403);
    const snapshot = await host.sessionQuery.readTitle(sessionId, signal());
    const title = (typeof snapshot === 'string' ? snapshot : snapshot?.title) ?? '';
    // Routing authority is the explicit stable ID, native access and workspace.
    // expected_title is legacy display metadata; renaming never rebinds an ID.
    return { ...host, header, title, workspace: resolve(header.cwd), binding: binding ?? { session_id: sessionId } };
  }
  const target = sessionId => inspectTarget(sessionId, true);

  async function choices() {
    checkLife();
    const host = services();
    const records = await host.sessionQuery.listSessions(signal());
    const seen = new Set(); const sessions = [];
    // Discovery spans projects; only an explicit saved binding permits prompt admission.
    for (const { header } of records) {
      if (!sessionIdOK(header.id) || header.origin === 'subagent'
        || typeof header.cwd !== 'string' || !isAbsolute(header.cwd)) continue;
      if (seen.has(header.id)) fail('SESSION_LIST_AMBIGUOUS', 409);
      seen.add(header.id);
      try {
        const snapshot = await host.sessionQuery.readTitle(header.id, signal());
        const title = (typeof snapshot === 'string' ? snapshot : snapshot?.title) || '未命名对话';
        const pinned = pinnedWorkspace(header.id);
        const scopeMatches = pinned === undefined || sameWorkspace(header.cwd, pinned, resolve);
        sessions.push({ session_id: header.id, title, workspace: resolve(header.cwd), created_at: header.createdAt ?? null,
          ...(scopeMatches ? {} : { error: 'SESSION_SCOPE_MISMATCH', binding_workspace: pinned }),
          available: scopeMatches, resident: Boolean(host.sessions.get(header.id)),
          bound: Boolean(bindingFor(header.id)),
          agent_status: host.agents.get(header.id)?.status ?? 'idle' });
      } catch (error) {
        sessions.push({ session_id: header.id, title: '标题读取失败', created_at: header.createdAt ?? null,
          available: false, error: error.code ?? 'SESSION_TITLE_UNAVAILABLE' });
      }
    }
    // Include stale/deleted saved bindings so the UI can explicitly remove them.
    for (const id of new Set([...bindings.keys(), ...connection.bindings().map(row => row.session_id)]))
      if (!seen.has(id) && bindingFor(id)) sessions.push({ session_id: id,
        title: bindingFor(id).expected_title || '已绑定对话（当前不可访问）', workspace: pinnedWorkspace(id),
        available: false, bound: true, error: 'SESSION_UNAVAILABLE' });
    return { sessions, default_session_id: null, scope: 'official-top-level-sessions-across-workspaces' };
  }

  function pending(host, sessionId) {
    const session = host.sessions.get(sessionId);
    const inbox = session ? host.sessionProjections.cachedSnapshot(session, ['inbox'])?.values?.inbox : undefined;
    return { 'next-turn': inbox?.['next-turn'] ?? [], 'next-step': inbox?.['next-step'] ?? [] };
  }

  async function list() {
    const items = [];
    for (const sessionId of new Set([...bindings.keys(), ...connection.bindings().map(row => row.session_id)])) {
      if (!bindingFor(sessionId)) continue;
      try { items.push(await status(sessionId)); }
      catch (error) { items.push({ session_id: sessionId, available: false,
        error: error instanceof BridgeError ? error.code : 'NATIVE_LOOKUP_FAILED' }); }
    }
    return { default_session_id: config.sessionId, sessions: items };
  }

  async function status(sessionId) {
    const host = await target(sessionId);
    const inbox = pending(host, sessionId);
    return { session_id: sessionId, sessionId, available: true,
      attached: Boolean(host.sessions.get(sessionId)),
      title: host.title, workspace: host.workspace, routing_identity: 'explicit-session-id',
      expected_title: host.title, // Compatibility display field; never an identity check.
      agent_status: host.agents.get(sessionId)?.status ?? null,
      pending_inbox: Object.fromEntries(Object.entries(inbox).map(([lane, items]) => [lane, items.length])),
      requests: [...rows.values()].filter(row => row.session_id === sessionId).map(row => ({
        ...identity(row), state: row.state, accepted_at: row.accepted_at ?? null })) };
  }

  async function submit(request, legacy = false) {
    const keys = Object.keys(request);
    if (keys.some(key => !['session_id', 'sessionId', 'request_id', 'requestId', 'text', 'mode'].includes(key)))
      fail('INVALID_REQUEST');
    const explicit = alias(request, 'session_id', 'sessionId');
    const hasTarget = Object.hasOwn(request, 'session_id') || Object.hasOwn(request, 'sessionId');
    const sessionId = hasTarget ? explicit : legacy ? config.sessionId : undefined;
    const requestId = alias(request, 'request_id', 'requestId');
    if (!requestIdOK(requestId) || typeof request.text !== 'string' || !request.text.trim()
      || request.text.length > 6500 || !['queue', 'steer'].includes(request.mode)) fail('INVALID_REQUEST');
    const host = await target(sessionId);
    const digest = createHash('sha256').update(JSON.stringify([sessionId, request.mode, request.text])).digest('hex');
    const old = rows.get(requestId);
    if (old) {
      if (old.session_id !== sessionId) fail('REQUEST_SESSION_MISMATCH', 409);
      if (old.digest !== digest) fail('REQUEST_CONTENT_MISMATCH', 409);
      return { ...identity(old), state: old.state, duplicate: true,
        receipt: { accepted: old.accepted_at !== undefined }, uncertain: old.state === 'admission_uncertain' };
    }
    const permissionMatch = await connection.admission(sessionId);
    if (!permissionMatch.matched) return { session_id: sessionId, request_id: requestId,
      state: permissionMatch.state ?? 'permission_confirmation_required', receipt: { accepted: false }, connection: permissionMatch };
    if (rows.size >= 10000) fail('REQUEST_LEDGER_LIMIT', 503);
    if (admitting.has(sessionId)) fail('SESSION_ADMISSION_BUSY', 429);
    const row = { session_id: sessionId, workspace: host.workspace, request_id: requestId, digest, mode: request.mode,
      state: 'admission_uncertain', created_at: new Date().toISOString() };
    admitting.add(sessionId);
    try {
      rows.set(requestId, row);
      try { save(row); } catch (error) { rows.delete(requestId); throw error; }
      const work = host.sessionController.prompt({ sessionId, requestId,
        content: [{ type: 'text', text: request.text }], mode: request.mode, clientTimeZone: 'Etc/UTC' }, signal());
      life.active.add(work);
      let receipt;
      try { receipt = await work; } finally { life.active.delete(work); }
      if (receipt?.accepted !== true) fail('NATIVE_ADMISSION_NOT_CONFIRMED', 503);
      row.state = 'accepted'; row.accepted_at = new Date().toISOString();
      save(row);
      return { ...identity(row), state: row.state, receipt: { accepted: true } };
    } finally { admitting.delete(sessionId); }
  }

  function owned(sessionId, requestId) {
    if (!requestIdOK(requestId)) fail('EXPLICIT_REQUEST_ID_REQUIRED');
    const row = rows.get(requestId);
    if (!row) fail('REQUEST_NOT_FOUND', 404);
    if (row.session_id !== sessionId) fail('REQUEST_SESSION_MISMATCH', 409);
    return row;
  }

  async function read(sessionId, requestId, afterSeq = -1, includeResults = false) {
    const row = owned(sessionId, requestId);
    // Unbinding prevents new admission, but never strands a prior owned result.
    const workspace = row.workspace ?? pinnedWorkspace(sessionId) ?? config.workspace;
    const host = await inspectTarget(sessionId, false, workspace);
    if (!Number.isSafeInteger(afterSeq) || afterSeq < -1) fail('INVALID_RESULT_CURSOR');
    const inbox = pending(host, sessionId);
    const queued = Object.entries(inbox).flatMap(([lane, messages]) => messages
      .filter(message => message.source?.kind === 'user' && message.source.rpcId === requestId)
      .map(message => ({ lane, item_id: message.id })));
    if (queued.length > 1) fail('NATIVE_REQUEST_ID_AMBIGUOUS', 409);
    if (queued.length) return { ...identity(row), state: 'queued', pending: queued[0], results: [] };
    if (row.state === 'canceled') return { ...identity(row), state: 'canceled', results: [] };
    const source = await host.sessionQuery.readSession(sessionId);
    if (source.session.id !== sessionId || !sameWorkspace(source.session.cwd, workspace, resolve))
      fail('SESSION_SCOPE_MISMATCH', 403);
    let turn = null, own = null, end = null;
    const assistants = [], otherInputs = [];
    for (const event of source.events) {
      if (event.type === 'turn/start') turn = event.data.turn;
      if (event.type === 'user/message' && event.data.source?.kind === 'user') {
        const input = { request_id: event.data.source.rpcId ?? null, turn, seq: event.seq };
        if (input.request_id === requestId) {
          if (own) fail('NATIVE_REQUEST_ID_AMBIGUOUS', 409);
          own = input;
        } else otherInputs.push(input);
      }
      if (event.type === 'assistant/message') assistants.push(event);
      if (own && event.type === 'turn/end' && event.data.turn === own.turn) end = event;
    }
    if (!own) return { ...identity(row), state: row.state === 'admission_uncertain'
      ? 'admission_uncertain' : 'accepted_unresolved', results: [], automatic_resubmit: false };
    if (own.turn === null) fail('NATIVE_TURN_ID_UNAVAILABLE', 503);
    const shared = otherInputs.some(input => input.turn === own.turn);
    const kind = end?.data?.reason?.kind;
    const state = shared ? 'shared_turn' : !end ? 'running'
      : kind === 'completed' ? 'completed' : kind === 'aborted' ? 'canceled' : 'failed';
    const result = { ...identity(row), state, turn: own.turn, shared_turn: shared,
      terminal_reason: kind ?? null, results: [], next_cursor: afterSeq, has_more: false };
    // A steer may share another request's turn. Never label that mixed output as this request's result.
    if (!includeResults || shared) return result;
    let bytes = 0;
    for (const event of assistants.filter(event => event.seq > Math.max(own.seq, afterSeq)
      && event.data.turn === own.turn && (!end || event.seq < end.seq))) {
      const text = redactText((event.data.message?.content ?? []).filter(block => block.type === 'text')
        .map(block => block.text).join('\n'));
      const size = Buffer.byteLength(text);
      if (result.results.length && bytes + size > 10000) { result.has_more = true; break; }
      const bounded = Buffer.from(text).subarray(0, Math.max(0, 10000 - bytes)).toString('utf8');
      result.results.push({ seq: event.seq, text: bounded, truncated: size > Buffer.byteLength(bounded),
        interrupted: Boolean(event.data.interrupted) });
      bytes += Buffer.byteLength(bounded); result.next_cursor = event.seq;
    }
    return result;
  }

  async function cancel(sessionId, requestId) {
    const row = owned(sessionId, requestId);
    const host = await inspectTarget(sessionId);
    if (row.state === 'canceled') return { ...identity(row), state: 'canceled', duplicate: true };
    const inbox = pending(host, sessionId);
    const matches = Object.values(inbox).flat().filter(message => message.source?.kind === 'user'
      && message.source.rpcId === requestId);
    if (matches.length !== 1) fail(matches.length ? 'NATIVE_REQUEST_ID_AMBIGUOUS'
      : 'REQUEST_NOT_PENDING_CANCEL_UNAVAILABLE', 409);
    // The native queue API removes exactly this item. Never call session-wide cancel.
    try { await host.sessionController.updateQueue({ sessionId, itemId: matches[0].id,
      action: { kind: 'remove' } }, signal()); }
    catch { fail('NATIVE_QUEUE_CANCEL_NOT_CONFIRMED', 409); }
    row.state = 'canceled'; row.canceled_at = new Date().toISOString(); save(row);
    return { ...identity(row), state: 'canceled', canceled_item_id: matches[0].id };
  }

  async function unbind(sessionId) {
    checkLife();
    if (!sessionIdOK(sessionId)) fail('EXPLICIT_SESSION_ID_REQUIRED');
    if (admitting.has(sessionId)) fail('SESSION_ADMISSION_BUSY', 409);
    if (connection.changing(sessionId)) fail('CONNECTION_CHANGE_IN_PROGRESS', 409);
    // Do not hide/cancel an in-flight operation when removing its binding.
    const host = services(), agent = host.agents.get(sessionId);
    const inbox = pending(host, sessionId);
    if ((agent?.status && agent.status !== 'idle')
      || Object.values(inbox).flat().some(item => item.source?.kind === 'user'
        && [...rows.values()].some(row => row.session_id === sessionId && row.request_id === item.source.rpcId)))
      fail('SESSION_BUSY_UNBIND_AFTER_IDLE', 409);
    persistence?.forget(sessionId);
    return connection.unbind(sessionId);
  }

  const persistence = options.permissionPersistenceFile || options.permissionPersistenceStore
    ? createPermissionPersistence(ctx, life, target, pending,
      { file: options.permissionPersistenceFile, store: options.permissionPersistenceStore }) : undefined;
  if (persistence) life.permissionPersistence = persistence;
  const permissions = createPermissionControl(ctx, life, target, pending,
    { ...options.permissions, persistence });
  // The settings UI may preview an accessible session without binding it. A
  // successful explicit save commits that exact ID; cancel never adds a binding.
  const settingsPermissions = createPermissionControl(ctx, life, inspectTarget, pending,
    { ...options.permissions, persistence });
  const connection = createConnectionControl({
    async query(id) { const value = await settingsPermissions.query(id); const host = await inspectTarget(id);
      return { ...value, title: host.title, workspace: host.workspace }; },
    async load(id) { const value = await settingsPermissions.load(id); const host = await inspectTarget(id);
      return { ...value, title: host.title, workspace: host.workspace }; },
    change: request => settingsPermissions.change(request),
  }, life, options.connections);
  return { list, choices, status, submit, read, cancel, permissions, connection, unbind, rotationInternals: { inspectTarget, pending, settingsPermissions } };
}
