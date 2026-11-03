// The fallback tick bounds wake-up latency only; it never decides that a worker is done.

import * as fs from "node:fs";

export const FALLBACK_TICK_MS = 2_000;
const COALESCE_MS = 100;

export function nextRunChange(dir, { fallbackMs = FALLBACK_TICK_MS, names = null } = {}) {
  return new Promise((resolve) => {
    let watcher = null;
    let coalesce = null;
    let tick = null;
    const finish = () => {
      clearTimeout(tick);
      clearTimeout(coalesce);
      try {
        watcher?.close();
      } catch {
      }
      resolve();
    };
    tick = setTimeout(finish, fallbackMs);
    try {
      watcher = fs.watch(dir, (_event, filename) => {
        if (names && filename && !names.has(String(filename))) return;
        clearTimeout(coalesce);
        coalesce = setTimeout(finish, COALESCE_MS);
      });
      watcher.on("error", finish);
    } catch {
    }
  });
}
