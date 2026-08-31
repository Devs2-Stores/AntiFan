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

# Run full typecheck and test suite
npm run verify
```

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