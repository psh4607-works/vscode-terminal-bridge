const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { resolveNodeRuntime } = require('../dist/node-runtime');

test('resolves and verifies the explicit current Node executable', async () => {
  assert.equal(typeof resolveNodeRuntime, 'function');
  assert.equal(await resolveNodeRuntime(process.execPath), process.execPath);
});

test('rejects missing or relative executables and resolves a bare executable through PATH', async t => {
  await assert.rejects(resolveNodeRuntime('/missing/node'), { code: 'NODE_EXECUTABLE_NOT_FOUND' });
  for (const value of ['', './node', '../node', 'a/b', 'bad\0name', null])
    await assert.rejects(resolveNodeRuntime(value), { code: 'INVALID_PARAMS' });
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'vt-node-'));
  t.after(() => fs.rm(folder, { recursive: true, force: true }));
  await fs.symlink(process.execPath, path.join(folder, 'verified-node'));
  const previous = process.env.PATH;
  process.env.PATH = folder;
  try { assert.equal(await resolveNodeRuntime('verified-node'), path.join(folder, 'verified-node')); }
  finally { process.env.PATH = previous; }
});

test('requires Node 22+ and bounds failed, malformed, noisy, or hanging version probes', async t => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'vt-node-'));
  t.after(() => fs.rm(folder, { recursive: true, force: true }));
  for (const [name, body, code] of [
    ['old', "console.log('v21.9.0')", 'NODE_VERSION_UNSUPPORTED'],
    ['bad', "console.log('SECRET invalid version')", 'NODE_RUNTIME_FAILED'],
    ['failed', "console.error('SECRET'); process.exit(1)", 'NODE_RUNTIME_FAILED'],
    ['noisy', "console.log('SECRET'.repeat(1024))", 'NODE_RUNTIME_FAILED'],
    ['timeout', 'setInterval(() => {}, 1000)', 'NODE_RUNTIME_FAILED'],
  ]) {
    const executable = path.join(folder, name);
    await fs.writeFile(executable, '#!' + process.execPath + '\n' + body + '\n', { mode: 0o700 });
    const started = Date.now();
    await assert.rejects(resolveNodeRuntime(executable), error => error.code === code && !error.message.includes('SECRET'));
    if (name === 'timeout') assert.ok(Date.now() - started < 4500, 'probe must reject before the bridge 5-second request timeout');
  }
  const executable = path.join(folder, 'minimum');
  await fs.writeFile(executable, '#!' + process.execPath + "\nif (process.argv[2] !== '--version') process.exit(1); console.log('v22.0.0')\n", { mode: 0o700 });
  assert.equal(await resolveNodeRuntime(executable), executable);
});


test('preserves an argv0-sensitive runtime shim for explicit and PATH resolution', async t => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'vt-node-shim-'));
  t.after(() => fs.rm(folder, { recursive: true, force: true }));
  const shim = path.join(folder, 'runtime-shim');
  const node = path.join(folder, 'node');
  await fs.writeFile(shim, '#!/bin/sh\ncase "$0" in */node) printf "v22.0.0\\n" ;; *) exit 1 ;; esac\n', { mode: 0o700 });
  await fs.symlink(shim, node);
  assert.equal(await resolveNodeRuntime(node), node);
  const previous = process.env.PATH;
  process.env.PATH = folder;
  try { assert.equal(await resolveNodeRuntime(), node); }
  finally { if (previous === undefined) delete process.env.PATH; else process.env.PATH = previous; }
});
test('version-manager validation uses the agent working directory', async t => {
  const directory = await fs.mkdtemp('/tmp/vtn-cwd-');
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const executable = path.join(directory, 'node');
  const canonical = await fs.realpath(directory);
  await fs.writeFile(executable, '#!/bin/sh\nif [ "$PWD" = "' + canonical + '" ] || [ "$PWD" = "' + directory + '" ]; then echo v22.1.0; else echo v20.1.0; fi\n', { mode: 0o700 });
  assert.equal(await resolveNodeRuntime(executable, directory), executable);
});
