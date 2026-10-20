const { test } = require('node:test');
const assert = require('node:assert/strict');
let TerminalBridge;
try { ({ TerminalBridge } = require('../dist/core')); } catch (e) { if (e.code !== 'MODULE_NOT_FOUND') throw e; }

const { fixture, tick } = require('./helpers.cjs');

test('lists existing terminals with distinct IDs and unknown activity, never guessed idle', async () => {
  assert.equal(typeof TerminalBridge, 'function', 'TerminalBridge must implement terminal discovery');
  const f = fixture(); f.window.createTerminal({ name: 'same' }); f.window.createTerminal({ name: 'same' });
  const bridge = new TerminalBridge(f.window);
  const list = await bridge.dispatch('terminal.list', {});
  assert.equal(list.length, 2); assert.notEqual(list[0].id, list[1].id);
  assert.equal(list[0].state, 'unknown'); assert.equal(list[0].pid, 123);
  assert.equal(list[0].shellIntegration, false);
  bridge.dispose();
});

test('create starts initializing and becomes idle only after integration; close removes terminal', async () => {
  const f = fixture(); const bridge = new TerminalBridge(f.window);
  const created = await bridge.dispatch('terminal.create', { name: 'AI', cwd: '/tmp' });
  assert.equal(created.state, 'initializing'); assert.equal(created.owned, true);
  f.integration(f.terminals[0], () => {});
  assert.equal((await bridge.dispatch('terminal.list', {}))[0].state, 'idle');
  await bridge.dispatch('terminal.close', { terminalId: created.id });
  assert.deepEqual(await bridge.dispatch('terminal.list', {}), []);
  await assert.rejects(bridge.dispatch('terminal.close', { terminalId: created.id }), { code: 'TERMINAL_NOT_FOUND' });
  bridge.dispose();
});

test('executes with one reader across synchronous start event, preserves output and exit code', async () => {
  const f = fixture(); const bridge = new TerminalBridge(f.window);
  const terminal = await bridge.dispatch('terminal.create', {}); const t = f.terminals[0];
  const run = f.execution(t);
  f.integration(t, () => { run.start(); return run.e; });
  const result = await bridge.dispatch('terminal.execute', { terminalId: terminal.id, command: 'echo hello' });
  assert.equal(result.status, 'running'); assert.equal(result.terminalId, terminal.id);
  run.end(7); await tick();
  const output = await bridge.dispatch('execution.read', { executionId: result.id });
  assert.equal(output.output, 'hello\r\n'); assert.equal(output.exitCode, 7);
  assert.equal(output.status, 'ended'); assert.equal(output.outputComplete, true);
  assert.equal(run.reads(), 1);
  assert.equal((await bridge.dispatch('terminal.list', {}))[0].state, 'idle');
  bridge.dispose();
});

test('does not interrupt busy/unknown terminals, rejects missing integration, explicit opt-in permits execution', async () => {
  const f = fixture(); const existing = f.window.createTerminal({}); const bridge = new TerminalBridge(f.window);
  const id = (await bridge.dispatch('terminal.list', {}))[0].id;
  await assert.rejects(bridge.dispatch('terminal.execute', { terminalId: id, command: 'echo test' }), { code: 'SHELL_INTEGRATION_UNAVAILABLE' });
  let calls = 0; let run;
  f.integration(existing, () => { calls++; run = f.execution(existing); return run.e; });
  await assert.rejects(bridge.dispatch('terminal.execute', { terminalId: id, command: 'echo test' }), { code: 'TERMINAL_STATE_UNKNOWN' });
  const result = await bridge.dispatch('terminal.execute', { terminalId: id, command: 'echo test', allowInterrupt: true });
  assert.equal(result.status, 'running');
  await assert.rejects(bridge.dispatch('terminal.execute', { terminalId: id, command: 'echo test' }), { code: 'TERMINAL_BUSY' });
  assert.equal(calls, 1); run.end(undefined); await tick();
  assert.equal((await bridge.dispatch('execution.status', { executionId: result.id })).exitCode, null);
  bridge.dispose();
});

test('bounded output returns absolute UTF-16 cursors and explicit truncation', async () => {
  const f = fixture(); const bridge = new TerminalBridge(f.window, { maxOutputUnits: 8, maxExecutions: 2 });
  const t = await bridge.dispatch('terminal.create', {}); const terminal = f.terminals[0];
  let run;
  f.integration(terminal, () => { run = f.execution(terminal, ['012345', '6789가나']); return run.e; });
  const result = await bridge.dispatch('terminal.execute', { terminalId: t.id, command: 'echo test' });
  run.end(0); await tick();
  const first = await bridge.dispatch('execution.read', { executionId: result.id, cursor: 0, limit: 3 });
  assert.equal(first.output, '456'); assert.equal(first.truncated, true);
  assert.equal(first.baseOffset, 4); assert.equal(first.nextCursor, 7); assert.equal(first.nextOffset, 12);
  const second = await bridge.dispatch('execution.read', { executionId: result.id, cursor: first.nextCursor });
  assert.equal(second.output, '789가나'); assert.equal(second.truncated, false); assert.equal(second.nextCursor, 12);
  await assert.rejects(bridge.dispatch('execution.read', { executionId: result.id, cursor: -1 }), { code: 'INVALID_PARAMS' });
  await assert.rejects(bridge.dispatch('execution.read', { executionId: result.id, cursor: 13 }), { code: 'INVALID_PARAMS' });
  for (let i = 0; i < 2; i++) { await bridge.dispatch('terminal.execute', { terminalId: t.id, command: 'echo test' }); run.end(0); await tick(); }
  await assert.rejects(bridge.dispatch('execution.status', { executionId: result.id }), { code: 'EXECUTION_NOT_FOUND' });
  bridge.dispose();
});

test('send and interrupt are explicit inputs, and closing a running terminal ends its state without inventing exit code', async () => {
  const f = fixture(); const bridge = new TerminalBridge(f.window);
  const t = await bridge.dispatch('terminal.create', {}); const terminal = f.terminals[0];
  f.integration(terminal, () => f.execution(terminal).e);
  await bridge.dispatch('terminal.send', { terminalId: t.id, text: 'hello', enter: true });
  assert.deepEqual(terminal.sent, [['hello', true]]);
  assert.equal((await bridge.dispatch('terminal.list', {}))[0].state, 'unknown');
  const run = await bridge.dispatch('terminal.execute', { terminalId: t.id, command: 'sleep 10', allowInterrupt: true });
  await bridge.dispatch('terminal.interrupt', { terminalId: t.id });
  assert.deepEqual(terminal.sent[1], ['\x03', false]);
  await bridge.dispatch('terminal.close', { terminalId: t.id }); await tick();
  const status = await bridge.dispatch('execution.status', { executionId: run.id });
  assert.equal(status.status, 'closed'); assert.equal(status.exitCode, null);
  bridge.dispose();
});
