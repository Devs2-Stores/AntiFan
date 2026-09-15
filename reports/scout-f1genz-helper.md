# Scout Report — F1GENZ Helper (--ultra)

## Project & Directory

- Root: E:\Work\apps\F1GENZ Helper — flagged kind:app, platform:haravan, verification:needsVerification, reason:nested-layout-unclear in .workspace-context.json.
- Layout: triple-nested F1GENZ Helper\F1GENZ Helper\F1GENZ Helper\ holding the payload — a Manifest V3 Chrome extension (~37 months old, v0.0.1). Nesting is a packaging artifact, not a monorepo.
- Files (11): manifest.json (MV3, activeTab+scripting, action icon only); background.js (service worker, ON/OFF badge + injection orchestrator); f1genz-helper-on.js (12.3KB, 311 lines — the entire app); f1genz-helper-off.js (32B, `$("#f1genz-helper-tool").hide()`); f1genz-helper.css/.map/.scss (fixed 320px left panel, z-index 999999999, 100vh); jquery.js (83.7KB bundled); f1genz-google-form.js (60B DEAD: `import puppeteer`/`import path`, unreferenced); index.html (5B, literal "ABCDE"); avatar.png.
- Side artifact: .antigravity/mcp-bridge/cmd-1787146796467-1640.res.json — submitted-command receipt, evidence the AntiFan MCP bridge touched this dir ~3w ago.

## Architecture & Role

Internal dev-productivity extension for F1GENZ theme engineers in the Haravan ADMIN (not a storefront app). Injects fixed left panel #f1genz-helper-tool into the active tab on toolbar click; three generators:
1. Settings — emits legacy Haravan settings.html markup (fieldset/table/input rows) + a Liquid capture loop for looped settings.
2. GET GoogleForm — paste a Google Form EDIT url → Apps Script proxy → returns ready HTML <form> with entry.<n> names (backend-less direct submit).
3. POST GoogleForm — define ≤10 short-answer fields → proxy CREATES a Google Form → returns edit link + generated DOM.

Flow: chrome.action click → background.js toggles badge → ON: insertCSS(css) → executeScript(jquery.js) → executeScript(f1genz-helper-on.js); OFF: executeScript(jquery.js) → executeScript(off.js) → $panel.hide(). In on.js: Helper.General.init() binds delegated $("body").on("click",…) handlers EVERY injection; then `if ($("#f1genz-helper-tool").length==0)` appends panel DOM + binds tool handlers, else $panel.show(). Scripts run in the MV3 isolated world — bundled jQuery never collides with page jQuery, but page JS state is unreachable; tool is DOM-in/clipboard-out.

## Load-bearing Files & Contracts

background.js — badge state machine (onInstalled→"OFF", onClicked toggles); no host_permissions, relies on activeTab grant; OFF path still injects jquery.js first (off-script needs $).

f1genz-helper-on.js — three contracts:

A. Legacy Haravan settings.html grammar (lines 219–296): <fieldset><legend> wrapper (224–225,274); <h3>{title} {i}</h3><table> per loop (227–228,273); row = <tr><td><label>{title}</label></td><td>{input}</td></tr>. 11-type vocabulary (244–272): text/checkbox/color/number inputs; <textarea type="textarea">; png→<input type="file" name="{n}.png"/> (251); jpg→name="{n}.jpg" (254); linklist/collection/blog/page→<select class="{type}" type="select" name="{n}"> (257+). Loop convention: loop>1 → names get numeric suffix {name}{i} (235–238), images keep ext after suffix. Liquid companion (277–295): {%- for i in (1..N) -%}{%- capture name -%}{name}{{ i }}[.png|.jpg]{%- endcapture -%}{%- endfor -%} — theme Liquid composes the setting name then indexes settings[name].

B. Google Forms direct-submit (30–46): <form method action> with inputs name="entry.{v.entry}", optional <label for="input{v.id}">{v.titile}</label>, submit "Gửi" — classic Haravan/Sapo backend-less contact form posting to docs.google.com/.../formResponse.

C. Apps Script proxy (70–83, 106–120): hardcoded endpoint duplicated verbatim — https://script.google.com/macros/s/AKfycbxYxahhcYflXewhzMGCRVudz-iPwTS5NyYCHFljVGUXAFGvCWjUtjYWnYwpnHnRyzTEEw/exec. POST JSON body with Content-Type: application/x-www-form-urlencoded + redirect:"follow" (Apps Script CORS/redirect workaround). Consumed response: {url, data:{method, action, entry:[{id, entry, titile}]}} — misspelled field `titile` is baked into both proxy API and renderer (38,42).

f1genz-helper.scss — #f1genz-helper-tool: fixed, top/left 0, 320px, 100vh, z-index 999999999; @for-generated .wi-1..100/.wig-1..100 width utilities.

## Critical Edge Cases / Traps / Workarounds

1. Delegated-handler accumulation (top defect): init() at line 126 re-binds $("body").on("click",…) on EVERY ON injection (lines 9,49–60,91–98). The length==0 guard (128) stops DOM dupes but NOT handler dupes → N toggles = N duplicate fetches/resets per click. Fix: namespaced off/on or a bound sentinel.
2. document.execCommand("copy") (51,94,300,304) — deprecated but the only reliable copy path here: navigator.clipboard is unavailable in this non-secure injected context; works because textarea is visible + .select() precedes.
3. Edit-URL heuristic (102): `!id.includes("edit")` rejects viewform URLs with bare "Error" — undocumented requirement to paste the EDIT url.
4. Zero fetch error handling: no .catch/timeout; dead Apps Script deployment = "Loading…" forever (105–120).
5. `titile` typo is load-bearing contract — fixing the backend spelling breaks the extension.
6. OFF still injects jQuery (wasteful; isolated world each time).
7. Panel pollutes host DOM: 320px fixed overlay z-index 999999999 under <body> — corrupts DOM snapshots, page-inventory scans, visual diffs taken while open.
8. Dead files: f1genz-google-form.js (puppeteer imports can't run in SW/content script anyway), index.html "ABCDE" — neither referenced by manifest.
9. Nested-dir packaging trap: extension root is 3 levels deep; "load unpacked" at top level fails silently (no manifest). .workspace-context.json already flags it.
10. type="select" on resource selects (257): non-standard HTML but part of the legacy Haravan settings parser contract — admin engine keys off class + type="select" to populate linklist/collection/blog/page options.
11. File-input name encodes image type: name="{field}.png" IS the type declaration; Liquid access must compose the same suffixed name (mirrored in capture generator 285–288).

## Improvements for Super Core

- platform_semantic — Haravan legacy settings.html grammar: fieldset>legend, h3+table grouping, 11-type vocabulary, class="linklist|collection|blog|page" type="select" resource selects, input type="file" name="field.png|jpg" image convention, {name}{i} loop naming + Liquid capture-name access. Ground truth for the pre-schema admin contract.
- platform_semantic — Google Forms direct-submit: entry.<n> names + formResponse action = standard backend-less form pattern across Haravan/Sapo; Apps Script proxies are the introspection/creation tool.
- anti_pattern — delegated handler stacking on re-injection: $("body").on("click",sel,fn) in a re-runnable content script multiplies side effects; guard DOM AND handlers (namespace off/on or sentinel). Symptom: N toggles ⇒ N duplicate calls.
- anti_pattern — hardcoded third-party /exec endpoint with no timeout/catch: Apps Script URLs rot silently.
- workaround — Apps Script fetch recipe: redirect:"follow" + Content-Type: application/x-www-form-urlencoded (NOT application/json) survives the script.google.com redirect/CORS dance.
- workaround — clipboard in injected scripts: execCommand("copy") on a visible selected textarea remains the only reliable path where navigator.clipboard is blocked; document, don't "fix".
- hidden_requirement — API typo contracts: a shipped misspelled field (titile) becomes immutable; flag typo'd consumed-API fields as frozen.
- fix_pattern — MV3 toggle extension: badge state machine + ordered insertCSS/executeScript (CSS→jQuery→app); OFF path must not assume prior world state.

## Improvements for Haravan Theme Core Output

- ThemeCompiler/HaravanSchemaGenerator must round-trip the legacy grammar exactly: fieldset>legend, h3+table, all 11 input types, type="select"+resource class, name="{field}.{png,jpg}" file inputs. This extension is a living golden specimen — snapshot-test against it.
- Loop support needs dual output: unrolled settings markup ({name}1..N) AND the Liquid capture-loop snippet; compiler should own both artifacts from one IR node (loop:N on a field group).
- Settings IR type enum maps 1:1 to {text,checkbox,color,number,textarea,png,jpg,linklist,collection,blog,page}; model png|jpg as image(format) internally, serialize back to the file-input convention.
- DOM sanitizer (theme export path): strip #f1genz-helper-tool — generalize to chrome-extension://-sourced nodes or fixed overlays z-index≥999999 appended under body; otherwise export_clean on a dev machine ships the helper panel inside cloned themes.
- Google Form widget contract: theme-side form generator should support provider:google-form emitting entry.<n> fields + optional label wrappers matching this tool's output (form-group/input{id} shape).

## Improvements for AntiFan Core & Site Clone

AntiFan Core:
- Snapshot/telemetry hygiene: inspect.page_inventory, inspect.snapshot, dump_dom, visual.compare, theme.export_clean should exclude extension overlays. Denylist seed: #f1genz-helper-tool; heuristic: position:fixed + z-index≥1e8 + direct body child + no theme-source correlation via theme.resolve_element. Otherwise a 320px panel corrupts region bounds, element indexing, pixel diffs.
- Verification claims: "page renders X sections" is falsifiable by extension chrome — claim recorder should capture "extension overlay present" as environmental context.
- Isolated-world awareness: CDP evaluate runs in page world; this extension's jQuery/DOM lives in the isolated world — telemetry expecting injected helpers reachable from page context will miss them. Document the boundary.

Site Clone:
- DoD validator: (a) flag #f1genz-helper-tool or any chrome-extension:// artifact in captured DOM as clone-hygiene failure; (b) flag forms with action on docs.google.com/script.google.com as external-dependency findings for offline-standalone mode — cannot be localized, must be declared.
- Asset pipeline: extension-injected jquery.js must never be attributed to the page's own asset graph — distinguish origin when building the offline manifest.
- IR model: settings-generator output is a clean "looped field group" specimen — add FieldGroup{loop, fields[]} IR node so cloned legacy settings.html can be decompiled back into IR.
- Dead-code precedent: f1genz-google-form.js (puppeteer import in a browser ext) + index.html ("ABCDE") = scaffold residue shipping in production artifacts; DoD validator should flag files unreachable from manifest/entrypoints.
