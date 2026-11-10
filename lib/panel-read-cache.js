/** Memory-only display cache shared by panel mounts. Never authorizes a write. */
export function createPanelReadCache(raw, { now = () => Date.now(), timeoutMs = 8000 } = {}) {
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
