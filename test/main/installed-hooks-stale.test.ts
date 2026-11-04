import * as assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { OMP_HOOK_IDS, installedHooksStale } from '../../src/main/leader/leader-runtime';

// The installer is the source of the manifest the runtime judges, so these cases run the real one
// into a scratch agent dir instead of hand-writing a manifest that could drift from it.
const REPO = process.cwd();
const HOOK_IDS = ['edit-guard', 'leader-guard', 'playwright-gate', 'run-state', 'theme-qa-gate'];

describe('installedHooksStale', () => {
  let agentDir: string;
  let previous: string | undefined;

  const manifestPath = (): string => path.join(agentDir, 'hooks', '.antifan-hooks.json');
  const readManifest = (): { hooks: Array<{ id: string; path: string; sourceSha256: string; inputs: string[] }> } => JSON.parse(fs.readFileSync(manifestPath(), 'utf8'));

  beforeEach(() => {
    agentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hooks-stale-'));
    previous = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    const run = spawnSync(process.execPath, [path.join(REPO, 'scripts', 'install-omp-hooks.mjs'), '--install'], {
      cwd: REPO,
      env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, ELECTRON_RUN_AS_NODE: '' },
      encoding: 'utf8',
    });
    assert.equal(run.status, 0, run.stdout + run.stderr);
  });

  afterEach(() => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    fs.rmSync(agentDir, { recursive: true, force: true });
  });

  it('records every hook with its bundled sources, and reports none stale right after an install', () => {
    const manifest = readManifest();
    assert.deepEqual(manifest.hooks.map((hook) => hook.id).sort(), [...HOOK_IDS].sort());
    assert.deepEqual([...OMP_HOOK_IDS].sort(), [...HOOK_IDS].sort(), 'the runtime list matches what the real installer writes');
    for (const hook of manifest.hooks) {
      assert.ok(hook.inputs.length > 0 && /^[0-9a-f]{64}$/.test(hook.sourceSha256), hook.id);
    }
    assert.deepEqual(installedHooksStale(), []);
  });

  it('lists a hook the installer knows but the manifest has no row for (installed before it existed, or a single-hook install)', () => {
    const manifest = readManifest();
    const kept = manifest.hooks.filter((hook) => hook.id !== 'playwright-gate');
    fs.writeFileSync(manifestPath(), JSON.stringify({ ...manifest, hooks: kept }), 'utf8');
    assert.deepEqual(
      installedHooksStale().map((hook) => [hook.id, hook.state]),
      [['playwright-gate', 'NOT_INSTALLED']],
    );
  });

  it('names the hook whose installed file was edited or removed, and only that one', () => {
    const manifest = readManifest();
    const edited = manifest.hooks.find((hook) => hook.id === 'edit-guard');
    const removed = manifest.hooks.find((hook) => hook.id === 'theme-qa-gate');
    assert.ok(edited && removed);
    fs.appendFileSync(edited.path, '\n// hand edit\n');
    fs.rmSync(removed.path);
    const stale = installedHooksStale();
    assert.deepEqual(
      stale.map((hook) => [hook.id, hook.state]).sort(),
      [['edit-guard', 'INSTALLED_CHANGED'], ['theme-qa-gate', 'MISSING']],
    );
  });

  it('names the hook whose source differs from the one it was installed from', () => {
    const manifest = readManifest();
    const target = manifest.hooks.find((hook) => hook.id === 'leader-guard');
    assert.ok(target);
    assert.deepEqual(installedHooksStale(), []);
    // The recorded source identity stands in for a source file edited after the install: the repo
    // sources cannot be edited from a test, but a hash that no longer matches them reads the same.
    target.sourceSha256 = '0'.repeat(64);
    fs.writeFileSync(manifestPath(), JSON.stringify(manifest), 'utf8');
    assert.deepEqual(
      installedHooksStale().map((hook) => [hook.id, hook.state]),
      [['leader-guard', 'SOURCE_CHANGED']],
    );
  });

  it('says the sources are unreadable, not changed, when the checkout that installed the hook is gone', () => {
    const manifest = readManifest() as { repoRoot?: string; hooks: unknown[] };
    manifest.repoRoot = path.join(os.tmpdir(), 'no-such-checkout-' + Date.now());
    fs.writeFileSync(manifestPath(), JSON.stringify(manifest), 'utf8');
    const stale = installedHooksStale();
    assert.deepEqual([...new Set(stale.map((hook) => hook.state))], ['SOURCES_UNREADABLE']);
    assert.equal(stale.length, OMP_HOOK_IDS.length);
    assert.match(stale[0]?.detail ?? '', /not readable under/);
  });

  it('proves no source drift for a manifest written before source hashes existed', () => {
    const manifest = readManifest();
    for (const hook of manifest.hooks as Array<Record<string, unknown>>) {
      delete hook.inputs;
      delete hook.sourceSha256;
    }
    fs.writeFileSync(manifestPath(), JSON.stringify(manifest), 'utf8');
    assert.deepEqual(installedHooksStale(), []);
  });

  it('reports nothing when no installer manifest exists', () => {
    fs.rmSync(manifestPath());
    assert.deepEqual(installedHooksStale(), []);
  });
});
