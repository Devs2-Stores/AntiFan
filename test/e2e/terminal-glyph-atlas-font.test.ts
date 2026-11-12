/**
 * The terminal's WebGL glyph atlas must draw in the font the terminal asks for.
 *
 * xterm's atlas sets canvas fonts as `${style} ${weight} ${size}px ${family}`, which starts
 * with a space for upright text. Electron 43.8.8 rejects that value and silently keeps
 * "10px sans-serif", so every terminal glyph was drawn in the wrong font while every other
 * test stayed green. `src/renderer/canvas-font-shim.js` repairs it on the Terminal Manager
 * page. This suite runs the real xterm + WebGL addon on this checkout's Electron binary, with
 * that shim, and checks every font the atlas assigned was the one the canvas kept: a new
 * Electron or xterm that breaks the atlas font again fails here before it ships.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';

const RUN_TIMEOUT_MS = 90_000;
const RUNTIME_DEFAULT_FONT = '10px sans-serif';

interface FontWrite {
  requested: string;
  kept: string;
}

interface AtlasEvidence {
  scenario: string;
  electron: string;
  runtimeKeepsDefault?: boolean;
  webgl?: { attached: boolean; error: string | null };
  fontWrites?: FontWrite[];
  error?: string;
}

function killOwnedChildTree(proc: ChildProcess): void {
  if (!proc.pid || proc.exitCode !== null || proc.signalCode !== null) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { stdio: 'ignore' });
    return;
  }
  try { proc.kill('SIGKILL'); } catch {}
}

describe('terminal glyph atlas font', () => {
  it('draws every atlas glyph in the font the terminal requested', async (t) => {
    const rootDir = path.resolve(__dirname, '..', '..', '..');
    const runnerScript = path.join(rootDir, 'scripts', 'run-electron.cjs');
    const driverPath = path.join(rootDir, 'test', 'e2e', 'terminal-glyph-atlas-font-driver.cjs');
    assert.ok(fs.existsSync(runnerScript), `the Electron runner is missing: ${runnerScript}`);
    assert.ok(fs.existsSync(driverPath), `the driver is missing: ${driverPath}`);

    const evidenceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-glyph-atlas-evidence-'));
    const evidencePath = path.join(evidenceDir, 'evidence.json');
    // Nothing of a running app may leak in: no ANTIFAN_* identity, no node-mode Electron.
    const env: NodeJS.ProcessEnv = {};
    for (const [name, value] of Object.entries(process.env)) {
      if (!name.toUpperCase().startsWith('ANTIFAN_')) env[name] = value;
    }
    delete env.ELECTRON_RUN_AS_NODE;
    env.ANTIFAN_DRIVER_REPO_ROOT = rootDir;
    env.ANTIFAN_DRIVER_EVIDENCE = evidencePath;

    const proc = spawn(process.execPath, [runnerScript, driverPath], { cwd: rootDir, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let transcript = '';
    proc.stdout?.on('data', (d) => { transcript += d.toString('utf8'); });
    proc.stderr?.on('data', (d) => { transcript += d.toString('utf8'); });
    let timedOut = false;
    // Wall-clock watchdog for a hung Electron child, which no fake timer can reap; it kills only
    // the child this suite spawned.
    const timer = setTimeout(() => { timedOut = true; killOwnedChildTree(proc); }, RUN_TIMEOUT_MS);
    const exited = Promise.withResolvers<number | null>();
    proc.once('error', exited.reject);
    proc.once('exit', (code) => exited.resolve(code));
    const exit = await exited.promise.finally(() => { clearTimeout(timer); killOwnedChildTree(proc); });

    try {
      assert.equal(timedOut, false, `the driver timed out after ${RUN_TIMEOUT_MS}ms\n${transcript}`);
      assert.equal(exit, 0, `the driver must exit cleanly\n${transcript}`);
      const evidence = JSON.parse(fs.readFileSync(evidencePath, 'utf8')) as AtlasEvidence;
      assert.equal(evidence.error, undefined, `the page failed: ${evidence.error}`);
      if (!evidence.webgl?.attached) {
        // Without WebGL the terminal falls back to its DOM renderer, which never builds an atlas.
        t.skip(`WebGL unavailable on this machine (${evidence.webgl?.error ?? 'no context'}); the atlas path cannot run`);
        return;
      }
      const writes = evidence.fontWrites ?? [];
      const atlasWrites = writes.filter((w) => /\b12px\b/.test(w.requested));
      assert.ok(atlasWrites.length > 0, `the atlas set no 12px font, so no glyph was rasterised: ${JSON.stringify(writes)}`);
      for (const style of ['', 'bold', 'italic']) {
        const seen = atlasWrites.some((w) => (style ? w.kept.includes(style) : !/bold|italic/.test(w.kept)));
        assert.ok(seen, `no atlas font for ${style || 'regular'} text was applied: ${JSON.stringify(atlasWrites)}`);
      }
      const rejected = atlasWrites.filter((w) => w.kept === RUNTIME_DEFAULT_FONT || !w.kept.includes('Cascadia Mono'));
      assert.deepEqual(
        rejected,
        [],
        `Electron ${evidence.electron} kept a different font than the atlas set (runtime rejects a leading space: ${evidence.runtimeKeepsDefault})`,
      );
    } finally {
      fs.rmSync(evidenceDir, { recursive: true, force: true });
    }
  });
});
