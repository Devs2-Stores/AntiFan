// report-head.mjs - the `STATUS: <word>` first line of a round's report, read from the first bytes only.
// Shared by board.mjs (needs-me) and leader-job.mjs (wait / wait-any): a worker rewrites line 1 to
// `STATUS: NEEDS_INPUT` while it is still running, and every waiter must see the same thing.
// Never throws; null when the file is missing, half-written or older than the round's dispatch.

import fs from "node:fs";

const REPORT_HEAD_BYTES = 512;

/** @returns {{status:string, mtimeMs:number}|null} status as written (case kept), mtimeMs of the report file. */
export function reportHeadOf(round) {
  if (typeof round?.reportPath !== "string") return null;
  let fd = null;
  try {
    fd = fs.openSync(round.reportPath, "r");
    const st = fs.fstatSync(fd);
    if (typeof round.dispatchedAt === "number" && st.mtimeMs < round.dispatchedAt) return null;
    const buf = Buffer.alloc(REPORT_HEAD_BYTES);
    const n = fs.readSync(fd, buf, 0, REPORT_HEAD_BYTES, 0);
    const first = buf.toString("utf8", 0, n).replace(/^\uFEFF/, "").split(/\r?\n/, 1)[0];
    const m = /^STATUS:\s*([A-Za-z_]+)/.exec(first);
    return m ? { status: m[1], mtimeMs: st.mtimeMs } : null;
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {}
    }
  }
}
