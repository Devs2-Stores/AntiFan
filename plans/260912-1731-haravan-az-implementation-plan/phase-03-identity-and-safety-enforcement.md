# Phase 03 — Identity and Safety Enforcement at the Capture Layer
Status: BLOCKED_ON_PREDECESSOR
Depends on: 00

## Context
Verification and measurement artifacts in AntiFan (specifically `reports/chromium-verification/chromium-45-cases-results.json`, `reports/HARAVAN-STOREFRONT-FINAL-CAMPAIGN-REPORT.md`, and `.canary/state/subset-r2.json`) produced unverified `100.0% PASS` claims due to three critical capture-layer defects:

1. **Defect D9 (Inert Preview Parameter & Theme Identity Failure):**
   Verification URLs across `scripts/verify-storefront-chromium.mjs:12–26`, `scripts/verify-storefront-chromium-direct.mjs:12–26`, `scripts/verify-storefront-routes.mjs:4–18`, `scripts/test-single-visual-compare.mjs:54`, and `packages/site-clone/src/qa/dod-validator.ts:265,867–878` used Shopify's `?preview_theme_id=` query parameter. Live probing (`scripts/probe-theme-identity.mjs`, verified in `evidence-addendum-04-260912-1731-measurement-identity.md §1`) proves that `?preview_theme_id=` is **inert** on unauthenticated Haravan document GET requests, returning HTML byte-identical to the unparameterized storefront (1,425,269 B, SHA-256 `c6d8127e597ebe7d`). Haravan's documented preview parameter is `?themeid=` (1,194,692 B, 213 vs 44 `hstatic.net` asset references). Consequently, the historical `chromium-45-cases-results.json` run measured the live production theme (`1001510509`, role `main`) while recording target theme `1001512581`.
   *(Authority note from plan.md §2 & §4): Raw HTML hash differences between runs vary due to dynamic CSRF/antiforgery tokens and do not uniquely establish theme identity; the probe is diagnostic only. Theme identity is established by the Haravan CLI standard contract `?themeid=<id>`, API asset binding, and server preview session cookie setting. Browser cookies named `preview_theme_id` must NOT be deleted or cleared, as Haravan's server sets a cookie with that name upon processing `?themeid=`. Query parameter remediation must apply strictly to Haravan storefront document navigation; asset/CDN URLs, API endpoints, cart endpoints, and Shopify multi-platform behaviors must be preserved.*

2. **Defect D10 (Unattested Viewport vs Horizontal Overflow & DOM Integrity):**
   In `reports/chromium-verification/chromium-45-cases-results.json`, all 45 cases report `docWidth: 1905` regardless of requested viewport (desktop 1440, laptop 1024, mobile 390). All 15 routes report identical `docHeight: 5400`, `bodyChildren: 27`, and `textLength: 8713` across all three viewports, and `hasFooter: false` is recorded across all 45 cases. Despite 100% horizontal overflow (`1905 > viewport.width`) and missing footers, all 45 cases were stamped `VERIFIED_PASS`.
   *(Authority note from plan.md §2, §4 & Controller correction): `docWidth: 1905` plus equal content metrics proves recorded horizontal overflow and insufficient viewport attestation, NOT that emulation can never be applied. Equal heights, text lengths, or PNG hashes can be entirely legitimate on simple, short, or invariant pages; arbitrary inequality or entropy thresholds must not be imposed. The capture layer must distinguish two separate failure modes:*
   - **Viewport Not Applied (`VIEWPORT_NOT_APPLIED`):** Emulation failure where the browser window/surface was not resized (attested by `window.innerWidth !== vp.width`, `window.visualViewport.width !== vp.width`, DPR mismatch, or raster canvas mismatch).
   - **Horizontal Overflow (`FAIL`):** Page layout defect where viewport emulation was successfully applied (`innerWidth === vp.width`), but document layout overflowed (`document.documentElement.scrollWidth > vp.width + 1`).

3. **Defect D11 (Canary Producer Theme Safety & Sentinel Semantics):**
   In `.canary/state/subset-r2.json:39–120`, the safety gate whitelisted `themeid=-1` in `safety.allowedThemes` and recorded 7 probe gates as passing (`"themeId": -1, "allowed": true, "reason": "themeid=-1 is -1 or an allowed theme"`). On Haravan, `-1` selects no draft theme, falling back to the live production storefront.
   *(Authority note from plan.md §2, §4 & Controller correction): Fix the producer script (`.canary/tools/theme-fidelity.mjs`), NOT the frozen historical artifact `subset-r2.json`. In the producer, trace `-1` semantics (which originally represented read-only live production in contrast to draft staging). For verification and mutation runs, require explicit allowed staging theme binding. Distinguish write operations from read-only probes: `SECURITY_ABORT` applies to unauthorized write, push, publish, or destructive operations on protected themes (`role === "main"`). Read-only probes of the main theme (e.g. baseline diagnostic comparisons) are permitted. Client-specific IDs must NOT be hardcoded into shared CLI tools; project-scoped bindings belong in campaign configurations.*

---

## Requirements

### R3-1: Query Handling for Haravan Document Navigation (D9)
- Modify query parameter targeting **only on Haravan storefront document navigation**.
- Use explicit `URL` / `URLSearchParams` manipulation to set `themeid=<targetThemeId>` (e.g. `1001512581`), rather than indiscriminate string search-and-replace.
- Explicit list of files requiring query parameter migration:
  1. `scripts/verify-storefront-chromium.mjs:12–26` (15 route paths)
  2. `scripts/verify-storefront-chromium-direct.mjs:12–26` (15 route paths)
  3. `scripts/verify-storefront-routes.mjs:4–18` (15 route paths)
  4. `scripts/test-single-visual-compare.mjs:54` (storefront URL)
  5. `packages/site-clone/src/qa/dod-validator.ts:265, 864–878` (criterion definition and Haravan preview token check, while preserving multi-platform Shopify token checks)
  6. `packages/site-clone/src/qa/dod-validator.test.ts:312–318, 511, 556` (unit test fixtures and assertions)
  7. `reports/15-page-data-mapping.json:18, 35, 67, 97, 127, 158, 175, 214, 246, 278, 298, 329, 349, 380, 411` (catalog mapping URLs)
- *Invariants:*
  - Retain `preview_theme_id` in `scripts/probe-theme-identity.mjs` as the intentional diagnostic negative control.
  - Do NOT delete or clear client/browser cookies named `preview_theme_id` (Haravan sets this cookie upon processing `?themeid=`).
  - Do NOT alter asset/CDN URLs (`hstatic.net`), API requests, cart operations, or Shopify multi-platform behaviors.
  - Historical artifacts (`reports/chromium-verification/chromium-45-cases-results.json` and `plans/reports/evidence-*`) remain immutable records.

### R3-2: Viewport Attestation vs Layout Overflow Distinction (D10)
In `scripts/verify-storefront-chromium.mjs` and `scripts/verify-storefront-chromium-direct.mjs`:
- After invoking `anti.browser.set_viewport`, immediately attest actual physical viewport metrics:
  ```js
  const viewportAttestation = {
    innerWidth: window.innerWidth,
    visualViewportWidth: window.visualViewport ? window.visualViewport.width : window.innerWidth,
    clientWidth: document.documentElement.clientWidth,
    dpr: window.devicePixelRatio,
    scrollWidth: document.documentElement.scrollWidth,
  };
  ```
- **Viewport Emulation Attestation Gate:**
  If `Math.abs(viewportAttestation.innerWidth - vp.width) > 1` or `Math.abs(viewportAttestation.visualViewportWidth - vp.width) > 1`, abort the case with verdict `VIEWPORT_NOT_APPLIED`. This flags harness/browser emulation failure.
- **Horizontal Overflow Gate:**
  If the viewport is successfully attested (`innerWidth === vp.width`), but `viewportAttestation.scrollWidth > vp.width + 1` (tolerance: 1 CSS px per `scripts/lib/viewport-geometry.mjs`), mark the case verdict as **`FAIL`** (with reason `HORIZONTAL_OVERFLOW`), **NOT** `VIEWPORT_NOT_APPLIED`.
- Fix tool schema in `scripts/verify-storefront-chromium.mjs:79–84`:
  Pass `mobile: Boolean(vp.isMobile)` and `reload: true`, remove the silent error catch block, and fail closed on RPC error.

### R3-3: Capture Validity & Per-Viewport Attestation Precondition (D10)
- In multi-viewport verification runs (15 routes × 3 viewports = 45 cases):
  - Every viewport switch MUST trigger tab resize, reload/settle, and layout re-evaluation.
  - **Equal Hashes & Heights Invariant:** Equal heights, equal body children, equal text lengths, or identical PNG hashes across viewports or runs can be legitimate (e.g. for simple banners or invariant headers). Arbitrary inequality or entropy thresholds MUST NOT be imposed.
  - **Capture Validity Gate:** Verification requires:
    1. Independent baseline/capture provenance paths;
    2. Successful image decoding and valid raster dimensions matching emulated viewport;
    3. Content landmark expectations (`header`, `main`, `footer` per template contract).
  - Rejection as `DEGENERATE_VIEWPORT` triggers ONLY if viewport attestation confirms that the browser viewport failed to resize across supposedly distinct viewport iterations (e.g. `innerWidth` remained identical across 390, 768/1024, and 1440 iterations).

### R3-4: DOM Integrity Predicates and Full-Page Verification (D10)
In `scripts/verify-storefront-chromium.mjs:111–121` and `scripts/verify-storefront-chromium-direct.mjs:83–94`:
- Replace the weak predicate `metrics.docHeight > 300` with strict conjunction:
  ```js
  const viewportOk = Math.abs(metrics.innerWidth - vp.width) <= 1;
  const overflowOk = metrics.docWidth <= (vp.width + 1);
  const footerOk = metrics.hasFooter === true;
  const heightOk = metrics.docHeight > 300;
  const leaksOk = (metrics.hoplongLeaksCount ?? 0) === 0;

  let status = 'VERIFIED_PASS';
  if (!metrics || metrics.error) {
    status = 'ERROR';
  } else if (!viewportOk) {
    status = 'VIEWPORT_NOT_APPLIED';
  } else if (!overflowOk) {
    status = 'FAIL'; // Horizontal overflow is a layout failure
  } else if (!footerOk || !heightOk || !leaksOk) {
    status = 'DEGRADED';
  }
  ```
- Any case where `hasFooter === false` (observed 45/45 in `chromium-45-cases-results.json`) or horizontal overflow is present MUST evaluate to `FAIL` or `DEGRADED`, never `VERIFIED_PASS`.
- Footer and header detection must verify semantic markup structure (`footer`, `.footer`, `#footer`, `.site-footer`), not merely trust legacy selectors.

### R3-5: Canary Safety Producer Remediation & Tenancy Boundaries (D11)
In `.canary/tools/theme-fidelity.mjs:85–86, 455–477`:
- In the producer script, trace `-1` semantics (sentinel for unisolated live production).
- Remove `-1` from `DEFAULT_ALLOWED_THEMES` for staging verification runs.
- In `evaluateUrlSafety(targets, allowedThemes)`, enforce that verification targets targeting staging must explicitly carry an allowed draft theme ID.
- **Tenancy Boundary:**
  `SECURITY_ABORT` is strictly reserved for unauthorized mutation, write, push, publish, or deletion operations targeting protected theme (`role === "main"`). Read-only probes of the main theme (e.g. diagnostic baseline reads) are permitted and must not trigger `SECURITY_ABORT`.
- **Shared CLI Boundary:**
  No client-specific IDs (`1001512581`, `1001510509`, `phukienmaymoc.com`) may be hardcoded into shared Haravan CLI commands. Project-specific IDs belong in campaign manifests and runner configurations. Shared CLI code enforces generic role protections (`role === "main"`).
- Do NOT mutate the frozen historical artifact `.canary/state/subset-r2.json`.

---

## Files

| path | action | why |
|---|---|---|
| `scripts/verify-storefront-chromium.mjs` | edit | Primary Chromium verification script: contains D9 (`preview_theme_id` in 15 routes), D10 (swallowed viewport errors, missing viewport attestation, conflated overflow, missing `hasFooter` check) |
| `scripts/verify-storefront-chromium-direct.mjs` | edit | Direct RPC verification script: contains D9 (`preview_theme_id` in 15 routes), D10 (omitted viewport switching, missing overflow and footer assertions) |
| `scripts/verify-storefront-routes.mjs` | edit | HTTP route probe script: contains D9 (`preview_theme_id` in 15 routes) |
| `scripts/test-single-visual-compare.mjs` | edit | Single-page visual compare probe: contains D9 (`preview_theme_id` at line 54) |
| `packages/site-clone/src/qa/dod-validator.ts` | edit | DoD validation engine: contains D9 (`preview_theme_id` token requirements at lines 265, 867–868, 878) |
| `packages/site-clone/src/qa/dod-validator.test.ts` | edit | DoD validation test suite: contains D9 test assertions expecting `preview_theme_id` (lines 312, 314, 317, 511, 556) |
| `.canary/tools/theme-fidelity.mjs` | edit | Canary fidelity producer tool: contains D11 (`PRODUCTION_THEME = '-1'` whitelist at lines 85–86 and 455–477) |
| `reports/15-page-data-mapping.json` | edit | Active 15-page catalog data mapping: contains D9 (`preview_theme_id` across 12 route entries) |
| `scripts/probe-theme-identity.mjs` | read | Diagnostic negative control proving `preview_theme_id` inertness vs `themeid` |
| `scripts/lib/viewport-geometry.mjs` | read | Source of truth for `VIEWPORT_TOLERANCE_PX = 1` and `sameViewport` geometry predicates |
| `reports/chromium-verification/chromium-45-cases-results.json` | read | Frozen historical artifact proving baseline defects D9, D10 |
| `plans/260912-1731-haravan-az-implementation-plan/plan.md` | read | Master plan defining authority for capture identity, viewport attestation, and safety gates |

---

## Steps

1. **Migrate Haravan Document Navigation Routes in `scripts/verify-storefront-chromium.mjs`:**
   - In lines 11–27, update the 15 route paths to use `themeid=1001512581`:
     ```javascript
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
     ```

2. **Add Viewport Attestation and Overflow Discrimination in `scripts/verify-storefront-chromium.mjs`:**
   - In lines 76–89, pass correct schema arguments, add `reload: true`, and fail closed on error:
     ```javascript
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
     ```
   - In lines 93–109, extend in-page evaluation to capture `innerWidth`, `visualViewportWidth`, `clientWidth`, `docWidth`, and landmarks:
     ```javascript
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
     ```
   - In lines 111–122, discriminate `VIEWPORT_NOT_APPLIED` from `FAIL`:
     ```javascript
     const viewportAttested = Math.abs((pageMetrics?.innerWidth || 0) - vp.width) <= 1;
     const hasNoOverflow = pageMetrics && pageMetrics.docWidth <= (vp.width + 1);
     const hasFooter = pageMetrics && pageMetrics.hasFooter === true;
     const hasMinHeight = pageMetrics && pageMetrics.docHeight > 300;
     const noLeaks = pageMetrics && (pageMetrics.hoplongLeaksCount ?? 0) === 0;

     let status = 'VERIFIED_PASS';
     if (!pageMetrics || pageMetrics.error) {
       status = 'ERROR';
     } else if (!viewportAttested) {
       status = 'VIEWPORT_NOT_APPLIED';
     } else if (!hasNoOverflow) {
       status = 'FAIL'; // Overflow is a layout failure
     } else if (!hasFooter || !hasMinHeight || !noLeaks) {
       status = 'DEGRADED';
     }

     const verified = status === 'VERIFIED_PASS';
     ```

3. **Multi-Viewport Attestation Precondition in `scripts/verify-storefront-chromium.mjs`:**
   - Before writing the summary report (line 130), verify that browser viewport was actually varied across iterations:
     ```javascript
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
     ```
     *(Note: Equal height, text, or body children across viewports is permitted if `innerWidth` matches the requested viewport.)*

4. **Remediate `scripts/verify-storefront-chromium-direct.mjs`:**
   - In lines 11–27, update all 15 routes to use `themeid=1001512581`.
   - In lines 60–64, insert the missing viewport switch inside the viewport loop:
     ```javascript
     await call('anti.browser.set_viewport', {
       tabId,
       width: vp.width,
       height: vp.height,
       mobile: Boolean(vp.mobile),
       reload: true
     }, 30_000);
     await sleep(800);
     ```
   - In lines 83–94, attest `innerWidth === vp.width`, evaluate `docWidth <= vp.width + 1` (assigning `status = 'FAIL'` on overflow), and enforce `hasFooter === true`.

5. **Remediate `scripts/verify-storefront-routes.mjs` and `scripts/test-single-visual-compare.mjs`:**
   - In `scripts/verify-storefront-routes.mjs:4–18`, update the 15 routes to use `themeid=1001512581`.
   - In `scripts/test-single-visual-compare.mjs:54`, update storefront URL:
     ```javascript
     const storefrontUrl = 'https://phukienmaymoc.com/?themeid=1001512581';
     ```

6. **Remediate DoD Validator in `packages/site-clone/src/qa/dod-validator.ts`:**
   - In line 265, update description:
     ```typescript
     description: 'Verifies derivation of valid Haravan theme preview URL with themeid token.',
     ```
   - In lines 864–871, prioritize `themeid=` for Haravan preview URLs while preserving multi-platform token checks:
     ```typescript
     const hasPreviewParam =
       urlString.includes('themeid=') ||
       urlString.includes('theme_id=') ||
       urlString.includes('themeid') ||
       urlString.includes('theme_id') ||
       urlString.includes('preview_theme_id=') ||
       urlString.includes('preview');
     ```
   - In line 878, ensure failure message names `themeid`:
     ```typescript
     return { passed: false, reason: `Preview URL "${urlString}" missing Haravan preview token (themeid)` };
     ```

7. **Update DoD Validator Tests in `packages/site-clone/src/qa/dod-validator.test.ts`:**
   - At lines 312–318, update test fixture:
     ```typescript
     it('passes when preview URL has themeid parameter', () => {
       const res = validator.auditHaravanPreview({
         previewUrl: 'https://store.myharavan.com/?themeid=12345678',
       });
       assert.strictEqual(res.passed, true);
       assert.ok(res.evidence?.includes('themeid=12345678'));
     });
     ```
   - At line 511, replace `preview_theme_id=987654321` with `themeid=987654321`.
   - At line 556, replace `preview_theme_id=123` with `themeid=123`.

8. **Remediate Canary Safety Producer in `.canary/tools/theme-fidelity.mjs` (D11):**
   - At lines 84–86, remove `-1` from default allowed staging themes:
     ```javascript
     /** The authorised theme copy. */
     export const DEFAULT_ALLOWED_THEMES = ['1001512581'];
     ```
     *(Delete `const PRODUCTION_THEME = '-1'`.)*
   - In `evaluateUrlSafety()` at lines 455–477:
     ```javascript
     export function evaluateUrlSafety(targets, allowedThemes = DEFAULT_ALLOWED_THEMES) {
       const allowed = new Set(allowedThemes.map((t) => String(t).trim()).filter(Boolean));
       const gates = [];
       const refusals = [];
       for (const target of targets) {
         let parsed;
         try {
           parsed = new URL(target.url);
         } catch {
           const refusal = { code: 'URL_UNPARSABLE', surface: target.name, url: target.url, value: null, reason: 'not an absolute URL' };
           gates.push({ surface: target.name, url: target.url, themeId: null, parameter: null, values: [], allowed: false, reason: refusal.reason });
           refusals.push(refusal);
           continue;
         }
         const values = [];
         for (const [key, value] of parsed.searchParams) {
           if (key.toLowerCase() === 'themeid') values.push(value);
         }
         if (!values.length) {
           gates.push({ surface: target.name, url: target.url, themeId: null, parameter: null, values: [], allowed: true, reason: 'no themeid query parameter' });
           continue;
         }
         const offending = values.filter((value) => !allowed.has(String(value).trim()) || String(value).trim() === '-1');
         if (offending.length) {
           const refusal = {
             code: 'THEME_ID_NOT_ALLOWED',
             surface: target.name,
             url: target.url,
             value: offending[0],
             values,
             allowedThemes: Array.from(allowed)
           };
           gates.push({
             surface: target.name,
             url: target.url,
             themeId: themeIdFromParameter(values[0]),
             parameter: values[0],
             values,
             allowed: false,
             reason: `themeid=${offending[0]} is not an allowed theme`
           });
           refusals.push(refusal);
           continue;
         }
     ```
   - Preserve read-only probe capabilities: allow read-only probes of the main theme when explicitly flagged as read-only diagnostic baseline.

9. **Update Active Catalog URLs in `reports/15-page-data-mapping.json`:**
   - In lines 18, 35, 67, 97, 127, 158, 175, 214, 246, 278, 298, 329, 349, 380, and 411, replace `preview_theme_id=1001512581` with `themeid=1001512581`.

---

## Validation

1. **Parameter Audit via Static Pattern Search:**
   - Run `grep` across the codebase searching for `preview_theme_id`:
     ```bash
     grep -n "preview_theme_id" scripts/ packages/site-clone/src/qa/
     ```
   - Confirm 0 occurrences in executable document navigation routes, active validators, and tests (excluding diagnostic probe `scripts/probe-theme-identity.mjs`).

2. **Canary Safety Gate Unit Check:**
   - Verify `evaluateUrlSafety([{ name: 'test', url: 'https://phukienmaymoc.com/?themeid=-1' }])` returns `refusals` with code `THEME_ID_NOT_ALLOWED`.
   - Verify `evaluateUrlSafety([{ name: 'test', url: 'https://phukienmaymoc.com/?themeid=1001512581' }])` returns `allowed: true`.

3. **DoD Validator Parameter Check:**
   - Confirm `auditHaravanPreview({ previewUrl: 'https://phukienmaymoc.com/?themeid=1001512581' })` yields `passed: true`.
   - Confirm `auditHaravanPreview({ previewUrl: 'https://phukienmaymoc.com/products/all' })` yields `passed: false`.

4. **Viewport Attestation vs Overflow Unit Check:**
   - Mock case A (emulation failure): `innerWidth = 1905`, `vp.width = 390` → yields `status: 'VIEWPORT_NOT_APPLIED'`.
   - Mock case B (layout overflow): `innerWidth = 390`, `docWidth = 520`, `vp.width = 390` → yields `status: 'FAIL'`.
   - Mock case C (missing footer): `innerWidth = 390`, `docWidth = 390`, `hasFooter = false` → yields `status: 'DEGRADED'`.
   - Mock case D (compliant): `innerWidth = 390`, `docWidth = 390`, `hasFooter = true`, `docHeight = 1200` → yields `status: 'VERIFIED_PASS'`.

---

## Risk

| Risk | Impact | Mitigation |
|---|---|---|
| Reported pass rates drop from 100% to true baseline (~18%) | High | Expected and honest outcome: 100% was an artifact of D9 and D10. Never relax gates to recover green numbers. |
| Staging theme `1001512581` renders real template defects | High | Serving the staging theme exposes leaks and asset bugs masked by D9. Theme fixes belong in Phase 06. |
| Mobile viewports expose horizontal overflow reflow bugs | Medium | Layout overflow evaluates to `FAIL`; layout fixes belong in CSS/Liquid templates. |
| Server-side session cookie `preview_theme_id` | Low | Haravan sets cookie `preview_theme_id` in response to `?themeid=`; browser navigation preserves cookies without interference. |

---

## Rollback

1. Revert changes to the 8 files touched in this phase:
   ```bash
   git checkout HEAD -- scripts/verify-storefront-chromium.mjs \
                         scripts/verify-storefront-chromium-direct.mjs \
                         scripts/verify-storefront-routes.mjs \
                         scripts/test-single-visual-compare.mjs \
                         packages/site-clone/src/qa/dod-validator.ts \
                         packages/site-clone/src/qa/dod-validator.test.ts \
                         .canary/tools/theme-fidelity.mjs \
                         reports/15-page-data-mapping.json
   ```
2. Record in the journal that rolling back restores false `100.0% PASS` certifications, re-introduces targeting of the live production theme (`1001510509`), re-opens the `themeid=-1` bypass, and disables horizontal overflow detection.
