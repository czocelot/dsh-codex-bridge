import { BridgeError } from './member-control.js';
const fail = (code) => { throw new BridgeError(code, 409); };
export function permissionChoice(request) {
  const mode = request.permission_mode ?? (request.initialize_new_auto === true ? 'explicit' : 'native');
  if (!['native', 'follow', 'explicit'].includes(mode)) fail('INVALID_PERMISSION_MODE');
  if (request.initialize_new_auto !== undefined && request.initialize_new_auto !== true) fail('INVALID_LEGACY_PERMISSION_OPTION');
  if (request.initialize_new_auto === true && (request.permission_mode !== undefined || request.permission_preset !== undefined)) fail('CONFLICTING_PERMISSION_OPTIONS');
  const preset = request.initialize_new_auto === true ? 'auto' : request.permission_preset;
  if (mode !== 'explicit' && preset !== undefined) fail('CONFLICTING_PERMISSION_OPTIONS');
  if (mode === 'explicit' && (typeof preset !== 'string' || !preset.trim() || preset.length > 100)) fail('EXPLICIT_PERMISSION_PRESET_REQUIRED');
  return { mode, ...(mode === 'explicit' ? { preset } : {}) };
}
export function selectPermission(request, source) {
  const choice = permissionChoice(request);
  if (choice.mode === 'native') return { mode: 'native' };
  const preset = choice.mode === 'follow' ? source.current_preset : choice.preset;
  const spec = source.preset_specs?.[preset];
  if (!spec || typeof spec.sandbox !== 'string' || typeof spec.approval !== 'string') fail('NATIVE_PRESET_UNAVAILABLE');
  if (choice.mode === 'follow' && (source.sandbox !== spec.sandbox || source.approval !== spec.approval)) fail('SOURCE_PERMISSION_NOT_STABLE');
  return { mode: choice.mode, preset, sandbox: spec.sandbox, approval: spec.approval };
}
export function permissionMatches(view, expected) {
  return view.current_preset === expected.preset && view.sandbox === expected.sandbox && view.approval === expected.approval;
}
export async function applyRotationPermission(settings, sessionId, requestId, expected) {
  let view = await settings.query(sessionId);
  const spec = view.preset_specs?.[expected.preset];
  if (!spec || spec.sandbox !== expected.sandbox || spec.approval !== expected.approval) fail('NATIVE_PRESET_CHANGED');
  if (expected.mode === 'native' && !permissionMatches(view, expected)) fail('NEW_PERMISSION_CHANGED');
  if (!permissionMatches(view, expected)) {
    await settings.change({ session_id: sessionId, request_id: requestId + '-permission', preset: expected.preset, expected_revision: view.revision });
    view = await settings.query(sessionId);
  }
  if (!permissionMatches(view, expected)) fail('NEW_PERMISSION_READBACK_FAILED');
  return view;
}
