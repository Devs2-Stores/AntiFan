# Task 6.4 — Admin Save → Storefront Roundtrip: evidence record

Status: **PARTIAL — live-save leg environment-blocked** (evidence below is a direct HTTPS fetch — Tier-2, no AntiFan authority; NOT AntiFan-verified)
Date: 2026-10-05 · Plan: `261005-1631-haravan-settings-enforcement`

## Capability surface

- AntiFan MCP (`xd://mcp__antifan_browser_*`) is **not mounted** in this session
  (P1 already found the bridge tools absent; P6Executor confirmed in its own
  session). §3.1 fallback authorized for browser evidence only.
- Fallback reason: `CAPABILITY_NOT_FOUND` — the AntiFan browser tool surface
  is not registered with this OMP session. `anti.telemetry.record_fallback`
  is itself unreachable (same surface), so per §3.1 the reason is recorded
  verbatim here instead. (No Playwright-derived evidence was produced; all
  live evidence is plain HTTPS GET of the public storefront — Tier-2,
  unauthenticated, read-only.)

## What was verified (read-only, real storefront)

Target: Vyantechnology, `org_id 200000878093`, `theme_id 1001509080`
(workspace `E:/Work/customizes/Vyantechnology`).

1. `https://vyantechnology.myharavan.com` 301 → `https://vyan.com.vn/`
   (public domain live).
2. Live DOM contains:
   `Haravan.theme = {"name":"Vỹ An - Theme chính","id":1001509080,"role":"main"}`
   → the workspace theme IS the published main theme.
3. Rendered-setting fingerprint check:
   - `THÔNG TIN LIÊN HỆ`, `contact@vyan.com.vn`, `8h00 - 17h00` → FOUND
   - `coppyright`/`store_address` literals → live DOM renders `VYANTECHOLOGY`
     and the current office address, where the local snapshot holds
     `VỸ AN TECHOLOGY` / older values → settings DO flow into the DOM; the
     local `settings_data.json` is a stale pull (expected, not a defect).
4. Dead-key check: `footer_contact_address`, `footer_contact_phone`,
   `dia-chi` are present in `settings_data.json` but referenced by no
   snippet/layout/template — unused settings, correctly absent from DOM.

## What could NOT be executed

- The Admin-save leg: no Haravan admin session available through Playwright
  MCP, and the AntiFan tab surface (which owns the admin session cookie
  context and `write_cas` attachment) is unmounted. `theme.transaction.write_cas`
  itself is a unit-tested capability (P1 isolation tests pass), but the live
  end-to-end save→reload→DOM-diff requires the AntiFan app session.
- TestVyan theme (`1001510621`) has no public storefront
  (`testvyan.myharavan.com` → 404); it is a draft/test theme only.

## Remaining risk

The save→render path is verified by composition (write_cas tested +
DOM-embeds-settings proven) but not by a live mutation. Recommend running
the roundtrip once inside AntiFan Desktop where `xd://mcp__antifan_*` is
mounted: record revision → write_cas a visible string setting →
`anti.browser.reload` → `anti.inspect.dom` on the rendered node.
