import { BridgeError, nativeServices } from './member-control.js';
import { createSettingsService } from './settings-service.js';
import { TYPERT } from './rpc-contract.js';

export async function initializeHostSettings(state, initialize, dispose) {
  try { await initialize(); }
  catch (error) {
    state.failure = error instanceof BridgeError ? error.code : 'BRIDGE_START_FAILED';
    state.control = null; state.listener = null;
    await dispose();
    // Keep the registered settings service alive to report the startup failure.
    // Letting this reject would dispose its Cordis scope and restore the 404.
  }
  return dispose;
}

/** Register the exact public Gateway contract before asynchronous host startup.
 * Native startup failures stay observable as typed errors instead of HTTP 404.
 * This owns no reviewer, permission preset, model task, or listener. */
export function registerHostSettings(ctx, protocol, state) {
  const ready = () => {
    if (state.closed) throw new BridgeError('BRIDGE_UNLOADED', 503);
    if (state.failure) throw new BridgeError(state.failure, 503);
    if (!state.control || !state.listener) throw new BridgeError('BRIDGE_INITIALIZING', 503);
    return state.control;
  };
  const connection = Object.fromEntries(['snapshot', 'prepare', 'confirm', 'cancel'].map(name =>
    [name, (...args) => ready().connection[name](...args)]));
  const presets = () => {
    if (state.closed) throw new BridgeError('BRIDGE_UNLOADED', 503);
    const { permissionPresets } = nativeServices(ctx, ['permissionPresets']);
    const options = permissionPresets.catalog().options;
    if (!Array.isArray(options) || !options.length || options.some(row => typeof row.value !== 'string'))
      throw new BridgeError('OFFICIAL_PERMISSION_CATALOG_UNAVAILABLE', 503);
    // Independent of session enumeration and listener initialization; read only.
    return { permission_presets: options.map(row => ({ ...row })),
      permission_catalog_source: 'official-permission-presets' };
  };
  const choices = async () => {
    const listing = await ready().choices();
    // Preserve older clients. New clients load this catalogue independently.
    try { return { ...listing, ...presets() }; }
    catch (error) { return { ...listing, permission_presets: [],
      permission_catalog_error: error.code ?? 'OFFICIAL_PERMISSION_CATALOG_UNAVAILABLE' }; }
  };
  const service = createSettingsService(ctx, connection, choices,
    () => {
      ready();
      return state.listener.snapshot();
    }, protocol, (port, expectedPort) => {
      ready();
      return state.listener.savePort(port, expectedPort);
    }, sessionId => ready().unbind(sessionId), presets);
  const unregister = ctx.typert.register(TYPERT);
  return { service, unregister };
}
