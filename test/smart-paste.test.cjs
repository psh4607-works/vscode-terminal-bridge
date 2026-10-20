const { test } = require('node:test');
const assert = require('node:assert/strict');
let createSmartPaste;
try { ({ createSmartPaste } = require('../dist/smart-paste')); } catch (e) { if (e.code !== 'MODULE_NOT_FOUND') throw e; }
function fixture(readClipboard) {
  const writes = []; const notices = [];
  const terminal = { sendText: (...args) => writes.push(args) };
  const host = { activeTerminal: terminal, terminals: [terminal], remote: false, enabled: true,
    fallback: async () => writes.push('fallback'), warn: text => notices.push(text), readClipboard };
  return { host, writes, notices, run: () => createSmartPaste(host)() };
}
test('smart paste inserts mixed Finder file paths, quoting shell metacharacters without Enter', async () => {
  assert.equal(typeof createSmartPaste, 'function', 'smart paste command controller must exist');
  const f = fixture(async () => ({ kind: 'files', paths: ['/tmp/movie clip.mov', "/tmp/O'Brien $(touch nope)", '/tmp/folder'] }));
  await f.run();
  assert.deepEqual(f.writes, [["'/tmp/movie clip.mov' '/tmp/O'\\''Brien $(touch nope)' '/tmp/folder' ", false]]);
});
test('safe image paths receive individual Orca-style bracketed paste frames', async () => {
  const f = fixture(async () => ({ kind: 'files', paths: ['/tmp/a.png', '/tmp/b.jpg', '/tmp/$(evil).png'] }));
  await f.run();
  assert.deepEqual(f.writes, [["\x1b[200~/tmp/a.png\x1b[201~ \x1b[200~/tmp/b.jpg\x1b[201~ '/tmp/$(evil).png' ", false]]);
});
test('plain text and disabled smart paste preserve VS Code built-in paste', async () => {
  const f = fixture(async () => ({ kind: 'text' }));
  await f.run(); assert.deepEqual(f.writes, ['fallback']);
  const disabled = fixture(async () => { throw new Error('must not inspect clipboard'); });
  disabled.host.enabled = false;
  await disabled.run(); assert.deepEqual(disabled.writes, ['fallback']);
});
test('focus change or closed target cancels both media and text paste', async () => {
  for (const kind of ['text', 'image']) for (const closed of [false, true]) {
    const f = fixture(async () => {
      if (closed) f.host.terminals = []; else f.host.activeTerminal = {};
      return kind === 'text' ? { kind } : { kind, paths: ['/tmp/image.png'] };
    });
    await f.run(); assert.deepEqual(f.writes, []); assert.equal(f.notices.length, 1);
  }
});
test('remote media and invalid paths are rejected without partial paste', async () => {
  for (const paths of [['/tmp/ok.png', '/tmp/bad\nfile'], ['relative.png'], []]) {
    const f = fixture(async () => ({kind: 'files', paths}));
    await f.run(); assert.deepEqual(f.writes, []); assert.equal(f.notices.length, 1);
  }
  const f = fixture(async () => ({kind: 'image', paths: ['/tmp/ok.png']}));
  f.host.remote = true; await f.run(); assert.deepEqual(f.writes, []); assert.equal(f.notices.length, 1);
});
test('clipboard failures show a generic message without leaking content or pasting fallback', async () => {
  const f = fixture(async () => { throw new Error('secret clipboard content'); });
  await f.run(); assert.deepEqual(f.writes, []); assert.equal(f.notices.length, 1);
  assert.doesNotMatch(f.notices[0], /secret/);
});
test('image paths containing spaces remain a single shell argument', async () => {
  const f = fixture(async () => ({kind: 'files', paths: ['/tmp/a picture.png']}));
  await f.run(); assert.deepEqual(f.writes, [["'/tmp/a picture.png' ", false]]);
});
test('undelivered exported images are discarded, delivered images are retained', async () => {
  for (const reason of ['remote', 'focus', 'write', 'success']) {
    let discarded = 0;
    const f = fixture(async () => {
      if (reason === 'focus') f.host.activeTerminal = {};
      return {kind: 'image', paths: ['/tmp/image.png'], discard: async () => { discarded++; }};
    });
    f.host.remote = reason === 'remote';
    if (reason === 'write') f.host.activeTerminal.sendText = () => { throw new Error('closed'); };
    await f.run(); assert.equal(discarded, reason === 'success' ? 0 : 1);
  }
});
