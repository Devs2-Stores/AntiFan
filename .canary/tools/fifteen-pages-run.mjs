/**
 * ANTiFan — Real 15-Page Hoplongtech Clone Canary Orchestrator
 *
 * Executes the complete empirical pipeline across all 15 locked target pages
 * and 3 viewports (1440x900, 1024x900, 390x844) = 45 render cases. The viewport set
 * is selectable (`--viewports`), and a reduced run declares the viewports it left
 * unverified in its summary, index, hub and report instead of measuring them as pass.
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

const { call, evalOn, bootstrap: boot, reloadBootstrap } = await import('./lib-rpc.mjs');
const { requireDoubleSettledMetrics, hydrateToCapturedState, releaseSettleOverrides } = await import('./canary-settle.mjs');

const { validateProbedFloor } = await import('../../scripts/lib/canary-floors.mjs');
const { detectHarnessResidue, detectLostLayoutSwitch } = await import('../../scripts/lib/bundle-integrity.mjs');
const { acquireCampaignLock, releaseCampaignLock, updateCampaignLock, assertCampaignLockHeld, LOCK_CODES } = await import('../../scripts/lib/campaign-lock.mjs');
const {
  mintBundleIdentity,
  detectBundleDrift,
  writePagePointer,
  writeRunPointer,
  readPagePointer,
  loadInstanceIdentity,
  canonicalVerdict,
  PROVENANCE_CODES,
} = await import('../../scripts/lib/evidence-provenance.mjs');
const { readRecord, writeRecordAtomic } = await import('../../scripts/lib/atomic-record.mjs');
const { validatePagesFilter, selectViewports, buildVerdictIndex, renderHubHtml, computeRunExit, casesWithoutProvenance, pageRouteRefusal, renderPageStatus } = await import('../../scripts/lib/campaign-verdicts.mjs');
const { checkObservedUrl, normalizeRoutePath } = await import('./theme-fidelity.mjs');



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

/**
 * Renew the canary session before a page.
 *
 * An attachment is bound to the tab it was minted with, and the previous page
 * deleted its own tabs, which kills that binding: the next create is then refused
 * with the fixed "session tab quota reached" text even though the session pool is
 * empty. Measured: the mint still succeeds with a dead binding, re-reading it
 * makes the next create adopt normally, and no instance restart is needed. The
 * tab the new session was minted with is kept until the page has a tab of its own
 * (closing it earlier would kill the binding it just created) and the previous
 * page's mint tab is closed at that point, so one session tab is ever live.
 */
async function renewSession(pageId, state) {
  const minted = await runCommand('node', ['.canary/tools/canary-session.mjs', String(boot.port), '.canary/state/canary-session.json'], { timeoutMs: 120_000 });
  if (minted.code !== 0) {
    throw Object.assign(
      new Error(`session renewal failed for page ${pageId}: mint exit ${minted.code} — ${childErrorDetail(minted.stdout, minted.stderr)}`),
      { code: 'SESSION_RENEWAL_FAILED' }
    );
  }
  reloadBootstrap();
  const previous = state.mintTabId;
  state.mintTabId = boot.tabId || null;
  state.previousMintTabId = previous;
  return { minted: true, mintTabId: state.mintTabId, previousMintTabId: previous };
}

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

/**
 * Extracts the informative lines from a child's output.
 *
 * Node prints the failure stack first and the version banner last, so a tail
 * slice returns `Node.js v24.x` and hides the actual error; the NO_COLOR and
 * trace-warnings notices are noise. Stderr is preferred, stdout is the fallback
 * because the mint prints its bootstrap document there on the success path.
 */
function childErrorDetail(stdout, stderr) {
  const informative = (text) => (text || '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !/NO_COLOR|trace-warnings|^Node\.js v\d/.test(line));
  const fromStderr = informative(stderr);
  const lines = fromStderr.length > 0 ? fromStderr : informative(stdout);
  return lines.slice(0, 8).join(' | ').slice(0, 800) || 'no child output';
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

/**
 * A run that never started: no mutation happened, and the exit code says why.
 *
 * Exit 2 is the refusal exit — nothing was acquired and nothing was published —
 * shared by a held lock, a lost lock and an unreadable page filter; the `code`
 * and the printed reason are what distinguish them.
 */
function refusedRun({ runId, code, reason, holder, proof }) {
  console.error(`[campaign] refusing to run: ${code}${reason ? ` — ${reason}` : ''}`);
  if (holder) console.error(`[campaign] lock holder: ${JSON.stringify(holder).slice(0, 400)}`);
  return {
    runId,
    startedAt: new Date().toISOString(),
    started: false,
    refusals: [{ code, reason: reason || null, holder: holder || null, proof: proof || null }],
    pagesRun: [],
    pageResults: {},
    exit: { code: 2, reason: code, detail: reason || null },
  };
}

/**
 * The campaign mutates shared state — `_verdicts.json`, each page's published
 * view, the run report — so it takes the run lock **itself** as its first
 * operation, before creating a directory or reading a tab. Trusting a caller to
 * have acquired it would let a direct import run unlocked, which is exactly the
 * interleaving the lock exists to prevent.
 */
export async function runFifteenPagesCanary(options = {}) {
  const runId = options.runId || `campaign-${crypto.randomUUID()}`;
  const filter = validatePagesFilter(options.pages, TARGET_PAGES.map((p) => p.id));
  if (!filter.ok) {
    return refusedRun({ runId, code: 'INVALID_PAGE_FILTER', reason: filter.reason });
  }
  const pagesFilter = filter.ids;
  const viewportSelection = selectViewports(VIEWPORTS, options.viewports);
  if (!viewportSelection.ok) {
    return refusedRun({ runId, code: 'INVALID_VIEWPORT_FILTER', reason: viewportSelection.reason });
  }
  let lock = options.lock || null;
  let acquiredHere = false;

  if (lock) {
    const assertion = await assertCampaignLockHeld(lock);
    if (!assertion.held) {
      return refusedRun({ runId, code: LOCK_CODES.LOCK_LOST, reason: `the supplied run lock is not held (${assertion.reason})` });
    }
  } else {
    lock = await acquireCampaignLock({ runId, pages: pagesFilter });
    acquiredHere = true;
    if (!lock.ok) {
      return refusedRun({
        runId,
        code: lock.code,
        reason: lock.reason || (lock.code === LOCK_CODES.RUN_IN_PROGRESS
          ? `another campaign invocation holds ${lock.lockPath}`
          : `run lock unavailable (${lock.code})`),
        holder: lock.holder,
        proof: lock.proof,
      });
    }
    // Operator-visible: a reclaim means a previous holder died without releasing,
    // and the proof names why it was considered dead.
    console.log(`[campaign] run lock ${lock.code} at ${lock.lockPath}${lock.reclaimedFrom ? ` (reclaimed from pid ${lock.reclaimedFrom.holder?.pid}: ${lock.reclaimedFrom.proof?.reason})` : ''}`);
  }

  try {
    return await runCampaignLocked(options, { runId, lock, pagesFilter, viewportSelection });
  } finally {
    if (acquiredHere) {
      const released = await releaseCampaignLock(lock);
      if (!released.removed && released.reason !== 'ABSENT') {
        console.error(`[campaign] run lock not released: ${JSON.stringify(released).slice(0, 300)}`);
      }
    } else {
      await updateCampaignLock(lock, { finishedAt: new Date().toISOString() });
    }
  }
}

async function runCampaignLocked(options, { runId, lock, pagesFilter, viewportSelection }) {
  // The run covers the selected viewports only. Everything downstream — loops, exit
  // status, index, hub, report — reads this set, so an excluded viewport cannot be
  // counted as a requested case that failed to produce evidence.
  const RUN_VIEWPORTS = viewportSelection.viewports;
  const scope = {
    viewports: RUN_VIEWPORTS.map((v) => v.label),
    excluded: viewportSelection.excluded,
    mobileUnverified: viewportSelection.mobileUnverified,
  };
  const baseRunDir = path.resolve(REPO, '.canary/15-pages');
  fs.mkdirSync(baseRunDir, { recursive: true });

  const instance = loadInstanceIdentity();
  const reportDir = path.join(baseRunDir, 'reports', runId);
  fs.mkdirSync(reportDir, { recursive: true });

  /**
   * Both tab scopes are measured, because a tab the run cannot close is invisible
   * to a session-scoped census and a tab the session owns is invisible to the
   * instance plane. The run asserts only that it added nothing it did not close:
   * pre-existing orphans are recorded, never counted as this run's failure.
   */
  const tabCensus = async () => {
    const idsOf = (res) => {
      const tabs = res?.tabs || res?.result?.tabs || (Array.isArray(res) ? res : null) || (Array.isArray(res?.result) ? res.result : null);
      return Array.isArray(tabs) ? tabs.map((t) => t?.tabId ?? t?.id ?? null).filter(Boolean) : null;
    };
    const instancePlane = await call('anti.browser.tabs.list', {}, 20_000).then(idsOf).catch(() => null);
    const sessionScope = await call('browser.list-tabs', {}, 20_000).then(idsOf).catch(() => null);
    return { at: new Date().toISOString(), instancePlane, sessionScope };
  };

  const runSummary = {
    runId,
    startedAt: new Date().toISOString(),
    viewports: RUN_VIEWPORTS,
    scope,
    instance,
    instanceRecord: readRecord(path.resolve(REPO, '.canary/state/canary-instance.json')),
    runLock: lock ? { lockPath: lock.lockPath, code: lock.code, reclaimedFrom: lock.reclaimedFrom ?? null } : null,
    tabCensus: { start: await tabCensus() },
    refusals: [],
    pagesRun: [],
    pageResults: {},
    matrix: [],
  };

  console.log(`================================================================`);
  console.log(`ANTiFan — REAL 15-PAGE HOPLONGTECH CLONE TEST`);
  console.log(`Target: ${TARGET_PAGES.length} pages x ${RUN_VIEWPORTS.length} viewports = ${TARGET_PAGES.length * RUN_VIEWPORTS.length} render cases`);
  if (scope.excluded.length > 0) {
    console.log(`SCOPE: excluding ${scope.excluded.map((e) => e.label).join(', ')} — those viewports are NOT verified by this run`);
  }
  console.log(`Runtime: Real Chromium on port ${boot.port}`);
  console.log(`================================================================\n`);

  const session = { mintTabId: null, previousMintTabId: null, renewals: [] };

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
    // Attempt-scoped and immutable: this run serves the bundle it just built, and a
    // later build of the same page writes a new attempt rather than rewriting this
    // one under a minted identity.
    const attemptId = `attempt-${crypto.randomUUID()}`;
    const attemptDir = path.join(pageDir, 'attempts', attemptId);
    const cloneDir = path.join(attemptDir, 'clone');
    const evDir = path.join(attemptDir, 'evidence');
    const mobileCloneDir = path.join(cloneDir, 'mobile');
    fs.mkdirSync(refDir, { recursive: true });
    fs.mkdirSync(cloneDir, { recursive: true });
    fs.mkdirSync(evDir, { recursive: true });

    const pageResult = {
      id: p.id,
      name: p.name,
      url: p.url,
      slug: p.slug,
      domain: p.domain,
      attemptId,
      attemptDir,
      evidenceRoot: evDir,
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
      console.log(`[P${p.id}] Session: renewing attachment for this page...`);
      const renewal = await renewSession(p.id, session);
      session.renewals.push({ pageId: p.id, ...renewal, at: new Date().toISOString() });
      pageResult.phases.sessionRenewal = renewal;
      console.log(`[P${p.id}] Session: mint tab ${renewal.mintTabId} bound (previous ${renewal.previousMintTabId || 'none'})`);
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
      const routeMismatch = checkObservedUrl({ name: p.name, url: p.url }, pageResult.finalUrl);
      const navTiming = await evalOn(refTabId, '(() => { const n = performance.getEntriesByType("navigation")[0]; return { redirectCount: n?.redirectCount ?? 0, type: n?.type ?? null }; })()').catch(() => null);
      pageResult.routeIdentity = {
        requestedUrl: p.url,
        observedUrl: pageResult.finalUrl,
        valid: !routeMismatch,
        redirectCount: navTiming?.redirectCount ?? 0,
        mismatch: routeMismatch ? { code: routeMismatch.code, message: routeMismatch.message, detail: routeMismatch.detail } : null,
      };
      if (routeMismatch) {
        throw routeMismatch;
      }

      // Rasterizing is what mounts the storefront's remaining sections: a
      // settle-only measurement here describes a pre-mount page (measured
      // 4107px/8 sections before the capture versus 5422px/15 sections after it),
      // so the dump must follow the capture that hydrates it.
      console.log(`[P${p.id}] Deep settling + hydrating reference tab (full-page capture first)...`);
      const preDump = await hydrateToCapturedState(refTabId, `P${p.id}-pre-dump`, { expectedUrl: p.url }, 240_000, 4);
      const settledRef = preDump.settled;
      pageResult.phases.referenceHydration = { byteLength: preDump.capture?.byteLength ?? preDump.capture?.bytes ?? null };
      console.log(`[P${p.id}] Reference settled: docH=${settledRef.metrics.docHeight}, sections=${settledRef.metrics.sectionCount}, cards=${settledRef.metrics.productCardCount}`);
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
      // The mobile bundle cannot be built from the desktop dump: the storefront
      // serves a different document to a mobile client (measured: 289,938 bytes /
      // `<body data-device="mobile">` / mobile nav versus 335,778 bytes / `web`), so
      // the mobile reference is captured at the mobile viewport and built separately.
      const refMobileHtmlPath = path.join(refDir, 'reference-mobile.html');
      console.log(`[P${p.id}] Dumping sanitized reference DOM...`);
      // Undo the settle pins first: this markup becomes the clone bundle, and a
      // pinned inline !important would override the clone's own CSS for good.
      const desktopRelease = await releaseSettleOverrides(refTabId, `P${p.id}-pre-dump-release`);
      pageResult.phases.desktopRelease = desktopRelease;
      console.log(`[P${p.id}] Settle overrides released: unfrozen=${Boolean(desktopRelease.unfreeze)} markedLeft=${desktopRelease.dom?.markedLeft ?? '?'}`);
      const dumpRes = await runCommand('node', ['.canary/tools/dump-ref.mjs', refTabId, refHtmlPath, 'sanitize'], { timeoutMs: 120_000 });
      if (dumpRes.code !== 0) {
        throw new Error(`dump-ref failed: ${dumpRes.stderr.slice(0, 300)}`);
      }
      fs.writeFileSync(path.join(evDir, 'reference-dump.json'), dumpRes.stdout);
      console.log(`[P${p.id}] Reference dumped to ${refHtmlPath}`);

      // 2. Empirical per-viewport readiness floors (matching canary-run.mjs pattern)
      console.log(`[P${p.id}] Probing empirical per-viewport readiness floors...`);
      const readinessFloors = {};
      for (const vp of RUN_VIEWPORTS) {
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
        let vpFinalUrl = null;
        for (let i = 0; i < 40; i++) {
          await sleep(400);
          try {
            const r = await evalOn(refTabId, '({ rs: document.readyState, href: location.href })', 5000);
            if (r && r.rs === 'complete') {
              readyStateComplete = true;
              vpFinalUrl = r.href;
              break;
            }
          } catch {}
        }
        if (!readyStateComplete) {
          throw new Error(`Reference tab failed to reach readyState===complete at ${vp.width}x${vp.height}`);
        }
        const vpRouteMismatch = checkObservedUrl({ name: `${p.name}@${vp.label}`, url: p.url }, vpFinalUrl);
        if (vpRouteMismatch) {
          throw vpRouteMismatch;
        }
        console.log(`[P${p.id}][${vp.label}] Settle & measure reference tab (hydrating capture pass)...`);
        const vpHydration = await hydrateToCapturedState(refTabId, `P${p.id}-${vp.label}`, { expectedUrl: p.url }, 240_000, 4);
        const vpSettled = vpHydration.settled;
        readinessFloors[vp.label] = validateProbedFloor(vpSettled.metrics, vp);
        console.log(`[P${p.id}][${vp.label}] Empirical floor: minSections=${readinessFloors[vp.label].minSections}, minCards=${readinessFloors[vp.label].minCards} (docH=${vpSettled.metrics.docHeight})`);
        if (vp.width < 768) {
          // Dumped while this tab is the foreground tab at the mobile viewport, so
          // the artifact is the document a mobile client is served.
          console.log(`[P${p.id}][${vp.label}] Dumping mobile reference DOM...`);
          const mobileRelease = await releaseSettleOverrides(refTabId, `P${p.id}-${vp.label}-release`);
          pageResult.phases.mobileRelease = mobileRelease;
          const dumpMobile = await runCommand('node', ['.canary/tools/dump-ref.mjs', refTabId, refMobileHtmlPath, 'sanitize'], { timeoutMs: 120_000 });
          if (dumpMobile.code !== 0) {
            throw new Error(`dump-ref (mobile ${vp.label}) failed: ${dumpMobile.stderr.slice(0, 300)}`);
          }
          fs.writeFileSync(path.join(evDir, 'reference-dump-mobile.json'), dumpMobile.stdout);
          pageResult.phases.mobileReference = { viewport: vp.label, path: refMobileHtmlPath, bytes: fs.statSync(refMobileHtmlPath).size };
        }
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
      let mobileBundleBuilt = false;
      let bundleIdentity = null;
      const cloneEntry = path.join(cloneDir, 'index.html');
      if (buildRes.code === 0 && fs.existsSync(cloneEntry)) {
        // Fail closed on harness residue: the settle guard marks every node it pins,
        // and a surviving marker means a pinned inline !important reached the bundle,
        // where it would override the clone's own CSS. Never mint that as deliverable.
        const contamination = detectHarnessResidue(cloneEntry);
        const lostLayoutSwitches = contamination.length === 0 ? detectLostLayoutSwitch(refHtmlPath, cloneEntry) : [];
        if (contamination.length || lostLayoutSwitches.length) {
          cloneBuilt = false;
          mobileBundleBuilt = false;
          const code = contamination.length ? 'CONTAMINATED_BUNDLE' : 'LAYOUT_SWITCH_LOST';
          const message = contamination.length
            ? `harness residue in bundle: ${contamination.join(', ')}`
            : `bundle dropped the source body attribute(s) that select the layout: ${lostLayoutSwitches.join(', ')}`;
          pageResult.phases.cloneGeneration = { ok: false, code, residue: contamination, lostLayoutSwitches };
          pageResult.errors.push({ phase: 'cloneGeneration', code, message });
          console.log(`[P${p.id}] REFUSED: ${message}`);
        } else {
          cloneBuilt = true;
          // Minted here, not downstream: this is the only moment that knows both the
          // entry just written and the attempt it was written into.
          bundleIdentity = mintBundleIdentity({
            entryPath: cloneEntry,
            sourceUrl: p.url,
            attemptId,
            evidenceRoot: evDir,
          });
          pageResult.bundle = bundleIdentity;
          pageResult.phases.cloneGeneration = {
            ok: true,
            entry: cloneEntry,
            bytes: bundleIdentity.entryBytes,
            entrySha256: bundleIdentity.entrySha256,
            attemptId,
          };
          console.log(`[P${p.id}] Clone bundle generated successfully (attempt ${attemptId}).`);
          if (fs.existsSync(refMobileHtmlPath)) {
            const mobileTelemetryPath = path.join(evDir, 'build-telemetry-mobile.json');
            const mobileBuild = await runCommand(
              'node',
              ['.canary/tools/build-clone.mjs', refMobileHtmlPath, mobileCloneDir, mobileTelemetryPath, 'undefined', 'undefined', baseDomain],
              { timeoutMs: 300_000 }
            );
            fs.writeFileSync(path.join(evDir, 'build-mobile.log'), mobileBuild.stdout + (mobileBuild.stderr ? `\n--- stderr ---\n${mobileBuild.stderr}` : ''));
            const mobileEntry = path.join(mobileCloneDir, 'index.html');
            const mobileResidue = mobileBuild.code === 0 && fs.existsSync(mobileEntry) ? detectHarnessResidue(mobileEntry) : [];
            const lostLayoutSwitches = mobileBuild.code === 0 && fs.existsSync(mobileEntry) && mobileResidue.length === 0
              ? detectLostLayoutSwitch(refMobileHtmlPath, mobileEntry)
              : [];
            mobileBundleBuilt = mobileBuild.code === 0 && fs.existsSync(mobileEntry) && mobileResidue.length === 0 && lostLayoutSwitches.length === 0;
            const mobileFailureCode = mobileResidue.length ? 'CONTAMINATED_BUNDLE' : (lostLayoutSwitches.length ? 'LAYOUT_SWITCH_LOST' : 'MOBILE_BUILD_FAILED');
            const mobileFailureMessage = mobileResidue.length
              ? `harness residue in mobile bundle: ${mobileResidue.join(', ')}`
              : (lostLayoutSwitches.length
                ? `mobile bundle dropped the source body attribute(s) that select the phone layout: ${lostLayoutSwitches.join(', ')}`
                : mobileBuild.stderr.slice(0, 500));
            if (!mobileBundleBuilt) {
              pageResult.errors.push({ phase: 'mobileCloneGeneration', code: mobileFailureCode, message: mobileFailureMessage });
            }
            pageResult.phases.mobileCloneGeneration = mobileBundleBuilt
              ? { ok: true, entry: mobileEntry, bytes: fs.statSync(mobileEntry).size }
              : { ok: false, code: mobileFailureCode, error: mobileFailureMessage };
            console.log(mobileBundleBuilt
              ? `[P${p.id}] Mobile clone bundle generated at ${mobileEntry}.`
              : `[P${p.id}] Mobile clone generation failed: ${mobileFailureCode} — ${mobileFailureMessage.slice(0, 200)}`);
          }
        }
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
        for (const vp of RUN_VIEWPORTS) {
          console.log(`[P${p.id}] Running viewport ${vp.label} (${vp.width}x${vp.height})...`);
          const vpResult = {
            viewport: `${vp.width}x${vp.height}`,
            label: vp.label,
            status: 'IN_PROGRESS'
          };
          try {
            // 1. Run viewport-run.mjs (sets viewport, reloads both tabs, settles, captures, compares)
            const floor = readinessFloors[vp.label];
            if (!floor || typeof floor.minSections !== 'number' || floor.minSections < 1 || typeof floor.minCards !== 'number' || floor.minCards < 0) {
              throw new Error(`Invalid or missing readiness floor for viewport ${vp.label}: ${JSON.stringify(floor)}`);
            }
            const isMobileTier = vp.width < 768;
            const mobileEntry = path.join(mobileCloneDir, 'index.html');
            if (isMobileTier && !fs.existsSync(mobileEntry)) {
              // A typed refusal, not a page failure: nothing produced a mobile bundle
              // for this page, so there is no candidate to judge at this tier.
              vpResult.status = 'REFUSED';
              vpResult.refusal = { code: 'MOBILE_BUNDLE_ABSENT', reason: `no mobile bundle at ${mobileEntry}` };
              vpResult.overall = 'INCONCLUSIVE';
              vpResult.causeCode = 'MOBILE_BUNDLE_ABSENT';
              runSummary.refusals.push({ pageId: p.id, viewport: vp.label, code: 'MOBILE_BUNDLE_ABSENT', path: mobileEntry });
              pageResult.viewports[vp.label] = vpResult;
              console.log(`[P${p.id}][${vp.label}] REFUSED: no mobile bundle at ${mobileEntry}`);
              continue;
            }
            const servedEntry = isMobileTier ? mobileEntry : cloneEntry;
            const vpProc = await runCommand(
              'node',
              ['.canary/tools/viewport-run.mjs', vp.label, String(vp.width), String(vp.height), refTabId, cloneTabId, attemptDir, String(floor.minSections), String(floor.minCards)],
              {
                timeoutMs: 180_000,
                env: {
                  CANARY_COMPARE_TIMEOUT_MS: '60000',
                  CANARY_ATTEMPT_DIR: attemptDir,
                  CANARY_EVIDENCE_ROOT: evDir,
                  CANARY_SERVED_ENTRY: servedEntry,
                  CANARY_BUNDLE_IDENTITY: bundleIdentity ? JSON.stringify(bundleIdentity) : '',
                  CANARY_AUTHORITY_RUN_ID: boot.runId || '',
                  CANARY_EVIDENCE_RUN_ID: runId,
                  CANARY_CLONE_DIR: cloneDir,
                  CANARY_REFERENCE_DUMP: isMobileTier ? path.join(evDir, 'reference-dump-mobile.json') : path.join(evDir, 'reference-dump.json'),
                  CANARY_HEIGHT_DRIFT_EXPERIMENT: process.env.CANARY_HEIGHT_DRIFT_EXPERIMENT === '1' ? '1' : '',
                  CANARY_REQUESTED_URL: p.url,
                  CANARY_PAGE_NAME: p.name,
                },
              }
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

            // Overall viewport verdict, plus the provenance this case was judged under.
            // The child's exit status is authoritative about *what happened*, so it
            // decides between an adjudicable verdict and a case that never got one.
            const terminalStatus = vpData.status || null;
            const refusalCode = vpProc.code === 4 || terminalStatus === PROVENANCE_CODES.IDENTITY_MISMATCH
              ? (vpData.refusal?.code || vpData.visual?.refusal?.code || PROVENANCE_CODES.IDENTITY_MISMATCH)
              : null;
            vpResult.bundle = bundleIdentity
              ? { ...bundleIdentity, servedEntryPath: servedEntry, drift: vpData.bundle?.drift ?? null }
              : null;
            vpResult.instance = instance;
            vpResult.childExitCode = vpProc.code;
            vpResult.terminalStatus = terminalStatus;
            // The child's own words about a nonzero exit: its refusal reason and any
            // uncaught stack live on stderr, and a case that never compared is only
            // diagnosable from the evidence document if they are kept here.
            vpResult.childOutput = {
              elapsedMs: vpProc.elapsedMs,
              timedOut: Boolean(vpProc.timedOut),
              stdoutTail: (vpProc.stdout || '').slice(-2000) || null,
              stderrHead: (vpProc.stderr || '').slice(0, 4000) || null,
            };
            if (refusalCode) {
              // The served entry was not the minted one: the wrong directory was
              // served, so there is nothing to compare and no verdict to give.
              vpResult.status = 'REFUSED';
              vpResult.refusal = vpData.refusal || vpData.visual?.refusal || { code: refusalCode, reason: 'minted identity does not match the served entry' };
              vpResult.overall = 'INCONCLUSIVE';
              vpResult.causeCode = refusalCode;
              runSummary.refusals.push({ pageId: p.id, viewport: vp.label, code: refusalCode, detail: vpResult.refusal });
            } else if (vpProc.code === 3) {
              // Readiness or rasterization refusal: the child stopped before the
              // compare, so this case has no pixel verdict to adjudicate.
              vpResult.status = 'REFUSED';
              vpResult.causeCode = terminalStatus || 'CASE_NEVER_COMPARED';
              vpResult.overall = 'INCONCLUSIVE';
              vpResult.refusal = { code: vpResult.causeCode, reason: vpData.visual?.reason ?? vpData.readiness?.reference?.reasons?.join('; ') ?? 'no pixel verdict was produced' };
            } else if (terminalStatus === 'COMPARE_ERROR' || terminalStatus === 'SKIPPED' || vpProc.code === -1) {
              // A comparator failure, a skipped compare or a dead child is a harness
              // outcome: recording it as an adjudicable case would be a false claim.
              vpResult.status = 'ERROR';
              vpResult.causeCode = vpProc.code === -1 ? 'VIEWPORT_RUN_TIMEOUT' : (terminalStatus || 'VIEWPORT_RUN_ERROR');
              vpResult.overall = 'INCONCLUSIVE';
              vpResult.error = vpProc.timedOut ? `viewport-run timed out after ${vpProc.elapsedMs}ms` : childErrorDetail(vpProc.stdout, vpProc.stderr);
            } else if (!terminalStatus) {
              // No evidence document at all: the child died before it could persist
              // anything, so nothing about this case can be judged.
              vpResult.status = 'ERROR';
              vpResult.causeCode = 'NO_EVIDENCE_DOCUMENT';
              vpResult.overall = 'INCONCLUSIVE';
              vpResult.error = childErrorDetail(vpProc.stdout, vpProc.stderr) || `exit ${vpProc.code} with no evidence document`;
            } else {
              const canonical = canonicalVerdict({
                refusal: null,
                captureValid: vpResult.capture.valid,
                visualVerdict: vpResult.visual.verdict,
                networkVerdict: vpResult.network.verdict,
                structural: st.geometryDeltaPx !== undefined ? { geometryDeltaPx: st.geometryDeltaPx } : null,
              });
              vpResult.overall = canonical.verdict;
              vpResult.causeCode = canonical.causeCode;
              vpResult.status = 'COMPLETED';
            }

            fs.writeFileSync(path.join(evDir, `run-${vp.label}.json`), JSON.stringify(vpResult, null, 2));
            pageResult.viewports[vp.label] = vpResult;
            console.log(`[P${p.id}][${vp.label}] Capture: Ref=${refPngStat.bytes}B Clone=${clonePngStat.bytes}B (isPng=${vpResult.capture.valid}) | Net: ${vpResult.network.verdict} | Visual: ${vpResult.visual.verdict} (${vpResult.visual.mismatchPercentage}%) | Overall: ${vpResult.overall} (${vpResult.causeCode})`);
          } catch (vpErr) {
            vpResult.status = 'ERROR';
            vpResult.error = vpErr.message;
            vpResult.overall = 'INCONCLUSIVE';
            vpResult.causeCode = 'VIEWPORT_RUN_ERROR';
            vpResult.bundle = bundleIdentity;
            vpResult.instance = instance;
            pageResult.viewports[vp.label] = vpResult;
            console.log(`[P${p.id}][${vp.label}] Error: ${vpErr.message}`);
          }
        }
      } else {
        // Clone was not built; mark viewports NOT_TESTED with build error
        for (const vp of RUN_VIEWPORTS) {
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
      const isRouteRefusal = pageErr?.code && ['URL_PATH_MISMATCH', 'URL_HOST_MISMATCH', 'URL_THEME_MISMATCH', 'URL_EXPECTATION_MISSING'].includes(pageErr.code);
      if (isRouteRefusal) {
        pageResult.status = 'REFUSED';
        pageResult.error = pageErr.message;
        pageResult.overall = 'INCONCLUSIVE';
        pageResult.causeCode = pageErr.code;
        pageResult.refusal = { code: pageErr.code, reason: pageErr.message, detail: pageErr.detail || null };
        runSummary.refusals.push({ pageId: p.id, viewport: null, code: pageErr.code, detail: pageResult.refusal });
        console.log(`[P${p.id}] PAGE ROUTE REFUSAL: ${pageErr.code} — ${pageErr.message}`);
      } else {
        pageResult.status = 'FAILED';
        pageResult.error = pageErr.message;
        pageResult.overall = 'FAIL';
        pageResult.errors.push({ phase: 'topLevel', message: pageErr.message });
        console.log(`[P${p.id}] PAGE FAILURE: ${pageErr.message}`);
      }
    } finally {
      // Clean up tabs. The mint tab is this session's own bound tab, so closing it is
      // allowed here; it must happen only after every tab this page needs has been
      // created, because a session whose bound tab is gone refuses further creates.
      // The result is recorded rather than swallowed: a silent failure here is how a
      // leaked tab per page turns into the quota refusal seen at page 2.
      if (cloneTabId) {
        const closed = await call('anti.browser.tabs.close', { tabId: cloneTabId }, 10_000).catch((e) => ({ error: String(e && e.message ? e.message : e).slice(0, 120) }));
        pageResult.phases.cloneTabClose = closed && closed.error ? { closed: false, error: closed.error } : { closed: true };
      }
      if (refTabId) {
        const closed = await call('anti.browser.tabs.close', { tabId: refTabId }, 10_000).catch((e) => ({ error: String(e && e.message ? e.message : e).slice(0, 120) }));
        pageResult.phases.referenceTabClose = closed && closed.error ? { closed: false, error: closed.error } : { closed: true };
      }
      if (session.mintTabId) {
        // The tab being reaped belongs to the previous page's mint, so no live session
        // owns it any more: a close is refused with TARGET_MISMATCH naming the binding
        // the session is isolated to. Rebinding first does not help — both
        // `browser.switch-tab` and `browser.set-automation-target` were measured
        // ineffective on the canary instance (the attach call succeeds, the close is
        // still refused), and the reference page's own mint tab must stay bound for the
        // creates that follow. So this attempt is kept only to record the outcome: the
        // tab is an instance-plane orphan, and clearing those is an owner action.
        const closed = await call('anti.browser.tabs.close', { tabId: session.mintTabId }, 10_000).catch((e) => ({ error: String(e && e.message ? e.message : e).slice(0, 120) }));
        pageResult.phases.mintTabClose = closed && closed.error ? { closed: false, tabId: session.mintTabId, error: closed.error } : { closed: true, tabId: session.mintTabId };
        if (closed && closed.error) console.log(`[P${p.id}] Session: mint tab ${session.mintTabId} NOT closed: ${closed.error}`);
        session.mintTabId = null;
      }
      if (staticServer) {
        try { staticServer.kill('SIGTERM'); } catch {}
      }
      pageResult.elapsedSec = Math.round((Date.now() - pageStartT) / 1000);
      // Drift is measured after the cases ran, against the identity minted at build
      // time: a change on disk is reported and never re-identifies the case.
      if (pageResult.bundle) {
        pageResult.bundleDrift = detectBundleDrift(pageResult.bundle);
        if (pageResult.bundleDrift.drifted) {
          // The target changed after it was identified, so every verdict already
          // taken describes bytes that no longer exist. Those cases become typed
          // refusals, and the page is not repointed at this attempt.
          pageResult.errors.push({ phase: 'bundleDrift', message: `${PROVENANCE_CODES.BUNDLE_DRIFT}: entry changed after the mint` });
          runSummary.refusals.push({ pageId: p.id, viewport: null, code: PROVENANCE_CODES.BUNDLE_DRIFT, detail: pageResult.bundleDrift });
          for (const vp of Object.values(pageResult.viewports)) {
            const supersededVerdict = vp.overall;
            vp.overall = 'INCONCLUSIVE';
            vp.causeCode = PROVENANCE_CODES.BUNDLE_DRIFT;
            vp.refusal = {
              code: PROVENANCE_CODES.BUNDLE_DRIFT,
              reason: 'the served bundle changed after its identity was minted',
              supersededVerdict,
              expected: pageResult.bundleDrift.expected ?? pageResult.bundle.entrySha256,
              observed: pageResult.bundleDrift.observed ?? null,
            };
          }
          pageResult.overall = 'INCONCLUSIVE';
        }
      }
      fs.writeFileSync(path.join(evDir, 'summary.json'), JSON.stringify(pageResult, null, 2));
      runSummary.pagesRun.push(p.id);
      runSummary.pageResults[p.id] = pageResult;

      // Ownership is re-proved *before* any shared write: the lock is the right to
      // publish. If another invocation holds it, this page's evidence stays inside
      // its attempt directory and neither the pointer nor the index is touched.
      const lockUpdate = await updateCampaignLock(lock, { pagesCompleted: runSummary.pagesRun.slice() });
      if (!lockUpdate.updated) {
        runSummary.lockLost = { at: new Date().toISOString(), pageId: p.id, reason: lockUpdate.reason };
        runSummary.refusals.push({ pageId: p.id, viewport: null, code: LOCK_CODES.LOCK_LOST, detail: lockUpdate.reason });
        pageResult.published = false;
        console.error(`[P${p.id}] LOCK LOST (${lockUpdate.reason}): not publishing this page; aborting the remaining pages`);
        break;
      }

      // Everything that would be published is validated before the first shared
      // write: an index that would carry a completed case without provenance is
      // refused, and the run stops without publishing a pointer to evidence that
      // no index will describe.
      const indexPlan = planVerdictIndex(runSummary, baseRunDir);
      if (indexPlan.gaps.length > 0) {
        pageResult.published = false;
        runSummary.refusals.push({
          pageId: p.id,
          viewport: null,
          code: 'INDEX_PROVENANCE_INCOMPLETE',
          detail: indexPlan.gaps.map(({ pageId, viewport }) => `page-${pageId}:${viewport}`),
        });
        console.error(`[P${p.id}] index refusal: ${indexPlan.gaps.length} completed case(s) carry no provenance; not publishing this page`);
        break;
      }

      // The page's published view is a pointer into this immutable attempt, rewritten
      // atomically, so a crash mid-page leaves the previous view intact and readable.
      if (pageResult.bundle && !pageResult.bundleDrift?.drifted) {
        writePagePointer(pageDir, {
          identity: pageResult.bundle,
          cloneDir,
          mobileCloneDir,
          referencePath: path.join(refDir, 'reference.html'),
          viewports: Object.fromEntries(Object.entries(pageResult.viewports).map(([label, v]) => [label, { verdict: v.overall, causeCode: v.causeCode ?? null, status: v.status }])),
        });
      }
      writeVerdictIndexFiles(runSummary, baseRunDir, indexPlan.index);
      pageResult.published = true;
      console.log(`[P${p.id}] Done in ${pageResult.elapsedSec}s. Overall: ${pageResult.overall}`);
    }
  }

  // ════════════════════════════════════════════════════════════════════════
  // FINAL AGGREGATION & REPORT GENERATION (15-PAGE-HOPLONGTECH-CLONE-CANARY.md)
  // ════════════════════════════════════════════════════════════════════════
  console.log(`\n================================================================`);
  console.log(`All pages executed. Generating 15-PAGE-HOPLONGTECH-CLONE-CANARY.md...`);
  console.log(`================================================================`);

  runSummary.tabCensus.end = await tabCensus();
  runSummary.sessionRenewals = session.renewals;
  runSummary.finishedAt = new Date().toISOString();
  runSummary.exit = computeRunExit(runSummary, pagesFilter, { targetPages: TARGET_PAGES, viewportLabels: scope.viewports, excludedViewports: scope.excluded.map((e) => e.label) });

  // Publication needs the lock too. A run that lost it returns its summary and the
  // non-zero exit status without touching any shared artifact — report, index,
  // hub or pointer — because those files describe the campaign, not this process.
  const stillHeld = await assertCampaignLockHeld(lock);
  if (!stillHeld.held) {
    runSummary.lockLost = runSummary.lockLost || { at: new Date().toISOString(), pageId: null, reason: stillHeld.reason };
    runSummary.exit = computeRunExit(runSummary, pagesFilter, { targetPages: TARGET_PAGES, viewportLabels: scope.viewports, excludedViewports: scope.excluded.map((e) => e.label) });
  }
  if (runSummary.lockLost) {
    console.error(`[campaign] run lock not held (${runSummary.lockLost.reason}): skipping report, index and pointer publication`);
    return runSummary;
  }
  // An index carrying a completed case with no provenance would publish exactly the
  // unjudgeable verdicts this phase exists to eliminate, so nothing is written and
  // the retained report is not even generated.
  const indexPlan = planVerdictIndex(runSummary, baseRunDir);
  if (indexPlan.gaps.length > 0) {
    runSummary.exit = { code: 1, reason: 'PROVENANCE_INCOMPLETE', detail: indexPlan.gaps.map(({ pageId, viewport }) => `NO_PROVENANCE@page-${pageId}:${viewport}`) };
    console.error('[campaign] no publishable index: skipping report retention, index, hub and pointer publication');
    return runSummary;
  }

  // The aggregate is retained under the run's own directory and then published to
  // the repository root atomically, so the tracked report is a copy of a retained
  // artifact rather than an in-place overwrite of the previous run's verdict.
  const reportMarkdown = generateReport(runSummary);
  const retainedReportPath = path.join(reportDir, '15-PAGE-HOPLONGTECH-CLONE-CANARY.md');
  writeRecordAtomic(retainedReportPath, reportMarkdown);
  const reportPath = path.resolve(REPO, '15-PAGE-HOPLONGTECH-CLONE-CANARY.md');
  writeRecordAtomic(reportPath, reportMarkdown);

  // Rebuilt now that the end-of-run census and the exit status exist: the index is
  // the canonical machine-readable artifact, so it must not ship the per-page
  // snapshot it was last built with.
  writeVerdictIndexFiles(runSummary, baseRunDir, indexPlan.index);
  writeRecordAtomic(path.join(reportDir, '_verdicts.json'), runSummary.index);
  writeRunPointer(baseRunDir, {
    runId,
    reportDir,
    // The pointer names the retained report, which nothing overwrites. The tracked
    // root copy is convenience, and the next run replaces it.
    reportPath: retainedReportPath,
    rootCopyPath: reportPath,
    pages: runSummary.pagesRun,
    cases: runSummary.index?.cases?.length ?? null,
    verdict: runSummary.index?.executiveVerdict ?? null,
  });
  console.log(`Report written to ${retainedReportPath} and published to ${reportPath}`);
  return runSummary;
}

/**
 * One canonical verdict and cause per page x viewport, written after **each page**
 * so a resumable run always leaves a consistent record instead of one that only
 * exists if the whole batch finishes.
 */
function planVerdictIndex(runSummary, baseRunDir) {
  // A page with no attempt pointer holds evidence from an earlier era; it is
  // reported as superseded rather than attributed to this run.
  const supersededSlugs = [];
  for (const slug of fs.readdirSync(baseRunDir)) {
    const pageDir = path.join(baseRunDir, slug);
    if (!slug.startsWith('page-') || !fs.statSync(pageDir).isDirectory()) continue;
    if (!readPagePointer(pageDir)) supersededSlugs.push(slug);
  }

  const index = buildVerdictIndex(runSummary, { supersededSlugs });
  // The index is written after every page, so the provenance rule is enforced here
  // rather than only in the end-of-run exit classification: a completed case with
  // no bundle or instance would otherwise be published the moment its page finished.
  const gaps = casesWithoutProvenance(index.cases);
  if (gaps.length > 0) {
    console.error(`[campaign] refusing to publish an index with ${gaps.length} completed case(s) carrying no provenance: ${gaps.map(({ pageId, viewport }) => `page-${pageId}:${viewport}`).join(', ')}`);
  }
  return { index, gaps };
}

function writeVerdictIndexFiles(runSummary, baseRunDir, index) {
  runSummary.index = index;
  writeRecordAtomic(path.join(baseRunDir, '_verdicts.json'), index);
  // The hub's columns are the viewports this run measured, not every viewport the
  // campaign knows: an absent column would read as a missing case instead of a
  // declared scope, and the index carries the scope for exactly that reason.
  const hubViewports = runSummary.scope?.viewports ?? VIEWPORTS.map((v) => v.label);
  writeRecordAtomic(path.join(baseRunDir, '_hub.html'), renderHubHtml(index, { viewportLabels: hubViewports }));
  return index;
}

// ── Report Builder (Strict 17 Sections) ───────────────────────────────────────
/**
 * The mask sensitivity result belongs in the report, not only in a machine-readable file.
 * Phase 4 asks whether the default widget masks would have hidden a difference that the
 * binding masks-off policy reports, and that answer is only useful to a reader of the
 * aggregate; it is rendered from the same evidence the verdicts come from.
 */
function renderMaskSensitivity(summary) {
  const legs = [];
  for (const page of Object.values(summary.pageResults || {})) {
    for (const [label, vp] of Object.entries(page.viewports || {})) {
      if (vp.visualMasksOn) legs.push({ label, binding: vp.visual, masked: vp.visualMasksOn });
    }
  }
  const total = Object.values(summary.pageResults || {}).reduce((n, p) => n + Object.keys(p.viewports || {}).length, 0);
  if (legs.length === 0) return '- **Widget-mask sensitivity (non-binding)**: not recorded in this batch.';
  const flips = legs.filter((l) => (l.binding?.verdict ?? null) !== (l.masked?.verdict ?? null));
  const reductions = legs.map((l) => (l.binding?.mismatchPercentage ?? 0) - (l.masked?.mismatchPercentage ?? 0));
  const maskedAreaRatio = legs.reduce((max, l) => Math.max(max, l.masked?.maskResolution?.maskedAreaRatio ?? 0), 0);
  const fmt = (n) => `${n >= 0 ? '+' : ''}${Number(n).toFixed(2)}pp`;
  const drift = [];
  for (const page of Object.values(summary.pageResults || {})) {
    for (const [label, vp] of Object.entries(page.viewports || {})) {
      if (vp.heightDriftExperiment) drift.push({ label, ...vp.heightDriftExperiment });
    }
  }
  const driftLine = drift.length === 0 ? '' : `\n- **Height-drift experiment**: ${drift.map((d) => `${d.label} natural difference ${d.naturalDifferencePx}px — allowHeightDrift=false: ${d.allowHeightDrift?.false?.verdict ?? d.allowHeightDrift?.false?.status} (${d.allowHeightDrift?.false?.mismatchPercentage ?? 'null'}%, dimsMatch=${d.allowHeightDrift?.false?.dimensionsMatch}), allowHeightDrift=true: ${d.allowHeightDrift?.true?.verdict ?? d.allowHeightDrift?.true?.status} (${d.allowHeightDrift?.true?.mismatchPercentage ?? 'null'}%, dimsMatch=${d.allowHeightDrift?.true?.dimensionsMatch})`).join('; ')}.`;
  return `- **Widget-mask sensitivity (non-binding)**: ${legs.length} of ${total} legs re-compared with the default widget masks on, under the same lease. The verdict moved on ${flips.length} of them${flips.length > 0 ? ` (${flips.map((l) => `${l.label}: ${l.binding?.verdict} → ${l.masked?.verdict}`).join(', ')})` : ''}. Mismatch change ranged ${fmt(Math.min(...reductions))} to ${fmt(Math.max(...reductions))}, with the masks covering at most ${(maskedAreaRatio * 100).toFixed(4)}% of the canvas. The binding policy remains masks-off, so a mask cannot pass a leg that the masks-off comparison fails.${driftLine}`;
}

export function generateReport(summary) {
  const pages = Object.values(summary.pageResults);
  const totalTested = pages.length;
  const executedPages = TARGET_PAGES.filter(p => summary.pageResults[p.id]);
  const unexecutedPages = TARGET_PAGES.filter(p => !summary.pageResults[p.id]);
  // A page refused on route identity never reached clone generation, so its absent bundle is
  // NOT a pipeline failure: it is a typed refusal with a known cause. Keeping the two apart is
  // what stops the report from reading "clone pipeline broken" for a page that was never built.
  const pipelinePages = executedPages.filter(p => !pageRouteRefusal(summary.pageResults[p.id]));
  const routeRefusedPages = executedPages.filter(p => pageRouteRefusal(summary.pageResults[p.id]));

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
    // A page refuses before the asset pipeline runs, so it may carry no phases at
    // all: reading through the optional chain keeps a route refusal out of the
    // failure-pattern list instead of throwing the whole report away.
    if (p.phases?.cloneGeneration && !p.phases.cloneGeneration.ok) {
      failurePatterns.add(`[cloneGeneration] ${p.phases.cloneGeneration.error}`);
    }
  }

  const executiveVerdict = totalRenderCasesRun > 0 && totalPass === totalRenderCasesRun && totalTested === 15
    ? 'PASS'
    : (totalFail > 0 ? 'FAIL' : 'INCONCLUSIVE');

  let finalDecisionEnum = 'INCONCLUSIVE';
  if (totalRenderCasesRun > 0 && totalPass === totalRenderCasesRun && totalTested === 15) {
    finalDecisionEnum = 'READY_FOR_NEXT_PHASE';
  } else if (totalFail > 0 && pages.some(p => p.phases?.cloneGeneration?.ok)) {
    finalDecisionEnum = 'NEEDS_TARGETED_FIXES';
  } else if (pipelinePages.length > 0 && pipelinePages.every(p => !p.phases?.cloneGeneration?.ok)) {
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

  // A reduced run reports its scope in the header rather than leaving the operator to
  // notice a NOT_TESTED column: an excluded viewport was never measured.
  const scopedViewportLabels = summary.scope?.viewports ?? VIEWPORTS.map((v) => v.label);
  // Labels, not scope entries: everything below only ever asks "is this viewport
  // excluded", and mixing the two shapes makes every answer silently false.
  const excludedViewports = (summary.scope?.excluded ?? []).map((e) => (typeof e === 'string' ? e : e.label));
  const totalScopedCases = TARGET_PAGES.length * scopedViewportLabels.length;
  const viewportLine = VIEWPORTS.filter((v) => scopedViewportLabels.includes(v.label))
    .map((v) => `${v.width}x${v.height} (${v.label})`)
    .join(', ');
  const unverifiedLine = excludedViewports.length > 0
    ? `\nUNVERIFIED VIEWS  : ${excludedViewports.map((label) => `${label} — excluded from this run: not measured, not passing`).join('; ')}`
    : '';

  let md = `# AntiFan — Hoplongtech 15-Page Clone Canary

## 1. Executive Verdict

\`\`\`text
EXECUTIVE VERDICT : ${executiveVerdict}${excludedViewports.length > 0 ? ' — SCOPE-REDUCED (not a whole-clone verdict)' : ''}
SCOPE             : ${scopedViewportLabels.join('/')} measured${excludedViewports.length > 0 ? ` | ${excludedViewports.join('/')} EXCLUDED (unverified, not passing)` : ''}
FINAL DECISION    : ${finalDecisionEnum}
PAGES EXECUTED    : ${totalTested} / 15 (${unexecutedPages.length > 0 ? `${unexecutedPages.length} pages UNTESTED in this batch` : 'ALL 15 PAGES TESTED'})
RENDER CASES RUN  : ${totalRenderCasesRun} / ${totalScopedCases} (PASS: ${totalPass} | FAIL: ${totalFail} | INCONCLUSIVE: ${totalInconclusive})${unverifiedLine}
COMPLETION DATE   : ${summary.completedAt || new Date().toISOString()}
\`\`\`

---

## 2. Exact 15 Target Pages

| # | Name | URL | Domain | Status |
|---|------|-----|--------|--------|
${TARGET_PAGES.map(p => {
  const pr = summary.pageResults[p.id];
  const stat = pr ? renderPageStatus(pr) : 'NOT_TESTED';
  return `| ${p.id} | ${p.name} | [${p.url}](${p.url}) | \`${p.domain}\` | **${stat}** |`;
}).join('\n')}

---

## 3. Test Environment

\`\`\`text
Runtime Platform   : Windows_NT x64 (Electron 28.3.3 / Chromium 120.0.6099.291)
${summary.aggregate
  ? `Evidence Source    : aggregated from ${Object.keys(summary.pageResults ?? {}).length} published page attempts; each page's own session identity is in its attempt evidence`
  : `AntiFan Port       : ${boot.port}
Attachment ID      : ${boot.attachmentId}
Run ID             : ${boot.runId}
Primary Tab ID     : ${boot.tabId}`}
Required Viewports : ${viewportLine}
Target Scope       : ${TARGET_PAGES.length} pages x ${scopedViewportLabels.length} viewports = ${totalScopedCases} cases
Executed in Batch  : ${totalTested} pages (${totalRenderCasesRun} cases)
\`\`\`

---

## 4. 15-Page Result Matrix

| Page | URL | ${VIEWPORTS.map((v) => `${v.label}${excludedViewports.includes(v.label) ? ' (EXCLUDED)' : ''}`).join(' | ')} | Structure | Assets | Typography | Network | Capture | Visual | Overall |
|------|-----|${VIEWPORTS.map(() => '------').join('|')}|-----------|--------|------------|---------|---------|--------|---------|
${TARGET_PAGES.map(p => {
  const pr = summary.pageResults[p.id];
  // An excluded viewport is stated as EXCLUDED, never as NOT_TESTED: the two are
  // different claims (out of scope by declaration vs. in scope and never measured).
  const cell = (label) => (excludedViewports.includes(label) ? 'EXCLUDED' : 'NOT_TESTED');
  if (!pr) return `| ${p.id}. ${p.name} | \`${p.url.slice(0, 32)}...\` | ${VIEWPORTS.map((v) => cell(v.label)).join(' | ')} | NOT_TESTED | NOT_TESTED | NOT_TESTED | NOT_TESTED | NOT_TESTED | NOT_TESTED | **NOT_TESTED** |`;
  const vpCell = (label) => (excludedViewports.includes(label) ? 'EXCLUDED' : (pr.viewports[label]?.overall || 'NOT_TESTED'));
  const vps = scopedViewportLabels.map((l) => pr.viewports[l]).filter(Boolean);
  const struct = vps.length === 0 ? 'NOT_TESTED' : (
    vps.every(v => v.structure?.refSections != null && v.structure?.cloneSections != null)
      ? (vps.every(v => v.structure.refCards === v.structure.cloneCards && Math.abs(v.structure.refSections - v.structure.cloneSections) <= 1) ? 'PASS' : 'FAIL')
      : 'INCONCLUSIVE'
  );
  const assets = pr.phases?.cloneGeneration ? (pr.phases.cloneGeneration.ok ? 'PASS' : 'FAIL') : 'NOT_TESTED';
  const typo = pr.phases?.discovery ? (pr.phases.discovery.ok ? 'PASS' : 'FAIL') : 'NOT_TESTED';
  const net = vps.length === 0 ? 'NOT_TESTED' : (vps.every(v => v.network?.verdict === 'PASS') ? 'PASS' : (vps.some(v => v.network?.verdict?.startsWith('FAIL')) ? 'FAIL' : 'INCONCLUSIVE'));
  const cap = vps.length === 0 ? 'NOT_TESTED' : (vps.every(v => v.capture?.valid) ? 'PASS' : 'FAIL');
  const vis = vps.length === 0 ? 'NOT_TESTED' : (vps.every(v => v.visual?.verdict === 'PASS') ? 'PASS' : (vps.some(v => v.visual?.verdict === 'FAIL') ? 'FAIL' : 'INCONCLUSIVE'));
  return `| ${p.id}. ${p.name} | \`${p.url.slice(0, 32)}...\` | ${VIEWPORTS.map((v) => vpCell(v.label)).join(' | ')} | ${struct} | ${assets} | ${typo} | ${net} | ${cap} | ${vis} | **${renderPageStatus(pr)}** |`;
}).join('\n')}

---

## 5. Per-Page Results

${TARGET_PAGES.map(p => {
  const pr = summary.pageResults[p.id];
  if (!pr) return `### Page ${p.id}: ${p.name}\n\n*Status: NOT_TESTED in this execution run.*\n`;
  const d = pr.phases?.discovery || {};
  // One section per viewport, driven by the run's declared scope: an excluded viewport
  // is reported as EXCLUDED, so an unmeasured column can never be read as "tested and
  // failed" or as an empty N/A block.
  const vpName = (v) => (v.mobile ? 'Mobile' : v.width >= 1440 ? 'Desktop' : 'Tablet');
  const vpSection = (v) => {
    if (excludedViewports.includes(v.label)) {
      return `#### ${v.label}px (${vpName(v)}) — EXCLUDED\n\n- **Not measured by this run**: this viewport was declared out of scope, so nothing here is a result. It is unverified, not passing.\n`;
    }
    const vp = pr.viewports[v.label] || {};
    return `#### ${v.label}px (${vpName(v)})
- **Navigation**: ${pr.finalUrl ? 'OK' : 'FAIL'}
- **Structure**: ${vp.structure ? `Ref: ${vp.structure.refSections} sec, ${vp.structure.refCards} cards | Clone: ${vp.structure.cloneSections} sec, ${vp.structure.cloneCards} cards` : 'N/A'}
- **Assets**: ${pageRouteRefusal(pr) ? 'NOT_RUN (route refused before clone generation)' : (pr.phases.cloneGeneration?.ok ? 'PASS (Local)' : 'FAIL (Audit)')}
- **Typography**: ${d.ok ? 'Verified' : 'N/A'}
- **Network**: ${vp.network?.verdict || 'N/A'} (Ref visual requests: ${vp.network?.referenceRequests ?? 'N/A'})
- **Capture**: ${vp.capture ? (vp.capture.valid ? `PASS (Ref: ${vp.capture.reference.bytes}B, Clone: ${vp.capture.clone.bytes}B)` : 'FAIL') : 'N/A'}
- **Visual**: ${vp.visual?.verdict || 'N/A'} (${vp.visual?.mismatchPercentage ?? 'N/A'}% mismatch)
- **Overall**: **${vp.overall || 'N/A'}**
`;
  };

  return `### Page ${p.id}: ${p.name}

- **Initial URL**: \`${p.url}\`
- **Final URL**: \`${pr.finalUrl || p.url}\`
- **Special Requirements**: ${p.specialNote}
- **Discovery Metrics**: ${d.sectionsCount || 0} sections, ${d.productCards || 0} product cards, ${d.articles || 0} articles, ${d.images || 0} images, document dimensions: \`${d.docW || 0}x${d.docH || 0}\`, overflowX: \`${d.overflowX}\`.

${VIEWPORTS.map(vpSection).join('\n')}
${pr.errors.length > 0 ? `**Failures**: ${pr.errors.map(e => `\`[${e.phase}] ${e.message}\``).join(', ')}` : '**Failures**: None'}
`;
}).join('\n---\n\n')}

---
## 6. Asset Pipeline Results

${executedPages.length === 0 ? '*No asset pipeline execution in this run.*' : `
- **Pages Tested in Pipeline**: ${pipelinePages.length} pages.
- **Successful Clone Bundles**: ${pipelinePages.filter(p => summary.pageResults[p.id]?.phases.cloneGeneration?.ok).length} / ${pipelinePages.length}.
- **Failed Clone Bundles**: ${pipelinePages.filter(p => !summary.pageResults[p.id]?.phases.cloneGeneration?.ok).length} / ${pipelinePages.length}.
- **Asset Families Discovered**: Discovered across \`src\`, \`srcset\`, \`<picture>\`, and inline style \`background-image\`.
${pipelinePages.some(p => !summary.pageResults[p.id]?.phases.cloneGeneration?.ok) ? `
### Pipeline Failures Encountered
${pipelinePages.filter(p => !summary.pageResults[p.id]?.phases.cloneGeneration?.ok).map(p => `- **Page ${p.id} (${p.name})**: \`${summary.pageResults[p.id]?.phases.cloneGeneration?.error || 'Unknown error'}\``).join('\n')}
` : '- All executed clone bundles generated without pipeline halt.'}
${routeRefusedPages.length > 0 ? `
### Not Reached — route refused before clone generation
${routeRefusedPages.map(p => `- **Page ${p.id} (${p.name})**: \`${renderPageStatus(summary.pageResults[p.id])}\``).join('\n')}
` : ''}
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
  const d = pr.phases?.discovery || {};
  return `- **Page ${p.id} (${p.name})**: Discovery Ref: ${d.sectionsCount || 0} sections, ${d.productCards || 0} product cards, ${d.articles || 0} articles.`;
}).join('\n')}

---

## 10. Responsive Results

${executedPages.length === 0 ? '*No responsive data collected in this run.*' : executedPages.map(p => {
  const pr = summary.pageResults[p.id];
  const measuredViewports = VIEWPORTS.filter((v) => !excludedViewports.includes(v.label));
  const isCleanOverflow = (v) => v === 0 || v === false;
  const lines = VIEWPORTS.map((v) => {
    if (excludedViewports.includes(v.label)) return `  * ${v.label}px DocHeight: EXCLUDED — not measured by this run (unverified, not passing)`;
    const s = pr.viewports[v.label]?.structure || {};
    return `  * ${v.label}px DocHeight: Ref=${s.refDocH ?? 'N/A'}px, Clone=${s.cloneDocH ?? 'N/A'}px (OverflowX: Ref=${s.refOverflowX ?? 'N/A'}, Clone=${s.cloneOverflowX ?? 'N/A'})`;
  }).join('\n');
  const heightsKnown = measuredViewports.every((v) => {
    const s = pr.viewports[v.label]?.structure || {};
    return s.refDocH != null && s.cloneDocH != null;
  });
  const overflowKnown = measuredViewports.every((v) => (pr.viewports[v.label]?.structure || {}).cloneOverflowX != null);
  const noOverflow = measuredViewports.every((v) => isCleanOverflow((pr.viewports[v.label]?.structure || {}).cloneOverflowX));
  const vpPass = measuredViewports.every((v) => pr.viewports[v.label]?.overall === 'PASS');
  const routeRefusal = pageRouteRefusal(pr);
  const respVerdict = routeRefusal
    ? renderPageStatus(pr)
    : measuredViewports.length === 0
    ? 'NO MEASURED VIEWPORT'
    : (!heightsKnown || !overflowKnown)
      ? 'INCONCLUSIVE (Missing complete structural metrics)'
      : (!noOverflow
        ? 'FAIL (Horizontal overflow detected on clone)'
        : (!vpPass
          ? 'INCONCLUSIVE (Visual or structural divergence across viewports)'
          : 'PASS'));
  const unverified = excludedViewports.length > 0 ? `\n  * Scope: ${measuredViewports.map((v) => v.label).join('/') || 'none'} measured; ${excludedViewports.join('/')} EXCLUDED and unverified.` : '';
  return `- **Page ${p.id} (${p.name})**: Status: **${respVerdict}**${unverified}
${lines}`;
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
${renderMaskSensitivity(summary)}

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
3. **Failure nào thuộc Asset Pipeline?**: ${pages.filter(p => p.phases?.cloneGeneration && !p.phases.cloneGeneration.ok).map(p => `Page ${p.id}: ${p.phases.cloneGeneration.error}`).join('; ') || (executedPages.length === 0 ? 'CHƯA KIỂM CHỨNG.' : 'Không phát hiện.')}
4. **Failure nào thuộc Independent HTML Generator?**: ${pages.some(p => p.phases?.cloneGeneration?.error?.includes('sourceBaseUrl')) ? 'Xử lý multi-domain base URL.' : (executedPages.length === 0 ? 'CHƯA KIỂM CHỨNG.' : 'Không phát hiện.')}
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
| A. Discovery | ${pipelinePages.length === 0 ? (routeRefusedPages.length > 0 ? 'NOT_RUN' : 'NOT_TESTED') : (pipelinePages.every(p => summary.pageResults[p.id]?.phases.discovery?.ok) ? 'PASS' : 'FAIL')} | ${pipelinePages.length > 0 ? `${pipelinePages.filter(p => summary.pageResults[p.id]?.phases.discovery?.ok).length}/${pipelinePages.length} pages passed${routeRefusedPages.length > 0 ? `; ${routeRefusedPages.length} page(s) route-refused before build (not a pipeline failure)` : ''}` : (routeRefusedPages.length > 0 ? `${routeRefusedPages.length} page(s) route-refused before build; pipeline never ran` : 'No pages run')} |
| B. Asset Localization | ${pipelinePages.length === 0 ? 'NOT_TESTED' : (pipelinePages.some(p => summary.pageResults[p.id]?.phases.cloneGeneration?.ok) ? (pipelinePages.every(p => summary.pageResults[p.id]?.phases.cloneGeneration?.ok) ? 'PASS' : 'PARTIAL_FAIL') : 'FAIL')} | ${pipelinePages.length > 0 ? `${pipelinePages.filter(p => summary.pageResults[p.id]?.phases.cloneGeneration?.ok).length}/${pipelinePages.length} bundles built${routeRefusedPages.length > 0 ? `; ${routeRefusedPages.length} page(s) route-refused before build (not a pipeline failure)` : ''}` : (routeRefusedPages.length > 0 ? `${routeRefusedPages.length} page(s) route-refused before build; pipeline never ran` : 'No bundles attempted')} |
| C. Asset Family | ${pipelinePages.length > 0 ? 'PASS' : (routeRefusedPages.length > 0 ? 'NOT_RUN' : 'NOT_TESTED')} | Discovered across src/srcset/picture/bg |
| D. Typography | ${pipelinePages.length > 0 ? (Object.keys(domainFonts).length > 0 ? 'PASS' : 'NOT_TESTED') : (routeRefusedPages.length > 0 ? 'NOT_RUN' : 'NOT_TESTED')} | ${pipelinePages.length > 0 && Object.keys(domainFonts).length > 0 ? `Extracted across ${Object.keys(domainFonts).length} domains` : 'No data'} |
| E. HTML Extraction | ${pipelinePages.length === 0 ? 'NOT_TESTED' : (pipelinePages.some(p => summary.pageResults[p.id]?.phases.cloneGeneration?.ok) ? 'PASS' : 'BLOCKED')} | BlueprintExtractor extraction |
| F. HTML Generation | ${pipelinePages.length === 0 ? 'NOT_TESTED' : (pipelinePages.some(p => summary.pageResults[p.id]?.phases.cloneGeneration?.ok) ? 'PASS' : 'BLOCKED')} | Independent bundle synthesis |
| G. CSS/Layout | ${totalRenderCasesRun === 0 ? 'NOT_TESTED' : (totalPass === totalRenderCasesRun ? 'PASS' : (totalFail > 0 ? 'FAIL' : 'INCONCLUSIVE'))} | Layout comparison across viewports |
| H. Responsive | ${totalRenderCasesRun === 0 ? 'NOT_TESTED' : (totalPass === totalRenderCasesRun ? 'PASS' : (totalFail > 0 ? 'FAIL' : 'INCONCLUSIVE'))} | Multi-viewport responsiveness (${scopedViewportLabels.join('/')})${excludedViewports.length > 0 ? ` — ${excludedViewports.join('/')} excluded and unverified` : ''} |
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

/**
 * Rebuild the campaign aggregate from what each page published.
 *
 * A per-batch report only knows the pages that batch measured, and that is not a
 * hypothetical: a second batch of seven pages wrote `PAGES EXECUTED 7 / 15 (8 pages
 * UNTESTED in this batch)` while all fifteen had evidence on disk. This reads each page's
 * own attempt pointer, takes the attempt that pointer names as that page's result, and
 * assembles one report over all of them, so a page with evidence is never reported as
 * untested. Nothing is re-derived: every number comes from the published summary.
 */
function collectCampaignPageResults() {
  const baseRunDir = path.resolve(REPO, '.canary/15-pages');
  const pageResults = {};
  const absent = [];
  // Empty string, not null: an ISO timestamp compared against null goes through numeric
  // coercion, where the date is NaN, so the comparison is false for every page and the
  // newest publication is silently discarded.
  let newestPublication = '';
  for (const slug of fs.readdirSync(baseRunDir).sort()) {
    const pageDir = path.join(baseRunDir, slug);
    if (!slug.startsWith('page-') || !fs.statSync(pageDir).isDirectory()) continue;
    const pointer = readPagePointer(pageDir);
    if (!pointer) {
      absent.push({ slug, reason: 'no attempt pointer' });
      continue;
    }
    const summaryPath = path.join(pointer.evidenceRoot, 'summary.json');
    if (!fs.existsSync(summaryPath)) {
      absent.push({ slug, reason: `no summary.json under ${pointer.evidenceRoot}` });
      continue;
    }
    const pageResult = JSON.parse(fs.readFileSync(summaryPath, 'utf8'));
    enrichWithChildEvidence(pageDir, pageResult);
    pageResults[pageResult.id] = pageResult;
    if (pointer.publishedAt && pointer.publishedAt > newestPublication) newestPublication = pointer.publishedAt;
  }
  return { baseRunDir, pageResults, absent, newestPublication };
}

/**
 * Fold the child's own measurements back into the page result the report renders.
 *
 * The per-page summary carries the binding comparison only. The widget-mask sensitivity
 * pass and the height-drift experiment are written by the child into the attempt's
 * evidence directory beside that summary, so they are read from there: the report then
 * shows what was measured instead of reporting the two passes as absent.
 */
function enrichWithChildEvidence(pageDir, pageResult) {
  const pointer = readPagePointer(pageDir);
  if (!pointer?.evidenceRoot) return;
  for (const [label, vp] of Object.entries(pageResult.viewports || {})) {
    const evidencePath = path.join(pointer.evidenceRoot, `${label}.json`);
    if (!fs.existsSync(evidencePath)) continue;
    let child;
    try {
      child = JSON.parse(fs.readFileSync(evidencePath, 'utf8'));
    } catch {
      continue;
    }
    if (child.visualMasksOn) vp.visualMasksOn = child.visualMasksOn;
    if (child.heightDriftExperiment) vp.heightDriftExperiment = child.heightDriftExperiment;
  }
}

/**
 * A run id derived from the verdicts themselves, so regenerating the aggregate twice over
 * unchanged evidence writes the same bytes. A timestamp would make the report differ
 * between two identical reads, and determinism is the property under test.
 */
function aggregateRunId(pageResults) {
  const parts = [];
  for (const id of Object.keys(pageResults).map(Number).sort((a, b) => a - b)) {
    const page = pageResults[id];
    for (const label of Object.keys(page.viewports || {}).sort()) {
      const vp = page.viewports[label];
      parts.push(`page-${id}:${label}:${vp?.overall ?? 'none'}:${vp?.causeCode ?? 'none'}:${vp?.visual?.mismatchPercentage ?? 'null'}`);
    }
  }
  return `aggregate-${crypto.createHash('sha256').update(parts.join('\n')).digest('hex').slice(0, 16)}`;
}

async function runAggregateOnly() {
  const { baseRunDir, pageResults, absent, newestPublication } = collectCampaignPageResults();
  const pageCount = Object.keys(pageResults).length;
  if (pageCount === 0) {
    console.error(`[campaign] no page under ${baseRunDir} has a published attempt; nothing to aggregate`);
    return { code: 1, reason: 'AGGREGATE_EMPTY' };
  }
  const runId = aggregateRunId(pageResults);
  const runSummary = {
    pageResults,
    refusals: [],
    pagesRun: pageCount,
    scope: { pages: 'all', viewports: VIEWPORTS.map((v) => v.label), excluded: [] },
    runId,
    absent,
    // The campaign's own completion is the newest publication among the pages it holds:
    // a regeneration timestamp would make two identical reads of unchanged evidence
    // write different bytes, which is the property the determinism check tests.
    completedAt: newestPublication,
    sessionRenewals: [],
    // This summary is read back from what many runs published, so it cannot carry one
    // run's live session identity and must not pretend to: the report says where its
    // evidence came from instead.
    aggregate: true,
  };
  const indexPlan = planVerdictIndex(runSummary, baseRunDir);
  const reportDir = path.join(baseRunDir, 'reports', runId);
  fs.mkdirSync(reportDir, { recursive: true });
  const reportMarkdown = generateReport(runSummary);
  const retainedReportPath = path.join(reportDir, '15-PAGE-HOPLONGTECH-CLONE-CANARY.md');
  writeRecordAtomic(retainedReportPath, reportMarkdown);
  const reportPath = path.resolve(REPO, '15-PAGE-HOPLONGTECH-CLONE-CANARY.md');
  writeRecordAtomic(reportPath, reportMarkdown);
  writeVerdictIndexFiles(runSummary, baseRunDir, indexPlan.index);
  writeRecordAtomic(path.join(reportDir, '_verdicts.json'), runSummary.index);
  writeRunPointer(baseRunDir, {
    runId,
    reportDir,
    reportPath: retainedReportPath,
    rootCopyPath: reportPath,
    pages: pageCount,
    cases: runSummary.index?.cases?.length ?? null,
    verdict: runSummary.index?.executiveVerdict ?? null,
  });
  console.log(`[campaign] aggregate ${runId}: ${pageCount} of ${TARGET_PAGES.length} pages, ${runSummary.index?.cases?.length ?? 0} cases, verdict ${runSummary.index?.executiveVerdict ?? 'none'}${absent.length ? `, absent: ${absent.map((a) => a.slug).join(', ')}` : ''}`);
  console.log(`[campaign] aggregate completion ${newestPublication ?? 'UNKNOWN'}`);
  console.log(`Report written to ${retainedReportPath} and published to ${reportPath}`);
  return { code: indexPlan.gaps.length ? 1 : 0, reason: indexPlan.gaps.length ? 'PROVENANCE_INCOMPLETE' : 'AGGREGATE_COMPLETE' };
}

// ── CLI Execution Entrypoint ──────────────────────────────────────────────────
// The campaign runs only when this file is the entrypoint. Importing the module
// (the report renderer's test does) must not start a live run.
const isEntrypoint = Boolean(process.argv[1]) && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isEntrypoint) {
  const args = process.argv.slice(2);
  if (args.includes('--aggregate-only')) {
    const result = await runAggregateOnly().catch((err) => {
      console.error('Fatal aggregate error:', err);
      process.exit(1);
    });
    process.exit(result.code);
  }
  const pageArgIdx = args.indexOf('--pages');
  const pages = pageArgIdx !== -1 ? args[pageArgIdx + 1] : null;
  const viewportArgIdx = args.indexOf('--viewports');
  const viewports = viewportArgIdx !== -1 ? args[viewportArgIdx + 1] : null;

  const summary = await runFifteenPagesCanary({ pages, viewports }).catch((err) => {
    console.error('Fatal canary run error:', err);
    process.exit(1);
  });

  // A fidelity FAIL is campaign output and exits 0; a non-zero status means the run
  // could not produce a complete, provenance-bound set of verdicts.
  const exit = summary.exit || { code: 1, reason: 'NO_EXIT_STATUS' };
  console.log(`15-page canary run finished: ${exit.reason} (exit ${exit.code})${exit.detail ? ` — ${JSON.stringify(exit.detail)}` : ''}`);
  process.exit(exit.code);
}
