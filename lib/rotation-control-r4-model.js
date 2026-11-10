import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { BridgeError, nativeServices, sameWorkspace } from './member-control.js';

const validRequest = x => typeof x === 'string' && /^codex-[a-zA-Z0-9_-]{1,100}$/.test(x);
const fail = (code, status = 409, details) => {
  const error = new BridgeError(code, status); error.details = details; throw error;
};
const titleText = x => typeof x === 'string' ? x : x?.title ?? '';
const escape = x => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Use the same native validated Session-local selector as SessionController,
 * deliberately without selectModel's separate global-default persistence. */
export async function inheritRotationModel(native,source,targetId) {
  const controller=native.sessionController,access=controller?.agents;
  const agent=native.agents.get(targetId)
    ?? (typeof controller?.resolveAgent==='function'?await controller.resolveAgent(targetId):null);
  const capabilities={agent:!!agent,serializeImageAdmission:typeof access?.serializeImageAdmission==='function',
    selectForNextRequest:typeof access?.selectForNextRequest==='function',selectionFor:typeof access?.selectionFor==='function',
    listProviders:typeof controller?.ctx?.llm?.listProviders==='function',listModels:typeof controller?.ctx?.llm?.listModels==='function',
    resolveCallConfig:typeof controller?.ctx?.llm?.resolveCallConfig==='function'};
  if(Object.values(capabilities).some(x=>!x))
    fail('NATIVE_SESSION_LOCAL_MODEL_SELECTION_UNAVAILABLE',503,{model_selection_capabilities:capabilities});
  return access.serializeImageAdmission(agent,async()=>{
    // Exact public availability check used by the official modelAvailable helper.
    const llm=controller.ctx.llm;
    if(!llm.listProviders().some(x=>x.id===source.provider)
      ||!(await llm.listModels(source.provider)).some(x=>x.id===source.model))
      fail('SOURCE_MODEL_UNAVAILABLE',409);
    const resolved=await controller.ctx.llm.resolveCallConfig(source);
    if(resolved.provider!==source.provider||resolved.model!==source.model)
      fail('SOURCE_MODEL_NORMALIZATION_CHANGED',409);
    const selected={provider:resolved.provider,model:resolved.model,
      ...(resolved.reasoningEffort===undefined?{}:{reasoningEffort:resolved.reasoningEffort})};
    access.selectForNextRequest(agent,selected);
    const actual=access.selectionFor(agent).current;
    if(JSON.stringify(actual)!==JSON.stringify(selected))fail('MODEL_INHERITANCE_READBACK_FAILED',409);
    return {...selected,source:'original-session-selection',global_default_changed:false};
  });
}

/** Publish one durable layer pointer before retiring the already-idle source.
 * A crash leaves either the old pointer/old binding, or the verified new pointer;
 * source retirement is idempotent cleanup and never strands the layer. */
export async function completeLayerBindingSwitch(api,state,row,save,now) {
  row.switch_intent??={source_session_id:row.source_session_id,target_session_id:row.session_id};
  if(row.switch_intent.source_session_id!==row.source_session_id||row.switch_intent.target_session_id!==row.session_id)
    fail('LAYER_SWITCH_INTENT_MISMATCH',409);
  state.layers[row.layer]={session_id:row.session_id,title:row.expected_title,
    workspace_id:row.workspace_id,updated_at:now()};
  row.phase='switch_committing';row.pending_source_unbind=true;save();
  if(!api.connection.bindingDisabled(row.source_session_id))await api.unbind(row.source_session_id);
  row.pending_source_unbind=false;row.phase='committed';row.committed_at=now();
  row.old_session_history_retained=true;row.other_bindings_unchanged=true;save();
  return structuredClone(row);
}

/** Repair only the exact self-created layerless transaction caused by the
 * selector/scope shadowing bug. Ambiguity fails closed; no ID is inferred from a title. */
export function repairLayerPointers(state,layers) {
  const repairs=[];
  for(const row of Object.values(state.requests)){
    if(row.layer!==undefined)continue;
    const matches=layers.filter(x=>x.sourceSessionId===row.source_session_id);
    if(matches.length!==1)fail('LAYERLESS_TRANSACTION_SCOPE_AMBIGUOUS',409);
    const layer=matches[0].layer;
    if(row.phase==='committed'){
      const stray=state.layers.undefined,current=state.layers[layer];
      if(!stray||stray.session_id!==row.session_id||stray.workspace_id!==row.workspace_id
        ||(current&&current.session_id!==row.session_id))fail('LAYER_POINTER_REPAIR_AMBIGUOUS',409);
      state.layers[layer]={...stray};delete state.layers.undefined;
    }
    row.layer=layer;row.pointer_repair={kind:'exact_source_scope_shadow_fix',source_session_id:row.source_session_id,target_session_id:row.session_id};
    repairs.push({request_id:row.request_id,layer,session_id:row.session_id});
  }
  return repairs;
}

/** Ordinary Host services, not an unauthenticated Gateway client or a new Host. */
export function createRotationControl(ctx, config, life, api, options = {}) {
  const file = options.file;
  let state = file && existsSync(file) ? JSON.parse(readFileSync(file, 'utf8'))
    : { schema: 'bridge-session-rotation/1', layers: {}, requests: {} };
  if (state.schema !== 'bridge-session-rotation/1' || !state.layers || !state.requests)
    fail('ROTATION_STORE_INVALID', 503);
  const layers = config.rotationLayers ?? [];
  if (!Array.isArray(layers) || layers.some(x => !x || typeof x.layer !== 'string'
    || typeof x.sourceSessionId !== 'string' || !/^session-[\w-]+$/.test(x.sourceSessionId)
    || typeof x.prefix !== 'string' || !['调研层使用', '执行层使用'].includes(x.prefix)))
    fail('ROTATION_SCOPE_CONFIG_INVALID', 503);
  const busy = new Set();
  const now = () => new Date().toISOString();
  const signal = () => AbortSignal.any([life.signal, AbortSignal.timeout(20000)]);
  const host = () => nativeServices(ctx,
    ['workspaceRegistry', 'sessionController', 'sessionQuery', 'agents']);
  function save() {
    if (file) {
      mkdirSync(dirname(file), { recursive: true });
      const temp = file + '.' + randomBytes(6).toString('hex') + '.tmp';
      writeFileSync(temp, JSON.stringify(state, null, 2), { flag: 'wx', flush: true });
      for(let attempt=0;;attempt++){
        try{renameSync(temp,file);break;}
        catch(error){if(!['EPERM','EACCES','EBUSY'].includes(error.code)||attempt>=9)throw error;
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,15);}
      }
    }
  }
  const pointerRepairs=repairLayerPointers(state,layers);
  if(pointerRepairs.length){state.pointer_repairs??=[];state.pointer_repairs.push(...pointerRepairs);save();}
  function scope(sourceId) {
    const matches = layers.filter(x => (state.layers[x.layer]?.session_id ?? x.sourceSessionId) === sourceId);
    if (matches.length !== 1) fail('SESSION_NOT_AUTHORIZED_FOR_ROTATION', 403);
    return matches[0];
  }
  async function metadata(id) {
    const target = await api.rotationInternals.inspectTarget(id);
    const registry = host().workspaceRegistry;
    const workspaces = registry.list().filter(w => w.sessionIds.includes(id));
    if (workspaces.length !== 1) fail('SOURCE_WORKSPACE_NOT_UNIQUE', 409);
    const w = workspaces[0];
    if (!sameWorkspace(w.path, config.workspace, resolve)
      || !sameWorkspace(target.header.cwd, w.path, resolve)) fail('ROTATION_WORKSPACE_MISMATCH', 403);
    return { session_id: id, title: target.title, cwd: target.header.cwd,
      workspace_id: w.id, workspace_title: w.title, workspace_path: w.path,
      grouped: true, origin: target.header.origin ?? null };
  }
  async function inspect(sourceId) {
    if (life.closed) fail('BRIDGE_UNLOADED', 503);
    const selected = scope(sourceId);
    await api.rotationInternals.inspectTarget(sourceId, true);
    const current = await metadata(sourceId);
    const native = host();
    const workspace = native.workspaceRegistry.get(current.workspace_id);
    const records = await native.sessionQuery.listSessions(signal());
    const titles = [];
    for (const record of records) {
      if (!workspace.sessionIds.includes(record.header.id)) continue;
      const name = titleText(await native.sessionQuery.readTitle(record.header.id, signal()));
      titles.push({ session_id: record.header.id, title: name });
    }
    const pattern = new RegExp('^' + escape(selected.prefix) + '(\\d+)$');
    const numbered = titles.filter(x => pattern.test(x.title));
    const historic=Object.values(state.requests).filter(x=>x.layer===selected.layer&&x.session_id&&pattern.test(x.expected_title??''));
    const next=Math.max(0,...numbered.map(x=>Number(pattern.exec(x.title)[1])),
      ...historic.map(x=>Number(pattern.exec(x.expected_title)[1])))+1;
    const source = await native.sessionQuery.readSession(sourceId);
    const steps = source.events.filter(e => e.type === 'step/start').length;
    const ended = source.events.filter(e => e.type === 'step/end').length;
    const latestMessage = [...source.events].reverse().find(e => e.type === 'assistant/message'
      && (e.data?.usage ?? e.usage));
    const usage = latestMessage?.data?.usage ?? latestMessage?.usage;
    const parts = usage && [usage.inputTokens, usage.cacheReadTokens, usage.outputTokens];
    const latestTokens = parts && parts.every(x => Number.isSafeInteger(x) && x >= 0)
      && parts.reduce((a,b)=>a+b,0) === usage.totalTokens ? usage.totalTokens : null;

    const permission = await api.rotationInternals.settingsPermissions.query(sourceId);
    return { layer: selected.layer, source: current, next_title: selected.prefix + next,
      numbered_sessions: numbered, execution_steps: steps, completed_execution_steps: ended,
      counter_semantics: 'cumulative native step/start events; not turns, tools, or training steps',
      latest_model_request_tokens: latestTokens, latest_model_request_usage: usage ?? null,
      rotate_before_step: 700, auto_trigger_step: 650,
      compression_before_tokens: 400000, current_permission: {
        preset: permission.current_preset, sandbox: permission.sandbox, approval: permission.approval },
      creation_api: 'sessionController.create({workspaceId})', authenticated_host_services: true,
      last_request_model: (()=>{const c=native.agents.get(sourceId)?.session?.requestHeader?.()?.config;
        return c?{provider:c.provider,model:c.model,reasoningEffort:c.reasoningEffort}:null;})(),
      context_tokens: null, context_tokens_note: 'not inferred from cumulative billing or turn count' };
  }
  function validate(request) {
    if (!request || Object.keys(request).some(k => !['source_session_id', 'request_id',
      'expected_workspace_id', 'expected_title', 'handoff_text', 'initialize_new_auto'].includes(k))
      || !validRequest(request.request_id) || typeof request.handoff_text !== 'string'
      || request.handoff_text.length < 100 || request.handoff_text.length > 4800
      || request.initialize_new_auto !== true) fail('INVALID_ROTATION_REQUEST', 400);
  }
  async function create(request) {
    validate(request);
    const selected = scope(request.source_session_id);
    const digest = createHash('sha256').update(JSON.stringify(request)).digest('hex');
    let row = state.requests[request.request_id];
    if (row && row.digest !== digest) fail('ROTATION_REQUEST_CONTENT_MISMATCH');
    if (row?.phase === 'committed') return structuredClone(row);
    if (busy.has(selected.layer)) fail('ROTATION_IN_PROGRESS', 429);
    const unsettled = Object.values(state.requests).find(x => x.layer === selected.layer
      && x.request_id !== request.request_id && x.phase !== 'committed');
    if (unsettled) fail('EXISTING_ROTATION_MUST_BE_RESOLVED', 409, { request_id: unsettled.request_id });
    busy.add(selected.layer);
    try {
      const native = host();
      const before = await inspect(request.source_session_id);
      if (before.source.workspace_id !== request.expected_workspace_id
        || (!row && before.next_title !== request.expected_title)) fail('ROTATION_PRECONDITION_CHANGED');
      if (before.current_permission.preset !== 'auto' || before.current_permission.approval !== 'ask')
        fail('SOURCE_NORMAL_AUTO_REVIEW_REQUIRED', 409, before.current_permission);
      const oldAgent=native.agents.get(request.source_session_id);
      const sourceSelection=native.sessionController.agents?.selectionFor(oldAgent)?.current;
      if(!sourceSelection?.provider||!sourceSelection?.model)fail('SOURCE_MODEL_SELECTION_UNAVAILABLE',503);
      const sourceModel={provider:sourceSelection.provider,model:sourceSelection.model,
        ...(sourceSelection.reasoningEffort===undefined?{}:{reasoningEffort:sourceSelection.reasoningEffort})};
      if (!row) {
        row = { request_id: request.request_id, digest, layer: selected.layer,
          source_session_id: request.source_session_id, workspace_id: request.expected_workspace_id,
          expected_title: request.expected_title, phase: 'creation_started', created_at: now(),
          source: before.source, source_model:sourceModel, model_default_verified:false };
        state.requests[request.request_id] = row; save();
      }
      if (!row.session_id) {
        if (row.creation_uncertain) fail('UNCERTAIN_CREATION_DO_NOT_RESUBMIT', 409);
        try {
          const created = await native.sessionController.create({ workspaceId: row.workspace_id });
          row.session_id = created.sessionId; row.phase = 'created'; save();
        } catch (error) {
          row.creation_uncertain = true; row.phase = 'creation_uncertain'; save(); throw error;
        }
      }
      row.model_selection=await inheritRotationModel(native,row.source_model??sourceModel,row.session_id);save();
      await native.sessionController.rename({ sessionId: row.session_id, title: row.expected_title });
      const meta = await metadata(row.session_id);
      if (meta.workspace_id !== row.workspace_id || meta.title !== row.expected_title)
        fail('CREATED_SESSION_IDENTITY_READBACK_FAILED');
      let permission = await api.rotationInternals.settingsPermissions.query(row.session_id);
      if (permission.current_preset !== 'auto' || permission.approval !== 'ask') {
        await api.rotationInternals.settingsPermissions.change({ session_id: row.session_id,
          request_id: request.request_id + '-auto', preset: 'auto', expected_revision: permission.revision });
        permission = await api.rotationInternals.settingsPermissions.query(row.session_id);
      }
      if (permission.current_preset !== 'auto' || permission.approval !== 'ask') fail('NEW_AUTO_READBACK_FAILED');
      row.permission = { preset: permission.current_preset, approval: permission.approval, sandbox: permission.sandbox };
      row.metadata = meta; row.phase = 'grouped_and_reviewed'; save();
      const plan = await api.connection.prepare(row.session_id, null);
      if (plan.confirmation_required) fail('UNEXPECTED_EXISTING_PERMISSION_CHANGE');
      const bound = await api.connection.confirm(row.session_id, plan.plan_id, null);
      if (bound.permission_changed) fail('UNEXPECTED_PERMISSION_CHANGE');
      const handoffId = request.request_id + '-handoff';
      row.handoff_request_id = handoffId;
      row.ack_path = join(config.workspace, 'tools', 'dsh-session-rotation-20261102-r1', 'ACK-' + request.request_id + '.json');
      const instruction = request.handoff_text + '\n\n本次新会话核验：你的会话ID为 ' + row.session_id
        + '，标题 ' + row.expected_title + '，真实工作区ID ' + row.workspace_id
        + '。这是已授权会话轮换，旧会话与其审批故障证据保留，审核正常启用。'
        + '请实际读取项目根AGENTS.md和本层专用交接文件 ' + resolve(config.workspace,selected.handoffFile)
        + '及同名.meta.json（若存在，仅采用源会话ID和文件SHA相符的元数据）；如其中有budget_journal，按需读取该源会话的未执行输入账本，保留每项原来源和任务状态，不自动重放。需要核对证据时仅按明确引用路径读取。再通过正常受审核工具写入 '
        + row.ack_path + '，内容为JSON：session_id、workspace_id、title、read_agents_md=true、handoff_received=true。'
        + '仅做这次简短交接读写核验，不展开研究、不训练、不改实验/模型/配方/审核/权限。最后简短回报已接收和未决项。';
      const receipt = await api.submit({ session_id: row.session_id, request_id: handoffId,
        text: instruction, mode: 'queue' });
      row.receipt = receipt; row.phase = 'handoff_submitted'; row.updated_at = now();
      if(row.last_error){(row.error_history??=[]).push(row.last_error);delete row.last_error;}save();
      return structuredClone(row);
    } catch (error) {
      if (row) { row.last_error = { code: error.code ?? error.name, message: String(error.message).slice(0, 500), utc: now() }; save(); }
      throw error;
    } finally { busy.delete(selected.layer); }
  }
  async function status(requestId) {
    const row = state.requests[requestId];
    if (!row) fail('ROTATION_NOT_FOUND', 404);
    const response = structuredClone(row);
    if (row.session_id) response.metadata = await metadata(row.session_id);
    if (row.handoff_request_id) response.handoff = await api.read(row.session_id, row.handoff_request_id, -1, true);
    return response;
  }
  async function commit(request) {
    if (!request || Object.keys(request).some(k => k !== 'request_id') || !validRequest(request.request_id))
      fail('INVALID_ROTATION_COMMIT', 400);
    const row = state.requests[request.request_id];
    if (!row?.session_id) fail('ROTATION_NOT_READY');
    if (row.phase === 'committed') return structuredClone(row);
    if(busy.has(row.layer))fail('ROTATION_IN_PROGRESS',429);
    busy.add(row.layer);
    try {
    const result = await status(request.request_id);
    if (result.handoff?.state !== 'completed' || result.handoff.shared_turn) fail('HANDOFF_NOT_COMPLETED');
    if (!existsSync(row.ack_path)) fail('HANDOFF_ACK_MISSING');
    const ack = JSON.parse(readFileSync(row.ack_path, 'utf8').replace(/^\uFEFF/, ''));
    if (ack.session_id !== row.session_id || ack.workspace_id !== row.workspace_id
      || ack.title !== row.expected_title || ack.read_agents_md !== true || ack.handoff_received !== true)
      fail('HANDOFF_ACK_IDENTITY_MISMATCH');
    const native = host();
    const data = await native.sessionQuery.readSession(row.session_id);
    const toolResults = data.events.filter(e => e.type === 'tool/result');
    if (!toolResults.length) fail('HANDOFF_HAS_NO_NATIVE_TOOL_RESULT');
    const permission = await api.rotationInternals.settingsPermissions.query(row.session_id);
    if (permission.current_preset !== 'auto' || permission.approval !== 'ask') fail('NEW_REVIEW_CHANGED_BEFORE_COMMIT');
    if(!api.connection.bindingDisabled(row.source_session_id)){
      const old=await api.status(row.source_session_id);
      if(old.agent_status&&old.agent_status!=='idle')fail('SOURCE_BUSY_NO_SWITCH');
    }
    row.native_tool_results=toolResults.length;
    return await completeLayerBindingSwitch(api,state,row,save,now);
    } finally {busy.delete(row.layer);}
  }
  async function active(layer) {
    const selected=layers.find(x=>x.layer===layer);
    if(!selected)fail('LAYER_NOT_AUTHORIZED_FOR_ROTATION',403);
    return inspect(state.layers[layer]?.session_id ?? selected.sourceSessionId);
  }
  return { inspect, create, status, commit, active, managedSources:()=>layers.map(x=>({...x,session_id:state.layers[x.layer]?.session_id??x.sourceSessionId})) };
}
