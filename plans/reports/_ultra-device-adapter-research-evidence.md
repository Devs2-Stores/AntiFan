# IMMUTABLE EVIDENCE PACKET — `ak:research --ultra`
## Topic: AntiFan Real iPhone Device Adapter: Architectural Boundary, Windows 11 Compatibility, RemoteXPC iOS 18+, and DeviceControlPort Design

This packet is frozen and authoritative for all five research candidates.

---

## 1. RESEARCH TRIGGER & NEW EVIDENCE

The user provided an exhaustive deep research report:
`E:\Download\antifan-real-device-research-2026-09-13.md` (1,198 lines, analyzed against AntiFan HEAD `24ca282ae454af5b642f6914f2661341042d0f6a`).

### 1.1 Core Architectural Insight from the Report
1. **Never cram iPhone into `BrowserControlPort`**:
   - `BrowserControlPort` is 298KB, coupled to Chromium/Blink specifics (`tabId`, `BrowserTarget`, CDP queue draining, `documentGeneration`, `paneId: 'desktop'|'mobile'`).
   - Adding iPhone methods into `BrowserControlPort` violates Separation of Concerns and bloats browser abstractions into an "everything automation interface".
2. **The Clean Seam is the Control Plane**:
   AntiFan already has `ControlPlaneRuntime` managing `CapabilityCatalogue`, `CapabilityTransportAdapter`, `ArtifactStore`, `ReceiptStore`, and `TerminalManager`.
   The natural architecture is:
   ```text
   Control Plane
    ├── Browser Capability  -> BrowserControlPort -> Chromium (Desktop + Emulation)
    ├── Device Capability   -> DeviceControlPort  -> iPhone (Real WebKit / Touch)
    └── Terminal Capability -> TerminalManager    -> Real Shell (PTY)
   ```
3. **Execution Target Differentiation**:
   - `BrowserTarget`: `projectId, workspaceId, runtimeId, tabId, browserEpoch, documentGeneration`
   - `DeviceTarget`: `projectId, workspaceId, runtimeId, deviceId (UDID), deviceEpoch, sessionGeneration, surface: 'safari'|'native'`
4. **Product Positioning: "Final Mobile Reality Check"**:
   - Chromium is for the fast fix loop (instant DOM inspection, CSS mutation, fast screenshot, <1s).
   - Real iPhone is for the expensive, truthful final verification gate (WebKit layout, `100dvh`, notch safe-areas, momentum touch physics, Apple font antialiasing).
5. **Windows 11 + iPhone Tech Stack (2026 Reality)**:
   - Appium XCUITest Driver officially supports non-macOS (Windows/Linux) for iOS 18+ via **RemoteXPC** (`appium-ios-remotexpc`).
   - Requires iTunes / Apple Mobile Device Support on Windows for usbmuxd communication.
   - Requires `usePreinstalledWDA = true` to avoid running `xcodebuild` on Windows during session init.
   - WDA setup is a one-time ceremony; daily sessions reuse running WDA.
   - Alternative lightweight path: `go-ios webinspector` or usbmux WebKit Remote Debugging Protocol (WRDP) on port 27753, bypassing Appium server overhead for pure Safari inspection.

---

## 2. RESEARCH QUESTIONS TO RESOLVE

1. **Architecture Boundary**:
   Should AntiFan implement `DeviceControlPort` + `DeviceTarget` as a peer to `BrowserControlPort` under `ControlPlaneRuntime`, or continue overloading `BrowserControlPort` with `paneId: 'mobile'`?
2. **Windows 11 Driver & Transport Stack**:
   Compare the two primary backends for `DeviceControlPort`:
   - **Backend 1: Appium XCUITest with RemoteXPC & preinstalled WDA** (official Appium path on Windows, supports native touch/gestures and Safari, requires Node Appium service).
   - **Backend 2: Native Go-based Usbmux / WebKit RDP Helper** (`go-ios.exe webinspector` + `screenshotr`, standalone Go binary under `bin/`, zero Appium dependency, pure Safari inspection).
   - **Backend 3: Hybrid local bridge** (AntiFan runs a managed background helper process, exposes typed `device.*` MCP capabilities).
3. **Readiness State Machine & Typed Failure Modes**:
   How should AntiFan detect and handle the 7 readiness gates (Connected -> Trusted -> Developer Mode -> UI Automation -> Web Inspector -> Remote Automation -> WDA/Session Ready)?
4. **Local Storefront Networking**:
   When testing local dev stores (`http://localhost:3300`), how does the physical iPhone connect? (Local LAN IP vs reverse proxy vs preview server).
5. **Scope & Anti-Goals**:
   How to strictly bound the device adapter to prevent AntiFan from mutating into an unmaintainable general-purpose device farm?

---

## 3. RUBRIC FOR VERIFIER (Kongming)

- **R1: Architectural Elegance & Codebase Fit**: Respects AntiFan's Control Plane + Adapter architecture; separates Browser from Device cleanly.
- **R2: Windows 11 + iOS Feasibility**: Grounded in current 2026 tech (RemoteXPC, usbmuxd, iOS 18+, WDA reuse, driver requirements).
- **R3: Actionability of API & Implementation Blueprint**: Concrete file paths to create/edit, minimal MCP tool surface (`device.*`), readiness state machine.
- **R4: Performance & Developer Ergonomics**: Preserves fast loop on Chromium; positions real iPhone as decisive final gate; handles localhost networking.
- **R5: Risk & Failure-Mode Rigor**: Robust disconnect handling, typed errors, zero zombie process leaks on Windows.
