import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const portArgIdx = process.argv.indexOf('--port');
const cliPort = portArgIdx !== -1 ? process.argv[portArgIdx + 1] : (!isNaN(parseInt(process.argv[3])) ? process.argv[3] : null);
const PORT = parseInt(process.env.PORT || cliPort || '3300', 10);
const baseDir = path.resolve(process.env.CLONE_DIR || process.argv[2] || 'clone/hoplongtech');

const mimeTypes = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.webp': 'image/webp',
  '.ttf': 'font/ttf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2'
};

const server = http.createServer((req, res) => {
  // Handle POST /save-dom for zero-elision direct save
  if (req.method === 'POST' && req.url === '/save-dom') {
    let body = '';
    req.on('data', chunk => {
      body += chunk.toString();
    });
    req.on('end', () => {
      // Clean Livewire attributes
      let cleanHtml = '<!DOCTYPE html>\n' + body;
      cleanHtml = cleanHtml.replace(/\swire:snapshot="[^"]*"/gi, '');
      cleanHtml = cleanHtml.replace(/\swire:effects="[^"]*"/gi, '');
      cleanHtml = cleanHtml.replace(/\swire:memo="[^"]*"/gi, '');
      cleanHtml = cleanHtml.replace(/\swire:id="[^"]*"/gi, '');
      cleanHtml = cleanHtml.replace(/\swire:initial-data="[^"]*"/gi, '');
      cleanHtml = cleanHtml.replace(/<!--\[if (?:START)?BLOCK\]><!\[endif\]-->/gi, '');
      cleanHtml = cleanHtml.replace(/<!--\[if ENDBLOCK\]><!\[endif\]-->/gi, '');
      
      // Replace remote CSS links with local CSS
      cleanHtml = cleanHtml.replace(/https:\/\/hoplongtech\.com\/build\/assets\/app-[^"'\s]+\.css/g, 'css/app.css');
      cleanHtml = cleanHtml.replace(/https:\/\/hoplongtech\.com\/build\/assets\/home-[^"'\s]+\.css/g, 'css/home.css');
      
      // Fix relative assets
      cleanHtml = cleanHtml.replace(/src="\/assets\//g, 'src="https://hoplongtech.com/assets/');
      cleanHtml = cleanHtml.replace(/href="\/assets\//g, 'href="https://hoplongtech.com/assets/');

      const outPath = path.join(baseDir, 'index.html');
      fs.writeFileSync(outPath, cleanHtml, 'utf8');
      console.log(`[Clone Server] Saved raw un-elided DOM (${cleanHtml.length} bytes) to ${outPath}`);

      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ success: true, length: cleanHtml.length }));
    });
    return;
  }

  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': '*'
    });
    res.end();
    return;
  }

  const userAgent = req.headers['user-agent'] || '';
  const isMobileUA = /Mobile|Android|iPhone|iPad|iPod|webOS|BlackBerry|IEMobile|Opera Mini/i.test(userAgent);
  const isMobileSecCh = req.headers['sec-ch-ua-mobile'] === '?1';
  const hasDesktopParam = req.url.includes('device=desktop') || req.url.includes('desktop=1');
  const hasMobileParam = req.url.includes('device=mobile') || req.url.includes('mobile=1');
  const isMobilePath = req.url.startsWith('/mobile/') || req.url === '/mobile';
  const isMobile = !hasDesktopParam && (isMobileUA || isMobileSecCh || hasMobileParam || isMobilePath);

  let reqPath = req.url.split('?')[0];
  if (reqPath === '/' || reqPath === '') {
    reqPath = isMobile ? '/mobile/index.html' : '/index.html';
  } else if (reqPath === '/index.html' && isMobile) {
    reqPath = '/mobile/index.html';
  }
  
  let filePath = path.join(baseDir, reqPath);
  
  // Handle directory resolution (e.g. /cart or /product)
  if (fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()) {
    const mIdx = path.join(filePath, 'mobile', 'index.html');
    const dIdx = path.join(filePath, 'index.html');
    if (isMobile && fs.existsSync(mIdx)) {
      filePath = mIdx;
    } else if (fs.existsSync(dIdx)) {
      filePath = dIdx;
    }
  } else if (reqPath.endsWith('/index.html') && isMobile) {
    const dir = path.dirname(filePath);
    const mIdx = path.join(dir, 'mobile', 'index.html');
    if (fs.existsSync(mIdx)) {
      filePath = mIdx;
    }
  }
  if (!fs.existsSync(filePath)) {
    const basename = path.basename(reqPath);
    if (reqPath.endsWith('.css')) {
      const rootCss = path.join(baseDir, 'css', basename);
      if (fs.existsSync(rootCss)) filePath = rootCss;
    } else if (reqPath.startsWith('/assets/')) {
      const rootAsset = path.join(baseDir, 'assets', reqPath.replace('/assets/', ''));
      if (fs.existsSync(rootAsset)) filePath = rootAsset;
    } else if (reqPath.startsWith('/mobile/assets/')) {
      const rootAsset = path.join(baseDir, 'assets', reqPath.replace('/mobile/assets/', ''));
      if (fs.existsSync(rootAsset)) filePath = rootAsset;
    } else if (reqPath.startsWith('/mobile/css/')) {
      const rootCss = path.join(baseDir, 'css', basename);
      if (fs.existsSync(rootCss)) filePath = rootCss;
    } else if (reqPath.startsWith('/css/')) {
      const rootCss = path.join(baseDir, 'css', basename);
      if (fs.existsSync(rootCss)) filePath = rootCss;
    }
  }
  
  if (!fs.existsSync(filePath)) {
    res.writeHead(404, { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*' });
    res.end('404 Not Found');
    return;
  }
  
  const ext = path.extname(filePath).toLowerCase();
  const contentType = mimeTypes[ext] || 'application/octet-stream';
  
  res.writeHead(200, {
    'Content-Type': contentType,
    'Access-Control-Allow-Origin': '*'
  });
  
  fs.createReadStream(filePath).pipe(res);
});
server.on('error', (err) => {
  console.error('[Clone Server] Server error:', err);
});

process.on('uncaughtException', (err) => {
  console.error('[Clone Server] Uncaught exception:', err);
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[Clone Server] Ready on http://127.0.0.1:${PORT}`);
});

// Keep process alive
setInterval(() => {}, 1000 * 60 * 60);
