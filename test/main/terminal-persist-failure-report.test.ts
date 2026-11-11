/**
 * A terminal state write that fails must be reported (console, because the terminal daemon
 * process shares this class and must not touch Main's lifecycle journal) once per distinct error,
 * and be reported again after a write has succeeded in between.
 */
import { describe, it, before, after, mock } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { TerminalManager } from '../../src/main/browser/terminal-manager';

const SCRATCH_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-persist-failure-'));

interface Privates {
  hadAnySessions: boolean;
  writePersistSync: () => void;
}

describe('Terminal state write failure report', () => {
  const previous = { dataRoot: process.env.ANTIFAN_DATA_ROOT, configDir: process.env.ANTIFAN_CONFIG_DIR };
  const blocker = path.join(SCRATCH_ROOT, 'not-a-directory');
  const goodDir = path.join(SCRATCH_ROOT, 'config');
  let manager: Privates;

  before(() => {
    process.env.ANTIFAN_DATA_ROOT = SCRATCH_ROOT;
    fs.writeFileSync(blocker, 'x');
    fs.mkdirSync(goodDir, { recursive: true });
    manager = TerminalManager.getInstance() as unknown as Privates;
    manager.hadAnySessions = true;
  });

  after(() => {
    for (const [key, value] of [['ANTIFAN_DATA_ROOT', previous.dataRoot], ['ANTIFAN_CONFIG_DIR', previous.configDir]] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(SCRATCH_ROOT, { recursive: true, force: true });
  });

  it('a failed state write is reported once per distinct error and re-armed by a success', () => {
    const warn = mock.method(console, 'warn', () => {});
    try {
      const failures = () => warn.mock.calls.filter((call) => String(call.arguments[0]).includes('state write failed')).length;

      process.env.ANTIFAN_CONFIG_DIR = path.join(blocker, 'config');
      manager.writePersistSync();
      manager.writePersistSync();
      assert.equal(failures(), 1, 'the same error twice is one report');

      process.env.ANTIFAN_CONFIG_DIR = goodDir;
      manager.writePersistSync();
      assert.equal(failures(), 1, 'a successful write reports nothing');
      assert.ok(fs.existsSync(path.join(goodDir, 'terminal-sessions.json')), 'the write landed');

      process.env.ANTIFAN_CONFIG_DIR = path.join(blocker, 'config');
      manager.writePersistSync();
      assert.equal(failures(), 2, 'a failure after a success is reported again');
    } finally {
      warn.mock.restore();
    }
  });
});
