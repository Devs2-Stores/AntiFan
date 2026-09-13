# IMMUTABLE EVIDENCE PACKET — `--ultra` Brainstorm
## Topic: AntiFan "Real Device" backend option (iPhone on Windows) as an alternative/complement to Chromium mobile emulation

This packet is frozen. Every candidate receives this exact text. Do not re-scout from scratch; you MAY read the cited files to deepen understanding, but the facts below are authoritative.

---

## 1. USER REQUEST (verbatim intent)

> "Nếu vấn đề Mobile thật mãi không giải quyết được, tôi đề xuất cho AntiFan thêm option cắm điện thoại thật vô và điều phối điện thoại thật thay vì Chromium thì sao nhỉ, tôi dùng Windows và có điện thoại iOS"

Translation of intent: If the mobile-fidelity problem in AntiFan genuinely cannot be solved by Chromium emulation, add an **option** to AntiFan where the user plugs in a **physical phone** and AntiFan orchestrates **that real device** instead of Chromium. User environment: **Windows 11** host, owns a **physical iPhone**.

Key words that shape the contract: **"thêm option"** (add an option — i.e. additive, opt-in, not a replacement), **"thay vì Chromium"** (as an alternative path for the mobile surface), **"nếu ... mãi không giải quyết được"** (conditional on Chromium mobile emulation being insufficient — the user is not asserting it must be ripped out).

---

## 2. CONFIRMED EVIDENCE — THE ACTUAL "MOBILE PROBLEM" INSIDE ANTIFAN

### 2.1 Measured runtime failures observed in this session (Tier-1 telemetry, not inference)

**Failure A — `VIEWPORT_NOT_APPLIED` during mobile viewport set.**
- Request: `anti.browser.set_viewport { width: 390, height: 844, mobile: true }`
- Result: `Error: VIEWPORT_NOT_APPLIED: Tab 'da64182d-...' measures 660x1429 after requesting 390x844`
- Workaround that succeeded: pass `mobile: false` explicitly → `{"success":true,"width":390,"height":844,"mobile":false,"presetId":"custom-390x844","observedWidth":390,"observedHeight":844,"verified":true}`
- Measured DOM state at failure: `{ innerWidth: 660, innerHeight: 1429, clientWidth: 390, clientHeight: 844, dpr: 2 }`

**Root cause (proven by code read):** `applyTabDeviceEmulation` in `src/main/browser/native-tab-host.ts:4644-4677` computes `fitScale = Math.min(1.0, maxW / preset.width, maxH / preset.height)` and passes it as `scale` to `safeEnableDeviceEmulation`. Chromium's emulation `scale` makes `window.innerWidth` report the *visual* viewport (390/0.5909 ≈ 660) while `document.documentElement.clientWidth` reports the *layout* viewport (390). The verification probe preferred `window.innerWidth` and therefore measured the wrong surface.
- Patched this session (already applied, compiled): `RENDER_SURFACE_PROBE_EXPRESSION` in `src/main/verification/visual-capture.ts:720-726` and the `evalJs` probe in `src/main/tools/browser-control-port.ts:2722-2724` now prefer `document.documentElement.clientWidth/clientHeight` when positive.

> **CRITICAL FRAMING:** Failure A is a *measurement bug*, and it is now fixed. It is NOT the deep mobile problem. Do not conflate them.

### 2.2 The structural limitation (this is the real problem)

Chromium mobile emulation runs **Blink**, not **WebKit**. AntiFan's mobile surface today is:
- A desktop Chromium WebContentsView resized + `Emulation.setDeviceMetricsOverride`'d to phone metrics.
- In Split Review Mode, a **second Chromium WebContentsView** drawn inside a phone bezel — still Blink.

Consequence: iOS Safari-specific behavior is **structurally unobservable**:
- `env(safe-area-inset-*)` notch/home-indicator insets and `viewport-fit=cover`
- `100dvh` / dynamic toolbar collapse behavior as the URL bar hides on scroll
- `position: fixed` + momentum/overscroll rubber-band, background scroll lock quirks
- iOS `-webkit-` prefix gaps, `-webkit-fill-available`, `input` zoom-on-focus below 16px
- WebKit font rasterization/metrics and `font-size-adjust` behavior
- iOS `<select>`/date-picker native UI, `touch-action`, tap-highlight, 300ms behaviors

**Every one of these is a real theme-QA class of bug that Chromium emulation cannot surface at all.** This is the honest reason a real-device option is worth considering — not the viewport-measurement bug that was already fixed.

### 2.3 Confirmed AntiFan architecture facts (file-cited)

| Fact | Evidence |
|---|---|
| There is a clean host abstraction seam | `interface BrowserHostPort` at `src/main/tools/browser-control-port.ts:103-177` — ~75 mostly-OPTIONAL methods. A second backend can implement a subset; optionality means capability-level feature detection is already the house pattern. |
| Current backend is Electron/Chromium-CDP only | `class NativeTabHost extends EventEmitter` at `src/main/browser/native-tab-host.ts:354`; `readRenderSurface` delegates to `getDevToolsHost()` (`native-tab-host.ts:5822-5824`) which issues raw `Runtime.evaluate` CDP (`tab-devtools-host.ts:840-864`). |
| No third-party automation driver exists | `package.json` dependencies: `@modelcontextprotocol/sdk, @xterm/*, cross-spawn, node-pty, tldts, ws, zod`. Dev: `@electron/packager, @types/node, @types/ws, electron, esbuild, typescript`. **No Playwright, no Puppeteer, no Appium, no WebDriver client.** |
| A phone-to-AntiFan transport ALREADY exists | `src/main/bridge/bridge-server.ts` is an authenticated local WebSocket RPC server that explicitly includes "Mobile Remote Companion Web App, Live Viewport streaming, and Terminal RPC". `renderMobileRemoteHtml()` (`src/main/bridge/mobile-remote-html.ts:12`) emits a full mobile web app the phone opens in **its own native browser**; `generateQrSvg` provides pairing. |
| Mobile target surface is pair-aware | `paneId?: 'desktop' \| 'mobile'` is threaded through the entire capability layer, and `SplitReviewCoordinator` (`src/main/browser/split-review-coordinator.ts`) owns dual-pane geometry with `DEVICE_PRESETS`. |
| Device presets are pure metadata | `src/main/browser/device-presets.ts` (109 lines) — iPhone 16 Pro Max 440×956 DPR 3, iPhone 15 Pro 393×852 DPR 3, iPhone 14/13 390×844 DPR 3, iPhone SE 375×667 DPR 2, iPads, Galaxy, Surface. `mobile: true`, `platform: 'iPhone'`, `maxTouchPoints`, `cornerRadius`, `userAgent`. |
| Host is Windows 11 x64, Electron; a shipped native binary convention exists | Root `bin/antifan-bridge-host.exe` exists, so shipping an external companion binary is already an accepted pattern. |

### 2.4 External reality check — iOS automation on Windows (web-researched, 2026)

**`go-ios` (github.com/danielpaulus/go-ios)** — Go reimplementation of Apple lockdown/DTX. On Windows it can: pair/manage devices, install `.ipa`, launch/kill processes, manage developer disk images, run usbmux tunnels (required iOS 17+, needs `wintun.dll` copied into `C:\Windows\system32`), and **run XCTest/WebDriverAgent** (`ios run-wda --bundlepath ... --xctestrun ...`), which exposes the standard **WebDriver REST API** locally.
- **Hard blocker:** Apple requires WDA (`WebDriverAgentRunner.xctest`) to be **signed and compiled with Xcode**, which does not exist on Windows. You must obtain a pre-built/signed WDA bundle from a **one-time macOS access** (cloud Mac, GitHub Actions macOS runner, or a borrowed Mac).
- **Expiry:** free Apple ID signing expires the WDA bundle **every 7 days**; requires re-sign and re-push.
- **Fragility:** major iOS updates alter DTX/lockdown internals; requires tracking `go-ios` updates.

**`ios-webkit-debug-proxy` (IWDP) on Windows** — exposes real Safari/`WKWebView` for inspection by translating WebKit Remote Debugging Protocol → CDP.
- Requires `libimobiledevice`, `libplist`, `usbmuxd`, plus **iTunes / Apple Mobile Device Support** drivers on the Windows host.
- Native Windows support is incomplete; needs third-party MinGW/MSVC ports or WSL/Cygwin.
- Largely **unmaintained**; new iOS versions routinely break device detection until patched.
- Protocol translation **degrades features**: no `Profiler.getProfile`, no memory/FPS timeline, unreliable console/exception sync, frequent blank DevTools panes.
- **Connection instability:** screen lock, display off, or minor USB hiccups drop the tunnel; requires restarts and replugging.

**Cloud real-device farms (BrowserStack / Sauce Labs / LambdaTest)** — the industry's standard escape hatch; remote macOS runners with real devices. Requires a paid account, network egress, and uploading the target URL.

**Android contrast (for honesty about asymmetry):** Android+Chrome exposes CDP directly over `adb forward` — a real-device Android option is dramatically cheaper than iOS on Windows. Any design should say this plainly.

---

## 3. CONSTRAINTS (fixed)

1. **Windows 11 host** is the primary and only guaranteed dev environment. Any design requiring a Mac at *runtime* is disqualified as the default path.
2. **Additive, opt-in.** The user said "thêm option". Chromium remains the default and must keep working unchanged. No regression to the existing mobile emulation path, splits, or presets.
3. **Must fit the existing host seam.** The house pattern is `BrowserHostPort` (optional methods) + the capability catalogue (`browser-capabilities.ts`, 176 capabilities) + `paneId: 'desktop'|'mobile'` threading. A design that forks the capability layer wholesale is high-risk.
4. **MCP-first invariant.** The user's standing protocol requires MCP tools (`anti.browser.*`, `anti.inspect.*`, `anti.screenshot.*`) to remain the orchestration surface. New capability must be reachable as MCP tools, not a side app.
5. **Evidence integrity.** AntiFan's whole value is *truthful* measurement. A real-device path that silently reports Chromium numbers, or that fakes a device status, violates the core contract. Any real-device path must be able to **prove** it is talking to the physical device (identity evidence: device UDID/model/iOS version, real screenshot pixels).
6. **No unverifiable claims.** Availability of an external tool must be detected at runtime, not assumed.
7. **Safety.** USB device control and external binaries must not be launched without explicit user opt-in; a missing prerequisite must fail closed with a clear remediation message, not silently degrade.

---

## 4. NON-GOALS (explicitly out of scope)

- Replacing or deleting Chromium mobile emulation.
- iOS *app* automation (native app UI, XCTest flows unrelated to the browser surface).
- Building a general-purpose Appium/WebDriver test framework inside AntiFan.
- Running AntiFan on macOS or Linux.
- Cloud device-farm integration as the primary deliverable (it may be mentioned as an alternative, not designed in depth).

---

## 5. WHAT A WINNING ANSWER MUST CONTAIN

A complete **bounded brainstorm contract** with all four fields:

1. **Outcome** — the user-visible/operational end state, stated concretely enough to observe.
2. **Constraints** — as in §3, extended with any you prove.
3. **Non-goals** — as in §4, extended with any you prove.
4. **Acceptance criteria** — *observable evidence*, not intentions. Must be sharp enough that a reviewer could determine pass/fail without asking a follow-up question.

Plus:
5. **A recommended direction**, and **up to three viable approaches** with meaningful trade-offs. For each: the assumption it most depends on, and the condition under which it fails first. Compare on **worst plausible case**, not best case.
6. **Explicit honesty about unknowns** — separate what is discoverable (can be verified by reading code/docs/hardware) from what is not (future iOS updates, Apple policy changes, user hardware variation).
7. **A recommendation of the smallest approach that satisfies the contract**; when a load-bearing assumption cannot be resolved now, prefer the approach **cheapest to abandon**.

### Hard requirements the verifier will check

- **HR-1:** The candidate must NOT present the `VIEWPORT_NOT_APPLIED` measurement bug as the justification for a real-device path. That bug is fixed (§2.1). The justification must be the structural Blink-vs-WebKit gap (§2.2) or a similarly real, still-open limitation.
- **HR-2:** The candidate must address the **macOS bootstrapping blocker** for iOS/WDA honestly and propose a concrete resolution (one-time macOS, pre-built signed bundle, or route around WDA entirely). Silently assuming WDA "just works" on Windows is a disqualifying error.
- **HR-3:** The candidate must respect the additive/opt-in constraint and name the concrete integration seam (e.g. `BrowserHostPort` + capability catalogue), not hand-wave "add a driver layer".
- **HR-4:** The candidate must state explicitly **which AntiFan capabilities cannot be delivered** on a real iOS device through the proposed path (e.g. no `Runtime.evaluate` if WDA-only; no CDP `DOM.*`, no `anti.inspect.styles`), rather than implying full parity.
- **HR-5:** The candidate must include at least one approach that **does not require WebDriverAgent at all** — i.e. it explores the space rather than committing to one vendor tool.
- **HR-6:** If the candidate claims a fact about AntiFan internals, it must cite a file path consistent with §2.3.

---

## 6. RUBRIC (used by the verifier; 1–20 per criterion)

| # | Criterion | What earns a high score |
|---|---|---|
| R1 | **Faithfulness to the request** | Solves "plug in a real phone and orchestrate it, as an option, on Windows, for an iPhone owner" — additive, opt-in, no scope invention. |
| R2 | **Evidence grounding** | Every load-bearing claim traceable to §2 or a cited file; no invented AntiFan internals; no vendor capability asserted without basis. |
| R3 | **Sharpness of acceptance criteria** | Each criterion is observable and falsifiable; a reviewer can judge pass/fail without follow-up. |
| R4 | **Honesty about unknowns** | Clearly separates discoverable from unknowable; states failure modes first; names what would falsify the recommendation. |
| R5 | **Feasibility on Windows + iPhone** | Respects the macOS/WDA blocker, the 7-day signing expiry, tunnel fragility; proposes a path that actually terminates in a working setup. |
| R6 | **Smallest-sufficient scope** | Prefers the cheapest-to-abandon approach that meets the contract; resists inventing frameworks, migrations, or governance. |

Hard-constraint gate: failing HR-1 .. HR-6 caps the candidate regardless of rubric totals.

---

## 7. OUTPUT SHAPE FOR EACH CANDIDATE

```
## Contract
- Outcome:
- Constraints:
- Non-goals:
- Acceptance criteria:

## Approaches (≤3)
### A. <name>
- Shape:
- Most-load-bearing assumption:
- Fails first when:
- Worst plausible case:
- Wins when:
(trade-offs explicit; compare on worst case)
### B. ...
### C. ...

## Recommendation
- Chosen direction + why it is the smallest that satisfies the contract
- Why the others lose
- Capability gaps this path admits (what AntiFan loses vs Chromium)
- Abandon cost / exit ramp

## Unresolved questions (last)
- ...
```
