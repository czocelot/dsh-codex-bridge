import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const packageRoot = resolve(process.env.BRIDGE_TEST_ROOT ?? '.');
const legacyId = 'session-11111111-1111-4111-8111-111111111111';
const testId = 'session-22222222-2222-4222-8222-222222222222';
const foreignId = 'session-33333333-3333-4333-8333-333333333333';
const childId = 'session-44444444-4444-4444-8444-444444444444';
const legacyWorkspace = resolve('fixtures/legacy-project');
const testWorkspace = resolve('fixtures/new-project');
const foreignWorkspace = resolve('fixtures/unapproved-project');
const newBinding = { session_id: testId, expected_title: 'Test', workspace: testWorkspace };
const code = expected => error => error?.code === expected;

function fixture(createSessionControl, { cold = false, tombstone = false, initialLedger, staticBindings = [newBinding] } = {}) {
  const headers = [
    { id: legacyId, cwd: legacyWorkspace, agentPreset: 'ptc' },
    { id: testId, cwd: testWorkspace, agentPreset: 'ptc' },
    { id: foreignId, cwd: foreignWorkspace, agentPreset: 'ptc' },
    { id: childId, cwd: legacyWorkspace, agentPreset: 'ptc', origin: 'subagent' },
  ];
  const events = new Map(headers.map(header => [header.id, []]));
  const allSessions = new Map(headers.map(header => [header.id, {
    id: header.id, header, snapshotEvents: () => events.get(header.id),
  }]));
  const sessions = new Map(allSessions);
  const agents = new Map([...sessions].map(([id, session]) => [id, { id, session, status: 'idle' }]));
  if (cold) { sessions.delete(testId); agents.delete(testId); }
  const calls = { prompt: [], load: [], permissionChanges: [], writes: [] };
  const preferences = new Map(tombstone ? [[testId, { binding_enabled: false }]] : []);
  const store = {
    get: id => structuredClone(preferences.get(id) ?? null),
    set(id, value) { preferences.set(id, structuredClone(value)); },
    entries: () => [...preferences].map(([id, value]) => [id, structuredClone(value)]),
  };
  const permissionState = { sandbox: 'workspace-write', approval: 'on-request' };
  const services = {
    sessions, agents,
    sessionProjections: {
      stateOf: () => ({ ...permissionState }),
      cachedSnapshot: () => ({ values: { inbox: { 'next-turn': [], 'next-step': [] } } }),
    },
    sessionQuery: {
      listSessions: async () => headers.map(header => ({ header: { ...header } })),
      readTitle: async id => ({ title: id === testId ? 'Test' : 'Existing session' }),
      observeSession: async () => ({ projections: { values: { permissions: { currentValue: 'auto' } } }, events: [] }),
      readSession: async id => ({ session: { ...headers.find(header => header.id === id) }, events: events.get(id) }),
    },
    permissionPresets: {
      names: ['auto'], current: () => 'auto',
      resolve: () => ({ ...permissionState }),
      catalog: () => ({ options: [{ value: 'auto', name: 'Auto' }] }),
      set: (...args) => { calls.permissionChanges.push(args); throw new Error('Unexpected permission change'); },
    },
    sessionController: {
      async resolveAgent(id) {
        calls.load.push(id);
        const session = allSessions.get(id);
        const agent = { id, session, status: 'idle' };
        sessions.set(id, session); agents.set(id, agent);
        return { agent };
      },
      async prompt(request) { calls.prompt.push(structuredClone(request)); return { accepted: true }; },
    },
    loader: { entries: () => [] },
  };
  const ctx = { get: key => services[key] };
  const life = { closed: false, signal: new AbortController().signal, active: new Set() };
  const config = { sessionId: legacyId, workspace: legacyWorkspace, sessionBindings: staticBindings };
  const options = {
    initialLedger: initialLedger ?? { version: 1, requests: [] },
    write: (...args) => calls.writes.push(args),
    connections: { store }, permissions: { audit() {} },
  };
  const control = createSessionControl(ctx, config, life, options);
  return { control, headers, sessions, events, calls, preferences, life,
    restart: () => createSessionControl(ctx, config, { closed: false, signal: new AbortController().signal, active: new Set() }, {
      ...options, initialLedger: calls.writes.at(-1)?.[1] ?? options.initialLedger,
    }) };
}

for (const filename of ['session-control.js', 'session-control-rotation-r1.js']) {
  const module = await import(pathToFileURL(resolve(packageRoot, 'lib', filename)));
  const label = `${filename}: `;

  test(label + 'configuration retains an explicit session workspace', () => {
    const binding = module.readSessionBindings([newBinding]).find(row => row.session_id === testId);
    assert.deepEqual(binding, newBinding);
  });

  test(label + 'relative workspaces and duplicate identities reject configuration', () => {
    assert.throws(() => module.readSessionBindings([{ ...newBinding, workspace: 'relative/project' }]), code('INVALID_SESSION_BINDINGS'));
    assert.throws(() => module.readSessionBindings([newBinding, newBinding]), code('INVALID_SESSION_BINDINGS'));
    assert.throws(() => module.readSessionBindings(null), code('INVALID_SESSION_BINDINGS'));
  });

  test(label + 'directory discovers all projects without binding, loading, or prompting them', async () => {
    const f = fixture(module.createSessionControl);
    const listing = await f.control.choices();
    assert.deepEqual(listing.sessions.map(row => row.session_id).sort(), [legacyId, testId, foreignId].sort());
    assert.equal(listing.sessions.find(row => row.session_id === testId).available, true);
    assert.equal(listing.sessions.find(row => row.session_id === foreignId).workspace, foreignWorkspace);
    assert.equal(listing.sessions.find(row => row.session_id === foreignId).bound, false);
    assert.equal(f.calls.load.length, 0);
    assert.equal(f.calls.prompt.length, 0);
  });

  test(label + 'cold Test connects with its existing PTC and permission settings', async () => {
    const f = fixture(module.createSessionControl, { cold: true });
    const plan = await f.control.connection.prepare(testId, null);
    assert.equal(plan.confirmation_required, false);
    const receipt = await f.control.connection.confirm(testId, plan.plan_id, null);
    assert.equal(receipt.connected, true);
    assert.equal(receipt.permission_changed, false);
    assert.deepEqual(f.calls.load, [testId]);
    assert.equal(f.sessions.get(testId).header.agentPreset, 'ptc');
    assert.equal(f.preferences.get(testId).preset, null);
    assert.equal(f.calls.permissionChanges.length, 0);
    assert.equal(f.calls.prompt.length, 0);
  });

  test(label + 'prompt dispatch uses only the explicit session and preserves its composition', async () => {
    const f = fixture(module.createSessionControl);
    const receipt = await f.control.submit({ session_id: testId, request_id: 'codex-workspace-acceptance', mode: 'queue', text: 'fixture-only input' });
    assert.equal(receipt.receipt.accepted, true);
    assert.equal(f.calls.prompt.length, 1);
    assert.equal(f.calls.prompt[0].sessionId, testId);
    assert.equal('agentPreset' in f.calls.prompt[0], false);
    assert.equal(f.sessions.get(testId).header.agentPreset, 'ptc');
    assert.equal(f.calls.permissionChanges.length, 0);
  });

  test(label + 'a changed workspace rejects the same ID before dispatch', async () => {
    const f = fixture(module.createSessionControl);
    f.headers.find(header => header.id === testId).cwd = foreignWorkspace;
    await assert.rejects(() => f.control.submit({ session_id: testId, request_id: 'codex-reject-moved', mode: 'queue', text: 'must reject' }), code('SESSION_SCOPE_MISMATCH'));
    assert.equal(f.calls.prompt.length, 0);
    assert.equal(f.calls.writes.length, 0);
    await assert.rejects(() => f.control.status(foreignId), code('SESSION_NOT_BOUND'));
  });

  test(label + 'disabled bindings stay disabled and never fall back to the old session', async () => {
    const f = fixture(module.createSessionControl, { tombstone: true });
    await assert.rejects(() => f.control.submit({ session_id: testId, request_id: 'codex-reject-disabled', mode: 'queue', text: 'must reject' }), code('SESSION_NOT_BOUND'));
    assert.equal(f.preferences.get(testId).binding_enabled, false);
    assert.equal(f.calls.prompt.length, 0);
    assert.equal(f.calls.permissionChanges.length, 0);
  });

  test(label + 'owned results validate against the Test workspace', async () => {
    const requestId = 'codex-workspace-result';
    const f = fixture(module.createSessionControl, { initialLedger: { version: 1, requests: [
      { session_id: testId, request_id: requestId, digest: 'a'.repeat(64), state: 'accepted' },
    ] } });
    f.events.set(testId, [
      { type: 'turn/start', seq: 0, data: { turn: 1 } },
      { type: 'user/message', seq: 1, data: { source: { kind: 'user', rpcId: requestId } } },
      { type: 'assistant/message', seq: 2, data: { turn: 1, message: { content: [{ type: 'text', text: 'owned result' }] } } },
      { type: 'turn/end', seq: 3, data: { turn: 1, reason: { kind: 'completed' } } },
    ]);
    const result = await f.control.read(testId, requestId, -1, true);
    assert.equal(result.state, 'completed');
    assert.equal(result.results[0].text, 'owned result');
    assert.equal(f.calls.load.length, 0);
    f.headers.find(header => header.id === testId).cwd = foreignWorkspace;
    await assert.rejects(() => f.control.read(testId, requestId, -1, true), code('SESSION_SCOPE_MISMATCH'));
  });

  test(label + 'an unbound project requires explicit confirmation and persists its own directory', async () => {
    const f = fixture(module.createSessionControl, { staticBindings: [] });
    await assert.rejects(() => f.control.status(testId), code('SESSION_NOT_BOUND'));
    const preview = await f.control.connection.snapshot(testId);
    assert.equal(preview.current.workspace, testWorkspace);
    assert.equal(f.preferences.has(testId), false);
    const plan = await f.control.connection.prepare(testId, null);
    assert.equal(f.preferences.has(testId), false);
    await f.control.connection.confirm(testId, plan.plan_id, null);
    assert.equal(f.preferences.get(testId).workspace, testWorkspace);
    assert.equal(f.preferences.has(foreignId), false);
    const resumed = f.restart();
    assert.equal((await resumed.connection.snapshot(testId)).connected, true);
    assert.equal((await resumed.status(testId)).workspace, testWorkspace);
    await assert.rejects(() => resumed.status(foreignId), code('SESSION_NOT_BOUND'));
    assert.equal(f.calls.prompt.length, 0);
    assert.equal(f.calls.permissionChanges.length, 0);
  });

  test(label + 'different project bindings coexist without a shared directory or default fallback', async () => {
    const f = fixture(module.createSessionControl, { staticBindings: [] });
    for (const id of [testId, foreignId]) {
      const plan = await f.control.connection.prepare(id, null);
      await f.control.connection.confirm(id, plan.plan_id, null);
    }
    assert.equal(f.preferences.get(testId).workspace, testWorkspace);
    assert.equal(f.preferences.get(foreignId).workspace, foreignWorkspace);
    await f.control.submit({ session_id: testId, request_id: 'codex-project-a', mode: 'queue', text: 'project A fixture' });
    await f.control.submit({ session_id: foreignId, request_id: 'codex-project-b', mode: 'queue', text: 'project B fixture' });
    assert.deepEqual(f.calls.prompt.map(row => row.sessionId), [testId, foreignId]);
    const ledger = f.calls.writes.at(-1)[1].requests;
    assert.deepEqual(ledger.map(row => row.workspace), [testWorkspace, foreignWorkspace]);
    await f.control.unbind(testId);
    const resumed = f.restart();
    await assert.rejects(() => resumed.status(testId), code('SESSION_NOT_BOUND'));
    assert.equal((await resumed.status(foreignId)).workspace, foreignWorkspace);
    assert.equal(f.preferences.get(testId).binding_enabled, false);
  });

  test(label + 'a directory change between prepare and confirm cannot retarget the binding', async () => {
    const f = fixture(module.createSessionControl, { staticBindings: [] });
    const plan = await f.control.connection.prepare(testId, null);
    f.headers.find(header => header.id === testId).cwd = foreignWorkspace;
    await assert.rejects(() => f.control.connection.confirm(testId, plan.plan_id, null), code('PERMISSION_CHANGED_REFRESH_REQUIRED'));
    assert.equal(f.preferences.has(testId), false);
    assert.equal(f.calls.prompt.length, 0);
  });

  test(label + 'persisted directory pins reject moved sessions after reload', async () => {
    const f = fixture(module.createSessionControl, { staticBindings: [] });
    const plan = await f.control.connection.prepare(testId, null);
    await f.control.connection.confirm(testId, plan.plan_id, null);
    f.headers.find(header => header.id === testId).cwd = foreignWorkspace;
    const resumed = f.restart();
    await assert.rejects(() => resumed.status(testId), code('SESSION_SCOPE_MISMATCH'));
    const listing = await resumed.choices();
    assert.equal(listing.sessions.find(row => row.session_id === testId).available, false);
    assert.equal(f.preferences.get(testId).workspace, testWorkspace);
  });

  test(label + 'owned cross-project results survive unbinding without mixing another request', async () => {
    const f = fixture(module.createSessionControl, { staticBindings: [] });
    const requestId = 'codex-durable-project-result';
    const plan = await f.control.connection.prepare(testId, null);
    await f.control.connection.confirm(testId, plan.plan_id, null);
    await f.control.submit({ session_id: testId, request_id: requestId, mode: 'queue', text: 'result fixture' });
    f.events.set(testId, [
      { type: 'turn/start', seq: 0, data: { turn: 1 } },
      { type: 'user/message', seq: 1, data: { source: { kind: 'user', rpcId: requestId } } },
      { type: 'assistant/message', seq: 2, data: { turn: 1, message: { content: [{ type: 'text', text: 'project A result' }] } } },
      { type: 'turn/end', seq: 3, data: { turn: 1, reason: { kind: 'completed' } } },
    ]);
    await f.control.unbind(testId);
    const resumed = f.restart();
    assert.equal((await resumed.read(testId, requestId, -1, true)).results[0].text, 'project A result');
    await assert.rejects(() => resumed.read(foreignId, requestId, -1, true), code('REQUEST_SESSION_MISMATCH'));
    assert.equal(f.preferences.get(testId).binding_enabled, false);
  });

  test(label + 'a persisted cold connection stays unknown on passive read and loads only on explicit connect', async () => {
    const f = fixture(module.createSessionControl, { staticBindings: [] });
    const plan = await f.control.connection.prepare(testId, null);
    await f.control.connection.confirm(testId, plan.plan_id, null);
    f.sessions.delete(testId);
    const resumed = f.restart();
    const before = await resumed.connection.snapshot(testId);
    assert.equal(before.state, 'permission_state_unknown');
    assert.equal(before.connected, false);
    assert.equal(f.calls.load.length, 0);
    const reconnect = await resumed.connection.prepare(testId, null);
    assert.equal(reconnect.confirmation_required, false);
    assert.deepEqual(f.calls.load, [testId]);
    assert.equal(f.calls.permissionChanges.length, 0);
    assert.equal(f.calls.prompt.length, 0);
  });
}

test('the package entry validates additional bindings without selecting an agent preset', async () => {
  const { validateConfig } = await import(pathToFileURL(resolve(packageRoot, 'lib/index.js')));
  const config = validateConfig({ sessionId: legacyId, workspace: legacyWorkspace, sessionBindings: [newBinding] });
  assert.deepEqual(config.sessionBindings.find(row => row.session_id === testId), newBinding);
  assert.equal('agentPreset' in config, false);
});
