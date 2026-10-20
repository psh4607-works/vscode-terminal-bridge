function fixture() {
  const listeners = {};
  const terminals = [];
  const emit = (name, value) => { for (const f of listeners[name] || []) f(value); };
  const window = { terminals, createTerminal(options) {
    const terminal = { name: options.name || 'shell', processId: Promise.resolve(123), sent: [],
      sendText(text, enter) { this.sent.push([text, enter]); },
      dispose() { terminals.splice(terminals.indexOf(this), 1); emit('CloseTerminal', this); },
      show() {} };
    terminals.push(terminal); emit('OpenTerminal', terminal); return terminal;
  }};
  for (const event of ['OpenTerminal', 'CloseTerminal', 'ChangeTerminalShellIntegration', 'StartTerminalShellExecution', 'EndTerminalShellExecution']) {
    window['onDid' + event] = f => { (listeners[event] ||= []).push(f); return { dispose() {} }; };
  }
  function integration(terminal, execute) {
    terminal.shellIntegration = { cwd: { toString: () => 'file:///tmp', fsPath: '/tmp' }, executeCommand: execute };
    emit('ChangeTerminalShellIntegration', { terminal, shellIntegration: terminal.shellIntegration });
  }
  function execution(terminal, chunks = ['hello\r\n']) {
    let reads = 0;
    const e = { commandLine: { value: 'echo hello', confidence: 2, isTrusted: true },
      cwd: { toString: () => 'file:///tmp' }, read() { reads++; return (async function* () { for (const chunk of chunks) yield chunk; })(); } };
    return { e, start: () => emit('StartTerminalShellExecution', { terminal, execution: e }),
      end: code => emit('EndTerminalShellExecution', { terminal, execution: e, exitCode: code }), reads: () => reads };
  }
  return { window, emit, integration, execution, terminals };
}
const tick = () => new Promise(resolve => setImmediate(resolve));


module.exports = { fixture, tick };
