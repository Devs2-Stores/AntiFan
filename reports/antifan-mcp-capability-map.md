# AntiFan MCP Capability Map (Audit §2, Mandate v2.0)

Total Registered Tools: **52**

## BROWSER (9 tools)

| Tool Name | Purpose | When to Use |
|-----------|---------|-------------|
| `anti.browser.tabs.list` | List tabs in the live AntiFan Desktop Browser GUI (every tab in the window by default; pass all: false to list only the  | Mandatory AntiFan MCP path |
| `anti.browser.tabs.create` | Open a new tab in live AntiFan Desktop Browser GUI without stealing focus. | Mandatory AntiFan MCP path |
| `anti.browser.tabs.activate` | Switch the active tab visible to the user in live AntiFan Desktop Browser GUI by tabId. | Mandatory AntiFan MCP path |
| `anti.browser.tabs.close` | Close a tab in live AntiFan Desktop Browser GUI by tabId. | Mandatory AntiFan MCP path |
| `anti.browser.navigate` | Navigate active or background tab in live AntiFan Desktop Browser GUI. | Mandatory AntiFan MCP path |
| `anti.browser.reload` | Reload active or background tab in live AntiFan Desktop Browser GUI. | Mandatory AntiFan MCP path |
| `anti.browser.set_viewport` | Set the bound tab viewport dimensions and device emulation, verified against the size the tab actually measures. | Mandatory AntiFan MCP path |
| `anti.browser.evaluate` | Execute JavaScript expression in page context with depth-capped circular protection. Refuses a tab with no laid-out surf | Mandatory AntiFan MCP path |
| `browser.set-viewport` | Set the bound Chromium tab viewport dimensions and device emulation. | Mandatory AntiFan MCP path |

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
| `anti.screenshot.full_page` | Capture canonical CDP full-page evidence (entire document scroll height) and stage it under the evidence lease. | Mandatory AntiFan MCP path |
| `anti.reference.capture` | Capture a reference from a live page: materialize lazily-mounted content, settle, then stage the settled DOM (and option | Mandatory AntiFan MCP path |
| `anti.visual.compare` | Compare current viewport or tab against baseline screenshot with pixel-level diffing, element selection, dynamic masking | Mandatory AntiFan MCP path |

## THEME (8 tools)

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

## VERIFICATION (4 tools)

| Tool Name | Purpose | When to Use |
|-----------|---------|-------------|
| `anti.spec.validate_gate` | Validate HTML Specification against target page to certify HTML_SPEC_READY status before theme compilation. | Mandatory AntiFan MCP path |
| `anti.verification.record_claim` | Record a live verification claim as UNVERIFIED with explicit proof obligations. | Mandatory AntiFan MCP path |
| `anti.verification.verify_claim` | Evaluate a recorded claim against fresh live browser evidence and persist an authoritative receipt. | Mandatory AntiFan MCP path |
| `anti.verification.list` | List recorded verification claims and their current verdicts. | Mandatory AntiFan MCP path |

## AGENT_CURSOR (10 tools)

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
| `anti.agent.sequence` | Execute an atomic multi-step action sequence (navigate, click, type, scroll, hover, pressKey, wait, screenshot, snapshot | Mandatory AntiFan MCP path |

## ARTIFACT (4 tools)

| Tool Name | Purpose | When to Use |
|-----------|---------|-------------|
| `anti.artifact.read` | Read an authorized artifact by ID with bounded chunk size (clamped to max 32KB per frame). | Mandatory AntiFan MCP path |
| `anti.artifact.stat` | Retrieve metadata and size information for an authorized artifact. | Mandatory AntiFan MCP path |
| `file.read` | Read a file relative to the authoritative workspace root. | Mandatory AntiFan MCP path |
| `file.write` | Write a file relative to the authoritative workspace root with boundary enforcement. | Mandatory AntiFan MCP path |

## OTHER (5 tools)

| Tool Name | Purpose | When to Use |
|-----------|---------|-------------|
| `browser_find` | Search the accessibility snapshot of the current page for text, pattern, query, or a regular expression. | Mandatory AntiFan MCP path |
| `browser_press_key` | Send native keyboard key press (Enter, Escape, Tab, Backspace, Arrow keys, etc.) or combination (Control+a) to the activ | Mandatory AntiFan MCP path |
| `anti.telemetry.record_fallback` | Record sanitized fallback telemetry when invoking Playwright after an AntiFan capability failure. | Mandatory AntiFan MCP path |
| `anti.trace.interaction` | Trace an interactive action (click, hover, focus, type, scroll) capturing pre/post DOM changes, style deltas, and layout | Mandatory AntiFan MCP path |
| `anti.media.freeze` | Freeze or unfreeze dynamic media (videos, audios, CSS animations, requestAnimationFrame) in tab to enable deterministic  | Mandatory AntiFan MCP path |

