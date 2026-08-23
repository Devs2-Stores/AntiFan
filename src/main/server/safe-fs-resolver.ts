import * as fs from 'node:fs';
import * as path from 'node:path';
import { Readable } from 'node:stream';

export interface SafeResolveResult {
  ok: true;
  stream: Readable;
  mimeType: string;
  size: number;
  canonicalPath: string;
}

export interface SafeResolveError {
  ok: false;
  status: 400 | 403 | 404 | 500;
  message: string;
}

export const MIME_MAP: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.wasm': 'application/wasm',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.xml': 'application/xml',
  '.map': 'application/json',
};

const BLOCKED_FILE_PATTERNS = [
  /^\.env(\..+)?$/i,
  /^\.git(\/|\\|$)/i,
  /^\.antifan(\/|\\|$)/i,
  /\.(key|pem|pfx|p12|pkcs12|secret|sqlite|db)$/i,
  /^(id_rsa|id_ed25519|id_dsa).*$/i,
  /^\.npmrc$/i,
  /^\.dockercfg$/i,
];

/**
 * Perform a segment-by-segment lstat walk starting from canonicalRoot.
 * Rejects if any segment is a symbolic link, directory junction, or reparse point.
 */
async function verifyNoSymlinkSegments(canonicalRoot: string, relativePath: string): Promise<string | null> {
  const segments = relativePath.split(/[/\\]+/).filter((s) => s.length > 0 && s !== '.');
  let currentPath = canonicalRoot;

  for (const seg of segments) {
    if (seg === '..' || seg.includes('\0')) return null;
    currentPath = path.join(currentPath, seg);

    let lstat: fs.Stats;
    try {
      lstat = await fs.promises.lstat(currentPath);
    } catch {
      return null;
    }

    // Zero-symlink policy: reject any symbolic link or junction
    if (lstat.isSymbolicLink()) {
      return null;
    }
  }
  return currentPath;
}

/**
 * Safely resolve and open a file inside a canonical workspace root.
 * Dual-layer containment check + in-root secrets deny-list + stream handle.
 */
export async function safeResolveAndOpenFile(
  canonicalRoot: string,
  decodedPath: string,
  customMimeMap: Record<string, string> = MIME_MAP
): Promise<SafeResolveResult | SafeResolveError> {
  try {
    // 1. Layer 1: Segment Walk rejecting symlinks/junctions
    let targetPath = await verifyNoSymlinkSegments(canonicalRoot, decodedPath);
    if (!targetPath) {
      return { ok: false, status: 404, message: 'File Not Found or Symlink Access Denied' };
    }

    // 2. Handle implicit directory index (e.g. / or /docs/ -> index.html)
    let initialStat: fs.Stats;
    try {
      initialStat = await fs.promises.stat(targetPath);
    } catch {
      return { ok: false, status: 404, message: 'File Not Found' };
    }

    if (initialStat.isDirectory()) {
      const indexPath = await verifyNoSymlinkSegments(targetPath, 'index.html');
      if (!indexPath) {
        return { ok: false, status: 403, message: 'Directory listing is disabled.' };
      }
      targetPath = indexPath;
    }

    // 3. Layer 2: Canonical Realpath Chroot Containment Verification
    let canonicalFinal: string;
    try {
      canonicalFinal = fs.realpathSync.native(targetPath);
    } catch {
      return { ok: false, status: 404, message: 'File Not Found' };
    }

    const relFromRoot = path.relative(canonicalRoot, canonicalFinal);
    const isInside = !relFromRoot.startsWith('..') && !path.isAbsolute(relFromRoot);
    const hasBoundary = canonicalFinal.startsWith(
      canonicalRoot.endsWith(path.sep) ? canonicalRoot : canonicalRoot + path.sep
    );

    if (!isInside || !hasBoundary) {
      return { ok: false, status: 403, message: '403 Forbidden: Target path escapes workspace root.' };
    }

    // 4. In-Root Secrets Deny-List & Windows ADS Check
    const basename = path.basename(canonicalFinal);
    if (basename.includes(':') || /~[0-9]/.test(basename)) {
      return { ok: false, status: 404, message: 'File Not Found' };
    }

    const normalizedRel = relFromRoot.replace(/\\/g, '/');
    for (const pattern of BLOCKED_FILE_PATTERNS) {
      if (pattern.test(basename) || pattern.test(normalizedRel)) {
        return { ok: false, status: 404, message: 'File Not Found (Protected Resource)' };
      }
    }

    // 5. Open FileHandle directly
    let handle: fs.promises.FileHandle;
    try {
      handle = await fs.promises.open(canonicalFinal, fs.constants.O_RDONLY);
    } catch {
      return { ok: false, status: 404, message: 'Unable to open file.' };
    }

    const handleStat = await handle.stat();
    if (!handleStat.isFile()) {
      await handle.close();
      return { ok: false, status: 403, message: 'Target is not a regular file.' };
    }

    const ext = path.extname(canonicalFinal).toLowerCase();
    const mimeType = customMimeMap[ext] || 'application/octet-stream';
    const stream = handle.createReadStream({ autoClose: true });

    return {
      ok: true,
      stream,
      mimeType,
      size: handleStat.size,
      canonicalPath: canonicalFinal,
    };
  } catch {
    return { ok: false, status: 500, message: 'Internal Server Error' };
  }
}
