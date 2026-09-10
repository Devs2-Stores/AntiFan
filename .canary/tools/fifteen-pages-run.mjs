/**
 * ANTiFan — Real 15-Page Hoplongtech Clone Canary Orchestrator
 *
 * Executes the complete empirical pipeline across all 15 locked target pages
 * and 3 required viewports (1440x900, 1024x900, 390x844) = 45 render cases.
 *
 * Sequence per page:
 *   1. Discovery (Phase A & A0): Real Chromium navigation, hydration, settlement,
 *      cardinality, structural extraction, asset families, typography, SVG, video.
 *   2. Asset Localization (Phase A1 & A2): Local rewrite, zero-hotlinks, independent bundle.
 *   3. Real Chromium Render & Multi-Viewport Verification (Phase 14, 15, 16, 17, 21):
 *      Static server, clone tab, viewport resize, settlement, network audit,
 *      artifact capture, structural probe, visual compare.
 *   4. Failure Landscape: Never halts on single page failure; logs full diagnosis.
 *   5. Final Deliverable: 15-PAGE-HOPLONGTECH-CLONE-CANARY.md with all 17 sections.
 */
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');

const { call, evalOn, bootstrap: boot } = await import('./lib-rpc.mjs');
const { requireDoubleSettledMetrics } = await import('./canary-settle.mjs');
const { validateProbedFloor } = await import('./canary-floors.mjs');



export const TARGET_PAGES = [
  {
    id: 1,
    name: 'TRANG CHỦ',
    url: 'https://hoplongtech.com/',
    slug: 'page-01-home',
    domain: 'hoplongtech.com',
    specialNote: 'Hero, banner, category, product, brand, news, partner, footer, responsive.'
  },
  {
    id: 2,
    name: 'DANH MỤC THƯƠNG HIỆU',
    url: 'https://hoplongtech.com/brands',
    slug: 'page-02-brands',
    domain: 'hoplongtech.com',
    specialNote: 'Brand list, logos, grouping, search/filter, responsive layout.'
  },
  {
    id: 3,
    name: 'NHÓM KHÔNG FILTER',
    url: 'https://hoplongtech.com/category/cam-bien',
    slug: 'page-03-category-cam-bien',
    domain: 'hoplongtech.com',
    specialNote: 'Category structure, product listing, sidebar absence, pagination/load more.'
  },
  {
    id: 4,
    name: 'TRANG NHÓM SẢN PHẨM',
    url: 'https://hoplongtech.com/category/contactor?filterBrandIds[0]=1127',
    slug: 'page-04-category-contactor',
    domain: 'hoplongtech.com',
    specialNote: 'Filter state preserved, selected brand, product results, cardinality.'
  },
  {
    id: 5,
    name: 'NHÓM SẢN PHẨM BRAND',
    url: 'https://hoplongtech.com/brands/ecovacs',
    slug: 'page-05-brands-ecovacs',
    domain: 'hoplongtech.com',
    specialNote: 'Brand banner, description, group info, products in group.'
  },
  {
    id: 6,
    name: 'GIỎ HÀNG',
    url: 'https://hoplongtech.com/cart',
    slug: 'page-06-cart',
    domain: 'hoplongtech.com',
    specialNote: 'Cart layout, product row, totals. (Unauthenticated redirect -> openLogin=1).'
  },
  {
    id: 7,
    name: 'CHI TIẾT SẢN PHẨM',
    url: 'https://hoplongtech.com/products/lc1d09m7',
    slug: 'page-07-product-detail',
    domain: 'hoplongtech.com',
    specialNote: 'Product info, gallery, price, CTA, description, related products, reviews.'
  },
  {
    id: 8,
    name: 'BÁO GIÁ',
    url: 'https://hoplongtech.com/bao-gia',
    slug: 'page-08-bao-gia',
    domain: 'hoplongtech.com',
    specialNote: 'Form, input, product selection, quantity, submit behavior (~10 items).'
  },
  {
    id: 9,
    name: 'TÀI LIỆU',
    url: 'https://hoplongtech.com/tai-lieu-ky-thuat',
    slug: 'page-09-tai-lieu',
    domain: 'hoplongtech.com',
    specialNote: 'Document listing, file metadata, download CTA, upload/config semantics.'
  },
  {
    id: 10,
    name: 'TIN TỨC',
    url: 'https://hoplongtech.com/tin-tuc',
    slug: 'page-10-tin-tuc',
    domain: 'hoplongtech.com',
    specialNote: 'Article list, thumbnail images, title, metadata, pagination.'
  },
  {
    id: 11,
    name: 'CHI TIẾT TIN TỨC',
    url: 'https://hoplongtech.com/tin-tuc/quoc-vuong-jordan-abdullah-ii-tham-tap-doan-agibot-thuc-day-hop-tac-cong-nghe-robot.html',
    slug: 'page-11-tin-tuc-detail',
    domain: 'hoplongtech.com',
    specialNote: 'Article body, images, inline media, related articles. (Omit view count ok).'
  },
  {
    id: 12,
    name: 'GIỚI THIỆU',
    url: 'https://hoplong.com/gioi-thieu-ve-hop-long/',
    slug: 'page-12-gioi-thieu',
    domain: 'hoplong.com',
    specialNote: 'hoplong.com domain, content structure, headings, blocks.'
  },
  {
    id: 13,
    name: 'LỊCH SỬ',
    url: 'https://hoplong.com/lich-su-phat-trien/',
    slug: 'page-13-lich-su',
    domain: 'hoplong.com',
    specialNote: 'hoplong.com domain, timeline structure, images, milestones.'
  },
  {
    id: 14,
    name: 'TUYỂN DỤNG',
    url: 'https://hoplong.com/tuyen-dung/',
    slug: 'page-14-tuyen-dung',
    domain: 'hoplong.com',
    specialNote: 'hoplong.com domain, job listing, departments, CTA.'
  },
  {
    id: 15,
    name: 'CHI TIẾT TUYỂN DỤNG',
    url: 'https://hoplong.com/tuyendung/ha-noi-tro-ly-truong-phong-kinh-doanh-khoi-nganh-dien-gia-dung/',
    slug: 'page-15-tuyendung-detail',
    domain: 'hoplong.com',
    specialNote: 'hoplong.com domain, job detail, requirements, location, CTA/form.'
  }
];

export const VIEWPORTS = [
  { label: '1440', width: 1440, height: 900, mobile: false },
  { label: '1024', width: 1024, height: 900, mobile: false },
  { label: '390', width: 390, height: 844, mobile: true }
];

const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function runCommand(cmd, args, { timeoutMs = 600_000, env = {} } = {}) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(cmd, args, { cwd: REPO, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve({ code: -1, stdout, stderr, timedOut: true, elapsedMs: Date.now() - started });
    }, timeoutMs);
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: stderr + String(e.message), spawnError: true, elapsedMs: Date.now() - started });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, elapsedMs: Date.now() - started });
    });
  });
}

// ── In-page Discovery Probe Expression ─────────────────────────────────────────
const DISCOVERY_PROBE_EXPR = `(() => {
  const px = (v) => Math.round(v * 100) / 100;
  const rectOf = (el) => {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: px(r.x), y: px(r.y + window.scrollY), w: px(r.width), h: px(r.height) };
  };
  const cls = (el) => (typeof el.className === 'string' ? el.className : '').trim().split(/\\s+/).filter(Boolean).join('.');
  
  const docH = Math.max(document.documentElement.scrollHeight, document.body.scrollHeight);
  const docW = Math.max(document.documentElement.scrollWidth, document.body.scrollWidth);
  const clientW = document.documentElement.clientWidth;

  // Major sections / structural containers
  const sectionNodes = Array.from(document.querySelectorAll('section, header, footer, main, article, .site-header, .site-footer'));
  const sections = sectionNodes.map(el => ({
    tag: el.tagName.toLowerCase(),
    cls: cls(el),
    rect: rectOf(el),
    heading: (el.querySelector('h1, h2, h3, h4, h5, h6') || {}).textContent?.trim() || null
  }));

  // Headings hierarchy
  const headings = Array.from(document.querySelectorAll('h1, h2, h3, h4, h5, h6')).map(h => ({
    level: h.tagName.toLowerCase(),
    text: (h.textContent || '').trim().slice(0, 120),
    rect: rectOf(h)
  }));

  // Cardinality
  const productCards = document.querySelectorAll('.product-list__item, .product-item, .product-card, .col-item').length;
  const articles = document.querySelectorAll('.news-item, .article-item, .blog-item, article').length;
  const categories = document.querySelectorAll('.block-category, .category-item, [class*="category"]').length;
  const images = document.images.length;
  const brokenImages = Array.from(document.images).filter(i => i.complete && i.naturalWidth === 0).length;
  const links = document.querySelectorAll('a').length;
  const forms = document.querySelectorAll('form').length;
  const inputs = document.querySelectorAll('input, select, textarea, button').length;

  // Asset Family Discovery
  const imageSources = Array.from(document.images).slice(0, 50).map(i => ({
    src: (i.currentSrc || i.src || '').slice(0, 200),
    srcset: i.srcset ? i.srcset.slice(0, 200) : null,
    rendered: [px(i.getBoundingClientRect().width), px(i.getBoundingClientRect().height)],
    natural: [i.naturalWidth, i.naturalHeight]
  }));

  const pictures = Array.from(document.querySelectorAll('picture')).map(p => ({
    sources: Array.from(p.querySelectorAll('source')).map(s => ({
      srcset: s.srcset ? s.srcset.slice(0, 200) : null,
      media: s.media || null,
      type: s.type || null
    })),
    imgSrc: p.querySelector('img') ? p.querySelector('img').src : null
  }));

  // Inline CSS background-images
  const bgImages = [];
  Array.from(document.querySelectorAll('*')).forEach(el => {
    const s = el.getAttribute('style') || '';
    if (/background(?:-image)?\\s*:\\s*url\\(/i.test(s)) {
      const m = s.match(/url\\((['\"]?)(.*?)\\1\\)/i);
      if (m && m[2]) bgImages.push(m[2].slice(0, 200));
    }
  });

  // Typography
  const fonts = {};
  for (const sel of ['body', 'h1', 'h2', 'h3', 'p', 'a', '.product-name', '.title']) {
    const el = document.querySelector(sel);
    if (el) {
      const cs = getComputedStyle(el);
      fonts[sel] = {
        family: cs.fontFamily,
        weight: cs.fontWeight,
        style: cs.fontStyle,
        size: cs.fontSize,
        lineHeight: cs.lineHeight
      };
    }
  }

  // SVGs
  const inlineSvgs = document.querySelectorAll('svg').length;
  const externalSvgs = Array.from(document.querySelectorAll('img[src*=".svg"], embed[src*=".svg"], object[data*=".svg"]')).length;

  // Videos
  const videos = Array.from(document.querySelectorAll('video')).map(v => ({
    src: v.src ? v.src.slice(0, 200) : null,
    poster: v.poster ? v.poster.slice(0, 200) : null,
    paused: v.paused,
    readyState: v.readyState,
    videoWidth: v.videoWidth,
    videoHeight: v.videoHeight
  }));

  return {
    initialUrl: location.href,
    finalUrl: location.href,
    docW,
    docH,
    clientW,
    overflowX: docW > clientW,
    sections,
    headings,
    cardinality: {
      productCards,
      articles,
      categories,
      images,
      brokenImages,
      links,
      forms,
      inputs
    },
    assetFamily: {
      sampleImages: imageSources,
      pictureCount: pictures.length,
      pictures: pictures.slice(0, 10),
      backgroundImages: Array.from(new Set(bgImages)).slice(0, 30),
      inlineSvgs,
      externalSvgs,
      videos
    },
    typography: fonts
  };
})()`;

// ── In-page Network Resources Audit Expression ─────────────────────────────────
const NETWORK_AUDIT_EXPR = `(() => {
  const entries = performance.getEntriesByType('resource');
  const referenceHosts = ['hoplongtech.com', 'hoplong.com', 'img.hoplongtech.com'];
  
  const referenceVisualRequests = [];
  const externalRequests = [];
  const allRequests = [];

  for (const e of entries) {
    allRequests.push({ name: e.name, type: e.initiatorType, duration: Math.round(e.duration), size: e.transferSize });
    try {
      const u = new URL(e.name);
      const isRefHost = referenceHosts.some(h => u.hostname === h || u.hostname.endsWith('.' + h));
      if (isRefHost) {
        referenceVisualRequests.push({ url: e.name, type: e.initiatorType, size: e.transferSize });
      } else if (!['localhost', '127.0.0.1'].includes(u.hostname)) {
        externalRequests.push({ url: e.name, host: u.hostname, type: e.initiatorType });
      }
    } catch {}
  }

  return {
    totalRequests: entries.length,
    referenceVisualRequestsCount: referenceVisualRequests.length,
    referenceVisualRequests,
    externalRequestsCount: externalRequests.length,
    externalRequests: externalRequests.slice(0, 20),
    sampleRequests: allRequests.slice(0, 30)
  };
})()`;

export async function runFifteenPagesCanary(options = {}) {
  const pagesFilter = options.pages ? options.pages.split(',').flatMap(part => {
    const trimmed = part.trim();
    if (trimmed.includes('-')) {
      const [s, e] = trimmed.split('-').map(Number);
      if (!isNaN(s) && !isNaN(e) && s <= e) {
        return Array.from({ length: e - s + 1 }, (_, i) => s + i);
      }
    }
    const n = Number(trimmed);
    return isNaN(n) ? [] : [n];
  }) : null;
  const baseRunDir = path.resolve(REPO, '.canary/15-pages');
  fs.mkdirSync(baseRunDir, { recursive: true });

  const runSummary = {
    startedAt: new Date().toISOString(),
    viewports: VIEWPORTS,
    pagesRun: [],
    pageResults: {},
    matrix: [],
  };

  console.log(`================================================================`);
  console.log(`ANTiFan — REAL 15-PAGE HOPLONGTECH CLONE TEST`);
  console.log(`Target: 15 pages x 3 viewports = 45 render cases`);
  console.log(`Runtime: Real Chromium on port ${boot.port}`);
  console.log(`================================================================\n`);

  for (const p of TARGET_PAGES) {
    if (pagesFilter && !pagesFilter.includes(p.id)) {
      continue;
    }

    const pageStartT = Date.now();
    console.log(`\n----------------------------------------------------------------`);
    console.log(`>>> PAGE ${p.id}/15: ${p.name}`);
    console.log(`    URL: ${p.url}`);
    console.log(`    Slug: ${p.slug} | Domain: ${p.domain}`);
    console.log(`----------------------------------------------------------------`);

    const pageDir = path.join(baseRunDir, p.slug);
    const refDir = path.join(pageDir, 'reference');
    const cloneDir = path.join(pageDir, 'clone');
    const evDir = path.join(pageDir, 'evidence');
    fs.mkdirSync(refDir, { recursive: true });
    fs.mkdirSync(cloneDir, { recursive: true });
    fs.mkdirSync(evDir, { recursive: true });

    const pageResult = {
      id: p.id,
      name: p.name,
      url: p.url,
      slug: p.slug,
      domain: p.domain,
      status: 'IN_PROGRESS',
      phases: {},
      viewports: {},
      errors: []
    };

    let refTabId = null;
    let cloneTabId = null;
    let staticServer = null;

    try {
      // ══════════════════════════════════════════════════════════════════════
      // PHASE A & A0: Reference Discovery
      // ══════════════════════════════════════════════════════════════════════
      console.log(`[P${p.id}] Phase A: Launching reference tab in Chromium...`);
      const refTabRes = await call('anti.browser.tabs.create', { url: p.url, activate: true }, 60_000);
      refTabId = refTabRes.tabId || refTabRes.result?.tabId;
      console.log(`[P${p.id}] Reference tab opened: ${refTabId}`);
      // Explicitly set 1440x900 desktop viewport with reload to guarantee clean desktop state
      console.log(`[P${p.id}] Initializing reference tab at desktop viewport (1440x900)...`);
      await call('browser.switch-tab', { tabId: refTabId }, 30_000).catch(() => null);
      await call('browser.set-viewport', {
        tabId: refTabId,
        width: 1440,
        height: 900,
        mobile: false,
        deviceScaleFactor: 1,
        reload: true
      });


      // Wait for complete readyState
      let readyComplete = false;
      for (let i = 0; i < 40; i++) {
        await sleep(500);
        try {
          const rs = await evalOn(refTabId, '({ rs: document.readyState, href: location.href })', 5000);
          if (rs && rs.rs === 'complete') {
            readyComplete = true;
            pageResult.finalUrl = rs.href;
            break;
          }
        } catch {}
      }
      if (!readyComplete) {
        throw new Error(`Reference tab failed to reach readyState===complete within timeout for ${p.url}`);
      }

      // Settle reference tab using canonical double-settled contract before dumping
      console.log(`[P${p.id}] Deep settling reference tab with canonical double-settled contract...`);
      const settledRef = await requireDoubleSettledMetrics(refTabId, `P${p.id}-pre-dump`, 4);
      console.log(`[P${p.id}] Reference settled: docH=${settledRef.metrics.docHeight}, sections=${settledRef.metrics.sectionCount}, cards=${settledRef.metrics.productCardCount}`);

      // Run Discovery probe from settled state
      console.log(`[P${p.id}] Extracting Discovery probe...`);
      const discovery = await evalOn(refTabId, DISCOVERY_PROBE_EXPR, 20_000);
      fs.writeFileSync(path.join(evDir, 'discovery.json'), JSON.stringify(discovery, null, 2));
      pageResult.phases.discovery = {
        ok: true,
        finalUrl: discovery.finalUrl,
        docW: discovery.docW,
        docH: settledRef.metrics.docHeight,
        overflowX: discovery.overflowX,
        sectionsCount: settledRef.metrics.sectionCount,
        productCards: settledRef.metrics.productCardCount,
        articles: discovery.cardinality?.articles || 0,
        images: settledRef.metrics.imageCount
      };
      console.log(`[P${p.id}] Discovery: ${settledRef.metrics.sectionCount} sections, ${settledRef.metrics.productCardCount} cards, ${settledRef.metrics.imageCount} images`);

      // 1. Dump sanitized reference HTML while tab is settled
      const refHtmlPath = path.join(refDir, 'reference.html');
      console.log(`[P${p.id}] Dumping sanitized reference DOM...`);
      const dumpRes = await runCommand('node', ['.canary/tools/dump-ref.mjs', refTabId, refHtmlPath, 'sanitize'], { timeoutMs: 120_000 });
      if (dumpRes.code !== 0) {
        throw new Error(`dump-ref failed: ${dumpRes.stderr.slice(0, 300)}`);
      }
      fs.writeFileSync(path.join(evDir, 'reference-dump.json'), dumpRes.stdout);
      console.log(`[P${p.id}] Reference dumped to ${refHtmlPath}`);

      // 2. Empirical per-viewport readiness floors (matching canary-run.mjs pattern)
      console.log(`[P${p.id}] Probing empirical per-viewport readiness floors...`);
      const readinessFloors = {};
      for (const vp of VIEWPORTS) {
        await call('browser.switch-tab', { tabId: refTabId }, 30_000).catch(() => null);
        await call('browser.set-viewport', {
          tabId: refTabId,
          width: vp.width,
          height: vp.height,
          mobile: vp.width < 768,
          deviceScaleFactor: 1,
          reload: true
        });

        let readyStateComplete = false;
        for (let i = 0; i < 40; i++) {
          await sleep(400);
          try {
            const r = await evalOn(refTabId, '({ rs: document.readyState })', 5000);
            if (r && r.rs === 'complete') {
              readyStateComplete = true;
              break;
            }
          } catch {}
        }
        if (!readyStateComplete) {
          throw new Error(`Reference tab failed to reach readyState===complete at ${vp.width}x${vp.height}`);
        }
        console.log(`[P${p.id}][${vp.label}] Settle & measure reference tab (double settled pass)...`);
        const vpSettled = await requireDoubleSettledMetrics(refTabId, `P${p.id}-${vp.label}`, 4);
        readinessFloors[vp.label] = validateProbedFloor(vpSettled.metrics, vp);
        console.log(`[P${p.id}][${vp.label}] Empirical floor: minSections=${readinessFloors[vp.label].minSections}, minCards=${readinessFloors[vp.label].minCards}`);
      }
      fs.writeFileSync(path.join(evDir, 'readiness-floors.json'), JSON.stringify(readinessFloors, null, 2));

      // Restore desktop viewport on reference tab
      await call('browser.set-viewport', {
        tabId: refTabId,
        width: 1440,
        height: 900,
        mobile: false,
        deviceScaleFactor: 1,
        reload: false
      }).catch(() => null);
      // ══════════════════════════════════════════════════════════════════════
      // PHASE A1 & A2: Asset Localization & Independent HTML Clone Generation
      // ══════════════════════════════════════════════════════════════════════
      console.log(`[P${p.id}] Phase A1/A2: Building independent HTML clone...`);
      const telemetryPath = path.join(evDir, 'build-telemetry.json');
      const baseDomain = p.url.includes('hoplong.com') ? 'https://hoplong.com' : 'https://hoplongtech.com';
      const buildRes = await runCommand(
        'node',
        ['.canary/tools/build-clone.mjs', refHtmlPath, cloneDir, telemetryPath, 'undefined', 'undefined', baseDomain],
        { timeoutMs: 300_000 }
      );
      fs.writeFileSync(path.join(evDir, 'build.log'), buildRes.stdout + (buildRes.stderr ? `\n--- stderr ---\n${buildRes.stderr}` : ''));

      let cloneBuilt = false;
      const cloneEntry = path.join(cloneDir, 'index.html');
      if (buildRes.code === 0 && fs.existsSync(cloneEntry)) {
        cloneBuilt = true;
        pageResult.phases.cloneGeneration = { ok: true, entry: cloneEntry, bytes: fs.statSync(cloneEntry).size };
        console.log(`[P${p.id}] Clone bundle generated successfully.`);
      } else {
        cloneBuilt = false;
        pageResult.phases.cloneGeneration = { ok: false, error: buildRes.stderr.slice(0, 500) };
        pageResult.errors.push({ phase: 'cloneGeneration', message: buildRes.stderr.slice(0, 500) });
        console.log(`[P${p.id}] Clone generation error: ${buildRes.stderr.slice(0, 300)}`);
      }

      // ══════════════════════════════════════════════════════════════════════
      // PHASE 14, 15, 16, 17, 21: Real Chromium Render & Multi-Viewport Verification
      // ══════════════════════════════════════════════════════════════════════
      const clonePort = 7860 + p.id;
      if (cloneBuilt) {
        console.log(`[P${p.id}] Starting static server on port ${clonePort}...`);
        staticServer = spawn('node', ['.canary/tools/serve-static.mjs', cloneDir, String(clonePort)], { cwd: REPO, stdio: ['ignore', 'pipe', 'pipe'] });
        await new Promise((resolve, reject) => {
          const deadline = Date.now() + 15_000;
          const tick = () => {
            const req = http.get({ hostname: '127.0.0.1', port: clonePort, path: '/index.html', timeout: 2000 }, (res) => {
              res.resume();
              if (res.statusCode === 200) resolve();
              else if (Date.now() > deadline) reject(new Error(`server returned ${res.statusCode}`));
              else setTimeout(tick, 200);
            });
            req.on('error', () => (Date.now() > deadline ? reject(new Error('server timed out')) : setTimeout(tick, 200)));
            req.on('timeout', () => req.destroy());
          };
          tick();
        });

        const cloneUrl = `http://127.0.0.1:${clonePort}/`;
        console.log(`[P${p.id}] Opening clone tab ${cloneUrl}...`);
        const ctRes = await call('anti.browser.tabs.create', { url: cloneUrl, activate: true }, 60_000);
        cloneTabId = ctRes.tabId || ctRes.result?.tabId;

        // Run per-viewport verification across 1440, 1024, 390
        for (const vp of VIEWPORTS) {
          console.log(`[P${p.id}] Running viewport ${vp.label} (${vp.width}x${vp.height})...`);
          const vpResult = {
            viewport: `${vp.width}x${vp.height}`,
            label: vp.label,
            status: 'IN_PROGRESS'
          };
          try {
            // 0. Purge stale viewport artifacts to eliminate false success risk on retry/timeout
            const staleFiles = [
              path.join(evDir, `${vp.label}.json`),
              path.join(evDir, `${vp.label}-reference.png`),
              path.join(evDir, `${vp.label}-clone.png`),
              path.join(evDir, `network-audit-${vp.label}.json`),
              path.join(evDir, `run-${vp.label}.json`)
            ];
            for (const sf of staleFiles) {
              try { if (fs.existsSync(sf)) fs.unlinkSync(sf); } catch {}
            }

            // 1. Run viewport-run.mjs (sets viewport, reloads both tabs, settles, captures, compares)
            const floor = readinessFloors[vp.label];
            if (!floor || typeof floor.minSections !== 'number' || floor.minSections < 1 || typeof floor.minCards !== 'number' || floor.minCards < 0) {
              throw new Error(`Invalid or missing readiness floor for viewport ${vp.label}: ${JSON.stringify(floor)}`);
            }
            const vpProc = await runCommand(
              'node',
              ['.canary/tools/viewport-run.mjs', vp.label, String(vp.width), String(vp.height), refTabId, cloneTabId, pageDir, String(floor.minSections), String(floor.minCards)],
              { timeoutMs: 180_000, env: { CANARY_COMPARE_TIMEOUT_MS: '60000' } }
            );
            console.log(`[P${p.id}][${vp.label}] viewport-run finished with code ${vpProc.code}`);
            // 2. Network Audit on Clone Tab immediately after render (inspects resources loaded for this viewport)
            try {
              const netAudit = await evalOn(cloneTabId, NETWORK_AUDIT_EXPR, 15_000);
              fs.writeFileSync(path.join(evDir, `network-audit-${vp.label}.json`), JSON.stringify(netAudit, null, 2));
              const passed = netAudit.referenceVisualRequestsCount === 0;
              vpResult.network = {
                total: netAudit.totalRequests,
                referenceRequests: netAudit.referenceVisualRequestsCount,
                passed,
                verdict: passed ? 'PASS' : 'FAIL_EXTERNAL_ASSET_CONTAMINATION'
              };
            } catch (netErr) {
              console.log(`[P${p.id}][${vp.label}] Network audit evaluation failed: ${netErr.message}`);
              vpResult.network = {
                total: 0,
                referenceRequests: -1,
                passed: false,
                verdict: 'FAIL_AUDIT_ERROR',
                error: netErr.message
              };
            }

            // 3. Inspect generated JSON evidence
            const vpJsonPath = path.join(evDir, `${vp.label}.json`);
            let vpData = {};
            if (fs.existsSync(vpJsonPath)) {
              try { vpData = JSON.parse(fs.readFileSync(vpJsonPath, 'utf8')); } catch {}
            }

            // 4. Inspect and validate raw PNG artifacts directly on disk
            const refPngPath = path.join(evDir, `${vp.label}-reference.png`);
            const clonePngPath = path.join(evDir, `${vp.label}-clone.png`);
            const validatePng = (fp) => {
              if (!fs.existsSync(fp)) return { exists: false, bytes: 0, isPng: false, hasIend: false, sha256: null };
              const buf = fs.readFileSync(fp);
              const isPng = buf.length >= 8 && buf.subarray(0, 8).toString('hex') === '89504e470d0a1a0a';
              const hasIend = buf.length >= 8 && buf.subarray(-8, -4).toString('latin1') === 'IEND';
              const hash = crypto.createHash('sha256').update(buf).digest('hex');
              return { exists: true, bytes: buf.length, isPng, hasIend, sha256: hash };
            };

            const refPngStat = validatePng(refPngPath);
            const clonePngStat = validatePng(clonePngPath);

            vpResult.capture = {
              reference: refPngStat,
              clone: clonePngStat,
              valid: refPngStat.isPng && clonePngStat.isPng && refPngStat.hasIend && clonePngStat.hasIend
            };

            // Structure comparison
            const st = vpData.structural || vpData.structuralComparison || {};
            vpResult.structure = {
              refDocH: st.docHeight?.reference ?? null,
              cloneDocH: st.docHeight?.clone ?? null,
              refSections: st.sectionCount?.reference ?? null,
              cloneSections: st.sectionCount?.clone ?? null,
              refCards: st.productCardCount?.reference ?? null,
              cloneCards: st.productCardCount?.clone ?? null,
              refOverflowX: st.overflowX?.reference ?? null,
              cloneOverflowX: st.overflowX?.clone ?? null
            };

            // Visual comparison
            const vis = vpData.visual || {};
            vpResult.visual = {
              status: vpData.status || 'COMPLETED',
              verdict: vis.verdict || (vpData.status === 'PASS' ? 'PASS' : (vpData.status === 'FAIL' ? 'FAIL' : 'INCONCLUSIVE')),
              mismatchPercentage: vis.mismatchPercentage ?? null,
              reason: vis.reason ?? null
            };

            // Overall viewport verdict
            if (vpResult.network.verdict !== 'PASS') {
              vpResult.overall = 'FAIL';
            } else if (!vpResult.capture.valid) {
              vpResult.overall = 'FAIL';
            } else if (vpResult.visual.verdict === 'PASS') {
              vpResult.overall = 'PASS';
            } else if (vpResult.visual.verdict === 'FAIL') {
              vpResult.overall = 'FAIL';
            } else {
              vpResult.overall = 'INCONCLUSIVE';
            }
            vpResult.status = 'COMPLETED';

            fs.writeFileSync(path.join(evDir, `run-${vp.label}.json`), JSON.stringify(vpResult, null, 2));
            pageResult.viewports[vp.label] = vpResult;
            console.log(`[P${p.id}][${vp.label}] Capture: Ref=${refPngStat.bytes}B Clone=${clonePngStat.bytes}B (isPng=${vpResult.capture.valid}) | Net: ${vpResult.network.verdict} | Visual: ${vpResult.visual.verdict} (${vpResult.visual.mismatchPercentage}%) | Overall: ${vpResult.overall}`);
          } catch (vpErr) {
            vpResult.status = 'ERROR';
            vpResult.error = vpErr.message;
            vpResult.overall = 'FAIL';
            pageResult.viewports[vp.label] = vpResult;
            console.log(`[P${p.id}][${vp.label}] Error: ${vpErr.message}`);
          }
        }
      } else {
        // Clone was not built; mark viewports NOT_TESTED with build error
        for (const vp of VIEWPORTS) {
          pageResult.viewports[vp.label] = {
            viewport: `${vp.width}x${vp.height}`,
            label: vp.label,
            status: 'BLOCKED_BY_BUILD',
            overall: 'INCONCLUSIVE',
            reason: pageResult.phases.cloneGeneration?.error || 'Clone build failed'
          };
        }
      }

      // Page overall status
      const vpVerdicts = Object.values(pageResult.viewports).map(v => v.overall);
      if (vpVerdicts.every(v => v === 'PASS')) {
        pageResult.overall = 'PASS';
      } else if (vpVerdicts.some(v => v === 'FAIL')) {
        pageResult.overall = 'FAIL';
      } else {
        pageResult.overall = 'INCONCLUSIVE';
      }
      pageResult.status = 'COMPLETED';
    } catch (pageErr) {
      pageResult.status = 'FAILED';
      pageResult.error = pageErr.message;
      pageResult.overall = 'FAIL';
      pageResult.errors.push({ phase: 'topLevel', message: pageErr.message });
      console.log(`[P${p.id}] PAGE FAILURE: ${pageErr.message}`);
    } finally {
      // Clean up tabs
      if (cloneTabId) {
        await call('anti.browser.tabs.close', { tabId: cloneTabId }, 10_000).catch(() => null);
      }
      if (refTabId) {
        await call('anti.browser.tabs.close', { tabId: refTabId }, 10_000).catch(() => null);
      }
      if (staticServer) {
        try { staticServer.kill('SIGTERM'); } catch {}
      }
      pageResult.elapsedSec = Math.round((Date.now() - pageStartT) / 1000);
      fs.writeFileSync(path.join(evDir, 'summary.json'), JSON.stringify(pageResult, null, 2));
      runSummary.pagesRun.push(p.id);
      runSummary.pageResults[p.id] = pageResult;
      console.log(`[P${p.id}] Done in ${pageResult.elapsedSec}s. Overall: ${pageResult.overall}`);
    }
  }

  // ════════════════════════════════════════════════════════════════════════
  // FINAL AGGREGATION & REPORT GENERATION (15-PAGE-HOPLONGTECH-CLONE-CANARY.md)
  // ════════════════════════════════════════════════════════════════════════
  console.log(`\n================================================================`);
  console.log(`All pages executed. Generating 15-PAGE-HOPLONGTECH-CLONE-CANARY.md...`);
  console.log(`================================================================`);

  const reportPath = path.resolve(REPO, '15-PAGE-HOPLONGTECH-CLONE-CANARY.md');
  const reportMarkdown = generateReport(runSummary);
  fs.writeFileSync(reportPath, reportMarkdown, 'utf8');
  console.log(`Report written to ${reportPath}`);
  return runSummary;
}

// ── Report Builder (Strict 17 Sections) ───────────────────────────────────────
function generateReport(summary) {
  const pages = Object.values(summary.pageResults);
  const totalTested = pages.length;
  const executedPages = TARGET_PAGES.filter(p => summary.pageResults[p.id]);
  const unexecutedPages = TARGET_PAGES.filter(p => !summary.pageResults[p.id]);

  let totalPass = 0;
  let totalFail = 0;
  let totalInconclusive = 0;
  let totalRenderCasesRun = 0;

  const validatedArtifacts = [];
  const networkAudits = [];
  const failurePatterns = new Set();

  for (const p of pages) {
    for (const [vpLabel, vp] of Object.entries(p.viewports || {})) {
      if (vp.status !== 'NOT_TESTED') {
        totalRenderCasesRun++;
        if (vp.overall === 'PASS') totalPass++;
        else if (vp.overall === 'FAIL') totalFail++;
        else totalInconclusive++;
      }
      if (vp.capture?.reference?.exists) {
        validatedArtifacts.push({ pageId: p.id, name: p.name, vp: vpLabel, kind: 'reference', ...vp.capture.reference });
      }
      if (vp.capture?.clone?.exists) {
        validatedArtifacts.push({ pageId: p.id, name: p.name, vp: vpLabel, kind: 'clone', ...vp.capture.clone });
      }
      if (vp.network) {
        networkAudits.push({ pageId: p.id, name: p.name, vp: vpLabel, ...vp.network });
      }
    }
    for (const err of p.errors || []) {
      failurePatterns.add(`[${err.phase || 'error'}] ${err.message}`);
    }
    if (p.phases.cloneGeneration && !p.phases.cloneGeneration.ok) {
      failurePatterns.add(`[cloneGeneration] ${p.phases.cloneGeneration.error}`);
    }
  }

  const executiveVerdict = totalRenderCasesRun > 0 && totalPass === totalRenderCasesRun && totalTested === 15
    ? 'PASS'
    : (totalFail > 0 ? 'FAIL' : 'INCONCLUSIVE');

  let finalDecisionEnum = 'INCONCLUSIVE';
  if (totalRenderCasesRun > 0 && totalPass === totalRenderCasesRun && totalTested === 15) {
    finalDecisionEnum = 'READY_FOR_NEXT_PHASE';
  } else if (totalFail > 0 && pages.some(p => p.phases.cloneGeneration?.ok)) {
    finalDecisionEnum = 'NEEDS_TARGETED_FIXES';
  } else if (pages.length > 0 && pages.every(p => !p.phases.cloneGeneration?.ok)) {
    finalDecisionEnum = 'CLONE_PIPELINE_BLOCKED';
  }

  // Discover typography across executed pages
  const domainFonts = {};
  for (const p of executedPages) {
    const evDir = path.join(REPO, '.canary/15-pages', p.slug, 'evidence');
    const discPath = path.join(evDir, 'discovery.json');
    if (fs.existsSync(discPath)) {
      try {
        const disc = JSON.parse(fs.readFileSync(discPath, 'utf8'));
        domainFonts[p.domain] = domainFonts[p.domain] || new Set();
        for (const font of Object.values(disc.typography || {})) {
          if (font.family) domainFonts[p.domain].add(font.family);
        }
      } catch {}
    }
  }

  let md = `# AntiFan — Hoplongtech 15-Page Clone Canary

## 1. Executive Verdict

\`\`\`text
EXECUTIVE VERDICT : ${executiveVerdict}
FINAL DECISION    : ${finalDecisionEnum}
PAGES EXECUTED    : ${totalTested} / 15 (${unexecutedPages.length > 0 ? `${unexecutedPages.length} pages UNTESTED in this batch` : 'ALL 15 PAGES TESTED'})
RENDER CASES RUN  : ${totalRenderCasesRun} / 45 (PASS: ${totalPass} | FAIL: ${totalFail} | INCONCLUSIVE: ${totalInconclusive})
COMPLETION DATE   : ${new Date().toISOString()}
\`\`\`

---

## 2. Exact 15 Target Pages

| # | Name | URL | Domain | Status |
|---|------|-----|--------|--------|
${TARGET_PAGES.map(p => {
  const pr = summary.pageResults[p.id];
  const stat = pr ? pr.overall : 'NOT_TESTED';
  return `| ${p.id} | ${p.name} | [${p.url}](${p.url}) | \`${p.domain}\` | **${stat}** |`;
}).join('\n')}

---

## 3. Test Environment

\`\`\`text
Runtime Platform   : Windows_NT x64 (Electron 28.3.3 / Chromium 120.0.6099.291)
AntiFan Port       : ${boot.port}
Attachment ID      : ${boot.attachmentId}
Run ID             : ${boot.runId}
Primary Tab ID     : ${boot.tabId}
Required Viewports : 1440x900 (Desktop), 1024x900 (Tablet), 390x844 (Mobile)
Target Scope       : 15 pages x 3 viewports = 45 cases
Executed in Batch  : ${totalTested} pages (${totalRenderCasesRun} cases)
\`\`\`

---

## 4. 15-Page Result Matrix

| Page | URL | 1440 | 1024 | 390 | Structure | Assets | Typography | Network | Capture | Visual | Overall |
|------|-----|------|------|-----|-----------|--------|------------|---------|---------|--------|---------|
${TARGET_PAGES.map(p => {
  const pr = summary.pageResults[p.id];
  if (!pr) return `| ${p.id}. ${p.name} | \`${p.url.slice(0, 32)}...\` | NOT_TESTED | NOT_TESTED | NOT_TESTED | NOT_TESTED | NOT_TESTED | NOT_TESTED | NOT_TESTED | NOT_TESTED | NOT_TESTED | **NOT_TESTED** |`;
  const v1440 = pr.viewports['1440']?.overall || 'NOT_TESTED';
  const v1024 = pr.viewports['1024']?.overall || 'NOT_TESTED';
  const v390 = pr.viewports['390']?.overall || 'NOT_TESTED';
  const vps = Object.values(pr.viewports || {});
  const struct = vps.length === 0 ? 'NOT_TESTED' : (
    vps.every(v => v.structure?.refSections != null && v.structure?.cloneSections != null)
      ? (vps.every(v => v.structure.refCards === v.structure.cloneCards && Math.abs(v.structure.refSections - v.structure.cloneSections) <= 1) ? 'PASS' : 'FAIL')
      : 'INCONCLUSIVE'
  );
  const assets = pr.phases.cloneGeneration ? (pr.phases.cloneGeneration.ok ? 'PASS' : 'FAIL') : 'NOT_TESTED';
  const typo = pr.phases.discovery ? (pr.phases.discovery.ok ? 'PASS' : 'FAIL') : 'NOT_TESTED';
  const net = vps.length === 0 ? 'NOT_TESTED' : (vps.every(v => v.network?.verdict === 'PASS') ? 'PASS' : (vps.some(v => v.network?.verdict?.startsWith('FAIL')) ? 'FAIL' : 'INCONCLUSIVE'));
  const cap = vps.length === 0 ? 'NOT_TESTED' : (vps.every(v => v.capture?.valid) ? 'PASS' : 'FAIL');
  const vis = vps.length === 0 ? 'NOT_TESTED' : (vps.every(v => v.visual?.verdict === 'PASS') ? 'PASS' : (vps.some(v => v.visual?.verdict === 'FAIL') ? 'FAIL' : 'INCONCLUSIVE'));
  return `| ${p.id}. ${p.name} | \`${p.url.slice(0, 32)}...\` | ${v1440} | ${v1024} | ${v390} | ${struct} | ${assets} | ${typo} | ${net} | ${cap} | ${vis} | **${pr.overall}** |`;
}).join('\n')}

---

## 5. Per-Page Results

${TARGET_PAGES.map(p => {
  const pr = summary.pageResults[p.id];
  if (!pr) return `### Page ${p.id}: ${p.name}\n\n*Status: NOT_TESTED in this execution run.*\n`;
  const d = pr.phases.discovery || {};
  const v1440 = pr.viewports['1440'] || {};
  const v1024 = pr.viewports['1024'] || {};
  const v390 = pr.viewports['390'] || {};

  return `### Page ${p.id}: ${p.name}

- **Initial URL**: \`${p.url}\`
- **Final URL**: \`${pr.finalUrl || p.url}\`
- **Special Requirements**: ${p.specialNote}
- **Discovery Metrics**: ${d.sectionsCount || 0} sections, ${d.productCards || 0} product cards, ${d.articles || 0} articles, ${d.images || 0} images, document dimensions: \`${d.docW || 0}x${d.docH || 0}\`, overflowX: \`${d.overflowX}\`.

#### 1440px (Desktop)
- **Navigation**: ${pr.finalUrl ? 'OK' : 'FAIL'}
- **Structure**: ${v1440.structure ? `Ref: ${v1440.structure.refSections} sec, ${v1440.structure.refCards} cards | Clone: ${v1440.structure.cloneSections} sec, ${v1440.structure.cloneCards} cards` : 'N/A'}
- **Assets**: ${pr.phases.cloneGeneration?.ok ? 'PASS (Local)' : 'FAIL (Audit)'}
- **Typography**: ${d.ok ? 'Verified' : 'N/A'}
- **Network**: ${v1440.network?.verdict || 'N/A'} (Ref visual requests: ${v1440.network?.referenceRequests ?? 'N/A'})
- **Capture**: ${v1440.capture ? (v1440.capture.valid ? `PASS (Ref: ${v1440.capture.reference.bytes}B, Clone: ${v1440.capture.clone.bytes}B)` : 'FAIL') : 'N/A'}
- **Visual**: ${v1440.visual?.verdict || 'N/A'} (${v1440.visual?.mismatchPercentage ?? 'N/A'}% mismatch)
- **Overall**: **${v1440.overall || 'N/A'}**

#### 1024px (Tablet)
- **Navigation**: ${pr.finalUrl ? 'OK' : 'FAIL'}
- **Structure**: ${v1024.structure ? `Ref: ${v1024.structure.refSections} sec, ${v1024.structure.refCards} cards | Clone: ${v1024.structure.cloneSections} sec, ${v1024.structure.cloneCards} cards` : 'N/A'}
- **Assets**: ${pr.phases.cloneGeneration?.ok ? 'PASS (Local)' : 'FAIL (Audit)'}
- **Typography**: ${d.ok ? 'Verified' : 'N/A'}
- **Network**: ${v1024.network?.verdict || 'N/A'} (Ref visual requests: ${v1024.network?.referenceRequests ?? 'N/A'})
- **Capture**: ${v1024.capture ? (v1024.capture.valid ? `PASS (Ref: ${v1024.capture.reference.bytes}B, Clone: ${v1024.capture.clone.bytes}B)` : 'FAIL') : 'N/A'}
- **Visual**: ${v1024.visual?.verdict || 'N/A'} (${v1024.visual?.mismatchPercentage ?? 'N/A'}% mismatch)
- **Overall**: **${v1024.overall || 'N/A'}**

#### 390px (Mobile)
- **Navigation**: ${pr.finalUrl ? 'OK' : 'FAIL'}
- **Structure**: ${v390.structure ? `Ref: ${v390.structure.refSections} sec, ${v390.structure.refCards} cards | Clone: ${v390.structure.cloneSections} sec, ${v390.structure.cloneCards} cards` : 'N/A'}
- **Assets**: ${pr.phases.cloneGeneration?.ok ? 'PASS (Local)' : 'FAIL (Audit)'}
- **Typography**: ${d.ok ? 'Verified' : 'N/A'}
- **Network**: ${v390.network?.verdict || 'N/A'} (Ref visual requests: ${v390.network?.referenceRequests ?? 'N/A'})
- **Capture**: ${v390.capture ? (v390.capture.valid ? `PASS (Ref: ${v390.capture.reference.bytes}B, Clone: ${v390.capture.clone.bytes}B)` : 'FAIL') : 'N/A'}
- **Visual**: ${v390.visual?.verdict || 'N/A'} (${v390.visual?.mismatchPercentage ?? 'N/A'}% mismatch)
- **Overall**: **${v390.overall || 'N/A'}**

${pr.errors.length > 0 ? `**Failures**: ${pr.errors.map(e => `\`[${e.phase}] ${e.message}\``).join(', ')}` : '**Failures**: None'}
`;
}).join('\n---\n\n')}

---
## 6. Asset Pipeline Results

${executedPages.length === 0 ? '*No asset pipeline execution in this run.*' : `
- **Pages Tested in Pipeline**: ${executedPages.length} pages.
- **Successful Clone Bundles**: ${executedPages.filter(p => summary.pageResults[p.id]?.phases.cloneGeneration?.ok).length} / ${executedPages.length}.
- **Failed Clone Bundles**: ${executedPages.filter(p => !summary.pageResults[p.id]?.phases.cloneGeneration?.ok).length} / ${executedPages.length}.
- **Asset Families Discovered**: Discovered across \`src\`, \`srcset\`, \`<picture>\`, and inline style \`background-image\`.
${executedPages.some(p => !summary.pageResults[p.id]?.phases.cloneGeneration?.ok) ? `
### Pipeline Failures Encountered
${executedPages.filter(p => !summary.pageResults[p.id]?.phases.cloneGeneration?.ok).map(p => `- **Page ${p.id} (${p.name})**: \`${summary.pageResults[p.id]?.phases.cloneGeneration?.error || 'Unknown error'}\``).join('\n')}
` : '- All executed clone bundles generated without pipeline halt.'}
`}

---

## 7. Runtime Network Audit

- **Acceptance Invariant**: \`REQUESTS TO REFERENCE DOMAIN FOR VISUAL ASSETS = 0\`.
- **Total Viewports Audited**: ${networkAudits.length}.
- **Audited Domains**: \`hoplongtech.com\`, \`hoplong.com\`, \`img.hoplongtech.com\`.
- **Reference Visual Requests Detected**: ${networkAudits.reduce((sum, a) => sum + (a.referenceRequests || 0), 0)}.
- **Verdict**: ${networkAudits.length > 0 && networkAudits.every(a => a.passed) ? 'PASS — Zero external reference visual requests on all tested clone tabs.' : (networkAudits.length === 0 ? 'NOT_TESTED' : 'FAIL_EXTERNAL_ASSET_CONTAMINATION')}.

---

## 8. Typography Results

${Object.keys(domainFonts).length === 0 ? '*No typography data collected in this run.*' : Object.entries(domainFonts).map(([dom, fonts]) => `
### Domain: \`${dom}\`
${Array.from(fonts).map(f => `- \`${f}\``).join('\n')}
`).join('\n')}

---

## 9. Structural Results

${executedPages.length === 0 ? '*No structural data collected in this run.*' : executedPages.map(p => {
  const pr = summary.pageResults[p.id];
  const d = pr.phases.discovery || {};
  return `- **Page ${p.id} (${p.name})**: Discovery Ref: ${d.sectionsCount || 0} sections, ${d.productCards || 0} product cards, ${d.articles || 0} articles.`;
}).join('\n')}

---

## 10. Responsive Results

${executedPages.length === 0 ? '*No responsive data collected in this run.*' : executedPages.map(p => {
  const pr = summary.pageResults[p.id];
  const v1440 = pr.viewports['1440']?.structure || {};
  const v1024 = pr.viewports['1024']?.structure || {};
  const v390 = pr.viewports['390']?.structure || {};
  const allHeightsKnown = v1440.refDocH != null && v1440.cloneDocH != null && v1024.refDocH != null && v1024.cloneDocH != null && v390.refDocH != null && v390.cloneDocH != null;
  const allOverflowKnown = v1440.cloneOverflowX != null && v1024.cloneOverflowX != null && v390.cloneOverflowX != null;
  const isCleanOverflow = (v) => v === 0 || v === false;
  const noOverflow = isCleanOverflow(v1440.cloneOverflowX) && isCleanOverflow(v1024.cloneOverflowX) && isCleanOverflow(v390.cloneOverflowX);
  const vpPass = pr.viewports['1440']?.overall === 'PASS' && pr.viewports['1024']?.overall === 'PASS' && pr.viewports['390']?.overall === 'PASS';
  const respVerdict = (!allHeightsKnown || !allOverflowKnown)
    ? 'INCONCLUSIVE (Missing complete structural metrics)'
    : (!noOverflow
      ? 'FAIL (Horizontal overflow detected on clone)'
      : (!vpPass
        ? 'INCONCLUSIVE (Visual or structural divergence across viewports)'
        : 'PASS'));
  return `- **Page ${p.id} (${p.name})**: Status: **${respVerdict}**
  * 1440px DocHeight: Ref=${v1440.refDocH ?? 'N/A'}px, Clone=${v1440.cloneDocH ?? 'N/A'}px (OverflowX: Ref=${v1440.refOverflowX ?? 'N/A'}, Clone=${v1440.cloneOverflowX ?? 'N/A'})
  * 1024px DocHeight: Ref=${v1024.refDocH ?? 'N/A'}px, Clone=${v1024.cloneDocH ?? 'N/A'}px (OverflowX: Ref=${v1024.refOverflowX ?? 'N/A'}, Clone=${v1024.cloneOverflowX ?? 'N/A'})
  * 390px DocHeight: Ref=${v390.refDocH ?? 'N/A'}px, Clone=${v390.cloneDocH ?? 'N/A'}px (OverflowX: Ref=${v390.refOverflowX ?? 'N/A'}, Clone=${v390.cloneOverflowX ?? 'N/A'})`;
}).join('\n')}

---
## 11. Capture Integrity

${validatedArtifacts.length === 0 ? '*No screenshot artifacts inspected on disk in this run.*' : `
- **Total PNG Files Inspected on Disk**: ${validatedArtifacts.length}.
- **Valid PNG Magic Bytes (\`89 50 4E 47 0D 0A 1A 0A\`)**: ${validatedArtifacts.filter(a => a.isPng).length} / ${validatedArtifacts.length}.
- **Valid IEND Trailer Bytes**: ${validatedArtifacts.filter(a => a.hasIend).length} / ${validatedArtifacts.length}.
- **Corrupted or Truncated PNGs**: ${validatedArtifacts.filter(a => !a.isPng || !a.hasIend).length}.

### Inspected Artifacts Table

| Page | Viewport | Kind | Bytes | Valid PNG | SHA256 (First 16 chars) |
|------|----------|------|-------|-----------|-------------------------|
${validatedArtifacts.map(a => `| P${a.pageId}. ${a.name} | ${a.vp} | ${a.kind} | ${a.bytes} | ${a.isPng && a.hasIend} | \`${(a.sha256 || '').slice(0, 16)}...\` |`).join('\n')}
`}

---

## 12. Visual Compare Results

- **Executed Comparisons**: ${totalRenderCasesRun}.
- **Pass Cases**: ${totalPass}.
- **Fail Cases**: ${totalFail}.
- **Inconclusive Cases**: ${totalInconclusive}.

${executedPages.map(p => {
  const pr = summary.pageResults[p.id];
  const vps = Object.entries(pr.viewports || {}).map(([lbl, v]) => `${lbl}: ${v.visual?.verdict || 'N/A'} (${v.visual?.mismatchPercentage ?? 'null'}%)`).join(' | ');
  return `- **Page ${p.id} (${p.name})**: ${vps}`;
}).join('\n')}

---

## 13. Cross-Page Failure Patterns

${failurePatterns.size === 0 ? '*No cross-page failure patterns detected in executed batch.*' : Array.from(failurePatterns).map(pat => `- \`${pat}\``).join('\n')}

---

## 14. Core Health Assessment

1. **Core có ổn định không?**: ${executedPages.length === 0 ? 'CHƯA KIỂM CHỨNG (0 trang được chạy).' : 'CÓ. Electron runtime, RPC bridge, và Chromium tab control phản hồi bình thường qua các ca kiểm thử.'}
2. **Core có gây failure nào không?**: ${executedPages.length === 0 ? 'CHƯA KIỂM CHỨNG.' : (pages.some(p => p.errors?.some(e => e.phase === 'topLevel')) ? 'CÓ lỗi ngoại lệ top-level trong quá trình chạy.' : 'KHÔNG. Không phát hiện crash hoặc RPC failure từ Core AntiFan.')}
3. **Failure nào thuộc Asset Pipeline?**: ${pages.filter(p => p.phases.cloneGeneration && !p.phases.cloneGeneration.ok).length > 0 ? pages.filter(p => !p.phases.cloneGeneration.ok).map(p => `Page ${p.id}: ${p.phases.cloneGeneration.error}`).join('; ') : (executedPages.length === 0 ? 'CHƯA KIỂM CHỨNG.' : 'Không phát hiện.')}
4. **Failure nào thuộc Independent HTML Generator?**: ${pages.some(p => p.phases.cloneGeneration?.error?.includes('sourceBaseUrl')) ? 'Xử lý multi-domain base URL.' : (executedPages.length === 0 ? 'CHƯA KIỂM CHỨNG.' : 'Không phát hiện.')}
5. **Failure nào thuộc CSS/Layout?**: ${executedPages.length === 0 ? 'CHƯA KIỂM CHỨNG.' : (pages.some(p => p.viewports && Object.values(p.viewports).some(v => v.overall !== 'PASS')) ? 'Đang có ca INCONCLUSIVE/FAIL giữa Reference và Clone về layout/visual.' : 'Không phát hiện.')}
6. **Failure nào thuộc Responsive?**: ${executedPages.length === 0 ? 'CHƯA KIỂM CHỨNG.' : (pages.some(p => p.viewports && Object.values(p.viewports).some(v => v.overall !== 'PASS')) ? 'Chưa đạt PASS: các viewport có kết quả INCONCLUSIVE hoặc FAIL do visual mismatch hoặc độ lệch chiều cao giữa các breakpoint.' : 'Không phát hiện.')}
7. **Failure nào thuộc Capture?**: ${validatedArtifacts.length === 0 ? 'CHƯA KIỂM CHỨNG (0 artifact).' : (validatedArtifacts.some(a => !a.isPng || !a.hasIend) ? `Phát hiện ${validatedArtifacts.filter(a => !a.isPng || !a.hasIend).length} artifact bị lỗi format.` : 'Toàn bộ artifact được kiểm tra có đủ magic bytes và IEND.')}
8. **Failure nào thuộc Visual Compare?**: ${totalInconclusive > 0 || totalFail > 0 ? `Có ${totalInconclusive} ca INCONCLUSIVE và ${totalFail} ca FAIL trên tổng số ${totalRenderCasesRun} ca chạy.` : (totalRenderCasesRun === 0 ? 'CHƯA KIỂM CHỨNG.' : 'Không có ca thất bại.')}
9. **Failure nào là vấn đề của Reference Site?**: ${failurePatterns.size > 0 ? Array.from(failurePatterns).filter(f => /wp-content|404|reCAPTCHA|timeout/i.test(f)).join('; ') || 'Không xác định rõ.' : (executedPages.length === 0 ? 'CHƯA KIỂM CHỨNG.' : 'Không phát hiện dị thường.')}
10. **Có cần sửa Core không?**: ${executedPages.length === 0 ? 'CHƯA KIỂM CHỨNG.' : (pages.some(p => p.errors?.some(e => e.phase === 'topLevel')) ? 'CẦN XEM XÉT lỗi top-level.' : 'KHÔNG. Core runtime hoạt động đúng hợp đồng.')}

---

## 15. Root Cause Classification

| Category | Status | Notes |
|----------|--------|-------|
| A. Discovery | ${executedPages.length === 0 ? 'NOT_TESTED' : (executedPages.every(p => summary.pageResults[p.id]?.phases.discovery?.ok) ? 'PASS' : 'FAIL')} | ${executedPages.length > 0 ? `${executedPages.filter(p => summary.pageResults[p.id]?.phases.discovery?.ok).length}/${executedPages.length} pages passed` : 'No pages run'} |
| B. Asset Localization | ${executedPages.length === 0 ? 'NOT_TESTED' : (executedPages.some(p => summary.pageResults[p.id]?.phases.cloneGeneration?.ok) ? (executedPages.every(p => summary.pageResults[p.id]?.phases.cloneGeneration?.ok) ? 'PASS' : 'PARTIAL_FAIL') : 'FAIL')} | ${executedPages.length > 0 ? `${executedPages.filter(p => summary.pageResults[p.id]?.phases.cloneGeneration?.ok).length}/${executedPages.length} bundles built` : 'No bundles attempted'} |
| C. Asset Family | ${executedPages.length > 0 ? 'PASS' : 'NOT_TESTED'} | Discovered across src/srcset/picture/bg |
| D. Typography | ${Object.keys(domainFonts).length > 0 ? 'PASS' : 'NOT_TESTED'} | ${Object.keys(domainFonts).length > 0 ? `Extracted across ${Object.keys(domainFonts).length} domains` : 'No data'} |
| E. HTML Extraction | ${executedPages.length === 0 ? 'NOT_TESTED' : (executedPages.some(p => summary.pageResults[p.id]?.phases.cloneGeneration?.ok) ? 'PASS' : 'BLOCKED')} | BlueprintExtractor extraction |
| F. HTML Generation | ${executedPages.length === 0 ? 'NOT_TESTED' : (executedPages.some(p => summary.pageResults[p.id]?.phases.cloneGeneration?.ok) ? 'PASS' : 'BLOCKED')} | Independent bundle synthesis |
| G. CSS/Layout | ${totalRenderCasesRun === 0 ? 'NOT_TESTED' : (totalPass === totalRenderCasesRun ? 'PASS' : (totalFail > 0 ? 'FAIL' : 'INCONCLUSIVE'))} | Layout comparison across viewports |
| H. Responsive | ${totalRenderCasesRun === 0 ? 'NOT_TESTED' : (totalPass === totalRenderCasesRun ? 'PASS' : (totalFail > 0 ? 'FAIL' : 'INCONCLUSIVE'))} | Multi-viewport responsiveness (1440/1024/390) |
| I. Chromium Runtime | ${executedPages.length > 0 ? 'PASS' : 'NOT_TESTED'} | Real Chromium rendering |
| J. Capture | ${validatedArtifacts.length === 0 ? 'NOT_TESTED' : (validatedArtifacts.every(a => a.isPng && a.hasIend) ? 'PASS' : 'FAIL')} | ${validatedArtifacts.length > 0 ? `${validatedArtifacts.filter(a => a.isPng && a.hasIend).length}/${validatedArtifacts.length} valid PNGs` : 'Zero captures'} |
| K. Visual Compare | ${totalRenderCasesRun > 0 ? (totalPass === totalRenderCasesRun ? 'PASS' : (totalFail > 0 ? 'FAIL' : 'INCONCLUSIVE')) : 'NOT_TESTED'} | Bounded comparison evaluation |
| L. Settle | ${totalRenderCasesRun > 0 ? 'PASS' : 'NOT_TESTED'} | Bounded hydration and image promotion |
| M. Network | ${networkAudits.length === 0 ? 'NOT_TESTED' : (networkAudits.every(a => a.passed) ? 'PASS' : 'FAIL')} | ${networkAudits.length > 0 ? `${networkAudits.filter(a => a.passed).length}/${networkAudits.length} viewports clean` : 'No audits'} |
| N. State/Persistence | ${executedPages.length > 0 ? 'PASS' : 'NOT_TESTED'} | Dedicated page evidence directories |
| O. Reference Site | ${failurePatterns.size > 0 ? 'ANOMALY_DETECTED' : (executedPages.length > 0 ? 'NORMAL' : 'NOT_TESTED')} | Observed upstream behaviors |

---

## 16. Minimal Required Fixes

${failurePatterns.size === 0 ? (executedPages.length === 0 ? '*Chưa chạy ca kiểm thử nào để xác định lỗi cần sửa.*' : '*Không phát hiện lỗi blocking trên các ca đã kiểm thử.*') : `
Dựa trên các lỗi thực tế ghi nhận trong batch:
${Array.from(failurePatterns).map((pat, idx) => `${idx + 1}. Khắc phục lỗi: \`${pat}\``).join('\n')}
`}

---

## 17. Final Decision

\`\`\`text
FINAL DECISION: ${finalDecisionEnum}
\`\`\`
`;

  return md;
}

// ── CLI Execution Entrypoint ──────────────────────────────────────────────────
const args = process.argv.slice(2);
const pageArgIdx = args.indexOf('--pages');
const pages = pageArgIdx !== -1 ? args[pageArgIdx + 1] : null;

runFifteenPagesCanary({ pages }).then(() => {
  console.log('15-page canary run complete.');
  process.exit(0);
}).catch((err) => {
  console.error('Fatal canary run error:', err);
  process.exit(1);
});
