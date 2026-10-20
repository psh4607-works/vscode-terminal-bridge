import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs/promises';
import { constants } from 'node:fs';
import * as path from 'node:path';
import WebSocket from 'ws';
import { CodexProxy } from './codex-proxy';

const START_TIMEOUT = 15000;
const REQUEST_TIMEOUT = 15000;
// Match the native Codex remote client limit (app-server-client/src/remote.rs).
const MAX_FRAME = 128 * 1024 * 1024;
const MAX_REQUEST = 256 * 1024;
const MAX_PENDING = 64;
function failure(code: string, message: string) { return Object.assign(new Error(message), { code }); }
const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
interface Pending { resolve(value: any): void; reject(error: unknown): void; timer: NodeJS.Timeout }

export class CodexClient extends EventEmitter {
  private socket?: WebSocket;
  private child?: ChildProcess;
  private pending = new Map<string, Pending>();
  private sequence = 0;
  private ended = false;
  private closing?: Promise<void>;
  private stderr = Buffer.alloc(0);
  private proxy?: CodexProxy;
  private physicalSocket?: { path: string; ino: number; dev: number };
  readonly endpoint: string;
  private constructor(private runtime: string, readonly executable: string) { super(); this.endpoint = 'unix://' + path.join(runtime, 't'); }
  get closed() { return this.ended; }
  canWake(threadId: string) { return !this.closed && (this.proxy?.canWake(threadId) ?? false); }

  static async start(options: { cwd: string; executable?: string; model?: string }): Promise<CodexClient> {
    if (!path.isAbsolute(options.cwd) || !(await fs.stat(options.cwd)).isDirectory())
      throw failure('INVALID_PARAMS', 'cwd must be an existing absolute directory');
    if (options.model !== undefined && (typeof options.model !== 'string' || !options.model.trim() || options.model.includes('\0')))
      throw failure('INVALID_PARAMS', 'model must be a nonblank string without NUL');
    const executable = await resolveExecutable(options.executable ?? 'codex');
    // macOS TMPDIR is often too long for sockaddr_un; use a private short runtime directory.
    const runtime = await fs.mkdtemp('/tmp/vtc-');
    await fs.chmod(runtime, 0o700);
    const client = new CodexClient(runtime, executable);
    try {
      const backendPath = path.join(runtime, 's');
      const args = ['app-server', '--listen', 'unix://' + backendPath];
      if (options.model) args.push('-c', 'model=' + JSON.stringify(options.model));
      const child = spawn(executable, args, { cwd: options.cwd, stdio: ['ignore', 'ignore', 'pipe'] });
      client.child = child;
      child.stderr!.on('data', (chunk: Buffer) => {
        // Drain stderr, retain only a small diagnostic tail, and never publish its potentially sensitive text.
        client.stderr = Buffer.concat([client.stderr, chunk]).subarray(-16384);
      });
      child.on('error', () => client.disconnected('CODEX_START_FAILED'));
      child.on('exit', () => client.disconnected('CODEX_DISCONNECTED'));
      const deadline = Date.now() + START_TIMEOUT;
      let socketPath = backendPath;
      for (;;) {
        if (client.closed) throw failure('CODEX_START_FAILED', 'Owned Codex server exited before connecting');
        let stat = await fs.lstat(socketPath).catch(error => {
          if (error.code === 'ENOENT') return undefined;
          throw error;
        });
        if (stat) {
          if (stat.isSymbolicLink()) {
            // Codex 0.161 publishes a deterministic protected alias even for dedicated children.
            const uid = process.getuid?.();
            const folder = path.join(await fs.realpath('/tmp'), 'codex-daemon-' + uid);
            const expected = path.join(folder, createHash('sha256').update(path.join(await fs.realpath(runtime), 's')).digest('hex'));
            if (uid === undefined || stat.uid !== uid || await fs.readlink(socketPath) !== expected)
              throw failure('UNSAFE_CODEX_SOCKET', 'Unexpected owned Codex socket alias');
            const parent = await fs.lstat(folder);
            const target = await fs.lstat(expected);
            if (!parent.isDirectory() || parent.isSymbolicLink() || parent.uid !== uid || (parent.mode & 0o077) ||
                !target.isSocket() || target.isSymbolicLink() || target.uid !== uid || (target.mode & 0o077))
              throw failure('UNSAFE_CODEX_SOCKET', 'Protected Codex socket must be private and owned');
            socketPath = expected; stat = target;
            client.physicalSocket = { path: expected, ino: target.ino, dev: target.dev };
          }
          if (!stat.isSocket() || stat.isSymbolicLink() || (process.getuid && stat.uid !== process.getuid()))
            throw failure('UNSAFE_CODEX_SOCKET', 'Owned Codex endpoint must be a socket owned by this user');
          if (stat.mode & 0o077) await fs.chmod(socketPath, 0o600);
          const verified = await fs.lstat(socketPath);
          if (!verified.isSocket() || verified.isSymbolicLink() || verified.ino !== stat.ino || verified.dev !== stat.dev || (verified.mode & 0o077))
            throw failure('UNSAFE_CODEX_SOCKET', 'Owned Codex socket changed during validation');
          break;
        }
        if (Date.now() >= deadline) throw failure('CODEX_START_TIMEOUT', 'Owned Codex server did not publish its socket');
        await pause(25);
      }
      let socket: WebSocket;
      for (;;) {
        if (client.closed || child.exitCode !== null || child.signalCode !== null)
          throw failure('CODEX_START_FAILED', 'Owned Codex server exited before connecting');
        if (Date.now() >= deadline) throw failure('CODEX_START_TIMEOUT', 'Owned Codex connection did not become ready');
        socket = new WebSocket('ws+unix://' + socketPath + ':/', { maxPayload: MAX_FRAME,
          handshakeTimeout: Math.max(1, deadline - Date.now()), perMessageDeflate: false });
        client.socket = socket;
        try {
          await new Promise<void>((resolve, reject) => {
            const failed = (error: Error) => reject(error);
            const closed = () => reject(failure('CODEX_START_FAILED', 'Owned Codex connection closed during startup'));
            socket.once('error', failed);
            socket.once('close', closed);
            socket.once('open', () => {
              socket.off('error', failed); socket.off('close', closed);
              // Established connections never retry: initialization and requests may already have effects.
              socket.on('message', (data, binary) => client.receive(data, binary));
              socket.on('close', () => client.disconnected('CODEX_DISCONNECTED'));
              socket.on('error', () => client.disconnected('CODEX_DISCONNECTED'));
              resolve();
            });
          });
          break;
        } catch (error) {
          socket.on('error', () => {});
          socket.terminate();
          const retryable = ['ECONNREFUSED', 'ECONNRESET', 'ENOENT'].includes((error as NodeJS.ErrnoException).code ?? '');
          if (!retryable || client.closed || child.exitCode !== null || child.signalCode !== null)
            throw failure('CODEX_START_FAILED', 'Cannot connect to owned Codex server');
          if (Date.now() >= deadline) throw failure('CODEX_START_TIMEOUT', 'Owned Codex connection did not become ready');
          await pause(Math.min(50, deadline - Date.now()));
        }
      }
      await client.request('initialize', { clientInfo: { name: 'vscode_terminal_bridge', title: 'Terminal Bridge', version: '0.4.0' }, capabilities: { experimentalApi: true } });
      socket.send(JSON.stringify({ method: 'initialized' }));
      if (client.closed) throw failure('CODEX_START_FAILED', 'Owned Codex connection closed during initialization');
      client.proxy = await CodexProxy.start(socketPath, client.endpoint.slice('unix://'.length));
      if (client.closed) {
        await client.proxy.close();
        throw failure('CODEX_START_FAILED', 'Owned Codex connection closed while starting native relay');
      }
      client.proxy.on('bindingChanged', () => client.emit('bindingChanged'));
      return client;
    } catch (error) { await client.close(); throw error; }
  }

  request(method: string, params: unknown): Promise<any> {
    if (this.closed || this.socket?.readyState !== WebSocket.OPEN)
      return Promise.reject(failure('CODEX_DISCONNECTED', 'Owned Codex connection is closed'));
    if (typeof method !== 'string' || !method || method.length > 256)
      return Promise.reject(failure('INVALID_PARAMS', 'A bounded method name is required'));
    if (this.pending.size >= MAX_PENDING) return Promise.reject(failure('CODEX_REQUEST_LIMIT', 'Too many pending Codex requests'));
    const id = 'bridge-' + ++this.sequence;
    let payload: string;
    try { payload = JSON.stringify({ id, method, params }); }
    catch { return Promise.reject(failure('INVALID_PARAMS', 'Request must be JSON serializable')); }
    if (Buffer.byteLength(payload) > MAX_REQUEST) return Promise.reject(failure('CODEX_REQUEST_TOO_LARGE', 'Codex request exceeds size limit'));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(failure('CODEX_REQUEST_TIMEOUT', 'Codex request timed out; delivery is unknown and was not retried'));
      }, REQUEST_TIMEOUT);
      this.pending.set(id, { resolve, reject, timer });
      this.socket!.send(payload, error => { if (error) this.disconnected('CODEX_DISCONNECTED'); });
    });
  }

  private receive(data: WebSocket.RawData, binary: boolean) {
    try {
      if (binary) throw new Error('binary frame');
      const message = JSON.parse(data.toString());
      if (!message || typeof message !== 'object' || Array.isArray(message)) throw new Error('invalid envelope');
      if (typeof message.method === 'string') {
        if (message.id !== undefined) {
          if (typeof message.id !== 'string' && typeof message.id !== 'number') throw new Error('invalid request ID');
          this.emit('serverRequest', { id: message.id, method: message.method, params: message.params });
        } else this.emit('notification', { method: message.method, params: message.params });
        return;
      }
      if (typeof message.id !== 'string' && typeof message.id !== 'number') throw new Error('invalid response ID');
      const pending = this.pending.get(String(message.id));
      if (!pending) return; // Timed-out responses are never replayed.
      this.pending.delete(String(message.id)); clearTimeout(pending.timer);
      if (message.error && typeof message.error === 'object') {
        pending.reject(Object.assign(new Error(typeof message.error.message === 'string' ? message.error.message : 'Codex request failed'), { code: message.error.code }));
      } else if ('result' in message) pending.resolve(message.result);
      else { pending.reject(failure('CODEX_PROTOCOL_ERROR', 'Malformed Codex response')); throw new Error('missing result'); }
    } catch { this.disconnected('CODEX_PROTOCOL_ERROR'); }
  }

  private disconnected(code: string) {
    if (this.ended) return;
    this.ended = true;
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(failure(code, 'Owned Codex connection closed')); }
    this.pending.clear();
    this.emit('closed', { code });
    queueMicrotask(() => { void this.close().catch(() => {}); });
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closing = Promise.resolve().then(async () => {
      this.socket?.terminate();
      await this.proxy?.close();
      const child = this.child;
      if (child?.pid && child.exitCode === null && child.signalCode === null) {
        child.kill('SIGTERM');
        const deadline = Date.now() + 1500;
        while (child.exitCode === null && child.signalCode === null && Date.now() < deadline) await pause(25);
        if (child.exitCode === null && child.signalCode === null) {
          child.kill('SIGKILL');
          const killDeadline = Date.now() + 1500;
          while (child.exitCode === null && child.signalCode === null && Date.now() < killDeadline) await pause(25);
        }
      }
      const physical = this.physicalSocket;
      if (physical && (!child || child.exitCode !== null || child.signalCode !== null)) {
        const stat = await fs.lstat(physical.path).catch(error => { if (error.code === 'ENOENT') return undefined; throw error; });
        if (stat?.isSocket() && stat.ino === physical.ino && stat.dev === physical.dev) await fs.unlink(physical.path);
      }
      this.stderr = Buffer.alloc(0);
      await fs.rm(this.runtime, { recursive: true, force: true });
    });
    this.disconnected('CODEX_DISCONNECTED');
    return this.closing;
  }
}

async function resolveExecutable(value: string): Promise<string> {
  if (typeof value !== 'string' || !value || value.includes('\0')) throw failure('INVALID_PARAMS', 'A valid executable is required');
  if (value.includes(path.sep) && !path.isAbsolute(value)) throw failure('INVALID_PARAMS', 'Executable paths must be absolute');
  const candidates = path.isAbsolute(value) ? [value] : (process.env.PATH ?? '').split(path.delimiter).filter(path.isAbsolute).map(folder => path.join(folder, value));
  for (const candidate of candidates) {
    try { if ((await fs.stat(candidate)).isFile()) { await fs.access(candidate, constants.X_OK); return candidate; } } catch {}
  }
  throw failure('CODEX_EXECUTABLE_NOT_FOUND', 'Codex executable was not found or is not executable');
}
