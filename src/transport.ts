import * as fs from 'node:fs/promises';
import * as net from 'node:net';
import * as path from 'node:path';
import * as os from 'node:os';

export interface WindowInfo {
  id: string;
  pid: number;
  workspaceFolders: string[];
}

const MAX_REQUEST_BYTES = 65536;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 5000;
const DISCOVERY_TIMEOUT_MS = 500;

export function defaultDirectory(): string {
  return path.join(os.homedir(), '.vscode-terminal-bridge');
}

function fail(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

function validateId(id: string): void {
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(id)) {
    throw fail('INVALID_WINDOW', 'Invalid window ID');
  }
}

function validateSocketPath(socketPath: string): void {
  const maximumBytes = process.platform === 'darwin' ? 103 : 107;
  if (Buffer.byteLength(socketPath) > maximumBytes) {
    throw fail('UNIX_PATH_TOO_LONG', 'Unix socket path is too long; use a shorter bridge directory (--directory)');
  }
}

async function checkDirectory(directory: string, create = false): Promise<void> {
  if (create) await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() ||
      (process.getuid && stat.uid !== process.getuid()) || (stat.mode & 0o077) !== 0) {
    throw fail('UNSAFE_DIRECTORY', 'Bridge directory must be owned by this user and have mode 0700');
  }
}

async function checkFile(filename: string, socket = false): Promise<number> {
  const stat = await fs.lstat(filename);
  if (stat.isSymbolicLink() || (socket ? !stat.isSocket() : !stat.isFile()) ||
      (process.getuid && stat.uid !== process.getuid()) || (stat.mode & 0o077) !== 0) {
    throw fail('UNSAFE_ENDPOINT', 'Unsafe bridge endpoint');
  }
  return stat.size;
}

function errorBody(error: unknown): { code: string; message: string } {
  const detail = error as { code?: unknown; message?: unknown };
  return {
    code: typeof detail?.code === 'string' ? detail.code : 'INTERNAL_ERROR',
    message: typeof detail?.message === 'string' ? detail.message : 'Unknown error',
  };
}

export async function startServer(options: {
  directory?: string;
  metadata: WindowInfo;
  dispatch: (method: string, params: unknown) => Promise<unknown>;
}): Promise<{ close(): Promise<void>; info: WindowInfo }> {
  const directory = options.directory ?? defaultDirectory();
  const info = options.metadata;
  validateId(info.id);
  await checkDirectory(directory, true);
  const socketPath = path.join(directory, info.id + '.sock');
  validateSocketPath(socketPath);
  const descriptorPath = path.join(directory, info.id + '.json');
  const sockets = new Set<net.Socket>();
  const server = net.createServer(socket => {
    if (sockets.size >= 32) {
      socket.destroy();
      return;
    }
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    socket.setTimeout(REQUEST_TIMEOUT_MS, () => socket.destroy());
    let data = Buffer.alloc(0);
    let handled = false;
    socket.on('data', chunk => {
      if (handled) return;
      data = Buffer.concat([data, chunk]);
      if (data.length > MAX_REQUEST_BYTES) {
        handled = true;
        socket.end(JSON.stringify({ error: { code: 'TOO_LARGE', message: 'Request exceeds 64 KiB' } }) + '\n');
        return;
      }
      const newline = data.indexOf(10);
      if (newline < 0) return;
      handled = true;
      socket.pause();
      void (async () => {
        try {
          const envelope = JSON.parse(data.subarray(0, newline).toString('utf8'));
          if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope) ||
              typeof envelope.method !== 'string' || envelope.method.length === 0 ||
              !envelope.params || typeof envelope.params !== 'object' || Array.isArray(envelope.params)) {
            throw fail('INVALID_REQUEST', 'method and an object params are required');
          }
          const result = envelope.method === 'ping'
            ? info : await options.dispatch(envelope.method, envelope.params);
          socket.end(JSON.stringify({ result }) + '\n');
        } catch (error) {
          socket.end(JSON.stringify({ error: errorBody(error) }) + '\n');
        }
      })();
    });
  });
  // Keep later listener errors from becoming unhandled process exceptions.
  server.on('error', () => {});
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => {
      server.off('error', reject);
      resolve();
    });
  });
  try {
    await fs.chmod(socketPath, 0o600);
    await fs.writeFile(descriptorPath, JSON.stringify(info), { mode: 0o600, flag: 'wx' });
  } catch (error) {
    await new Promise<void>(resolve => server.close(() => resolve()));
    throw error;
  }
  let closing: Promise<void> | undefined;
  return {
    info,
    close() {
      closing ??= (async () => {
        for (const socket of sockets) socket.destroy();
        await new Promise<void>(resolve => server.close(() => resolve()));
        await fs.unlink(descriptorPath).catch(() => {});
      })();
      return closing;
    },
  };
}

async function performRequest(windowId: string, method: string, params: unknown,
  directory: string, timeoutMs: number): Promise<unknown> {
  validateId(windowId);
  await checkDirectory(directory);
  const socketPath = path.join(directory, windowId + '.sock');
  validateSocketPath(socketPath);
  await checkFile(socketPath, true);
  const payload = JSON.stringify({ method, params }) + '\n';
  if (Buffer.byteLength(payload) > MAX_REQUEST_BYTES) {
    throw fail('TOO_LARGE', 'Request exceeds 64 KiB');
  }
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let data = Buffer.alloc(0);
    let done = false;
    const finish = (error: unknown, result?: unknown) => {
      if (done) return;
      done = true;
      socket.destroy();
      if (error) reject(error);
      else resolve(result);
    };
    socket.setTimeout(timeoutMs, () => finish(fail('TIMEOUT', 'Bridge request timed out')));
    socket.on('error', error => finish(error));
    socket.on('connect', () => socket.write(payload));
    socket.on('end', () => {
      if (!done) finish(fail('INVALID_RESPONSE', 'Bridge closed without a response'));
    });
    socket.on('data', chunk => {
      data = Buffer.concat([data, chunk]);
      if (data.length > MAX_RESPONSE_BYTES) {
        finish(fail('TOO_LARGE', 'Bridge response too large'));
        return;
      }
      const newline = data.indexOf(10);
      if (newline < 0) return;
      try {
        const response = JSON.parse(data.subarray(0, newline).toString('utf8'));
        if (response.error) finish(fail(response.error.code, response.error.message));
        else finish(null, response.result);
      } catch (error) {
        finish(error);
      }
    });
  });
}

export function request(windowId: string, method: string, params: unknown,
  directory = defaultDirectory()): Promise<unknown> {
  return performRequest(windowId, method, params, directory, REQUEST_TIMEOUT_MS);
}

export async function discover(directory = defaultDirectory()): Promise<WindowInfo[]> {
  try {
    await checkDirectory(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const filenames = (await fs.readdir(directory))
    .filter(name => /^[a-zA-Z0-9_-]{1,64}\.json$/.test(name));
  const results: WindowInfo[] = [];
  let nextIndex = 0;
  const worker = async () => {
    while (nextIndex < filenames.length) {
      const name = filenames[nextIndex++];
      try {
        const filename = path.join(directory, name);
        if (await checkFile(filename) > MAX_REQUEST_BYTES) continue;
        const raw = await fs.readFile(filename);
        if (raw.length > MAX_REQUEST_BYTES) continue;
        const info = JSON.parse(raw.toString('utf8')) as WindowInfo;
        if (info.id !== name.slice(0, -5)) continue;
        const live = await performRequest(info.id, 'ping', {}, directory, DISCOVERY_TIMEOUT_MS) as WindowInfo;
        if (live.id === info.id && typeof live.pid === 'number' &&
            Array.isArray(live.workspaceFolders) && live.workspaceFolders.every(item => typeof item === 'string')) {
          results.push(live);
        }
      } catch {
        // A stale or unsafe endpoint is never deleted by discovery.
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, filenames.length) }, worker));
  return results.sort((left, right) => left.id.localeCompare(right.id));
}
