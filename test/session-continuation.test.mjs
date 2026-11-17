import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { continuation, continuationStatus } from '../lib/session-continuation-policy-r1.js';
import { createAutoRotation } from '../lib/auto-rotation-continuation-r1.js';
import { createTurnBudgetGuard } from '../lib/turn-budget-continuation-r1.js';
import * as standard from 'dsh-codex-bridge';
import * as rotationEntry from 'dsh-codex-bridge/rotation';

const id = 'session-11111111-1111-4111-8111-111111111111';
const otherId = 'session-22222222-2222-4222-8222-222222222222';
function fixture(t) {
  const workspace = mkdtempSync(join(tmpdir(), 'bridge-continuation-'));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  const file = join(workspace, 'tools/dsh-session-continuation-20261117-r1/POLICY.json');
  mkdirSync(join(workspace, 'tools/dsh-session-continuation-20261117-r1'), { recursive: true });
  const policy = { schema: 'dsh-user-session-continuation/1', enabled: true, workspace,
    session_ids: [id], native_permissions_review_SafetyNet_and_compaction_unchanged: true };
  const save = (value = policy) => writeFileSync(file, JSON.stringify(value));
  save(); return { workspace, file, policy, save, config: { workspace } };
}

test('continuation is opt-in, scoped to the exact project and selected session, and fails closed', t => {
  const f = fixture(t);
  assert.equal(continuation(f.config, id), true);
  assert.equal(continuation(f.config, otherId), false);
  assert.equal(continuation({ workspace: join(f.workspace, 'another-project') }, id), false);
  assert.deepEqual(continuationStatus(f.config).session_ids, [id]);
  for (const patch of [{ enabled: false }, { schema: 'other' }, { workspace: resolve(f.workspace, '..') },
    { session_ids: [otherId] }, { native_permissions_review_SafetyNet_and_compaction_unchanged: false }]) {
    f.save({ ...f.policy, ...patch }); assert.equal(continuation(f.config, id), false);
  }
  writeFileSync(f.file, '{'); assert.equal(continuation(f.config, id), false);
  rmSync(f.file); assert.equal(continuation(f.config, id), false);
});

test('authorized continuation retains the requested target and never invokes automatic rotation', async t => {
  const f = fixture(t); let inspections = 0;
  const automatic = createAutoRotation({ inspect: async () => { inspections++; throw Error('unexpected rotation'); } }, f.config, {});
  const request = { session_id: id, request_id: 'codex-continue', text: 'Synthetic work', mode: 'queue' };
  const result = await automatic.beforeSubmit(request);
  assert.deepEqual(result.request, request); assert.equal(result.rotation, null);
  assert.equal(result.preflight.automatic_step_rotation_enforced, false);
  assert.equal(result.preflight.native_permission_and_review_checks_unchanged, true);
  assert.equal(inspections, 0);
  f.save({ ...f.policy, enabled: false });
  await assert.rejects(automatic.beforeSubmit({ ...request, request_id: 'codex-revoked' }), /unexpected rotation/);
  assert.equal(inspections, 1);
});

test('native rejection still controls an authorized continued step; frozen/deferred records remain intact', async t => {
  const f = fixture(t), deferred = { id: 'synthetic-input', content: [{ type: 'text', text: 'Keep pending' }] };
  const initial = { schema: 'bridge-turn-budget/1', sessions: { [id]: {
    source: { session_id: id, layer: 'execution' }, frozen: true, native_steps: 900, deferred: [deferred] } } };
  const before = structuredClone(initial); let nextCalls = 0;
  const reject = { kind: 'reject', reason: 'native-review-denial' };
  const guard = createTurnBudgetGuard({ initial, continuation: sessionId => continuation(f.config, sessionId),
    sources: () => [], events: () => { throw Error('No step history needed'); },
    persist: () => { throw Error('No journal mutation permitted'); } });
  assert.deepEqual(await guard.before({ id }, [deferred], async () => { nextCalls++; return reject; }), reject);
  assert.equal(nextCalls, 1); assert.deepEqual(initial, before);
});

test('unlisted sessions retain the 650 wrapup and 690 guard; native step continuation runs below the guard', async t => {
  const f = fixture(t), source = { session_id: otherId, layer: 'execution' };
  for (const steps of [650, 690]) {
    let nextCalls = 0, wrapups = 0;
    const guard = createTurnBudgetGuard({ continuation: sessionId => continuation(f.config, sessionId),
      sources: () => [source], events: async () => Array.from({ length: steps }, (_, seq) => ({ type: 'step/start', seq })),
      persist() {}, summaryReady: () => null, enqueueWrapup: async () => { wrapups++; } });
    const pending = { id: 'synthetic-pending-' + steps, content: [] };
    const result = await guard.before({ id: otherId }, [pending], async () => { nextCalls++; return 'native-next'; });
    if (steps === 650) { assert.equal(result, 'native-next'); assert.equal(nextCalls, 1); assert.equal(wrapups, 1); }
    else { assert.deepEqual(result, { kind: 'reject' }); assert.equal(nextCalls, 0);
      assert.deepEqual(guard.state.sessions[otherId].deferred, [pending]); }
  }
});

test('revoking continuation restores the bridge guard without replaying or clearing pending inputs', async t => {
  const f = fixture(t); let nextCalls = 0;
  const guard = createTurnBudgetGuard({ continuation: sessionId => continuation(f.config, sessionId),
    sources: () => [{ session_id: id, layer: 'execution' }],
    events: async () => Array.from({ length: 690 }, (_, seq) => ({ type: 'step/start', seq })),
    persist() {}, summaryReady: () => null });
  const native = async () => { nextCalls++; return 'native-next'; };
  assert.equal(await guard.before({ id }, [], native), 'native-next');
  f.save({ ...f.policy, enabled: false });
  const pending = { id: 'synthetic-input', content: [] };
  assert.deepEqual(await guard.before({ id }, [pending], native), { kind: 'reject' });
  assert.equal(nextCalls, 1); assert.deepEqual(guard.state.sessions[id].deferred, [pending]);
});

test('canonical package entries combine standalone creation with continuation and match manifest versions', () => {
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(standard.version, manifest.version); assert.equal(rotationEntry.version, manifest.version);
  assert.equal(standard.sessionCreationBuild, '20261114-create-r6');
  assert.equal(rotationEntry.sessionCreationBuild, '20261114-create-r6');
  assert.equal(rotationEntry.sessionContinuationBuild, '20261117-session-continuation-r2');
});
