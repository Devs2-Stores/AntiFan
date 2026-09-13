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

- **Attachment (USB)**: Apple Mobile Device Support must be installed and running, because
  enumeration goes through `usbmuxd`. On Windows that means the standalone (non-Microsoft-Store)
  iTunes installer or the Apple Devices app. Without it there is no USB path at all, and
  `device.status` reports a transport failure instead of claiming no device is attached.
- **WebDriverAgent runner**: the automation surface is WebDriverAgent over plain HTTP. No Appium
  server is involved in this path.
- **Reaching it**: either forward the device port to the host, or point the adapter at the device's
  own address:
  - `ANTIFAN_WDA_URL=http://<host>:8100`
  - `ANTIFAN_WDA_CANDIDATES=http://127.0.0.1:8100,http://<iphone-lan-ip>:8100`

  An iPhone's `localhost` is the phone's own loopback, not the workstation's, so a forwarded port or
  a network address is required. A reverse-USB tunnel for localhost is out of scope for this milestone.

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

### First-run runbook (Windows, real hardware)

1. **Confirm the USB stack** — `sc query AppleMobileDeviceService` must report `RUNNING`. `FAILED 1060`
   means Apple Mobile Device Support is missing: install the standalone (non-Microsoft-Store) iTunes for
   Windows or the Apple Devices app first. Without it there is no enumeration path, and the probe says so
   explicitly rather than blaming the phone.
2. **On-device prerequisites** — unlock the phone, tap *Trust This Computer*, enable
   Settings → Privacy & Security → Developer Mode, and Settings → Developer → Enable UI Automation.
3. **Start WebDriverAgent on the phone** (pre-signed runner). On iOS 17+/18+ over Windows this normally
   needs a RemoteXPC tunnel first: install go-ios (`npm i -g go-ios`), copy `wintun.dll` into
   `C:\Windows\system32`, and run `ios tunnel start` from an **Administrator** shell. Runner-launch
   commands change between iOS releases — follow the current go-ios / `appium-ios-remotexpc`
   documentation rather than a copied snippet.
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
5. **Point the app at the same transport** — set `ANTIFAN_WDA_URL` (or `ANTIFAN_WDA_CANDIDATES`) before
   launching, then `device.status` reports the same gates the probe exercised.

A phone's `localhost` is its own loopback, not this workstation's, and there is no reverse-USB tunnel
for localhost in this milestone: use a forwarded port, a LAN address, or a tunnel URL.