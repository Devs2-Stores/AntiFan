# AntiFan MCP Capability Map (Audit §2, Mandate v2.0)

Total Registered Tools: **129**

## BROWSER (16 tools)

| Tool Name | Purpose | When to Use |
|-----------|---------|-------------|
| `anti.browser.tabs.list` | List tabs in the live AntiFan Desktop Browser GUI (every tab in the window by default; pass all: false to list only the  | Mandatory AntiFan MCP path |
| `anti.browser.tabs.create` | Open a new tab in live AntiFan Desktop Browser GUI without stealing focus by default. | Mandatory AntiFan MCP path |
| `anti.browser.tabs.activate` | Switch the active tab visible to the user in live AntiFan Desktop Browser GUI by tabId. | Mandatory AntiFan MCP path |
| `anti.browser.tabs.close` | Close a tab in live AntiFan Desktop Browser GUI by tabId. | Mandatory AntiFan MCP path |
| `anti.browser.rebind_target` | Rebind this session attachment to a live tabId after the bound tab detached or died. Use tabs.list to find a live tab, t | Mandatory AntiFan MCP path |
| `anti.browser.set_automation_target` | Set the primary automation target tab for this session (authority rotation via CAS). | Mandatory AntiFan MCP path |
| `anti.browser.navigate` | Navigate active or background tab in live AntiFan Desktop Browser GUI. | Mandatory AntiFan MCP path |
| `anti.browser.reload` | Reload active or background tab in live AntiFan Desktop Browser GUI. | Mandatory AntiFan MCP path |
| `anti.browser.set_viewport` | Set the bound tab viewport dimensions and device emulation, verified against the size the tab actually measures. | Mandatory AntiFan MCP path |
| `anti.browser.get_viewport` | Get the bound tab viewport dimensions, DPR, device preset, and layout surface state without applying overrides. | Mandatory AntiFan MCP path |
| `anti.browser.evaluate` | Execute JavaScript expression in page context with depth-capped circular protection. Refuses a tab with no laid-out surf | Mandatory AntiFan MCP path |
| `anti.browser.evaluate_frame` | Execute JavaScript inside a child frame selected by frameUrl substring. | Mandatory AntiFan MCP path |
| `browser.set-viewport` | Set the bound Chromium tab viewport dimensions and device emulation. | Mandatory AntiFan MCP path |
| `browser.get-viewport` | Get the bound Chromium tab viewport dimensions, DPR, device preset, and layout surface state without applying overrides. | Mandatory AntiFan MCP path |
| `browser.wait` | Deterministic wait for selector, url, navigation, dom-stable, network, actionability, generation, or legacy condition st | Mandatory AntiFan MCP path |
| `anti.browser.dump_dom` | Stream clean or raw page DOM directly to a workspace file with zero MCP transport truncation and Windows-safe atomic wri | Mandatory AntiFan MCP path |

## INSPECT (8 tools)

| Tool Name | Purpose | When to Use |
|-----------|---------|-------------|
| `anti.inspect.dom` | Read DOM elements and computed attributes from AntiFan Desktop tab (supports desktop and mobile split panes). Operates d | Mandatory AntiFan MCP path |
| `anti.inspect.snapshot` | Capture an accessible semantic snapshot of elements indexed with monotonic @e1..@eN references (supports selector and vi | Mandatory AntiFan MCP path |
| `anti.inspect.styles` | Inspect computed CSS styles, box model, typography, layout, and CSS variables for an element (supports @ref or CSS selec | Mandatory AntiFan MCP path |
| `anti.inspect.region` | Inspect spatial region bounds, collecting intersecting visible DOM elements with coordinates and z-index. | Mandatory AntiFan MCP path |
| `anti.inspect.page_inventory` | Scan entire physical page structure from y=0 to scrollHeight, returning list of all sections, coordinates, heights, and  | Mandatory AntiFan MCP path |
| `anti.inspect.style_diff` | Compare computed CSS styles and box-model metrics between elements on two tabs (or two selectors). | Mandatory AntiFan MCP path |
| `anti.inspect.matched_styles` | Inspect live CDP matched CSS and classify active versus overridden declarations. | Mandatory AntiFan MCP path |
| `anti.inspect.responsive_matrix` | Probe document and target overflow at the five standard responsive widths. | Mandatory AntiFan MCP path |

## CAPTURE (4 tools)

| Tool Name | Purpose | When to Use |
|-----------|---------|-------------|
| `anti.screenshot.viewport` | Capture high-fidelity viewport screenshot from live AntiFan Desktop GUI (supports desktop and mobile split panes, format | Mandatory AntiFan MCP path |
| `anti.screenshot.full_page` | Capture canonical PNG full-page evidence (entire document scroll height) and stage it under the evidence lease. | Mandatory AntiFan MCP path |
| `anti.reference.capture` | Capture a reference from a live page: materialize lazily-mounted content, settle, then stage the settled DOM (and option | Mandatory AntiFan MCP path |
| `anti.visual.compare` | Compare current viewport or tab against baseline screenshot with pixel-level diffing, element selection, dynamic masking | Mandatory AntiFan MCP path |

## THEME (9 tools)

| Tool Name | Purpose | When to Use |
|-----------|---------|-------------|
| `theme.qa_validate` | Run the authoritative Theme QA verification workflow for the bound storefront tab and workspace. | Mandatory AntiFan MCP path |
| `theme.debug_bundle` | Return an atomic storefront diagnostic bundle with platform, Liquid, overflow, and HS findings. | Mandatory AntiFan MCP path |
| `theme.assert_cart` | Inspect passive storefront cart contract telemetry without adding synthetic items. | Mandatory AntiFan MCP path |
| `theme.resolve_product` | Auto-resolve complete storefront product variant matrix, pricing, SKU, and availability. | Mandatory AntiFan MCP path |
| `storefront.resolve_product` | Auto-resolve complete storefront product variant matrix, pricing, SKU, and availability. | Mandatory AntiFan MCP path |
| `anti.theme.style_override` | In-memory ephemeral CSS stylesheet override for safe theme testing without writing files to disk (bypasses CLI watchers) | Mandatory AntiFan MCP path |
| `theme.style_override` | In-memory ephemeral CSS stylesheet override for safe theme testing without writing files to disk (bypasses CLI watchers) | Mandatory AntiFan MCP path |
| `anti.theme.resolve_element` | Map a live DOM element to bounded, correlated local theme source candidates. | Mandatory AntiFan MCP path |
| `anti.theme.export_clean` | Materialize, sanitize (Livewire/SSR blobs and unhydrated modals stripped), and export clean static theme HTML directly t | Mandatory AntiFan MCP path |

## VERIFICATION (4 tools)

| Tool Name | Purpose | When to Use |
|-----------|---------|-------------|
| `anti.spec.validate_gate` | Validate HTML Specification against target page to certify HTML_SPEC_READY status before theme compilation. | Mandatory AntiFan MCP path |
| `anti.verification.record_claim` | Record a live verification claim as UNVERIFIED with explicit proof obligations. | Mandatory AntiFan MCP path |
| `anti.verification.verify_claim` | Evaluate a recorded claim against fresh live browser evidence and persist an authoritative receipt. | Mandatory AntiFan MCP path |
| `anti.verification.list` | List recorded verification claims and their current verdicts. | Mandatory AntiFan MCP path |

## AGENT_CURSOR (11 tools)

| Tool Name | Purpose | When to Use |
|-----------|---------|-------------|
| `anti.agent.cursor.click` | Move visual Agent Cursor and click an element in live AntiFan Desktop tab without stealing visual focus. | Mandatory AntiFan MCP path |
| `anti.agent.cursor.move` | Move visible Agent Cursor without clicking in live AntiFan Desktop tab. | Mandatory AntiFan MCP path |
| `anti.agent.cursor.type` | Move visual Agent Cursor and type into an input element in live AntiFan Desktop tab without stealing visual focus. | Mandatory AntiFan MCP path |
| `anti.agent.cursor.scroll` | Scroll active or background tab using visual Agent Cursor in live AntiFan Desktop tab. | Mandatory AntiFan MCP path |
| `anti.agent.cursor.hover` | Move visual Agent Cursor to hover over an element in live AntiFan Desktop tab. | Mandatory AntiFan MCP path |
| `anti.agent.cursor.highlight` | Highlight a DOM element with visual Agent Cursor overlay in live AntiFan Desktop tab. | Mandatory AntiFan MCP path |
| `anti.agent.cursor.clear` | Clear all active Agent Cursor overlays in live AntiFan Desktop tab. | Mandatory AntiFan MCP path |
| `anti.agent.file_upload` | Upload local files into a file input element in live AntiFan Desktop tab without native file dialogs. | Mandatory AntiFan MCP path |
| `anti.agent.drop` | Dispatch native drag and drop file transfer onto a target drop zone element in live AntiFan Desktop tab. | Mandatory AntiFan MCP path |
| `anti.agent.drag` | Drag a control (price slider, range handle, drag-to-reorder row) from one element/coordinate to another with a bounded i | Mandatory AntiFan MCP path |
| `anti.agent.sequence` | Execute an atomic multi-step action sequence (navigate, click, type, scroll, hover, pressKey, wait, screenshot, snapshot | Mandatory AntiFan MCP path |

## ARTIFACT (4 tools)

| Tool Name | Purpose | When to Use |
|-----------|---------|-------------|
| `anti.artifact.read` | Read an authorized artifact by ID with bounded chunk size (clamped to max 32KB per frame). | Mandatory AntiFan MCP path |
| `anti.artifact.stat` | Retrieve metadata and size information for an authorized artifact. | Mandatory AntiFan MCP path |
| `file.read` | Read a file relative to the authoritative workspace root. | Mandatory AntiFan MCP path |
| `file.write` | Write a file relative to the authoritative workspace root with boundary enforcement. | Mandatory AntiFan MCP path |

## OTHER (73 tools)

| Tool Name | Purpose | When to Use |
|-----------|---------|-------------|
| `browser_find` | Search the accessibility snapshot of the current page for text, pattern, query, or a regular expression. | Mandatory AntiFan MCP path |
| `browser_press_key` | Send native keyboard key press (Enter, Escape, Tab, Backspace, Arrow keys, etc.) or combination (Control+a) to the activ | Mandatory AntiFan MCP path |
| `device.list` | List iOS devices attached to this host (live enumeration over the USB multiplexer). Tier-2 surface: the real phone, not  | Mandatory AntiFan MCP path |
| `device.status` | Read physical device readiness gates (attachment, trust, Developer Mode, UI Automation, WebDriverAgent) plus the current | Mandatory AntiFan MCP path |
| `device.open_safari` | Establish the Safari automation surface on the device (ensure the WebDriverAgent session) and return the bound device ta | Mandatory AntiFan MCP path |
| `device.navigate` | Open a url in Safari on the real device. This is a deep-link: it returns immediately and never waits for load, so follow | Mandatory AntiFan MCP path |
| `device.reload` | Re-open the last url this surface navigated to. WebDriverAgent exposes no refresh route and no URL readback, so reload i | Mandatory AntiFan MCP path |
| `device.screenshot` | Capture real-device screenshot evidence (the actual panel pixels a human would see) into the artifact store as a Tier-2  | Mandatory AntiFan MCP path |
| `device.tap` | Tap a point on the device panel. Coordinates are CSS points (the device viewport space), not raw pixels. | Mandatory AntiFan MCP path |
| `device.swipe` | Swipe on the device panel with a native gesture; momentum scrolling is produced by the device and nothing is emulated. | Mandatory AntiFan MCP path |
| `device.type` | Type text through the native keyboard into the currently focused field (tap the input first; WebDriverAgent types into t | Mandatory AntiFan MCP path |
| `device.wait` | Wait on the real device: 'timeout' sleeps; 'page_loaded'/'stable' sample frames until rendering stops changing. That is  | Mandatory AntiFan MCP path |
| `anti.telemetry.record_fallback` | Record sanitized fallback telemetry when invoking Playwright after an AntiFan capability failure. | Mandatory AntiFan MCP path |
| `anti.trace.interaction` | Trace an interactive action (click, hover, focus, type, scroll) capturing pre/post DOM changes, style deltas, and layout | Mandatory AntiFan MCP path |
| `anti.media.freeze` | Freeze or unfreeze dynamic media (videos, audios, CSS animations) in tab to enable deterministic visual comparisons. Nat | Mandatory AntiFan MCP path |
| `core.query` | Query the local Super Core evidence store: anchored claims filtered by text/platform/unit/kind. Platform filter excludes | Mandatory AntiFan MCP path |
| `core.context_pack` | Build a Context Pack for a task: relevant claims, unresolved conflicts, unknowns, permission scope. Packs dedupe on (tas | Mandatory AntiFan MCP path |
| `core.recommend` | Recommend from evidence: Context Pack + recommendation or explicit abstention. | Mandatory AntiFan MCP path |
| `core.receipt` | Issue a Decision Receipt binding task context and evidence revisions. Refused when Core unavailable. | Mandatory AntiFan MCP path |
| `core.ingest_outcome` | Ingest a verified outcome as a case + pending candidate (never auto-promoted). | Mandatory AntiFan MCP path |
| `core.adjudicate` | Adjudicate a candidate (PROMOTE/REJECT/SUPERSEDE) with explicit authority. Refused when Core unavailable. | Mandatory AntiFan MCP path |
| `core.stats` | Return Super Core store counts for verification. | Mandatory AntiFan MCP path |
| `core.health` | Aggregated Core Health: status, reasonCode, stats, audit, decay and phase gates. Read-only. | Mandatory AntiFan MCP path |
| `core.reuse_metric` | Historical reuse for a task: found + injected + outcome-linked counts, each witnessed by rows. Read-only. | Mandatory AntiFan MCP path |
| `core.domain` | Return a domain view (units, claims, eligible skills, gaps) or insufficient-evidence. | Mandatory AntiFan MCP path |
| `core.invalidate` | Mark claims stale when their source changed or was deleted. | Mandatory AntiFan MCP path |
| `core.revoke` | Revoke claims derived from a restricted source (permission propagation). | Mandatory AntiFan MCP path |
| `core.snapshot` | Create a release snapshot for regression/rollback. | Mandatory AntiFan MCP path |
| `core.rollback` | Restore claims/candidates to a release snapshot. | Mandatory AntiFan MCP path |
| `core.record_experience_node` | Record an experience graph node (CLIENT_REQUEST, PROJECT, TASK, CONTEXT, DECISION, IMPLEMENTATION, ARTIFACT, VERIFICATIO | Mandatory AntiFan MCP path |
| `core.record_experience_edge` | Record an experience graph edge between two nodes. | Mandatory AntiFan MCP path |
| `core.experience_chain` | Traverse the experience graph from a node (BFS, depth-bounded). | Mandatory AntiFan MCP path |
| `core.record_anti_pattern` | Record an anti-pattern: what not to do, symptoms, evidence, affected platform, replacement. | Mandatory AntiFan MCP path |
| `core.anti_patterns` | List anti-patterns, optionally filtered by platform/status. | Mandatory AntiFan MCP path |
| `core.record_workaround` | Record a workaround: problem, condition, solution, reason, platform, version, evidence. | Mandatory AntiFan MCP path |
| `core.workarounds` | List workarounds, optionally filtered by platform/stillValid. | Mandatory AntiFan MCP path |
| `core.record_fix_pattern` | Record a fix pattern: before, after, why, evidence, lesson. | Mandatory AntiFan MCP path |
| `core.fix_patterns` | List fix patterns. | Mandatory AntiFan MCP path |
| `core.find_similar` | Find similar claims, cases, decisions, anti-patterns, workarounds, fix patterns for a task. Platform filter excludes unt | Mandatory AntiFan MCP path |
| `core.classify_uncertainty` | Classify uncertainty level for a claim or task. | Mandatory AntiFan MCP path |
| `core.decay_check` | Check for stale/aging claims beyond a threshold. | Mandatory AntiFan MCP path |
| `core.corpus_audit` | Run a corpus completion audit (read-only evaluation). | Mandatory AntiFan MCP path |
| `core.candidates` | List adjudication candidates (default PENDING). | Mandatory AntiFan MCP path |
| `core.knowledge_gaps` | Classify per-platform knowledge gaps: NO_EVIDENCE (never had claims), STALE (claims exist, none fresh), CONFLICTED (clai | Mandatory AntiFan MCP path |
| `core.check_phase_gate` | Check a phase gate (coverage, evidence, conflict, temporal, promotion, regression). | Mandatory AntiFan MCP path |
| `core.resolve_conflict` | Resolve or classify a conflict (GENERAL_RULE, CONTEXTUAL_RULE, LEGACY_RULE, EXCEPTION, CONFLICTED, UNRESOLVED). | Mandatory AntiFan MCP path |
| `core.record_regression` | Record a core regression definition; core.replay_regression re-executes its checks against live state and writes the res | Mandatory AntiFan MCP path |
| `core.replay_regression` | Re-execute a recorded regression's checks against live state and write replayResult + replayedAt. | Mandatory AntiFan MCP path |
| `core.record_observation` | Record a raw observation (source, kind, payload) into the learning loop. | Mandatory AntiFan MCP path |
| `core.record_principle` | Record a personal engineering principle. | Mandatory AntiFan MCP path |
| `core.principles` | List principles. | Mandatory AntiFan MCP path |
| `core.record_hidden_requirement` | Record a hidden requirement inferred from a task. | Mandatory AntiFan MCP path |
| `core.hidden_requirements` | List hidden requirements. | Mandatory AntiFan MCP path |
| `core.record_commercial` | Record commercial intelligence for a task type. | Mandatory AntiFan MCP path |
| `core.commercial_intel` | List commercial intelligence records. | Mandatory AntiFan MCP path |
| `core.record_tool` | Record tool intelligence. | Mandatory AntiFan MCP path |
| `core.tool_intel` | List tool intelligence records. | Mandatory AntiFan MCP path |
| `core.record_archetype` | Record a project archetype. | Mandatory AntiFan MCP path |
| `core.archetypes` | List archetypes. | Mandatory AntiFan MCP path |
| `core.record_platform_semantic` | Record a platform semantic fact. | Mandatory AntiFan MCP path |
| `core.platform_semantics` | List platform semantics. | Mandatory AntiFan MCP path |
| `core.record_practice_parity` | Record declared vs observed practice parity. | Mandatory AntiFan MCP path |
| `core.practice_parity` | List practice parity records. | Mandatory AntiFan MCP path |
| `core.record_skill_version` | Record a skill version/failure/fix/production event. | Mandatory AntiFan MCP path |
| `core.skill_genealogy` | List skill version history. | Mandatory AntiFan MCP path |
| `core.context_pack_v2` | Build an enriched Context Pack: claims + rules + historical cases + pitfalls + workarounds + recommended pattern + uncer | Mandatory AntiFan MCP path |
| `core.receipt_v2` | Issue an enriched Decision Receipt: evidence revisions + why + historical cases + risks + alternatives + uncertainty + c | Mandatory AntiFan MCP path |
| `terminal.write` | Write raw input text to an active PTY terminal session. Writing to a SLEEPING session wakes it (a fresh shell in the sam | Mandatory AntiFan MCP path |
| `terminal.resize` | Resize terminal rows and columns for an active PTY session | Mandatory AntiFan MCP path |
| `terminal.wait` | Wait for output-match pattern, process exit, or silence on a terminal session. A SLEEPING session returns immediately wi | Mandatory AntiFan MCP path |
| `terminal.list` | List active terminal sessions with bounded wire summary and incarnation metadata | Mandatory AntiFan MCP path |
| `terminal.create` | Create a new base or split terminal PTY session | Mandatory AntiFan MCP path |
| `terminal.close` | Close a terminal session and safely terminate its process tree | Mandatory AntiFan MCP path |

