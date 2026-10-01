import * as fs2 from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
process.env.ANTIFAN_DATA_ROOT = fs2.mkdtempSync(path.join(os.tmpdir(), "antifan-repro-"));
class FakePty {
  pid = 0; killed = false;
  onData() { return { dispose() {} }; }
  onExit() { return { dispose() {} }; }
  kill() { this.killed = true; }
  write() {}
  resize() {}
}
const ptyModule = require("node-pty");
ptyModule.spawn = () => new FakePty();
import { TerminalManager } from "../src/main/browser/terminal-manager";
async function main() {
  const tm = TerminalManager.getInstance();
  const id = tm.createSession("E:/Work/project", undefined, undefined, { role: "sync", spaceTerminalId: "watch" });
  const rec = (tm as any).sessions.get(id);
  console.log("before restart:", JSON.stringify({ role: rec.role, idlePolicy: rec.idlePolicy, space: rec.spaceTerminalId }));
  console.log("sleep before restart:", JSON.stringify(tm.sleepSession(id)));
  (tm as any).activeSessionId = id;
  await tm.restart(undefined);
  const rec2 = (tm as any).sessions.get(id);
  console.log("after restart:", JSON.stringify({ role: rec2?.role, idlePolicy: rec2?.idlePolicy, space: rec2?.spaceTerminalId, state: rec2?.state }));
  console.log("sleep after restart:", JSON.stringify(tm.sleepSession(id)), "state=", rec2?.state);
  await tm.dispose();
}
main().catch((e) => { console.error(e); process.exit(1); });
