/**
 * Drives a reference tab to a deterministic, fully-hydrated, media-frozen state
 * and returns a structural fingerprint. Usage: node prepare-ref.mjs <tabId> [label]
 */
import { call, evalOn } from './lib-rpc.mjs';

const tabId = process.argv[2];
const label = process.argv[3] || tabId;
if (!tabId) { console.error('usage: prepare-ref.mjs <tabId> [label]'); process.exit(2); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const HYD_SINGLE_PASS = `(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const H = Math.max(document.documentElement.scrollHeight, document.body.scrollHeight);
  for (let y = 0; y <= H; y += 600) { window.scrollTo({ top: y, left: 0, behavior: 'instant' }); await sleep(60); }
  window.scrollTo({ top: H, left: 0, behavior: 'instant' });
  await sleep(400);
  const sections = Array.from(document.querySelectorAll('section')).map((s) => (typeof s.className === 'string' ? s.className : ''));
  const productCards = document.querySelectorAll('.product-list__item, .product-item, .product-card').length;
  const blockCategories = document.querySelectorAll('.block-category').length;
  const imgs = document.images.length;
  const pending = Array.from(document.images).filter((i) => !i.complete).length;
  const broken = Array.from(document.images).filter((i) => i.complete && i.naturalWidth === 0).length;
  const sig = sections.join('|') + '@' + H + '@' + productCards + '@' + imgs;
  return {
    docH: H,
    docW: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
    innerHeight: window.innerHeight,
    sections,
    productCards,
    blockCategories,
    imgs,
    pending,
    broken,
    fonts: document.fonts ? document.fonts.status : 'unknown',
    sig,
  };
})()`;

// 0. establish a real layout viewport: a never-foregrounded tab reports
// innerHeight=0 and hydrates against a zero-height viewport.
await call('browser.switch-tab', { tabId }, 30000).catch((e) => console.error(`activate warning: ${e.message}`));
// 1. reload
await call('anti.browser.reload', { tabId }, 60000);
for (let i = 0; i < 60; i++) {
  await sleep(500);
  try {
    const r = await evalOn(tabId, '({ rs: document.readyState, h: document.documentElement.scrollHeight, n: document.querySelectorAll("section").length })', 10000);
    if (r && r.rs === 'complete' && r.h > 1000) break;
  } catch {}
}
// 2. hydrate in host-driven bounded passes (each pass <= 2s, well below 15s bridge ceiling)
let lastSig = '';
let stable = 0;
let iters = 0;
let lastResult = null;
for (; iters < 30 && stable < 4; iters++) {
  const res = await evalOn(tabId, HYD_SINGLE_PASS, 12000).catch((e) => ({ error: String(e.message || e).slice(0, 300) }));
  if (res && res.sig) {
    if (res.sig === lastSig) {
      stable++;
    } else {
      stable = 0;
    }
    lastSig = res.sig;
    lastResult = res;
  }
  await sleep(200);
}
if (stable < 3 || !lastResult || (lastResult.sections?.length || 0) < 5) {
  throw new Error(`hydration never stabilized (iters=${iters} stable=${stable} sections=${lastResult?.sections?.length ?? 0} cards=${lastResult?.productCards ?? 0} h=${lastResult?.docH ?? 0})`);
}
await evalOn(tabId, `(async () => {
  window.scrollTo({ top: 0, left: 0, behavior: 'instant' });
  await new Promise((r) => setTimeout(r, 400));
  return true;
})()`, 5000).catch(() => null);
const hydro = {
  iters,
  stable,
  ...(lastResult || {}),
};
// 3. freeze media
let freeze = null;
try { freeze = await call('anti.media.freeze', { tabId, freeze: true }, 60000); } catch (e) { freeze = { error: String(e.message).slice(0, 200) }; }
// 4. fingerprint after freeze
await sleep(800);
const fp = await evalOn(tabId, `({
  docH: document.documentElement.scrollHeight,
  docW: document.documentElement.scrollWidth,
  innerWidth: window.innerWidth,
  innerHeight: window.innerHeight,
  sections: Array.from(document.querySelectorAll('section')).map(s => (typeof s.className === 'string' ? s.className : '')),
  productCards: document.querySelectorAll('.product-list__item').length,
  imgs: document.images.length,
  pending: Array.from(document.images).filter(i => !i.complete).length,
  broken: Array.from(document.images).filter(i => i.complete && i.naturalWidth === 0).length,
  scrollY: window.scrollY,
})`, 60000);

console.log(JSON.stringify({ label, tabId, hydro, freeze, fingerprint: fp }, null, 2));
