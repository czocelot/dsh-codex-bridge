import { createListenerControl } from './listener-control.js';
import { isAbsolute, resolve } from 'node:path';
import { BridgeError, createMemberControl, nativeServices, sameWorkspace } from './member-control.js';
import { createSessionControl, readSessionBindings } from './session-control.js';
import { registerHostSettings, initializeHostSettings } from './host-settings.js';

export const name = 'codex-native-session-bridge';
// Host session/permission/Gateway interfaces only. Agent-local compression,
// model providers and other installed plugins never gate bridge activation.
export const inject = ['sessions', 'sessionProjections', 'agents', 'sessionController', 'sessionQuery', 'permissionPresets', 'loader', 'typert'];
export const version = '0.8.0';
export const uiBuild = '0.8.0';
export const compatibilityBuild = '0.8.0-release';

export function validateConfig(config = {}) {
  const { sessionId = '', workspace = '', port = 19491, enableMemberCompaction = false,
    compactionTimeoutMs = 600000, enableProviderControl = false, providerStateFile } = config;
  if (typeof sessionId !== 'string' || typeof workspace !== 'string'
    || ((sessionId !== '' || workspace !== '') && (!/^session-[a-zA-Z0-9-]{8,100}$/.test(sessionId) || !isAbsolute(workspace)))
    || !Number.isInteger(port) || port < 1024 || port > 65535
    || typeof enableMemberCompaction !== 'boolean'
    || typeof enableProviderControl !== 'boolean' || enableProviderControl
    || (enableProviderControl && (typeof providerStateFile !== 'string' || !isAbsolute(providerStateFile)))
    || !Number.isSafeInteger(compactionTimeoutMs) || compactionTimeoutMs < 1000 || compactionTimeoutMs > 900000)
    throw Error('Use valid bridge limits; legacy sessionId and workspace must be supplied together or both left empty.');
  const sessionBindings = readSessionBindings(config.sessionBindings === undefined ? [] : config.sessionBindings);
  if (!workspace && sessionBindings.some(binding => !binding.workspace))
    throw Error('Static bindings need their own absolute workspace when no legacy workspace is configured.');
  if (enableMemberCompaction && !sessionId) throw Error('Member compaction requires an explicitly configured legacy root.');
  if (sessionBindings.some(binding => binding.session_id === sessionId))
    throw Error('Additional session binding duplicates the legacy execution session.');
  return { sessionId, workspace: workspace ? resolve(workspace) : undefined, port, enableMemberCompaction, compactionTimeoutMs, enableProviderControl, sessionBindings,
    providerStateFile: providerStateFile ? resolve(providerStateFile) : undefined };
}

function reply(res, code, value) {
  if (res.destroyed || res.writableEnded) return;
  const body = JSON.stringify(value);
  if (Buffer.byteLength(body) > 24000) return reply(res, 503, { error: 'RESPONSE_LIMIT' });
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(body);
}

function attached(ctx, config) {
  const { sessions } = nativeServices(ctx, ['sessions']);
  const session = config.sessionId ? sessions.get(config.sessionId) : undefined;
  if (session && !sameWorkspace(session.header.cwd, config.workspace, resolve))
    throw new BridgeError('SCOPE_MISMATCH');
  return session;
}

async function jsonRequest(req) {
  if (!(req.headers['content-type'] ?? '').startsWith('application/json'))
    throw new BridgeError('JSON_REQUIRED', 415);
  let bytes = 0;
  const chunks = [];
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > 24000) throw new BridgeError('REQUEST_LIMIT', 413);
    chunks.push(chunk);
  }
  let request;
  try { request = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new BridgeError('MALFORMED_JSON', 400); }
  if (!request || typeof request !== 'object' || Array.isArray(request))
    throw new BridgeError('INVALID_REQUEST', 400);
  return request;
}

function validId(value) { return typeof value === 'string' && /^codex-[a-zA-Z0-9_-]{1,100}$/.test(value); }

export function createHandler(ctx, config, life, sessionOptions) {
  life.active ??= new Set();
  const members = createMemberControl(ctx, config, life, resolve);
  const sessionControl = createSessionControl(ctx, config, life, sessionOptions);
  life.sessionControl = sessionControl;
  let busy = false;
  return async (req, res) => {
    if (life.closed) return reply(res, 503, { error: 'BRIDGE_UNLOADED' });
    if (Object.hasOwn(req.headers, 'origin')
      || !['127.0.0.1:' + config.port, 'localhost:' + config.port].includes(req.headers.host)
      || !['127.0.0.1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress))
      return reply(res, 403, { error: 'LOOPBACK_ONLY' });
    let ownsLegacyLock = false;
    try {
      const url = new URL(req.url, 'http://127.0.0.1:' + config.port);
      for (const key of url.searchParams.keys())
        if (url.searchParams.getAll(key).length !== 1)
          throw new BridgeError('AMBIGUOUS_QUERY_PARAMETERS', 400);
      const sessionId = url.searchParams.get('session_id');
      const requestId = url.searchParams.get('request_id');
      if (req.method === 'GET' && url.pathname === '/sessions/connection') {
        if ([...url.searchParams.keys()].some(key => key !== 'session_id'))
          throw new BridgeError('UNEXPECTED_QUERY_PARAMETERS', 400);
        return reply(res, 200, await sessionControl.connection.snapshot(sessionId));
      }
      if (req.method === 'POST' && ['/sessions/connection/prepare', '/sessions/connection/confirm', '/sessions/connection/cancel'].includes(url.pathname)) {
        if (url.search) throw new BridgeError('UNEXPECTED_QUERY_PARAMETERS', 400);
        if (req.headers['x-codex-bridge-control'] !== 'bridge-connection-v1')
          throw new BridgeError('EXPLICIT_CONTROL_HEADER_REQUIRED', 403);
        const request = await jsonRequest(req);
        if (Object.keys(request).some(key => !['session_id', 'preset', 'plan_id', 'confirmation'].includes(key)))
          throw new BridgeError('INVALID_REQUEST', 400);
        const api = sessionControl.connection;
        const result = url.pathname.endsWith('/prepare') ? await api.prepare(request.session_id, request.preset ?? null)
          : url.pathname.endsWith('/confirm') ? await api.confirm(request.session_id, request.plan_id, request.confirmation ?? null)
          : api.cancel(request.session_id, request.plan_id);
        return reply(res, 200, result);
      }
      if (req.method === 'GET' && url.pathname === '/sessions/permissions') {
        if ([...url.searchParams.keys()].some(key => key !== 'session_id'))
          throw new BridgeError('UNEXPECTED_QUERY_PARAMETERS', 400);
        return reply(res, 200, await sessionControl.permissions.query(sessionId));
      }
      if (req.method === 'POST' && url.pathname === '/sessions/permissions') {
        if (url.search) throw new BridgeError('UNEXPECTED_QUERY_PARAMETERS', 400);
        if (req.headers['x-codex-bridge-control'] !== 'native-permission-preset-v1')
          throw new BridgeError('EXPLICIT_CONTROL_HEADER_REQUIRED', 403);
        return reply(res, 200, await sessionControl.permissions.change(await jsonRequest(req)));
      }
      if (req.method === 'GET' && url.pathname === '/sessions')
        return reply(res, 200, await sessionControl.list());
      if (req.method === 'GET' && url.pathname === '/sessions/status')
        return reply(res, 200, await sessionControl.status(sessionId));
      if (req.method === 'GET' && ['/requests/status', '/requests/results'].includes(url.pathname)) {
        const after = url.searchParams.get('after_seq');
        return reply(res, 200, await sessionControl.read(sessionId, requestId,
          after === null ? -1 : Number(after), url.pathname === '/requests/results'));
      }
      if (req.method === 'POST' && ['/prompt', '/v1/prompt', '/requests/cancel'].includes(url.pathname)) {
        if (url.search) throw new BridgeError('UNEXPECTED_QUERY_PARAMETERS', 400);
        const request = await jsonRequest(req);
        if (url.pathname === '/requests/cancel') {
          if (Object.keys(request).some(key => !['session_id', 'request_id'].includes(key)))
            throw new BridgeError('INVALID_REQUEST', 400);
          return reply(res, 200, await sessionControl.cancel(request.session_id, request.request_id));
        }
        return reply(res, 200, await sessionControl.submit(request, url.pathname === '/prompt'));
      }
      if (busy) return reply(res, 429, { error: 'ONE_REQUEST_AT_A_TIME' });
      busy = true;
      ownsLegacyLock = true;
      if (req.method === 'GET' && req.url === '/status') {
        const session = attached(ctx, config);
        const { sessionProjections, agents } = nativeServices(ctx, ['sessionProjections', 'agents']);
        const snapshot = session ? sessionProjections.cachedSnapshot(session, ['inbox']) : undefined;
        const inbox = snapshot?.values?.inbox ?? {};
        const pending = {};
        for (const lane of ['next-turn', 'next-step'])
          pending[lane] = Array.isArray(inbox[lane]) ? inbox[lane].length : 0;
        return reply(res, 200, { package: 'dsh-codex-bridge', version, uiBuild, compatibilityBuild,
          sessionId: config.sessionId, attached: Boolean(session),
          agentStatus: agents.get(config.sessionId)?.status ?? null,
          pendingInbox: pending, historyReads: 0, coldLoads: 0,
          memberCompaction: { enabled: Boolean(config.enableMemberCompaction),
            requiresResidentMember: true, nativeIdleMaintenance: true } });
      }
      if (req.method === 'GET' && req.url === '/members')
        return reply(res, 200, members.list());
      const operationPath = /^\/members\/compactions\/(codex-[a-zA-Z0-9_-]{1,100})$/.exec(req.url);
      if (req.method === 'GET' && operationPath)
        return reply(res, 200, members.read(operationPath[1]));
      if (req.method !== 'POST' || req.url !== '/members/compact')
        return reply(res, 404, { error: 'UNSUPPORTED_ROUTE' });
      if (req.url === '/members/compact'
        && req.headers['x-codex-bridge-control'] !== 'native-member-compact-v1')
        return reply(res, 403, { error: 'EXPLICIT_CONTROL_HEADER_REQUIRED' });
      const request = await jsonRequest(req);
      if (life.closed) throw new BridgeError('BRIDGE_UNLOADED');
      const keys = Object.keys(request);
      if (req.url === '/members/compact') {
        if (keys.some(key => !['requestId', 'rootSessionId', 'memberId', 'expectedName', 'expectedSeq'].includes(key))
          || !validId(request.requestId) || request.rootSessionId !== config.sessionId
          || typeof request.memberId !== 'string' || request.memberId.length > 128
          || typeof request.expectedName !== 'string' || !request.expectedName || request.expectedName.length > 200
          || !Number.isSafeInteger(request.expectedSeq) || request.expectedSeq < 0)
          throw new BridgeError('INVALID_MEMBER_REQUEST', 400);
        const result = members.submit({ requestId: request.requestId, rootSessionId: request.rootSessionId,
          memberId: request.memberId, expectedName: request.expectedName, expectedSeq: request.expectedSeq });
        return reply(res, result.state === 'running' ? 202 : 200, result);
      }
    } catch (error) {
      reply(res, error instanceof BridgeError ? error.status : 503,
        { error: error instanceof BridgeError ? error.code : 'NATIVE_ADMISSION_FAILED',
          ...(error instanceof BridgeError && error.details ? error.details : {}) });
    } finally { if (ownsLegacyLock) busy = false; }
  };
}

export async function apply(ctx, options) {
  const config = validateConfig(options);
  const protocol = await import('@deepseek-ai/dsh-typert-protocol');
  const settings = { closed: false, control: null, listener: null, failure: null };
  // This must not wait for disk persistence, native maintenance or TCP listen.
  // Otherwise a startup error leaves the visible client with unclaimed /api/* 404s.
  const { unregister } = registerHostSettings(ctx, protocol, settings);
  ctx.effect(() => () => { settings.closed = true; unregister(); });
  // Start and stop the listener inside its injected host lifecycle. Pending
  // native maintenance drains before its required services can be disposed.
  ctx.effect(async () => {
    const controller = new AbortController();
    const life = { closed: false, signal: controller.signal, active: new Set() };
    let listener;
    const dispose = async () => {
      if (life.closed) return;
      life.closed = true;
      controller.abort();
      await Promise.allSettled([...life.active]);
      life.permissionPersistence?.dispose();
      await listener?.close();
    };
    return initializeHostSettings(settings, async () => {
    // Public home-path API; own data survives package replacement and official upgrades.
    const { dshHomePath } = await import('@deepseek-ai/dsh-home-paths');
    const { createHash } = await import('node:crypto');
    let profileName = 'default';
    try { profileName = String(nativeServices(ctx, ['profileContext']).profileContext.name ?? profileName); } catch {}
    const scope = createHash('sha256').update(profileName + ':' + (config.sessionId || 'panel')).digest('hex').slice(0, 16);
    const handler = createHandler(ctx, config, life, {
      ledgerFile: dshHomePath('plugin-data', 'dsh-codex-bridge', 'requests-' + scope + '.jsonl'),
      permissions: { auditFile: dshHomePath('plugin-data', 'dsh-codex-bridge', 'audit-' + scope + '.jsonl') },
      permissionPersistenceFile: dshHomePath('plugin-data', 'dsh-codex-bridge', 'permissions-' + scope + '.json'),
      connections: { file: dshHomePath('plugin-data', 'dsh-codex-bridge', 'connections-' + scope + '.json') },
    });
    listener = createListenerControl(config, life, handler, { version,
      file: dshHomePath('plugin-data', 'dsh-codex-bridge', 'listener-' + scope + '.json') });
    settings.control = life.sessionControl;
    settings.listener = listener;
    await listener.start();
    }, dispose);
  });
}
