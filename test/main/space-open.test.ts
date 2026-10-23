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
  const minted: Array<{ kind: 'base' | 'split'; specId: string; directory: string; parent?: string; role: string; idlePolicy: string }> = [];
  const tabs: string[] = [];
  const confirmedHashes = new Set<string>();
  const state = { cascadeWake: false };
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
    // Snapshots, as the host's mapped list is: a wake later in the run must not rewrite what an
    // earlier read saw.
    sessions: () => sessions.map((s) => ({ ...s })),
    mint: async (directory, _cap, spec) => {
      // A real mint yields to the event loop: this is what lets two concurrent opens interleave.
      await new Promise((r) => setImmediate(r));
      const id = `t${++next}`;
      sessions.push({ id, cwd: directory, state: 'running', spaceTerminalId: spec.id });
      minted.push({ kind: 'base', specId: spec.id, directory, role: spec.role, idlePolicy: spec.idlePolicy });
      return id;
    },
    mintSplit: async (directory, _cap, parent, spec) => {
      await new Promise((r) => setImmediate(r));
      const id = `t${++next}`;
      sessions.push({ id, cwd: directory, state: 'running', spaceTerminalId: spec.id, splitOf: parent });
      minted.push({ kind: 'split', specId: spec.id, directory, parent, role: spec.role, idlePolicy: spec.idlePolicy });
      return id;
    },
    findSyncDuplicate: () => duplicate,
    typeCommand: (id, text) => void typed.push({ id, text }),
    wake: async (id) => {
      const s = sessions.find((x) => x.id === id);
      if (!s) return false;
      s.state = 'running';
      if (state.cascadeWake) {
        for (const pane of sessions) if (pane.splitOf === id) pane.state = 'running';
      }
      return true;
    },
  };
  return { deps, sessions, typed, minted, state, tabs, windowOpens: () => windowOpens, setDuplicate: (d: typeof duplicate) => void (duplicate = d) };
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

  describe('splits and cwd', () => {
    const LAYOUT = {
      version: 1,
      terminals: [
        { id: 'main', label: 'Main', role: 'agent' },
        { id: 'sync-haravan', label: 'Haravan sync', role: 'sync', cwd: 'Haravan', splitOf: 'main', command: 'hrv theme dev' },
        { id: 'sync-sapo', label: 'Sapo sync', role: 'sync', cwd: 'Sapo', splitOf: 'main', command: 'sapo theme dev' },
      ],
    };
    const withThemeFolders = (): string => folderWith(LAYOUT, { 'Haravan/layout/theme.liquid': 'x', 'Sapo/layouts/theme.bwt': 'x' });

    it('mints the base first, then each split under it with its own folder, role and command', async () => {
      const h = harness(true);
      const folder = withThemeFolders();
      const result = await openSpace(h.deps, folder, undefined);
      assert.deepEqual(result, { ok: true, terminalsOpened: 3, terminalsReused: 0, tabsOpened: 0, tabsReused: 0 });
      assert.deepEqual(h.minted.map((m) => m.kind), ['base', 'split', 'split']);
      assert.deepEqual(h.minted.map((m) => m.specId), ['main', 'sync-haravan', 'sync-sapo']);
      assert.deepEqual(h.minted.map((m) => m.directory), [folder, path.join(folder, 'Haravan'), path.join(folder, 'Sapo')]);
      assert.deepEqual(h.minted.slice(1).map((m) => [m.parent, m.role, m.idlePolicy]), [['t1', 'sync', 'never'], ['t1', 'sync', 'never']]);
      assert.deepEqual(h.typed, [{ id: 't2', text: 'hrv theme dev\r' }, { id: 't3', text: 'sapo theme dev\r' }]);
    });

    it('reopening reuses base and splits by spaceTerminalId and mints no extra pane', async () => {
      const h = harness(true);
      const folder = withThemeFolders();
      await openSpace(h.deps, folder, undefined);
      const again = await openSpace(h.deps, folder, undefined);
      assert.deepEqual(again, { ok: true, terminalsOpened: 0, terminalsReused: 3, tabsOpened: 0, tabsReused: 0 });
      assert.equal(h.sessions.length, 3);
      assert.equal(h.typed.length, 2, 'running watchers are not retyped');
    });

    it('a sleeping parent wakes with its splits; the splits it woke still get their command', async () => {
      const h = harness(true);
      const folder = withThemeFolders();
      await openSpace(h.deps, folder, undefined);
      for (const s of h.sessions) s.state = 'sleeping';
      h.typed.length = 0;
      // Waking a parent cascades to its splits, exactly as the terminal manager does.
      h.state.cascadeWake = true;
      const result = await openSpace(h.deps, folder, undefined);
      assert.equal(result.ok, true);
      assert.deepEqual(h.sessions.map((s) => s.state), ['running', 'running', 'running']);
      assert.deepEqual(h.typed, [{ id: 't2', text: 'hrv theme dev\r' }, { id: 't3', text: 'sapo theme dev\r' }]);
      assert.equal((result as { terminalsWoken?: number }).terminalsWoken, 3);
    });

    it('does not mint a sync split when a live watcher already pushes to its remote, using the split own folder', async () => {
      const h = harness(true);
      const folder = withThemeFolders();
      const askedAbout: string[] = [];
      h.deps.findSyncDuplicate = (directory) => {
        askedAbout.push(directory);
        return directory.endsWith('Sapo') ? { id: 'elsewhere', label: 'other sapo watcher' } : undefined;
      };
      const result = await openSpace(h.deps, folder, undefined);
      assert.equal(result.ok, true);
      assert.deepEqual(askedAbout, [path.join(folder, 'Haravan'), path.join(folder, 'Sapo')]);
      assert.deepEqual((result as { syncDuplicates?: unknown }).syncDuplicates, [
        { spaceTerminalId: 'sync-sapo', duplicate: { id: 'elsewhere', label: 'other sapo watcher' } },
      ]);
      assert.deepEqual(h.sessions.map((s) => s.spaceTerminalId), ['main', 'sync-haravan']);
    });

    it('fails before minting anything when a declared cwd is missing, a file, or leaves the folder', async () => {
      const h = harness(true);
      const folder = folderWith(LAYOUT, { 'Haravan/layout/theme.liquid': 'x' });
      const missing = await openSpace(h.deps, folder, undefined);
      assert.equal(missing.ok, false);
      assert.match(missing.ok ? '' : (missing as { message: string }).message, /cwd 'Sapo'/);
      assert.equal(h.sessions.length, 0, 'nothing was minted');
      const asFile = folderWith(LAYOUT, { Haravan: 'not a folder', 'Sapo/layouts/theme.bwt': 'x' });
      assert.equal((await openSpace(h.deps, asFile, undefined)).ok, false);
      assert.equal(h.sessions.length, 0);
    });

    it('a split whose parent was not opened because it is a sync duplicate fails instead of being minted loose', async () => {
      const h = harness(true);
      h.setDuplicate({ id: 'x', label: 'x' });
      const folder = folderWith({ version: 1, terminals: [{ id: 'up', role: 'sync' }, { id: 'w', role: 'shell', splitOf: 'up' }] });
      const result = await openSpace(h.deps, folder, undefined);
      assert.equal(result.ok, false);
      assert.match(result.ok ? '' : (result as { message: string }).message, /split of 'up'/);
      assert.equal(h.minted.length, 0);
    });
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
