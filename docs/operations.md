# AntiFan Browser Desktop — Operations

Local Control Plane operations for OMP / agent CLI clients through MCP. Browser,
device, terminal, artifact, and theme QA services execute explicit capabilities;
external agents retain planning and repair responsibility. Legacy extension
integration notes below describe those integrations, not a required core dependency.

> **Scope Invariant (Personal / Non-Public Tooling):**
> AntiFan Browser Desktop is strictly an internal, personal developer companion.
> Public distribution concerns (such as Chrome Web Store publishing, EV Code
> Signing certificates, and public auto-update servers) are intentionally
> out-of-scope. Installation and upgrades use local packaging (`npm run package`)
> and local script runners.

## Repair and final artifact verification

- `theme.qa_repair.verify` runs fresh QA with a unique verification attempt. A failed or inconclusive check retains the session as `awaiting_fix`; the workspace must change before retry. Existing circuit-breaker repair limits yield `blocked`, never success. Session expiry and target binding remain enforced.
- The returned `revision` hashes the scanned workspace files before and after QA. Concurrent edits reject certification. This does not by itself prove deployment of local bytes to a remote storefront.
- Regression still uses the existing baseline differential and authorized R0 rollback. A QA pass certifies that QA scope, not universal visual fidelity or real-device parity.
- Final visual certification requires matching target URL (including preview query), surface, and artifact revision. Surface comparison is case-insensitive and a trailing slash on the target URL is tolerated; the query is compared, so a receipt captured against a different preview theme never certifies. Diagnostic metrics cannot certify final parity.
- Source CSS/JS now requires `codeApprovals`, supplied to the CLI as a path to a JSON file (`--code-approvals <path>` or `--code-approvals=<path>`), an array of `{ sha256, classification, usage, evidence }`. Classification must be `THEME_REQUIRED` or `EXTRACTED`; the hash binds exact UTF-8 source content. Unclassified or changed code fails with `UNRESOLVED_CODE_OWNERSHIP`. Approval is an explicit maintainer decision, not automatic semantic classification or visual certification. Do not generate approvals for all files merely to bypass the gate. A harvested stylesheet or script whose bytes never reached disk is reported by the existing asset audit as a missing/unavailable asset, not as an ownership violation.
- The CLI compiler stages route transforms and asset consolidation before final validation/promotion. Conflicting basename contents and missing final Liquid asset references fail before promotion. This integrity gate does not classify reference CSS/JS ownership. Compiles without an asset source (`assetsDir`/`inputPath`/`failClosedAssets`) keep the platform's existing tolerance for third-party or externally supplied references; the reference audit is mandatory whenever the compiler owns the referenced bytes.
- Asset filenames come from the source reference only when that stem carries meaning. Generic download names (`image`, `download`, `untitled`, `default`, `screenshot`, …), pure digits, and hash-only stems are replaced with a stable `asset-<source-url-hash>` id. The rule applies to harvested assets and to dependencies discovered inside CSS (`@import`, `url(...)`) alike. Role-shaped names such as `hero-banner.webp` are never invented from a guess; provenance (`sourceUrl`, occurrences, request identity) is retained on every item.
- `anti.media.freeze` leaves native RAF/cancellation untouched. It pauses media/CSS animation and running infinite Web Animations API animations (the classification reports per-class counts: `media`, `css`, `waapi`, `smil`), and optionally normalizes slider tracks; unfreeze resumes exactly the handles this freeze paused and restores recorded styles/scroll state without synthetic hover events. RAF-driven visual motion requires separate capture-settle evidence.

Executable checks (build emitted TypeScript first):

```sh
npm run typecheck
npm run build:site-clone
npx tsc -p .
node --test --test-force-exit .compiled/test/main/theme-qa-workflow-differential-and-rollback.test.js .compiled/test/unit/sensory-and-spec-gate.test.js .compiled/test/unit/injected-script-store.test.js
node --test packages/site-clone/dist/generators/theme-compiler.test.js packages/site-clone/dist/qa/dod-validator.test.js
node scripts/run-electron.cjs scripts/smoke-media-freeze.cjs
```

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

## Super Core (local evidence/provenance store)

- `packages/super-core` is a local-first SQLite store (`node:sqlite`, WAL) over the
  Work Root corpus: artifacts, claims, evidence anchors, decisions, dependencies,
  conflicts, skills, cases/candidates, releases, receipts.
- DB defaults to `<repo>/.super-core/core.db`; `SUPER_CORE_DB` overrides.
- MCP tools `core.query`, `core.context_pack`, `core.recommend`, `core.receipt`,
  `core.ingest_outcome`, `core.adjudicate`, `core.stats`, `core.domain`,
  `core.invalidate`, `core.revoke`, `core.snapshot`, `core.rollback` are served
  in-process by `scripts/antifan-omp-mcp.cjs` (no bridge dependency). A running
  MCP server must be restarted to pick up a rebuilt `packages/super-core/dist`.
- CLI: `antifan-core <cmd>` via `scripts/antifan-core.cjs`.
- Adjudication has a `scope` (`production` | `acceptance-test`); test-scope
  promotions are auditable and never masquerade as user approvals.
- `scripts/clone-site.mjs` queries `core.contextPack` before cloning (fail-open),
  detects the source platform from captured HTML, supports `--theme` to compile a
  Haravan theme skeleton (requires `--code-approvals <file>`), and records the
  outcome via `core.ingestOutcome` after the manifest is written.

## Exact Conversation Routing (Sidecar Router)

- **Managed Sidecar ID**: `antifan-chat-router`
- **Sidecar Data Directory**: `~/.gemini/antigravity/sidecar_data/antifan-chat-router/data`
- **Routing Protocol**:
  - `Auto Send`: Routed via `sidecar-agentapi` targeting the specific Antigravity conversation ID chosen in the Sidebar session selector.
  - `Draft`: Populates the active-panel composer via standard Extension Host bridge without auto-submitting.
  - `Pre-publication Downgrade`: If Sidecar is offline or unmapped before request publication, opens an explicit Draft in active panel labeled `Active tab draft`.
  - `Post-publication Boundary`: Any timeout or crash after publishing a Sidecar request marks delivery `unknown`; never creates duplicate commands or auto-resends.

### Installation & Management Commands (External Extension Companion)

The Sidecar configuration scripts are hosted in the external extension companion repository (`antigravity-browser`):
```bash
# In external companion repo (e.g. E:/Work/apps/antigravity-browser):
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
- Report chỉ chứng nhận thứ đã đo: `qaMatrix` giữ `domSemantics`, `cssModularity` và `interactiveOperability` ở `score: null` kèm mô tả "unmeasured" vì workflow không chạy scanner tương ứng, và `checklist.interactions` chỉ xuất hiện khi có kết quả probe thật từ caller (không suy ra từ HS scan). Bật `enabledChecks.interactions` khi chưa có phép đo trả về `INCONCLUSIVE` kèm evidence gap, không phải PASS/FAIL.
- `theme.debug_bundle` / `antifan_theme_debug_bundle`: Returns immediate diagnostic scan results without staging reports.

### PII Sanitization Guarantee

All generated Theme QA reports automatically redact customer emails, phone numbers, and bearer tokens before saving artifacts or transmitting responses.

---

## MCP Dispatch Accounting (Invocation Ledger)

Read-only accounting over the control-plane invocation ledger (`control-plane-v2/invocations`): which dispatched MCP tool names were actually called, what terminal state they reached, which `error.code`s dominate, and how slow they were. The reader is `src/main/diagnostics/mcp-dispatch-accounting.ts` (compiled to `.compiled/src/main/diagnostics/mcp-dispatch-accounting.js`, which the service's worker and the CLI both load); the Hub renders **one** panel over it, and `scripts/antifan-mcp-dispatch-account.cjs` proves the same reader runs outside Electron. The suite adds no ledger, no hot-path instrument and no advertised MCP tool, and it never calls `InvocationLedger.initialize()` — the dispatch path is untouched.

### What the reader measures

- One row per **recorded dispatch name**: `calls`, `frames`, `superseded`, the terminal `states` mix, the `errors` histogram, and `latency` p50/p95 from owner-written samples only. **Both histograms are published as object keys**, so their key space is bounded at the publication boundary (`sortedHistogram` in the reader): a persisted `frame.state` or `frame.error.code` is published verbatim only when it matches `HISTOGRAM_TOKEN_PATTERN` **and** is not location-shaped, and anything else is published as `UNRECOGNIZED` with its count **summed** into that bucket — never dropped, because the row's own totals have to reconcile. That is a boundary rule rather than a display choice: a `frame.error.code` is writer-supplied text that nothing validates on the way in, so without the rename a single crafted frame would reach the renderer as a JSON **key** carrying the operator's file layout, where a value-only sanitiser never looks. Rows describe **retained frames only** — a name absent from the payload means "no frame retained in this store", never "the tool was never called". Absence renders `UNMEASURED`/`NO_DATA` with the mechanism named; it never renders `0`.
- Identity is the validated composite `(attachmentId, idempotencyKey)`. `frame.id` is a random control-plane id, is not an identity, and is not an input to one. A frame that cannot form a composite is counted in `unattributed*`, never silently merged.
- The population is every entry of the injected directory whose name **contains** `.jsonl` — deliberately wider than the writer's own `endsWith('.jsonl')` filter, because `*.jsonl.quarantine-<ts>` (whole-partition quarantine, `quarantinePartition` in `src/main/session/invocation-ledger.ts`) and `*.jsonl.tmp-<pid>-<ts>` (compaction temp file) are exactly the shapes a name-filtered reader loses. The buckets reconcile by construction: `fileCount == jsonlCount + quarantineCount + tempCount + otherCount`.
- **Retention horizon.** The suite *reports* retention; it never changes it. Live partitions are append-only, `pruneDeadPartitions` filters `*.jsonl` so it never touches a quarantine file, and a quarantined partition is never replayed. The store therefore grows with lifetime rather than with the current snapshot: the pass declares a time budget and an input ceiling and discloses which one stopped it, and the rows carry the `firstSeen`/`lastSeen` they actually saw. Dated snapshots of the store's scale live in `plans/260917-0341-mcp-dispatch-accounting/plan.md` and are deliberately not repeated here: no count is a constant anywhere in the code, the tests or the assertions, and every run re-derives its own.
- The pass runs off the Electron main thread: `McpDispatchService` spawns a `node:worker_threads` worker over that compiled, electron-free module and awaits exactly one message. The CLI runs the same pass in-process (yielding every `IN_PROCESS_YIELD_INTERVAL_FILES` files). `PASS_BUDGET_MS`, `MAX_CENSUS_BYTES`, `MAX_CENSUS_FILES` and `IN_PROCESS_YIELD_INTERVAL_FILES` are the pass module's own exports; no other surface inlines a literal or declares a second budget.

### The quarantine margin is a margin, not a recovery

- `totals.quarantineMargin` = `{ label, files, framesPresent, framesAdmitted, framesNamedInvalid, reasons[] }`, summed from the pass's per-file `fileRollups` — no file is opened, nothing is re-scanned. Each roll-up carries a file **name** (never a path) and satisfies `frames === admitted + namedInvalid`, so `holdsMargin` is checkable from the payload alone.
- It is a **margin**, not a recovery: `framesAdmitted` is a *split of* the already-admitted set (the intact frames inside a quarantined file are already inside the admitted total), so no surface may add it to anything. The margin discloses; it does not accumulate. **0 retained frames are repaired by this suite**, and `label` says so verbatim.
- Files skipped by the input ceiling are **not** margin: `fileRollups` carries one entry per file actually read.
- The dominant margin reason today is `writer-canonicalization-array-slot`: `canonicalJsonStringify`'s array branch (`src/shared/control-plane-contracts.ts`) renders an `undefined`/`null` element as an empty slot while the writer persists `null` inside arrays, so such a frame cannot re-verify and its whole partition is quarantined. It is diagnosed here, not repaired here — the same helper backs policy and parameter digests, so it is tracked as row **B33** in `plans/bottlenecks.json`.

### Residue and short-read vocabulary

The reader names what it cannot admit instead of dropping it. Line classes: `ADMITTED`, `STRUCTURAL_INVALID`, `CHECKSUM_MISMATCH`, `TORN_TAIL`, `UNPARSEABLE`, `RESIDUE_NO_CHECKSUM`, `POST_CENSUS_APPEND`; per-file outcomes `POST_CENSUS_TRUNCATE`, `VANISHED`; whole-read outcome `CENSUS_DRIFT`. Both `reason` fields are closed sets (`missing-identity | unsupported-format-version`, `writer-canonicalization-array-slot | unexplained`).

- `POST_CENSUS_APPEND` — the file grew between the census `stat` and the read. The reader reads exactly the censused byte length and hashes the bytes it actually read, so a live append is **named**, not silently half-read.
- `POST_CENSUS_TRUNCATE` — the file shrank, or its bytes no longer hash to the censused bytes: the partition is no longer the object that was censused.
- `VANISHED` — the file disappeared between census and read (a compaction rename or unlink).
- `CENSUS_DRIFT` differs in kind: it is a **whole-read** outcome, not a per-line class, and it fails closed to `UNMEASURED` — a partial in-memory fold cannot be trusted, so there are no rows at all. A time-budget expiry has the same shape (`UNMEASURED` / `READ_BUDGET_EXCEEDED`, `census: null`, `totals: null`, `rows: []`).
- An **input** ceiling is the opposite case: the files actually read are a legitimate measurement, so rows render over the **newest-first** selection (`order: 'mtimeMs-desc,name-asc'` — a name-sorted prefix would render every late-sorting tool as "never called"), with `totals.truncation = { ceiling, filesRead, filesSkipped, order }`, the `partial: N of M files` label, and the covered `mtimeMs` window. The margin then covers the read set only.
- `lowerBound: true` marks a row measured over a truncated read: its counts are a floor ("≥ N"), never a total. `lowerBound: false` means the row covers every retained frame in the read set.

### CLI

```sh
node scripts/antifan-mcp-dispatch-account.cjs [--store <dir>] [--as-of <iso>] [--json] [--no-memo] [--freeze]
node scripts/antifan-mcp-dispatch-account.cjs --core-attempts [--dir <dir>] [--json]
```

- `--store <dir>` — the invocation store directory. `ANTIFAN_DATA_ROOT` is the only other input, joined with `control-plane-v2/invocations`. With neither, the run prints `UNMEASURED` / `NO_DATA_ROOT_RESOLVED` with `storePath: null` and reads nothing: there is deliberately **no** repo-relative, working-directory or `%APPDATA%` ladder. On this workstation the repo-relative `E:\Work\apps\AntiFan\.antifan-data` does not exist while the live store is `E:\Work\.antifan-data`, so such a ladder would silently read the live store while the operator believes `--store` won.
- `--as-of <iso>` — pins the instant the payload describes (default: now). The pass never reads a clock itself. Ledger section only.
- `--json` — stdout is one JSON document and **nothing else**, so `JSON.parse(stdout)` is well defined. It has exactly two members: `{ "storeAbsolute": <string|null>, "payload": { <the envelope> } }`. `payload` is the document the renderer receives and the **only** part the payload gate validates, so the gate's own verdicts describe it and not the wrapper; `storeAbsolute` is the CLI's own disclosure of the store the run actually read (`null` when nothing was read, e.g. no root resolved or a freeze that could not be taken). Constraint D keeps absolute paths out of the renderer payload, not out of the CLI, which is why the location lives beside the payload instead of inside it — an earlier flat document put a key the project's own gate rejects *inside* the payload it was validating. **This is a breaking change** for any consumer that parsed that flat object: read `.payload` for the envelope and `.storeAbsolute` for the location. The envelope's own `storePath` stays the display label — the **final path segment** of the store it read, separator-free by construction (`storeDisplayLabel` in the reader module, which the CLI uses on every path where that module loads and mirrors with a drive-guarded fallback for the branches that run when it cannot). Human mode keeps the `store: <absolute>` first line, and the absolute location stays a CLI/receipt affordance only. In `--core-attempts` mode the document is the **proxy's own** and is streamed through unchanged, so this wrapper does not apply there.
- `--no-memo` — states a cold read explicitly; the CLI never memoises, because its job is determinism and a cold read rather than speed.
- `--freeze` — copies the store into a fresh directory under the OS temp directory and reads the copy, printing that path, so a determinism proof cannot be perturbed by a live append. Byte-identity is proven by reading the **same** copy twice: `node scripts/antifan-mcp-dispatch-account.cjs --store <freeze> --as-of <fixed> --json`. Ledger section only.
- `--core-attempts` — **delegates** to the reader that owns the store: it spawns `node scripts/antifan-omp-mcp.cjs --core-attempts [--json] [--dir <dir>]` with the current interpreter, streams that reader's stdout/stderr through unchanged and propagates its exit code. The proxy owns the attempt store, so the proxy owns its reader and its schema; this CLI is a convenience facade over it and never parses an attempt record itself. `--dir <dir>` overrides which attempt store is read; otherwise the store is derived from the same data root the ledger store came from (the bridge mints `<dataRoot>/telemetry/core-attempts` into the launcher's child environment), and the resolved invocation directory is never forwarded because it is a different store. With no root resolved at all, the proxy applies its own `ANTIFAN_PROXY_TELEMETRY_DIR` rule rather than a guess made here. `--freeze` and `--as-of` are **refused** with this flag (exit `2`) instead of being silently ignored.
- Exit codes: `0` whenever a well-formed envelope was printed (`MEASURED` or `UNMEASURED` — the status is data, not a failure), `2` for malformed argv or a refused flag combination, `1` when the delegated reader could not be spawned or did not exit normally. The CLI never writes inside the store. `npm run accounting:mcp-dispatch` runs `npm run compile` first, then this CLI with no arguments.

The payload's shape is pinned at build time rather than at runtime. `scripts/check-mcp-dispatch-payload.mjs` is the **last step of `npm run compile`**, and its entire input is the committed fixtures under `test/fixtures/mcp-dispatch-payload/` plus its own source — it reads no store and no environment variable, so a dirty or absent store can never keep the app from launching. Over a payload it enforces: rule 1, the envelope, row and per-file roll-up key sets are subsets of the frozen allowlists; rule 2, no persisted frame/authority field named by constraint D appears anywhere inside it; rule 3, no string **and no key** is an absolute path (`C:\…`, `\\server…`, `/…`) or an `http(s)://` URL — the `states` and `errors` histograms are keyed by persisted text, so a key is data too; and rule 4, the declared role of a fixture must match its shape (`empty-store.json` must assert `UNMEASURED` with `totals: null, rows: []` instead of comparing nulls). Exit `0` when every rule holds, `1` when one fires with the offending location named on stderr, `2` for malformed argv. Rules 1–3 each have one fixture under `seeded/` that trips that rule and **only** that rule; rule 4 is asserted by the role fixtures themselves, which must match the shape their role declares. The reader's `UNRECOGNIZED` boundary and this gate are two independent defences against the same leak: the reader stops a location-shaped histogram key from being *produced*, and the gate stops one from *crossing* even if a future producer emits it.

### `core.*` provenance

The ledger contains **zero** `core.*` frames: those calls return in-process before invocation identity is minted, so no ledger row can ever show them. They are recorded instead by the stdio proxy into a separate bounded attempt store (`unit: proxy-attempt`), whose directory comes only from `ANTIFAN_PROXY_TELEMETRY_DIR` — no default and no plausible-path fallback. **The proxy owns that store, so the proxy owns its reader:** the canonical surface is `node scripts/antifan-omp-mcp.cjs --core-attempts [--json] [--dir <store>]` (never an advertised MCP tool — it does not start the stdio server), and the accounting CLI's `--core-attempts` is a facade that spawns exactly that command. Use the proxy command directly when only the attempt store matters; use the facade when one store root should drive both surfaces.

The store is bounded by two environment knobs, both clamped so they can tune the bound but never disable it:

| Variable | Default | Clamp | Effect |
|---|---|---|---|
| `ANTIFAN_PROXY_TELEMETRY_MAX_BYTES` | `262144` (256 KiB) | minimum `4096` | bytes per attempt file before rotation |
| `ANTIFAN_PROXY_TELEMETRY_RETAINED_FILES` | `5` | minimum `1`, maximum `64` | rotated files kept by the ring |

A byte cap alone would mint files without limit, which is the uncapped pattern the ring exists to stop, so the two bounds are declared together in `scripts/antifan-omp-mcp.cjs` (`coreAttemptLimits`), read once per process and overridable within the clamps. The ring is **directory-wide and covers rotated files only**: a proxy's own active file is not a rotation candidate and another pid's active file is never pruned (the per-pid name separates two proxies, it is not a rotation slot), so the retained count is applied to the rotated set sorted oldest-first by `(mtime, name)`. A value that does not parse as a finite integer falls back to the **default** rather than becoming `NaN` — a `NaN` cap would make every size comparison false, i.e. silently unbounded — and `0` clamps up to `1`, so the ring cannot be switched off by configuration. `0` attempts means **not yet instrumented**, never "unused", and because unknown-capability and abandoned calls are attempts too, any rate derived from this store is a pessimistic bound.

The attempt store's directory precedence lives in the proxy and nowhere else: explicit `--dir`, then `ANTIFAN_PROXY_TELEMETRY_DIR`, then `UNMEASURED` / `NO_STORE_DIR` with `storePath: null`. The proxy never creates a directory and never guesses a path, and the accounting CLI's facade passes `--dir` explicitly whenever it resolved a root, so this precedence is not duplicated.

The declared launch-path table lives in `scripts/antifan-omp-mcp.cjs` (`CORE_ATTEMPT_LAUNCH_PATHS`) and in the Hub's labelled hole (`MCP_DISPATCH_CORE_HOLE_LAUNCH_PATHS` in `src/renderer/toolbar.ts`); below is the operator-facing copy. The wording matters: "cannot carry" here always means **no injector at that entry point**, not "the variable can never reach that path".

| Launch path | Injector present | Why |
|---|---|---|
| `scripts/antifan-agent.cjs` (bridge `antifan.cli.startSession` response `proxyTelemetryDir` → `childEnv` → `spawnAgentChild`) | yes | the only injector; the value then reaches the agent's whole subtree |
| `package.json` bin `antifan-mcp` (`./scripts/antifan-omp-mcp.cjs`) | no | no injector at this entry point; it inherits a value only from a parent tree launched by `scripts/antifan-agent.cjs` |
| `package.json` script `mcp` (`node scripts/antifan-omp-mcp.cjs`) | no | same proxy, same missing injector |
| Codex (`~/.codex/config.toml`) | no | no AntiFan MCP server is registered, and its child environment mirrors the Electron main process, which never holds the key |
| `scripts/generate-mcp-capability-map.mjs` | no | spawns the proxy with the inherited environment (`...process.env`); inherits a value only from an injected parent tree |

Three limits are stated rather than implied.

First, the injector's `childEnv` spreads the sanitized parent environment and this key is **not** scrubbed the way the bridge token is, so a caller that pre-sets the key injects it everywhere, and a proxy that the **agent** spawns by any means inherits it — the value reaches the agent's whole subtree, which is a limitation of this instrumentation rather than a guarantee.

Second, a launch path with no records means **not instrumented**, never "called nothing": coverage is disclosed per path, and the store's own `instrumentedSince` field says when instrumentation began (it reads `(none)` until the first record is written).

Third, the wrap point is **not the only place a `core.*` call can end**. `invoke()` refuses before the wrap in two further classes — the session tool-surface policy (`REFUSED_TOOL_SURFACE`: a capability forbidden for the session) and the advertised required-field contract (`INVALID_ARGUMENT`: a tool whose schema declares required fields, e.g. `core.record_observation` without `source`/`kind`, supplies no usable value for one of them). Those calls are neither dispatches nor attempts, so **the attempt store undercounts `core.*` calls by exactly those two classes**. This is why a zero must never be read alone: "0 attempts" for a tool that is in fact being refused before the wrap looks exactly like "not instrumented", and the two states call for completely different responses — the first is a policy doing its job on a tool that needs a different argument or a different session, the second is a coverage hole that needs the instrumentation path fixed. Read `instrumentedSince` and the launch-path column before drawing a conclusion from any zero.

This section is scoped to MCP dispatch accounting and the proxy attempt store.

---

## Agent-facing call contracts (remediation soak)

Landed by `plans/260917-1821-antifan-consolidated-remediation-soak`. Every statement below
describes the path an agent actually uses (stdio proxy -> bridge -> capability) and the live
evidence that proves it.

### Tab listing

- `anti.browser.tabs.list` on a bound session returns the **window strip annotated with the bound
  identity**: exactly one row carries `isBoundTab: true` (and `isPrimaryTab: true`), and that id
  equals the id the same session sees under the session scope. An offscreen/ephemeral tab the agent
  plane created is unioned into the strip when the window does not render it, so the bound row is
  never missing.
- `scope: 'session'` returns only the tabs that session owns; a session that owns nothing lists
  nothing rather than leaking the user's strip.

### Admission budget and tab quota

- `VIEWPORT_GATE_ADMISSION_BUDGET_MS` (30 s) is the default admission budget for the viewport gate
  (`withLock`). It is deliberately the inner bound of the dispatch policy ceiling, so a queued
  admission cannot outlive the policy that admitted it.
- `SESSION_TAB_LIMIT` (10) bounds the tabs one session may own. The refusal is `POLICY_DENIED`
  carrying `used`/`limit`/`countedTabIds` (a bounded sample), and its message names a **browser**
  tab, never a terminal tab.

### Capture truth

- A capture that freezes media attaches the freeze measurement to its envelope: the classification
  reports per-class counts, and the receipt carries the capture policy identity
  (`capture-freeze-classes-v1`) plus `isMediaFrozen` at raster time. A baseline captured before that
  policy is **not comparable** with one captured after it, by design.
- A failed capture returns a diagnosis whose remedy names the dominant animation class
  (`Animation` -> WAAPI, `CSSAnimation` -> CSS), so the repair is not guessed.

### Core Health

- The Hub's usage line comes from `stats.mcpDispatchCalls` plus a non-gating `mcp.dispatch` check,
  both read from the **ledger aggregate** (`accounting:mcp-dispatch`) and never from a client-side
  tally. The MCP tool `core.health` returns the store payload and therefore does not carry that
  line; the per-name breakdown is the Hub's MCP Dispatch tab.
- `reasonCode` joins **every** failed gate, and `checks[].gating` marks which checks are allowed to
  decide the aggregate status — a reported fact (usage, knowledge gaps, connected count) can no
  longer cap the panel below `HEALTHY`.
- The dispatch reader resolves its store from `--store` or `ANTIFAN_DATA_ROOT` only. Run with
  neither it reports `UNMEASURED` / `NO_DATA_ROOT_RESOLVED` by design, so a bare
  `npm run accounting:mcp-dispatch` proves the gates but measures nothing: pass the root to read
  per-name call counts.

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
- **Device identity**: measured on this workstation, Apple's Windows usbmuxd answers `ListDevices` with
  the device number and serial only. The name, `ProductType` and iOS version therefore come from the
  device's own **lockdownd** (`GetValue` on port 62078, no pairing session, no elevation), cached per
  attachment. When a device does not report a fact it is reported as absent — never as a placeholder
  like `iPhone` / `unknown`, and the UI panel prints "Chưa xác định" for it. Raw `ProductType`
  (`iPhone14,5`) is what the device said; a marketing name is not invented from it.
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
- `device.type` reads the active element first, and WebDriverAgent answers 404 for two different
  conditions. Its message decides which: one naming the session (`invalid session`, `no such session`)
  is a dead session (`DEVICE_SESSION_FAILED`, rebindable with `device.open_safari`), while everything
  else — `no such element` when nothing editable is focused — stays
  `DEVICE_OPERATION_UNSUPPORTED` and tells the caller to tap the input first. Both messages carry what
  WebDriverAgent actually said.

### Failure codes

Every device failure carries a code plus an operator action: `DEVICE_TRANSPORT_UNREACHABLE`,
`DEVICE_NOT_CONNECTED`, `DEVICE_NOT_TRUSTED`, `DEVICE_DEVELOPER_MODE_REQUIRED`,
`DEVICE_UI_AUTOMATION_REQUIRED`, `DEVICE_WDA_NOT_READY`, `DEVICE_SESSION_FAILED`,
`DEVICE_OPERATION_UNSUPPORTED`, `DEVICE_TARGET_STALE`. `DEVICE_TARGET_STALE` distinguishes an
attachment change (`deviceEpoch`) from a recreated session (`sessionGeneration`); both are rebindable
from a fresh `device.status`.

### Toolbar surface

The toolbar's phone chip (`#btnPhoneStatus`) is an independent surface from the device-presets picker:
it reports the **physical** phone, not the emulated viewport, and it is pushed from the main process
(`antifan:toolbar:phone-status`) plus polled every 10s and on window focus.

- Silent on a host that never had a phone attached. An unanswered usbmuxd is indistinguishable from an
  absent phone, so the amber "Muxer Offline" chip only appears once this renderer session has actually
  observed an attachment — otherwise the feature would be a permanent false alarm for anyone who does
  not use it.
- Device-supplied strings are escaped before they reach the panel; they are data, not markup.
- Disconnecting re-renders the open panel instead of leaving it claiming a connected phone, and Escape
  closes it. Closing the panel does not collapse the popped-out toolbar if another overlay owns it.

### Background usbmuxd (Windows startup)

`scripts/start-itunes-hidden.vbs` → `scripts/start-itunes-background.ps1` is wired into the user's
Startup folder (`AntiFan-iTunes-Background.lnk`) so the usbmuxd endpoint exists after logon without a
window. The script is a launcher, not a service, and it holds to a bounded contract:

- idempotent — exits `0` immediately when `tcp:27015` is already served (verified live: it prints
  "already listening … nothing to do" and touches no process);
- bounded — at most 20s waiting for the port, then at most 20s for a window to hide;
- scoped — it hides **only** the window of the iTunes process it started. iTunes is single-instance, so
  when it is already running the script only waits and never hides the user's window. The owner is
  identified by **PID set difference** (the newest iTunes PID that did not exist before this script ran),
  not by the handle returned from a protocol launch: for the Store/MSIX package that handle can be the
  activation broker or an already-exited process. Resolution happens **after** the port opens, and if the
  tracked PID turns out to be dead the loop adopts the new PID instead of giving up — a cold start takes
  seconds to show a window, and that is precisely when a visible iTunes window would appear. A
  pre-existing instance is never a candidate;
- honest — exit `1` plus a warning when the port never opened. Nothing is reported as successful on a
  timeout, and failures are not swallowed by a global `SilentlyContinue`.

**Verification status (honest):** the idempotent path is verified live (it exits `0`, prints
"already listening … nothing to do" and touches no process) and the script parses with zero errors under
the language parser. The **launch-and-hide path cannot be verified from this session** — it needs a boot
with nothing listening on `tcp:27015`, and the machine already has usbmuxd up from the user's running
iTunes; stopping that process is the user's call. Treat the cold-start hide as designed-but-unproven
until a re-logon (or a manual run with iTunes closed) shows it, and read the printed PID line as the
evidence when it does.

Run it manually with
`powershell -NoProfile -ExecutionPolicy Bypass -File scripts/start-itunes-background.ps1`.
To disable it, delete the `AntiFan-iTunes-Background.lnk` shortcut from the Startup folder.

### Verification

```bash
# Control plane → capability family → adapter, against a WebDriverAgent-contract fixture (no phone needed)
npm run smoke:device

# Toolbar phone chip + panel in real Electron WebContents (synthetic status payloads)
npm run smoke:phone-ui
```

The fixture speaks the exact WebDriverAgent routes and payload shapes taken from its source, so policy
freeze, device authorization, session generations, artifact staging and request wire format are all
exercised for real; only the USB socket itself needs hardware. It also drives the live discovery path
(no injected enumerator), so a host with no Apple Mobile Device Support must report
`DEVICE_TRANSPORT_UNREACHABLE` with the fix attached instead of a raw socket error, and it asserts the
lifecycle contracts directly: a re-plug on the same UDID advances the attachment epoch and clears the
session the retired attachment owned, a pre-re-plug binding is refused rather than driven, and a client
that resets during the usbmux handshake is accounted for instead of taking the process down (the pre-fix
shape crashes with an unhandled `ECONNRESET` on the accepted socket — reproduced by reverting the guard
placement in the compiled module).

`smoke:phone-ui` mounts the real `toolbar.html` with the real preload and asserts the panel's
truthfulness contracts: quiet on a phone-less host, device facts only (no invented model code), escaped
device strings, no stale "connected" content after a disconnect, and Escape closing the panel. Its
status payloads are **synthetic** renderer fixtures, not hardware evidence.

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

That bridge is pinned to **one** `deviceNumber`, because that is what its open sockets carry. A cached
bridge is reused only while its own device is still attached and still answers there, and only for a
request naming that same device: on a host with two phones, asking about the other one drops the bridge
and rebuilds it rather than answering with the wrong phone's screen and status.

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
| `ios webinspector cdp` | bridges CDP and answers real queries (`Runtime.evaluate` returned the same live viewport numbers, so two independent transports agree). The server binds **loopback only** (`addr 127.0.0.1:9222` in its log, confirmed with `netstat`), so it is not LAN-reachable. Two traps: `--port` did **not** move the listener in any measured run — `--port 9444` and `--port=9444` both reported `127.0.0.1:9222` (and die with `bind: Only one usage of each socket address` when the user's Chrome owns 9222), while `--port=9446` printed no address line at all — so do not rely on it, and use `js-shell` when 9222 is taken; and pass `--udid=<udid>` because every invocation logged *"no udid specified using first device in list"*, which matters once a replug leaves several entries. WebKit's bridge implements no `Input` domain and no `Page.captureScreenshot`: page-level screenshots and injection are not available through it |
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
  device failure is the cable or the phone. Provenance of the tested build, for anyone repeating this:
  `3uTools_v9.08.006_Setup_x64.exe` from `dl.3u.com` (197845832 bytes, SHA-256
  `e00d0661920cdeac91901b7b12c03c3411c1ff4faf9f8f167231ec46d642370e`) carries a **valid** Authenticode
  signature from `CN="Shenzhen Aidapu Network Technology Co., Ltd."` (GlobalSign), installs to
  `C:\Program Files\3uTools9` and uninstalls through `C:\Program Files\3uTools9\Uninstall.exe`. The
  installer ignored its `/log` argument when launched through `Start-Process -Verb RunAs`, so no install
  log exists; do not expect one. Detection in the GUI is **not** evidence that our path works — 3uTools
  uses its own device stack, so check the 27015 listener plus `ios list`.
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
- **3uTools IPA signing is non-recursive and omits PlugIns, causing XCTest Error 103 / AMFI library validation failure.**
  3uTools' built-in signer only codesigns the root executable (`WebDriverAgentRunner-Runner.app/WebDriverAgentRunner-Runner`).
  It leaves `PlugIns/WebDriverAgentRunner.xctest/WebDriverAgentRunner` and `Frameworks/WebDriverAgentLib.framework` completely
  unsigned. When `testmanagerd` launches the runner, the iOS kernel's AppleMobileFileIntegrity (AMFI) rejects the plugin:
  `Library Validation failed: Rejecting '.../WebDriverAgentRunner' ... reason: mapped file has no cdhash, completely unsigned?`
  and aborts with `Failed to load the test bundle (Error code: 103, Domain: com.apple.XCTestErrorDomain)`.
  **Fix:** Extract the private key generated by 3uTools at `C:\ProgramData\3u\3utools\ipasign\cnf\pri.pem`, extract the certificate
  from `embedded.mobileprovision` under `DeveloperCertificates`, and use `zsign.exe` to recursively re-sign all frameworks,
  dylibs, and `.xctest` bundles before installing via `ios install`.

### Verified hardware execution runbook (iPhone 13, iOS 26.5.2)

1. **Tunnel:** `ios tunnel start --userspace` (negotiates RSD tunnel over usbmuxd without elevation).
2. **Signing:** Use `zsign` with the private key and provisioning profile to recursively sign WebDriverAgent:
   ```bash
   zsign.exe -k pri.pem -c cert.pem -m embedded.mobileprovision \
     -b com.facebook.WebDriverAgentRunner.xctrunner.<suffix> \
     -n "WebDriverAgentRunner-Runner" -o signed.ipa unsigned.ipa
   ```
3. **Install:** `ios install --path=signed.ipa` (transfers and installs via `zipconduit`).
4. **Trust:** On iPhone: Settings > General > VPN & Device Management > Trust developer profile.
5. **Start WDA Runner:**
   ```bash
   ios runwda --bundleid=com.facebook.WebDriverAgentRunner.xctrunner.<suffix> \
     --testrunnerbundleid=com.facebook.WebDriverAgentRunner.xctrunner.<suffix> \
     --xctestconfig=WebDriverAgentRunner.xctest
   ```
6. **Probe Hardware (Phase 0 gate):**
   ```bash
   npm run probe:device -- --forward 8100 --touch
   ```
   Returns `VERDICT: GO` (exit 0), confirming USB presence, usbmuxd listener, lockdown info, in-process port forward, WDA /status, screen metrics (`390x844 scale=3`), W3C Safari session creation, navigation to `https://example.com`, render settle, 1170x2532 screenshot capture, and a W3C pointer touch gesture at (195, 295).

7. **Adapter Interactive Verification:**
   Driving the live `IosDeviceAdapter` against the running WDA runner verified user-observable actions:
   - `device.tap`: Tapping the "Learn more" link on `example.com` triggered live navigation to `iana.org` (99.43% pixel delta); tapping `MoreMenuButton` at (332, 786) popped up Safari's native iOS action sheet.
   - `device.swipe`: Scrolling down 400 pt on the IANA page produced a 99.54% pixel delta with native device momentum.
   - `device.type`: `typeLocked` dynamically resolved the focused input via `GET /element/active` and typed `"AntiFan"` in 727 ms, visually confirmed in the search input and suggestion list.

### Path to the deferred inspection milestone

The forwarding facts above do not depend on Appium, and neither does inspection: go-ios 1.3.2 ships
`webinspector list|cdp|eval|js-shell|launch`, which bridges Safari's Remote Automation to CDP over the
same tunnel. That is a concrete vendor path for the `webInspector` / `remoteAutomation` gates that
currently report `unknown`, and it is why those gates were left tri-state instead of hard-coded false.