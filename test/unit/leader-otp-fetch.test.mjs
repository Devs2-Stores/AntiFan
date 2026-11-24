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

/** Run the script; resolves {code, stdout, stderr, clip}. `clip` is what the clipboard seam received (null when untouched). */
function run(args, env = {}) {
  const clipFile = path.join(TEMP, `clip-${++seq}.txt`);
  const envFile = path.join(TEMP, `env-${seq}.env`);
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SCRIPT, ...args], {
      env: { ...process.env, ANTIFAN_SECRET_OTP_INBOX_URL: "", ANTIFAN_SECRET_OTP_INBOX_KEY: "", OTP_FETCH_ENV_FILE: envFile, OTP_FETCH_CLIPBOARD_FILE: clipFile, OTP_FETCH_POLL_MS: "50", ...env },
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

  test("missing config names the missing keys only (exit 2)", async () => {
    const r = await run(["--since", "1"]);
    assert.equal(r.code, 2);
    const out = JSON.parse(r.stdout.trim());
    assert.match(out.error, /ANTIFAN_SECRET_OTP_INBOX_URL/);
    assert.match(out.error, /ANTIFAN_SECRET_OTP_INBOX_KEY/);
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
});
