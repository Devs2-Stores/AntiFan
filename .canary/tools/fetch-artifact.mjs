/**
 * Fetch raw artifact bytes from the AntiFan bridge artifact HTTP API.
 * Usage: node .canary/tools/fetch-artifact.mjs <artifactId> <outFile>
 */
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';

const [, , artifactId, outFile] = process.argv;
if (!artifactId || !outFile) {
  console.error('usage: fetch-artifact.mjs <artifactId> <outFile>');
  process.exit(2);
}
// lib-rpc resolves the canary session file first (ambient ANTIFAN_MCP_BOOTSTRAP
// points at the user's instance); ANTIFAN_MCP_BOOTSTRAP_FILE targets another.
const { bootstrap: boot } = await import('./lib-rpc.mjs');

function fetchChunk(offset, limit) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port: boot.port,
      path: `/api/artifacts/${encodeURIComponent(artifactId)}?offset=${offset}&limit=${limit}`,
      method: 'GET',
      headers: { 'x-antifan-attachment-secret': boot.secret },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error(`status ${res.statusCode}: ${Buffer.concat(chunks).toString('utf8').slice(0, 300)}`));
        resolve({
          buffer: Buffer.concat(chunks),
          hasMore: res.headers['x-artifact-has-more'] === 'true',
          totalBytes: parseInt(res.headers['x-artifact-total-bytes'] || '0', 10) || 0,
          mime: res.headers['content-type'] || 'application/octet-stream',
        });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

const parts = [];
let offset = 0;
for (;;) {
  const c = await fetchChunk(offset, 1024 * 1024);
  parts.push(c.buffer);
  offset += c.buffer.length;
  if (!c.hasMore || c.buffer.length === 0) break;
  if (offset > 200 * 1024 * 1024) break;
}
const buf = Buffer.concat(parts);
fs.mkdirSync(path.dirname(path.resolve(outFile)), { recursive: true });
fs.writeFileSync(outFile, buf);
const { createHash } = await import('node:crypto');
console.log(JSON.stringify({ ok: true, out: outFile, bytes: buf.length, sha256: createHash('sha256').update(buf).digest('hex') }));
