const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readMacClipboardWithRunner, attachClipboardDiscard } = require('../dist/macos-clipboard');

test('native clipboard results preserve all original file paths', async () => {
  const calls = [];
  const result = await readMacClipboardWithRunner(async (...args) => {
    calls.push(args);
    return JSON.stringify({ kind: 'files', paths: ['/tmp/a image.png', '/tmp/a folder'] });
  });
  assert.deepEqual(result, { kind: 'files', paths: ['/tmp/a image.png', '/tmp/a folder'] });
  assert.equal(calls[0][0], '/usr/bin/osascript');
  assert.equal(calls[0][2].shell, false);
});

test('discard removes only owned generated image folders, never copied files', async () => {
  const fs = require('node:fs/promises');
  const path = require('node:path');
  const os = require('node:os');
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-discard-test-'));
  try {
    const folder = path.join(base, 'vscode-terminal-paste-12345678-1234-4234-8234-123456789ABC');
    await fs.mkdir(folder);
    const file = path.join(folder, 'image.png');
    await fs.writeFile(file, 'fixture');
    const copied = attachClipboardDiscard({ kind: 'files', paths: [file] });
    assert.equal(copied.discard, undefined);
    const image = attachClipboardDiscard({ kind: 'image', paths: [file] });
    assert.equal(typeof image.discard, 'function');
    await image.discard();
    await assert.rejects(fs.stat(folder), { code: 'ENOENT' });
    assert.equal(attachClipboardDiscard({ kind: 'image', paths: [path.join(base, 'image.png')] }).discard, undefined);
  } finally { await fs.rm(base, { recursive: true, force: true }); }
});

test('invalid and partial native path lists are rejected without leaking content', async () => {
  for (const paths of [['/tmp/ok', 'relative'], ['/tmp/bad\npath'], [], ['/tmp/ok', 1]]) {
    await assert.rejects(readMacClipboardWithRunner(async () => JSON.stringify({ kind: 'files', paths })), /Invalid clipboard paths/);
  }
});

test('text and image results are discriminated and process errors propagate', async () => {
  assert.deepEqual(await readMacClipboardWithRunner(async () => '{"kind":"text"}'), { kind: 'text' });
  assert.deepEqual(await readMacClipboardWithRunner(async () => '{"kind":"image","paths":["/tmp/paste/image.png"]}'), { kind: 'image', paths: ['/tmp/paste/image.png'] });
  await assert.rejects(readMacClipboardWithRunner(async () => 'private invalid output'), /Invalid clipboard response/);
});

test('native JXA reads a named pasteboard file list without touching general clipboard', { skip: process.platform !== 'darwin' }, () => {
  const fs = require('node:fs');
  const { execFileSync } = require('node:child_process');
  const source = fs.readFileSync(require('node:path').join(__dirname, '../resources/clipboard.js'), 'utf8');
  const fixture = source.replace('var board = $.NSPasteboard.generalPasteboard;', `var board = $.NSPasteboard.pasteboardWithUniqueName;
    board.clearContents;
    var first = $.NSURL.fileURLWithPath('/tmp/a image.png');
    var second = $.NSURL.fileURLWithPath('/tmp/a folder');
    var objects = $.NSMutableArray.alloc.init;
    objects.addObject(first);
    objects.addObject(second);
    board.writeObjects(objects);`);
  const output = execFileSync('/usr/bin/osascript', ['-l', 'JavaScript', '-'], { input: fixture, timeout: 10000, encoding: 'utf8' });
  assert.deepEqual(JSON.parse(output), { kind: 'files', paths: ['/tmp/a image.png', '/tmp/a folder'] });
});

test('native bitmap paste creates private persistent PNG in a named pasteboard fixture', { skip: process.platform !== 'darwin' }, () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const { execFileSync } = require('node:child_process');
  const source = fs.readFileSync(path.join(__dirname, '../resources/clipboard.js'), 'utf8');
  const fixture = source.replace('var board = $.NSPasteboard.generalPasteboard;', `var board = $.NSPasteboard.pasteboardWithUniqueName;
    board.clearContents;
    var bitmap = $.NSBitmapImageRep.alloc.initWithBitmapDataPlanesPixelsWidePixelsHighBitsPerSampleSamplesPerPixelHasAlphaIsPlanarColorSpaceNameBytesPerRowBitsPerPixel(null, 2, 2, 8, 4, true, false, $.NSDeviceRGBColorSpace, 0, 0);
    var bytes = bitmap.representationUsingTypeProperties($.NSBitmapImageFileTypePNG, $.NSDictionary.dictionary);
    board.setDataForType(bytes, $.NSPasteboardTypePNG);`);
  const result = JSON.parse(execFileSync('/usr/bin/osascript', ['-l', 'JavaScript', '-'], { input: fixture, timeout: 10000, encoding: 'utf8' }));
  try {
    assert.equal(result.kind, 'image');
    assert.equal(fs.statSync(path.dirname(result.paths[0])).mode & 0o777, 0o700);
    assert.equal(fs.statSync(result.paths[0]).mode & 0o777, 0o600);
    assert.equal(fs.readFileSync(result.paths[0]).subarray(1, 4).toString(), 'PNG');
  } finally {
    if (result.paths?.[0]) fs.rmSync(path.dirname(result.paths[0]), { recursive: true });
  }
});

test('native nonlocal copied file URL is rejected atomically', { skip: process.platform !== 'darwin' }, () => {
  const fs = require('node:fs');
  const { execFileSync } = require('node:child_process');
  const source = fs.readFileSync(require('node:path').join(__dirname, '../resources/clipboard.js'), 'utf8');
  const fixture = source.replace('var board = $.NSPasteboard.generalPasteboard;', `var board = $.NSPasteboard.pasteboardWithUniqueName;
    board.clearContents;
    board.setStringForType('file://external.example/tmp/private.png', $.NSPasteboardTypeFileURL);`);
  assert.throws(() => execFileSync('/usr/bin/osascript', ['-l', 'JavaScript', '-'], { input: fixture, timeout: 10000, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }), error => {
    assert.match(error.stderr, /Invalid clipboard file path/);
    assert.doesNotMatch(error.stderr, /external.example/);
    return true;
  });
});
