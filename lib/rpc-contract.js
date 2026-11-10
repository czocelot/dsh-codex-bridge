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
export const TYPERT = { package: 'dsh-codex-bridge', face: 'host', schemas: [], invocations,
  model: { services: [{ key: 'codexBridgeConnection', exportName: 'BridgeSettings', tags: [], types: [],
    summary: 'Explicit session-scoped bridge connection settings; native permission authority is retained.',
    members: definitions.map(([name]) => ({ kind: 'method', name, signature: name + '(...args): Promise<Json>' })) }],
  events: [], objects: [] } };
export const TYPERT_REMOTE = { package: 'dsh-codex-bridge', descriptors: invocations };
