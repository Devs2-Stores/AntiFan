# Phương án fix — AntiFan issues (audit 05–06/10/2026)

Nguồn: `session-analysis-261006-omp-chat-audit.md`. Map code đã scout xong; mỗi mục có file:line thật, mechanism hiện tại, phương án, risk.

---

## Nhóm 1 — Terminal input corruption (`;0;111;1;0;1_[`)

**Cơ chế đã xác nhận:** PTY chạy ConPTY (`src/main/browser/terminal-manager.ts:1708` `useConpty: true`). TUI (omp/Ratatui/Crossterm) bật win32-input-mode bằng `ESC[?9001h` (vào PTY input — node-pty `onData` không thấy). TUI thoát không gửi `ESC[?9001l` → ConPTY giữ mode; user gõ → sequence extended ra output → xterm (không `windowsPty` option, `standalone.js:3028`) echo raw. `appendData` (:1765) đã scan `ESC[?1049` để track alt-screen nhưng **không** track `9001`. Không có reset path nào (`:1740` `onExit` chỉ xử lý root shell).

**Phương án:**

1. **Auto-detect + auto-recover (khuyến nghị, đủ dùng):** trong `TerminalManager.appendData` scan thêm `\x1b[?9001h` (enable) và `\x1b[?9001l` (disable) trên `s.win32InputScanTail` như alt-screen. Khi `onData` thấy chunk chứa pattern `;\d+;\d+;\d+;\d+_\[` *và* `s.win32InputMode === true` *và* không còn `1049h` active → đây là leaked keystroke echo → tự `s.pty.write('\x1b[?9001l')` rồi emit warning log (`terminal.win32InputRecovered`). Detect-on-symptom, không cần đoán lifecycle.
   - Risk: false-positive nếu TUI đang chạy và intentionally muốn win32-input. Gate bằng `s.altScreen === false` + session không active TUI flag. Effort: ~1 ngày.

2. **Manual reset command (bổ sung, rẻ):** `TerminalManager.resetInputMode(id)` → `pty.write('\x1b[?9001l\x1b[?1049l\x1bc')`. Expose qua IPC `antifan:terminal:reset` + nút/context-menu trong `standalone.js`. Effort: nửa ngày.

3. **Preventive nguồn:** không làm được — child process exit trong shell không emit `onExit` (đã xác nhận :1740 chỉ wrap root PTY). Cần (1) làm auto-recover.

**Acceptance:** mở TUI (omp), `Ctrl+C` giữa chừng, gõ phím → không còn `;0;111…` và input hoạt động bình thường.

---

## Nhóm 2 — Tab targeting / authority (TARGET_MISMATCH, TARGET_STALE, TARGET_NOT_ACTIVATABLE)

### 2a. Ephemeral agent tab không activate được → deadlock
- `bridge-server.ts:2647-2651` & `:2674-2678` — `antifan.cli.startSession` hardcode `{ offscreen: true, ephemeral: true }`. `native-tab-host.ts:8928` `trySwitchTab` refuse `TARGET_NOT_ACTIVATABLE` cho `offscreen||ephemeral`. `browser-control-port.ts:2604` `requireActivatedTab` throw, liệt kê `activationCandidates` — nhưng session agent thường chỉ có đúng 1 tab (ephemeral đó) → `No other tab in this session can be activated`.
- Flag `userFacing` (commit `7239394`) tồn tại ở `openTab` (`browser-control-port.ts:3926`, `bridge-server.ts:2899`) nhưng **`startSession` không dùng**.

**Phương án:**
- Trong `antifan.cli.startSession` (:2647, :2674) thêm option `interactive?: boolean` (hoặc `userFacing: true`) trên session-start request → mint tab với `{ offscreen: false, ephemeral: false, plane: 'user' }` khi caller cần activate. Default giữ nguyên offscreen (headless agent không cần).
- Trong `requireActivatedTab` (:2604), khi `offscreen && candidates.length === 0` → tự mint một userFacing tab trong cùng workspace rồi activate nó (thay vì BLOCKED). Hoặc ít nhất trả `canProvision: true` trong error payload để client biết path.
- Effort: 1 ngày. Risk: tab user-plane chiếm chỗ tab strip — cần cleanup-on-close như ephemeral.

### 2b. TARGET_MISMATCH split-pane — agent truyền tabId raw thay vì paneId
- `capability-catalogue.ts:696-699` + `browser-control-port.ts:8103` — throw TARGET_MISMATCH kèm note `paneId:"mobile"` trong message. Agent vẫn lặp ~40 lần.
- Phương án: trong `authorizeAndResolveEffectiveTarget` (:636-708), khi `reqTabId` khác bound nhưng `resolveTargetTabId(reqTabId)` resolve về bound tab (pane sibling) → auto-rewrite sang `{ tabId: bound, paneId: 'mobile' }` thay vì throw. Chỉ auto-resolve khi tab đích nằm trong cùng `tabByWebContents` map của bound tab.
- Effort: 0.5 ngày. Risk: thấp — chỉ nới trong cùng pane family.

### 2c. AUTHENTICATION_DENIED attachment revoked giữa phiên
- `attachment-registry.ts:1315-1335` `revokeForConnection` — revoke khi last socket disconnect. `bridge-server.ts:2128-2140` `ws.on('close')` trigger. MCP reconnect mới tạo socket mới nhưng attachment đã revoked → `:667` `assertExecutionAuthority` throw.
- Phương án: trong `revokeForConnection`, trước khi `revokeAttachmentUnlocked`, grace period (vd 10s) cho reconnect cùng `connectionId`/session — hoặc mark `suspended` thay vì `revoked`, promote lại khi heartbeat (`bridge-server.ts:2842`) đến.
- Effort: 1 ngày. Risk: attachment zombie nếu client không quay lại — cần TTL sweep.

### 2d. Bridge disconnect → QA_UNAVAILABLE → BLOCKED delivery
- `antifan-omp-mcp.cjs:1692,2045-2365` — autoheal đã có; khi app down thật thì `MCP_BRIDGE_OFFLINE`. `theme-qa-gate.ts:1050` đã phân loại `QA_UNAVAILABLE` cho `CAPABILITY_NOT_FOUND`/auth nhưng session report vẫn BLOCKED.
- Phương án: trong `theme-qa-gate.ts` `tool_result` (:1132), khi evidence là `MCP_SERVER_NOT_CONNECTED`/`BRIDGE_UNREACHABLE` → verdict `QA_UNAVAILABLE` kèm receipt rõ (`bridge_down:true`), **không** để agent tự kết BLOCKED mơ hồ. Doc vào `annotation-prompt.ts:80-84` đã có — cần verify hook emit đúng code này.
- Effort: 0.5 ngày.

---

## Nhóm 3 — Capture / QA gates

### 3a. CAPTURE_FRAME_STARVATION — remedy message thù địch
- `tab-devtools-host.ts:2120-2245` `ensureFramesForRaster` — ladder: invalidate → reassert → in-window-lift → lift-recycle → `CAPTURE_FRAME_STARVATION`. Đã có native raster fallback (:2691) cho viewport non-offscreen — nhưng chỉ sau throw, và không cover `full-page`/`clip`.
- Observed: window "maximized và visible" mà vẫn starve → DWM occludes renderer khi window minimized/occluded bởi other window, hoặc throttle.
- Phương án:
  1. Thêm rung cuối trước khi throw: `this.shell.window?.focus()` + `win.show()` + `win.moveTop()` (foreground nudge) rồi re-probe 1 lần nữa. Windows DWM thường resume compositor sau focus nudge.
  2. Khi vẫn starve: mark error `retryable: true` trong `CaptureError` details + trả `suggestedDelayMs: 2000` — agent retry thay vì fail.
  3. `full-page`/`clip`: fallback sang tile capture (3b dưới) thay vì throw.
- Effort: 1 ngày.

### 3b. FULLPAGE_CAPTURE_UNSUPPORTED_GEOMETRY >16384px
- `visual-capture.ts:703` `CAPTURE_MAX_DIMENSION = 16384` — Chromium hard cap, không fix được. Hiện throw.
- Phương án: khi `docH > 16384` → tự tile capture theo clip rects `vh`-sized, stitch PNG server-side (đã có artifact pipeline), trả `full-page-stitched` receipt với `tileCount`. Nếu không stitch được → trả `CAPTURE_PARTIAL` kèm segment offsets, không throw.
- Effort: 2 ngày (stitch + receipt schema).

### 3c. SETTLE_INCOMPLETE — DOM gate fail trên trang animation vô hạn
- `capture-settle.ts:79-85` `DEFAULT_SETTLE_TIMEOUTS.domTimeoutMs = 300` — bounded, không "deadlock". Thực tế là `theme-qa-workflow.ts:594-598` throw `SETTLE_INCOMPLETE` khi `dom=false` → QA fail.
- Giaohangnang có carousel animation loop → `domQuiet` luôn false trong 300ms.
- Phương án: khi `dom=false` nhưng `network/fonts/images` đều true và `layoutStable` (từ `LAYOUT_DRIFT` check :847-874) → downgrade verdict thành `QA_INCONCLUSIVE` kèm `domUnstable:true` thay vì `SETTLE_INCOMPLETE` throw. Hoặc cho `settleCapture` option `domPolicy: 'strict'|'lenient'` — QA workflow dùng lenient, capture pipeline dùng strict.
- Effort: 0.5 ngày. Risk: lenient mode có thể bỏ sót layout shift — mitigate bằng `layoutStable` gate thay thế.

### 3d. NAVIGATION_TIMEOUT 8s quá ngắn cho Haravan preview
- `native-tab-host.ts:10543, 10612, 10687, 10752` + `browser-control-port.ts:2073, 2169` — constant 8000ms.
- Phương án: nâng default 8000 → 20000ms; expose `timeoutMs` trong `navigate`/`reload` options cho caller override. Đã có `NAVIGATION_TIMEOUT` code riêng (:2079-2089) — tốt, giữ.
- Effort: 0.25 ngày.

### 3e. Hidden-tab evaluate timeout `15000ms (tab visibility: hidden)`
- `tab-devtools-host.ts:231` `EVAL_JS_DEFAULT_TIMEOUT_MS = 15_000` — per-expression in-page budget (:3155-3159). Comment :226-230 đã note "Chrome pauses RAF in background tabs, script chờ frame sẽ hang".
- Phương án: không cần fix code — đây là agent-side: truyền `timeoutMs` cao hơn hoặc đảm bảo expression không chờ RAF. Tuy nhiên, nên thêm vào error message hint: `(tab visibility: hidden)` → `"if the script waits on requestAnimationFrame, it will not fire on hidden tabs — either activate the tab or rewrite without RAF"`. Effort: 10 phút.

### 3f. URL_HOST_MISMATCH scheme-less expected URL
- `visual-capture.ts:1301-1317` — `new URL('levents-global.myharavan.com/path')` throw `Invalid URL` → `URL_HOST_MISMATCH`.
- Phương án: trước `new URL`, nếu `!/^https?:\/\//i.test(trimmedExpected)` → prepend `https://`. Áp dụng cho cả `expected` và `observed`.
- Effort: 5 phút.

### 3g. CAPTURE_NOT_READY layoutStable drift — lazy mount
- `capture-settle.ts:560-584` `LAYOUT_DRIFT_TOLERANCE_RATIO=0.001`, min 2px; `LAYOUT_OBSERVATION_ATTEMPTS=3`. Session S2 Spa drift 879px — lazy image load trong observation window.
- Đã đúng ý đồ (phải refuse khi còn grow). Phương án: `anti.reference.capture` đã materialize trước — đảm bảo settleCapture path gọi materialization trước khi gate. Nếu đã gọi mà vẫn drift → đây là page behavior, không fix code. Chỉ cải thiện message: trả `unstableSelectors` (đã có `describeInflight`) rõ hơn.

---

## Nhóm 4 — Repo / tooling

### 4a. `theme-qa-gate` hook test non-hermetic
- `theme-qa-gate.ts:273-282` `bridgeOutageEvidence` đọc `process.env.ANTIFAN_DATA_ROOT` → `config/bridge-dev.json`. `test/unit/theme-qa-gate-hook.test.mjs:29-32` chỉ isolate `ANTIFAN_EDIT_MODE`, để `ANTIFAN_DATA_ROOT`/`ANTIFAN_CONFIG_DIR` trôi → PID chết → `HEALTH_PID_DEAD` inject → ~26 fail.
- Fix: trong test file, top-level `const PREV_DATA_ROOT = process.env.ANTIFAN_DATA_ROOT; const PREV_CONFIG_DIR = process.env.ANTIFAN_CONFIG_DIR;` → `delete` trong `before` hoặc `loadHook()`, restore `after`. Effort: 15 phút.

### 4b. `site-clone` test ENOENT icon.png (cwd-dependent)
- `packages/site-clone/src/generators/theme-compiler.test.ts:70` & `:434` — `path.resolve('assets/icon.png')` resolve theo `process.cwd()`, fail khi chạy từ `packages/site-clone`.
- Fix: `path.resolve(import.meta.url` → repo root `assets/icon.png`, hoặc `new URL('../../assets/icon.png', import.meta.url)`. Effort: 5 phút.

### 4c. MCP tool-name mismatch — agent gọi sai tên
- `scripts/antifan-omp-mcp.cjs:31-218` `definitions` — tên thật: `theme.qa_validate` (:66), `browser.promote-baseline` (:92), `anti.visual.promote_baseline` (:93). Agent gọi `anti_theme_qa_validate`/`anti_browser_promote_baseline` → `xd://` no-such-tool.
- Error emit site là OMP-side (`xdev.ts:397`) không sửa được trong repo này. Nhưng `antifan-omp-mcp.cjs:2477` `invoke` validate trước — có thể thêm alias map: `{ 'anti.theme.qa_validate': 'theme.qa_validate', 'anti.browser.promote_baseline': 'browser.promote-baseline' }` trong `CAPABILITY_MAP` (:550) để gọi sai vẫn route đúng. Effort: 30 phút.

### 4d. `anti_theme_style_override` validation loop
- `antifan-omp-mcp.cjs:79-80` — schema require `operation`+`id` nhưng description không có example. Agent gọi `{}` hoặc thiếu field → `INVALID_ARGUMENT` loop.
- Fix: thêm `description` kèm minimal example vào definition; hoặc `invoke` (:2477) khi thiếu required trả kèm `expectedShape` object. Effort: 30 phút.

### 4e. `PENDING_CLEANUP` 30s budget cho evaluate nặng
- `browser-control-port.ts:1108` `BROWSER_EVAL_INVOCATION_BUDGET_MS = 30_000` → `capability-transport.ts:600` exec 25s + cleanup 5s.
- Phương án: giữ nguyên (đây là intentional bound), nhưng doc trong schema description của `anti.browser.evaluate` (:85): `"Long-running expressions may return PENDING_CLEANUP; poll via anti.browser.evaluate again or split the script"`. Effort: 10 phút.

### 4f. `haravan_preflight.py` Windows path mangling
- Repo-side `probe-haravan-session-cookies.cjs:117` đã đúng (`execFileSync` array). Bug là agent-side unquoted backslash trong bash string — không fix được trong repo này (skill docs là `C:/Users/Admin/.agents/skills/haravan-audit/`). Có thể sửa skill doc: đổi `py <skill-dir>\scripts\haravan_preflight.py` → `py "<skill-dir>/scripts/haravan_preflight.py"` forward-slash. Effort: 5 phút (ngoài repo).

---

## Nhóm 5 — Agent-side guard rails (rule/hook, không phải code bug)

Các vi phạm trong audit (xóa asset, paste `…`, `PUT` leak vào CSS, `npm install` không xin phép) — không fix trong repo AntiFan; cần harden `edit`/`write` tool contract phía OMP hoặc `src/omp-hooks/edit-guard.ts`:

- `edit-guard.ts` thêm check: PUT body chứa `…`/`..` (trừ khi context file có) → warn/block.
- `edit-guard.ts` block `write`/`edit` xóa file trong `allowedFiles` whitelist khi mode scoped.
- Fast-mode guard deadlock (Super-Fast chặn browser/shell nhưng QA gate đòi live evidence) → hook `theme-qa-gate.ts` khi `REFUSED_FAST_MODE_TOOL` → verdict `QA_MICRO_STATIC` hoặc `QA_DEFERRED` thay vì lặp.

---

## Thứ tự đề xuất implement

| Sprint | Items | Effort |
|---|---|---|
| 1 | 1 terminal auto-recover + reset cmd; 4a test hermetic; 3f URL normalize; 4b icon.png; 4c alias map | ~2 ngày |
| 2 | 2a userFacing agent tab; 2b pane auto-resolve; 2c attachment grace; 3d nav timeout; 3e eval hint | ~2 ngày |
| 3 | 3a starvation foreground nudge + retryable flag; 3c SETTLE_INCOMPLETE lenient; 2d bridge degrade path | ~2 ngày |
| 4 | 3b full-page tile stitch; 5 edit-guard hardening | ~3 ngày |

---

## Ultra reframing verdict (ak-problem-solving --ultra)

Winner: Candidate A — **recoverable scoped lease** primitive. Cơ chế chung của các bug: subsystem acquire state/authority transient mà không có recorded inverse hoặc bind sai lifetime (socket vs session, ephemeral flag vs user intent, root shell vs inner TUI). Precedent đã có sẵn trong codebase: GPU Lens `startLens/stopLens` + `lensGeneration` + `GPU_LENS_CLEANUP_SCRIPT`. Fix = extract pattern đó ra từng seam, không invent framework mới.

ultra: picked=A/5 margin=high unanimous=yes rejected_all=no

---

## Ultra fix-plan verdict (ak-fix --ultra)

Winner: Candidate C (fx-cand3, 98/100). Implementation contract đã chốt bởi verifier:

| Ticket | Fix đã chọn | File |
|---|---|---|
| T1 | Track `win32InputMode` bằng scan-tail như `altScreenScanTail`; emit `\x1b[?9001l` vào pty khi `!altScreen` mà mode còn leak (hoặc thấy pattern `;\d+;\d+;\d+;\d+_\[`). **GATE: live ConPTY repro trước khi commit mechanism** | src/main/browser/terminal-manager.ts |
| T2 | `startSession` đọc `p.userFacing \|\| p.interactive` → mint `plane:'user'` tab; default giữ offscreen/ephemeral | src/main/bridge/bridge-server.ts |
| T3 | Auto-resolve pane sibling (`<boundId>:mobile` hoặc `isTabAllowed`) → `params.paneId='mobile'`; foreign tab vẫn fail-closed TARGET_MISMATCH | capability-catalogue.ts, browser-control-port.ts |
| T4 | `revokeForConnection`: conns=0 → state `suspended` + grace timer 5-15s; reconnect với secret hợp lệ → restore `active`; **verifySecret vẫn fail-closed tuyệt đối** | src/main/run/attachment-registry.ts |
| T5 | `SETTLE_INCOMPLETE` chỉ throw khi network/fonts/images/layout fail; `dom=false` đơn độc → `domUnstable:true` + verdict INCONCLUSIVE | src/main/qa/theme-qa-workflow.ts |
| T6 | Default nav/reload timeout 8000→20000ms; expose `timeoutMs` option | native-tab-host.ts, browser-control-port.ts |
| T7 | Normalize scheme-less URL (`https://` prepend) trước `new URL()` | src/main/verification/visual-capture.ts |
| T8 | Isolate `ANTIFAN_DATA_ROOT`/`ANTIFAN_CONFIG_DIR` trong test setup + restore `test.after` | test/unit/theme-qa-gate-hook.test.mjs |
| T9 | `path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..')` + `assets/icon.png` | packages/site-clone theme-compiler.test.ts |
| T10 | CAPABILITY_MAP += `anti.theme.qa_validate`, `anti.browser.promote_baseline` | scripts/antifan-omp-mcp.cjs |
| T11 | Enrich descriptions style_override (example) + evaluate (PENDING_CLEANUP note) | scripts/antifan-omp-mcp.cjs |

ultra: picked=C/5 margin=high unanimous=yes rejected_all=no
