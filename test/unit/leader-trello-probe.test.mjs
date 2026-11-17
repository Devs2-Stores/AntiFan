// probes trello-card and telegram-otp (scripts/leader/probes): masking of secret-shaped text and the OTP-free shape.
// Fake secrets only. The expression is the one `leader-job.mjs probe` prints, run in a vm with a stub page.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as path from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import * as vm from "node:vm";

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "scripts", "leader", "leader-job.mjs");

function expression(name, extra = []) {
  const r = spawnSync(process.execPath, [CLI, "probe", "--name", name, ...extra], { encoding: "utf8", env: { ...process.env, FORCE_COLOR: "0" } });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout.trim().split("\n").at(-1)).expression;
}

const MASK_EXPR = expression("trello-card");
const mask = async (text) => (await vm.runInContext(MASK_EXPR, vm.createContext({ window: { __PROBE_MASK_TEXT: text } }))).masked;

describe("trello-card masking", () => {
  test("a bare token line, a bang password and a labelled value are masked by shape", async () => {
    assert.equal(await mask("Abc@12345xyz"), "[masked:12]");
    assert.equal(await mask("Passw0rd!"), "[masked:9]");
    assert.equal(await mask("mật khẩu: Hello123"), "mật khẩu: [masked:8]");
    assert.equal(await mask("Password Hello123"), "Password [masked:8]");
    assert.equal(await mask("**Pass:** abc"), "**Pass:** [masked:3]");
    assert.equal(await mask("OTP = 123456 | email: hieu.buingoc@haravan.com"), "OTP = [masked:6] | email: hieu.buingoc@haravan.com");
    assert.equal(await mask("- `Abc@12345xyz`"), "- `[masked:12]`");
  });

  test("emails, urls, domains, files, dates, metrics and plain sentences are kept", async () => {
    for (const keep of [
      "atoha.myharavan.com",
      "hieu.buingoc@haravan.com",
      "https://www.atoha.com/",
      "Vui lòng tối ưu PageSpeed cho trang chủ trước 17/11/2026, mục tiêu LCP<2.5s và điểm 90+.",
      "Báo cáo_Final2.pdf 1.500.000đ 2026-11-13 0912.345.678 v1.2.3",
      "Tài khoản Admin: hieu.buingoc@haravan.com",
      "Please pass the test and keep the keyboard",
      "[Trang chủ](https://www.atoha.com/pages/about)",
    ]) {
      assert.equal(await mask(keep), keep, keep);
    }
  });

  test("a label with a word before the colon masks the value after it", async () => {
    assert.equal(await mask("Mật khẩu Admin: Hello123"), "Mật khẩu Admin: [masked:8]");
  });

  test("--copy-secret moves the chosen secret to the clipboard and returns only counts", async () => {
    const written = [];
    const expr = expression("trello-card", ["--copy-secret", "2"]);
    const run = async (text, navigator) => vm.runInContext(expr, vm.createContext({ window: { __PROBE_MASK_TEXT: text }, navigator }));
    const text = "Admin\nuser: hieu.buingoc@haravan.com\nMật khẩu: Hello123\nAbc@12345xyz";
    const ok = await run(text, { clipboard: { writeText: async (v) => void written.push(v) } });
    assert.equal(ok.copy.copied, true);
    assert.equal(ok.copy.index, 2);
    assert.equal(ok.copy.len, 12);
    assert.equal(ok.copy.total, 2);
    assert.equal(JSON.stringify(ok.copy.secrets.map((s) => [s.kind, s.len])), '[["label",8],["bare",12]]');
    assert.deepEqual(written, ["Abc@12345xyz"]);
    assert.ok(!JSON.stringify(ok).includes("Abc@"), "the value never appears in the result");
    assert.ok(!JSON.stringify(ok).includes("Hello123"));
    const refused = await run(text, { clipboard: { writeText: async () => { throw new Error("denied"); } } });
    assert.equal(refused.copy.copied, false);
    assert.match(refused.copy.error, /clipboard refused/);
  });

  test("a masked line keeps its neighbours and reports only the length", async () => {
    const out = await mask("Shop: atoha.myharavan.com\nAbc@12345xyz\nLink https://www.atoha.com/");
    assert.equal(out, "Shop: atoha.myharavan.com\n[masked:12]\nLink https://www.atoha.com/");
    assert.ok(!out.includes("Abc@"));
  });

  test("the expression reads the card back in blocks and masks the description", async () => {
    const el = (props) => props;
    const back = {
      querySelectorAll: () => [],
    };
    const nodes = {
      '[data-testid="card-back-name"]': back,
      '[data-testid="card-back-title-input"]': el({ value: "atoha.myharavan.com" }),
      '[data-testid="due-date-badge-with-date-range-picker"]': el({ innerText: "Nov 17, 4:30 PM" }),
      '[data-testid="description-content-area"]': el({ innerText: "Site: atoha.myharavan.com\nHieu123!x" }),
    };
    const lists = {
      'button[aria-label^="Change list for this card"]': [el({ innerText: "Doing Tài", getAttribute: () => "" })],
      '[data-testid="card-label"]': [el({ innerText: "PageSpeed Services", getAttribute: () => null })],
    };
    const root = {
      querySelector: (s) => nodes[s] ?? null,
      querySelectorAll: (s) => lists[s] ?? [],
    };
    const document = { ...root };
    back.querySelector = root.querySelector;
    back.querySelectorAll = root.querySelectorAll;
    const ctx = vm.createContext({ window: {}, document, location: { href: "https://trello.com/c/AbCdEfGh/1900-atoha?x=1" }, setTimeout });
    const out = await vm.runInContext(MASK_EXPR, ctx);
    assert.equal(out.title, "atoha.myharavan.com");
    assert.equal(out.listName, "Doing Tài");
    assert.deepEqual([...out.labels], ["PageSpeed Services"]);
    assert.equal(out.due, "Nov 17, 4:30 PM");
    assert.equal(out.descriptionMasked, "Site: atoha.myharavan.com\n[masked:9]");
    assert.equal(out.url, "https://trello.com/c/AbCdEfGh/1900-atoha");
    assert.equal(out.shape.description, true);
    assert.equal(out.shape.comments, 0);
  });

  test("a page that is not a card answers with an error instead of waiting", async () => {
    const ctx = vm.createContext({ window: {}, document: {}, location: { href: "https://trello.com/b/x/task" }, setTimeout });
    assert.match((await vm.runInContext(MASK_EXPR, ctx)).error, /not a Trello card/);
  });
});

describe("telegram-otp probe", () => {
  const bubble = (text) => ({ innerText: text });
  const page = (texts) => ({ document: { querySelectorAll: () => texts.map(bubble) } });
  const luc = (ms) => {
    const d = new Date(ms + 7 * 3600 * 1000);
    const p = (n) => String(n).padStart(2, "0");
    return `Lúc: ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())} ${p(d.getUTCDate())}/${p(d.getUTCMonth() + 1)}/${d.getUTCFullYear()}`;
  };
  const msg = (ms, code = "482913", from = "noreply@haravan.com") => `MÃ XÁC THỰC\nBấm để copy: ${code}\nTừ: Haravan <${from}>\n${luc(ms)}`;

  test("reports age, code length and sender, never the digits", async () => {
    const t = Date.now() - 40_000;
    const expr = expression("telegram-otp");
    const out = vm.runInContext(expr, vm.createContext({ window: {}, ...page([msg(t - 600_000, "111111"), msg(t)]) }));
    const o = await out;
    assert.equal(o.topicOpen, true);
    assert.equal(o.count, 2);
    assert.equal(o.newest.len, 6);
    assert.equal(o.newest.fromHaravan, true);
    assert.ok(o.newest.ageSec >= 39 && o.newest.ageSec <= 45, String(o.newest.ageSec));
    assert.ok(!("newerThanSend" in o));
    assert.ok(!JSON.stringify(o).includes("482913"));
  });

  test("--after separates a code sent before the login from one sent after it", async () => {
    const sent = Date.now() - 30_000;
    const run = async (texts) => vm.runInContext(expression("telegram-otp", ["--after", String(sent)]), vm.createContext({ window: {}, ...page(texts) }));
    assert.equal((await run([msg(sent - 120_000)])).newerThanSend, false);
    assert.equal((await run([msg(sent - 120_000), msg(sent + 5_000)])).newerThanSend, true);
    const none = await run([]);
    assert.deepEqual({ open: none.topicOpen, newest: none.newest, count: none.count, newer: none.newerThanSend }, { open: false, newest: null, count: 0, newer: false });
  });
});
