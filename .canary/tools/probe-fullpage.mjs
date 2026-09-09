/** Diagnostic probe: raw JSON for viewport/full-page/compare captures on a controlled tab. */
import { call, evalOn } from './canary-client.mjs';

const URL = process.argv[2] || 'http://127.0.0.1:7854/probe-930.html';
const open = await call('browser.open-tab', { url: URL, activate: false }, 60_000);
const tabId = open.tabId || open.result?.tabId;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
for (let i = 0; i < 40; i++) {
  const st = await evalOn(tabId, 'document.readyState').catch(() => null);
  if (st === 'complete') break;
  await sleep(300);
}
await call('browser.set-viewport', { tabId, width: 1440, height: 900, mobile: false, deviceScaleFactor: 1, reload: true }, 60_000);
for (let i = 0; i < 40; i++) {
  const st = await evalOn(tabId, 'document.readyState').catch(() => null);
  if (st === 'complete') break;
  await sleep(300);
}
const geom = await evalOn(tabId, '({ docH: document.documentElement.scrollHeight, bodyH: document.body.scrollHeight, vh: window.innerHeight, dpr: devicePixelRatio, iw: window.innerWidth })');
console.log('GEOM', JSON.stringify(geom));

const show = (label, v) => console.log(label, JSON.stringify(v).slice(0, 1500));
try { show('VIEWPORT', await call('anti.screenshot.viewport', { tabId, format: 'png' }, 60_000)); } catch (e) { show('VIEWPORT_ERR', { code: e.code, message: e.message, details: e.details }); }
try { show('FULLPAGE', await call('anti.screenshot.full_page', { tabId }, 120_000)); } catch (e) { show('FULLPAGE_ERR', { code: e.code, message: e.message, details: e.details }); }
try { show('COMPARE_FULL', await call('anti.visual.compare', { tabId, comparisonTabId: tabId, fullPage: true, tolerance: 2, normalizeScroll: true, allowHeightDrift: false, useDefaultWidgetMasks: false }, 180_000)); } catch (e) { show('COMPARE_FULL_ERR', { code: e.code, message: e.message, details: e.details }); }
await call('anti.browser.tabs.close', { tabId }, 30_000);
