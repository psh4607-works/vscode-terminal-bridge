import { EventEmitter } from 'node:events';
import { createServer, type Server } from 'node:http';
import * as fs from 'node:fs/promises';
import WebSocket, { WebSocketServer } from 'ws';

const MAX_FRAME = 8 * 1024 * 1024;
const MAX_BUFFER = 16 * 1024 * 1024;
const MAX_PENDING = 64;
const key = (id: unknown) => JSON.stringify(id);
const validId = (id: unknown) => typeof id === 'string' || typeof id === 'number';

/** A transparent single-native-client relay. Only native RPC traffic establishes a wake binding. */
export class CodexProxy extends EventEmitter {
  private server: Server;
  private wss: WebSocketServer;
  private native?: WebSocket;
  private upstream?: WebSocket;
  private bound?: string;
  private generation = 0;
  private lifecycle = new Map<string, number>();
  private turns = new Map<string, string>();
  private blocked = true;
  private activeTurn?: string;
  private completed = new Set<string>();
  private closing?: Promise<void>;
  private constructor(private backendPath: string, private socketPath: string) {
    super();
    this.server = createServer((_req, res) => { res.writeHead(404); res.end(); });
    this.wss = new WebSocketServer({ server: this.server, maxPayload: MAX_FRAME, perMessageDeflate: false });
    this.wss.on('connection', native => this.connect(native));
    this.server.on('error', () => this.drop());
  }
  static async start(backendPath: string, socketPath: string) {
    const proxy = new CodexProxy(backendPath, socketPath);
    try {
      await new Promise<void>((resolve, reject) => {
        proxy.server.once('error', reject);
        proxy.server.listen(socketPath, () => { proxy.server.off('error', reject); resolve(); });
      });
      await fs.chmod(socketPath, 0o600);
      return proxy;
    } catch (error) { await proxy.close(); throw error; }
  }
  canWake(threadId: string) {
    return !this.closing && this.native?.readyState === WebSocket.OPEN && this.upstream?.readyState === WebSocket.OPEN &&
      this.bound === threadId && !this.blocked && this.lifecycle.size === 0 && this.turns.size === 0;
  }
  private changed() { this.emit('bindingChanged'); }
  private revoke() { this.bound = undefined; this.blocked = true; this.activeTurn = undefined; this.completed.clear(); this.changed(); }
  private drop() {
    const native = this.native, upstream = this.upstream;
    this.native = undefined; this.upstream = undefined;
    this.lifecycle.clear(); this.turns.clear(); this.revoke();
    native?.terminate(); upstream?.terminate();
  }
  private connect(native: WebSocket) {
    native.on('error', () => {});
    if (this.closing || this.native) { native.close(1008, 'Only one native TUI connection is allowed'); return; }
    this.native = native;
    this.revoke();
    const upstream = new WebSocket('ws+unix://' + this.backendPath + ':/', {
      maxPayload: MAX_FRAME, handshakeTimeout: 5000, perMessageDeflate: false,
    });
    this.upstream = upstream;
    let queued: Buffer[] = [], queuedBytes = 0;
    const drop = () => { queued = []; queuedBytes = 0; if (this.native === native) this.drop(); };
    const forward = (destination: WebSocket, bytes: Buffer) => {
      if (destination.readyState !== WebSocket.OPEN || destination.bufferedAmount + bytes.length > MAX_BUFFER) { drop(); return; }
      destination.send(bytes, { binary: false }, error => { if (error) drop(); });
    };
    native.on('close', drop); native.on('error', drop);
    upstream.on('close', drop); upstream.on('error', drop);
    native.on('message', (raw, binary) => {
      if (this.native !== native) return;
      try {
        if (binary) throw new Error('binary protocol frame');
        const bytes = Buffer.isBuffer(raw) ? raw : Buffer.from(raw.toString());
        this.outgoing(JSON.parse(bytes.toString()));
        if (upstream.readyState === WebSocket.CONNECTING) {
          if (queued.length >= MAX_PENDING || queuedBytes + bytes.length > 1024 * 1024) throw new Error('startup queue exceeded');
          queued.push(bytes); queuedBytes += bytes.length;
        } else forward(upstream, bytes);
      } catch { drop(); }
    });
    upstream.on('open', () => {
      if (this.native !== native) { upstream.terminate(); return; }
      for (const bytes of queued) forward(upstream, bytes);
      queued = []; queuedBytes = 0;
    });
    upstream.on('message', (raw, binary) => {
      if (this.native !== native) return;
      try {
        if (binary) throw new Error('binary protocol frame');
        const bytes = Buffer.isBuffer(raw) ? raw : Buffer.from(raw.toString());
        this.incoming(JSON.parse(bytes.toString()));
        forward(native, bytes);
      } catch { drop(); }
    });
  }
  private outgoing(message: any) {
    if (!message || typeof message !== 'object' || Array.isArray(message)) throw new Error('invalid envelope');
    if (!message.method) return; // Approval/question responses are forwarded untouched.
    if (['thread/start', 'thread/resume', 'thread/fork', 'thread/unsubscribe'].includes(message.method)) {
      this.revoke();
      if (!validId(message.id) || this.lifecycle.size >= MAX_PENDING) throw new Error('invalid lifecycle request');
      this.lifecycle.set(key(message.id), ++this.generation);
    } else if (['turn/start', 'turn/steer'].includes(message.method)) {
      this.blocked = true; this.activeTurn = undefined; this.changed();
      if (!validId(message.id) || this.turns.size >= MAX_PENDING) throw new Error('invalid turn request');
      this.turns.set(key(message.id), message.params?.threadId);
    }
  }
  private incoming(message: any) {
    if (!message || typeof message !== 'object' || Array.isArray(message)) throw new Error('invalid envelope');
    if (!message.method && validId(message.id)) {
      const requestKey = key(message.id);
      const generation = this.lifecycle.get(requestKey);
      if (generation !== undefined) {
        this.lifecycle.delete(requestKey);
        if (generation === this.generation) {
          const thread = message.result?.thread;
          if (!message.error && typeof thread?.id === 'string' && thread.id.length <= 128) {
            this.bound = thread.id; this.blocked = thread.status?.type === 'active';
          } else this.revoke();
        }
        this.changed();
      }
      if (this.turns.has(requestKey)) {
        this.turns.delete(requestKey);
        const turn = message.result?.turn;
        if (turn?.id) {
          this.activeTurn = turn.id;
          if (this.completed.has(turn.id) || ['completed', 'failed', 'interrupted'].includes(turn.status)) this.blocked = false;
        }
        // A failed submission remains blocked until fresh idle evidence arrives.
        this.changed();
      }
      return;
    }
    if (message.params?.threadId !== this.bound) return;
    if (message.method === 'turn/started') {
      this.blocked = true; this.activeTurn = message.params.turn?.id; this.changed();
    } else if (message.method === 'turn/completed') {
      const id = message.params.turn?.id;
      if (typeof id === 'string') {
        this.completed.add(id);
        while (this.completed.size > MAX_PENDING) this.completed.delete(this.completed.values().next().value!);
        if (!this.activeTurn || this.activeTurn === id) this.blocked = false;
        this.changed();
      }
    } else if (message.method === 'thread/status/changed') {
      this.blocked = message.params.status?.type !== 'idle'; this.changed();
    } else if (validId(message.id)) { this.blocked = true; this.changed(); }
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closing = Promise.resolve().then(async () => {
      this.drop();
      for (const client of this.wss.clients) client.terminate();
      await new Promise<void>(resolve => this.wss.close(() => resolve()));
      this.server.closeAllConnections();
      await new Promise<void>(resolve => this.server.close(() => resolve()));
    });
    this.revoke();
    return this.closing;
  }
}
