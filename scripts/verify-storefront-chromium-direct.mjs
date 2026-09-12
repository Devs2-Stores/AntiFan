import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { call, evalOn } from '../.canary/tools/lib-rpc.mjs';
import { VIEWPORT_TOLERANCE_PX } from './lib/viewport-geometry.mjs';

const VIEWPORTS = [
  { name: 'desktop', width: 1440, height: 900, mobile: false },
  { name: 'tablet', width: 768, height: 1024, mobile: false },
  { name: 'mobile', width: 390, height: 844, mobile: true }
];

const ROUTES = [
  { id: 'p01', name: 'Home', path: '/?themeid=1001512581' },
  { id: 'p02', name: 'Collection Cam Bien', path: '/collections/cam-bien?themeid=1001512581' },
  { id: 'p03', name: 'Collection Contactor', path: '/collections/contactor?themeid=1001512581' },
  { id: 'p04', name: 'Brand Inovance', path: '/collections/vendors?q=Inovance&themeid=1001512581' },
  { id: 'p05', name: 'Product LC1D09M7', path: '/products/lc1d09m7?themeid=1001512581' },
  { id: 'p06', name: 'Cart', path: '/cart?themeid=1001512581' },
  { id: 'p07', name: 'Blog News', path: '/blogs/news?themeid=1001512581' },
  { id: 'p08', name: 'Article PLC', path: '/blogs/news/plc-la-gi-cau-tao-nguyen-ly-hoat-dong?themeid=1001512581' },
  { id: 'p09', name: 'Search Laser', path: '/search?q=laser&themeid=1001512581' },
  { id: 'p10', name: 'Page Brands', path: '/pages/brands?themeid=1001512581' },
  { id: 'p11', name: 'Page Quote', path: '/pages/bao-gia?themeid=1001512581' },
  { id: 'p12', name: 'Page Documents', path: '/pages/tai-lieu-ky-thuat?themeid=1001512581' },
  { id: 'p13', name: 'Page About', path: '/pages/gioi-thieu?themeid=1001512581' },
  { id: 'p14', name: 'Page History', path: '/pages/lich-su-phat-trien?themeid=1001512581' },
  { id: 'p15', name: 'Page Careers', path: '/pages/tuyen-dung?themeid=1001512581' }
];

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function main() {
  console.log('[START] Connecting via lib-rpc to AntiFan Control Plane (Port 20131)...');
  const tabs = await call('anti.browser.tabs.list', {});
  console.log(`[OK] Discovered ${tabs.length} tabs.`);

  const tabId = '70a8e41e-09a3-4734-bf6a-457a4c1ef9e7';
  console.log(`[INFO] Targeting established preview tab: ${tabId}`);

  // Historical report reports/chromium-verification/chromium-45-cases-results.json is frozen
  // evidence (baseline for D9/D10); runs write into an isolated run directory.
  const runId = `run-${crypto.randomUUID()}`;
  const runTimestamp = new Date().toISOString();
  const reportsDir = path.resolve('reports/runs', runId);
  fs.mkdirSync(reportsDir, { recursive: true });

  const results = [];
  console.log(`\nStarting live Chromium verification (${ROUTES.length} routes x ${VIEWPORTS.length} viewports)...\n`);

  let index = 0;
  for (const route of ROUTES) {
    const targetUrl = new URL(route.path, 'https://phukienmaymoc.com');
    if (!targetUrl.searchParams.has('themeid')) {
      targetUrl.searchParams.set('themeid', '1001512581');
    }
    const fullUrl = targetUrl.toString();

    // Navigate once per route
    try {
      await call('anti.browser.navigate', {
        tabId,
        url: fullUrl
      }, 60_000);
      await sleep(1500); // Settle
    } catch (e) {
      console.warn(`[WARN] Navigation failed for ${route.name}:`, e.message);
    }

    for (const vp of VIEWPORTS) {
      index++;
      const caseId = `${route.id}_${vp.name}`;

      // Set viewport with fail-closed error handling and real schema arguments
      try {
        await call('anti.browser.set_viewport', {
          tabId,
          width: vp.width,
          height: vp.height,
          mobile: Boolean(vp.mobile),
          reload: true
        }, 30_000);
        await sleep(800);
      } catch (e) {
        console.error(`[ERROR] Viewport set failed for ${caseId}:`, e.message);
        throw new Error(`VIEWPORT_SET_FAILED: ${e.message}`);
      }

      // Evaluate DOM metrics under this viewport condition
      let metrics = null;
      try {
        const expr = `JSON.stringify({
          title: document.title,
          docHeight: document.documentElement.scrollHeight,
          docWidth: document.documentElement.scrollWidth,
          innerWidth: window.innerWidth,
          visualViewportWidth: window.visualViewport ? window.visualViewport.width : window.innerWidth,
          clientWidth: document.documentElement.clientWidth,
          dpr: window.devicePixelRatio,
          bodyChildren: document.body.children.length,
          hasHeader: Boolean(document.querySelector('header, .header, #header, .header-desktop, .site-header')),
          hasFooter: Boolean(document.querySelector('footer, .footer, #footer, .site-footer')),
          hasContent: Boolean(document.querySelector('main, .main, #main, .content, .container')),
          textLength: document.body.innerText ? document.body.innerText.length : 0,
          hoplongLeaksCount: document.querySelectorAll('a[href*="hoplongtech.com"], a[href*="hoplong.com"], img[src*="hoplongtech.com"]').length
        })`;
        const raw = await evalOn(tabId, expr, 15_000);
        metrics = JSON.parse(raw);
      } catch (e) {
        metrics = { error: e.message };
      }

      const viewportAttested = metrics && !metrics.error && (
        Math.abs((metrics.innerWidth || 0) - vp.width) <= VIEWPORT_TOLERANCE_PX &&
        Math.abs((metrics.visualViewportWidth || metrics.innerWidth || 0) - vp.width) <= VIEWPORT_TOLERANCE_PX
      );
      const hasNoOverflow = metrics && metrics.docWidth <= (vp.width + VIEWPORT_TOLERANCE_PX);
      const hasFooter = metrics && metrics.hasFooter === true;
      const hasMinHeight = metrics && metrics.docHeight > 300;
      const noLeaks = metrics && (metrics.hoplongLeaksCount ?? 0) === 0;

      let status = 'VERIFIED_PASS';
      if (!metrics || metrics.error) {
        status = 'ERROR';
      } else if (!viewportAttested) {
        status = 'VIEWPORT_NOT_APPLIED';
      } else if (!hasNoOverflow) {
        status = 'FAIL'; // Horizontal overflow is a layout failure
      } else if (!hasFooter || !hasMinHeight || !noLeaks) {
        status = 'DEGRADED';
      }

      const caseRecord = {
        caseIndex: index,
        caseId,
        pageId: route.id,
        pageName: route.name,
        url: fullUrl,
        viewport: vp,
        metrics,
        status
      };

      results.push(caseRecord);
      const title = metrics?.title ? metrics.title.slice(0, 28) : 'N/A';
      console.log(`[${String(index).padStart(2)}/${ROUTES.length * VIEWPORTS.length}] ${caseId.padEnd(24)} | ${status.padEnd(20)} | Width: ${metrics?.innerWidth || 0}px (scroll: ${metrics?.docWidth || 0}px) | Height: ${String(metrics?.docHeight || 0).padStart(5)}px | Leaks: ${metrics?.hoplongLeaksCount ?? 'ERR'} | Title: ${title}`);
    }
  }

  // Multi-viewport attestation precondition: verify that viewport varied across iterations
  for (const route of ROUTES) {
    const pageCases = results.filter(r => r.pageId === route.id);
    if (pageCases.length === 3) {
      const [c1, c2, c3] = pageCases;
      const staticViewport = (
        c1.metrics?.innerWidth === c2.metrics?.innerWidth &&
        c2.metrics?.innerWidth === c3.metrics?.innerWidth &&
        c1.viewport.width !== c3.viewport.width
      );
      if (staticViewport) {
        for (const c of pageCases) {
          c.status = 'DEGENERATE_VIEWPORT';
        }
      }
    }
  }

  const passCount = results.filter(r => r.status === 'VERIFIED_PASS').length;
  const degradedCount = results.filter(r => r.status === 'DEGRADED').length;
  const failCount = results.filter(r => ['FAIL', 'ERROR', 'VIEWPORT_NOT_APPLIED', 'DEGENERATE_VIEWPORT'].includes(r.status)).length;
  const leakCases = results.filter(r => (r.metrics?.hoplongLeaksCount ?? 0) > 0);
  const total = results.length;
  const summary = {
    runId,
    totalCases: total,
    passedCases: passCount,
    degradedCases: degradedCount,
    failedCases: failCount,
    passRate: `${((passCount / total) * 100).toFixed(1)}%`,
    hoplongLeakCases: leakCases.length,
    targetThemeId: 1001512581,
    verifiedStore: 'phukienmaymoc.com',
    orgId: '200001207485',
    viewports: VIEWPORTS.map(v => `${v.width}x${v.height}`),
    timestamp: runTimestamp,
    results
  };

  const outputPath = path.join(reportsDir, 'chromium-live-capture-results.json');
  fs.writeFileSync(outputPath, JSON.stringify(summary, null, 2), 'utf8');
  console.log(`\n================ CHROMIUM VERIFICATION SUMMARY ================`);
  console.log(`Run: ${runId}`);
  console.log(`Total Cases: ${total}`);
  console.log(`PASS ${passCount} | DEGRADED ${degradedCount} | FAIL ${failCount} (${summary.passRate} pass rate)`);
  console.log(`Hoplong leak cases: ${leakCases.length} / ${total}`);
  console.log(`Report Saved: ${path.relative(process.cwd(), outputPath)}`);
  console.log(`===============================================================\n`);
}

main().catch(err => {
  console.error('[FATAL]', err);
  process.exit(1);
});
