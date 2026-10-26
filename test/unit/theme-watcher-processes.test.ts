import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import * as cp from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  parseProcessLines,
  parseWmicCsv,
  snapshotProcesses,
  snapshotProcessesCached,
  watcherPlatformOfCommand,
  watchersUnder,
  type ProcessRow,
} from '../../src/main/process/theme-watcher-processes';
import { planThemeSyncAutostart, specsWithoutRunningWatcher } from '../../src/main/project/theme-sync-autostart';
import { HARAVAN_LOCAL_BINDING_FILE, SAPO_LOCAL_BINDING_FILE } from '../../src/main/project/sync-identity';

const HRV_COMMAND =
  '"C:\\Program Files\\nodejs\\node.exe" C:\\Users\\Admin\\AppData\\Roaming\\npm/node_modules/@local/haravan-theme-ops-cli/dist/index.js theme dev';

describe('watcherPlatformOfCommand', () => {
  it('recognises the Haravan CLI by its install path, as the process table really shows it', () => {
    assert.equal(watcherPlatformOfCommand(HRV_COMMAND), 'haravan');
  });

  it('names Sapo and Shopify by their CLI, and `unknown` when the command names none', () => {
    assert.equal(watcherPlatformOfCommand('node C:/npm/node_modules/@sapo/cli/index.js theme watch'), 'sapo');
    assert.equal(watcherPlatformOfCommand('node C:/npm/node_modules/@shopify/cli/bin/run.js theme dev'), 'shopify');
    assert.equal(watcherPlatformOfCommand('node C:/tools/runner.js theme dev'), 'unknown');
  });

  it('is not fooled by commands that merely sit near the words', () => {
    assert.equal(watcherPlatformOfCommand('node build.js theme-dev-tools'), null);
    assert.equal(watcherPlatformOfCommand('hrv theme fetch --only config/settings_data.json'), null);
    assert.equal(watcherPlatformOfCommand(''), null);
  });
});

describe('parseProcessLines and watchersUnder', () => {
  const rows: ProcessRow[] = parseProcessLines(
    ['10|1|', '11|10|', `12|11|${HRV_COMMAND}`, '20|1|', '21|20|', 'garbage', '30|1|node x theme dev'].join('\r\n'),
  );

  it('reads pid, parent and command, and drops lines that are not rows', () => {
    assert.equal(rows.length, 6);
    assert.deepEqual(rows[2], { pid: 12, ppid: 11, command: HRV_COMMAND });
  });

  it('finds a watcher at any depth below the shell, and none under a shell without one', () => {
    assert.deepEqual(watchersUnder(rows, 10), ['haravan']);
    assert.deepEqual(watchersUnder(rows, 20), []);
    assert.deepEqual(watchersUnder(rows, 999), []);
  });

  it('terminates on a parent cycle left by pid reuse', () => {
    const cyclic = parseProcessLines(['1|2|', '2|1|', `3|2|${HRV_COMMAND}`].join('\n'));
    assert.deepEqual(watchersUnder(cyclic, 1), ['haravan']);
  });

  it('reads wmic csv from the right so commas in a command line survive', () => {
    const csv = [
      'Node,CommandLine,ParentProcessId,ProcessId',
      `HOST,${HRV_COMMAND},11,12`,
      'HOST,"C:\\a b\\x.exe" --list=a,b,c,10,11',
      'HOST,,0,4',
      'junk',
    ].join('\r\r\n');
    const rows = parseWmicCsv(csv);
    assert.deepEqual(rows.map((row) => [row.pid, row.ppid]), [[12, 11], [11, 10], [4, 0]]);
    assert.equal(rows[0]?.command, HRV_COMMAND);
    assert.equal(rows[1]?.command, '', 'a command that is not a watcher keeps no text');
  });
});

describe('snapshotProcesses', () => {
  it('sees a real watcher process below the process that spawned it', async () => {
    // The command line names `theme dev` after the script, exactly as `hrv theme dev` does.
    const child = cp.spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)', 'haravan', 'theme', 'dev'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    try {
      assert.ok(child.pid, 'the stand-in watcher started');
      const processes = await snapshotProcesses();
      assert.ok(processes, 'the process table was readable');
      assert.deepEqual(watchersUnder(processes, process.pid), ['haravan']);
      assert.deepEqual(watchersUnder(processes, child.pid), [], 'the watcher has no watcher below it');
    } finally {
      child.kill();
    }
  });

  it('starts a single probe for callers that arrive while one is running, and forgets a failed one', async () => {
    let probes = 0;
    let release: (rows: ProcessRow[] | null) => void = () => {};
    const slow = (): Promise<ProcessRow[] | null> => {
      probes += 1;
      return new Promise((resolve) => { release = resolve; });
    };
    const calls = [snapshotProcessesCached(-1, undefined, slow), snapshotProcessesCached(-1, undefined, slow), snapshotProcessesCached(-1, undefined, slow)];
    assert.equal(probes, 1, 'three concurrent callers share one probe');
    release(null);
    assert.deepEqual(await Promise.all(calls), [null, null, null]);
    const rows: ProcessRow[] = [{ pid: 1, ppid: 0, command: '' }];
    const next = snapshotProcessesCached(60_000, undefined, async () => { probes += 1; return rows; });
    assert.equal(await next, rows, 'a failed probe leaves nothing cached, so the next caller probes again');
    assert.equal(probes, 2);
  });

  it('serves one probe to every caller within the age window, and probes again after it', async () => {
    const first = await snapshotProcessesCached(60_000);
    assert.ok(first, 'the process table was readable');
    assert.equal(await snapshotProcessesCached(60_000), first, 'a second caller within the window reuses the rows');
    const fresh = await snapshotProcessesCached(-1);
    assert.ok(fresh);
    assert.notEqual(fresh, first, 'an expired snapshot is probed again');
  });
});

describe('specsWithoutRunningWatcher', () => {
  const HRV = JSON.stringify({ org_id: '1000123', theme_id: '1001234' });
  const SAPO = JSON.stringify({ store_prefix: 'shop', theme_id: 55 });
  const folderWith = (files: Record<string, string>): string => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-watch-running-'));
    for (const [rel, body] of Object.entries(files)) fs.writeFileSync(path.join(dir, rel), body, 'utf8');
    return dir;
  };
  const watching = (shellPid: number, command: string): ProcessRow[] => [
    { pid: shellPid, ppid: 1, command: '' },
    { pid: shellPid + 1, ppid: shellPid, command },
  ];

  it('drops the spec a hand-typed watcher in a plain shell already covers', () => {
    const folder = folderWith({ [HARAVAN_LOCAL_BINDING_FILE]: HRV });
    const specs = planThemeSyncAutostart(folder);
    assert.equal(specs.length, 1);
    assert.deepEqual(specsWithoutRunningWatcher(folder, specs, [{ cwd: folder, shellPid: 100 }], watching(100, HRV_COMMAND)), []);
  });

  it('keeps the spec when no terminal runs a watcher, or the watcher belongs to another remote', () => {
    const folder = folderWith({ [HARAVAN_LOCAL_BINDING_FILE]: HRV });
    const other = folderWith({ [HARAVAN_LOCAL_BINDING_FILE]: JSON.stringify({ org_id: '1000123', theme_id: '999' }) });
    const specs = planThemeSyncAutostart(folder);
    assert.equal(specsWithoutRunningWatcher(folder, specs, [{ cwd: folder, shellPid: 100 }], watching(100, 'node x')).length, 1);
    assert.equal(specsWithoutRunningWatcher(folder, specs, [{ cwd: other, shellPid: 100 }], watching(100, HRV_COMMAND)).length, 1);
    assert.equal(specsWithoutRunningWatcher(folder, specs, [{ cwd: folder }], watching(100, HRV_COMMAND)).length, 1, 'a row without a shell pid cannot be judged');
  });

  it('starts only the platform that is not yet covered in a folder bound to both', () => {
    const folder = folderWith({ [HARAVAN_LOCAL_BINDING_FILE]: HRV, [SAPO_LOCAL_BINDING_FILE]: SAPO });
    const specs = planThemeSyncAutostart(folder);
    assert.equal(specs.length, 2);
    const left = specsWithoutRunningWatcher(folder, specs, [{ cwd: folder, shellPid: 100 }], watching(100, HRV_COMMAND));
    assert.deepEqual(left.map((spec) => spec.command), ['sapo theme dev']);
  });

  it('treats a watcher whose CLI cannot be named as covering every platform of its folder', () => {
    const folder = folderWith({ [HARAVAN_LOCAL_BINDING_FILE]: HRV, [SAPO_LOCAL_BINDING_FILE]: SAPO });
    const specs = planThemeSyncAutostart(folder);
    assert.deepEqual(
      specsWithoutRunningWatcher(folder, specs, [{ cwd: folder, shellPid: 100 }], watching(100, 'node C:/tools/runner.js theme dev')),
      [],
    );
  });
});
