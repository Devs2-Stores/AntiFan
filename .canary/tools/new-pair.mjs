/**
 * Open a fresh reference/clone tab pair for an isolated viewport run.
 *   node .canary/tools/new-pair.mjs [cloneUrl]
 * Prints { refTabId, cloneTabId }.
 */
import { call } from './lib-rpc.mjs';

const cloneUrl = process.argv[2] || 'http://127.0.0.1:7852/';
const REF = 'https://hoplongtech.com/';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function openTab(url) {
  const r = await call('browser.open-tab', { url, activate: false });
  const id = r.tabId || r.result?.tabId || r.result;
  if (!id || typeof id !== 'string') throw new Error('open-tab returned no tabId: ' + JSON.stringify(r).slice(0, 300));
  return id;
}

async function waitLoad(tabId, urlPart) {
  const deadline = Date.now() + 60000;
  for (;;) {
    const st = await call('anti.browser.evaluate', {
      tabId,
      expression: '({ href: location.href, ready: document.readyState, h: Math.max(document.documentElement.scrollHeight, document.body.scrollHeight) })',
    }).catch(() => null);
    const v = st?.result || st;
    if (v && typeof v.href === 'string' && v.href.includes(urlPart) && v.ready === 'complete' && v.h > 100) return v;
    if (Date.now() > deadline) throw new Error('timeout waiting for ' + urlPart + ' on ' + tabId + ': ' + JSON.stringify(v));
    await sleep(700);
  }
}

const refTabId = await openTab(REF);
await waitLoad(refTabId, 'hoplongtech.com');
const cloneTabId = await openTab(cloneUrl);
await waitLoad(cloneTabId, '127.0.0.1');
await sleep(1500);
console.log(JSON.stringify({ refTabId, cloneTabId }));
