import { describe, it, after } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { TerminalManager, killProcessTree } from '../../src/main/browser/terminal-manager';

const ROOT = path.resolve(__dirname, '../../..');

describe('Terminal Process Tree Kill & Web Links Addon Contracts', () => {
  const tm = TerminalManager.getInstance();
  const tempDir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'antifan-proc-test-'));
  const testStateFile = path.join(tempDir, 'terminal-sessions.json');
  const originalSpawn = (tm as any).spawn.bind(tm);
  const originalStatePath = (tm as any).statePath.bind(tm);
  (tm as any).statePath = () => testStateFile;

  (tm as any).spawn = function (id: string, cwd: string, restoredBuffer = '') {
    const mockPty = {
      pid: undefined,
      onData: () => ({ dispose: () => {} }),
      onExit: () => ({ dispose: () => {} }),
      kill: () => {},
      write: () => {},
      resize: () => {},
    };
    const s = {
      id,
      name: `Terminal ${id.replace('terminal-', '')}`,
      cwd: cwd || 'E:/Work/project',
      pty: mockPty as any,
      buffer: restoredBuffer || '',
      capsuleId: (tm as any).currentCapsuleId || 'default',
      disposed: false,
    };
    (tm as any).sessions.set(id, s);
    return s;
  };

  after(async () => {
    await tm.dispose();
    (tm as any).spawn = originalSpawn;
    (tm as any).statePath = originalStatePath;
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
  });

  it('verifies killProcessTree helper handles boundary and invalid PIDs safely without throwing', async () => {
    // Should never throw/reject on undefined, 0, negative, or NaN
    await assert.doesNotReject(async () => killProcessTree(undefined));
    await assert.doesNotReject(async () => killProcessTree(0));
    await assert.doesNotReject(async () => killProcessTree(-1));
    await assert.doesNotReject(async () => killProcessTree(Number.NaN));
    await assert.doesNotReject(async () => killProcessTree(Number.POSITIVE_INFINITY));
    await assert.doesNotReject(async () => killProcessTree(null as any));
  });

  it('verifies TerminalManager lifecycle safely disposes and kills process trees during session restart and close', async () => {
    // 1. Create a parent session and split session
    const parentId = tm.createSession();
    assert.ok(parentId);
    const splitId = tm.createSplitSession(parentId);
    assert.ok(splitId);

    const parentSession = tm.getSession(parentId);
    const splitSession = tm.getSession(splitId);
    assert.ok(parentSession);
    assert.ok(splitSession);

    // 2. Restart session - should safely kill target and split sessions
    tm.switchSession(parentId);
    await tm.restart();

    // The old parentSession and splitSession references should have disposed = true
    assert.strictEqual(parentSession.disposed, true);
    assert.strictEqual(splitSession.disposed, true);

    // 3. Create a new session and close it
    const tempId = tm.createSession();
    const tempSession = tm.getSession(tempId);
    assert.ok(tempSession);

    assert.strictEqual(await tm.closeSession(tempId), true);
    assert.strictEqual(tempSession.disposed, true);
    assert.strictEqual(tm.getSession(tempId), undefined);

    // Cleanup parent
    await tm.closeSession(parentId);
  });

  it('verifies standalone.html includes @xterm/addon-web-links script tag', () => {
    const htmlPath = path.join(ROOT, 'src/renderer/standalone.html');
    assert.ok(fs.existsSync(htmlPath));
    const htmlContent = fs.readFileSync(htmlPath, 'utf8');

    assert.match(
      htmlContent,
      /<script\s+src=["'][^"']*@xterm\/addon-web-links\/lib\/addon-web-links\.js["']><\/script>/i,
      'standalone.html must include @xterm/addon-web-links script'
    );
  });

  it('verifies standalone-preload.ts exports createTab and openExternal for link routing', () => {
    const preloadPath = path.join(ROOT, 'src/preload/standalone-preload.ts');
    assert.ok(fs.existsSync(preloadPath));
    const preloadContent = fs.readFileSync(preloadPath, 'utf8');

    assert.match(preloadContent, /createTab:\s*\(url\?:\s*string\)\s*=>\s*ipcRenderer\.invoke\('antifan:toolbar:create-tab',\s*url\)/);
    assert.match(preloadContent, /openExternal:\s*\(url\?:\s*string\)\s*=>\s*ipcRenderer\.invoke\('antifan:toolbar:open-external',\s*url\)/);
  });

  it('verifies standalone.js implements attachWebLinksAddon and wires click-to-open AntiFan tab', () => {
    const jsPath = path.join(ROOT, 'src/renderer/standalone.js');
    assert.ok(fs.existsSync(jsPath));
    const jsContent = fs.readFileSync(jsPath, 'utf8');

    // 1. Function attachWebLinksAddon definition
    assert.match(jsContent, /function\s+attachWebLinksAddon\s*\(\s*term\s*\)/);
    assert.match(jsContent, /WebLinksAddon/);

    // 2. Link handler routing: priority to createTab (new browser tab), fallback to openExternal
    assert.match(jsContent, /api\?\.createTab/);
    assert.match(jsContent, /api\?\.openExternal/);

    // 3. Main pane and split pane load web links addon
    assert.match(jsContent, /webLinksAddon\s*=\s*attachWebLinksAddon/);
    assert.match(jsContent, /splitWebLinksAddon\s*=\s*attachWebLinksAddon/);

    // 4. Proper cleanup on disposal
    assert.match(jsContent, /item\.webLinksAddon\?\.dispose\(\)/);
    assert.match(jsContent, /splitWebLinksAddon\?\.dispose\(\)/);
  });
});
