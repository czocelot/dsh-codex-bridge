import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { createStandaloneSessions } from '../lib/standalone-session-create.js';
import { createHandler, validateConfig } from '../lib/index-create-r6.js';
import { createHandler as rotationHandler, validateConfig as rotationConfig } from 'dsh-codex-bridge/rotation';

const sourceId = 'session-11111111-1111-4111-8111-111111111111';
const newId = 'session-22222222-2222-4222-8222-222222222222';
const specs = { auto: { sandbox: 'danger-full-access', approval: 'ask' },
  full: { sandbox: 'danger-full-access', approval: 'never' },
  read: { sandbox: 'read-only', approval: 'ask' }, custom: { sandbox: 'workspace-write', approval: 'ask' } };
const view = (preset, extra = {}) => ({ current_preset: preset, ...specs[preset],
  preset_specs: specs, revision: 7, native_state_known: true, ...extra });
function fixture(t, options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'bridge-create-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const calls = { create: 0, rename: 0, load: 0, change: [], prompts: 0, bindings: 0 };
  const w = { id: 'workspace-fixture', title: 'Fixture', path: dir, sessionIds: [sourceId] };
  const other = { id: 'workspace-other', title: 'Other', path: join(dir, 'other'), sessionIds: [] };
  const workspaces = new Map([[w.id, w], [other.id, other]]);
  const sessions = new Map([[sourceId, { id: sourceId, header: { id: sourceId, cwd: dir }, title: 'Source' }]]);
  let target = options.native ?? view('uncatalogued', { sandbox: 'workspace-write', approval: 'custom-policy' });
  const life = { closed: false, signal: new AbortController().signal, active: new Set() };
  const settings = {
    async query(id) { return id === sourceId ? view(options.source ?? 'full') : target; },
    async load(id) { assert.equal(id, newId); calls.load++; return target; },
    async change(r) { assert.equal(r.session_id, newId); calls.change.push(r); target = view(r.preset); },
  };
  const ctx = { workspaceRegistry: { list: () => [...workspaces.values()], get: id => workspaces.get(id) },
    permissionPresets: { resolve(name) { if (!specs[name]) throw Error('unknown'); return specs[name]; } },
    sessionController: {
      async create(r) {
        calls.create++; assert.deepEqual(Object.keys(r), ['workspaceId']);
        const selected = workspaces.get(r.workspaceId); selected.sessionIds.push(newId);
        sessions.set(newId, { id: newId, header: { id: newId, cwd: selected.path }, title: 'New session' });
        if (options.createHook) await options.createHook();
        return { sessionId: newId };
      },
      async rename(r) { calls.rename++; sessions.get(r.sessionId).title = r.title.trim(); return { title: r.title.trim() }; },
      prompt() { calls.prompts++; throw Error('No prompt permitted'); },
    } };
  const internals = { settingsPermissions: settings, inspectTarget: async id => sessions.get(id) };
  const file = join(dir, 'created.json');
  const controller = () => createStandaloneSessions(ctx, life, internals, { file });
  return { dir, file, calls, ctx, internals, settings, sessions, workspaces, w, other, life, controller,
    request: { request_id: 'codex-fixture', workspace_id: w.id } };
}

test('native creation preserves uncatalogued permissions, routes by workspace and leaves an empty unbound session', async t => {
  const f = fixture(t), api = f.controller();
  assert.equal(api.workspaces().length, 2);
  const result = await api.create({ ...f.request, workspace_id: f.other.id, title: '  Fresh task  ' });
  assert.equal(result.session_id, newId); assert.equal(result.title, 'Fresh task');
  assert.equal(result.workspace_id, f.other.id); assert.equal(result.permission_mode, 'native');
  assert.deepEqual(result.permission, { preset: 'uncatalogued', sandbox: 'workspace-write', approval: 'custom-policy' });
  assert.equal(f.sessions.get(newId).header.cwd, f.other.path);
  assert.equal(result.initial_message_sent, false); assert.equal(result.bridge_bound, false);
  assert.deepEqual(f.calls, { create: 1, rename: 1, load: 1, change: [], prompts: 0, bindings: 0 });
});

test('explicit permission selects each native preset; follow copies the source without changing it', async t => {
  for (const preset of Object.keys(specs)) {
    const f = fixture(t, { native: view('read') });
    const result = await f.controller().create({ ...f.request, permission_mode: 'explicit', permission_preset: preset });
    assert.equal(result.permission.preset, preset);
    assert.equal(f.calls.change.length, preset === 'read' ? 0 : 1);
    if (f.calls.change.length) assert.equal(f.calls.change[0].expected_revision, 7);
    assert.equal((await f.settings.query(sourceId)).current_preset, 'full');
  }
  const f = fixture(t, { native: view('read'), source: 'custom' });
  const result = await f.controller().create({ ...f.request, permission_mode: 'follow', source_session_id: sourceId });
  assert.equal(result.permission.preset, 'custom'); assert.equal(f.calls.change.length, 1);
});

test('concurrent retries and persisted replay create once; a changed request conflicts even during source lookup', async t => {
  const f = fixture(t), api = f.controller();
  const result = await Promise.all([api.create(f.request), api.create(f.request)]);
  assert.deepEqual(result[0], result[1]); assert.equal(f.calls.create, 1);
  assert.deepEqual(await f.controller().create(f.request), result[0]);
  assert.equal(f.calls.create, 1);
  assert.throws(() => api.create({ ...f.request, title: 'Changed' }), { code: 'CREATE_REQUEST_CONTENT_MISMATCH' });
  const g = fixture(t), wait = Promise.withResolvers();
  g.settings.query = async () => { await wait.promise; return view('full'); };
  const b = g.controller(), request = { ...g.request, permission_mode: 'follow', source_session_id: sourceId };
  const pending = b.create(request);
  assert.throws(() => b.create({ ...request, title: 'Changed' }), { code: 'CREATE_REQUEST_CONTENT_MISMATCH' });
  wait.resolve(); await pending; assert.equal(g.calls.create, 1);
});

test('unknown native result is fenced on retry and restart; a known session resumes after later failure', async t => {
  const f = fixture(t, { createHook: () => { throw Error('lost response'); } }), api = f.controller();
  await assert.rejects(api.create(f.request), /lost response/);
  assert.equal(api.status(f.request.request_id).phase, 'creation_uncertain');
  await assert.rejects(f.controller().create(f.request), { code: 'UNCERTAIN_CREATION_DO_NOT_RESUBMIT' });
  assert.equal(f.calls.create, 1);
  const g = fixture(t), original = g.settings.load;
  g.settings.load = async () => { throw Error('temporarily unavailable'); };
  await assert.rejects(g.controller().create(g.request), /temporarily unavailable/);
  const saved = JSON.parse(readFileSync(g.file, 'utf8')).requests[0];
  assert.equal(saved.session_id, newId); assert.equal(saved.phase, 'created');
  g.settings.load = original;
  assert.equal((await g.controller().create(g.request)).phase, 'completed'); assert.equal(g.calls.create, 1);
});

test('invalid options, unknown workspaces and unsafe status IDs have no creation side effects', async t => {
  const f = fixture(t), api = f.controller();
  for (const request of [null, [], 'text', { ...f.request, workspace_id: '' }, { ...f.request, title: ' ' },
    { ...f.request, permission_mode: 'explicit' }, { ...f.request, permission_mode: 'native', permission_preset: 'auto' },
    { ...f.request, source_session_id: sourceId }, { ...f.request, permission_mode: 'follow' },
    { ...f.request, text: 'Do not send' }, { ...f.request, initialize_new_auto: true }])
    assert.throws(() => api.create(request));
  await assert.rejects(api.create({ ...f.request, workspace_id: 'missing' }), { code: 'WORKSPACE_NOT_FOUND' });
  await assert.rejects(api.create({ ...f.request, permission_mode: 'explicit', permission_preset: 'invented' }), { code: 'NATIVE_PRESET_UNAVAILABLE' });
  assert.throws(() => api.status('__proto__'), { code: 'INVALID_CREATE_REQUEST_ID' });
  assert.equal(f.calls.create, 0); assert.equal(f.calls.change.length, 0);
});

test('workspace retargeting and subagent identity fail before permission writes; unload drains creation', async t => {
  const f = fixture(t, { createHook: () => { f.w.path = join(f.dir, 'retargeted'); } });
  await assert.rejects(f.controller().create(f.request), { code: 'CREATE_WORKSPACE_CHANGED' });
  assert.equal(f.calls.load, 0); assert.equal(f.calls.change.length, 0);
  const g = fixture(t, { createHook: () => { g.sessions.get(newId).header.origin = 'subagent'; } });
  await assert.rejects(g.controller().create(g.request), { code: 'CREATED_SESSION_WORKSPACE_MISMATCH' });
  const gate = Promise.withResolvers(), started = Promise.withResolvers();
  const h = fixture(t, { createHook: async () => { started.resolve(); await gate.promise; } });
  const api = h.controller(), work = api.create(h.request);
  await started.promise; assert.equal(h.life.active.size, 1); h.life.closed = true; gate.resolve();
  await assert.rejects(work, { code: 'BRIDGE_UNLOADED' }); assert.equal(h.life.active.size, 0);
  assert.equal(h.calls.rename, 0); assert.equal(h.calls.load, 0);
  h.life.closed = false;
  assert.equal((await h.controller().create(h.request)).session_id, newId); assert.equal(h.calls.create, 1);
});

test('corrupt persistent state fails closed; maximum-length request IDs still permit explicit permissions', async t => {
  const f = fixture(t, { native: view('read') });
  await f.controller().create({ ...f.request, request_id: 'codex-' + 'x'.repeat(100), permission_mode: 'explicit', permission_preset: 'full' });
  assert.ok(f.calls.change[0].request_id.length <= 106);
  writeFileSync(f.file, '{'); assert.throws(() => f.controller(), { code: 'CREATE_LEDGER_INVALID' });
});

function httpFixture(t, rotation) {
  const f = fixture(t, { native: view('read') });
  const agents = new Map([[sourceId, { id: sourceId, status: 'idle' }]]); agents.list = () => [];
  for (const session of f.sessions.values()) Object.assign(session, { permissions: specs.read, preset: 'read', snapshotEvents: () => [] });
  const create = f.ctx.sessionController.create;
  f.ctx.sessionController.create = async request => {
    const result = await create(request), s = f.sessions.get(result.sessionId);
    Object.assign(s, { permissions: specs.read, preset: 'read', snapshotEvents: () => [] });
    return result;
  };
  Object.assign(f.ctx, { sessions: f.sessions, agents, loader: { entries: () => [] },
    sessionProjections: { cachedSnapshot: () => ({ values: { inbox: {} } }), stateOf: s => s.permissions },
    sessionQuery: { listSessions: async () => [...f.sessions.values()].map(s => ({ header: s.header })), readTitle: async id => f.sessions.get(id)?.title },
    permissionPresets: { names: Object.keys(specs), current: s => s.preset, resolve: p => specs[p], catalog: () => ({ options: [] }),
      set(s, p) { f.calls.change.push(p); s.preset = p; s.permissions = specs[p]; } },
    on: () => () => {}, effect: () => {},
  });
  const config = rotation ? rotationConfig({ sessionId: sourceId, workspace: f.dir, port: 32091 }) : validateConfig({ port: 32091 });
  const handler = (rotation ? rotationHandler : createHandler)(f.ctx, config, f.life,
    { initialLedger: { version: 1, requests: [] }, permissions: { audit() {} }, connections: { file: join(f.dir, 'connections.json'), store: {
      get: () => null, entries: () => [], set() { f.calls.bindings++; throw Error('No binding permitted'); } } } });
  async function request(method, url, body, headers = {}) {
    const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
    Object.assign(req, { method, url, headers: { host: '127.0.0.1:32091', 'content-type': 'application/json', ...headers }, socket: { remoteAddress: '127.0.0.1' } });
    let status, value;
    await handler(req, { writeHead(code) { status = code; }, end(text) { value = JSON.parse(text); } });
    return { status, value };
  }
  return { ...f, requestHTTP: request };
}
for (const rotation of [false, true]) test(`${rotation ? 'rotation' : 'standard'} entry exposes guarded create routes and keeps new sessions unbound`, async t => {
  const f = httpFixture(t, rotation), send = f.requestHTTP;
  const header = { 'x-codex-bridge-control': 'bridge-session-create-v1' };
  assert.equal((await send('GET', '/workspaces')).value.workspaces.length, 2);
  assert.equal((await send('GET', '/workspaces?extra=1')).status, 400);
  assert.equal((await send('GET', '/sessions/create/status?request_id=codex-missing&extra=1')).status, 400);
  assert.equal((await send('GET', '/workspaces', undefined, { origin: 'https://example.org' })).status, 403);
  assert.equal((await send('POST', '/sessions/create', f.request)).status, 403);
  assert.equal((await send('POST', '/sessions/create?extra=1', f.request, header)).status, 400);
  const result = await send('POST', '/sessions/create', { ...f.request, title: 'Fresh', permission_mode: 'explicit', permission_preset: 'full' }, header);
  assert.equal(result.status, 200, JSON.stringify(result.value)); assert.equal(result.value.session_id, newId);
  assert.equal(result.value.permission.preset, 'full'); assert.equal(result.value.bridge_bound, false);
  assert.equal((await send('GET', '/sessions/create/status?request_id=codex-fixture')).value.phase, 'completed');
  assert.equal((await send('GET', '/status')).value.sessionCreation.defaultPermissionMode, 'native');
  assert.equal((await send('POST', '/v1/prompt', { session_id: newId, request_id: 'codex-no-bind', text: 'Fixture only', mode: 'queue' })).status, 403);
  assert.equal(f.calls.prompts, 0); assert.equal(f.calls.bindings, 0);
});
