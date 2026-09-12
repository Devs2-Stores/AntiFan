import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { AntiFanMcpClient } from './lib/antifan-mcp-client.mjs';
import { VIEWPORT_TOLERANCE_PX } from './lib/viewport-geometry.mjs';

const VIEWPORTS = [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'mobile', width: 390, height: 844, isMobile: true }
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

async function main() {
  console.log('[START] Initializing AntiFan MCP Client for Chromium Verification...');
  const client = new AntiFanMcpClient();
  await client.connect();

  console.log('[OK] AntiFan MCP connected. Enumerating existing tabs...');
  const tabsRes = await client.callTool('anti.browser.tabs.list', {});
  const existingTabs = JSON.parse(tabsRes.content?.[0]?.text || '[]');
  console.log(`[INFO] Live tabs present: ${existingTabs.length}`);

  // Create dedicated tab for verification
  let targetTabId;
  if (existingTabs.length > 0) {
    targetTabId = existingTabs[0].id;
    console.log(`[INFO] Reusing active tab: ${targetTabId}`);
  } else {
    const newTabRes = await client.callTool('anti.browser.tabs.create', { url: 'about:blank' });
    targetTabId = JSON.parse(newTabRes.content?.[0]?.text || '{}').id;
    console.log(`[INFO] Created new verification tab: ${targetTabId}`);
  }

  const results = [];
  // Historical report reports/chromium-verification/chromium-45-cases-results.json is a frozen
  // evidence artifact (baseline for D9/D10). Runs write into an isolated run directory.
  const runId = `run-${crypto.randomUUID()}`;
  const runTimestamp = new Date().toISOString();
  const reportsDir = path.resolve('reports/runs', runId);
  fs.mkdirSync(reportsDir, { recursive: true });

  console.log(`\nStarting live viewport verification (${ROUTES.length} pages x ${VIEWPORTS.length} viewports) — ${runId}\n`);

  let caseIndex = 0;
  for (const page of ROUTES) {
    const targetUrl = new URL(page.path, 'https://phukienmaymoc.com');
    if (!targetUrl.searchParams.has('themeid')) {
      targetUrl.searchParams.set('themeid', '1001512581');
    }
    const fullUrl = targetUrl.toString();
    
    // Navigate tab once per page
    try {
      await client.callTool('anti.browser.navigate', {
        tabId: targetTabId,
        url: fullUrl
      });
      // Settle wait
      await new Promise(r => setTimeout(r, 1200));
    } catch (e) {
      console.warn(`[WARN] Navigation to ${page.name} failed:`, e.message);
    }

    for (const vp of VIEWPORTS) {
      caseIndex++;
      const caseId = `${page.id}_${vp.name}`;
      
      // Set viewport with fail-closed error handling and real schema arguments
      try {
        await client.callTool('anti.browser.set_viewport', {
          tabId: targetTabId,
          width: vp.width,
          height: vp.height,
          mobile: Boolean(vp.isMobile),
          reload: true
        });
        await new Promise(r => setTimeout(r, 600));
      } catch (e) {
        console.error(`[ERROR] Viewport set failed for ${caseId}:`, e.message);
        throw new Error(`VIEWPORT_SET_FAILED: ${e.message}`);
      }

      // Evaluate page metrics via evaluate tool
      let pageMetrics = null;
      try {
        const evalRes = await client.callTool('anti.browser.evaluate', {
          tabId: targetTabId,
          expression: `JSON.stringify({
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
          })`
        });
        const parsed = JSON.parse(evalRes.content?.[0]?.text || '{}');
        pageMetrics = typeof parsed === 'string' ? JSON.parse(parsed) : parsed;
      } catch (e) {
        pageMetrics = { error: e.message };
      }

      const viewportAttested = pageMetrics && !pageMetrics.error && (
        Math.abs((pageMetrics.innerWidth || 0) - vp.width) <= VIEWPORT_TOLERANCE_PX &&
        Math.abs((pageMetrics.visualViewportWidth || pageMetrics.innerWidth || 0) - vp.width) <= VIEWPORT_TOLERANCE_PX
      );
      const hasNoOverflow = pageMetrics && pageMetrics.docWidth <= (vp.width + VIEWPORT_TOLERANCE_PX);
      const hasFooter = pageMetrics && pageMetrics.hasFooter === true;
      const hasMinHeight = pageMetrics && pageMetrics.docHeight > 300;
      const noLeaks = pageMetrics && (pageMetrics.hoplongLeaksCount ?? 0) === 0;

      let status = 'VERIFIED_PASS';
      if (!pageMetrics || pageMetrics.error) {
        status = 'ERROR';
      } else if (!viewportAttested) {
        status = 'VIEWPORT_NOT_APPLIED';
      } else if (!hasNoOverflow) {
        status = 'FAIL'; // Horizontal overflow is a layout failure
      } else if (!hasFooter || !hasMinHeight || !noLeaks) {
        status = 'DEGRADED';
      }

      const caseRecord = {
        caseIndex,
        caseId,
        pageId: page.id,
        pageName: page.name,
        route: page.path,
        viewport: vp,
        metrics: pageMetrics,
        verifiedStatus: status
      };

      results.push(caseRecord);
      console.log(`[CASE ${String(caseIndex).padStart(2)}/${ROUTES.length * VIEWPORTS.length}] ${caseId.padEnd(28)} | ${status.padEnd(20)} | Width: ${pageMetrics?.innerWidth || 0}px (scroll: ${pageMetrics?.docWidth || 0}px) | Height: ${pageMetrics?.docHeight || 0}px | Title: ${pageMetrics?.title?.slice(0, 30) || 'N/A'}`);
    }
  }

  // Multi-viewport attestation precondition: verify that viewport varied across iterations
  for (const page of ROUTES) {
    const pageCases = results.filter(r => r.pageId === page.id);
    if (pageCases.length === 3) {
      const [c1, c2, c3] = pageCases;
      const staticViewport = (
        c1.metrics?.innerWidth === c2.metrics?.innerWidth &&
        c2.metrics?.innerWidth === c3.metrics?.innerWidth &&
        c1.viewport.width !== c3.viewport.width
      );
      if (staticViewport) {
        for (const c of pageCases) {
          c.verifiedStatus = 'DEGENERATE_VIEWPORT';
        }
      }
    }
  }

  await client.close();

  const passedCount = results.filter(r => r.verifiedStatus === 'VERIFIED_PASS').length;
  const degradedCount = results.filter(r => r.verifiedStatus === 'DEGRADED').length;
  const failedCount = results.filter(r => ['FAIL', 'ERROR', 'VIEWPORT_NOT_APPLIED', 'DEGENERATE_VIEWPORT'].includes(r.verifiedStatus)).length;
  const leakCases = results.filter(r => (r.metrics?.hoplongLeaksCount ?? 0) > 0);
  const total = results.length;
  const summary = {
    runId,
    totalCases: total,
    passedCases: passedCount,
    degradedCases: degradedCount,
    failedCases: failedCount,
    passRate: `${((passedCount / total) * 100).toFixed(1)}%`,
    hoplongLeakCases: leakCases.length,
    store: 'phukienmaymoc.com',
    orgId: '200001207485',
    themeId: '1001512581',
    viewports: VIEWPORTS.map(v => `${v.width}x${v.height}`),
    timestamp: runTimestamp,
    results
  };

  const outputPath = path.join(reportsDir, 'chromium-live-capture-results.json');
  fs.writeFileSync(outputPath, JSON.stringify(summary, null, 2), 'utf8');
  console.log(`\n[COMPLETE] Live capture ${runId}: PASS ${passedCount} | DEGRADED ${degradedCount} | FAIL ${failedCount} / ${total}`);
  console.log(`Hoplong leak cases: ${leakCases.length} / ${total}`);
  console.log(`Saved report to: ${path.relative(process.cwd(), outputPath)}\n`);
}

main().catch(err => {
  console.error('[FATAL]', err);
  process.exit(1);
});
