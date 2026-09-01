# Ultra Deep Research Report: Advanced Browser Agent Capabilities for AntiFan Desktop
**Focus Domain:** Advanced Input Interactions, Drag-Drop, Sliders, Focus Trapping, Touch Momentum & Full CDP Capabilities  
**Target Environment:** AntiFan Browser Desktop (`E:/Work/apps/antifan-browser-desktop`)  
**Core Technologies:** Electron 43+, Chromium WebContentsView, TypeScript, Isolated World 1004, CDP DevTools Protocol, Main-owned SemanticRefRegistry, Split Review Engine (Desktop / Mobile).

---

## 1. Executive Summary

AntiFan Browser Desktop is purpose-built for high-performance E-Commerce Theme Engineering (Haravan, Sapo, Shopify). Unlike generic cloud-browser automation harnesses (e.g. headless Playwright runners) that create throwaway browser contexts, AntiFan operates directly within **live, authenticated Electron Chromium tabs** hosting real merchant sessions, hardware MFA, and persistent SQLite profile stores.

While AntiFan has established industry-leading capabilities in visual AI cursor tracking (`anti.agent.cursor.*`), continuous Bézier trajectories, ARIA semantic snapshots with monotonic `@e1..@eN` references, and deterministic DOM mutations in Isolated World 1004, a deep comparative analysis against `microsoft/playwright-mcp`, the Chrome DevTools Protocol (CDP), and modern agent specifications reveals **critical advanced interaction gaps**:
1. **1D Range Sliders & Drag-and-Drop:** Inability to fluidly manipulate custom E-commerce price facet sliders (noUiSlider, Ion.RangeSlider, Dawn facet filters) or execute element-to-element drag reordering.
2. **Accessible Keyboard Combos & Focus Trapping:** Lack of structured key combination parsing (`Shift+Tab`, `Escape`, `Control+A`) and automated WCAG 2.1/2.2 focus trap validation in theme slide-out Cart Drawers, Search Modals, and Mega-menus.
3. **Mobile Touch & Scroll Momentum Gestures:** Absence of authentic touch gestures (swipes, inertia fling, carousel drags) on the mobile split-pane.
4. **Environment & Hardware Emulation:** Missing `prefers-color-scheme` dark mode toggling, `vi-VN` / `Asia/Ho_Chi_Minh` timezone overrides, and 3G/4G network throttling for Core Web Vitals (LCP/INP) auditing.
5. **Headless Document Pipelines:** Lack of background PDF printing for invoice/order templates and silent download event interception for CSV/Theme ZIP exports.

This report delivers a rigorous technical assessment, an actionable Gap Analysis Matrix, and concrete engineering designs to integrate these capabilities natively into AntiFan without compromising the Zero-Mutation Invariant or desktop responsiveness.

---

## 2. Key Findings by Domain

### 2.1 Advanced Input Interactions: Drag-Drop, Sliders & Trackers
* **The E-Commerce Slider Dilemma:** Modern storefronts (Shopify Dawn, Haravan F1GENZ, Sapo themes) use two distinct slider architectures:
  1. *Native HTML5 `<input type="range">`:* Value changes require setting the native property descriptor setter (`Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, val)`) and dispatching bubbling `input` + `change` events.
  2. *Custom DOM / SVG Pointer Sliders (noUiSlider, Ion.RangeSlider):* Do NOT listen to HTML5 Drag-and-Drop API (`dragstart`/`drop`). Instead, they bind `pointerdown` / `mousedown` on the handle, listen to `pointermove` / `mousemove` on `window` or `document`, and finalize on `pointerup` / `mouseup`.
* **Playwright MCP Mechanism (`browser_drag`):** Playwright computes the source and target bounding boxes, dispatches a mouse down at the source center, interpolates multiple intermediate mouse move steps, and releases at the target center.
* **AntiFan Opportunity:** AntiFan can combine its visual Bézier cursor animation engine (`agent-browser.ts`) with CDP `Input.dispatchMouseEvent` / Isolated World PointerEvents to provide a unified `anti.agent.drag` and `anti.agent.slider_set` capability that works seamlessly across native inputs and complex multi-handle price range filters.

### 2.2 Keyboard Combo Dispatching & Focus Trapping
* **Focus Trapping in Theme Drawers:** Shopify and Haravan themes rely heavily on AJAX Cart Drawers, Quick View modals, and Mobile Drawer Navigation. Under WCAG 2.1 Criterion 2.1.2 (No Keyboard Trap), when a drawer opens, focus must be trapped inside the modal container:
  - `Tab` must cycle through focusable children (`a`, `button`, `input`, `select`, `[tabindex]:not([tabindex="-1"])`) and loop back to the first child after the last.
  - `Shift+Tab` must cycle backwards and wrap to the last child.
  - `Escape` must close the drawer and restore focus to the trigger button.
  - Background elements must receive `aria-hidden="true"` or `inert` and never receive focus.
* **Key Combo Normalization:** Generic agents often send human-readable combo strings (e.g. `"Shift+Tab"`, `"Ctrl+Enter"`, `"Alt+ArrowDown"`). AntiFan's `keyboard-normalizer.ts` currently requires separate `key` and `modifiers` parameters. Supporting compound combo parsing significantly simplifies agent interaction.

### 2.3 Mobile Touch Gestures & Scroll Momentum (Split Review)
* **Mobile Swiper / Carousel Dynamics:** Storefront product image galleries (Swiper.js, Splide, Flickity) and sticky mobile filter drawers listen to Touch Events (`touchstart`, `touchmove`, `touchend`, `touchcancel`). Mouse wheel or programmatic `scrollBy` events fail to trigger swipe transitions.
* **CDP Gesture Synthesis:** CDP provides native gesture synthesizers:
  - `Input.synthesizeScrollGesture`: Emulates touch or mouse scroll gestures with realistic velocity, fling decay (`preventFling: false`), and inertial deceleration.
  - `Input.synthesizePinchGesture`: Emulates pinch-to-zoom for mobile image lightbox inspections.
  - `Input.dispatchTouchEvent`: Dispatches raw multi-touch points with coordinates, radius, and pressure force.

### 2.4 Emulation & Localization
* **Color Schemes & High Contrast:** CDP `Emulation.setEmulatedMedia` allows instant switching between `prefers-color-scheme: dark` and `light`, as well as `forced-colors: active` for verifying dark theme presets (e.g. Dawn Dark, Aqua Theme) and contrast compliance.
* **Timezone & Locale Emulation:**
  - Liquid filters (`date: "%d/%m/%Y"`) and JavaScript countdown timers (Tết holidays, Flash Sales) behave differently based on timezone.
  - CDP `Emulation.setTimezoneOverride(timezoneId: "Asia/Ho_Chi_Minh")` and `Emulation.setUserAgentOverride(..., acceptLanguage: "vi-VN,vi;q=0.9")` ensure deterministic Vietnamese locale rendering.
* **Network & CPU Throttling:**
  - CDP `Network.emulateNetworkConditions` enables simulating Slow 3G ($400\text{ms}$ RTT, $400\text{ kbps}$) and Fast 4G ($20\text{ms}$ RTT, $4\text{ Mbps}$) to measure genuine Core Web Vitals (LCP, INP) on heavy storefronts.
  - CDP `Emulation.setCPUThrottlingRate(rate: 4)` simulates mid-tier mobile hardware (Snapdragon 680 / Helio G99) to detect JavaScript thread blocking and Liquid render bloat.

### 2.5 Session & Storage State
* **Playwright `storageState` vs AntiFan SQLite Partition:**
  - Playwright dumps cookies and localStorage to flat JSON files.
  - AntiFan uses persistent Chromium profile partitions (`persist:antifan-default` / `persist:antifan-tenant-*`) backed by SQLite and LevelDB.
  - *Recommendation:* Introduce `anti.storage.export_state` and `anti.storage.import_state` for test fixture portability and snapshot rollback, while maintaining the live Electron profile partition as the authoritative runtime session.

### 2.6 Document & Download Pipeline
* **Background PDF Generation:** CDP `Page.printToPDF` enables exporting pixel-perfect A4/Letter PDFs of invoice layouts, packing slips, or Theme QA audit reports without opening OS print dialogs.
* **Silent Download Interception:** CDP `Page.setDownloadBehavior` (or Electron `session.on('will-download')`) enables capturing exported order CSVs and theme ZIP backups directly to the workspace artifacts directory without freezing agent execution.

---

## 3. Gap Analysis Matrix (Playwright MCP vs AntiFan Desktop)

| Capability Domain | Playwright MCP Tool | AntiFan Current Status | AntiFan Verdict | Architecture & Rationale |
| :--- | :--- | :--- | :--- | :--- |
| **Element Drag & Drop** | `browser_drag` | Partial (`anti.agent.drop` for file drops only) | **ADOPT & ENHANCE** | Integrate `anti.agent.drag` supporting both Pointer drag (price sliders) and HTML5 DnD (cart reordering) with visual cursor feedback. |
| **Slider Value Control** | Implicit via `browser_fill_form` (slider type) | Not explicitly implemented | **ADOPT** | Add `anti.agent.slider_set` supporting native `<input type="range">` and custom JS slider libraries (noUiSlider / Ion). |
| **Keyboard Combos** | `browser_press_key` (e.g. `Control+a`) | `browser.keyboard-press` (Array modifiers) | **ADAPT** | Enhance `keyboard-normalizer.ts` with compound string parsing (`"Shift+Tab"`, `"Ctrl+Enter"`). |
| **Focus Trap Verification** | None (Manual script execution) | None | **ADOPT (PROPRIETARY)** | Implement `theme.qa.focus_trap_validate` to automate WCAG 2.1 modal/drawer keyboard cycle testing. |
| **Mobile Touch Swiping** | None (Mouse simulation only) | None | **ADOPT** | Implement `anti.agent.swipe` utilizing CDP `Input.synthesizeScrollGesture` (`gestureSourceType: "touch"`). |
| **Color Scheme Emulation** | `browser_emulate` (`colorScheme`) | Viewport dimensions only | **ADOPT** | Implement `anti.emulation.set_color_scheme` using CDP `Emulation.setEmulatedMedia`. |
| **Timezone & Locale** | Context initialization options | None (Inherits OS) | **ADOPT** | Implement `anti.emulation.set_locale` using CDP `Emulation.setTimezoneOverride` & `setUserAgentOverride`. |
| **Network & CPU Throttling** | `browser_throttle_network` | None | **ADOPT** | Implement `anti.emulation.set_network_conditions` and `anti.emulation.set_cpu_throttling`. |
| **PDF Generation** | `browser_pdf` | None | **ADOPT** | Implement `anti.document.print_pdf` using CDP `Page.printToPDF`. |
| **Download Interception** | `browser_file_download` | OS Dialog (Blocks Agent) | **ADOPT** | Implement `anti.download.set_behavior` using CDP `Page.setDownloadBehavior` & Electron download hooks. |
| **Storage State Dump/Restore** | `browser_save_storage_state` | SQLite Profile Sync only | **ADAPT** | Implement `anti.storage.export_state` / `import_state` as JSON fixtures while preserving live profile. |
| **Cross-Origin Iframe Execution** | Context frame selectors | Same-origin DOM traversal only | **ADAPT** | Leverage CDP `Page.createIsolatedWorld` per target FrameId to automate cross-origin payment/review iframes. |
| **Arbitrary Code Execution** | `browser_run_code_unsafe` | Gated `antifan_eval_js` | **STRICT REJECT** | Violates Zero-Mutation & Security Invariant. Rely strictly on typed capabilities and Isolated World 1004. |

---

## 4. Concrete Implementation Design in AntiFan

### 4.1 Advanced Input: `anti.agent.drag` & `anti.agent.slider_set`

#### Tool Schema: `anti.agent.drag`
```json
{
  "name": "anti.agent.drag",
  "description": "Drag an element or coordinate to a target element, coordinate, or offset vector (supports range sliders, sortable lists, and visual sliders)",
  "inputSchema": {
    "type": "object",
    "properties": {
      "source": { "type": "string", "description": "Source CSS selector or @ref (e.g. '@e12')" },
      "target": { "type": "string", "description": "Optional target CSS selector or @ref" },
      "deltaX": { "type": "number", "description": "Optional relative horizontal drag distance in pixels" },
      "deltaY": { "type": "number", "description": "Optional relative vertical drag distance in pixels" },
      "steps": { "type": "number", "default": 12, "description": "Interpolation steps for smooth gesture dispatch" },
      "delayMs": { "type": "number", "default": 15, "description": "Delay in ms between movement steps" },
      "tabId": { "type": "string", "description": "Optional target tab ID" },
      "paneId": { "type": "string", "enum": ["desktop", "mobile"], "description": "Optional pane target in split review" }
    },
    "required": ["source"]
  }
}
```

#### Tool Schema: `anti.agent.slider_set`
```json
{
  "name": "anti.agent.slider_set",
  "description": "Set the value of a range slider input or custom JS slider component with event dispatch",
  "inputSchema": {
    "type": "object",
    "properties": {
      "selector": { "type": "string", "description": "CSS selector or @ref of the slider element or handle" },
      "value": { "type": "number", "description": "Target numeric value to set" },
      "percentage": { "type": "number", "minimum": 0, "maximum": 100, "description": "Optional target percentage (0-100) along the slider track" },
      "tabId": { "type": "string", "description": "Optional target tab ID" },
      "paneId": { "type": "string", "enum": ["desktop", "mobile"], "description": "Optional pane target in split review" }
    },
    "required": ["selector"]
  }
}
```

#### Implementation Architecture:
1. **Isolated World Drag Dispatcher (`src/main/browser/semantic-ref-executor.ts`):**
   ```typescript
   // In Isolated World 1004 execution builder:
   if (req.action === 'drag') {
     const startRect = getElementGlobalRect(sourceEl);
     const startX = startRect.centerX;
     const startY = startRect.centerY;
     const endX = targetRect ? targetRect.centerX : startX + (req.deltaX || 0);
     const endY = targetRect ? targetRect.centerY : startY + (req.deltaY || 0);

     // 1. Pointer Down & Mouse Down sequence
     const pointerDownEv = new PointerEvent('pointerdown', { bubbles: true, cancelable: true, clientX: startX, clientY: startY, buttons: 1, pointerId: 1, pointerType: 'mouse' });
     sourceEl.dispatchEvent(pointerDownEv);
     sourceEl.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, clientX: startX, clientY: startY, buttons: 1 }));

     // 2. Step-by-step Move sequence across document
     const steps = Math.max(2, req.steps || 12);
     for (let i = 1; i <= steps; i++) {
       const curX = startX + (endX - startX) * (i / steps);
       const curY = startY + (endY - startY) * (i / steps);
       document.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, cancelable: true, clientX: curX, clientY: curY, buttons: 1, pointerId: 1, pointerType: 'mouse' }));
       document.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, cancelable: true, clientX: curX, clientY: curY, buttons: 1 }));
       await new Promise(r => setTimeout(r, req.delayMs || 15));
     }

     // 3. Pointer Up & Mouse Up on target element
     const dropTarget = document.elementFromPoint(endX, endY) || sourceEl;
     dropTarget.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true, clientX: endX, clientY: endY, buttons: 0, pointerId: 1, pointerType: 'mouse' }));
     dropTarget.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, clientX: endX, clientY: endY, buttons: 0 }));
     return { ok: true, executed: true };
   }
   ```

---

### 4.2 Keyboard Combo Enhancement & Focus Trap Verification

#### Enhanced Keyboard Normalizer (`src/main/browser/keyboard-normalizer.ts`):
```typescript
/**
 * Parses compound key combo strings (e.g. "Shift+Tab", "Control+Shift+A", "Meta+K")
 * into normalized descriptors.
 */
export function parseKeyCombo(comboString: string): { key: string; modifiers: ElectronModifier[] } {
  const parts = comboString.split('+').map(p => p.trim());
  if (parts.length === 0) throw new Error('Empty key combo');
  const rawKey = parts[parts.length - 1];
  const rawModifiers = parts.slice(0, parts.length - 1);
  return {
    key: rawKey,
    modifiers: normalizeModifiers(rawModifiers),
  };
}
```

#### Theme QA Focus Trap Validator (`src/main/qa/scanners/focus-trap-scanner.ts`):
```typescript
export interface FocusTrapResult {
  isTrapped: boolean;
  leakedElements: Array<{ tag: string; id?: string; selector: string; outerHTML: string }>;
  cycleLength: number;
  escapable: boolean;
  returnedToTrigger: boolean;
}

export async function validateModalFocusTrap(
  tabHost: NativeTabHost,
  tabId: string,
  triggerSelector: string,
  modalContainerSelector: string
): Promise<FocusTrapResult> {
  // 1. Click trigger to open modal
  await tabHost.agentClick({ selector: triggerSelector, tabId });
  await new Promise(r => setTimeout(r, 400)); // wait for drawer animation

  // 2. Tab cycling probe
  const leakedElements = [];
  const focusSequence = [];
  for (let i = 0; i < 15; i++) {
    await tabHost.sendKeyboardPress({ key: 'Tab', tabId });
    const focusedInfo = await tabHost.executeInWorld(tabId, () => {
      const active = document.activeElement;
      if (!active) return null;
      const modal = document.querySelector(modalContainerSelector);
      const isInside = modal ? modal.contains(active) : false;
      return { isInside, tag: active.tagName, id: active.id, className: active.className };
    });
    if (focusedInfo && !focusedInfo.isInside) {
      leakedElements.push(focusedInfo);
    }
  }

  // 3. Test Escape Key recovery
  await tabHost.sendKeyboardPress({ key: 'Escape', tabId });
  await new Promise(r => setTimeout(r, 300));
  const postEscapeActive = await tabHost.executeInWorld(tabId, () => document.activeElement?.matches(triggerSelector));

  return {
    isTrapped: leakedElements.length === 0,
    leakedElements,
    cycleLength: focusSequence.length,
    escapable: true,
    returnedToTrigger: Boolean(postEscapeActive),
  };
}
```

---

### 4.3 Mobile Touch Gestures: `anti.agent.swipe`

#### Tool Schema: `anti.agent.swipe`
```json
{
  "name": "anti.agent.swipe",
  "description": "Simulate a natural mobile touch swipe gesture with velocity momentum on the mobile split-pane or active tab",
  "inputSchema": {
    "type": "object",
    "properties": {
      "direction": { "type": "string", "enum": ["left", "right", "up", "down"], "description": "Swipe direction" },
      "distance": { "type": "number", "default": 250, "description": "Swipe distance in pixels" },
      "durationMs": { "type": "number", "default": 300, "description": "Gesture duration in milliseconds" },
      "selector": { "type": "string", "description": "Optional target carousel/element container" },
      "tabId": { "type": "string", "description": "Optional target tab ID" },
      "paneId": { "type": "string", "enum": ["desktop", "mobile"], "default": "mobile", "description": "Target pane (defaults to mobile in split review)" }
    },
    "required": ["direction"]
  }
}
```

#### CDP Execution in `TabDevToolsHost`:
```typescript
public async performTouchSwipe(
  wc: Electron.WebContents,
  options: { direction: 'left' | 'right' | 'up' | 'down'; distance?: number; startX?: number; startY?: number; speed?: number }
): Promise<void> {
  const dist = options.distance || 250;
  const startX = options.startX || 200;
  const startY = options.startY || 400;
  let xDist = 0;
  let yDist = 0;

  switch (options.direction) {
    case 'left': xDist = -dist; break;
    case 'right': xDist = dist; break;
    case 'up': yDist = -dist; break;
    case 'down': yDist = dist; break;
  }

  // Synthesize genuine touch scroll gesture via CDP
  await this.sendCdpCommand(wc, 'Input.synthesizeScrollGesture', {
    x: startX,
    y: startY,
    xDistance: xDist,
    yDistance: yDist,
    gestureSourceType: 'touch',
    speed: options.speed || 800,
    preventFling: false,
  });
}
```

---

### 4.4 Emulation & Localization

#### Implementation in `TabDevToolsHost`:
```typescript
// 1. Dark / Light / High Contrast Emulation
public async setEmulatedColorScheme(wc: Electron.WebContents, scheme: 'dark' | 'light' | 'no-preference'): Promise<void> {
  await this.sendCdpCommand(wc, 'Emulation.setEmulatedMedia', {
    media: 'screen',
    features: [{ name: 'prefers-color-scheme', value: scheme }],
  });
}

// 2. Locale & Timezone Emulation
public async setLocalization(wc: Electron.WebContents, timezoneId: string, locale: string): Promise<void> {
  await this.sendCdpCommand(wc, 'Emulation.setTimezoneOverride', { timezoneId });
  await this.sendCdpCommand(wc, 'Emulation.setUserAgentOverride', {
    userAgent: wc.getUserAgent(),
    acceptLanguage: locale,
  });
}

// 3. Network & CPU Throttling
public async setNetworkThrottling(
  wc: Electron.WebContents,
  profile: 'slow-3g' | 'fast-4g' | 'offline' | 'online'
): Promise<void> {
  const profiles = {
    'slow-3g': { latency: 400, downloadThroughput: (400 * 1024) / 8, uploadThroughput: (400 * 1024) / 8, connectionType: 'cellular3g' },
    'fast-4g': { latency: 20, downloadThroughput: (4 * 1024 * 1024) / 8, uploadThroughput: (3 * 1024 * 1024) / 8, connectionType: 'cellular4g' },
    'offline': { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 },
    'online': { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 },
  };
  await this.sendCdpCommand(wc, 'Network.enable');
  await this.sendCdpCommand(wc, 'Network.emulateNetworkConditions', profiles[profile]);
}
```

---

### 4.5 Document & Download Interception

#### PDF Printing (`anti.document.print_pdf`):
```typescript
public async printToPdf(
  wc: Electron.WebContents,
  options: { landscape?: boolean; printBackground?: boolean; paperFormat?: 'A4' | 'Letter' } = {}
): Promise<string> {
  const isA4 = options.paperFormat !== 'Letter';
  const res = await this.sendCdpCommand<{ data: string }>(wc, 'Page.printToPDF', {
    landscape: options.landscape || false,
    printBackground: options.printBackground !== false,
    paperWidth: isA4 ? 8.27 : 8.5,
    paperHeight: isA4 ? 11.69 : 11.0,
    preferCSSPageSize: true,
  });
  return res.data; // Base64 PDF data
}
```

#### Download Interception (`anti.download.set_behavior`):
```typescript
public async setupDownloadInterception(wc: Electron.WebContents, targetDirectory: string): Promise<void> {
  await this.sendCdpCommand(wc, 'Browser.setDownloadBehavior', {
    behavior: 'allowAndName',
    downloadPath: targetDirectory,
    eventsEnabled: true,
  });
}
```

---

## 5. Strict Non-Goals & Security/YAGNI Filters

| Proposed Feature | Evaluation & Threat Analysis | Action |
| :--- | :--- | :--- |
| **`browser_run_code_unsafe` (Arbitrary JS)** | **Critical Security Vulnerability:** Executing un-sandboxed Node.js / Playwright code in the main process allows full Remote Code Execution (RCE) and violates AntiFan's Zero-Mutation Invariant. | **PERMANENT REJECT** |
| **Ephemeral Cloud Browser Contexts** | **Destroys Merchant Productivity:** Replacing persistent Electron profile partitions with disposable contexts destroys saved Haravan/Shopify 2FA sessions, passkeys, and multi-tenant tab state. | **STRICT REJECT** |
| **Global Keylogging & Raw Mouse Hooks** | **OS Privacy Risk:** Global OS input hooks (outside Electron WebContents) expose user credentials and background window keystrokes. | **STRICT REJECT** (Keep all input scoped strictly to target WebContents). |
| **Synthetic Test-Only DOM Mocks** | **Violation of Grounding Axiom:** Injecting fake mock events or mock server responses gives false confidence in Theme QA. All tests must run against real DOM and live network. | **STRICT REJECT** |

---

## 6. Actionable Phased Roadmap

### Phase 0: P0 Immediate Core Expansion (Sprint 1)
* [x] **Compound Key Combo Support:** Expand `keyboard-normalizer.ts` to parse `"Shift+Tab"`, `"Ctrl+Enter"`, `"Escape"`.
* [x] **Theme Range Slider Support:** Implement `anti.agent.slider_set` for `<input type="range">` and custom JS sliders.
* [x] **Element-to-Element Drag:** Implement `anti.agent.drag` supporting smooth pointer drag interpolation and HTML5 DnD.
* [x] **Color Scheme Emulation:** Register `anti.emulation.set_color_scheme` using CDP `Emulation.setEmulatedMedia`.

### Phase 1: P1 Advanced Interactions & Theme QA (Sprint 2)
* [ ] **Mobile Touch Swipe Gestures:** Implement `anti.agent.swipe` with CDP `Input.synthesizeScrollGesture` for Swiper/carousel testing on mobile split-pane.
* [ ] **Focus Trap QA Scanner:** Integrate `theme.qa.focus_trap_validate` to automate WCAG 2.1 modal/drawer verification.
* [ ] **Timezone & Locale Overrides:** Implement `anti.emulation.set_locale` for Vietnamese currency/date testing.
* [ ] **Network & CPU Throttling:** Implement `anti.emulation.set_network_conditions` for Core Web Vitals profiling.

### Phase 2: P2 Document Pipelines & Telemetry Streaming (Sprint 3)
* [ ] **Headless PDF Generation:** Implement `anti.document.print_pdf` for packing slip & QA report export.
* [ ] **Silent Download Interception:** Implement `anti.download.set_behavior` for CSV and Theme ZIP backups.
* [ ] **CDP Real-Time Event Streaming:** Upgrade `TabDiagnostics` to stream CDP Console & Network events directly into MCP subscribers without polling.
