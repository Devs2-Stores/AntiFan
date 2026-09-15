/**
 * Deadlock fixture for the external-supervisor tests. Simulates a runner that
 * wedges before arming its watchdog: it takes the mutex, writes one heartbeat
 * that never carries `watchdogArmedAt`, spawns a grandchild (to prove the kill
 * takes the whole tree), then stalls.
 *
 * Modes:
 *  - `stall`     — a hard busy-loop: the event loop dies, heartbeats go stale.
 *  - `heartbeat` — heartbeats keep refreshing but the runner never arms: only
 *                  the bootstrap ceiling can kill it.
 *
 * Env: GOAL_DIR (required), GOAL_MODE ('stall'|'heartbeat'), GOAL_HB_MS.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { acquireRunnerMutex, writeHeartbeat } from '../../../scripts/goal/watchdog.mjs';

const dir = process.env.GOAL_DIR;
const mode = process.env.GOAL_MODE || 'stall';
const hbMs = Number(process.env.GOAL_HB_MS || 200);

fs.mkdirSync(dir, { recursive: true });
acquireRunnerMutex(dir);

// Grandchild: same process tree on Windows (taskkill /T), same process group on
// POSIX (not detached, so it inherits the group the supervisor signals).
const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
fs.writeFileSync(path.join(dir, 'grandchild.pid'), String(grandchild.pid));

writeHeartbeat(dir, { mode });

if (mode === 'heartbeat') {
  setInterval(() => writeHeartbeat(dir, { mode }), hbMs);
} else {
  // Hard stall: nothing in this process runs again.
  for (;;) {}
}
