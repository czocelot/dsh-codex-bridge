/** Uses the public Typert decorator and service base; no new permission service. */
export function createSettingsService(ctx, control, list, listener, protocol, savePort, unbind, presets) {
  const { Remote, TypertRemoteService, RemoteError } = protocol;
  const initializers = [];
  const call = async work => {
    try { return await work(); }
    catch (error) {
      throw new RemoteError(error.code ?? 'BRIDGE_OPERATION_FAILED',
        error.message ?? 'Bridge operation failed', error.details);
    }
  };
  const withTransport = async work => {
    const result = await work();
    const transport = listener();
    return { ...result, permission_ready: result.connected === true,
      connected: result.connected === true && transport.listening === true, transport };
  };
  class BridgeSettings extends TypertRemoteService {
    constructor() {
      super(ctx, 'codexBridgeConnection');
      for (const init of initializers) init.call(this);
    }
    list() { return call(() => list()); }
    presets() { return call(() => presets()); }
    snapshot(sessionId) { return call(() => withTransport(() => control.snapshot(sessionId))); }
    prepare(sessionId, preset) { return call(() => control.prepare(sessionId, preset)); }
    confirm(sessionId, planId, confirmation) { return call(() => withTransport(() => control.confirm(sessionId, planId, confirmation))); }
    cancel(sessionId, planId) { return call(() => control.cancel(sessionId, planId)); }
    listener() { return call(() => listener()); }
    unbind(sessionId) { return call(() => {
      if (!unbind) throw Object.assign(new Error('Unbind is unavailable'), { code: 'UNBIND_UNAVAILABLE' });
      return unbind(sessionId);
    }); }
    savePort(port, expectedPort) { return call(() => {
      if (!savePort) throw Object.assign(new Error('Listener settings are unavailable'), { code: 'LISTENER_CONTROL_UNAVAILABLE' });
      return savePort(port, expectedPort);
    }); }
  }
  // The same standard method-decorator initializer contract emitted by JS compilers.
  for (const name of ['list', 'presets', 'snapshot', 'prepare', 'confirm', 'cancel', 'listener', 'savePort', 'unbind'])
    Remote(BridgeSettings.prototype[name], { kind: 'method', name, static: false, private: false,
      addInitializer(value) { initializers.push(value); } });
  return new BridgeSettings();
}
