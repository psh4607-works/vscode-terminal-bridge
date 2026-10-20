export type ClipboardContent = { kind: 'text' } | { kind: 'files' | 'image'; paths: string[]; discard?: () => Promise<void> };
interface PasteTerminal { sendText(text: string, execute?: boolean): void }
export interface PasteHost {
  readonly activeTerminal: PasteTerminal | undefined;
  readonly terminals: readonly PasteTerminal[];
  readonly remote: boolean;
  readonly enabled: boolean;
  readClipboard(): Promise<ClipboardContent>;
  fallback(): Promise<unknown>;
  warn(message: string): unknown;
}
const quote = (path: string) => "'" + path.replace(/'/g, "'\\''") + "'";
const imagePath = /\.(png|jpe?g|gif|webp|bmp|tiff?|heic|avif)$/i;
const unsafeRawPath = /[\s\x00-\x1f\x7f'"`$;&|<>()[\]{}*?!\\]/;
function formatPath(path: string): string {
  return imagePath.test(path) && !unsafeRawPath.test(path)
    ? `\x1b[200~${path}\x1b[201~` : quote(path);
}
export function createSmartPaste(host: PasteHost) {
  return async () => {
    const target = host.activeTerminal;
    if (!target) return;
    if (!host.enabled) return host.fallback();
    let content: ClipboardContent;
    try { content = await host.readClipboard(); }
    catch {
      host.warn('Terminal Bridge: 클립보드를 읽지 못했습니다. 다시 복사한 뒤 붙여넣어 주세요.');
      return;
    }
    let delivered = false;
    try {
      if (host.activeTerminal !== target || !host.terminals.includes(target)) {
        host.warn('Terminal Bridge: 터미널이 변경되어 붙여넣기를 취소했습니다.');
        return;
      }
      if (content.kind === 'text') return host.fallback();
      if (host.remote) {
        host.warn('Terminal Bridge: 원격 터미널로 로컬 파일을 전달하는 기능은 아직 지원하지 않습니다.');
        return;
      }
      if (!content.paths.length || content.paths.some(path => !path.startsWith('/') || /[\x00-\x1f\x7f]/.test(path))) {
        host.warn('Terminal Bridge: 붙여넣을 수 없는 파일 경로입니다.');
        return;
      }
      target.sendText(content.paths.map(formatPath).join(' ') + ' ', false);
      delivered = true;
    } catch {
      host.warn('Terminal Bridge: 터미널에 붙여넣기를 전달하지 못했습니다.');
    } finally {
      if (!delivered && content.kind === 'image') await content.discard?.().catch(() => undefined);
    }
  };
}
