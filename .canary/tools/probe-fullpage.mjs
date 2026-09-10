/**
 * Isolation probe for the canonical full-page capture path.
 *
 * Answers one question with timing evidence: does `anti.screenshot.full_page`
 * complete on the live reference tab after the canonical settle contract, and
 * does a repeat on the same tab behave the same way? A first-attempt timeout
 * followed by success would prove the bound/surface interaction is the variable;
 * a repeatable timeout proves the page or the surface is the cause.
 */
import fs from 'node:fs';
import path from 'node:path';
import { call, evalOn } from './lib-rpc.mjs';
import { settleAndMeasure, CARD_SELECTOR } from './canary-settle.mjs';

const REF_URL = process.env.CANARY_REF_URL || 'https://hoplongtech.com/';
const OUT = path.resolve('.canary/state/probe-fullpage.json');
const WIDTH = Number(process.env.PROBE_WIDTH || 1440);
const HEIGHT = Number(process.env.PROBE_HEIGHT || 900);
const ATTEMPTS = Number(process.env.PROBE_ATTEMPTS || 3);

const log = (m) => console.log(`[probe] ${m}`);
const record = { url: REF_URL, viewport: { width: WIDTH, height: HEIGHT }, attempts: [] };

const created = await call('anti.browser.tabs.create', { url: REF_URL, activate: true }, 60_000);
const tabId = created.tabId || created.result?.tabId;
record.tabId = tabId;
log(`tab ${tabId}`);

await call('browser.switch-tab', { tabId }, 30_000).catch(() => null);
await call('browser.set-viewport', {
  tabId,
  width: WIDTH,
  height: HEIGHT,
  mobile: WIDTH < 768,
  deviceScaleFactor: 1,
  reload: true,
});

const settlePasses = [];
for (let pass = 1; pass <= 3; pass++) {
  const r = await settleAndMeasure(tabId, `probe-pass${pass}`);
  const s = r.settle || {};
  const row = {
    pass,
    mediaFrozen: s.mediaFrozen === true,
    fontsSettled: s.fontsSettled === true,
    imagesSettled: s.imagesSettled === true,
    domSettled: s.domSettled === true,
    visualStable: s.visualStable === true,
    timedOut: s.timedOut,
    readyState: s.readyState,
    fontsStatus: s.fontsStatus,
    pendingImages: s.pendingImages,
    imageCount: s.imageCount,
    brokenImages: (s.brokenImages || []).length,
    structuralMutations: s.structuralMutations,
    sectionCount: r.metrics?.sectionCount,
    productCardCount: r.metrics?.productCardCount,
    docHeight: r.metrics?.docHeight,
    phases: s.phases,
  };
  settlePasses.push(row);
  log(`pass ${pass}: frozen=${row.mediaFrozen} fonts=${row.fontsSettled} images=${row.imagesSettled} dom=${row.domSettled} visual=${row.visualStable} rs=${row.readyState} pending=${row.pendingImages} mut=${row.structuralMutations} ${row.sectionCount}/${row.productCardCount}`);
  fs.writeFileSync(OUT, JSON.stringify({ ...record, settlePasses }, null, 2));
}
record.settlePasses = settlePasses;
const settled = { settle: settlePasses[settlePasses.length - 1], metrics: { sectionCount: settlePasses[settlePasses.length - 1].sectionCount, productCardCount: settlePasses[settlePasses.length - 1].productCardCount } };
const dom = await evalOn(tabId, `({
  sectionCount: document.querySelectorAll('section').length,
  cardCount: document.querySelectorAll('${CARD_SELECTOR}').length,
  docHeight: Math.max(document.documentElement.scrollHeight, document.body.scrollHeight),
  readyState: document.readyState,
})`, 15000);
record.settled = { settle: settled.settle, metrics: settled.metrics };
record.dom = dom;
log(`settled visualStable=${settled.settle?.visualStable} dom=${dom.sectionCount}/${dom.cardCount} h=${dom.docHeight} rs=${dom.readyState}`);

for (let i = 1; i <= ATTEMPTS; i++) {
  const startedAt = Date.now();
  const attempt = { attempt: i, startedAt };
  try {
    const res = await call('anti.screenshot.full_page', { tabId }, 240_000);
    attempt.status = 'CAPTURED';
    attempt.elapsedMs = Date.now() - startedAt;
    attempt.receipt = res?.receipt || res?.captureReceipt || null;
    attempt.byteLength = res?.byteLength ?? null;
    attempt.artifactId = res?.artifactRef?.id || res?.artifactId || res?.artifactRef || null;
    log(`attempt ${i}: CAPTURED in ${attempt.elapsedMs}ms raster=${attempt.receipt?.rasterSize?.width}x${attempt.receipt?.rasterSize?.height} bytes=${attempt.byteLength}`);
    if (attempt.byteLength && attempt.receipt) {
      const file = path.resolve(`.canary/state/probe-fullpage-attempt-${i}.png`);
      const fetched = await call('artifact.read', { artifactId: attempt.artifactId, offset: 0, limit: attempt.byteLength }, 60_000).catch((e) => ({ error: e.message }));
      fs.writeFileSync(file, JSON.stringify(fetched).slice(0, 400));
    }
  } catch (e) {
    attempt.status = 'ERROR';
    attempt.elapsedMs = Date.now() - startedAt;
    attempt.error = String(e.message || e).slice(0, 500);
    log(`attempt ${i}: ERROR after ${attempt.elapsedMs}ms — ${attempt.error.slice(0, 220)}`);
  }
  record.attempts.push(attempt);
  // Re-check that the tab still answers between attempts; a lost target is a
  // different failure from a capture that never settles.
  try {
    record.attempts[record.attempts.length - 1].tabAlive = await evalOn(tabId, '1', 5000) === 1;
  } catch (e) {
    record.attempts[record.attempts.length - 1].tabAlive = false;
    record.attempts[record.attempts.length - 1].tabAliveError = String(e.message || e).slice(0, 200);
  }
}

fs.writeFileSync(OUT, JSON.stringify(record, null, 2));
log(`written ${OUT}`);
process.exit(0);
