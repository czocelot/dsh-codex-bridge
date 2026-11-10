/** User-driven state; never polls or implicitly changes permissions. */
export function createPanelController(api) {
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
