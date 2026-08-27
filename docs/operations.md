# Antigravity Browser Desktop — Operations

Install, update, logs, rollback, and process ownership for the opt-in desktop
companion. The current Extension browser remains the independent fallback at
every step.

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

# Run full typecheck and test suite
npm run verify
```

### MCP Capabilities for Coding Agents

Coding agents (Antigravity, Claude Code, Cursor) can invoke Theme QA tools over MCP stdio:

- `theme.qa_validate` / `antifan_theme_qa_validate`: Runs full inspection (Liquid errors, layout overflow, broken assets, HS rules) and generates a structured report artifact.
- `theme.debug_bundle` / `antifan_theme_debug_bundle`: Returns immediate diagnostic scan results without staging reports.

### PII Sanitization Guarantee

All generated Theme QA reports automatically redact customer emails, phone numbers, and bearer tokens before saving artifacts or transmitting responses.