
const fs2 = require('node:fs');
const os = require('node:os');
const path = require('node:path');
process.env.ANTIFAN_DATA_ROOT = fs2.mkdtempSync(path.join(os.tmpdir(), 'antifan-repro-'));
class FakePty {
  constructor() { this.pid = 0; this.killed = false; }
  onData() { return { dispose() {} }; }
  onExit() { return { dispose() {} }; }
  kill() { this.killed = true; }
  write() {}
  resize() {}
}
const ptyModule = require('node-pty');
ptyModule.spawn = () => new FakePty();
const { TerminalManager } = require('tsx/cjs') ? require('../src/main/browser/terminal-manager.ts') : null;
async function main() {
  const tm = TerminalManager.getInstance();
  const id = tm.createSession('E:/Work/project', undefined, undefined, { role: 'sync', spaceTerminalId: 'watch' });
  const rec = tm.sessions.get(id);
  console.log('before restart:', JSON.stringify({ role: rec.role, idlePolicy: rec.idlePolicy, space: rec.spaceTerminalId }));
  console.log('sleep before restart:', JSON.stringify(tm.sleepSession(id)));
  tm.activeSessionId = id;
  await tm.restart(undefined);
  const rec2 = tm.sessions.get(id);
  console.log('after restart:', JSON.stringify({ role: rec2 && rec2.role, idlePolicy: rec2 && rec2.idlePolicy, space: rec2 && rec2.spaceTerminalId, state: rec2 && rec2.state }));
  console.log('sleep after restart:', JSON.stringify(tm.sleepSession(id)), 'state=', rec2 && rec2.state);
  await tm.dispose();
}
main().catch((e) => { console.error(e); process.exit(1); });
