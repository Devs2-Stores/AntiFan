import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { test } from 'node:test';

const require = createRequire(import.meta.url);
const { ProcessRegistry, NEVER_SWEEP_OWNERS } = require('../../.compiled/src/main/process/process-registry.js');
const { spawnOwned } = require('../../.compiled/src/main/process/spawn-owned.js');

const mk = (extra = {}) => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'procreg-'));
  const killed = [];
  const registry = new ProcessRegistry({
    stateDir,
    autoInstallExitHooks: false,
    logger: () => {},
    isProcessAlive: () => true,
    getProcessStartTime: async (pid) => 1000 + (extra.startOffset?.[pid] ?? 0),
    killProcess: async (pid) => (killed.push(pid), true),
    ...extra.options,
  });
  return { registry, stateDir, killed };
};
const rec = (pid, owner, more = {}) => ({ pid, owner, createdAt: 1000, osStartTime: 1000, ...more });

test('boot sweep kills core-health orphans, skips daemon/PTY owners, other owners and live hosts', async () => {
  const { registry, killed } = mk({ options: { isProcessAlive: (pid) => pid !== 999999 } });
  registry.writeMarkerFile([
    rec(101, 'core-health'),
    rec(102, 'terminal'),
    rec(103, 'daemon-host'),
    rec(104, 'unrelated-owner'),
    rec(105, 'spawn-owned', { hostPid: 4242 }), // host 4242 is alive (fake) and is not us
    rec(106, 'core-health', { hostPid: 999999 }), // host gone: a real orphan
  ]);
  const report = await registry.sweepOrphans({ owners: ['core-health', 'spawn-owned'] });
  assert.deepEqual(killed.sort(), [101, 106]);
  assert.equal(report.killed, 2);
  assert.equal(report.ownerSkipped, 4);
  const left = registry.readMarkerFile().map((r) => r.pid).sort();
  assert.deepEqual(left, [102, 103, 104, 105], 'skipped records stay in the marker file');
  assert.ok(NEVER_SWEEP_OWNERS.includes('terminal') && NEVER_SWEEP_OWNERS.includes('daemon-host'));
});

test('daemon-host and PTY owners are skipped even when the caller passes no owner list', async () => {
  const { registry, killed } = mk();
  registry.writeMarkerFile([rec(201, 'pty'), rec(202, 'terminal-daemon'), rec(203, 'core-health')]);
  await registry.sweepOrphans();
  assert.deepEqual(killed, [203]);
});

test('a reused PID is still skipped (start time mismatch)', async () => {
  const { registry, killed } = mk({ startOffset: { 301: 90_000 } });
  registry.writeMarkerFile([rec(301, 'core-health')]);
  const report = await registry.sweepOrphans({ owners: ['core-health'] });
  assert.deepEqual(killed, []);
  assert.equal(report.pidReusedSkipped, 1);
});

test('a child registered while the sweep awaits keeps its marker, and kept survivors outlive the first registration', async () => {
  let release;
  const gate = new Promise((r) => (release = r));
  const { registry } = mk({ options: { getProcessStartTime: async (pid) => (pid === 401 ? (await gate, 1000) : null) } });
  registry.writeMarkerFile([rec(401, 'core-health'), rec(402, 'terminal'), rec(403, 'unrelated-owner')]);
  const sweep = registry.sweepOrphans({ owners: ['core-health'] });
  registry.register({ pid: 777, owner: 'core-health', name: 'late', command: 'x', osStartTime: 5 });
  release();
  await sweep;
  assert.deepEqual(registry.readMarkerFile().map((r) => r.pid).sort(), [402, 403, 777], 'late child kept, skipped survivors kept, killed orphan dropped');
  registry.register({ pid: 778, owner: 'core-health', name: 'later', command: 'x', osStartTime: 6 });
  assert.deepEqual(registry.readMarkerFile().map((r) => r.pid).sort(), [402, 403, 777, 778], 'survivors are not dropped by the next registration');
});

test('index.ts awaits the boot sweep before anything else registers', () => {
  const src = fs.readFileSync(path.join(path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\//, '')), '..', '..'), 'src', 'main', 'index.ts'), 'utf8');
  assert.match(src, /await ProcessRegistry\.getInstance\(\)\s*\.sweepOrphans/);
});

test('spawnOwned registers with this run token in env and unregisters on close', async () => {
  ProcessRegistry.resetInstance();
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'procreg-own-'));
  const registry = ProcessRegistry.getInstance({ stateDir, autoInstallExitHooks: false, logger: () => {}, getProcessStartTime: async () => null });
  const child = spawnOwned(process.execPath, ['-e', 'process.stdout.write(process.env.ANTIFAN_HOST_RUN_TOKEN || "none")'], { owner: 'spawn-owned', name: 't', stdio: ['ignore', 'pipe', 'ignore'], tagArgv: false });
  let out = '';
  child.stdout.on('data', (d) => (out += d));
  assert.equal(registry.get(child.pid)?.owner, 'spawn-owned');
  const marker = registry.readMarkerFile().find((r) => r.pid === child.pid);
  assert.equal(marker.runToken, registry.runToken);
  assert.equal(marker.hostPid, process.pid);
  await new Promise((r) => child.once('close', r));
  assert.equal(out, registry.runToken);
  assert.equal(registry.get(child.pid), undefined);
  ProcessRegistry.resetInstance();
});

test('index.ts runs the boot sweep restricted to owners', () => {
  const src = fs.readFileSync(path.join(path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\//, '')), '..', '..'), 'src', 'main', 'index.ts'), 'utf8');
  assert.match(src, /sweepOrphans\(\{ owners: \[/);
});
