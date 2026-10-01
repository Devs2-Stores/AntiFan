import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { openSpace, createConfirmationStore, type SpaceOpenDeps, type SpaceSessionView } from '../../src/main/project/space-open';
import { parseSpaceManifest, antifanDirUnignoredInGit, type SpaceTabSpec } from '../../src/main/project/space-manifest';

function folderWith(manifest: unknown, files: Record<string, string> = {}): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-space-open-'));
  fs.mkdirSync(path.join(dir, '.antifan'));
  fs.writeFileSync(path.join(dir, '.antifan', 'space.json'), typeof manifest === 'string' ? manifest : JSON.stringify(manifest));
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), body);
  }
  return fs.realpathSync.native(dir);
}

function harness(confirmed = false) {
  const sessions: SpaceSessionView[] = [];
  const typed: Array<{ id: string; text: string }> = [];
  const tabs: string[] = [];
  const confirmedHashes = new Set<string>();
  let windowOpens = 0;
  let duplicate: { id: string; label: string } | undefined;
  let next = 0;
  const tabKey = (spec: SpaceTabSpec): string => (spec.kind === 'url' ? spec.url : `path:${spec.path}`);
  const deps: SpaceOpenDeps = {
    folderKey: (f) => f.toLowerCase(),
    admit: () => {},
    isConfirmed: (_k, h) => confirmed || confirmedHashes.has(h),
    recordConfirmed: (_k, h) => void confirmedHashes.add(h),
    openWindow: async () => {
      windowOpens += 1;
      return {
        ok: true,
        window: {
          capsuleId: 'cap1',
          hasTab: (spec) => tabs.includes(tabKey(spec)),
          openTab: (spec) => {
            tabs.push(tabKey(spec));
            return true;
          },
        },
      };
    },
    sessions: () => sessions,
    mint: async (folder, _cap, spec) => {
      // A real mint yields to the event loop: this is what lets two concurrent opens interleave.
      await new Promise((r) => setImmediate(r));
      const id = `t${++next}`;
      sessions.push({ id, cwd: folder, state: 'running', spaceTerminalId: spec.id });
      return id;
    },
    findSyncDuplicate: () => duplicate,
    typeCommand: (id, text) => void typed.push({ id, text }),
    wake: async (id) => {
      const s = sessions.find((x) => x.id === id);
      if (!s) return false;
      s.state = 'running';
      return true;
    },
  };
  return { deps, sessions, typed, tabs, windowOpens: () => windowOpens, setDuplicate: (d: typeof duplicate) => void (duplicate = d) };
}

const MANIFEST = {
  version: 1,
  terminals: [
    { id: 'agent', label: 'omp', command: 'omp', role: 'agent' },
    { id: 'sh', label: 'shell', role: 'shell' },
  ],
  tabs: [{ url: 'https://example.com/a' }, { path: 'ref/index.html' }],
};

describe('openSpace', () => {
  it('reports field-level errors and touches nothing for an invalid manifest', async () => {
    const h = harness();
    const folder = folderWith({ version: 1, terminals: [{ id: 'bad id', label: 'x' }] });
    const result = await openSpace(h.deps, folder, undefined);
    assert.equal(result.ok, false);
    assert.equal((result as { reason: string }).reason, 'MANIFEST_INVALID');
    assert.ok(((result as { errors?: unknown[] }).errors ?? []).length > 0);
    assert.equal(h.windowOpens(), 0);
    assert.equal(h.sessions.length, 0);
  });

  it('refuses to run commands until the exact content is confirmed', async () => {
    const h = harness();
    const folder = folderWith(MANIFEST, { 'ref/index.html': '<p>x</p>' });
    const first = await openSpace(h.deps, folder, undefined);
    assert.equal((first as { reason: string }).reason, 'NEEDS_CONFIRM');
    assert.deepEqual((first as { commands: unknown }).commands, [{ label: 'omp', command: 'omp' }]);
    assert.equal(h.sessions.length, 0);
    const hash = (first as { hash: string }).hash;
    const wrong = await openSpace(h.deps, folder, 'deadbeef');
    assert.equal((wrong as { reason: string }).reason, 'CONFIRM_MISMATCH');
    assert.equal(h.sessions.length, 0);
    const ok = await openSpace(h.deps, folder, hash);
    assert.equal(ok.ok, true);
    // Confirmed once: a later plain open of the same content needs no second prompt.
    const again = await openSpace(h.deps, folder, undefined);
    assert.equal(again.ok, true);
  });

  it('opens every terminal and tab once, then reuses them', async () => {
    const h = harness(true);
    const folder = folderWith(MANIFEST, { 'ref/index.html': '<p>x</p>' });
    const first = await openSpace(h.deps, folder, undefined);
    assert.deepEqual(first, { ok: true, terminalsOpened: 2, terminalsReused: 0, tabsOpened: 2, tabsReused: 0 });
    assert.deepEqual(h.typed, [{ id: 't1', text: 'omp\r' }]);
    const second = await openSpace(h.deps, folder, undefined);
    assert.deepEqual(second, { ok: true, terminalsOpened: 0, terminalsReused: 2, tabsOpened: 0, tabsReused: 2 });
    assert.equal(h.typed.length, 1);
  });

  it('mints a replacement for a declared terminal whose shell exited', async () => {
    const h = harness(true);
    const folder = folderWith({ version: 1, terminals: [{ id: 'sh', label: 'shell', role: 'shell' }] });
    await openSpace(h.deps, folder, undefined);
    h.sessions[0]!.state = 'exited';
    const result = await openSpace(h.deps, folder, undefined);
    assert.equal((result as { terminalsOpened: number }).terminalsOpened, 1);
  });

  it('does not mint a sync watcher when another live one pushes to the same remote', async () => {
    const h = harness(true);
    h.setDuplicate({ id: 'other', label: 'theme watch' });
    const folder = folderWith({ version: 1, terminals: [{ id: 'up', label: 'upload', role: 'sync', idlePolicy: 'never' }, { id: 'sh', label: 'shell', role: 'shell' }] });
    const result = await openSpace(h.deps, folder, undefined);
    assert.deepEqual(result, {
      ok: true,
      terminalsOpened: 1,
      terminalsReused: 0,
      tabsOpened: 0,
      tabsReused: 0,
      syncDuplicates: [{ spaceTerminalId: 'up', duplicate: { id: 'other', label: 'theme watch' } }],
    });
    assert.deepEqual(h.sessions.map((s) => s.spaceTerminalId), ['sh']);
  });

  it('two folders bound to one remote mint one sync watcher between them, even when opened concurrently', async () => {
    const h = harness(true);
    // Duplicate lookup reads the live sessions, as the host does: a watcher exists once one is minted.
    const deps: SpaceOpenDeps = {
      ...h.deps,
      findSyncDuplicate: () => {
        const live = h.sessions.find((s) => s.spaceTerminalId === 'up' && s.state === 'running');
        return live ? { id: live.id, label: 'theme watch' } : undefined;
      },
    };
    const manifest = { version: 1, terminals: [{ id: 'up', label: 'upload', role: 'sync', idlePolicy: 'never' }] };
    const a = folderWith(manifest);
    const b = folderWith(manifest);
    const [ra, rb] = await Promise.all([openSpace(deps, a, undefined), openSpace(deps, b, undefined)]);
    assert.equal(h.sessions.length, 1, 'exactly one uploader exists');
    const opened = [ra, rb].map((r) => (r.ok ? r.terminalsOpened : -1)).sort();
    assert.deepEqual(opened, [0, 1]);
    const skipped = [ra, rb].find((r) => r.ok && r.terminalsOpened === 0);
    assert.ok(skipped && skipped.ok && skipped.syncDuplicates?.length === 1, 'the loser is told why');
  });

  it('two concurrent opens produce one set of sessions', async () => {
    const h = harness(true);
    const folder = folderWith(MANIFEST, { 'ref/index.html': '<p>x</p>' });
    await Promise.all([openSpace(h.deps, folder, undefined), openSpace(h.deps, folder, undefined)]);
    assert.equal(h.sessions.length, 2);
    assert.equal(h.tabs.length, 2);
  });

  it('opens a path tab whose file does not exist yet, since containment is by its folder', async () => {
    const h = harness(true);
    const folder = folderWith({ version: 1, tabs: [{ path: 'missing.html' }] });
    const result = await openSpace(h.deps, folder, undefined);
    assert.deepEqual(result, { ok: true, terminalsOpened: 0, terminalsReused: 0, tabsOpened: 1, tabsReused: 0 });
  });

  it('wakes a sleeping declared terminal and delivers its command instead of counting it reused', async () => {
    const h = harness(true);
    h.sessions.push({ id: 'zz', cwd: 'E:/Work/x', state: 'sleeping', spaceTerminalId: 'agent' });
    const folder = folderWith({ version: 1, terminals: [{ id: 'agent', label: 'omp', command: 'omp', role: 'agent' }] });
    h.deps.folderKey = () => 'e:/work/x';
    const result = await openSpace(h.deps, folder, undefined);
    assert.equal(result.ok, true);
    assert.equal(h.sessions.find((s) => s.id === 'zz')?.state, 'running');
    assert.deepEqual(h.typed, [{ id: 'zz', text: 'omp\r' }]);
  });
});

describe('space manifest hardening', () => {
  it('refuses Win32 device names and alternate data streams as tab paths', () => {
    for (const bad of ['NUL', 'ref/con.html', 'COM1', 'file.txt:stream']) {
      const parsed = parseSpaceManifest(Buffer.from(JSON.stringify({ version: 1, tabs: [{ path: bad }] })));
      assert.equal(parsed.ok, false, bad);
    }
    assert.equal(parseSpaceManifest(Buffer.from(JSON.stringify({ version: 1, tabs: [{ path: 'ref/index.html' }] }))).ok, true);
  });

  it('warns only for a git working tree whose .gitignore does not cover .antifan/', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-gitign-'));
    assert.equal(antifanDirUnignoredInGit(dir), false, 'not a git repo');
    fs.mkdirSync(path.join(dir, '.git'));
    assert.equal(antifanDirUnignoredInGit(dir), true, 'repo without .gitignore');
    fs.writeFileSync(path.join(dir, '.gitignore'), 'node_modules\n');
    assert.equal(antifanDirUnignoredInGit(dir), true);
    for (const rule of ['.antifan', '/.antifan/', '.antifan/*', '**/.antifan/']) {
      fs.writeFileSync(path.join(dir, '.gitignore'), `node_modules\n${rule}\n`);
      assert.equal(antifanDirUnignoredInGit(dir), false, rule);
    }
  });

  it('treats a .git file (linked worktree) as a repo and a later negation as un-ignored', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-gitign-wt-'));
    fs.writeFileSync(path.join(dir, '.git'), 'gitdir: ../main/.git/worktrees/w\n');
    assert.equal(antifanDirUnignoredInGit(dir), true, 'worktree without .gitignore');
    fs.writeFileSync(path.join(dir, '.gitignore'), '.antifan/\n!.antifan/\n');
    assert.equal(antifanDirUnignoredInGit(dir), true, 'negation re-includes it');
    fs.writeFileSync(path.join(dir, '.gitignore'), '!.antifan/\n.antifan/\n');
    assert.equal(antifanDirUnignoredInGit(dir), false, 'the last rule wins');
  });
});

describe('space manifest path containment', () => {
  it('refuses parent escapes, absolute and UNC paths', () => {
    for (const bad of ['../x.html', '/etc/x', 'C:\\x.html', '\\\\host\\share\\x.html']) {
      const parsed = parseSpaceManifest(Buffer.from(JSON.stringify({ version: 1, tabs: [{ path: bad }] })));
      assert.equal(parsed.ok, false, bad);
    }
  });
});

describe('createConfirmationStore', () => {
  it('persists the latest confirmed hash per folder and forgets an older one', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-space-conf-')), 'c.json');
    const store = createConfirmationStore(file);
    assert.equal(store.isConfirmed('k', 'h1'), false);
    store.recordConfirmed('k', 'h1');
    assert.equal(createConfirmationStore(file).isConfirmed('k', 'h1'), true);
    store.recordConfirmed('k', 'h2');
    assert.equal(store.isConfirmed('k', 'h1'), false);
  });
});
