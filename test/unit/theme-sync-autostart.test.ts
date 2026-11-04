import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { detectThemeSyncPlatforms, planThemeSyncAutostart, windowHasLeaderWorker } from '../../src/main/project/theme-sync-autostart';
import { HARAVAN_LOCAL_BINDING_FILE, SAPO_LOCAL_BINDING_FILE } from '../../src/main/project/sync-identity';

const HARAVAN = JSON.stringify({ org_id: '1000123', theme_id: '1001234' });
const SAPO = JSON.stringify({ store_prefix: 'shop', theme_id: 55 });

function folderWith(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-theme-sync-'));
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), body, 'utf8');
  }
  return dir;
}

const space = (terminals: unknown[]): string => JSON.stringify({ version: 1, terminals, tabs: [] });

describe('detectThemeSyncPlatforms', () => {
  it('names the platform from the binding file its own CLI wrote', () => {
    assert.deepEqual(detectThemeSyncPlatforms(folderWith({ [HARAVAN_LOCAL_BINDING_FILE]: HARAVAN })), ['haravan']);
    assert.deepEqual(detectThemeSyncPlatforms(folderWith({ [SAPO_LOCAL_BINDING_FILE]: SAPO })), ['sapo']);
  });

  it('lists Haravan before Sapo when a folder is bound to both', () => {
    const folder = folderWith({ [SAPO_LOCAL_BINDING_FILE]: SAPO, [HARAVAN_LOCAL_BINDING_FILE]: HARAVAN });
    assert.deepEqual(detectThemeSyncPlatforms(folder), ['haravan', 'sapo']);
  });

  it('does not count a garbled or id-less binding: the CLI has nothing to push to', () => {
    assert.deepEqual(detectThemeSyncPlatforms(folderWith({ [HARAVAN_LOCAL_BINDING_FILE]: '{org_id: 1' })), []);
    assert.deepEqual(detectThemeSyncPlatforms(folderWith({ [HARAVAN_LOCAL_BINDING_FILE]: JSON.stringify({ org_id: '1' }) })), []);
    assert.deepEqual(detectThemeSyncPlatforms(folderWith({ [SAPO_LOCAL_BINDING_FILE]: JSON.stringify({ theme_id: 1 }) })), []);
  });

  it('recognises Shopify by shopify.theme.toml or the intake platform, and nothing else', () => {
    assert.deepEqual(detectThemeSyncPlatforms(folderWith({ 'shopify.theme.toml': '[environments.dev]\n' })), ['shopify']);
    assert.deepEqual(detectThemeSyncPlatforms(folderWith({ '.workspace-context.json': JSON.stringify({ platform: 'shopify' }) })), ['shopify']);
    assert.deepEqual(detectThemeSyncPlatforms(folderWith({ '.workspace-context.json': JSON.stringify({ platform: 'haravan' }) })), []);
    assert.deepEqual(detectThemeSyncPlatforms(folderWith({ '.workspace-context.json': 'not json' })), []);
    assert.deepEqual(detectThemeSyncPlatforms(folderWith({ '.shopifyignore': '' })), []);
  });

  it('finds nothing in a folder that is not a theme or does not exist', () => {
    assert.deepEqual(detectThemeSyncPlatforms(folderWith({ 'README.md': 'x' })), []);
    assert.deepEqual(detectThemeSyncPlatforms(path.join(os.tmpdir(), `antifan-theme-missing-${process.pid}-${Date.now()}`)), []);
  });
});

describe('planThemeSyncAutostart', () => {
  it('plans one never-sleeping sync watcher per platform with the fixed command', () => {
    const folder = folderWith({ [HARAVAN_LOCAL_BINDING_FILE]: HARAVAN, [SAPO_LOCAL_BINDING_FILE]: SAPO });
    assert.deepEqual(planThemeSyncAutostart(folder), [
      { id: 'theme-sync-haravan', label: 'hrv theme dev', command: 'hrv theme dev', role: 'sync', idlePolicy: 'never' },
      { id: 'theme-sync-sapo', label: 'sapo theme dev', command: 'sapo theme dev', role: 'sync', idlePolicy: 'never' },
    ]);
  });

  it('plans `shopify theme dev` for a Shopify theme', () => {
    const [spec] = planThemeSyncAutostart(folderWith({ 'shopify.theme.toml': '' }));
    assert.equal(spec?.command, 'shopify theme dev');
  });

  it('plans nothing for a folder that is not a theme', () => {
    assert.deepEqual(planThemeSyncAutostart(folderWith({ 'package.json': '{}' })), []);
  });

  describe('when the folder has its own Space', () => {
    const bound = { [HARAVAN_LOCAL_BINDING_FILE]: HARAVAN };

    it('still starts the watcher when the Space is bare shells (what Space init writes)', () => {
      const bareShells = space([
        { id: 'terminal-14', label: 'Terminal 14', role: 'shell', idlePolicy: 'manual' },
        { id: 'terminal-split-4', label: 'Terminal split-4', role: 'shell', idlePolicy: 'manual', splitOf: 'terminal-14' },
      ]);
      const plan = planThemeSyncAutostart(folderWith({ ...bound, '.antifan/space.json': bareShells }));
      assert.deepEqual(plan.map((s) => s.id), ['theme-sync-haravan']);
    });

    it('leaves the watcher to the Space when it declares a sync terminal', () => {
      const declared = space([{ id: 'w', label: 'watch', role: 'sync', idlePolicy: 'never' }]);
      assert.deepEqual(planThemeSyncAutostart(folderWith({ ...bound, '.antifan/space.json': declared })), []);
    });

    it('still starts the watcher when the Space only declares an agent command', () => {
      const declared = space([{ id: 'a', label: 'omp', role: 'agent', command: 'omp' }]);
      assert.deepEqual(planThemeSyncAutostart(folderWith({ ...bound, '.antifan/space.json': declared })).map((spec) => spec.command), ['hrv theme dev']);
    });

    it('leaves it to the Space when a terminal types a theme watcher command', () => {
      for (const command of ['hrv theme dev', 'sapo  theme watch --store x', 'shopify theme dev']) {
        const declared = space([{ id: 'w', label: 'watch', role: 'shell', command }]);
        assert.deepEqual(planThemeSyncAutostart(folderWith({ ...bound, '.antifan/space.json': declared })), [], command);
      }
    });

    it('is not suppressed by a Space that is invalid JSON or fails validation', () => {
      assert.equal(planThemeSyncAutostart(folderWith({ ...bound, '.antifan/space.json': '{nope' })).length, 1);
      assert.equal(planThemeSyncAutostart(folderWith({ ...bound, '.antifan/space.json': space([{ id: 'bad id', label: 'x' }]) })).length, 1);
    });
  });

  describe('when a Leader drives the window', () => {
    // The theme role (main/live) is only known to `hrv theme info -j`, a network call: the binding
    // file carries none. A worker a Leader minted in the folder therefore never gets an app-started
    // watcher, whatever theme it is bound to, because a watcher on the live theme pushes every save.
    it('plans nothing for any platform that would otherwise start a watcher', () => {
      const cases: Array<Record<string, string>> = [
        { [HARAVAN_LOCAL_BINDING_FILE]: HARAVAN },
        { [HARAVAN_LOCAL_BINDING_FILE]: HARAVAN, [SAPO_LOCAL_BINDING_FILE]: SAPO },
        { [SAPO_LOCAL_BINDING_FILE]: SAPO },
        { 'shopify.theme.toml': '' },
      ];
      for (const files of cases) {
        const folder = folderWith(files);
        assert.ok(planThemeSyncAutostart(folder).length > 0, `without a Leader: ${Object.keys(files).join(',')}`);
        assert.deepEqual(planThemeSyncAutostart(folder, { leaderDriven: true }), [], Object.keys(files).join(','));
      }
    });

    it('keeps the plan for a window no Leader drives, with or without the option', () => {
      const folder = folderWith({ [HARAVAN_LOCAL_BINDING_FILE]: HARAVAN });
      assert.deepEqual(planThemeSyncAutostart(folder, { leaderDriven: false }), planThemeSyncAutostart(folder));
      assert.equal(planThemeSyncAutostart(folder, { leaderDriven: false }).length, 1);
    });

    it('still defers to a Space that declares its own watcher', () => {
      const declared = space([{ id: 'w', label: 'watch', role: 'sync', idlePolicy: 'never' }]);
      const folder = folderWith({ [HARAVAN_LOCAL_BINDING_FILE]: HARAVAN, '.antifan/space.json': declared });
      assert.deepEqual(planThemeSyncAutostart(folder, { leaderDriven: false }), []);
      assert.deepEqual(planThemeSyncAutostart(folder, { leaderDriven: true }), []);
    });
  });
});

describe('windowHasLeaderWorker', () => {
  const rows = [
    { id: 'terminal-1', ownerKey: 'project:a' },
    { id: 'terminal-2', ownerKey: 'project:b' },
  ];

  it('is true for a Leader worker owned by this window', () => {
    assert.equal(windowHasLeaderWorker('project:a', rows, (id) => id === 'terminal-1'), true);
  });

  it('is false when the worker belongs to another window', () => {
    assert.equal(windowHasLeaderWorker('project:a', rows, (id) => id === 'terminal-2'), false);
  });

  it('is false while the registry has no record of any of this window\'s terminals', () => {
    assert.equal(windowHasLeaderWorker('project:a', rows, () => false), false);
    assert.equal(windowHasLeaderWorker('project:a', [], () => true), false);
  });
});
