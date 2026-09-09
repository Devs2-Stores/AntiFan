/**
 * Canary collector: receives large in-page payloads (hydrated DOM, CSSOM, telemetry)
 * from the live AntiFan Chromium tab over localhost and persists them byte-exact.
 * POST /put?name=<file>   body = raw text  -> .canary/dump/<file>
 * GET  /health
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'dump');
fs.mkdirSync(root, { recursive: true });

const PORT = Number(process.env.CANARY_COLLECTOR_PORT || 20333);

const server = http.createServer((req, res) => {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
    'Access-Control-Allow-Headers': '*',
  };
  if (req.method === 'OPTIONS') {
    res.writeHead(204, cors);
    res.end();
    return;
  }
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  if (url.pathname === '/health') {
    res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, root }));
    return;
  }
  if (url.pathname === '/put' && req.method === 'POST') {
    const name = (url.searchParams.get('name') || 'payload.bin').replace(/[^a-zA-Z0-9._-]/g, '_');
    const chunks = [];
    let bytes = 0;
    req.on('data', (c) => { chunks.push(c); bytes += c.length; });
    req.on('end', () => {
      const buf = Buffer.concat(chunks);
      const out = path.join(root, name);
      fs.writeFileSync(out, buf);
      console.log(`[collector] wrote ${name} (${buf.length} bytes) -> ${out}`);
      res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, name, bytes: buf.length, sha256: createHash('sha256').update(buf).digest('hex') }));
    });
    req.on('error', (e) => {
      console.error('[collector] request error', e);
      try { res.writeHead(500, cors); res.end('{}'); } catch {}
    });
    return;
  }
  res.writeHead(404, cors);
  res.end('not found');
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[collector] listening on http://127.0.0.1:${PORT} root=${root}`);
});
