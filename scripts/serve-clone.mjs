import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const PORT = 20199;
const baseDir = path.resolve('clone/hoplongtech');

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
  '.webp': 'image/webp'
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

  let reqPath = req.url.split('?')[0];
  if (reqPath === '/' || reqPath === '') reqPath = '/index.html';
  
  const filePath = path.join(baseDir, reqPath);
  
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

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[Clone Server] Ready on http://127.0.0.1:${PORT}`);
});
