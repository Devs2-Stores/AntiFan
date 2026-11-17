import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { pathTemplate } from '../../scripts/har-scan.mjs';

const SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'scripts', 'har-scan.mjs');
const SECRET = ['abc123', 'SECRET'].join('');

test('har-scan never prints credentials and flags unobserved bundle origins', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'har-'));
  const har = {
    log: {
      version: '1.2',
      entries: [
        { request: { method: 'GET', url: `https://api.example.test/v2/items/123?token=${SECRET}`, headers: [{ name: 'Authorization', value: `Bearer ${SECRET}` }, { name: 'Cookie', value: `sid=${SECRET}` }] }, response: { status: 200, headers: [], content: { mimeType: 'application/json', size: 42 } } },
        { request: { method: 'POST', url: 'https://api.example.test/v2/items/456', headers: [], postData: { text: JSON.stringify({ name: 'x', price: 1 }) } }, response: { status: 201, headers: [], content: { mimeType: 'application/json', size: 7 } } },
      ],
    },
  };
  fs.writeFileSync(path.join(dir, 'sample.har'), JSON.stringify(har));
  fs.writeFileSync(path.join(dir, 'bundle.js'), 'fetch("https://api.example.test/v2/items");\nconst cdn="https://cdn.example.test/x";\nconst p="/api/orders";\n');
  const r = spawnSync(process.execPath, [SCRIPT, '--har', path.join(dir, 'sample.har'), '--bundle', dir], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!r.stdout.includes(SECRET), 'no raw secret in output');
  assert.match(r.stdout, /origin https:\/\/api\.example\.test requests=2/);
  assert.match(r.stdout, /GET \/v2\/items\/:id x1/);
  assert.match(r.stdout, /body=name,price/);
  assert.match(r.stdout, /unobserved https:\/\/cdn\.example\.test/);
  assert.match(r.stdout, /coverage: observed 1 of 2 bundle-declared origins/);
  assert.match(r.stdout, /sha256:[0-9a-f]{8}/);
});

test('pathTemplate folds ids', () => {
  assert.equal(pathTemplate('/a/12/b/0123456789abcdef01234567/c/123e4567-e89b-12d3-a456-426614174000'), '/a/:id/b/:id/c/:id');
});
