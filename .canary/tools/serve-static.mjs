/**
 * Minimal deterministic static server for canary clone bundles.
 *
 *   node .canary/tools/serve-static.mjs <rootDir> <port>
 *
 * Hardened for a hostile-input boundary: the clone bundle is untrusted output of
 * the generation pipeline, and the server is reachable by any local process.
 *   - GET/HEAD only; every other method is 405.
 *   - no CORS headers at all: the bundle is same-origin, so nothing legitimate
 *     needs cross-origin read access.
 *   - a request carrying an Origin header that is not this server's own origin is
 *     rejected 403 (hostile cross-origin / DNS-rebinding probe).
 *   - containment is checked on the REALPATH of the resolved target, so a sibling
 *     prefix (`<root>-evil`), a symlink escape, and a `..` traversal all fail.
 *   - encoded traversal is decoded once and rejected before resolution; Windows
 *     alternate data streams (`file:stream`), NUL bytes, and backslashes are
 *     rejected outright.
 *   - no directory listing; a directory serves index.html only when present.
 *   - no-store on every response so a canary viewport reload always re-reads disk.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const [, , rootArg, portArg] = process.argv;
if (!rootArg || !portArg) {
  console.error('usage: serve-static.mjs <rootDir> <port>');
  process.exit(2);
}
const root = fs.realpathSync(path.resolve(rootArg));
const port = Number(portArg);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.eot': 'application/vnd.ms-fontobject',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.map': 'application/json; charset=utf-8',
};

const selfOrigins = new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`, `http://[::1]:${port}`]);

function deny(res, status, message) {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store' });
  res.end(message);
}

/** Resolve a request path to a real file inside the root, or null with a reason. */
function resolveTarget(rawUrl) {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(rawUrl, `http://127.0.0.1:${port}`).pathname);
  } catch {
    return { error: 400, reason: 'malformed request target' };
  }
  if (pathname.includes('\0')) return { error: 400, reason: 'NUL byte in path' };
  if (pathname.includes('\\')) return { error: 403, reason: 'backslash in path' };
  // Windows alternate data stream: a colon is never valid in a served path.
  if (pathname.includes(':')) return { error: 403, reason: 'alternate data stream' };
  const segments = pathname.split('/').filter(Boolean);
  if (segments.some((s) => s === '..' || s === '.')) return { error: 403, reason: 'traversal segment' };

  const candidate = path.resolve(root, ...segments);
  let real;
  try {
    real = fs.realpathSync(candidate);
  } catch {
    return { error: 404, reason: `not found: ${pathname}` };
  }
  // Containment on the realpath: defeats sibling prefixes and symlink escapes.
  if (real !== root && !real.startsWith(root + path.sep)) return { error: 403, reason: 'outside root' };

  let stat;
  try {
    stat = fs.statSync(real);
  } catch {
    return { error: 404, reason: `not found: ${pathname}` };
  }
  if (stat.isDirectory()) {
    const index = path.join(real, 'index.html');
    if (!fs.existsSync(index) || !fs.statSync(index).isFile()) return { error: 403, reason: 'directory listing denied' };
    return { file: index };
  }
  if (!stat.isFile()) return { error: 403, reason: 'not a regular file' };
  return { file: real };
}

const server = http.createServer((req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { Allow: 'GET, HEAD', 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('method not allowed');
    return;
  }
  const origin = req.headers.origin;
  if (typeof origin === 'string' && origin && origin !== 'null' && !selfOrigins.has(origin)) {
    deny(res, 403, 'cross-origin request denied');
    return;
  }

  const resolved = resolveTarget(req.url || '/');
  if (resolved.error) {
    deny(res, resolved.error, resolved.reason);
    return;
  }

  let buf;
  try {
    buf = fs.readFileSync(resolved.file);
  } catch (e) {
    deny(res, 500, String(e && e.message));
    return;
  }
  res.writeHead(200, {
    'Content-Type': MIME[path.extname(resolved.file).toLowerCase()] || 'application/octet-stream',
    'Content-Length': buf.length,
    'Cache-Control': 'no-store, no-cache, must-revalidate',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(req.method === 'HEAD' ? undefined : buf);
});

server.listen(port, '127.0.0.1', () => {
  console.log(`[static] ready http://127.0.0.1:${port}/ root=${root}`);
});
