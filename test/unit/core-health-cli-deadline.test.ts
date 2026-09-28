/**
 * CoreHealthService CLI deadline & in-flight un-wedging proof.
 *
 * Verifies that when a child process's deadline expires, the promise settles
 * immediately with a timeout error and cleans up `cliInFlight`, even if a
 * detached grandchild process holds stdio pipes open (which delays Node's
 * `close` event until the grandchild exits).
 */
import { test, describe, afterEach } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CoreHealthService, resolveRepoRoot } from '../../src/main/diagnostics/core-health';

const REPO_ROOT = resolveRepoRoot(__dirname);

// Whitebox unit test accessor for private cli<T>() method
interface CliAccessor {
  cli<T = unknown>(command: string, arg?: string): Promise<T>;
}

describe('CoreHealthService CLI deadline handling', () => {
  let tmpDir: string | null = null;

  afterEach(() => {
    if (tmpDir && fs.existsSync(tmpDir)) {
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch {}
      tmpDir = null;
    }
  });

  function setupScratchCli(): { scriptPath: string; counterFile: string } {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-deadline-test-'));
    const scriptPath = path.join(tmpDir, 'scratch-cli.cjs');
    const counterFile = path.join(tmpDir, 'counter.txt');

    const scriptContent = `
const { spawn } = require('child_process');
const fs = require('fs');
const counterFile = ${JSON.stringify(counterFile)};

fs.appendFileSync(counterFile, Buffer.from([49, 10]));

const grandchild = spawn(process.execPath, ['-e', 'setTimeout(() => process.exit(0), 4000)'], {
  detached: true,
  stdio: ['ignore', 1, 2],
  windowsHide: true,
});
grandchild.unref();

process.exit(0);
`;
    fs.writeFileSync(scriptPath, scriptContent);
    return { scriptPath, counterFile };
  }

  test(
    'cli() settles on deadline when grandchild holds pipes open, and second call on same key also settles',
    { timeout: 6000 },
    async () => {
      const { scriptPath, counterFile } = setupScratchCli();

      const svc = new CoreHealthService({
        scriptPath,
        repoRoot: REPO_ROOT,
        timeoutMs: 250,
      });
      // Accessible via whitebox type assertion for unit verification of private cli()
      const cliSvc = svc as unknown as CliAccessor;

      // 1. First call: must settle within deadline (< 1500ms), not wait for grandchild (4000ms)
      const t0 = Date.now();
      await assert.rejects(
        async () => {
          await cliSvc.cli('health');
        },
        (err: Error) => {
          assert.match(err.message, /timed out after 250ms/);
          return true;
        }
      );
      const elapsed1 = Date.now() - t0;
      assert.ok(
        elapsed1 < 1500,
        `First cli() call must settle well before grandchild exits at 4000ms (took ${elapsed1}ms)`
      );

      // 2. Second call on the SAME key: must also settle and spawn anew (not wedged in cliInFlight)
      const t1 = Date.now();
      await assert.rejects(
        async () => {
          await cliSvc.cli('health');
        },
        (err: Error) => {
          assert.match(err.message, /timed out after 250ms/);
          return true;
        }
      );
      const elapsed2 = Date.now() - t1;
      assert.ok(
        elapsed2 < 1500,
        `Second cli() call on same key must also settle well before grandchild exits (took ${elapsed2}ms)`
      );

      // 3. Verify that the second call genuinely spawned a new process (not wedged returning old
      //    promise). The counter line is written by the child's own boot, which can trail the
      //    deadline that un-wedged the call — under a loaded lane that boot is slower than the
      //    250ms deadline — so the read is bounded-waited instead of sampled once.
      const countInvocations = (): number =>
        fs.existsSync(counterFile) ? fs.readFileSync(counterFile, 'utf8').trim().split('\n').filter(Boolean).length : 0;
      const counterDeadline = Date.now() + 3000;
      let invocations = countInvocations();
      while (invocations < 2 && Date.now() < counterDeadline) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        invocations = countInvocations();
      }
      assert.equal(
        invocations,
        2,
        'Second call must have spawned a new child process, proving in-flight map was cleared'
      );
    }
  );

  test(
    'getSnapshot() public surface maps timed out CLI to UNAVAILABLE without hanging on grandchild',
    { timeout: 2500 },
    async () => {
      const { scriptPath } = setupScratchCli();

      const svc = new CoreHealthService({
        scriptPath,
        repoRoot: REPO_ROOT,
        timeoutMs: 250,
      });

      const t0 = Date.now();
      const snap = await svc.getSnapshot();
      const elapsed = Date.now() - t0;

      assert.ok(
        elapsed < 1500,
        `getSnapshot() must settle well before grandchild exits (took ${elapsed}ms)`
      );
      assert.equal(snap.status, 'UNAVAILABLE');
      assert.equal(snap.reasonCode, 'CORE_UNAVAILABLE');
      assert.ok(
        snap.affected.some((a) => a.includes('timed out after 250ms')),
        `affected must contain timeout message, got: ${JSON.stringify(snap.affected)}`
      );
    }
  );
});
