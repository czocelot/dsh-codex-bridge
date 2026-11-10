import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, mkdirSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { dirname } from 'node:path';
import { BridgeError } from './member-control.js';

const fail = (code, details) => { const error = new BridgeError(code, 409); error.details = details; throw error; };
export const validPort = port => Number.isInteger(port) && port >= 1024 && port <= 65535;

/** Only owns this bridge's IPv4 loopback sockets and one plugin-data file. */
export function createListenerControl(config, life, handler, options = {}) {
  const makeServer = options.createServer ?? createServer;
  const file = options.file;
  const basePort = config.port;
  let configuredPort = basePort, active, pending = false, lastError = null;
  const servers = new Set();
  if (file && existsSync(file)) {
    const saved = JSON.parse(readFileSync(file, 'utf8'));
    if (saved.schema !== 'bridge-loopback-listener/1' || !validPort(saved.port)) fail('LISTENER_STORE_INVALID');
    configuredPort = saved.port;
  }
  function snapshot() {
    const address = active?.address();
    return { version: options.version, host: '127.0.0.1', port: typeof address === 'object' ? address?.port ?? null : null,
      actual_port: typeof address === 'object' ? address?.port ?? null : null,
      configured_port: configuredPort, base_config_port: basePort, listening: active?.listening === true,
      applying: pending, error: lastError, apply_mode: 'hot-swap-own-loopback-listener',
      permission_independent_listener: true, requires_restart: false };
  }
  function bind(port) {
    return new Promise((resolve, reject) => {
      const server = makeServer(handler); servers.add(server);
      server.requestTimeout = 10000; server.headersTimeout = 10000;
      server.once('error', error => { servers.delete(server); reject(error); });
      server.listen(port, '127.0.0.1', () => {
        server.on('error', error => { if (server === active) lastError = error.code ?? 'LISTENER_FAILED'; });
        server.unref?.(); resolve(server);
      });
    });
  }
  function persist(port) {
    if (options.persist) return options.persist(port);
    if (!file) return;
    mkdirSync(dirname(file), { recursive: true });
    const temporary = file + '.' + randomBytes(8).toString('hex') + '.tmp';
    try {
      writeFileSync(temporary, JSON.stringify({ schema: 'bridge-loopback-listener/1', port }) + '\n',
        { encoding: 'utf8', flag: 'wx', flush: true });
      renameSync(temporary, file);
      const readback = JSON.parse(readFileSync(file, 'utf8'));
      if (readback.port !== port) throw Error('Listener preference readback mismatch');
    } finally { if (existsSync(temporary)) unlinkSync(temporary); }
  }
  async function start() {
    try { active = await bind(configuredPort); config.port = configuredPort; lastError = null; }
    catch (error) { lastError = error.code ?? 'LISTENER_START_FAILED'; }
    return snapshot();
  }
  async function savePort(port, expectedPort) {
    if (life.closed) fail('BRIDGE_UNLOADED');
    if (!validPort(port)) fail('INVALID_LISTENER_PORT', { minimum: 1024, maximum: 65535 });
    if (pending) fail('LISTENER_CHANGE_IN_PROGRESS');
    if (expectedPort !== configuredPort) fail('LISTENER_CONFIG_CHANGED_REFRESH_REQUIRED', { current: snapshot() });
    if (port === configuredPort && active?.listening) return { saved: true, changed: false, listener: snapshot() };
    pending = true; let next;
    try {
      next = await bind(port);
      if (life.closed) fail('BRIDGE_UNLOADED');
      // The previous listener remains available until both new bind and persistence succeed.
      persist(port);
      const previous = active; active = next; configuredPort = config.port = port; lastError = null;
      next = null;
      if (previous) previous.close(() => servers.delete(previous));
      pending = false;
      return { saved: true, changed: true, listener: snapshot() };
    } catch (error) {
      if (next) { next.close(); servers.delete(next); }
      fail(error.code === 'EADDRINUSE' ? 'LISTENER_PORT_IN_USE' : error.code ?? 'LISTENER_APPLY_FAILED',
        { attempted_port: port, current: snapshot(), previous_listener_retained: active?.listening === true });
    } finally { pending = false; }
  }
  async function close() {
    await Promise.all([...servers].map(server => new Promise(resolve => {
      server.closeAllConnections?.(); server.close(() => { servers.delete(server); resolve(); });
    })));
    active = undefined;
  }
  return { start, snapshot, savePort, close };
}
