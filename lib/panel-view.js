/** Host React with scoped form styles and native keyboard controls. */
export function createPanelView(React) {
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
