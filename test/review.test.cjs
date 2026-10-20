const { test } = require('node:test');
const assert = require('node:assert/strict');
const { TerminalBridge } = require('../dist/core');
const { fixture, tick } = require('./helpers.cjs');

test('dispose rejects further dispatch and stops consuming an active output stream', async () => {
  const f = fixture(); const bridge = new TerminalBridge(f.window);
  const terminal = await bridge.dispatch('terminal.create', {});
  const t = f.terminals[0];
  let release; let returned = false; let secondChunkRequested = false;
  const execution = { commandLine: { value: 'long-running' }, read() {
    return (async function* () {
      try {
        await new Promise(resolve => { release = resolve; });
        yield 'AFTER_DISPOSE';
        secondChunkRequested = true;
        yield 'MUST_NOT_BE_READ';
      } finally { returned = true; }
    })();
  } };
  f.integration(t, () => execution);
  await bridge.dispatch('terminal.execute', { terminalId: terminal.id, command: 'long-running' });
  bridge.dispose();
  release(); await tick();
  await assert.rejects(bridge.dispatch('terminal.list', {}), { code: 'BRIDGE_CLOSED' });
  assert.equal(returned, true, 'active iterator must be closed after its pending next resolves');
  assert.equal(secondChunkRequested, false, 'disposal must stop requesting additional chunks');
});

test('retention evicts completed runs before an older active run', async () => {
  const f = fixture(); const bridge = new TerminalBridge(f.window, { maxOutputUnits: 32, maxExecutions: 2 });
  const longTerminal = await bridge.dispatch('terminal.create', { name: 'server' });
  const shortTerminal = await bridge.dispatch('terminal.create', { name: 'commands' });
  const long = f.execution(f.terminals[0], ['server output']);
  f.integration(f.terminals[0], () => long.e);
  const active = await bridge.dispatch('terminal.execute', { terminalId: longTerminal.id, command: 'server' });
  let short;
  f.integration(f.terminals[1], () => { short = f.execution(f.terminals[1], ['short']); return short.e; });
  const first = await bridge.dispatch('terminal.execute', { terminalId: shortTerminal.id, command: 'first' });
  short.end(0); await tick();
  await bridge.dispatch('terminal.execute', { terminalId: shortTerminal.id, command: 'second' });
  short.end(0); await tick();
  const status = await bridge.dispatch('execution.status', { executionId: active.id });
  assert.equal(status.status, 'running');
  assert.equal((await bridge.dispatch('execution.read', { executionId: active.id })).output, 'server output');
  await assert.rejects(bridge.dispatch('execution.status', { executionId: first.id }), { code: 'EXECUTION_NOT_FOUND' });
  bridge.dispose();
});
