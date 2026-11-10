import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const packageRoot = resolve(process.env.BRIDGE_TEST_ROOT ?? '.');
const { createPanelView } = await import(pathToFileURL(resolve(packageRoot, 'lib/panel-view.js')));
const first = { session_id: 'session-project-a', title: 'Same title', workspace: 'C:/Projects/Alpha', bound: false };
const second = { session_id: 'session-project-b', title: 'Same title', workspace: 'D:/Projects/Beta', bound: false };

function render(patch = {}) {
  const state = { sessions: [first, second], sessionId: '', search: '', editIntent: 'add',
    preset: null, portInput: '', loading: false, permissionPresets: [], ...patch };
  const React = { createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    useEffect() {}, useSyncExternalStore: (_subscribe, snapshot) => snapshot() };
  return createPanelView(React)({ controller: { getSnapshot: () => state, subscribe() {} } });
}
function nodes(tree) {
  if (!tree || typeof tree !== 'object') return [];
  if (Array.isArray(tree)) return tree.flatMap(nodes);
  return [tree, ...tree.children.flatMap(nodes)];
}
const textOf = tree => typeof tree === 'string' ? tree : Array.isArray(tree)
  ? tree.map(textOf).join(' ') : tree?.children?.map(textOf).join(' ') ?? '';

test('project-directory search distinguishes identically named sessions', () => {
  const tree = render({ search: 'Beta' });
  const options = nodes(tree).filter(node => node.type === 'option' && node.props.value);
  assert.deepEqual(options.map(node => node.props.value), [second.session_id]);
  assert.ok(textOf(options[0]).includes(second.workspace));
});

test('session choices and the selected session show their project directories', () => {
  const tree = render({ sessionId: first.session_id, editIntent: 'edit' });
  const options = nodes(tree).filter(node => node.type === 'option' && node.props.value);
  assert.ok(textOf(options[0]).includes(first.workspace));
  assert.ok(textOf(options[1]).includes(second.workspace));
  const directoryFact = nodes(tree).find(node => node.type === 'div' && node.props.key === '项目目录');
  assert.ok(textOf(directoryFact).includes(first.workspace));
});
