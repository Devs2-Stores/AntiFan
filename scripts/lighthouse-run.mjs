// Child process behind `anti.perf.lighthouse`. Reads a job file (path in argv[2]):
//   { lighthouseDir, url, formFactor, categories, outPath, cookies, timeoutMs }
// launches a throw-away headless Chrome, installs the cookies through CDP, runs Lighthouse
// on a page of that Chrome and writes the full JSON report to outPath.
// Stdout carries one JSON line: {ok:true,...} or {ok:false,code,message}. Cookie values are
// never printed. Runs under system Node (Lighthouse 13 needs Node >= 22.19, newer than Electron's).
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const emit = (value) => { process.stdout.write(`${JSON.stringify(value)}\n`); };

function packageDir(nm, name) {
  const nested = path.join(nm, 'lighthouse', 'node_modules', name);
  if (fs.existsSync(path.join(nested, 'package.json'))) return nested;
  const top = path.join(nm, name);
  if (fs.existsSync(path.join(top, 'package.json'))) return top;
  throw Object.assign(new Error(`package ${name} not found under ${nm}`), { code: 'LIGHTHOUSE_NOT_INSTALLED' });
}

function packageEntry(dir) {
  const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
  let entry = pkg.exports && typeof pkg.exports === 'object' && pkg.exports['.'] ? pkg.exports['.'] : pkg.exports;
  while (entry && typeof entry === 'object') entry = entry.import ?? entry.node ?? entry.default;
  return pathToFileURL(path.join(dir, typeof entry === 'string' ? entry : (pkg.module || pkg.main || 'index.js'))).href;
}

const SAME_SITE = { no_restriction: 'None', lax: 'Lax', strict: 'Strict' };

function toCdpCookie(cookie) {
  const out = { name: cookie.name, value: cookie.value, domain: cookie.domain, path: cookie.path || '/' };
  if (cookie.secure) out.secure = true;
  if (cookie.httpOnly) out.httpOnly = true;
  if (SAME_SITE[cookie.sameSite]) out.sameSite = SAME_SITE[cookie.sameSite];
  if (typeof cookie.expirationDate === 'number' && cookie.expirationDate > 0) out.expires = cookie.expirationDate;
  return out;
}

let chrome;
let browser;
let finished = false;
async function cleanup() {
  try { await browser?.disconnect?.(); } catch { /* best effort */ }
  try { await chrome?.kill?.(); } catch { /* best effort */ }
}

async function main() {
  const job = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
  const deadline = setTimeout(async () => {
    if (finished) return;
    finished = true;
    emit({ ok: false, code: 'LIGHTHOUSE_TIMEOUT', message: `Lighthouse did not finish within ${job.timeoutMs} ms` });
    await cleanup();
    process.exit(3);
  }, Math.max(5000, job.timeoutMs - 3000));

  const nm = job.lighthouseDir;
  const lighthouseEntry = packageEntry(path.join(nm, 'lighthouse'));
  const lighthouse = (await import(lighthouseEntry)).default;
  const { launch } = await import(packageEntry(packageDir(nm, 'chrome-launcher')));
  const puppeteer = await import(packageEntry(packageDir(nm, 'puppeteer-core')));
  const connect = puppeteer.connect ?? puppeteer.default?.connect;

  chrome = await launch({ chromeFlags: ['--headless=new', '--disable-gpu'], logLevel: 'silent' });
  browser = await connect({ browserURL: `http://127.0.0.1:${chrome.port}`, defaultViewport: null });
  const page = await browser.newPage();
  if (job.cookies.length) {
    const session = await page.createCDPSession();
    await session.send('Network.setCookies', { cookies: job.cookies.map(toCdpCookie) });
  }

  let config;
  if (job.formFactor === 'desktop') {
    config = (await import(pathToFileURL(path.join(nm, 'lighthouse', 'core', 'config', 'desktop-config.js')).href)).default;
  }
  const flags = {
    output: 'json',
    logLevel: 'error',
    onlyCategories: job.categories,
    formFactor: job.formFactor,
    disableStorageReset: true,
  };
  const result = await lighthouse(job.url, flags, config, page);
  if (!result || typeof result.report !== 'string') throw Object.assign(new Error('Lighthouse returned no report'), { code: 'LIGHTHOUSE_NO_REPORT' });
  fs.mkdirSync(path.dirname(job.outPath), { recursive: true });
  fs.writeFileSync(job.outPath, result.report, { flag: 'wx' });
  clearTimeout(deadline);
  finished = true;
  emit({ ok: true, outPath: job.outPath, bytes: Buffer.byteLength(result.report) });
  await cleanup();
  process.exit(0);
}

main().catch(async (err) => {
  if (finished) return;
  finished = true;
  emit({ ok: false, code: err?.code || 'LIGHTHOUSE_FAILED', message: String(err?.message || err).slice(0, 500) });
  await cleanup();
  process.exit(2);
});
