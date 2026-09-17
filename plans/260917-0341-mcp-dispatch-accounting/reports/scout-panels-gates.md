# Scout Report — Phases 5, 6, 7 (self-report panel, `core.*` proxy emitter, gates/docs/follow-up)

Scope: read-only scout of `E:\Work\apps\AntiFan` for plan `plans/260917-0341-mcp-dispatch-accounting`.
Method: file reads + read-only listings/`Select-String` on this machine, 2026-09-17. No file was modified except this report.
Labels: **OBSERVED** = read or measured in this session; **DERIVED** = inference from observed code; **ASSUMED** = unverified.
Phase files `phase-05-self-report-panel.md`, `phase-06-core-proxy-emitter.md`, `phase-07-gates-docs-and-followup.md` are 29-line stubs (skeleton headings only) — nothing to reconcile against.

---

## 1. `gaps.jsonl` writer contract

### 1.1 Writer and path resolution
- Writer: `src/main/telemetry/fallback-recorder.ts` (160 lines). **OBSERVED**
- Path function: `getTelemetryLogPath(baseDir = process.cwd())` → `path.join(baseDir, '.antifan', 'telemetry', 'gaps.jsonl')` — `fallback-recorder.ts:122-124`. **OBSERVED**
- Sole production call site: `execute: async (params, context) => recordFallbackTelemetry(params, getWorkspaceRoot ? getWorkspaceRoot() : undefined)` — `src/main/tools/browser-capabilities.ts:968`. Import at `browser-capabilities.ts:13`. **OBSERVED**
- Parameter is injected at `browser-capabilities.ts:259` (signature) and bound at `src/main/control-plane/control-plane-runtime.ts:310`: `registerBrowserCapabilities(this.capabilities, browser, this.themeQaWorkflow, () => this.getWorkspaceRoot(), this.receipts)`. **OBSERVED**
- Registered MCP name: `anti.telemetry.record_fallback` — `browser-capabilities.ts:948-969` (`policy: idempotent-write`, `lane: unbounded`, `required: ['primaryTool','fallbackTool','fallbackResult']` at `:966`). Advertised in `scripts/antifan-omp-mcp.cjs:59`. **OBSERVED**
- Second (non-load-bearing) caller: `src/main/mcp/mcp-server.ts:18` imports the recorder; tool declared at `:459-460`. **OBSERVED**

### 1.2 How the workspace root is actually determined
`ControlPlaneRuntime.getWorkspaceRoot()` — `src/main/control-plane/control-plane-runtime.ts:248-291`:
1. `workspaceId = this.leaseState.workspaceId || ''` (`:249`); memo cache on key `${workspaceId}|${this.workspaceRoot}` (`:252-255`, invalidation at `:292-296`). **OBSERVED**
2. Registry path: `this.workspaces.get(workspaceId, leaseState.projectId)` accepted only if `rootPath` is a non-empty string, `!== dataRoot`, `!== path.resolve(dataRoot,'..')`, and `fs.existsSync` (`:262-271`). **OBSERVED**
3. Env fallback only when the registry did not supply a root AND the configured root is empty/data-root/data-parent: `process.env.THEME_WORKSPACE_ROOT || process.env.ANTIFAN_WORKSPACE_ROOT || process.env.WORKSPACE_ROOT` (`:276`), same two exclusions (`:279-283`). **OBSERVED**
4. **Unbound ⇒ `''` (empty string), not `undefined`** — constructor init `resolveInitialWorkspaceRoot()` returns `''` with the comment "unbound root remains empty" (`:148-149`); the same `resolved = ''` assignment appears at `:282` and `:285`. **OBSERVED**

**Load-bearing consequence (DERIVED, high confidence):** `browser-capabilities.ts:968` therefore passes `''`, and JS default parameters substitute only for `undefined` — so `baseDir` stays `''` and `path.join('', '.antifan','telemetry','gaps.jsonl')` collapses to the **relative** path `.antifan\telemetry\gaps.jsonl` (verified: `node -e` on this host printed `".antifan\\telemetry\\gaps.jsonl"`), which `fs.appendFileSync` resolves against `process.cwd()`. The `: undefined` branch at `:968` is unreachable from the real runtime because the binding at `control-plane-runtime.ts:310` is an arrow function that never returns `undefined`.

### 1.3 Exact record shape
`SanitizedTelemetryRecord` — `fallback-recorder.ts:17-20`, built at `:103-120`. **OBSERVED**

| Field | Rule | Anchor |
|---|---|---|
| `timestamp` | `new Date().toISOString()`, always present | `:105` |
| `contextMode` | literal `'STANDALONE_PLAYWRIGHT_DIAGNOSTIC_PROBE'`, always present | `:19, :106` |
| `primaryTool` | `sanitizeString(...,128)`, required, non-empty | `:112` |
| `fallbackTool` | `sanitizeString(...,128)`, required, non-empty | `:115` |
| `fallbackResult` | enum `SUCCESS\|FAILED\|SKIPPED`, required | `:24-25, :116` |
| `sessionId` | `<=128`, `undefined` when unsupplied | `:107` |
| `targetUrl` | `sanitizeTargetUrl` (userinfo stripped, 10 sensitive query keys → `[REDACTED]`, keys at `:23`) or `undefined` | `:74-93, :108` |
| `errorCode` | `<=64` or `undefined` | `:113` |
| `errorMessage` | `<=1024` or `undefined` | `:114` |
| `durationMs` | finite `>=0` number or `undefined` | `:117` |
| `notes` | `<=1024` or `undefined` | `:118` |

Optional fields are **absent**, never substituted (`:109-111` comment + test `src/main/telemetry/fallback-recorder.test.ts:107-116`). Measured on the live store: exactly these 11 keys across all 405 records, no others. **OBSERVED**

### 1.4 The 43-72 refusal-over-substitution incident (anti-fabrication rationale)
Measured on the live bridge, documented at `fallback-recorder.ts:43-72`: calling `anti.telemetry.record_fallback` **with no arguments at all** returned `{"recorded":true,...}` and appended a line to `gaps.jsonl`, because the sanitizer substituted `'unknown'`, `'browser_*'` and `'FAILED'` for the three fields the advertised schema marks required. An empty call therefore produced a record indistinguishable from a real fallback event, so the ledger could not be trusted as evidence; the fix refuses before any filesystem work (`assertRecordableFallbackPayload` `:53-72`, invoked first at `:130-132`) and collects every missing field into one refusal (`:58-71`).
Corroboration: `docs/mcp-advertised-schema-enforcement.md:44` (measured fabrication) and `:57-61` (the boundary rule); test `src/main/telemetry/fallback-recorder.test.ts:38-53` asserts the zero-argument call throws `INVALID_ARGUMENT` and creates no file.
**Forensic residue still in the live store (OBSERVED):** 4 of the 405 records carry `primaryTool: "unknown"` + `fallbackTool: "browser_*"` + `fallbackResult: "FAILED"` — pre-fix fabrications. A Phase 5 reader must classify, not silently drop or count as measured.

### 1.5 Rotation / bounding that exists TODAY
- `MAX_LOG_SIZE_BYTES = 10 * 1024 * 1024` — `fallback-recorder.ts:22`. **OBSERVED**
- Check + rename: if `statSync(logPath).size >= MAX_LOG_SIZE_BYTES`, `fs.renameSync(logPath, path.join(logDir, \`gaps-${Date.now()}.jsonl\`))` — `:143-149`. **OBSERVED**
- Then `fs.appendFileSync(logPath, JSON.stringify(record)+'\n','utf8')` — `:152-153`. **OBSERVED**
- No other bounding exists: no cap on the number of rotated files, no pruning, no time-based rotation, no reader of rotated files anywhere in the repo. **OBSERVED**
- Directory is created on demand (`:138-140`). Filesystem failures are swallowed and reported as `{recorded:false}` with the intended path (`:156-159`) — a reader must not read absence-of-file as "zero events" when a write was refused. **OBSERVED**

### 1.6 Schema version field
**None exists.** No `schemaVersion` / `version` / `v` key in the interface (`:17-20`), the record builder (`:103-120`), or any of the 405 on-disk records. `contextMode` is a fixed literal, not a version discriminator. **OBSERVED** → a reader must be tolerant by key presence; adding a version field is a Phase 5 decision that must not break the existing writer contract or `fallback-recorder.test.ts:82-138`.

---

## 2. Where rotated / other telemetry files live (measured on this machine)

| Absolute path | Size | Lines | mtime | Note |
|---|---|---|---|---|
| `E:\Work\apps\AntiFan\.antifan\telemetry\gaps.jsonl` | 89,379 B | 405 | 2026-09-17 09:56:27 | the live repo-root store; **no** `gaps-<ts>.jsonl` exists alongside it. **OBSERVED** |
| `E:\Work\.antifan-data\.antifan\telemetry\gaps.jsonl` | 1,107 B | 2 | 2026-09-10 16:24:52 | second store, produced by a run whose cwd/passed baseDir was the app data root. Records cite real incidents (`TARGET_STALE` "ViewportGate is poisoned…", `MCP_TIMEOUT` "Request timeout after 30000ms"). **OBSERVED** |

- Only those two `gaps*.jsonl` files exist on the Work tree: a recursive `-Filter gaps*.jsonl` over the app root plus `E:\Work\.antifan-data`, `-soak`, `-canary`, `-probe`, `-acl-fixed-smoke`, `E:\Work\antifan-canary`, `-conpty-ui-check` returned exactly those two. **OBSERVED**
- 25 further `.antifan` directories exist (`E:\Work\apps\{F1GENZ Guarantee,F1GENZ Multiform,F1GENZ MultiLanguage,F1GENZ_Review,Haravan CLI,Sapo CLI}\.antifan`, `E:\Work\customizes\*\ .antifan`) — none contains a `telemetry/` subdirectory. **OBSERVED**
- **Exact glob a rotation-aware reader must use:** `path.join(resolvedRoot, '.antifan', 'telemetry', 'gaps*.jsonl')`. That is exactly the two shapes the writer can produce — `gaps.jsonl` (`fallback-recorder.ts:123`) and `gaps-<Date.now()>.jsonl` (`:146`). Broadening it (e.g. `**/*.jsonl` under `.antifan`) would sweep unrelated stores; narrowing it to one path loses records after rotation. **DERIVED from OBSERVED writer code**
- Ordering: with no rotated file on disk to observe, ordering must key on mtime or the record's `timestamp`, not on filename (`.` sorts before `-`, and `Date.now()` suffixes only sort lexicographically while the digit count is stable). **ASSUMED**
- Two roots can be live at the same time (both files above exist). The panel must disclose **every** absolute path read and must not merge them into one total. **DERIVED**

---

## 3. Proxy bootstrap channel

### 3.1 How the proxy is launched (measured on this machine)
Live MCP client config `C:\Users\Admin\.omp\agent\mcp.json`: `mcpServers["antifan-browser"] = { type: "stdio", command: "node", args: ["E:/Work/apps/AntiFan/scripts/antifan-agent.cjs","mcp"], cwd: "E:/Work/apps/AntiFan", timeout: 300000 }`. **OBSERVED**
→ `scripts/antifan-agent.cjs` routes the alias to the proxy: `resolveAgentCommand` returns `{command: process.execPath, commandArgs: [path.resolve(scriptsDir,'antifan-omp-mcp.cjs'), ...restArgs]}` for `mcp|mcp-server|stdio|omp-mcp` (`scripts/antifan-agent.cjs:843-848`), spawned at `:798` via `spawnAgentChild` (`:881+`). **OBSERVED**
Other spawn sites (all in-repo harnesses, not the app): `scripts/theme-harness/mcp-client.mjs:83`, `scripts/lib/antifan-mcp-client.mjs:37`, `scripts/test-antifan-mcp-client.mjs:31`, `scripts/generate-mcp-capability-map.mjs:30`, `scripts/smoke-theme-golden-live.cjs:311`, `scripts/smoke-omp-closed-loop.cjs:254`, `scripts/smoke-mcp-industrial-e2e.cjs:230`. **OBSERVED**
`~/.codex/config.toml` has **no** antifan MCP server (`[mcp_servers]` at `:22` lists playwright, ccs-websearch, ccs-image-analysis, stitch, figma, figma-desktop, node_repl only). **OBSERVED** → the env injected by `src/main/agent/codex-execution-backend.ts:81-100` currently reaches **no** AntiFan proxy.
No app-side spawn of the OMP client exists in `src` (grep `oh-my-pi|omp` → no matches). **OBSERVED**

### 3.2 Exact env vars in that channel (complete, from a full `process.env.` scan of the proxy)
`ANTIFAN_MCP_BOOTSTRAP` (`:164,166,249,251,1963`), `ANTIFAN_ATTACHMENT_SECRET` (`:170,176,177,265,271`), `ANTIFAN_MCP_PORT` (`:171,270`), `ANTIFAN_HOST` (`:175`), `ANTIFAN_RUN_ID` (`:178,275`), `ANTIFAN_ATTEMPT_ID` (`:179,276`), `ANTIFAN_PROJECT_ID` (`:180,277`), `ANTIFAN_WORKSPACE_ID` (`:181,278`), `ANTIFAN_ATTACHMENT_ID` (`:272`), `ANTIFAN_BOUND_TAB_ID` (`:257,273,1251,1569,1609,1612`), `ANTIFAN_OWNER_PID` (`:259,279`), `ANTIFAN_AUTHORITY_REVISION` (`:266-267,274`), `ANTIFAN_TERMINAL_AFFINITY_SESSION_ID|ANTIFAN_TERMINAL_PARENT_SESSION_ID|ANTIFAN_TERMINAL_SESSION_ID|ANTIFAN_BRIDGE_PID` (`:216-219`), `ANTIFAN_TERMINAL_AFFINITY_GENERATION|ANTIFAN_TERMINAL_GENERATION` (`:1322`), `ANTIFAN_FIXER_SESSION` (`:544-545`), `ANTIFAN_SESSION_GRANT` (`:562-563`), `ANTIFAN_ALLOWED_CAPABILITIES|ANTIFAN_ALLOWED_CAPABILITY_NAMES` (`:576-577`), `ANTIFAN_FORBIDDEN_CAPABILITIES|ANTIFAN_FORBIDDEN_CAPABILITY_NAMES` (`:592-593`), `ANTIFAN_HEARTBEAT_MS` (`:1810`), `SUPER_CORE_DB` (`:451`). **OBSERVED**

### 3.3 Where the app constructs the env object
- `scripts/antifan-agent.cjs:761-793` — `childEnv`: spreads `sanitizedParentEnv` (`:756`, with bridge token/port/host deleted `:757-759`) and adds the ANTIFAN_* keys; `ANTIFAN_MCP_BOOTSTRAP` JSON at `:773-788`. This is the env object the proxy actually inherits today. **OBSERVED**
- `src/main/agent/codex-execution-backend.ts:81-100` — `childEnv` for the spawned `codex exec` (`spawn` at `:101`); `ANTIFAN_MCP_BOOTSTRAP` JSON at `:90-99`, `port: process.env.ANTIFAN_BRIDGE_PORT || process.env.ANTIFAN_MCP_PORT` at `:91`. Only occurrence of `ANTIFAN_MCP_BOOTSTRAP` in `src/`. **OBSERVED**
- `scripts/theme-harness/mcp-client.mjs:67-81` — harness env (deletes foreign bootstrap `:72-74`, sets its own `:75-80`). **OBSERVED**

### 3.4 What happens when a variable is missing
Fail-closed for bootstrap: `resolveBridgeCandidates()` returns `[]` (`:186-188`); `getBootstrap()` returns `null` (`:282`); a non-`core.*` `invoke` autoheals then throws `MCP_CONTEXT_REQUIRED` with `MCP_BRIDGE_OFFLINE` written to stderr (`:1538-1550`); an interactive no-bootstrap launch writes `MCP_BRIDGE_OFFLINE: AntiFan Desktop Bridge is not running.` and `process.exit(1)` (`:1963-1968`). **OBSERVED**
**Critical exception:** `core.*` is dispatched **before** that gate — `invoke` resolves `CAPABILITY_MAP` then `if (mappedEarly.startsWith('core.')) return invokeCore(mappedEarly, params)` (`:1533-1536`), ahead of the bootstrap check at `:1538`. So a bare `node scripts/antifan-omp-mcp.cjs` with **zero** env still serves all 51 `core.*` tools. **OBSERVED**

### 3.5 Does a data-root-like variable already exist in this channel?
**No.** There is no workspace-root, data-root, or telemetry-path variable in the app→proxy channel. The only path-like variable is `SUPER_CORE_DB` (`:451`) and it **defaults** to `<repo>/.super-core/core.db` (`:452`) — the exact defaulting pattern Phase 6 forbids. **OBSERVED**
→ The plan **must add** a variable. Findings the planner needs to scope it:
- The app-side handshake that the launcher already consumes is `antifan.cli.startSession` (`scripts/antifan-agent.cjs:515`), whose response is built at `src/main/bridge/bridge-server.ts:2156-2173` and carries `runId, attemptId, attachmentId, secret, projectId, workspaceId, tabId, authorityRevision, host, port, expiresAt, allowedCapabilityNames, forbiddenCapabilityNames, runtimePid` — **no filesystem path**. The bridge process owns the workspace root (`ControlPlaneRuntime.getWorkspaceRoot()`), so adding e.g. `workspaceRoot: this.controlPlaneRuntime.getWorkspaceRoot()` to that response object is the one app-side injection point that reaches the proxy through `antifan-agent.cjs:761-793`. **DERIVED from OBSERVED code**
- `scripts/antifan-agent.cjs:76` already reads `process.env.ANTIFAN_DATA_ROOT` for config discovery, so a client-provided data root is a plausible alternative carrier. **OBSERVED**
- Without one of those, the emitter's honest state is `proxyTelemetryUnavailable` (plan.md:59, :149) — never a guessed path. **OBSERVED (plan text)**

---

## 4. Proxy structure for an emitter

### 4.1 Request path (exact ranges, `scripts/antifan-omp-mcp.cjs`, 2008 lines)
- `server.setRequestHandler(CallToolRequestSchema, …)` — `:1836-1931`. `callerRequestId` derived from MCP `extra.requestId` at `:1839-1841`; `invoke(request.params.name, request.params.arguments || {}, callerRequestId)` at `:1842`; every thrown error becomes `{isError:true, content:[{type:'text', text:err.message}]}` at `:1928-1930`. **OBSERVED**
- `async function invoke(method, params, callerRequestId)` — `:1505-1676`: tool-surface refusal `:1506-1512`; advertised-required-field enforcement `:1513-1529`; `const mappedEarly = CAPABILITY_MAP[method] || method` `:1533`; **`if (mappedEarly.startsWith('core.')) return invokeCore(mappedEarly, params);` `:1534-1535`**; bootstrap get/autoheal `:1537-1551`; `const mapped = CAPABILITY_MAP[method] || method` `:1553`; `const identity = resolveInvocationIdentity(callerRequestId, params)` **`:1561`** (mints `req-mcp-*`/`idem-mcp-*` or UUIDs, `:704-715`); transport-arg stripping `:1565-1568`; `sendDispatch` WS frame `:1583-1650`; retry policy `:1652-1675`. **OBSERVED**
- `async function invokeCore(method, params)` — `:522-542` → `getCore()` `:449-460` (requires `../packages/super-core/dist/index.js`, `SUPER_CORE_DB` override, returns `null` on failure) → `CORE_DISPATCH` table `:468-521` (51 entries, `[storeMethod, adapt, mutating]`) → `core[storeMethod](...adapt(params||{}))` `:541`; unavailable store returns `{available:false,...}` for advisory calls (`:534`) or throws `CORE_UNAVAILABLE` for mutating ones (`:531-533`). **OBSERVED**
- Exports the gate depends on: `definitions, CAPABILITY_MAP, CORE_DISPATCH, invoke, invokeCore, DEFAULT_CLIENT_TIMEOUT_MS` — `:1979-1988`; `DEFAULT_CLIENT_TIMEOUT_MS = 240000` at `:662`. **OBSERVED**

### 4.2 Where a non-throwing, bounded emitter can be inserted with least risk
**Recommended: wrap the early return at `:1533-1536`.** Structure: resolve `mappedEarly`; capture `const t0 = Date.now()`; `let outcome; let errorCode;` `try { outcome = invokeCore(mappedEarly, params); } catch (e) { errorCode = …; throw e; } finally { emitCoreAttempt({method: mappedEarly, t0, outcome|errorCode, ok: !errorCode}) }` with `emitCoreAttempt` fully self-contained in `try/catch`. Rationale (DERIVED): it is the single choke point for all 51 `core.*` tools, it is before the bootstrap gate so it works for every launch mode, and it does not touch the bridge dispatch path used by Phases 1-4. Inserting inside `invokeCore` (`:522-542`) is the alternative but that function is executed by the compile gate's parity check (`check-mcp-budget-dominance.mjs:305-317` calls each catalogue `core.*` binding against a recording port), so an emit there would run during `npm run compile`.

### 4.3 Identity data available at that point, BEFORE identity minting
| Datum | Availability | Anchor |
|---|---|---|
| Resolved tool name | yes — `mappedEarly` (post-`CAPABILITY_MAP`) | `:1533` |
| Caller-typed name | yes — `method` (the raw arg to `invoke`) | `:1505` |
| Caller-supplied `requestId` / `idempotencyKey` | only if the caller sent them in `params` — read inside `resolveInvocationIdentity`, not extracted by the time of the `:1534` branch | `:704-715` |
| MCP SDK `extra.requestId` | yes in the handler (`:1839-1841`) but **not** passed into `invoke`'s core.* branch — it is only consumed at `:1561` | `:1839-1842, :1561` |
| Timestamp | yes — `Date.now()` at the branch | DERIVED |
| Outcome / error code | only after `invokeCore` resolves or throws | `:541` |
| Attachment/run/workspace ids | available via `getBootstrap()` even for `core.*` (env is populated), but must not be required | `:242-283` |
| Stable proxy-minted dispatch id | **not available** — identity is minted later at `:1561`; this is precisely why plan.md:59 says `core.*` "mints no identity" and the unit must be `proxy-attempt`, not `logical-dispatch` | `:1534-1535` vs `:1561` |

### 4.4 What the emitter must never do
- **Never throw.** Any throw inside `invoke` becomes a tool error at `:1928-1930`, converting a working `core.*` call into a failure. Emit inside its own `try/catch`. **DERIVED from OBSERVED `:1928-1930`**
- **Never block dispatch.** The branch is on the hot path for every `core.*` call; prefer a bounded async append with a swallowed rejection over a synchronous write, and never await the write before returning the caller's result. **DERIVED**
- **Never write unbounded.** The proxy has no rotation and no `node:fs` today (`require` list at `:2-8`; the only `node:path` use is inline at `:452`; no `node:fs` occurrence anywhere in the file — **OBSERVED**). Reuse the discipline already proven in `fallback-recorder.ts:22/:143-149` (hard byte cap + timestamped rotation) or refuse to write past a cap. **DERIVED**
- **Never discover a path.** No `process.cwd()`, no repo-relative default — that is the `SUPER_CORE_DB` (`:451-452`) and `.omp/hooks/pre/antifan-core-bridge.ts:248-249` pattern that Phase 6's contract exists to reject.

### 4.5 Existing logging / diagnostic sink to reuse
**None file-based in the proxy.** All diagnostics go to `process.stderr`: `:1542` (autoheal failure), `:1546-1548` (`MCP_BRIDGE_OFFLINE`), `:1658` (connection/auth issue), `:1747` (heartbeat send failed), `:1787`/`:1793` (heartbeat renew/error), `:1966`/`:1974` (bridge offline / connect failure). Harnesses consume and prefix that stream (`scripts/theme-harness/mcp-client.mjs:89`). **OBSERVED**
The nearest JSONL precedent is outside the proxy: `.omp/hooks/pre/antifan-core-bridge.ts:240-249` `resolveLogPath()` honours `ANTIFAN_CORE_BRIDGE_LOG` (empty or `off` ⇒ `null` ⇒ no sink) but **defaults** to `<projectRoot>/.canary/core-bridge/events.jsonl` (file exists on disk, 18,997 B), appending at `:568`. Phase 6 should copy the env-gating and the `off`/empty ⇒ write-nothing clause, and drop the default. **OBSERVED + DERIVED**

---

## 5. Gate inventory

### 5.1 `npm run compile` chain — `package.json:24`, 7 stages, in order
| # | Command | Asserts | Fails? |
|---|---|---|---|
| 1 | `node scripts/build-native-host-shim.mjs` | builds `bin/antifan-bridge-host.exe` from `scripts/native-host-shim/main.c` + `Program.cs`; skipped when the exe is newer unless `--force`/`ANTIFAN_FORCE_BUILD_SHIM=1` | throws on tool failure |
| 2 | `node scripts/check-emit-integrity.mjs` | every `.ts`/`.tsx` under `src`,`scripts`,`test` has a `.compiled` sibling `.js`; deletes `.compiled/.tsbuildinfo` when a source older than build info lost its emit, forcing a full rebuild | **always exits 0** (`:24`, `:130`) |
| 3 | `tsc -p ./` | typechecks `include: ["src/**/*.ts","scripts/**/*.ts","test/**/*.ts"]` (`tsconfig.json:22`), `strict`, `noUncheckedIndexedAccess`, `noImplicitReturns` (`:12-16`); emits to `.compiled` (`outDir :6`, `rootDir :8`). **`.mjs`/`.cjs` are neither typechecked nor emitted** | yes (tsc exit) |
| 4 | `node scripts/check-mcp-budget-dominance.mjs` | proxy exports a finite `DEFAULT_CLIENT_TIMEOUT_MS` and no per-tool `CLIENT_TIMEOUT_MS` table (`:84-90`); every `CAPABILITY_MAP` row is a non-no-op with a target (`:91-102`); builds the **real** catalogue from 8 registration modules (`:109-176`); every advertised tool resolves to a registration (`:190-200`); advertised↔declared schema parity in the unsafe direction (`:202-241`); `core.*` exact-schema + `CORE_DISPATCH` reachability (`:242-275`); `CORE_DISPATCH` shape + boolean mutability (`:281-300`); catalogue↔proxy store-method identity (`:304-317`); ceiling dominates the largest container policy (`:336-341`) | **yes, exit 1** (`:380-383`) |
| 5 | `node scripts/prune-orphan-emit.mjs` | deletes `.compiled/{src,test,scripts}` emit with no source sibling in `.ts/.tsx/.js/.mjs/.cjs` (`:41`, `:75-82`); never prunes `.compiled/src/renderer` (`:96`) | **always exits 0** (`:31`) |
| 6 | `node scripts/copy-static.mjs` | copies a fixed renderer list (`:36-42`) and a fixed scripts list `['antifan-agent.cjs','antifan-agent.cmd','antifan-omp-mcp.cjs','dev-watcher-helpers.mjs']` (`:106`) into `.compiled/scripts` | yes — throws on failed copy (`:25-28`, `:66`, `:90`) |
| 7 | `npm run build:extension` → `scripts/build-extension.mjs` | esbuild-bundles `src/extension/background.ts` → `extension/background.js` (`:12-27`) | yes (esbuild) |

### 5.2 Effect of adding new files
- **New `src/main/telemetry/*.ts`**: typechecked + emitted by stage 3; stage 2 silently repairs missing emit; stage 5 keeps it; stage 6/7 untouched. **No gate change required.** **DERIVED from OBSERVED**
- **New `scripts/*.mjs` harness**: not typechecked (`tsconfig.json:22`), **not** copied to `.compiled/scripts` (`copy-static.mjs:106` is a fixed list), not pruned. A `.compiled/test/**/*.test.js` that requires it via `../../scripts/...` resolves to `.compiled/scripts/...` and fails — the same class of failure already documented at `docs/mcp-advertised-schema-enforcement.md:118-120` for `antifan-agent.cjs`. → put the harness in `test/unit/*.test.mjs` (runs from source, `package.json:43`) or append it to `copy-static.mjs:106`. **OBSERVED + DERIVED**
- **New gate wired into `compile`**: append to `package.json:24` and exit 1 on failure (pattern `check-mcp-budget-dominance.mjs:380-383`).

### 5.3 Exact command chain a Phase 7 implementer must run
```bash
npm run compile      # package.json:24 — the 7-stage chain above; stage 4 is the structural gate
npm run test:main    # package.json:44 — ".compiled/test/main/**/*.test.js"
npm run test:unit    # package.json:43 — "test/unit/*.test.mjs" + compiled test/unit, test/*, integration, benchmark
npm run audit        # package.json:37 → scripts/check-bottlenecks.mjs
npm run plans:check  # package.json:38 → scripts/check-plans.mjs
npm run verify       # package.json:47 → scripts/run-test-pipeline.mjs --verify (adds audit + plans:check, then every lane)
```
- `npm run verify` prepends `STATIC_LANES = ['audit','plans:check']` and runs `TEST_LANES = ['compile','test:canary','test:fast','test:site-clone','test:integration','test:main','test:e2e']` (`scripts/run-test-pipeline.mjs:22-23`), one lane at a time via `npm run <lane>` (`:42-45`), marking compile-dependent lanes **skipped** when compile fails (`:60-63`) and exiting 1 if any lane failed (`:97`). **OBSERVED**
- Which lanes read `.compiled`: `test:fast` (`package.json:39`), `test:integration` (`:42`), `test:unit` (`:43`), `test:main` (`:44`), `test:e2e` (`:45`). Source-level lanes: `test/unit/*.test.mjs` (`:43`) and `test:canary` = `test/unit/canary-*.test.mjs` (`:40`). **OBSERVED**
- `npm run audit` semantics: every row in `plans/bottlenecks.json` carries a predicate that must return `true` when the defect is PRESENT; `open`+absent and `closed`+present are **errors**, a row with no usable predicate is an error, `manual` rows only warn when stale (`scripts/check-bottlenecks.mjs:10-25`). Any Phase 7 follow-up row must therefore be machine-checkable. **OBSERVED**
- `npm run plans:check`: every `plans/**/plan.md` needs frontmatter with a `status:` in `{completed, complete, done, in-progress, active, pending, planned, superseded, blocked}`; missing/unrecognized fails (`scripts/check-plans.mjs:15-25`, `:133`). **OBSERVED**
- **There is no CI in this repo**: `.github/` does not exist under `E:\Work\apps\AntiFan` (glob `.github/**/*` → no files; `E:\Work\.github` is a sibling directory, not this repo). "One CI assertion" must therefore be a repo-native gate script wired into `package.json` (compile and/or a test lane). **OBSERVED**

---

## 6. Docs targets

| File | Section (line range) | What Phase 7 must do |
|---|---|---|
| `docs/operations.md` | `## Super Core (local evidence/provenance store)` **:60-77** — states `core.*` MCP tools "are served in-process by `scripts/antifan-omp-mcp.cjs` (no bridge dependency)" (:66-70) | add the `core.*` telemetry provenance note (`omp-proxy` provenance, `proxy-attempt` unit, own store, never summed) and the `proxyTelemetryUnavailable` state |
| `docs/operations.md` | `### MCP Capabilities for Coding Agents` **:135-142** | the MCP-surface docs the phase must update |
| `docs/operations.md` | `### Verification Commands` **:117-133** | add the Phase 7 gate command beside `npm run verify` |
| `docs/operations.md` | `### PII Sanitization Guarantee` **:143-145** | confirm scope: the self-report panel reads records the recorder already sanitized (`fallback-recorder.ts:74-93`) — no new redaction logic may be invented |
| `docs/README.md` | §1 table **:7-14** (operations.md at :13, mcp-advertised-schema-enforcement.md at :14) | register any new doc |
| `docs/mcp-advertised-schema-enforcement.md` | rule at **:8-9** ("No layer may fabricate a value the caller did not supply for a field that the layer's own advertised schema marks `required`"), rationale **:57-61**, measurement **:44** | **binding rule the suite must obey** — name it in Phase 5/6 docs |
| `.cursor/rules/development-rules.md` | **:8-11** (YAGNI>KISS>DRY; real implementations only; strict scope; exported-symbol integrity), **:14-16** (pre-edit read; multi-file batch; type/build gating), **:20-31** (reproduce→fix→prove; delivery format) | constrains the new modules and the delivery evidence |
| `.cursor/rules/testing-rules.md` | **:8-11** deterministic + side-effect-free, never weaken assertions, "Mocks are permitted ONLY for external third-party network APIs… Internal core logic MUST run against real instances"; **:14** run the narrowest test file first; **:18-21** raw stdout test evidence | constrains the Phase 5/6/7 tests (no mocked `core` store on the hot-path test; real temp-dir filesystem) |

- **No telemetry/observability doc exists.** Full `docs/` file list: `README.md`, `mcp-advertised-schema-enforcement.md`, `operations.md`, `research-9router-auth.md`, `research-browser-agent-seamless-execution.md`, `research-mobile-device-parity-chrome-sync.md`, `security-model.md`, `ui-architecture.md` (+ `docs/haravan/`). Either extend `operations.md` or create a new doc **and** register it in `docs/README.md:7-14`. **OBSERVED**
- `docs/security-model.md` covers "MCP capability risk gating" (`docs/README.md:12`) but contains no telemetry contract. **OBSERVED**

---

## 7. File inventory, test-scenario matrix, dependency map

### 7.1 File inventory
| Phase | Op | Path | Purpose | Evidence anchor |
|---|---|---|---|---|
| 5 | MODIFY | `src/main/telemetry/fallback-recorder.ts` | add a rotation-aware enumeration/glob helper for the SAME directory it writes; optionally add a schema-version field — without changing the existing record shape | `:122-124`, `:143-149`, `:17-20`; tests `src/main/telemetry/fallback-recorder.test.ts:82-138` |
| 5 | CREATE | `src/main/telemetry/self-report-reader.ts` (name is the planner's choice) | glob `<root>/.antifan/telemetry/gaps*.jsonl`, parse JSONL, classify by key presence (`LEGACY_SUBSTITUTED`, unparseable, oversized), return `{records, files[], absolutePaths[], unreadable[]}`; **never writes** | glob shape from `:123,:146`; classification rule from `:43-72` |
| 5 | MODIFY | `src/renderer/toolbar.ts` | add the Panel B tab: extend the `HubTab` union (`:448`), `HUB_CORE_TABS` (`:449`), nav map (`:453`), render branch (`:707`, `:856`), click wiring (`:2815`) | all OBSERVED |
| 5 | MODIFY | the Phase 4 IPC/service file (delivery surface) | add a sibling request path to `ipcMain.handle('antifan:workflow:get-state', …)` — precedent `src/main/browser/native-tab-host.ts:2057-2070` | OBSERVED |
| 6 | MODIFY | `scripts/antifan-omp-mcp.cjs` | bounded, non-throwing `core.*` attempt emitter wrapped around `:1533-1536`; must keep the `:1979-1988` exports and `:662` ceiling intact | `:1534-1535`, `:1928-1930`, `check-mcp-budget-dominance.mjs:84-102` |
| 6 | MODIFY | `scripts/antifan-agent.cjs` | forward the new path variable into `childEnv` (`:761-793`) — the only env object the live proxy actually inherits | `mcp.json` → `resolveAgentCommand :843-848` |
| 6 | MODIFY | `src/main/bridge/bridge-server.ts` | **only if** the path is to be app-supplied on this channel: add the resolved root to the `startSession` response (`:2156-2173`), which `antifan-agent.cjs:515` already consumes | OBSERVED |
| 6 | MODIFY (conditional) | `src/main/agent/codex-execution-backend.ts` | inject the same variable at `:81-100` **only if** an AntiFan MCP server is registered for codex; today `~/.codex/config.toml` registers none | OBSERVED |
| 6 | CREATE | `test/unit/mcp-proxy-emitter.test.mjs` | source-level test requiring the proxy directly (precedent: `test/unit/bridge-receipt-coverage.test.mjs:38`) | OBSERVED |
| 7 | CREATE | `scripts/check-panel-separation.mjs` | the single assertion that Panel A and Panel B never share a total (blueprint: `check-mcp-budget-dominance.mjs:380-383`) | plan.md:53,119 |
| 7 | MODIFY | `package.json` | append the new gate to `compile` (`:24`) and/or a lane | OBSERVED |
| 7 | MODIFY | `docs/operations.md` | `:60-77`, `:117-133`, `:135-145` | OBSERVED |
| 7 | MODIFY | `docs/README.md` | `:7-14` if a new doc is added | OBSERVED |
| 7 | MODIFY | `plans/bottlenecks.json` | record the `canonicalJsonStringify` follow-up (plan.md:138) as a machine-checkable row | `check-bottlenecks.mjs:10-25` |
| 7 | MODIFY | `plans/260917-0341-mcp-dispatch-accounting/plan.md` + `phase-0{5,6,7}-*.md` | replace the 29-line stubs with the scouted content; keep `status:` legal | `check-plans.mjs:15-25` |
| — | DELETE | none | — | — |

### 7.2 Test-scenario matrix
| # | Scenario | Mechanism to exercise it | Expected | Lane |
|---|---|---|---|---|
| T5-1 | Reader sees both rotation shapes | write `gaps.jsonl` + `gaps-<ts>.jsonl` into a temp root | both parsed; both absolute paths returned and disclosed | `test/unit/*.test.mjs` (source) |
| T5-2 | Unbound/empty root | call the reader with `''` (the value `control-plane-runtime.ts:149` returns) and with a non-existent dir | `NO_DATA`/`UNMEASURED` **with the resolved path**; never `0`; never a CWD-relative guess | same |
| T5-3 | Legacy fabricated records | seed records with `primaryTool:"unknown"`, `fallbackTool:"browser_*"` | classified by name (e.g. `LEGACY_SUBSTITUTED`), displayed, never dropped, never counted as measured | same |
| T5-4 | Torn tail / unparseable line | append a half line | classified separately, no crash, rest of file still counted | same |
| T5-5 | No mixing | assert Panel B carries no field that feeds a Panel A total | structurally separate payload types | `test:main` or source |
| T6-1 | Emitter without env | spawn the proxy with no telemetry var and call a `core.*` tool | tool result unchanged; nothing written anywhere; `proxyTelemetryUnavailable` reported | `test/unit/*.test.mjs` |
| T6-2 | Emitter with env | spawn with the var pointing at a temp dir | exactly one bounded attempt record with method + timestamp + outcome; `core.*` result byte-identical to the no-env run | same |
| T6-3 | Emitter cannot throw | make the target path unwritable (e.g. a directory in its place) | `core.*` still returns normally | same |
| T6-4 | Emitter cannot block/burst | N sequential calls past the cap | rotation or refused writes; bounded file count/size | same |
| T6-5 | `core.*` still identity-free | after the change, grep the ledger for `"name":"core.` | still zero occurrences (measured today: 0 files matching the literal `"name":"core.` and 0 matching `core.stats` across the `*.jsonl` partitions; the directory holds 1,041 files incl. quarantines) | manual/`audit` |
| T6-6 | Compat | `test/unit/bridge-receipt-coverage.test.mjs` + `npm run compile` stage 4 | unchanged pass; `CORE_DISPATCH` untouched | `test:unit`, `compile` |
| T7-1 | Panels never share a total | run the new gate against a fixture where a shared total exists | gate exits 1 | `compile` |
| T7-2 | Gate green on the real tree | run the gate against the live service payload | exits 0 | `compile` |
| T7-3 | No new advertised tool | `check-mcp-budget-dominance.mjs` parity section | unchanged (plan.md:40,122) | `compile` |
| T7-4 | Docs/gates bookkeeping | `npm run plans:check`, `npm run audit` | exit 0 | `audit`, `plans:check` |

### 7.3 Dependency map
```
Phase 5 (panel B)  →  Phase 1 census contract (asOf + file-set discipline)      plan.md:57,68-70
Phase 5            →  Phase 4 delivery surface (IPC + Hub tab)                  native-tab-host.ts:2057-2070; toolbar.ts:448-453,707,856,2815
Phase 5            →  fallback-recorder.ts writer contract (frozen shape)        fallback-recorder.ts:17-20,103-124,143-153
Phase 5            →  workspaces/260901-1736 rotation ownership (in-progress)    plan.md:129
Phase 6 (emitter)  →  proxy invoke path only; INDEPENDENT of Phases 1-5          plan.md:59 ("cuttable")
Phase 6            →  an app-side injection point: bridge-server.ts:2156-2173 → antifan-agent.cjs:761-793 → proxy env
Phase 6            →  check-mcp-budget-dominance.mjs proxy exports/parity        check-mcp-budget-dominance.mjs:82-102, 242-275
Phase 6            →  test/unit/bridge-receipt-coverage.test.mjs (requires proxy directly)  :38
Phase 7            →  Panel A + Panel B payload types from Phases 1-5           plan.md:53,119
Phase 7            →  compile chain (package.json:24) + verify pipeline          run-test-pipeline.mjs:22-23
Phase 7            →  docs authorities (operations.md, docs/README.md)          operations.md:60-77,117-145
```

---

## 8. Risks, observable signals, pre-decided responses

| # | Risk | Observable signal | Pre-decided response |
|---|---|---|---|
| R1 | **Workspace root unbound at write time** — `control-plane-runtime.ts:149` returns `''`; the default parameter at `fallback-recorder.ts:128` does not fire for `''`; `path.join('',…)` collapses to a CWD-relative path (DERIVED; verified `path.join` behaviour). Writes then land in whatever cwd the Electron process has — the mechanism that most plausibly produced `E:\Work\.antifan-data\.antifan\telemetry\gaps.jsonl` | glob over the resolved root returns 0 files while a CWD-relative `gaps.jsonl` exists; the panel shows `NO_DATA` where records demonstrably exist | Reader resolves the **same** root the writer used (reimplementing `control-plane-runtime.ts:248-291` semantics, including the data-root/data-parent exclusions), discloses the absolute root **and every file path read**, and renders `NO_DATA` + path. Never falls back to `process.cwd()` silently; never renders `0` (plan.md:118) |
| R2 | **Two live roots** (measured: repo root 405 records + data root 2 records) | two non-empty globs in one run | per-root rows labelled by absolute path; never summed, never ratio-mixed |
| R3 | **Rotation mid-read** (10 MB boundary, `fallback-recorder.ts:143-149`) | record count differs between two passes; a `gaps-<ts>.jsonl` appears between globs | glob both shapes; re-glob after reading; report `asOf` + the file set (Phase 1 census discipline, plan.md:57) |
| R4 | **Pre-fix fabricated records in the store** (measured: 4 records, `unknown` / `browser_*` / `FAILED`) | those literal values appear in the panel | classify by name and display; never silently drop; never treat as a measured fallback (the rationale at `fallback-recorder.ts:43-72`) |
| R5 | **Proxy launched with no injected env** — the normal case for a manual `node scripts/antifan-omp-mcp.cjs`, and possible for any client that never received the var; note `core.*` still serves calls in that state (`:1534-1535` precedes `:1538-1550`) | `proxyTelemetryUnavailable` in the proxy's own output; store file count unchanged after `core.*` calls | write nothing; no plausible-path fallback; no `SUPER_CORE_DB`-style default (`:451-452`); the panel renders the `core.*` family as an explicit labelled hole naming the mechanism (plan.md:124,149) |
| R6 | **Emitter throws or blocks** → a working `core.*` call becomes `isError` (`:1928-1930`) | `core.*` calls failing right after the emitter lands; `test/unit/bridge-receipt-coverage.test.mjs` or `npm run compile` stage 4 red | emit only inside its own `try/catch`, after the outcome is known, async and bounded; Phase 6 must remain cuttable — reverting it must leave Phases 1-5 green (plan.md:59) |
| R7 | **Emitter writes unbounded** (proxy has no rotation, no `node:fs` today) | proxy store grows without bound; no rotation file ever appears | hard byte cap + timestamped rotation mirroring `fallback-recorder.ts:22/:143-149`, or refuse writes past the cap |
| R8 | **Panels get joined** (a shared total, a cross-panel rate) | the Phase 7 assertion fires; a ratio spans panels | the assertion fails the build (plan.md:53,119); panels stay separate row sets |
| R9 | **New `.mjs` harness invisible to `.compiled` tests** | a red lane with a missing relative require from `.compiled/test/**` | place the harness in `test/unit/*.test.mjs` (source lane) or add it to `copy-static.mjs:106` |
| R10 | **A new gate fails on pre-existing state** | `npm run compile` goes red on the first run after wiring | derive all thresholds/counts at run time — never hard-code (plan.md:115,148); prove the gate red on a seeded fixture and green on the real tree, the way `--proxy <fixture>` proves `check-mcp-budget-dominance.mjs` fires (`:30-31,41-45`) |
| R11 | **Codex launch path cannot carry the var today** (no antifan MCP server in `~/.codex/config.toml`) | emitter never runs for codex-launched sessions; only the OMP/`antifan-agent.cjs` path produces records | scope Phase 6 to the channel that exists (`bridge-server.ts:2156-2173` → `antifan-agent.cjs:761-793` → proxy) and **state the codex hole explicitly** rather than implying coverage (plan.md:40 forbids changing the advertised surface, so this must be a documented limitation, not a new tool) |
