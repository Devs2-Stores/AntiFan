---
phase: 10
title: "Settings Providers And Background Projects"
status: done
priority: P1
effort: "6d"
dependencies: [3, 5, 6, 7]
---

# Phase 10: Settings Providers And Background Projects

## Overview

Port settings and secondary utilities from legacy modals into coherent product
surfaces. Preserve active behavior and service implementations while enforcing
Project ownership, redacted credentials, keyboard access, and background-work
visibility.

## Existing Capability Migration Contract

- Existing: provider/auth/model settings, connection tests, plugin manager,
  logs, JSON/image/artifact viewers, changelog, license, update, mobile remote,
  shortcuts, and preference storage.
- Reuse: Main provider/auth/settings/plugin/mobile services, validation,
  formatting reducers, and verified modal behavior where safe.
- Required delta: dedicated route/panel, redacted DTOs, preference scope,
  Project-bound mobile/background state, and consistent component styling.
- Legacy removal condition: feature-by-feature settings parity and credential/
  Project-binding security tests pass.

## Requirements

- Settings opens as a dedicated route/panel with searchable categories and a
  persistent close/back path to Chromium.
- Provider profiles support Antigravity, Codex, Anthropic, Gemini, OpenAI-
  compatible, DeepSeek as a normal provider, and custom models through Main APIs.
- Renderer receives redacted auth/connection state only; secrets never roundtrip.
- General settings cover appearance density, default dock placement, shortcuts,
  browser behavior, artifact retention display, diagnostics, and update status.
- Plugin manager shows real manifests, permissions, enable state, and hooks; no
  fabricated catalog entries.
- Preserve app logs, JSON/artifact viewer, changelog, license, image info, update
  check, and mobile remote with consistent component styling.
- Mobile remote must bind an authenticated session to one explicit ProjectRuntime
  or remain disabled with an explanatory state.
- Background Projects surface live run/PTY/process blockers, resource state, and
  focus/stop actions without a global active-Project concept.
- Destructive Project/profile actions remain separate and explicit.

## Architecture

Settings uses app-level operations for global preferences/providers/catalog and
Project operations for Project-scoped preferences/resources. The renderer never
stores API keys. Provider edit submits new secret material once to Main/vault and
receives a redacted profile summary.

Secondary viewers share one dialog/sheet framework. Background Project state is
fed by `ProjectWindowCoordinator` lifecycle summaries, not polling global hosts.

## User Flows And States

- Configure/test/save provider profile; login/logout Codex/Antigravity.
- Add/remove custom model and choose Project/chat default profile.
- Inspect plugin permissions and enable/disable plugin.
- View/copy redacted logs, JSON, artifact/image info, changelog, license, update.
- Start mobile remote for one Project, copy/open URL, stop/restart safely.
- Inspect background Project with active run/terminal/process; focus or stop.
- Request Project record deletion separately from Chromium profile deletion.

## File Inventory

| Action | Absolute path | Purpose | Test impact |
|---|---|---|---|
| Modify | `E:/Work/apps/antigravity-browser-desktop/src/main/settings/settings-store.ts` | Versioned UI/global/Project preference ownership | Unit |
| Modify | `E:/Work/apps/antigravity-browser-desktop/src/main/harness/provider-gateway.ts` | UI-safe provider profile/test summaries | Provider tests |
| Modify | `E:/Work/apps/antigravity-browser-desktop/src/main/providers/types.ts` | Redacted provider/model DTOs; no DSH terminology | Unit/static |
| Modify | `E:/Work/apps/antigravity-browser-desktop/src/main/auth/codex-auth-service.ts` | Redacted Codex status/actions | Auth tests |
| Modify | `E:/Work/apps/antigravity-browser-desktop/src/main/auth/antigravity-auth-service.ts` | Redacted auth/API-key status/actions | Auth tests |
| Modify | `E:/Work/apps/antigravity-browser-desktop/src/main/plugins/plugin-registry.ts` | UI-safe manifest/permission summaries | Plugin tests |
| Modify | `E:/Work/apps/antigravity-browser-desktop/src/main/mobile-remote-server.ts` | Explicit authorized Project binding or disabled state | Security/E2E |
| Modify | `E:/Work/apps/antigravity-browser-desktop/src/main/project-window-coordinator.ts` | Background Project summaries and focus/stop | Lifecycle tests |
| Modify | `E:/Work/apps/antigravity-browser-desktop/src/preload/app-preload.ts` | Typed global settings/provider/diagnostic operations | Static parity |
| Modify | `E:/Work/apps/antigravity-browser-desktop/src/preload/project-preload.ts` | Project preference/mobile/background operations | Static parity |
| Create | `E:/Work/apps/antigravity-browser-desktop/src/renderer/project-app/settings/settings-screen.tsx` | Searchable settings route | Renderer/E2E |
| Create | `E:/Work/apps/antigravity-browser-desktop/src/renderer/project-app/settings/provider-settings.tsx` | Provider/auth/model profiles | Renderer/E2E |
| Create | `E:/Work/apps/antigravity-browser-desktop/src/renderer/project-app/settings/plugin-settings.tsx` | Plugin permissions/state | Renderer |
| Create | `E:/Work/apps/antigravity-browser-desktop/src/renderer/project-app/settings/background-projects.tsx` | Background lifecycle/resources | Renderer/E2E |
| Create | `E:/Work/apps/antigravity-browser-desktop/src/renderer/project-app/settings/diagnostics-viewers.tsx` | Logs/JSON/artifact/image/changelog/license/update | Renderer |
| Create | `E:/Work/apps/antigravity-browser-desktop/src/renderer/project-app/settings/mobile-remote-settings.tsx` | Project-bound remote lifecycle | Renderer/E2E |
| Modify | `E:/Work/apps/antigravity-browser-desktop/src/renderer/components/plugin-manager.ts` | Reuse/move pure reducer and permission formatting | Unit |
| Modify | `E:/Work/apps/antigravity-browser-desktop/test/main/settings-store.test.ts` | Preference scope/migration/redaction | Unit |
| Modify | `E:/Work/apps/antigravity-browser-desktop/test/plugins/plugin-system.test.ts` | Settings parity/permission display contract | Unit |
| Modify | `E:/Work/apps/antigravity-browser-desktop/test/main/mobile-remote-server.test.ts` | Explicit Project binding/security | Unit |
| Create | `E:/Work/apps/antigravity-browser-desktop/test/e2e/settings-and-background-projects.cjs` | End-to-end settings/background flows | Electron E2E |

## Implementation Steps

1. Inventory current settings/modal features against Phase 1 parity ledger.
2. Define global vs Project preference contracts and migrate only validated values.
3. Build redacted provider/auth/model profile operations and connection tests.
4. Build settings route, category navigation, forms, validation, save/reset, and
   keyboard/focus behavior.
5. Port plugin manager and diagnostics/viewer utilities to shared components.
6. Implement Project-bound mobile remote or a fail-closed disabled state.
7. Implement background Project resource/status list and focus/stop actions.
8. Test credential redaction, provider failures, preference migration, plugin
   permissions, background resources, mobile binding, and destructive confirmations.

## Function And Interface Checklist

- [ ] `ProviderProfileSummary` contains no API key/token/credential material.
- [ ] `saveProviderSecret()` sends new secret once and returns redacted state.
- [ ] `PreferenceScope` distinguishes app and Project preferences.
- [ ] `BackgroundProjectSummary` reports blockers and actions without global focus.
- [ ] `MobileRemoteSession` binds exact Project and authorized session identity.
- [ ] Viewer components sanitize/cap content before rendering or copying.

## Test Scenario Matrix

| Priority | Scenario | Expected result |
|---|---|---|
| Critical | Renderer snapshot/log contains provider secret | Security test fails |
| Critical | Mobile client omits or changes Project ID | Rejected; no browser control |
| High | Provider test fails/auth expires | Redacted actionable state; chat selection remains safe |
| High | Background Project has run + PTY | Blockers shown; no suspend/stop without explicit action |
| High | Old preference schema corrupt | Safe defaults plus migration warning; no crash |
| Medium | Keyboard-only settings navigation | All controls reachable; focus returns to browser |

## Dependency Map

`Project lifecycle + Harness/provider state -> scoped settings contracts -> settings/background UI -> parity/security E2E`

## Success Criteria

- [ ] Settings and provider flows are coherent, searchable, and no longer modal sprawl.
- [ ] Credentials remain Main/vault-owned and renderer/logs expose redacted status only.
- [ ] Plugins, viewers, update/changelog/license, and image info retain parity.
- [ ] Background Project resources are visible and explicitly controllable.
- [ ] Mobile remote is exact-Project authorized or safely disabled.

## Risk Assessment

Provider/auth code may still expose legacy raw-key roundtrips. If redacted DTOs
cannot replace them without breaking login, build the Main migration first and
keep the new settings route unavailable. Do not preserve unsafe behavior for UI
parity. Mobile remote is a privileged cross-device boundary; disable it rather
than allow implicit current-Project routing.
