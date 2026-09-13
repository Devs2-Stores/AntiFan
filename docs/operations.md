# Antigravity Browser Desktop — Operations

Install, update, logs, rollback, and process ownership for the opt-in desktop
companion. The current Extension browser remains the independent fallback at
every step.

> **Scope Invariant (Personal / Non-Public Tooling):**
> AntiFan Browser Desktop is strictly an internal, personal developer companion.
> Public distribution concerns (such as Chrome Web Store publishing, EV Code
> Signing certificates, and public auto-update servers) are intentionally
> out-of-scope. Installation and upgrades use local packaging (`npm run package`)
> and local script runners.

## Install / upgrade

- Windows x64 installer; user data lives in the per-profile app-data dir.
- Version compatibility is enforced before any side effect: a mismatch returns
  a clear compatibility error and the old Extension browser stays usable.
- Pre-upgrade copies of schemas, profiles, pending handoffs, and delivery
  records are preserved (immutable) so a newer reader never mutates an
  unreadable record, and a rolling downgrade can recover the original bytes.

## Logs export

- Diagnostics export is REDACTED by default: secrets, cookies, authorization,
  and page bodies are stripped (`redactStringValues` + sensitive-key redaction).
- Never export raw page HTML, console bodies, or network response bodies.

## Uninstall / rollback

- Uninstall does NOT delete user browser profiles unless explicitly selected.
- Rollback requires no workspace data migration: stop the desktop app and
  disconnect the bridge; existing commands, iframe browser, captures, MCP
  resources, Queue, and the currently supported Chat behavior continue on the
  current Extension path.
## Exact Conversation Routing (Sidecar Router)

- **Managed Sidecar ID**: `antifan-chat-router`
- **Sidecar Data Directory**: `~/.gemini/antigravity/sidecar_data/antifan-chat-router/data`
- **Routing Protocol**:
  - `Auto Send`: Routed via `sidecar-agentapi` targeting the specific Antigravity conversation ID chosen in the Sidebar session selector.
  - `Draft`: Populates the active-panel composer via standard Extension Host bridge without auto-submitting.
  - `Pre-publication Downgrade`: If Sidecar is offline or unmapped before request publication, opens an explicit Draft in active panel labeled `Active tab draft`.
  - `Post-publication Boundary`: Any timeout or crash after publishing a Sidecar request marks delivery `unknown`; never creates duplicate commands or auto-resends.

### Installation & Management Commands

In `E:/Work/apps/antigravity-browser`:
```bash
# Run compatibility probe
node scripts/probe-agentapi-sidecar.mjs

# Install or update Sidecar configuration
node scripts/install-sidecar.mjs --action install

# Remove Sidecar configuration safely
node scripts/install-sidecar.mjs --action remove
```

### Diagnostics & Badges

- `🎯 Exact đã nhận`: Verified delivery directly to the selected conversation via Sidecar router.
- `⚡ IDE đã nhận`: Verified delivery to the active composer panel via Extension bridge.
- `⏳ Đang gửi...`: Command queued and processing.
- `❌ Lỗi gửi`: Execution failed with bounded error message.
- `⚠️ Không rõ biên nhận`: Execution timed out without definitive receipt; safe manual review required.

---

## Theme QA & Verification Gate Operations

The Theme QA verification engine runs automated quality gates against e-commerce storefront themes (Haravan, Sapo, Shopify).

### Verification Commands

```bash
# Run automated Theme QA verification gate smoke suite
npm run smoke:theme-qa

# Run real Chromium Product Card + Drawer proof and publish only after teardown
npm run smoke:theme-golden-live

# Run three sequential 45-minute Windows freeze certifications
npm run certify:core-freeze

# Run full typecheck and test suite
npm run verify
```

`smoke:theme-golden-live` writes `plans/260905-0012-core-pre-freeze-hardening-and-live-proof/reports/live-theme-proof.json` only after Core owners reach zero, Electron exits, and its process-bound temporary profile is removed. `certify:core-freeze` writes `freeze-certificate.json` only when all three raw reports validate against one frozen build/threshold identity.

### MCP Capabilities for Coding Agents

Coding agents (Antigravity, Claude Code, Cursor) can invoke Theme QA tools over MCP stdio:

- `theme.qa_validate` / `antifan_theme_qa_validate`: Runs full inspection (Liquid errors, layout overflow, broken assets, HS rules, CDP diagnostics) and generates a structured report artifact.
- Kết quả luôn kèm `summary` object (`summary.passed`, `summary.totalIssues`, `summary.criticalCount`). Diagnostics third-party (GTM, FB Pixel, chat widget) chỉ là warning — không fail gate; lỗi first-party/theme-asset (console level ≥ 3, network Chromium âm trừ ERR_ABORTED) hoặc main-frame failure mới tính critical.
- `theme.debug_bundle` / `antifan_theme_debug_bundle`: Returns immediate diagnostic scan results without staging reports.

### PII Sanitization Guarantee

All generated Theme QA reports automatically redact customer emails, phone numbers, and bearer tokens before saving artifacts or transmitting responses.

---

## Semantic Ref Engine & Zero-Mutation World 1004 Operations

The semantic ref subsystem (`SemanticRefRegistry` & `executeJavaScriptInIsolatedWorld(1004)`) provides high-fidelity, zero-mutation DOM introspection and agent interaction.

### Invariants & Guarantees
- **Zero DOM Mutation**: The walker script runs strictly in isolated world 1004. It never injects `data-antifan-ref` attributes, mutation observers, or global window variables into the storefront main world.
- **Main Process Authority**: The Main process assigns monotonic `@e1`, `@e2`, ... ref tags directly from collected raw element descriptors.
- **Fingerprint Invalidation & Stale Ref Protection**: Each published snapshot increments document generation. Click and move actions verify exact fingerprint tags, element centers, and bounding boxes, failing closed with clear error if the node detached or changed.
- **FIFO Target Operation Queue**: Operations (`agentSnapshot`, `agentClick`, `agentMove`, `agentType`) targeting a specific tab and pane (`desktop` | `mobile`) are serialized on a per-target FIFO queue, preventing race conditions during navigation or hydration.

---

## Real-Device (Phone Adapter) Operations

The Phone Adapter drives a physically attached iPhone as the **Tier-2 reality gate**: the Chromium
surface stays the fast loop, and the real device answers what emulation cannot (Safari's live layout
viewport, native momentum scrolling, on-device rendering). It is a peer execution adapter registered
beside the browser port — never a mobile pane of it — and it stages evidence into the same artifact
store, so a device receipt is directly comparable with the Chromium capture that preceded it.

### Prerequisites

- **Attachment (USB)**: `usbmuxd` must be running, because enumeration goes through it. Two flavours
  provide it on Windows: the classic (non-Microsoft-Store) iTunes/Apple Devices install adds
  `AppleMobileDeviceService` plus `Common Files\Apple\Mobile Device Support`, while Microsoft Store
  iTunes serves the same port from `AppleMobileDeviceProcess.exe` (measured on this workstation — see the
  host traps below for what that changes for third-party tools). Without either there is no USB path at
  all, and `device.status` reports a transport failure instead of claiming no device is attached.
- **WebDriverAgent runner**: the automation surface is WebDriverAgent over plain HTTP. No Appium
  server is involved in this path. On iOS 17 and later the runner must be launched through a RemoteXPC
  tunnel, which is what the runbook below covers.
- **Reaching it**: nothing to configure by default. With no `ANTIFAN_WDA_URL`, no
  `ANTIFAN_WDA_CANDIDATES` and no explicit candidates, the adapter bridges the runner's device-side port
  to loopback over usbmux itself (`ANTIFAN_WDA_DEVICE_PORT`, default 8100). Configuring an explicit
  transport **turns that bridge off** and makes the operator its owner — do that when the runner is
  already exposed some other way, not as the default recipe:
  - `ANTIFAN_WDA_URL=http://<host-port-or-lan-ip>:8100`
  - `ANTIFAN_WDA_CANDIDATES=https://preview.example,http://<iphone-lan-ip>:8100`

  An iPhone's `localhost` is the phone's own loopback, not the workstation's, so an explicit transport
  means a LAN address or a forwarded port. A reverse-USB tunnel for localhost is out of scope for this
  milestone.

### Capabilities

| Tool | Purpose |
| --- | --- |
| `device.list` | Enumerate attached devices (live `usbmuxd` enumeration). |
| `device.status` | Tri-state readiness gates (attachment, trust, Developer Mode, UI Automation, WebDriverAgent) plus the current device binding. Never fails on absence. |
| `device.open_safari` | Establish the Safari automation surface (WebDriverAgent session) and return the bound target; optionally deep-link a url. |
| `device.navigate` / `device.reload` | Deep-link open / re-open the remembered url. |
| `device.screenshot` | Real-device screenshot into the artifact store (Tier-2 receipt). |
| `device.tap` / `device.swipe` / `device.type` | Native input; coordinates are CSS points, not raw pixels. |
| `device.wait` | Explicit `timeout`, or `page_loaded` / `stable` frame-stability sampling. |

### Honest semantics (do not over-claim)

- `device.navigate` is a deep-link open: WebDriverAgent returns immediately, never waits for load, and
  exposes no URL readback. A load guarantee cannot be expressed on this transport, so `device.wait`
  reports a **rendering heuristic** and says so in its result.
- `device.reload` has no refresh route to call: it re-opens the last url this adapter navigated to and
  refuses with `DEVICE_OPERATION_UNSUPPORTED` when no url is remembered.
- The viewport reported by `device.status` is `panel-derived` (panel pixels ÷ scale). Safari's live
  layout viewport is only measurable by the page itself, which belongs to the inspection milestone.
- DOM / CSS / console / network inspection is **not** part of this surface. It needs Safari's Web
  Inspector plus Remote Automation, tracked as separate readiness gates (`webInspector`,
  `remoteAutomation`) that stay `unknown` until that milestone lands.
- Three lifetimes stay distinct: `deviceEpoch` (physical attachment), `sessionGeneration` (automation
  session) and the derived rendering surface. A phone still plugged in after WebDriverAgent crashed is
  a session-generation change, not a removed device.

### Failure codes

Every device failure carries a code plus an operator action: `DEVICE_TRANSPORT_UNREACHABLE`,
`DEVICE_NOT_CONNECTED`, `DEVICE_NOT_TRUSTED`, `DEVICE_DEVELOPER_MODE_REQUIRED`,
`DEVICE_UI_AUTOMATION_REQUIRED`, `DEVICE_WDA_NOT_READY`, `DEVICE_SESSION_FAILED`,
`DEVICE_OPERATION_UNSUPPORTED`, `DEVICE_TARGET_STALE`. `DEVICE_TARGET_STALE` distinguishes an
attachment change (`deviceEpoch`) from a recreated session (`sessionGeneration`); both are rebindable
from a fresh `device.status`.

### Verification

```bash
# Control plane → capability family → adapter, against a WebDriverAgent-contract fixture (no phone needed)
npm run smoke:device
```

The fixture speaks the exact WebDriverAgent routes and payload shapes taken from its source, so policy
freeze, device authorization, session generations, artifact staging and request wire format are all
exercised for real; only the USB socket itself needs hardware. It also drives the live discovery path
(no injected enumerator), so a host with no Apple Mobile Device Support must report
`DEVICE_TRANSPORT_UNREACHABLE` with the fix attached instead of a raw socket error.

**This smoke is contract evidence, not device evidence.** A fixture verdict can never be cited as the
Phase 0 hardware gate result.

`npm run probe:device` reports its host layers in order: `usb_presence` (Windows device tree — does the
OS itself see an Apple USB device, and which serial), `host_service` (usbmuxd reachable), `device_lockdown`
(device identity and iOS version read through lockdownd), `usbmux_forward` (in-process usbmux bridge for a
device-side port, see `--forward`), `transport` (a WDA base URL answers). A phone that is visible over USB
while usbmuxd is missing means the cable, port and pairing are fine and only Apple Mobile Device Support is
absent — a different fix from an empty USB bus. The probe writes the serial and the lockdownd facts into
its JSON report.

`--forward <devicePort>` bridges a port the phone itself listens on to `127.0.0.1` with the in-process
usbmux forwarder, with no `iproxy` / `go-ios forward` involved. The adapter does the same thing on its own
while the candidate list is still its own default: when none of those candidates answers, it bridges the
runner's device port (`ANTIFAN_WDA_DEVICE_PORT`, default 8100) over usbmux and only accepts it once
WebDriverAgent answers there. An explicit candidate list, whether from the argument or the environment,
means the operator owns the transport and keeps the bridge off. Bridging is not a RemoteXPC tunnel: it
reaches a port the device already exposes, which is what a running runner provides.

### First-run runbook (Windows, real hardware)

1. **Confirm the USB stack** — run `npm run probe:device` and read `usb_presence` first: it reports what
   Windows itself sees (the Apple USB composite device and its serial). Then trust `host_service` for
   usbmuxd: a `FAILED 1060` from `sc query AppleMobileDeviceService` is **not** proof that support is
   missing, because this workstation has no such service and still serves usbmuxd from the Store iTunes
   (`AppleMobileDeviceProcess.exe` on the port). Real absence looks like `usb_presence` passing while
   nothing answers the port, and either installer flavour restores it (see the host traps for which one
   signing tools expect). If `usb_presence` itself fails, fix the cable, the port or the *Trust This
   Computer* prompt before installing anything.
2. **On-device prerequisites** — unlock the phone, tap *Trust This Computer*, enable
   Settings → Privacy & Security → Developer Mode, and Settings → Developer → Enable UI Automation.
3. **Start WebDriverAgent on the phone** — this is the one step that cannot be done from this host, and
   on iOS 17+ (measured device: iOS 26.5.2) it is the whole remaining distance. The runner must be
   launched through a RemoteXPC tunnel because XCTest runners reach `testmanagerd` only that way:
   - **With a Mac (any, borrowed is fine)**: open the WebDriverAgent project in Xcode, select the device,
     Run. Once it reports "listening on port 8100" the phone side is done — this host needs nothing
     installed, because the adapter bridges that port over usbmux itself.
   - **Windows-only (verified on this host, iOS 26.5.2, no Administrator and no wintun.dll)**:
     1. `npm i -g go-ios` (verified with 1.3.2 — it sees the device through usbmuxd).
     2. `ios tunnel start --userspace` — the userspace tunnel needs neither `wintun.dll` nor elevation;
        it negotiates over the existing usbmux connection and exposes the full RSD service list
        (`ios rsd ls`). The README's `wintun.dll`/`sudo` advice applies to the kernel tunnel mode.
     3. Developer Mode must be ON: `ios devmode get`. With a passcode set, iOS refuses the remote
        enable and the toggle has to be flipped on the device (Settings → Privacy & Security →
        Developer Mode → on → restart → confirm). `ios devmode enable` still reveals the menu.
     4. `ios ui download wda` fetches an unsigned WebDriverAgentRunner (13.2.0 verified) and prints
        the `.app` path. Sign and install it with go-ios — note `--install` belongs to `sign app`, while
        `ui install` signs *and* installs in one step:
        - `ios ui install wda --p12file=<p12> --profile=<mobileprovision> [--p12password=…]`
        - `ios sign app --path=<app> --p12file=<p12> --profile=<mobileprovision> --install`
        - a paid Apple Developer account mints both assets without a Mac:
          `ios sign provision appstoreconnect --bundleid=com.facebook.WebDriverAgentRunner.xctrunner
          --asc-key-id=<keyid> --asc-issuer-id=<issuerid> --asc-private-key=<AuthKey_XXXX.p8>
          --p12-output=<p12> --profile-output=<mobileprovision>`
        - or sign it outside go-ios (Sideloadly/AltStore with a free Apple ID) and `ios install
          --path=<ipa>`. Two things break this step in practice: Sideloadly and AltStore both document the **web** (non-Microsoft-Store) iTunes
        *and* iCloud as prerequisites and tell you to uninstall the Store versions first, and any external
        signer must keep app extensions — the test bundle lives in
        `WebDriverAgentRunner-Runner.app/PlugIns/WebDriverAgentRunner.xctest`, so an install that strips
        extensions produces an app `runwda` cannot launch.
     5. `ios runwda --bundleid=com.facebook.WebDriverAgentRunner.xctrunner
        --testrunnerbundleid=com.facebook.WebDriverAgentRunner.xctrunner`, then confirm the port with
        `npm run probe:device -- --forward 8100`.

   When no runner
   is listening, usbmuxd answers the connection and then refuses the port, and the probe reports exactly
   that instead of a generic timeout.
4. **Run the hardware probe**:

   ```bash
   npm run probe:device                                            # sweep http://127.0.0.1:8100
   npm run probe:device -- --candidates http://192.168.1.24:8100   # or the device's own LAN address
   npm run probe:device -- --touch                                 # add the gesture layer
   ```

   Verdicts: `GO` (exit 0) — the whole path works; `NO_GO` (exit 1) — something answered but a required
   layer failed, and each failing layer is named with its typed code; `INCONCLUSIVE` (exit 2) — no
   transport was reachable at all, which means "not set up yet", never "hardware unusable". Evidence
   (JSON report + PNGs) lands in `scratch/spike-out/`.
5. **Point the app at the runner** — usually nothing to set. With no `ANTIFAN_WDA_URL`, no
   `ANTIFAN_WDA_CANDIDATES` and no explicit candidates, the adapter bridges the runner's device-side port
   over usbmux on its own (`ANTIFAN_WDA_DEVICE_PORT`, default 8100). Setting either variable — or passing
   candidates — deliberately turns that bridge **off** and makes the operator the owner of the transport;
   that is the case where a forwarded port, a LAN address or a tunnel URL is required. Then
   `device.status` reports the same gates the probe exercised.

A phone's `localhost` is its own loopback, not this workstation's, and nothing here assumes a reverse-USB
tunnel for localhost: the adapter bridges the runner's own port over usbmux, so a forwarder, a LAN
address or a tunnel URL is only needed once an explicit transport is configured.

### No-signing device surface (measured on this workstation, 2026-09-13)

go-ios reaches several device services through the RSD tunnel with **no signed app at all** — Developer
Mode plus the mounted developer image are enough. Verified live against the attached iPhone 13 / iOS
26.5.2:

| Command | Measured result |
| --- | --- |
| `ios screenshot --output=<file>` | a real PNG at native panel resolution — 1170x2532 (390x844 pt at scale 3, matching this `iPhone14,5`) — and provably complete: 253 chunks ending in `IEND`, and the concatenated IDAT streams inflate to exactly `height * (1 + width * 6) = 17777172` bytes, so no scanline is missing (a 16-bit RGB IHDR is why the stride is 6 bytes per pixel). The first attempt timed out with `TakeScreenshot: Timed out waiting for response` and the immediate retry succeeded, so treat that timeout as retryable. A locked or screen-off device can return a *valid* all-black frame, so confirm the pixels are not uniform before calling a capture evidence |
| `ios ps` | the device's real process list with system paths and start times |
| `ios info` | full lockdown identity (build `23F84`, baseband, Bluetooth address, boot session) |
| `ios rsd ls` | the full RSD service list |
| `ios webinspector list` | with Settings > Safari > Advanced > Web Inspector on, it lists the live page: `com.apple.mobilesafari` (pid 784), `automationAvailability: WIRAutomationAvailabilityAvailable`, `ready: true`, plus the real URL and title. Its error text is **not** authoritative: *"web inspector is not enabled on the device"* also appeared when the actual fault was a stale tunnel-info entry whose `rsdPort` no longer answered — re-check `ios rsd ls` (and restart the tunnel) before touching device settings |
| `ios webinspector js-shell` | **works, one expression per invocation**: `printf '<expr>\n' \| ios webinspector js-shell` evaluates against the live Safari page through the tunnel. Measured on a real page: `innerWidth/innerHeight` 390x699, `devicePixelRatio` 3, `documentElement.scrollHeight` 9144, 5580 elements, and **120 resource entries** from `performance.getEntriesByType('resource')` — real network timing with no signing and no CDP. A second expression in the same invocation answers `context deadline exceeded`, so run one expression per process |
| `ios webinspector cdp` | bridges CDP and answers real queries (`Runtime.evaluate` returned the same live viewport numbers, so two independent transports agree). Two traps: the `--port` flag is **ignored** in 1.3.2 (both `--port 9444` and `--port=9444` still bind 9222), and if anything else owns 9222 the bridge dies with `bind: Only one usage of each socket address` — this workstation's Chrome was listening there, so check `netstat -ano | findstr :9222` before blaming the device. WebKit's bridge implements no `Input` domain and no `Page.captureScreenshot`: a page-level screenshot is not available through it |
| `ios ax` | no response within 60 s, consistent with Settings > Developer > Enable UI Automation still being off (unconfirmed until that toggle is flipped) |

What this tier cannot do: **native input**. go-ios exposes no tap/swipe, so driving the UI still requires
a signed runner (`runwda` / `runtest` / `runxctest` / `ui`). The no-signing tier therefore yields
evidence and inspection — screenshots, process lists, logs, packet capture, web content — not device
control. Do not run bare `ios prepare` to widen it: it is the one command here that reconfigures the
device (supervision-style prep, certificate creation) on someone's personal phone, and nothing above
needs it. The harnesses used for these measurements are untracked local scratch tools
(`scratch/verify-png.cjs`, `scratch/cdp-probe.cjs`, `scratch/cdp-supported.cjs`).

### Known host traps (measured on this workstation)

- **Installing 3uTools (9.08.006, tested 2026-09-13) tears down the usbmuxd path that it also needs.**
  The elevated installer stopped Apple's user-mode stack: the `Apple Mobile Device USB Device` node
  disappeared from `Win32_PnPSignedDriver`, `AppleMobileDeviceProcess.exe` was gone and nothing listened
  on `tcp 27015`, so `ios list` failed with `actively refused`. Launching the Store iTunes again restored
  everything — AMDS process back on 27015, both Apple nodes bound to `oem44.inf` v538.0.0.0 exactly as
  before. After any 3uTools install or update, relaunch iTunes and re-check `ios list` before believing a
  device failure is the cable or the phone.
- **A free-Apple-ID signer that does not require iCloud.** 3u's own documentation for the IPA Signature
  feature says it accepts an ordinary Apple ID (7-day certificate) or an imported P12 (1 year), and needs
  only Apple's mobile device drivers — no iCloud login on the PC. That is what makes it worth testing
  here: Sideloadly and AltStore both document the web (non-Store) iTunes *and* iCloud as prerequisites,
  and this machine has neither.
- **Explorer shows the iPhone, yet no tool can reach it.** Windows' inbox MTP/WPD stack is what makes the
  phone appear in Explorer; the usbmux interface only gets a device node once Apple's driver package is
  installed (here `oem44.inf` binds the composite and the `Apple Mobile Device USB Device` node). Before
  that, no userspace binary — `iproxy`, `pymobiledevice3`, `idevice_id` — can reach the device even
  though the cable works. Swapping in a WinUSB driver is not a shortcut; it only creates a conflict with
  Apple's INF later.
- **Microsoft Store iTunes is what provides usbmuxd here.** `C:\Program Files\WindowsApps\AppleInc.iTunes_*\
  AMDS64\AppleMobileDeviceProcess.exe` answers on tcp 27015, while `C:\Program Files\Common Files\Apple`
  does not exist. Signing tools that document the classic non-Store iTunes as a prerequisite may not see
  the device in this configuration. (Inventory the Store flavour with `Get-AppxPackage` or the process
  owner — `C:\Program Files\WindowsApps` cannot be listed without elevation, so an empty listing there
  means nothing.) Swapping to the web installers is an upgrade rather than a workaround: they lay down
  the classic `AppleMobileDeviceService` plus `Common Files\Apple\Mobile Device Support` layout that
  go-ios, `iproxy` and the libimobiledevice guides assume, and the pairing record under
  `C:\ProgramData\Apple\Lockdown` is shared between flavours, so the device returns after a re-trust and
  a tunnel restart.
- **The machine had no Apple roots at all until 2026-09-13** (285 trusted roots, none issued by Apple),
  which made `gs.apple.com` fail TLS verification with `SELF_SIGNED_CERT_IN_CHAIN`. That endpoint is
  Apple's TSS, which `ios image auto` needs in order to mount the developer image, and the same class of
  failure affects any tool that signs through Apple's servers. Both of Apple's published roots —
  `CN=Apple Root CA` (`AppleIncRootCertificate.cer`, SHA-256 `B0:B1:73:0E:…:F0:24`, byte-identical to the
  anchor `gs.apple.com` serves, so this was a missing anchor and never an interception) and
  `CN=Apple Root CA - G3` (SHA-256 `63:34:3A:BF:…:91:79`) — were installed into the **CurrentUser** store
  on 2026-09-13 without Administrator rights, after which `gs.apple.com` verifies and `ios image auto`
  signs and mounts the developer image successfully. Do not re-diagnose this: if verification fails
  again, check the store first. Remove them with `certutil -user -delstore Root <thumbprint>`; reinstall
  from `https://www.apple.com/certificateauthority/` if the store is ever rebuilt.
- **A free-Apple-ID signature lasts roughly seven days.** Fine for one verification run; a durable setup
  needs a paid identity or a periodic re-sign, otherwise the runner silently stops launching and the
  failure looks like a broken adapter.

### Path to the deferred inspection milestone

The forwarding facts above do not depend on Appium, and neither does inspection: go-ios 1.3.2 ships
`webinspector list|cdp|eval|js-shell|launch`, which bridges Safari's Remote Automation to CDP over the
same tunnel. That is a concrete vendor path for the `webInspector` / `remoteAutomation` gates that
currently report `unknown`, and it is why those gates were left tri-state instead of hard-coded false.