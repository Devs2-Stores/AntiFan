# Phone Adapter (Tier-2 real-device surface) — Delivery Report

Date: 2026-09-13 · Repo: `E:/Work/apps/AntiFan` · Status: **code-complete and contract-verified**;
live device path **hardware-unverified / BLOCKED** on a host prerequisite.

## Outcome

A physically attached iPhone is now a **peer execution adapter** under the control plane, beside the
browser port — never a mobile pane of it. Ten `device.*` capabilities expose enumeration, tri-state
readiness, Safari session establishment, deep-link navigation, real-device screenshots, native input and
honest waits. Evidence lands in the same `ArtifactStore`, so a Tier-2 device receipt is directly
comparable with the Chromium capture that preceded it.

## What shipped

| File | Role |
| --- | --- |
| `src/shared/device-control-contracts.ts` | Device contracts: `DeviceBinding`, `DeviceTarget` (with `viewportSource`), tri-state gates, two readiness milestones, error codes + remediation. |
| `src/main/device/device-control-port.ts` | Frozen port: 10 methods, `DeviceRegistryPort` (discovery seam + `select`), artifact sink contract with `maxBytes`/`overflowMode`. Operations take a `DeviceBinding` (identity + session), never geometry. |
| `src/main/device/usbmux-client.ts` | Dependency-free usbmuxd client (hand-rolled plist XML + 16-byte LE framing). |
| `src/main/device/device-manager.ts` | Attachment lifetime: epoch bumping that never recycles, removal handling, live-binding resolution, session recording. |
| `src/main/device/wda-rest-client.ts` | WebDriverAgent REST client: candidate probing, `/status`, `/wda/screen`, session creation across payload variants, failure description. |
| `src/main/device/ios-session-manager.ts` | Automation-session lifetime: monotonic `sessionGeneration`, reuse, `markLost`, release. |
| `src/main/device/device-readiness.ts` | Tri-state gate derivation and the automation/inspection milestone split. |
| `src/main/device/ios-device-adapter.ts` | Composition + per-device serialization + fail-closed evidence staging. |
| `src/main/tools/device-capabilities.ts` | The 10-capability family and its policy factory. |
| `src/main/tools/capability-catalogue.ts` | `requiresDeviceTarget` normalization + mirror check, relaxed viewport-gate invariant, device authorization that distinguishes "no device surface registered" from "no device attached/selected". |
| `src/shared/control-plane-contracts.ts` | Device error codes, `requiresDeviceTarget`, `deviceTarget`/`deviceOperation` context, `assertExactDeviceTarget` (ownership, device identity, attachment epoch, session generation). |
| `src/main/control-plane/control-plane-runtime.ts` · `src/main/index.ts` | `registerDevice` / `getDevicePort`, lazy live-binding resolver, adapter registration beside `registerBrowser`. |
| `scripts/antifan-omp-mcp.cjs` | Advertises the 10 device tools under their catalogue names (no routing rows needed). |
| `scripts/smoke-device-surface.mjs` | Permanent fixture-backed contract smoke (no phone required). |
| `scripts/probe-iphone-hardware.mjs` | Hardware GO/NO-GO probe (Phase 0 gate) with typed per-layer verdicts. |
| `scripts/check-mcp-budget-dominance.mjs` | Also registers the device family so the ceiling check covers it. |
| `test/unit/device-target-authority.test.ts` | Target staleness (epoch, generation, foreign device), dispatch-time refusal, session-less capability legality, readiness milestone derivation. |
| `docs/operations.md` | Operator section: prerequisites, tool table, honest semantics, failure codes, Windows first-run runbook. |

## Hardening found by verification (not in the first cut)

1. **Two-phone identity hole** — `assertExactDeviceTarget` compared ownership and epochs but not
   `deviceId`, and epochs are per-device, so a target for a second attached iPhone passed. Device
   identity is now a required part of the expectation and is checked.
2. **Decorative concurrency policy** — `schedulerLane` / `duplicateMode` are validated and hashed but
   nothing in the dispatcher enforces mutual exclusion (the browser side gets its real exclusion from
   `ViewportGate.withLock`). Since WebDriverAgent **kills the previous session when a new one is
   created**, two concurrent `device.open_safari` calls would leave the first caller driving a dead
   session. The adapter now serializes per device, and it locks the **leaves** (`sendToSession`,
   `screenshot`, `type`, `wait`) plus session establishment — never a public method that then calls a
   locked leaf, which would make the chain await itself and hang. Session establishment resolves the
   concrete device *before* taking the lock, so an auto-targeted call and an explicitly targeted one
   share one chain instead of racing. Phase [8] of the smoke proves this from a session-less state:
   two simultaneous establishments produce exactly one `POST /session` and a shared generation, and
   concurrent / mixed operations complete rather than deadlocking.
3. **Silently truncated evidence** — the artifact store defaults to `overflowMode: 'truncate'`, which
   for a screenshot means storing a corrupt PNG that still claims `image/png`. Device staging now passes
   `overflowMode: 'reject'` with an explicit 32 MiB ceiling.
4. **Fail-open risk removed** — an unwired `getDeviceBinding` now fails loudly (`CAPABILITY_NOT_FOUND`
   "no device surface registered") instead of the checks silently vanishing; a wired-but-empty registry
   reports `DEVICE_NOT_CONNECTED` with the USB remediation.
5. **Diagnostics must work with nothing attached** — `device.list` / `device.status` / `device.open_safari`
   are device-optional so a host with no phone gets the adapter's accurate `DEVICE_NOT_CONNECTED`
   ("install Apple Mobile Device Support") rather than a target complaint. Target-bound operations still
   fail closed, and a supplied target is always validated against the live binding.
6. **Runtime lease vs evidence lease** — the first cut forwarded the *runtime* lease token to artifact
   staging, which the store correctly rejects as an expired evidence lease. Device staging now mirrors
   `browser.screenshot` (unleased unless the caller explicitly acquired an evidence lease).

## Verification (evidence)

1. `npm run compile` — clean, including emit integrity and the MCP budget-dominance check over all 176
   capabilities.
2. `npm run test:fast` — **770 passed, 0 failed**.
3. `npm run test:main` — 1111 tests, 1102 passed, **8 failed, all pre-existing — measured, not inferred**.
   The whole uncommitted diff (all 21 paths) was snapshotted aside, the tree restored to `HEAD`,
   recompiled, and the lane re-run: **identical totals (1111 / 1102 / 8) and the same failing tests
   name-for-name** (normalized `✖` entries: 11 on both sides, empty symmetric difference) — the
   Chromium↔Terminal tab matrix (flows 08, 10, 22, 23, 24, 30, 31) and the happy-path theme-repair case
   `theme-qa-workflow-differential-and-rollback.test.ts:301`, failing on the `assert.strictEqual` pair at
   :335–336 (the clean-fix verification path, not the rollback path). The working tree was then restored
   from the backup and recompiled clean; the restore was verified by content (`git diff` worktree-vs-index
   empty, 21 changed paths vs `HEAD`, device symbols present in every restored file).
   A single-file swap would not have covered `control-plane-contracts.ts`, which those suites import;
   the full-diff baseline does. No assertion in those suites was touched or relaxed.
4. `npm run smoke:device` — **0 failed** on both host states: 34 passed with no device attached and 31
   passed with a device attached. The difference is phase [7], which branches on live discovery (a
   device-less host takes the typed-absence branch, an attached device takes the readiness branch); no
   check is skipped silently. It drives the real control plane → policy
   freeze → device authorization → real adapter → real HTTP against a WebDriverAgent-contract fixture,
   and additionally exercises the **live discovery path** (no injected enumerator) so the absent-USB-stack
   host reports a typed `DEVICE_TRANSPORT_UNREACHABLE` with the fix attached, `device.status` reports a
   failed attachment gate with remediation and no fabricated identity, and a target-bound operation
   reports `DEVICE_NOT_CONNECTED`. Phase [8] adds the concurrency contract on a fresh runtime:
   simultaneous session establishments → exactly one `POST /session` and a shared generation; two
   concurrent `tap`s and a mixed `screenshot`/`wait` pair all complete on the serialized chain.
5. `npm run probe:device` — hardware gate, currently `INCONCLUSIVE` (exit 2) on this host: every host-side
   layer passes and the single failure is the runner port, where usbmuxd relays the connection and the
   device refuses it because no WebDriverAgent is listening. `INCONCLUSIVE` means "not set up yet", never
   "hardware unusable".

### Evidence labelling (important)

The fixture smoke is not Phase 0 device evidence and its `GO` verdict must never be cited as the hardware
gate result. The distinction is now narrower than "contract vs hardware": the host-side transport layers
and the adapter's own client are **hardware-verified** (see the section below), while **no real
WebDriverAgent session has ever been established** — session creation, navigation, screenshots, input and
waits remain unproven against a physical device until a runner is listening. No claim of a working
real-device session is made.

## Hardware-verified on the attached iPhone (2026-09-13)

Apple Mobile Device Support was installed and the phone unlocked, which moved the device path from
"no transport" to "every host-side layer proven against real hardware":

| Layer | Evidence |
| --- | --- |
| USB enumeration | `usb_presence` pass — `Apple Mobile Device USB Composite Device`, `Apple Mobile Device USB Device`, `Apple Mobile Device Ethernet`, WPD `Apple iPhone`, serial `0000811000013942210A401E` |
| usbmuxd | `host_service` pass — `tcp 127.0.0.1:27015` accepting; the adapter's own client enumerates `00008110-00013942210A401E` (`connection: usb`) |
| Port bridging | `connectDevicePort` took the **`same-socket` handover** branch (Apple's Windows usbmuxd does not return a `Port`), and the in-process forwarder carried a real lockdownd exchange: a plain TCP client with no usbmux knowledge read `ProductVersion` through `127.0.0.1:<bridge>` |
| Device facts | `device_lockdown` pass — `Admin's iPhone`, `iPhone14,5`, iOS `26.5.2` (`23F84`), pairing record present at `C:\ProgramData\Apple\Lockdown\00008110-00013942210A401E.plist` |
| Pairing | trusted — privileged keys answer `GetProhibited` (needs a paired `StartSession`), not `PairingRequired` |
| Adapter transport fallback | with no candidate answering, the adapter bridged device port 8100 over usbmux itself — **no `iproxy`/`go-ios` involved** |
| Runner gate | **device-measured**: usbmuxd answered the Connect to port 8100 and the device refused it, surfaced as typed `DEVICE_WDA_NOT_READY` ("The WebDriverAgent runner is not answering") — i.e. no runner is running, which is now the only remaining gap |
| Developer Mode | `ios devmode get` → `DeveloperModeEnabled: true`, after the device-side toggle and restart that iOS requires when a passcode is set |
| iOS 17+ tunnel | `ios tunnel start --userspace` → `{"userspaceTun":true,"rsdPort":54932}` and `ios rsd ls` lists the full RSD service set — **no `wintun.dll`, no Administrator** |
| Developer image | `ios image auto` → "requesting new signature from Apple TSS" → "success mounting image"; `ios image list` reports the image signature. Needed installing Apple's root CAs first (see host traps) |
| Installed apps | `ios apps` lists 81 applications and **no WebDriverAgent**: the runner genuinely has to be signed and installed |

`npm run smoke:device` reports 31 passed / 0 failed with a device attached (the live-discovery phase takes
its "device present" branch instead of its absence branch).

## Remaining gap: a running WebDriverAgent runner

Apple Mobile Device Support is installed and working, so the earlier host prerequisite is closed. What is
left is a runner on the phone, and it is measured rather than assumed: usbmuxd **answers** a Connect to
device port 8100 and the device then refuses it, which the adapter surfaces as typed
`DEVICE_WDA_NOT_READY` ("The WebDriverAgent runner is not answering. Launch it on the device and confirm
its provisioning profile is trusted.").

On iOS 17+ an XCTest runner reaches `testmanagerd` only through a RemoteXPC tunnel, so launching it is the
one step that cannot be performed from this host:

- **A Mac (any, borrowed is fine)** — open WebDriverAgent in Xcode, select the device, Run. Nothing needs
  installing here: the adapter bridges port 8100 over usbmux on its own.
- **Windows-only (verified on this host, no Administrator and no `wintun.dll`)** — go-ios 1.3.2 sees the
  device, and `ios tunnel start --userspace` negotiates over usbmux and exposes the full RSD service list,
  so the kernel-tunnel `wintun.dll` advice does not apply. `ios ui download wda` fetched an unsigned
  WebDriverAgentRunner 13.2.0. The two remaining inputs are on the device side: Developer Mode is
  `false` and, with a passcode set, iOS refuses a remote enable, so the toggle must be flipped in
  Settings (the menu is already revealed); and the runner needs signing assets (a P12 + mobileprovision,
  an App Store Connect key for `sign provision appstoreconnect`, or an external signer such as
  Sideloadly/AltStore). After that: `ios runwda --bundleid=com.facebook.WebDriverAgentRunner.xctrunner`
  and `npm run probe:device -- --forward 8100`.

Either way the host side needs no further work: `npm run probe:device -- --forward 8100` confirms the port,
and the adapter's own fallback bridges it without `iproxy` or `go-ios forward`. The step-by-step runbook is
in `docs/operations.md` ("First-run runbook").

## Honest scope boundaries

- No DOM/CSS/console/network inspection: that needs Safari's Web Inspector + Remote Automation and stays
  behind `webInspector` / `remoteAutomation` gates that report `unknown`. No capability is advertised that
  the transport cannot serve.
- `navigate` is a deep-link open (no load wait, no URL readback); `wait` returns a labelled rendering
  heuristic. `reload` re-opens the remembered URL and refuses with `DEVICE_OPERATION_UNSUPPORTED` when
  none is known.
- The viewport in `device.status` is `panel-derived`; Safari's live layout viewport requires the
  inspection milestone.
- Two-phone hosts resolve through explicit selection (`device.status`/`device.open_safari` select the
  device they name); with several devices attached and none named there is deliberately no guess.

## Running the surface

```bash
npm run smoke:device     # fixture-backed contract smoke, no phone needed
npm run probe:device     # hardware GO/NO-GO against the real iPhone (Phase 0 gate)
# Electron main-process reload is required for the live app to register device.*
```
