// Generated from rpc-contract.js, panel-controller.js and panel-view.js; host-supplied React only.
window.__ModuleLoader__.load({id:'dsh-codex-bridge',factory:function(require){
/** Memory-only display cache shared by panel mounts. Never authorizes a write. */
function createPanelReadCache(raw, { now = () => Date.now(), timeoutMs = 8000 } = {}) {
  const cache = new Map(), pending = new Map();
  const ttl = { list: 15000, listener: 5000, presets: 60000 };
  function read(name, args = [], fresh = false) {
    const key = name + ':' + JSON.stringify(args);
    if (pending.has(key)) return pending.get(key);
    const saved = cache.get(key);
    if (!fresh && saved && now() - saved.time < ttl[name]) return Promise.resolve(saved.value);
    let timer;
    // The timeout only releases this panel's wait, not the underlying RPC.
    // Retain pending until settlement so another mount cannot duplicate it.
    const actual = Promise.resolve().then(() => raw[name](...args));
    const visible = Promise.race([actual, new Promise((_, reject) => {
      timer = setTimeout(() => reject(Object.assign(new Error('读取超时；可稍后刷新，原请求仍在等待。'),
        { code: 'PANEL_READ_TIMEOUT' })), timeoutMs);
    })]);
    pending.set(key, visible);
    actual.then(value => { if (name in ttl) cache.set(key, { value, time: now() }); }, () => {})
      .finally(() => { clearTimeout(timer); if (pending.get(key) === visible) pending.delete(key); });
    return visible;
  }
  const api = Object.create(null);
  for (const name of ['list', 'listener', 'presets', 'snapshot']) api[name] = (...args) => read(name, args);
  api.peek = name => cache.get(name + ':[]')?.value;
  api.readFresh = name => read(name, [], true);
  for (const name of ['prepare', 'confirm', 'cancel', 'savePort', 'unbind']) api[name] = async (...args) => {
    try { return await raw[name](...args); }
    finally {
      // Mutations invalidate display metadata only. Permission snapshot/prepare/
      // confirm remain uncached and are rechecked by the native host.
      if (name === 'savePort') cache.delete('listener:[]');
      if (['confirm', 'unbind'].includes(name)) cache.delete('list:[]');
    }
  };
  return api;
}

/** Own wire contract using the public TypertSchema.parse interface. No plugin code is copied. */
const schema = parse => ({ mode: 'strict', typeSymbol: 'dsh-codex-bridge#Json', create: () => ({ parse }) });
const string = (pattern, max) => schema(value => {
  if (typeof value !== 'string' || value.length > max || !pattern.test(value)) throw Error('Invalid bridge RPC string');
  return value;
});
const session = string(/^session-[a-zA-Z0-9-]{8,100}$/, 108);
const plan = string(/^codex-connect-[a-f0-9]{24}$/, 38);
const preset = schema(value => {
  if (value !== null && (typeof value !== 'string' || !value || value.length > 100)) throw Error('Invalid official preset selection');
  return value;
});
const port = schema(value => {
  if (!Number.isInteger(value) || value < 1024 || value > 65535) throw Error('Invalid local listener port');
  return value;
});
const confirmation = schema(value => {
  if (value === null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(key => !['accepted', 'session_id', 'from_preset', 'to_preset', 'expected_revision'].includes(key))
    || value.accepted !== true || typeof value.session_id !== 'string'
    || typeof value.from_preset !== 'string' || typeof value.to_preset !== 'string'
    || !Number.isSafeInteger(value.expected_revision) || value.expected_revision < -1)
    throw Error('Invalid specific permission confirmation');
  return { ...value };
});
function json(value, depth = 0) {
  if (depth > 30) throw Error('Bridge RPC result too deeply nested');
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map(item => json(item, depth + 1));
  if (value && Object.getPrototypeOf(value) === Object.prototype) return Object.fromEntries(
    Object.entries(value).filter(([, v]) => v !== undefined).map(([key, v]) => [key, json(v, depth + 1)]));
  throw Error('Bridge RPC result is not a JSON value');
}
const parameter = (name, codec) => ({ name, wire: name, source: 'json', codec });
const definitions = [
  ['list', []], ['presets', []], ['listener', []], ['snapshot', [parameter('sessionId', session)]],
  ['prepare', [parameter('sessionId', session), parameter('preset', preset)]],
  ['confirm', [parameter('sessionId', session), parameter('planId', plan), parameter('confirmation', confirmation)]],
  ['cancel', [parameter('sessionId', session), parameter('planId', plan)]],
  ['savePort', [parameter('port', port), parameter('expectedPort', port)]],
  ['unbind', [parameter('sessionId', session)]],
];
const invocations = definitions.map(([method, parameters]) => ({
  id: 'dsh-codex-bridge#codexBridgeConnection/' + method,
  service: 'codexBridgeConnection', namespace: 'codexBridgeConnection', method,
  invocation: { kind: 'direct' }, parameters, result: schema(value => json(value)),
  sourceLocation: { file: 'lib/settings-service.js', line: 1, column: 1 },
}));
const TYPERT = { package: 'dsh-codex-bridge', face: 'host', schemas: [], invocations,
  model: { services: [{ key: 'codexBridgeConnection', exportName: 'BridgeSettings', tags: [], types: [],
    summary: 'Explicit session-scoped bridge connection settings; native permission authority is retained.',
    members: definitions.map(([name]) => ({ kind: 'method', name, signature: name + '(...args): Promise<Json>' })) }],
  events: [], objects: [] } };
const TYPERT_REMOTE = { package: 'dsh-codex-bridge', descriptors: invocations };

/** User-driven state; never polls or implicitly changes permissions. */
function createPanelController(api) {
  const cachedList = api.peek?.('list'), cachedListener = api.peek?.('listener'), cachedPresets = api.peek?.('presets');
  let value = { loading: false, sessionsLoading: false, listenerLoading: false, presetsLoading: false, viewLoading: false,
    sessions: cachedList?.sessions ?? [], sessionId: '', search: '', editIntent: 'edit',
    view: null, preset: null, presetTouched: false, permissionPresets: [], plan: null, acknowledged: false, message: '', error: null,
    listError: null, listener: cachedListener ?? null, listenerError: null, presetsError: null,
    portInput: cachedListener ? String(cachedListener.configured_port ?? cachedListener.port ?? '') : '', portMessage: '', portError: null };
  value.permissionPresets = cachedPresets?.permission_presets ?? cachedList?.permission_presets ?? [];
  let generation = 0, pageGeneration = 0, disposed = false; const subscribers = new Set();
  let loadingPage = null;
  const emit = patch => { if (disposed) return; value = { ...value, ...patch }; for (const fn of subscribers) fn(); };
  const errorOf = error => ({ code: error?.code ?? 'HOST_CONNECTION_UNAVAILABLE', message: error?.message ?? String(error), details: error?.details ?? null });
  const cancelOld = plan => { if (plan) void api.cancel(plan.session_id, plan.plan_id).catch(() => {}); };
  const run = async work => {
    const epoch = generation; emit({ loading: true, error: null, message: '' });
    try { await work(epoch); } catch (error) { if (epoch === generation) emit({ error: errorOf(error), plan: null }); }
    finally { if (epoch === generation) emit({ loading: false }); }
  };
  async function inspect(sessionId, epoch = generation, retainPreselection = false) {
    if (epoch === generation) emit({ viewLoading: true });
    let view;
    try { view = await api.snapshot(sessionId); }
    finally { if (epoch === generation) emit({ viewLoading: false }); }
    if (epoch === generation) emit({ sessionId, view,
      preset: retainPreselection ? value.preset : view.selected_preset ?? null,
      presetTouched: retainPreselection && value.presetTouched,
      permissionPresets: Array.isArray(view.current?.presets) && view.current.presets.length ? view.current.presets : value.permissionPresets,
      plan: null, acknowledged: false });
  }
  async function refreshDirectory(epoch = generation) {
    const listing = await api.list();
    if (epoch === generation) emit({ sessions: listing.sessions ?? [] });
  }
  const savedMessage = saved => !saved.saved ? '' : saved.transport?.listening === false
    ? '配置已保存、权限读回一致；本地服务未监听，请查看服务状态。'
    : '配置已保存，权限读回一致；本地服务可用，没有命令时正常空闲。';
  return {
    getSnapshot: () => value,
    subscribe(fn) { subscribers.add(fn); return () => subscribers.delete(fn); },
    load({ fresh = false } = {}) {
      if (loadingPage) return loadingPage;
      cancelOld(value.plan);
      disposed = false; const pageEpoch = ++pageGeneration;
      emit({ sessionsLoading: true, listenerLoading: true, presetsLoading: true,
        listError: null, listenerError: null, presetsError: null, error: null, plan: null, acknowledged: false });
      const valid = () => pageEpoch === pageGeneration && !disposed;
      const read = name => fresh && api.readFresh ? api.readFresh(name) : api[name]();
      const listing = read('list').then(async data => {
        if (!valid()) return;
        const sessions = data.sessions ?? [];
        emit({ sessions, sessionsLoading: false });
        if (value.sessionId && sessions.some(row => row.session_id === value.sessionId && row.available !== false)) {
          if (!value.view && !value.viewLoading) await inspect(value.sessionId, generation, value.presetTouched);
        } else if (value.sessionId) {
          generation++;
          emit({ sessionId: '', view: null, viewLoading: false, preset: null, presetTouched: false });
        }
      }).catch(error => { if (valid()) emit({ listError: errorOf(error), sessionsLoading: false }); });
      const listener = read('listener').then(data => {
        if (valid()) emit({ listener: data, listenerLoading: false,
          portInput: value.portInput || String(data.configured_port ?? data.port ?? '') });
      }).catch(error => { if (valid()) emit({ listenerError: errorOf(error), listenerLoading: false }); });
      const presets = read('presets').then(data => {
        if (valid()) emit({ permissionPresets: data.permission_presets ?? [], presetsLoading: false });
      }).catch(error => { if (valid()) emit({ presetsError: errorOf(error), presetsLoading: false }); });
      const work = Promise.allSettled([listing, listener, presets]);
      loadingPage = work;
      void work.finally(() => { if (loadingPage === work) loadingPage = null; });
      return work;
    },
    setSearch(search) { emit({ search }); },
    beginAdd() {
      if (value.loading || value.sessionsLoading) return;
      cancelOld(value.plan); generation++;
      emit({ editIntent: 'add', sessionId: '', search: '', view: null, preset: null, presetTouched: false,
        plan: null, acknowledged: false, loading: false, viewLoading: false,
        message: '请选择尚未绑定的对话，新增不会替换已有绑定。', error: null });
    },
    selectSession(sessionId) {
      if (sessionId && !value.sessions.some(row => row.session_id === sessionId && row.available !== false)) return Promise.resolve(emit({ error: { code: 'TARGET_NOT_IN_DIRECTORY', message: '请选择列表中可用的目标对话。' } }));
      if (value.editIntent === 'add' && value.sessions.find(row => row.session_id === sessionId)?.bound)
        return Promise.resolve(emit({ error: { code: 'SESSION_ALREADY_BOUND', message: '该对话已有绑定，请从已绑定列表编辑。' } }));
      const retainPreselection = !value.sessionId && value.presetTouched;
      cancelOld(value.plan); generation++;
      emit({ sessionId, view: null, plan: null, preset: retainPreselection ? value.preset : null,
        presetTouched: retainPreselection, acknowledged: false, message: '', error: null });
      const epoch = generation;
      return sessionId ? inspect(sessionId, epoch, retainPreselection).catch(error => {
        if (epoch === generation && !disposed) emit({ error: errorOf(error) });
      }) : Promise.resolve(emit({ viewLoading: false }));
    },
    editBinding(sessionId) {
      if (value.loading || value.sessionsLoading) return Promise.resolve();
      emit({ editIntent: 'edit', presetTouched: false });
      return this.selectSession(sessionId);
    },
    selectPreset(preset) { cancelOld(value.plan); emit({ preset, presetTouched: true, acknowledged: false, plan: null, message: '', error: null }); },
    acknowledge(accepted) { emit({ acknowledged: accepted === true }); },
    connect: () => run(async epoch => {
      if (!value.sessionId || !value.view) throw Object.assign(new Error('请先按名称选择目标对话。'), { code: 'SELECT_TARGET_FIRST' });
      if (value.editIntent === 'add' && value.sessions.find(row => row.session_id === value.sessionId)?.bound)
        throw Object.assign(new Error('该对话已有绑定，未覆盖原配置。'), { code: 'SESSION_ALREADY_BOUND' });
      // Cached display data never decides native authorization.
      await inspect(value.sessionId, epoch, true);
      if (epoch !== generation) return;
      const plan = await api.prepare(value.sessionId, value.preset);
      if (epoch !== generation) { await api.cancel(plan.session_id, plan.plan_id); return; }
      if (plan.confirmation_required) emit({ plan, acknowledged: false });
      else { const saved = await api.confirm(plan.session_id, plan.plan_id, null);
        if (epoch === generation) { await refreshDirectory(epoch); await inspect(plan.session_id, epoch); emit({ editIntent: 'edit', message: savedMessage(saved) }); } }
    }),
    confirm: () => run(async epoch => {
      const plan = value.plan;
      if (!plan || !value.acknowledged) throw Object.assign(new Error('请先确认这次具体权限变更。'), { code: 'CONFIRMATION_REQUIRED' });
      const saved = await api.confirm(plan.session_id, plan.plan_id, { accepted: true, session_id: plan.session_id,
        from_preset: plan.before.current_preset, to_preset: plan.desired.preset, expected_revision: plan.before.revision });
      if (epoch === generation) { await refreshDirectory(epoch); await inspect(plan.session_id, epoch); emit({ editIntent: 'edit', message: savedMessage(saved) }); }
    }),
    unbind: sessionId => run(async epoch => {
      if (!value.sessions.some(row => row.session_id === sessionId && row.bound))
        throw Object.assign(new Error('该对话未绑定。'), { code: 'SESSION_NOT_BOUND' });
      await api.unbind(sessionId);
      await refreshDirectory(epoch);
      if (epoch !== generation) return;
      if (value.sessionId === sessionId) await inspect(sessionId, epoch);
      emit({ message: '已解除这个对话的桥接绑定；其他绑定、官方权限与服务端口不变。' });
    }),
    cancel: () => run(async () => { const plan = value.plan; if (plan) await api.cancel(plan.session_id, plan.plan_id);
      emit({ plan: null, acknowledged: false, message: '已取消，未修改权限或已保存配置。' }); }),
    setPort(portInput) { emit({ portInput, portError: null, portMessage: '' }); },
    async savePort() {
      const text = value.portInput.trim(), expected = value.listener?.configured_port ?? value.listener?.port;
      if (!/^\d{4,5}$/.test(text) || Number(text) < 1024 || Number(text) > 65535) {
        emit({ portError: { code: 'INVALID_LISTENER_PORT', message: '端口必须是1024至65535之间的整数。' } }); return;
      }
      emit({ loading: true, portError: null, portMessage: '' });
      try {
        const actual = api.readFresh ? await api.readFresh('listener') : await api.listener();
        if ((actual.configured_port ?? actual.port) !== expected) {
          emit({ listener: actual });
          throw Object.assign(new Error('实际端口已变化；请核对最新状态后再次保存。'), { code: 'LISTENER_CHANGED_REFRESH_REQUIRED' });
        }
        const result = await api.savePort(Number(text), expected);
        emit({ listener: result.listener, portInput: String(result.listener.configured_port),
          portMessage: `端口已保存并生效：127.0.0.1:${result.listener.actual_port ?? result.listener.port}。无需重启宿主。` });
      } catch (error) { emit({ portError: errorOf(error) }); }
      finally { emit({ loading: false }); }
    },
    dispose() { cancelOld(value.plan); disposed = true; generation++; pageGeneration++; loadingPage = null; subscribers.clear(); },
  };
}

/** Host React with scoped form styles and native keyboard controls. */
function createPanelView(React) {
  const h = React.createElement;
  const css = `
.dsb-panel{box-sizing:border-box;width:100%;min-width:0;max-width:820px;padding:4px 2px 24px;color:var(--dsw-alias-label-primary,#e5e7eb);font-family:inherit;font-size:14px;line-height:1.55;text-align:left;}
.dsb-panel *{box-sizing:border-box;}.dsb-panel h2,.dsb-panel h3,.dsb-panel p{position:static;float:none;height:auto;width:auto;white-space:normal;margin:0 0 10px;overflow-wrap:anywhere;line-height:1.55;}
.dsb-panel h2{font-size:19px;font-weight:600;}.dsb-panel h3{font-size:15px;font-weight:600;}
.dsb-panel .dsb-card{display:block;position:static;min-width:0;border:1px solid var(--dsw-alias-border-main,#52525b);border-radius:10px;padding:14px;margin:14px 0;background:var(--dsw-alias-bg-layer-2,#202126);}
.dsb-panel label{display:block;position:static;float:none;width:100%;height:auto;margin:10px 0 5px;white-space:normal;line-height:1.6;}
.dsb-panel input,.dsb-panel select,.dsb-panel button{font:inherit;letter-spacing:normal;line-height:1.5;color:inherit;position:static;float:none;transform:none;max-width:100%;}
.dsb-panel input:not([type=checkbox]),.dsb-panel select{display:block;appearance:auto;width:100%;height:auto;min-height:38px;padding:8px 10px;margin:4px 0 10px;background:var(--dsw-alias-bg-layer-1,#141519);border:1px solid #71717a;border-radius:6px;outline-offset:2px;}
.dsb-panel select[size]{height:158px;padding:4px;}.dsb-panel option{white-space:normal;padding:5px 7px;min-height:30px;color:inherit;background:var(--dsw-alias-bg-layer-1,#141519);}
.dsb-panel select[size] option:checked{background:#2563eb;color:#fff;}.dsb-panel option:disabled{color:#9ca3af;}
/* Keep native listbox/dropdown semantics inside this plugin even when a host
   theme styles all settings selects as customizable flex base-select controls. */
.dsb-panel select,.dsb-panel select[size]{appearance:auto!important;-webkit-appearance:auto!important;display:block!important;align-items:normal!important;flex-direction:column!important;white-space:normal!important;text-overflow:clip!important;}
.dsb-panel select option{display:block!important;white-space:normal!important;}
.dsb-panel input:not([type=checkbox]),.dsb-panel select{min-height:38px!important;}
.dsb-panel select[size]{overflow-y:auto!important;overflow-x:hidden!important;}
.dsb-panel label{display:block!important;position:static!important;transform:none!important;height:auto!important;}
.dsb-panel .dsb-card{display:block!important;position:static!important;}
.dsb-panel button{display:inline-block;min-height:38px;height:auto;width:auto;padding:8px 12px;margin:0;border:1px solid #71717a;border-radius:6px;background:transparent;cursor:pointer;white-space:normal;}
.dsb-panel :is(button,input,select):disabled{opacity:.55;cursor:default;}.dsb-panel :is(button,input,select):focus-visible{outline:2px solid #60a5fa;outline-offset:2px;}
.dsb-panel .dsb-actions{display:flex;flex-wrap:wrap;align-items:center;gap:10px;margin-top:12px;}.dsb-panel .dsb-facts{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,180px),1fr));gap:12px 20px;margin:12px 0;}
.dsb-panel .dsb-fact{min-width:0;}.dsb-panel dt{font-size:12px;opacity:.7;margin:0;}.dsb-panel dd{margin:3px 0 0;overflow-wrap:anywhere;line-height:1.5;}
.dsb-panel .dsb-help{font-size:12px;opacity:.75;}.dsb-panel .dsb-error{border-color:#ef4444;}.dsb-panel .dsb-success{color:#86efac;}.dsb-panel .dsb-confirm{border:2px solid #d97706;}
.dsb-panel .dsb-check{display:flex;align-items:flex-start;gap:8px;margin-top:14px;}.dsb-panel input[type=checkbox]{appearance:auto;flex:0 0 18px;width:18px;height:18px;min-height:18px;margin:3px 0 0;padding:0;}
@media(max-width:480px){.dsb-panel .dsb-card{padding:10px;}.dsb-panel .dsb-actions button{flex:1 1 145px;}}
`;
  const presetLabel = option => typeof option.name === 'string' ? option.name : option.name?.zh ?? option.name?.en ?? option.value;
  const stamp = row => row.created_at !== null && row.created_at !== undefined && Number.isFinite(new Date(row.created_at).getTime())
    ? new Date(row.created_at).toLocaleString('zh-CN', { hour12: false }) : '创建时间未知';
  const title = row => row?.title || row?.expected_title || '未命名对话';
  return function BridgeConnectionPanel({ controller }) {
    const state = React.useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
    React.useEffect(() => { void controller.load(); return () => controller.dispose(); }, [controller]);
    const current = state.view?.current, plan = state.plan, selected = state.sessions.find(row => row.session_id === state.sessionId);
    const options = current?.presets?.length ? current.presets : state.permissionPresets ?? [];
    const namedPreset = value => options.find(row => row.value === value) ? presetLabel(options.find(row => row.value === value)) : value ?? '尚未读取';
    const desired = state.preset === null ? current : current?.preset_specs?.[state.preset];
    const matched = Boolean(current?.native_state_known && desired && (state.preset === null || current.current_preset === state.preset)
      && current.sandbox === desired.sandbox && current.approval === desired.approval);
    const visible = state.sessions.filter(row => (state.editIntent !== 'add' || !row.bound)
      && ([title(row), row.workspace ?? ''].some(text => text.toLocaleLowerCase().includes(state.search.trim().toLocaleLowerCase())) || row.session_id === state.sessionId));
    const act = (text, onClick, disabled = false) => h('button', { type: 'button', onClick, disabled: disabled || state.loading }, text);
    const cell = (name, value) => h('div', { className: 'dsb-fact', key: name }, h('dt', null, name), h('dd', null, value ?? '尚未读取'));
    const error = (value, heading) => value ? h('div', { role: 'alert', className: 'dsb-card dsb-error' }, h('strong', null, heading + '：' + value.code),
      h('p', null, value.code === 'OPEN_TARGET_IN_NATIVE_UI' || value.code === 'SESSION_NOT_RESIDENT_OPEN_IN_NATIVE_UI'
        ? '请先在DSH打开这个对话，再刷新状态。插件不会为了设置启动模型任务。' : value.message),
      value.details?.current?.listening ? h('p', null, '原服务仍在监听，端口未切换。') : null,
      value.details?.current?.current_preset ? h('p', null, `实际权限读回：${value.details.current.current_preset} / ${value.details.current.sandbox} / ${value.details.current.approval}`) : null,
      value.details?.native_change_may_have_applied ? h('p', null, '官方接口可能已应用部分变化；请刷新核对。插件不会自动恢复权限或重试。') : null) : null;
    const listener = state.listener;
    const requestState = !selected ? '未选择对话' : selected.agent_status && selected.agent_status !== 'idle'
      ? `执行中（${selected.agent_status}）` : '空闲（没有命令，正常状态）';
    return h('section', { className: 'dsb-panel', 'aria-label': 'Bridge 连接权限' }, h('style', null, css),
      h('h2', null, 'Bridge 本地服务与会话'), h('p', { className: 'dsb-help', 'data-bridge-ui-build': '0.8.0' }, '0.8.0 · 多项目会话桥接'),
      h('p', null, '服务监听、目标对话和权限配置分别管理。没有请求时正常空闲，不代表断连。'),
      h('div', { className: 'dsb-card', 'aria-label': '本地服务监听' }, h('h3', null, '本地服务监听'),
        h('p', { role: 'status' }, listener ? (listener.listening ? `监听正常 · 127.0.0.1:${listener.actual_port ?? listener.port}` : `未监听${listener.error ? ' · '+listener.error : ''}`) : state.listenerLoading ? '正在读取监听状态…' : '监听状态尚未读取'),
        listener && state.listenerLoading ? h('p', { className: 'dsb-help', role: 'status' }, '显示上次读取结果，正在更新监听状态…') : null,
        h('p', { className: 'dsb-help' }, '仅本机127.0.0.1；插件加载时启动。保存对话权限不会启动端口，也不会提交命令。'),
        cell('已保存的配置端口', listener?.configured_port ?? listener?.port), h('label', { htmlFor: 'dsb-port' }, '服务端口'),
        h('input', { id: 'dsb-port', 'aria-label': '服务端口', type: 'text', inputMode: 'numeric', value: state.portInput,
          disabled: state.loading || !listener, onChange: event => controller.setPort(event.target.value) }),
        act('保存并应用端口', () => void controller.savePort(), !listener),
        h('p', { className: 'dsb-help' }, '范围1024–65535。新端口成功监听并保存后才切换；冲突时保留原服务，不终止其他进程。外部调用方需使用新端口。'),
        state.portMessage ? h('p', { role: 'status', className: 'dsb-success' }, state.portMessage) : null,
        error(state.portError, '端口未应用'), error(state.listenerError, '读取监听状态失败')),
      h('div', { className: 'dsb-card', 'aria-label': '全部已绑定对话' }, h('h3', null, '全部已绑定对话'),
        h('div', { className: 'dsb-actions' }, h('button', { id: 'dsb-add-binding', type: 'button', disabled: state.loading || state.sessionsLoading,
          onClick: () => controller.beginAdd() }, '新增绑定')),
        h('p', { className: 'dsb-help' }, '可同时绑定多个对话。下方选择只改变当前编辑对象，不替换其他绑定。每次请求仍须明确指定目标对话。'),
        ...state.sessions.filter(row => row.bound).map(row => h('div', { key: row.session_id, className: 'dsb-card' },
          h('strong', null, title(row)), h('p', { className: 'dsb-help' }, row.workspace ?? '目录暂不可读'), h('p', { className: 'dsb-help' }, stamp(row)),
          row.available === false ? h('p', null, '当前不可访问，绑定记录保留。') : null,
          h('div', { className: 'dsb-actions' }, act('编辑这个对话', () => void controller.editBinding(row.session_id), row.available === false || state.sessionsLoading),
            act('解除此对话绑定', () => void controller.unbind(row.session_id))))),
        !state.sessions.some(row => row.bound) && !state.listError ? h('p', null, state.sessionsLoading ? '正在读取已绑定对话…' : '尚未读取到已绑定对话。') : null),
      h('div', { className: 'dsb-card', 'aria-label': '选择目标对话' }, h('h3', null, state.editIntent === 'add' ? '新增绑定：选择尚未绑定的对话' : '选择当前编辑的对话'),
        h('p', { className: 'dsb-help' }, '可选择各项目中官方可访问的顶层对话。每个绑定单独固定目录；查看列表不会连接或保存其他会话。'),
        h('label', { htmlFor: 'dsb-search' }, '搜索对话名称或项目目录'), h('input', { id: 'dsb-search', type: 'search', 'aria-label': '搜索对话名称或项目目录',
          value: state.search, onChange: event => controller.setSearch(event.target.value) }), h('label', { htmlFor: 'dsb-sessions' }, '目标对话'),
        h('select', { id: 'dsb-sessions', 'aria-label': '目标对话', size: 5, value: state.sessionId, disabled: state.loading || (state.sessionsLoading && !state.sessions.length),
          onChange: event => void controller.selectSession(event.target.value) }, h('option', { value: '', disabled: true }, '请选择目标对话'),
          ...visible.map(row => h('option', { key: row.session_id, value: row.session_id, disabled: row.available === false },
            `${title(row)} · ${row.workspace ?? "目录暂不可读"} · ${stamp(row)} · 对话${state.sessions.indexOf(row)+1}${row.available === false ? '（不可用）' : ''}`))),
        state.sessionsLoading ? h('p', { role: 'status' }, '正在读取对话列表…') : null,
        !state.sessionsLoading && !state.listError && !visible.length ? h('p', { role: 'status' }, state.sessions.length ? '没有匹配的对话。' : '没有可访问的顶层对话。') : null,
        error(state.listError, '读取对话列表失败'), h('dl', { className: 'dsb-facts' }, cell('已选择', selected ? `${title(selected)} · ${stamp(selected)}` : '尚未选择'),
          cell('项目目录', selected?.workspace ?? current?.workspace), cell('请求执行状态', requestState), cell('会话绑定', state.view?.preference_saved || selected?.bound ? '已绑定' : '尚未保存绑定'))),
      h('div', { className: 'dsb-card', 'aria-label': '会话权限配置' }, h('h3', null, '会话权限配置'),
        state.viewLoading ? h('p', { role: 'status' }, '正在读取此对话的实际权限…') : null,
        h('dl', { className: 'dsb-facts' }, cell('当前官方权限预设', current ? namedPreset(current.current_preset) : null),
          cell('当前sandbox / 审批', current ? `${current.sandbox ?? '尚不可读'} / ${current.approval ?? '尚不可读'}` : null),
          cell('配置匹配', current ? (matched ? '匹配' : '不匹配或有效权限尚不可读') : '先选择目标对话')),
        h('label', { htmlFor: 'dsb-preset' }, '连接权限等级'),
        h('select', { id: 'dsb-preset', 'aria-label': '连接权限等级', value: state.preset ?? '', disabled: state.loading || !options.length,
          onChange: event => controller.selectPreset(event.target.value || null) }, h('option', { value: '' }, '沿用当前官方权限（不修改权限）'),
          ...options.map(option => h('option', { key: option.value, value: option.value }, presetLabel(option)))),
        state.presetsLoading ? h('p', { role: 'status', className: 'dsb-help' }, options.length ? '显示缓存档位，正在更新官方选项…' : '正在读取官方权限档位…') : null,
        error(state.presetsError, '读取官方权限档位失败'),
        h('p', { className: 'dsb-help', role: options.length ? undefined : 'status' }, options.length
          ? `已读取${options.length}个官方档位。选择不会立即改权限；保存仍须选择目标对话，具体变化须确认后再调用官方接口。`
          : '尚未读取到官方权限档位。请刷新列表；不会以“沿用当前”冒充完整选项。'),
        h('div', { className: 'dsb-actions' }, act(state.editIntent === 'add' ? '新增此绑定' : '保存此对话的绑定配置', () => void controller.connect(), !current || state.viewLoading), act('刷新列表与状态', () => void controller.load({ fresh: true }))),
        state.loading ? h('p', { role: 'status' }, '正在处理…') : null, state.message ? h('p', { role: 'status', className: 'dsb-success' }, state.message) : null,
        error(state.error, '操作未完成')),
      plan ? h('div', { role: 'dialog', 'aria-modal': false, tabIndex: -1, 'aria-label': '确认本次权限变更', className: 'dsb-card dsb-confirm' },
        h('h3', null, '确认本次权限变更'), h('p', null, `仅目标对话：${title(selected)} · ${selected ? stamp(selected) : ''}`),
        h('p', null, `当前：${namedPreset(plan.before.current_preset)} · sandbox=${plan.before.sandbox} · approval=${plan.before.approval}`),
        h('p', null, `将调整为：${namedPreset(plan.desired.preset)} · sandbox=${plan.desired.sandbox} · approval=${plan.desired.approval}`),
        h('p', null, '不会提交模型任务。取消会保留原权限和已保存配置。'),
        h('label', { className: 'dsb-check' }, h('input', { type: 'checkbox', checked: state.acknowledged,
          onChange: event => controller.acknowledge(event.target.checked) }), h('span', null, '我确认对上述具体对话执行这次权限变更。')),
        h('div', { className: 'dsb-actions' }, act('取消，保留原状态', () => void controller.cancel()), act('确认调整并保存', () => void controller.confirm(), !state.acknowledged))) : null);
  };
}

// Package graph dependencies live in package.json; Cordis requires service keys here.
const inject = ['remote', 'slots'];
function apply(ctx) {
  const React = require('react');
  const View = createPanelView(React);
  let mounted, nativeRemote;
  const waiters = new Set();
  const getRemote = () => nativeRemote ? Promise.resolve(nativeRemote) : new Promise((resolve, reject) => {
    const item = { resolve, reject };
    item.timer = setTimeout(() => { waiters.delete(item); reject(Object.assign(new Error('宿主接口尚未就绪，请稍后刷新。'), {code:'HOST_RPC_NOT_READY'})); }, 7000);
    waiters.add(item);
  });
  ctx.effect(() => {
    mounted = ctx.remote.$mount(TYPERT_REMOTE);
    void Promise.resolve(mounted).catch(() => {});
    return mounted;
  });
  // Preserve the native injected scope, but register the page independently:
  // remote startup must not hide the settings entry or block the first render.
  ctx.inject(['remote.codexBridgeConnection'], scoped => {
    nativeRemote = scoped.remote.codexBridgeConnection;
    for (const item of waiters) { clearTimeout(item.timer); item.resolve(nativeRemote); }
    waiters.clear();
    return () => { nativeRemote = null; };
  });
  ctx.effect(() => () => { for (const item of waiters) { clearTimeout(item.timer); item.reject(Object.assign(new Error('页面接口已卸载'),{code:'BRIDGE_UNLOADED'})); } waiters.clear(); });
  const raw = Object.fromEntries(['list','presets','snapshot','prepare','confirm','cancel','listener','savePort','unbind'].map(name => [name, async (...args) => {
    const remote = await getRemote();
    const result = await remote[name](...args);
    if (!result.ok) throw Object.assign(new Error(result.error.message || result.error.code), {code: result.error.code, details: result.error.details});
    return result.value;
  }]));
  const api = createPanelReadCache(raw);
  function Panel() {
    const [controller] = React.useState(() => createPanelController(api));
    return React.createElement(View, {controller});
  }
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section', id: 'codex-bridge-connection', order: 60, label: 'Bridge 连接权限',
  }, Panel));
}
return {apply,inject};

}});
