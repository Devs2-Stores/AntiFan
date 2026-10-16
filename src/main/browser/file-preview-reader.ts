import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ReadFilePreviewResult } from '../../shared/contracts';

const MAX_TEXT_READ_BYTES = 512 * 1024;
const MAX_TEXT_FILE_BYTES = 10 * 1024 * 1024;
const MAX_IMAGE_FILE_BYTES = 25 * 1024 * 1024;
const BINARY_SNIFF_BYTES = 4096;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const RASTER_IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'bmp', 'ico']);

function sniffImageMime(bytes: Buffer): string | null {
  const ascii = (start: number, end: number) => bytes.toString('latin1', start, end);
  if (bytes.length >= PNG_SIGNATURE.length && bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (ascii(0, 6) === 'GIF87a' || ascii(0, 6) === 'GIF89a') return 'image/gif';
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'image/webp';
  if (ascii(4, 8) === 'ftyp' && (ascii(8, 12) === 'avif' || ascii(8, 12) === 'avis')) return 'image/avif';
  if (bytes.length >= 14 && ascii(0, 2) === 'BM') return 'image/bmp';
  if (bytes.length >= 6 && bytes.readUInt32BE(0) === 0x00000100) return 'image/x-icon';
  return null;
}

export function normalizePreviewPath(rawPath: string): string {
  let targetPath = rawPath.trim();
  if ((targetPath.startsWith('"') && targetPath.endsWith('"')) ||
      (targetPath.startsWith("'") && targetPath.endsWith("'")) ||
      (targetPath.startsWith('`') && targetPath.endsWith('`'))) {
    targetPath = targetPath.slice(1, -1).trim();
  }
  targetPath = targetPath.replace(/[,\.;\)]+$/, '');
  const lineColMatch = /:(\d+)(?::\d+)?$/.exec(targetPath);
  if (lineColMatch) {
    targetPath = targetPath.slice(0, lineColMatch.index).trim();
  }
  return targetPath;
}

/**
 * `code` CLI arguments for opening a resolved file (at `lineColSuffix`) or folder. They are passed
 * as an array to a process started without a shell, so a spaced path needs no quoting.
 */
export function buildVSCodeLaunchArgs(resolvedTarget: string, isFile: boolean, lineColSuffix: string): string[] {
  return isFile ? ['-r', '-g', `${resolvedTarget}${lineColSuffix}`] : ['-r', resolvedTarget];
}

/**
 * `vscode://file/` URL for a resolved file (at `lineColSuffix`) or folder. On Windows the `code`
 * launcher is a .cmd script that only runs through cmd.exe, which expands `%VAR%` even inside
 * quotes and reads a trailing `\"` as an escaped quote; the URL handler opens the same target with
 * no shell. Each path segment is percent-encoded; a drive letter stays as written.
 */
export function buildVSCodeFileUrl(resolvedTarget: string, isFile: boolean, lineColSuffix: string): string {
  const segments = resolvedTarget.replace(/\\/g, '/').replace(/\/+$/, '').split('/');
  const encoded = segments.map((seg, i) => (i === 0 && /^[A-Za-z]:$/.test(seg) ? seg : encodeURIComponent(seg))).join('/');
  return `vscode://file${encoded.startsWith('/') ? '' : '/'}${encoded}${isFile ? lineColSuffix : ''}`;
}

export function readFilePreview(targetPath: string): ReadFilePreviewResult {
  const fileName = path.basename(targetPath);
  try {
    if (!fs.existsSync(targetPath)) {
      return { ok: false, filePath: targetPath, fileName, reason: 'NOT_FOUND', message: `File không tồn tại: ${targetPath}` };
    }
    const stat = fs.statSync(targetPath);
    if (stat.isDirectory()) {
      return { ok: false, filePath: targetPath, fileName, reason: 'IS_DIRECTORY', message: `Đường dẫn là thư mục, không phải file: ${targetPath}`, size: stat.size };
    }

    if (RASTER_IMAGE_EXTENSIONS.has(path.extname(targetPath).slice(1).toLowerCase())) {
      if (stat.size > MAX_IMAGE_FILE_BYTES) {
        return { ok: false, filePath: targetPath, fileName, reason: 'TOO_LARGE', message: `Ảnh quá lớn (${(stat.size / (1024 * 1024)).toFixed(1)} MB), hãy mở bằng trình xem ảnh`, size: stat.size };
      }
      const bytes = fs.readFileSync(targetPath);
      const mimeType = sniffImageMime(bytes);
      if (mimeType) {
        return {
          ok: true,
          kind: 'image',
          filePath: targetPath,
          fileName,
          mimeType,
          dataUrl: `data:${mimeType};base64,${bytes.toString('base64')}`,
          size: stat.size,
        };
      }
    }

    if (stat.size > MAX_TEXT_FILE_BYTES) {
      return { ok: false, filePath: targetPath, fileName, reason: 'TOO_LARGE', message: `File quá lớn (${(stat.size / (1024 * 1024)).toFixed(1)} MB), hãy mở bằng VS Code`, size: stat.size };
    }
    const fd = fs.openSync(targetPath, 'r');
    try {
      const bytesToRead = Math.min(stat.size, MAX_TEXT_READ_BYTES);
      const buffer = Buffer.alloc(bytesToRead);
      fs.readSync(fd, buffer, 0, bytesToRead, 0);
      if (buffer.subarray(0, BINARY_SNIFF_BYTES).includes(0)) {
        return { ok: false, filePath: targetPath, fileName, reason: 'BINARY_FILE', message: 'File nhị phân, không thể xem dạng text', size: stat.size };
      }
      const content = buffer.toString('utf8');
      return {
        ok: true,
        kind: 'text',
        filePath: targetPath,
        fileName,
        content,
        size: stat.size,
        lineCount: content.split('\n').length,
        isTruncated: stat.size > MAX_TEXT_READ_BYTES,
      };
    } finally {
      fs.closeSync(fd);
    }
  } catch (err) {
    return { ok: false, filePath: targetPath, fileName, reason: 'READ_ERROR', message: err instanceof Error ? err.message : String(err) };
  }
}
