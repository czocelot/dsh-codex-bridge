export class BridgeError extends Error {
  constructor(code, status = 503) { super(code); this.code = code; this.status = status; }
}

export function nativeServices(ctx, names) {
  // Resolve through the live host owner, never retain a borrowed tool scope.
  const host = ctx.root ?? ctx;
  const result = {};
  for (const name of names) {
    try { result[name] = typeof host.get === 'function' ? host.get(name) : host[name]; }
    catch { throw new BridgeError('HOST_BINDING_UNAVAILABLE'); }
    if (!result[name]) throw new BridgeError('HOST_BINDING_UNAVAILABLE');
  }
  return result;
}

export function sameWorkspace(a, b, normalize) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const left = normalize(a), right = normalize(b);
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
}

export function pending(agent) {
  const turn = agent.inbox?.nextTurn, step = agent.inbox?.nextStep;
  if (!Array.isArray(turn) || !Array.isArray(step)) throw new BridgeError('NATIVE_INBOX_UNAVAILABLE');
  return { nextTurn: turn.length, nextStep: step.length };
}

export function idle(agent) {
  const queue = pending(agent);
  if (agent.status !== 'idle' || queue.nextTurn || queue.nextStep)
    throw new BridgeError('AGENT_NOT_IDLE', 409);
}

export function rootState(ctx, config, normalize) {
  const services = nativeServices(ctx, ['sessions', 'agents', 'sessionProjections']);
  const session = services.sessions.get(config.sessionId);
  const agent = services.agents.get(config.sessionId);
  if (!session || !agent) throw new BridgeError('ROOT_NOT_RESIDENT', 409);
  if (agent.id !== config.sessionId || agent.session !== session
    || session.header.id !== config.sessionId || session.header.origin === 'subagent'
    || !sameWorkspace(session.header.cwd, config.workspace, normalize))
    throw new BridgeError('ROOT_SCOPE_MISMATCH', 403);
  const team = services.sessionProjections.stateOf(session, 'agentTeam');
  if (!team || team.id !== config.sessionId || team.failure || !Array.isArray(team.members))
    throw new BridgeError('NATIVE_TEAM_UNAVAILABLE');
  const catalog = services.sessionProjections.snapshot(session, ['subagentCatalog']).values.subagentCatalog;
  if (!Array.isArray(catalog)) throw new BridgeError('NATIVE_CATALOG_UNAVAILABLE');
  return { ...services, session, agent, team, catalog };
}

export function targetState(root, config, memberId, expectedName, normalize) {
  if (memberId === config.sessionId) throw new BridgeError('TARGET_IS_LEAD', 403);
  const matches = root.team.members.filter(member => member.id === memberId);
  if (matches.length !== 1) throw new BridgeError('TARGET_NOT_IN_TEAM', 403);
  const member = matches[0];
  if (member.phase !== 'active') throw new BridgeError('MEMBER_NOT_ACTIVE', 409);
  if (expectedName !== undefined && member.name !== expectedName)
    throw new BridgeError('MEMBER_NAME_MISMATCH', 409);
  const entries = root.catalog.filter(entry => entry.id === memberId);
  if (entries.length !== 1 || entries[0].mode !== 'continuable')
    throw new BridgeError('MEMBER_NOT_NATIVE_CONTINUABLE', 403);
  const agent = root.agents.get(memberId);
  if (!agent) return { member, agent: undefined };
  const session = agent.session;
  if (agent.id !== memberId || session?.header.id !== memberId
    || session.header.origin !== 'subagent' || session.header.parentSession !== config.sessionId
    || !sameWorkspace(session.header.cwd, config.workspace, normalize))
    throw new BridgeError('MEMBER_SCOPE_MISMATCH', 403);
  const identity = root.sessionProjections.stateOf(session, 'subagent')?.identity;
  if (!identity || identity.mode !== 'continuable' || !session.isOwnSeq(identity.seq)
    || session.eventAt(identity.seq)?.type !== 'subagent/descriptor'
    || session.eventAt(identity.seq)?.data?.mode !== 'continuable')
    throw new BridgeError('MEMBER_DESCRIPTOR_INVALID', 403);
  return { member, agent };
}

function measurement(ctx, session) {
  const { tokenMeter } = nativeServices(ctx, ['tokenMeter']);
  if (typeof tokenMeter.measure !== 'function') throw new BridgeError('NATIVE_METER_UNAVAILABLE');
  const value = tokenMeter.measure(session);
  if (![value.totalTokens, value.surfaceTokens, value.logRevision].every(Number.isSafeInteger))
    throw new BridgeError('NATIVE_METER_INVALID');
  return { kind: 'native_token_estimate', pressureTokens: value.totalTokens,
    surfaceTokens: value.surfaceTokens, logRevision: value.logRevision,
    sequenceCursor: session.seq, baseline: value.baseline?.kind ?? null };
}

function proof(session, result) {
  const spec = [['startSeq', 'compaction/start'], ['summarySeq', 'compaction/summary'],
    ['endSeq', 'compaction/end']];
  if (!result || typeof result.compactionId !== 'string'
    || !(result.startSeq < result.summarySeq && result.summarySeq < result.endSeq)
    || !Array.isArray(result.shadowedSeqs) || result.shadowedSeqs.length === 0
    || !Number.isFinite(result.shadowedTokenCount) || result.shadowedTokenCount <= 0)
    throw new BridgeError('NATIVE_RESULT_UNVERIFIED');
  for (const [field, type] of spec) {
    const seq = result[field], event = session.eventAt(seq);
    if (!Number.isSafeInteger(seq) || !session.isOwnSeq(seq) || event?.type !== type
      || event.data?.compactionId !== result.compactionId
      || (type !== 'compaction/summary' && event.data.turn !== null)
      || (type === 'compaction/end' && event.data.error !== undefined))
      throw new BridgeError('NATIVE_RESULT_UNVERIFIED');
  }
  const summary = session.eventAt(result.summarySeq).data;
  if (summary.shadowedTokenCount !== result.shadowedTokenCount
    || !Array.isArray(summary.shadowedSeqs)
    || JSON.stringify(summary.shadowedSeqs) !== JSON.stringify(result.shadowedSeqs)
    || session.eventAt(result.summarySeq + 1)?.type !== 'user/message')
    throw new BridgeError('NATIVE_RESULT_UNVERIFIED');
  return { compactionId: result.compactionId, startSeq: result.startSeq,
    summarySeq: result.summarySeq, endSeq: result.endSeq,
    shadowedItems: result.shadowedSeqs.length, shadowedTokens: result.shadowedTokenCount,
    persistedByNativeCompactNow: true, successfulEndObserved: true };
}

function safeFailure(error) {
  if (error instanceof BridgeError) return error.code;
  if (error?.name === 'ManualCompactionError'
    && ['busy', 'cancelled', 'changed', 'summary', 'commit', 'persistence'].includes(error.code))
    return 'NATIVE_COMPACTION_' + error.code.toUpperCase();
  if (/inactive context/.test(String(error?.message))) return 'HOST_CONTEXT_INACTIVE';
  if (error?.name === 'AbortError' || error?.name === 'TimeoutError') return 'CANCELLED_OR_TIMED_OUT';
  return 'NATIVE_COMPACTION_FAILED';
}

function expose(operation) {
  const { request, ...value } = operation;
  return structuredClone(value);
}

export function createMemberControl(ctx, config, life, normalize) {
  const operations = new Map();
  let active;
  const assertEnabled = () => {
    if (life.closed) throw new BridgeError('BRIDGE_UNLOADED');
    if (!config.enableMemberCompaction) throw new BridgeError('MEMBER_COMPACTION_DISABLED', 403);
  };
  const lookup = request => {
    const root = rootState(ctx, config, normalize);
    const target = targetState(root, config, request.memberId, request.expectedName, normalize);
    if (!target.agent) throw new BridgeError('COLD_MEMBER_REQUIRES_NATIVE_OWNER_ACTIVATION', 409);
    idle(root.agent); idle(target.agent);
    if (target.agent.session.seq !== request.expectedSeq)
      throw new BridgeError('STALE_MEMBER_CURSOR', 409);
    return { root, ...target };
  };

  return {
    list() {
      assertEnabled();
      const root = rootState(ctx, config, normalize);
      return { sessionId: config.sessionId, rootStatus: root.agent.status,
        members: root.team.members.map(member => {
          try {
          const target = targetState(root, config, member.id, undefined, normalize);
          return { memberId: member.id, name: member.name, phase: member.phase,
            resident: Boolean(target.agent), status: target.agent?.status ?? 'cold',
            ...(target.agent ? { pendingInbox: pending(target.agent),
              context: measurement(ctx, target.agent.session) }
              : { reason: 'COLD_MEMBER_REQUIRES_NATIVE_OWNER_ACTIVATION' }) };
          } catch (error) {
            return { memberId: member.id, name: member.name, phase: member.phase,
              status: 'unavailable', error: safeFailure(error) };
          }
        }) };
    },
    read(requestId) {
      assertEnabled();
      const operation = operations.get(requestId);
      if (!operation) throw new BridgeError('UNKNOWN_OPERATION', 404);
      return expose(operation);
    },
    submit(request) {
      assertEnabled();
      const prior = operations.get(request.requestId);
      if (prior) {
        if (JSON.stringify(prior.request) !== JSON.stringify(request))
          throw new BridgeError('REQUEST_ID_CONFLICT', 409);
        return expose(prior);
      }
      if (active) throw new BridgeError('COMPACTION_IN_PROGRESS', 409);
      if (operations.size >= 16) throw new BridgeError('OPERATION_LIMIT_RELOAD_REQUIRED', 429);
      const target = lookup(request);
      const before = measurement(ctx, target.agent.session);
      const operation = { request: structuredClone(request), requestId: request.requestId,
        sessionId: config.sessionId, memberId: request.memberId, name: target.member.name,
        state: 'running', success: false, before };
      operations.set(request.requestId, operation);
      active = operation;
      const work = Promise.resolve().then(async () => {
        try {
          if (life.closed) throw new BridgeError('BRIDGE_UNLOADED');
          const current = lookup(request);
          if (current.agent !== target.agent) throw new BridgeError('MEMBER_ACTIVATION_CHANGED', 409);
          // Web hosts isolate this service inside each Agent preset. Never
          // require/create a root compressor or substitute another Agent's.
          const compaction = current.agent.ctx?.get?.('compaction');
          if (typeof compaction?.compactNow !== 'function')
            throw new BridgeError('NATIVE_COMPACT_NOW_UNAVAILABLE');
          const signal = AbortSignal.any([life.signal, AbortSignal.timeout(config.compactionTimeoutMs)]);
          const result = await compaction.compactNow(current.agent, signal);
          operation.after = measurement(ctx, current.agent.session);
          if (result === null) { operation.state = 'no_compactable_history'; return; }
          operation.native = proof(current.agent.session, result);
          operation.reduced = operation.after.pressureTokens < before.pressureTokens;
          operation.success = true;
          operation.state = 'succeeded';
        } catch (error) {
          operation.error = safeFailure(error);
          operation.state = 'failed';
          try { operation.after = measurement(ctx, target.agent.session); } catch {}
          operation.historyMayHaveChanged = target.agent.session.seq !== before.sequenceCursor;
        } finally {
          operation.finishedAt = new Date().toISOString();
          if (active === operation) active = undefined;
        }
      });
      life.active.add(work);
      void work.finally(() => life.active.delete(work));
      return expose(operation);
    },
  };
}
