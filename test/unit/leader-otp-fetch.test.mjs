// otp-fetch.mjs: the OTP goes to the clipboard (here a file seam), stdout carries only {found,len,ageSec}, and no output holds the code or the key.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, test } from "node:test";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const SCRIPT = path.join(REPO, "scripts", "leader", "otp-fetch.mjs");
const TEMP = fs.mkdtempSync(path.join(os.tmpdir(), "otp-fetch-"));
const servers = new Set();
after(() => {
  for (const s of servers) {
    if (!s.listening) continue;
    s.closeAllConnections?.();
    s.close();
  }
  fs.rmSync(TEMP, { recursive: true, force: true });
});

const KEY = "k".repeat(40);
const CODE = "A7Q93Z";
let seq = 0;

/** A fake otp-inbox. `handler(req)` returns [status, body]; every request is recorded. */
async function fakeWorker(handler) {
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push({ url: req.url, auth: req.headers.authorization });
    const [status, body] = handler(req, seen.length);
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  servers.add(server);
  return { url: `http://127.0.0.1:${server.address().port}`, seen, close: () => (server.listening ? server.close() : undefined) };
}

/**
 * Run the script; resolves {code, stdout, stderr, clip}. `clip` is what the clipboard seam received (null when untouched).
 * A read (no --now/--clear/--lock/--renew/--unlock) needs `--job` and a login lock held by that job: unless `opts.raw`, the helper seeds a
 * fresh lock for job "tester" and adds `--job tester`, so the tests below exercise the read itself; the lock tests pass `raw`.
 */
function run(args, env = {}, opts = {}) {
  const clipFile = path.join(TEMP, `clip-${++seq}.txt`);
  const envFile = path.join(TEMP, `env-${seq}.env`);
  const isRead = !["--now", "--clear", "--lock", "--renew", "--unlock"].some((f) => args.includes(f));
  const lockFile = env.OTP_FETCH_LOCK_FILE ?? path.join(TEMP, `lock-${seq}.lock`);
  if (isRead && !opts.raw) {
    fs.writeFileSync(lockFile, JSON.stringify({ job: "tester", pid: 1, at: Date.now() }));
    args = [...args, "--job", "tester"];
  }
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SCRIPT, ...args], {
      env: { ...process.env, ANTIFAN_SECRET_OTP_INBOX_URL: "", ANTIFAN_SECRET_OTP_INBOX_KEY: "", OTP_FETCH_ENV_FILE: envFile, OTP_FETCH_CLIPBOARD_FILE: clipFile, OTP_FETCH_POLL_MS: "50", OTP_FETCH_LOCK_FILE: lockFile, ...env },
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (code) => resolve({ code, stdout, stderr, clip: fs.existsSync(clipFile) ? fs.readFileSync(clipFile, "utf8") : null, envFile }));
  });
}

const cfg = (w) => ({ ANTIFAN_SECRET_OTP_INBOX_URL: w.url, ANTIFAN_SECRET_OTP_INBOX_KEY: KEY });
const noSecrets = (r) => {
  for (const text of [r.stdout, r.stderr]) {
    assert.ok(!text.includes(CODE), "the code reached the output");
    assert.ok(!text.includes(KEY), "the key reached the output");
  }
};

describe("otp-fetch", () => {
  test("a code newer than --since goes to the clipboard; stdout is one json line without the code", async () => {
    const received = Date.now() - 4000;
    const w = await fakeWorker(() => [200, { found: true, otp: CODE, receivedAt: received }]);
    const r = await run(["--since", "123456", "--wait", "5"], cfg(w));
    w.close();
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.clip, CODE);
    const lines = r.stdout.trim().split(/\r?\n/);
    assert.equal(lines.length, 1);
    const out = JSON.parse(lines[0]);
    assert.equal(out.found, true);
    assert.equal(out.len, 6);
    assert.ok(out.ageSec >= 3 && out.ageSec <= 8, `ageSec ${out.ageSec}`);
    assert.deepEqual(Object.keys(out).sort(), ["ageSec", "found", "len"]);
    assert.equal(w.seen[0].url, "/otp?since=123456");
    assert.equal(w.seen[0].auth, `Bearer ${KEY}`);
    noSecrets(r);
  });

  test("no code: polls until --wait, leaves the clipboard alone, exit 1", async () => {
    const w = await fakeWorker(() => [200, { found: false }]);
    const t0 = Date.now();
    const r = await run(["--since", "1", "--wait", "1"], cfg(w));
    w.close();
    assert.equal(r.code, 1, r.stderr);
    assert.equal(r.clip, null);
    assert.equal(JSON.parse(r.stdout.trim()).found, false);
    assert.ok(w.seen.length >= 3, `polled ${w.seen.length} times`);
    assert.ok(Date.now() - t0 >= 900);
  });

  test("a code that shows up on a later poll is still taken", async () => {
    const w = await fakeWorker((_req, n) => (n < 3 ? [200, { found: false }] : [200, { found: true, otp: CODE, receivedAt: Date.now() }]));
    const r = await run(["--since", "1", "--wait", "10"], cfg(w));
    w.close();
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.clip, CODE);
    assert.equal(w.seen.length, 3);
    noSecrets(r);
  });

  test("401 stops at once with exit 3 and a message that holds neither the key nor a code", async () => {
    const w = await fakeWorker(() => [401, { error: "unauthorized" }]);
    const r = await run(["--since", "1", "--wait", "30"], cfg(w));
    w.close();
    assert.equal(r.code, 3);
    assert.equal(w.seen.length, 1, "a wrong key is not retried");
    assert.equal(r.clip, null);
    assert.match(JSON.parse(r.stdout.trim()).error, /401/);
    noSecrets(r);
  });

  test("an unreachable Worker times out with found:false, never throws", async () => {
    const w = await fakeWorker(() => [200, { found: false }]);
    const dead = w.url;
    w.close();
    await new Promise((r) => setTimeout(r, 50));
    const r = await run(["--since", "1", "--wait", "1"], { ANTIFAN_SECRET_OTP_INBOX_URL: dead, ANTIFAN_SECRET_OTP_INBOX_KEY: KEY });
    assert.equal(r.code, 1);
    const out = JSON.parse(r.stdout.trim());
    assert.equal(out.found, false);
    assert.match(out.error, /unreachable/);
    noSecrets(r);
  });

  test("an unusable code (wrong shape) is not copied and ends at once with exit 3 (the Worker already deleted it)", async () => {
    const w = await fakeWorker(() => [200, { found: true, otp: "12 34\n56", receivedAt: Date.now() }]);
    const r = await run(["--since", "1", "--wait", "30"], cfg(w));
    w.close();
    assert.equal(r.code, 3);
    assert.equal(w.seen.length, 1, "no polling after a burned code");
    assert.equal(r.clip, null);
    const out = JSON.parse(r.stdout.trim());
    assert.equal(out.found, false);
    assert.match(out.error, /resend/);
  });

  test("config comes from the env file when the env has none, and the env wins when both exist", async () => {
    const w = await fakeWorker(() => [200, { found: true, otp: CODE, receivedAt: Date.now() }]);
    const first = path.join(TEMP, "env-file-only.env");
    fs.writeFileSync(first, `# comment\nANTIFAN_SECRET_OTP_INBOX_URL=${w.url}/\nANTIFAN_SECRET_OTP_INBOX_KEY="${KEY}"\n`);
    const r = await run(["--since", "1", "--wait", "0"], { OTP_FETCH_ENV_FILE: first });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.clip, CODE);
    assert.equal(w.seen[0].url, "/otp?since=1", "the trailing slash of the URL is dropped");
    assert.equal(w.seen[0].auth, `Bearer ${KEY}`);

    const other = await fakeWorker(() => [200, { found: false }]);
    const r2 = await run(["--since", "1", "--wait", "0"], { OTP_FETCH_ENV_FILE: first, ANTIFAN_SECRET_OTP_INBOX_URL: other.url });
    w.close();
    other.close();
    assert.equal(r2.code, 1);
    assert.equal(other.seen.length, 1, "the env URL won over the file URL");
  });

  test("missing config names the missing keys and sends the worker to the Leader, not to a search (exit 2)", async () => {
    const r = await run(["--since", "1"]);
    assert.equal(r.code, 2);
    const out = JSON.parse(r.stdout.trim());
    assert.match(out.error, /ANTIFAN_SECRET_OTP_INBOX_URL/);
    assert.match(out.error, /ANTIFAN_SECRET_OTP_INBOX_KEY/);
    assert.match(out.error, /tell the Leader/);
    assert.match(out.error, /NEEDS_INPUT/);
    assert.doesNotMatch(out.error, /\.env|%USERPROFILE%|\.antifan|file/i, "the message does not hand the worker a place to look");
  });

  test("--clear overwrites the clipboard with an empty string and needs no config", async () => {
    const clip = path.join(TEMP, "clip-clear.txt");
    fs.writeFileSync(clip, CODE);
    const r = await run(["--clear"], { OTP_FETCH_CLIPBOARD_FILE: clip });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(fs.readFileSync(clip, "utf8"), "");
    assert.deepEqual(JSON.parse(r.stdout.trim()), { cleared: true });
  });

  test("bad arguments exit 2", async () => {
    assert.equal((await run(["--since", "abc"])).code, 2);
    assert.equal((await run(["--wat"])).code, 2);
  });

  // ---- clock skew (review finding 7): t0 is a local clock, receivedAt a Worker clock

  /** A Worker whose clock is local + offsetMs. It honours `since` like the real one: it hands over (and deletes) the first queued code newer than it. */
  async function skewedWorker(offsetMs, queue) {
    return fakeWorker((req) => {
      const since = Number(new URL(req.url, "http://x").searchParams.get("since"));
      const serverNow = Date.now() + offsetMs;
      const i = queue.findIndex((c) => c.receivedAt > since);
      if (i < 0) return [200, { found: false, serverNow }];
      const [c] = queue.splice(i, 1);
      return [200, { found: true, otp: c.otp, receivedAt: c.receivedAt, serverNow }];
    });
  }

  test("a local clock 60 s ahead of the Worker no longer hides a valid code: t0 is converted to the Worker's clock and skewSec is reported", async () => {
    const offset = -60000;
    const w = await skewedWorker(offset, [{ otp: CODE, receivedAt: Date.now() + offset - 3000 }]);
    const r = await run(["--since", String(Date.now() - 10000), "--wait", "10"], cfg(w));
    w.close();
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.clip, CODE);
    const out = JSON.parse(r.stdout.trim());
    assert.equal(out.found, true);
    assert.ok(Math.abs(out.skewSec - -60) <= 2, `skewSec ${out.skewSec}`);
    assert.ok(out.ageSec >= 2 && out.ageSec <= 8, `ageSec ${out.ageSec}`);
    assert.equal(w.seen.length, 2, "one poll to learn the clock, one corrected poll");
    noSecrets(r);
  });

  test("a local clock 60 s behind: a code older than t0 that the Worker still hands over is discarded, the real one is taken", async () => {
    const offset = 60000;
    const STALE = "ZZ9999";
    const nowW = Date.now() + offset;
    const w = await skewedWorker(offset, [
      { otp: STALE, receivedAt: nowW - 30000 }, // newer than the local t0 as a raw number, older than t0 on the Worker's clock
      { otp: CODE, receivedAt: nowW + 500 },
    ]);
    const r = await run(["--since", String(Date.now() - 5000), "--wait", "10"], cfg(w));
    w.close();
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.clip, CODE, "the stale code must never reach the clipboard");
    assert.ok(Math.abs(JSON.parse(r.stdout.trim()).skewSec - 60) <= 2);
    assert.ok(!r.stdout.includes(STALE));
  });

  test("no serverNow in the answer: behaviour is unchanged and no skewSec is printed", async () => {
    const w = await fakeWorker(() => [200, { found: true, otp: CODE, receivedAt: Date.now() }]);
    const r = await run(["--since", "1", "--wait", "5"], cfg(w));
    w.close();
    assert.equal(r.code, 0, r.stderr);
    assert.ok(!("skewSec" in JSON.parse(r.stdout.trim())));
  });

  test("--now prints the local epoch ms to use as t0 and needs no config", async () => {
    const before = Date.now();
    const r = await run(["--now"]);
    assert.equal(r.code, 0, r.stderr);
    const { now } = JSON.parse(r.stdout.trim());
    assert.ok(now >= before && now <= Date.now());
  });

  // ---- https only (review finding 12)

  test("a non-https URL is refused before any request (the Bearer key would travel in clear); loopback http is the test exception", async () => {
    const r = await run(["--since", "1", "--wait", "0"], { ANTIFAN_SECRET_OTP_INBOX_URL: "http://otp-inbox.example.workers.dev", ANTIFAN_SECRET_OTP_INBOX_KEY: KEY });
    assert.equal(r.code, 2);
    assert.match(JSON.parse(r.stdout.trim()).error, /https/);
    assert.equal(r.clip, null);
    noSecrets(r);
    const r2 = await run(["--since", "1", "--wait", "0"], { ANTIFAN_SECRET_OTP_INBOX_URL: "ftp://x.example", ANTIFAN_SECRET_OTP_INBOX_KEY: KEY });
    assert.equal(r2.code, 2);
  });

  // ---- machine-wide login lock (review finding 8)

  describe("login lock", () => {
    const lockEnv = (name) => ({ OTP_FETCH_LOCK_FILE: path.join(TEMP, `${name}.lock`) });
    const out = (r) => JSON.parse(r.stdout.trim());

    test("the first job takes it, another job is told who holds it, the holder may take it again and release it", async () => {
      const env = lockEnv("basic");
      const a = await run(["--lock", "--job", "job-a"], env);
      assert.equal(a.code, 0, a.stderr);
      assert.equal(out(a).acquired, true);
      const b = await run(["--lock", "--job", "job-b"], env);
      assert.equal(b.code, 4);
      assert.equal(out(b).locked, true);
      assert.equal(out(b).holder.job, "job-a");
      assert.equal((await run(["--lock", "--job", "job-a"], env)).code, 0, "the holder may re-take it (a resend)");
      const stolen = await run(["--unlock", "--job", "job-b"], env);
      assert.equal(stolen.code, 4, "another job cannot release it");
      assert.ok(fs.existsSync(env.OTP_FETCH_LOCK_FILE));
      const done = await run(["--unlock", "--job", "job-a"], env);
      assert.equal(done.code, 0);
      assert.ok(!fs.existsSync(env.OTP_FETCH_LOCK_FILE));
      assert.equal((await run(["--lock", "--job", "job-b"], env)).code, 0);
    });

    test("a lock older than 20 minutes is dead and is replaced; one of 11 minutes is still live; releasing when nothing is held succeeds", async () => {
      const live = lockEnv("live11");
      fs.writeFileSync(live.OTP_FETCH_LOCK_FILE, JSON.stringify({ job: "slow-job", pid: 1, at: Date.now() - 11 * 60 * 1000 }));
      const blocked = await run(["--lock", "--job", "job-x"], live, { raw: true });
      assert.equal(blocked.code, 4, "11 minutes is inside the 20 minute expiry");
      assert.equal(out(blocked).holder.job, "slow-job");
      const env = lockEnv("stale");
      fs.writeFileSync(env.OTP_FETCH_LOCK_FILE, JSON.stringify({ job: "dead-job", pid: 1, at: Date.now() - 21 * 60 * 1000 }));
      const r = await run(["--lock", "--job", "job-c"], env, { raw: true });
      assert.equal(r.code, 0, r.stdout);
      assert.equal(JSON.parse(fs.readFileSync(env.OTP_FETCH_LOCK_FILE, "utf8")).job, "job-c");
      assert.equal((await run(["--unlock", "--job", "job-c"], env, { raw: true })).code, 0);
      assert.equal((await run(["--unlock", "--job", "job-c"], env, { raw: true })).code, 0);
    });

    test("six jobs racing for the lock: exactly one wins (atomic create)", async () => {
      const env = lockEnv("race");
      const results = await Promise.all(["j1", "j2", "j3", "j4", "j5", "j6"].map((j) => run(["--lock", "--job", j], env, { raw: true })));
      assert.equal(results.filter((r) => r.code === 0).length, 1, results.map((r) => r.code).join(","));
      assert.equal(results.filter((r) => r.code === 4).length, 5);
    });

    test("six jobs racing to replace an EXPIRED lock: exactly one wins and the winner's lock is never deleted by a loser", async () => {
      for (let round = 0; round < 3; round++) {
        const env = lockEnv(`race-expired-${round}`);
        fs.writeFileSync(env.OTP_FETCH_LOCK_FILE, JSON.stringify({ job: "dead-job", pid: 1, at: Date.now() - 30 * 60 * 1000 }));
        const names = ["k1", "k2", "k3", "k4", "k5", "k6"];
        const results = await Promise.all(names.map((j) => run(["--lock", "--job", j], env, { raw: true })));
        const winners = results.map((r, i) => (r.code === 0 ? names[i] : null)).filter(Boolean);
        assert.equal(winners.length, 1, `round ${round}: ${results.map((r) => r.code).join(",")}`);
        assert.equal(results.filter((r) => r.code === 4).length, 5, `round ${round}`);
        assert.equal(JSON.parse(fs.readFileSync(env.OTP_FETCH_LOCK_FILE, "utf8")).job, winners[0], "the file holds the winner's lock");
      }
    });

    test("--job is required for every lock command and for a read (exit 2); --now and --clear need none", async () => {
      const env = lockEnv("nojob");
      for (const args of [["--lock"], ["--unlock"], ["--renew"], ["--since", "1", "--wait", "0"], []]) {
        const r = await run(args, env, { raw: true });
        assert.equal(r.code, 2, `${args.join(" ")}: ${r.stdout}`);
        assert.match(out(r).error, /--job/);
      }
      assert.ok(!fs.existsSync(env.OTP_FETCH_LOCK_FILE), "an unnamed lock is never created");
      assert.equal((await run(["--now"], env, { raw: true })).code, 0);
      assert.equal((await run(["--clear"], env, { raw: true })).code, 0);
    });

    test("reading a code needs the lock for that job: no lock, another job's lock and an expired own lock all end in exit 4 before any request", async () => {
      const w = await fakeWorker(() => [200, { found: true, otp: CODE, receivedAt: Date.now() }]);
      const env = { ...lockEnv("reader"), ...cfg(w) };
      const none = await run(["--since", "1", "--wait", "0", "--job", "job-r"], env, { raw: true });
      assert.equal(none.code, 4);
      assert.match(out(none).error, /--lock/);
      assert.equal(none.clip, null);
      fs.writeFileSync(env.OTP_FETCH_LOCK_FILE, JSON.stringify({ job: "someone-else", pid: 1, at: Date.now() }));
      const other = await run(["--since", "1", "--wait", "0", "--job", "job-r"], env, { raw: true });
      assert.equal(other.code, 4);
      assert.equal(out(other).locked, true);
      assert.equal(out(other).holder.job, "someone-else");
      fs.writeFileSync(env.OTP_FETCH_LOCK_FILE, JSON.stringify({ job: "job-r", pid: 1, at: Date.now() - 25 * 60 * 1000 }));
      const expired = await run(["--since", "1", "--wait", "0", "--job", "job-r"], env, { raw: true });
      assert.equal(expired.code, 4);
      assert.match(out(expired).error, /--renew/);
      assert.equal(w.seen.length, 0, "no request reached the Worker");
      assert.equal((await run(["--renew", "--job", "job-r"], env, { raw: true })).code, 0);
      const ok = await run(["--since", "1", "--wait", "0", "--job", "job-r"], env, { raw: true });
      w.close();
      assert.equal(ok.code, 0, ok.stdout);
      assert.equal(ok.clip, CODE);
      noSecrets(ok);
    });

    test("--renew restarts the clock of the holder's own lock and refuses another job's lock or no lock", async () => {
      const env = lockEnv("renew");
      fs.writeFileSync(env.OTP_FETCH_LOCK_FILE, JSON.stringify({ job: "job-a", pid: 1, at: Date.now() - 19 * 60 * 1000 }));
      const mine = await run(["--renew", "--job", "job-a"], env, { raw: true });
      assert.equal(mine.code, 0, mine.stdout);
      assert.equal(out(mine).renewed, true);
      assert.ok(Date.now() - JSON.parse(fs.readFileSync(env.OTP_FETCH_LOCK_FILE, "utf8")).at < 60_000, "the lock was written again with a fresh time");
      const other = await run(["--renew", "--job", "job-b"], env, { raw: true });
      assert.equal(other.code, 4);
      assert.equal(out(other).renewed, false);
      assert.equal(JSON.parse(fs.readFileSync(env.OTP_FETCH_LOCK_FILE, "utf8")).job, "job-a", "another job's renew changes nothing");
      assert.equal((await run(["--unlock", "--job", "job-a"], env, { raw: true })).code, 0);
      const none = await run(["--renew", "--job", "job-a"], env, { raw: true });
      assert.equal(none.code, 4, "nothing to renew");
    });
  });
});
