const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
let resolveNodeRuntime;
try { ({ resolveNodeRuntime } = require('../dist/node-runtime')); } catch (error) { if (error.code !== 'MODULE_NOT_FOUND') throw error; }

test('resolves and verifies the explicit current Node executable', async () => {
  assert.equal(typeof resolveNodeRuntime, 'function');
  assert.equal(await resolveNodeRuntime(process.execPath), await fs.realpath(process.execPath));
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
  try { assert.equal(await resolveNodeRuntime('verified-node'), await fs.realpath(process.execPath)); }
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
    await assert.rejects(resolveNodeRuntime(executable), error => error.code === code && !error.message.includes('SECRET'));
  }
  const executable = path.join(folder, 'minimum');
  await fs.writeFile(executable, '#!' + process.execPath + "\nif (process.argv[2] !== '--version') process.exit(1); console.log('v22.0.0')\n", { mode: 0o700 });
  assert.equal(await resolveNodeRuntime(executable), await fs.realpath(executable));
});
