/**
 * A restart script ends the live app through the single-instance handoff, the one channel
 * that needs no credential. The quit flag must be honoured even when the process has no
 * live shell, so the check has to sit before the handler's early return.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { QUIT_REQUEST_ARGUMENT, isQuitRequestArgv } from '../../../src/main/browser/single-instance-lock';

const root = fs.existsSync(path.join(process.cwd(), 'src')) ? process.cwd() : path.resolve(__dirname, '..', '..', '..');

describe('isQuitRequestArgv', () => {
  it('matches the exact flag anywhere in the argument list', () => {
    assert.equal(isQuitRequestArgv(['electron.exe', 'E:\\Work\\apps\\AntiFan', '--allow-eval', '--antifan-quit-request']), true);
    assert.equal(isQuitRequestArgv([QUIT_REQUEST_ARGUMENT]), true);
  });

  it('rejects look-alikes and ordinary launches', () => {
    assert.equal(isQuitRequestArgv(['electron.exe', '--antifan-quit-request=1']), false);
    assert.equal(isQuitRequestArgv(['electron.exe', '--antifan-quit']), false);
    assert.equal(isQuitRequestArgv(['electron.exe', 'https://example.com/--antifan-quit-request']), false);
    assert.equal(isQuitRequestArgv(['electron.exe', 'E:\\Work\\apps\\AntiFan', '--allow-eval']), false);
    assert.equal(isQuitRequestArgv([]), false);
    assert.equal(isQuitRequestArgv(undefined), false);
  });
});

describe('second-instance quit request wiring', () => {
  const index = fs.readFileSync(path.join(root, 'src', 'main', 'index.ts'), 'utf8');
  const handlerStart = index.indexOf("app.on('second-instance'");
  assert.ok(handlerStart > 0, 'index.ts must install a second-instance handler');
  const handler = index.slice(handlerStart, handlerStart + 2500);

  it('checks the quit flag before the no-live-shell early return', () => {
    const quitCheck = handler.indexOf('isQuitRequestArgv(commandLine)');
    const earlyReturn = handler.indexOf('if (shells.length === 0) return;');
    assert.ok(quitCheck > 0, 'the handler must test isQuitRequestArgv(commandLine)');
    assert.ok(earlyReturn > 0, 'the no-shell early return must still exist');
    assert.ok(quitCheck < earlyReturn, 'the quit flag has to be handled before the early return');
  });

  it('quits through the shared quit path with its own origin', () => {
    assert.match(handler, /requestApplicationQuit\('second-instance-quit'\)/);
  });
});

describe('antifan-restart.ps1', () => {
  const script = fs.readFileSync(path.join(root, 'scripts', 'antifan-restart.ps1'), 'utf8');

  it('refuses a stale build unless told otherwise', () => {
    assert.match(script, /BUILD_STALE/);
    assert.match(script, /\$AllowStale/);
    assert.match(script, /\.compiled\\src\\main\\index\.js/);
  });

  it('sends the quit flag through the launcher, not the bridge', () => {
    assert.match(script, /--antifan-quit-request/);
    assert.doesNotMatch(script, /antifan\.quit/);
    assert.doesNotMatch(script, /bridge\.json/);
  });

  it('stops the process by force only when the caller passes -Force', () => {
    const forceStops = script.match(/Stop-Process/g) ?? [];
    assert.equal(forceStops.length, 1, 'exactly one forced stop exists');
    const stopIndex = script.indexOf('Stop-Process');
    const guard = script.lastIndexOf('if (-not $Force)', stopIndex);
    assert.ok(guard > 0 && guard < stopIndex, 'the forced stop sits behind the -Force guard');
  });
});
