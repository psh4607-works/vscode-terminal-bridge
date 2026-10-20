'use strict';
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { runTests } = require('@vscode/test-electron');
(async () => {
  const root = path.resolve(__dirname, '..');
  // macOS Unix sockets have a short pathname limit; os.tmpdir() is often too long.
  const runtime = await fs.mkdtemp('/tmp/vbt-');
  const workspace = path.join(runtime, 'workspace');
  const userData = path.join(runtime, 'user-data');
  const directory = path.join(runtime, 'bridge');
  await fs.mkdir(path.join(userData, 'User'), { recursive: true });
  await fs.mkdir(workspace);
  await fs.writeFile(path.join(userData, 'User', 'settings.json'), JSON.stringify({
    'security.workspace.trust.enabled': false,
    'terminal.integrated.shellIntegration.enabled': true,
    'terminal.integrated.defaultProfile.osx': 'zsh',
    'terminal.integrated.profiles.osx': { zsh: { path: '/bin/zsh', args: [] } },
    'update.mode': 'none', 'telemetry.telemetryLevel': 'off',
    ...(process.env.BRIDGE_TEST_CODEX_PATH ? { 'terminalBridge.codexPath': process.env.BRIDGE_TEST_CODEX_PATH } : {})
  }));
  try {
    await runTests({
      vscodeExecutablePath: process.env.BRIDGE_VSCODE_PATH || '/Applications/Visual Studio Code.app/Contents/MacOS/Code',
      extensionDevelopmentPath: root,
      extensionTestsPath: path.join(root, 'test/integration/index.cjs'),
      extensionTestsEnv: { VSCODE_TERMINAL_BRIDGE_DIR: directory, BRIDGE_NODE_PATH: process.execPath, BRIDGE_TEST_ROOT: root,
        BRIDGE_TEST_WORKSPACE: workspace, BRIDGE_TEST_CODEX: process.env.BRIDGE_TEST_CODEX === '1' ? '1' : '0',
        BRIDGE_TEST_CODEX_MODEL: process.env.BRIDGE_TEST_CODEX_MODEL || '' },
      launchArgs: [workspace, '--user-data-dir', userData, '--extensions-dir', path.join(runtime, 'extensions'), '--disable-extensions', '--skip-welcome', '--skip-release-notes', '--disable-updates', '--disable-workspace-trust', '--new-window']
    });
  } finally { await fs.rm(runtime, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exitCode = 1; });
