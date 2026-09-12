import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { call } from '../.canary/tools/lib-rpc.mjs';

const IMAGE_HYDRATION_EXPR = `(async () => {
  document.querySelectorAll('img[loading="lazy"]').forEach(img => {
    try { img.loading = 'eager'; } catch {}
  });
  document.querySelectorAll('img[data-src], img[data-srcset], img[data-lazy], img[data-original], img[data-echo]').forEach(img => {
    const declaredSrc = img.getAttribute('data-src') || img.getAttribute('data-lazy') || img.getAttribute('data-original') || img.getAttribute('data-echo');
    const declaredSet = img.getAttribute('data-srcset');
    const declaredSizes = img.getAttribute('data-sizes');
    try {
      if (declaredSrc && img.getAttribute('src') !== declaredSrc) img.setAttribute('src', declaredSrc);
      if (declaredSet && img.getAttribute('srcset') !== declaredSet) img.setAttribute('srcset', declaredSet);
      if (declaredSizes && declaredSizes !== 'auto' && img.getAttribute('sizes') !== declaredSizes) img.setAttribute('sizes', declaredSizes);
      if (img.classList) img.classList.remove('lazyload', 'lazyloading');
    } catch {}
  });
  await Promise.all(
    Array.from(document.images)
      .filter(i => !i.complete)
      .map(i => new Promise(resolve => {
        i.addEventListener('load', resolve, { once: true });
        i.addEventListener('error', resolve, { once: true });
        setTimeout(resolve, 6000);
      }))
  );
  window.scrollTo(0, 0);
  return { images: document.images.length, completed: Array.from(document.images).filter(i => i.complete).length };
})()`;

function startStaticServer(filePath, port) {
  const content = fs.readFileSync(filePath);
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(content);
  });
  return new Promise(resolve => {
    server.listen(port, '127.0.0.1', () => {
      console.log(`[SERVER] Serving ${filePath} at http://127.0.0.1:${port}/`);
      resolve(server);
    });
  });
}

async function main() {
  const PORT = 7865;
  const refFile = path.resolve('.canary/15-pages/page-01-home/reference/reference.html');
  const server = await startStaticServer(refFile, PORT);

  const refUrl = `http://127.0.0.1:${PORT}/`;
  const storefrontUrl = 'https://phukienmaymoc.com/?preview_theme_id=1001512581';

  console.log('[1] Creating Reference Tab...');
  const refTabRes = await call('anti.browser.tabs.create', { url: refUrl, activate: true }, 60_000);
  const refTabId = refTabRes?.tabId || refTabRes?.result?.tabId;
  console.log('    Ref Tab ID:', refTabId);

  console.log('[2] Creating Storefront Tab...');
  const storeTabRes = await call('anti.browser.tabs.create', { url: storefrontUrl, activate: false }, 60_000);
  const storeTabId = storeTabRes?.tabId || storeTabRes?.result?.tabId;
  console.log('    Storefront Tab ID:', storeTabId);

  console.log('[3] Setting Viewport 1440x900 on both tabs...');
  await call('anti.browser.set_viewport', { tabId: refTabId, width: 1440, height: 900, mobile: false });
  await call('anti.browser.set_viewport', { tabId: storeTabId, width: 1440, height: 900, mobile: false });

  console.log('[4] Hydrating images on both tabs...');
  const refHydrate = await call('anti.browser.evaluate', { tabId: refTabId, expression: IMAGE_HYDRATION_EXPR }).catch(e => ({ error: e.message }));
  console.log('    Ref Hydrate:', refHydrate);
  const storeHydrate = await call('anti.browser.evaluate', { tabId: storeTabId, expression: IMAGE_HYDRATION_EXPR }).catch(e => ({ error: e.message }));
  console.log('    Storefront Hydrate:', storeHydrate);

  console.log('[5] Freezing animations on both tabs...');
  await call('anti.media.freeze', { tabId: refTabId, freeze: true }).catch(() => null);
  await call('anti.media.freeze', { tabId: storeTabId, freeze: true }).catch(() => null);

  await new Promise(r => setTimeout(r, 2000));

  console.log('[6] Calling anti.visual.compare...');
  try {
    const compareRes = await call('anti.visual.compare', {
      tabId: refTabId,
      comparisonTabId: storeTabId,
      tolerance: 2,
      normalizeScroll: true,
      fullPage: false,
      useDefaultWidgetMasks: true
    }, 60_000);

    console.log('[RESULT] Compare Response:', JSON.stringify(compareRes, null, 2));
  } catch (err) {
    console.error('[ERROR] Compare failed:', err);
  } finally {
    console.log('[CLEANUP] Closing tabs...');
    await call('anti.browser.tabs.close', { tabId: refTabId }).catch(() => null);
    await call('anti.browser.tabs.close', { tabId: storeTabId }).catch(() => null);
    server.close();
  }
}

main().catch(console.error);
