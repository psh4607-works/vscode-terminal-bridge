const { test } = require('node:test');
const assert = require('node:assert/strict');
const { TerminalBridge } = require('../dist/core');
const { fixture, tick } = require('./helpers.cjs');

test('unknown exit status does not claim shell idle (subshell or interrupted tracking)', async () => {
  const f = fixture(); const bridge = new TerminalBridge(f.window);
  const terminal = await bridge.dispatch('terminal.create', {}); const t = f.terminals[0];
  const run = f.execution(t); f.integration(t, () => run.e);
  await bridge.dispatch('terminal.execute', { terminalId: terminal.id, command: 'nested-shell' });
  run.end(undefined); await tick();
  assert.equal((await bridge.dispatch('terminal.list', {}))[0].state, 'unknown');
  await assert.rejects(bridge.dispatch('terminal.execute', { terminalId: terminal.id, command: 'echo next' }), { code: 'TERMINAL_STATE_UNKNOWN' });
  bridge.dispose();
});

test('end event may precede output drain, and a late start event must not re-open the run', async () => {
  const f = fixture(); const bridge = new TerminalBridge(f.window);
  const terminal = await bridge.dispatch('terminal.create', {}); const t = f.terminals[0];
  let release; let reads = 0;
  const gate = new Promise(resolve => { release = resolve; });
  const e = { commandLine: { value: 'printf tail' }, read() { reads++; return (async function* () { yield 'head'; await gate; yield 'tail'; })(); } };
  f.integration(t, () => e);
  const run = await bridge.dispatch('terminal.execute', { terminalId: terminal.id, command: 'printf tail' });
  f.emit('EndTerminalShellExecution', { terminal: t, execution: e, exitCode: 0 });
  f.emit('StartTerminalShellExecution', { terminal: t, execution: e });
  assert.equal((await bridge.dispatch('execution.status', { executionId: run.id })).outputComplete, false);
  release(); await tick();
  const result = await bridge.dispatch('execution.read', { executionId: run.id });
  assert.equal(result.output, 'headtail'); assert.equal(result.status, 'ended');
  assert.equal(result.outputComplete, true); assert.equal(reads, 1);
  assert.equal((await bridge.dispatch('terminal.list', {}))[0].state, 'idle');
  bridge.dispose();
});

test('caps bridge-started active executions rather than losing observation of a running command', async () => {
  const f = fixture(); const bridge = new TerminalBridge(f.window, { maxOutputUnits: 32, maxExecutions: 1 });
  const first = await bridge.dispatch('terminal.create', {});
  const second = await bridge.dispatch('terminal.create', {});
  let calls = 0;
  for (const t of f.terminals) f.integration(t, () => { calls++; return f.execution(t).e; });
  const active = await bridge.dispatch('terminal.execute', { terminalId: first.id, command: 'sleep 100' });
  await assert.rejects(bridge.dispatch('terminal.execute', { terminalId: second.id, command: 'sleep 100' }), { code: 'EXECUTION_LIMIT' });
  assert.equal(calls, 1);
  assert.equal((await bridge.dispatch('execution.status', { executionId: active.id })).status, 'running');
  bridge.dispose();
});

test('clean-shell is opt-in and points zsh to an isolated startup directory', async () => {
  const f = fixture(); const original = f.window.createTerminal; const options = [];
  f.window.createTerminal = o => { options.push(o); return original(o); };
  const bridge = new TerminalBridge(f.window, undefined, '/tmp/bridge-clean-zsh');
  await bridge.dispatch('terminal.create', { name: 'default' });
  await bridge.dispatch('terminal.create', { name: 'clean', cleanShell: true });
  assert.equal(options[0].shellPath, undefined); assert.equal(options[0].env, undefined);
  assert.equal(options[1].shellPath, '/bin/zsh');
  assert.deepEqual(options[1].env, { ZDOTDIR: '/tmp/bridge-clean-zsh' });
  bridge.dispose();
});
