import * as http from 'node:http';
import * as fs from 'node:fs';
import * as path from 'node:path';

const PORT = 48922;
const BASE_DIR = fs.existsSync(path.resolve('clone/hoplongtech')) ? path.resolve('clone/hoplongtech') : path.resolve('clone/hoplongtech-offline');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ttf': 'font/ttf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2'
};

const server = http.createServer((req, res) => {
  let reqPath = (req.url || '/').split('?')[0];
  const isMobile = Boolean(req.headers['user-agent'] && (req.headers['user-agent'].includes('Mobile') || req.headers['user-agent'].includes('iPhone') || req.headers['user-agent'].includes('Android')));
  if (reqPath === '/' || reqPath === '') {
    reqPath = isMobile && fs.existsSync(path.join(BASE_DIR, 'mobile.html')) ? '/mobile.html' : '/index.html';
  }
  const filePath = path.join(BASE_DIR, reqPath);
  if (!filePath.startsWith(BASE_DIR)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) {
      res.writeHead(404);
      res.end('Not Found');
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';
    res.writeHead(200, {
      'Content-Type': contentType,
      'Content-Length': stat.size,
      'Access-Control-Allow-Origin': '*'
    });

    const stream = fs.createReadStream(filePath);
    stream.pipe(res);
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[HoplongCloneServer] Serving clone on http://127.0.0.1:${PORT}`);
});
