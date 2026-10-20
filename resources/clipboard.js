ObjC.import('AppKit');
ObjC.import('Foundation');

function run(argv) {
  var board = $.NSPasteboard.generalPasteboard;
  var generation = board.changeCount;
  function stable() {
    if (board.changeCount !== generation) throw new Error('Clipboard changed during paste.');
  }
  var items = board.pasteboardItems;
  var paths = [];
  for (var index = 0; index < items.count; index++) {
    var item = items.objectAtIndex(index);
    var raw = item.stringForType($.NSPasteboardTypeFileURL);
    if (raw && !raw.isNil()) {
      var url = $.NSURL.URLWithString(raw);
      if (!url || url.isNil() || !url.isFileURL) throw new Error('Unsupported clipboard URL.');
      var host = ObjC.unwrap(url.host) || '';
      var local = ObjC.unwrap(url.path);
      if ((host && host !== 'localhost') || !local || local[0] !== '/' || /[\x00-\x1f\x7f]/.test(local)) throw new Error('Invalid clipboard file path.');
      paths.push(local);
    }
  }
  stable();
  if (paths.length) {
    if (paths.length > 1000) throw new Error('Too many clipboard files.');
    return JSON.stringify({ kind: 'files', paths: paths });
  }
  var text = board.stringForType($.NSPasteboardTypeString);
  stable();
  if (text && !text.isNil() && text.length > 0) return JSON.stringify({ kind: 'text' });
  var image = $.NSImage.alloc.initWithPasteboard(board);
  if (!image || image.isNil()) return JSON.stringify({ kind: 'text' });
  var tiff = image.TIFFRepresentation;
  if (!tiff || tiff.isNil() || tiff.length > 64 * 1024 * 1024) throw new Error('Clipboard image is too large.');
  var bitmap = $.NSBitmapImageRep.imageRepWithData(tiff);
  if (!bitmap || bitmap.isNil() || bitmap.pixelsWide * bitmap.pixelsHigh > 32 * 1024 * 1024) throw new Error('Clipboard image is too large.');
  var png = bitmap.representationUsingTypeProperties($.NSBitmapImageFileTypePNG, $.NSDictionary.dictionary);
  if (!png || png.isNil() || png.length > 18 * 1024 * 1024) throw new Error('Clipboard image is too large.');
  stable();
  var fm = $.NSFileManager.defaultManager;
  var base = argv[0] || ObjC.unwrap($.NSTemporaryDirectory());
  var folder = base.replace(/\/$/, '') + '/vscode-terminal-paste-' + ObjC.unwrap($.NSUUID.UUID.UUIDString);
  if (!fm.createDirectoryAtPathWithIntermediateDirectoriesAttributesError($(folder), false, $({ NSFilePosixPermissions: 448 }), null)) throw new Error('Cannot save clipboard image.');
  var destination = folder + '/image.png';
  if (!png.writeToFileAtomically($(destination), true)) throw new Error('Cannot save clipboard image.');
  if (!fm.setAttributesOfItemAtPathError($({ NSFilePosixPermissions: 384 }), $(destination), null)) throw new Error('Cannot secure clipboard image.');
  stable();
  return JSON.stringify({ kind: 'image', paths: [destination] });
}
