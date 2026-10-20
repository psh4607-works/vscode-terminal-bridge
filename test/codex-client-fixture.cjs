#!/usr/bin/env node
const http = require('node:http');
const fs = require('node:fs');
const { WebSocketServer } = require('ws');
const endpoint = process.argv[process.argv.indexOf('--listen') + 1];
let socketPath = endpoint.slice('unix://'.length);
const rendezvous = socketPath;
const mode = ['startup-reset', 'startup-denied', 'initialize-disconnect', 'protected-socket', 'ignore-term', 'unsafe-socket', 'symlink'].find(value => process.argv.includes('model=' + JSON.stringify(value))) ?? '';
if (mode) fs.writeFileSync(require('node:path').join(process.cwd(), 'fixture-info.json'), JSON.stringify({ pid: process.pid, socketPath }));
if (mode === 'ignore-term') process.on('SIGTERM', () => {});
if (mode === 'protected-socket') {
  const path = require('node:path');
  const folder = path.join(fs.realpathSync('/tmp'), 'codex-daemon-' + process.getuid());
  fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
  socketPath = path.join(folder, require('node:crypto').createHash('sha256').update(path.join(fs.realpathSync(path.dirname(rendezvous)), path.basename(rendezvous))).digest('hex'));
  fs.writeFileSync(path.join(process.cwd(), 'fixture-info.json'), JSON.stringify({ pid: process.pid, socketPath: rendezvous, physicalPath: socketPath }));
}
const server = http.createServer();
const wss = new WebSocketServer({ noServer: true });
let upgrades = 0, initializes = 0;
const record = () => {
  if (['startup-reset', 'startup-denied', 'initialize-disconnect'].includes(mode))
    fs.writeFileSync(require('node:path').join(process.cwd(), 'startup-counts.json'), JSON.stringify({ upgrades, initializes }));
};
server.on('upgrade', (request, socket, head) => {
  upgrades++; record();
  if (mode === 'startup-reset' && upgrades <= 2) return socket.destroy();
  if (mode === 'startup-denied') return socket.end('HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n');
  wss.handleUpgrade(request, socket, head, ws => wss.emit('connection', ws, request));
});
wss.on('connection', socket => socket.on('message', bytes => {
  const message = JSON.parse(bytes.toString());
  const respond = result => socket.send(JSON.stringify({ id: message.id, result }));
  if (message.method === 'initialize') { initializes++; record(); if (mode === 'initialize-disconnect') socket.terminate(); else respond({ initialized: true }); }
  else if (message.method === 'initialized') return;
  else if (['thread/resume', 'thread/start', 'thread/fork'].includes(message.method)) setTimeout(() => respond({ thread: { id: message.params.threadId ?? 'new-thread' } }), message.params.delay ?? 0);
  else if (message.method === 'thread/unsubscribe') respond({ status: 'unsubscribed' });
  else if (message.method === 'turn/start' || message.method === 'turn/steer') respond({ turn: { id: 'native-turn', status: 'inProgress' } });
  else if (message.method === 'complete') {
    socket.send(JSON.stringify({ method: 'turn/completed', params: { threadId: message.params.threadId, turn: { id: 'native-turn', status: 'completed' } } }));
    respond({});
  }
  else if (message.method === 'echo') setTimeout(() => respond(message.params), message.params.delay ?? 0);
  else if (message.method === 'fail') socket.send(JSON.stringify({ id: message.id, error: { code: -32001, message: 'fixture failure' } }));
  else if (message.method === 'nativeApproval') {
    socket.expectedApproval = true;
    socket.send(JSON.stringify({ id: 'native-approval', method: 'item/commandExecution/requestApproval', params: { threadId: message.params.threadId } }));
    respond({});
  } else if (!message.method && message.id === 'native-approval' && socket.expectedApproval) {
    socket.expectedApproval = false;
    socket.send(JSON.stringify({ method: 'approvalReceived', params: message }));
  } else if (message.method === 'approval') {
    socket.send(JSON.stringify({ method: 'turn/started', params: { threadId: 'fixture' } }));
    socket.send(JSON.stringify({ id: 'approval-1', method: 'item/commandExecution/requestApproval', params: { threadId: 'fixture' } }));
    respond({ sent: true });
  } else if (message.method === 'disconnect') socket.close();
  else if (message.method === 'malformed') socket.send('{');
  else if (message.method === 'large') socket.send('x'.repeat(8 * 1024 * 1024 + 1));
  else if (!message.method) process.exit(42); // An automatic approval response is a test failure.
}));
if (mode === 'symlink') { fs.symlinkSync('/tmp/nonexistent-codex-fixture', socketPath); setInterval(() => {}, 1000); }
else server.listen(socketPath, () => {
  fs.chmodSync(socketPath, mode === 'unsafe-socket' ? 0o666 : 0o600);
  if (mode === 'protected-socket') fs.symlinkSync(socketPath, rendezvous);
});
