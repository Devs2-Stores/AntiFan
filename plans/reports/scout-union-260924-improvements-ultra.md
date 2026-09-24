# Scout Report — "Hôm nay cần cải thiện gì AntiFan không?" (`--ultra`)

Date: 2026-09-24 · Repo: `E:\Work\apps\AntiFan` · HEAD: `0cf4e68f` (fix(terminal): scope attachment-bound terminal calls)
Method: `ak:scout --ultra` — one immutable evidence packet, five independent read-only scout candidates (CandA-ledger, CandB-uncommitted, CandC-codehealth, CandD-tests, CandE-docs) in a single wave, one verifier (UltraVerifier) producing the evidence-validated deduplicated union.

## Verdict — có cần cải thiện không?

**CÓ.** 5 lỗi P0 khẩn cấp (regression `TERMINAL_FORBIDDEN` do HEAD `0cf4e68f`, deadlock `TERMINAL_TAB_CLOSED`, vi phạm invariant §3.1 namespace, 3 crash native chưa triage, CHANGELOG thiếu bản vá bảo mật), cùng rò rỉ rAF/timer ở renderer và tồn đọng kiểm thử/ledger.

## P0 — Làm ngay hôm nay

1. **Sửa regression `TERMINAL_FORBIDDEN` trên MCP client** — `src/main/tools/terminal-capabilities.ts:153-160`, `src/main/control-plane/control-plane-runtime.ts:248-251`, `src/main/bridge/bridge-server.ts:1030-1045`, `scripts/antifan-omp-mcp.cjs:1970-1990`. Proxy resolve `tabId` local nhưng không đăng ký ngược vào attachment record ⇒ mọi `terminal_*` call qua MCP fail. ~30–45 phút.
2. **Deadlock `TERMINAL_TAB_CLOSED` + retry vô ích** — `src/main/bridge/bridge-server.ts:2101-2103` ném lỗi trước khi auto-provision tab mới; `ECONNREFUSED`/`TERMINAL_TAB_CLOSED` không nằm trong `TERMINAL_PAIRING_ERRORS` (`scripts/antifan-omp-mcp.cjs:1547-1574`) nên retry 4 lần vô nghĩa. ~45 phút.
3. **Xoá alias `browser_find`/`browser_press_key` vi phạm §3.1** — `src/main/tools/browser-capabilities.ts:1322-1323, 1436-1437` đăng ký "Canonical Playwright MCP alias" trong catalogue AntiFan, vi phạm namespace isolation vừa chốt trong `AGENTS.md §3.1`. ~30 phút.
4. **Triage 3 crash native P0 chưa có chủ** — `issue-register.jsonl:279-281`: `electron.exe+0x897d241` (gpu, 09-18), `DUI70.dll+0x3733e` (browser, 09-21), `electron.exe+0xe22b52` STATUS_BREAKPOINT (browser, 09-21). ~1–2 giờ.
5. **CHANGELOG thiếu commit `0cf4e68f`** — bản vá cô lập terminal multi-tenant chưa được ghi. ~15 phút.

## P1 — Tuần này

1. **Rò rỉ timer/rAF `TerminalWriteDispatcher`** (~0.208 MB/phút, 38k `V8FrameRequestCallback`) — `src/shared/terminal-write-dispatcher.ts:140-176, 275-285`; `cancelFrame` chỉ huỷ rAF, không clear `setTimeout` fallback; `cancel(target)` race với `onComplete` cũ. ~2–3 giờ.
2. **`IssueRegister` bypass state machine** — gán `item.status` trực tiếp tại `src/main/session/issue-register.ts:704, 751, 902, 948, 972` thay vì `transitionIssue` (`:801-815`). ~45 phút.
3. **Cookie sync rớt batch khi user logout** — `REMOVALS_UNSUPPORTED` HTTP 400 (`bridge-server.ts:1396-1405`) + `allowedDomains` hardcode (`src/main/index.ts:824`). ~1 giờ.
4. **Canary chạy đúp + thiếu fast-feedback cho `test/main/`** — `package.json:33-34`, `scripts/run-test-pipeline.mjs:16-17`; `test:main` ~104s, không có runner incremental. ~1–1.5 giờ.
5. **Khép plan soak `260920-0100`** — 2 gate fail (peak WS 1670>1600 MB, p50 13.49>12 ms); cần quyết định trần `FREEZE_SLO` hoặc A/B discriminator chưa chạy. ~1 giờ.
6. **Plan `260919-0130` ghi `completed` nhưng Phase 3/4 còn mở** — `plan.md:4, 380-395, 495-502`. ~30 phút.

## P2 — Dọn dẹp / Hygiene

1. Commit `tab-devtools-host.ts` + test (đã đủ coverage, commit-ready); dọn dead code `:1744-1747`.
2. Revert 2 file generated bị dirty CRLF (`extension/background.js`, `src/renderer/terminal-write-dispatcher.js`).
3. `CAPABILITY_NOT_FOUND` → `TARGET_STALE` khi tab bị huỷ — `tab-automation-host.ts:2237,2246,2308,2317,2378,2387,2503,2512` vs `:1584`.
4. B38: thêm `buffered` count + compositor-surface diagnosis — `browser-control-port.ts:1202, 2399`; cập nhật predicate `bottlenecks.json:626-638`.
5. Purge 87 fixture rows `issue-register.jsonl:1-53`; archive 8 `.quarantine-*` partitions.
6. Xoá `heap-diff-leg3*.json`, 50+ `.tmp-*` root, `.gitignore` cho soak logs; commit verdict `real-soak-4h-verdict-4hfix9.md` + payload.
7. Refresh `lastVerifiedAt` B21, B34–B38.
8. Test cho renderer dispatcher globals + extension handshake backoff (`src/extension/background.ts:36-81`).

## Đã loại bỏ / không xác minh được

- CandA claim về 5 file `.diff` ở root: **không tồn tại** tại HEAD (chép nhầm từ handoff 18/09).
- CandE claim `site-clone` skill vi phạm §3.1: file nằm ở `~/.claude/skills/` (global), ngoài repo — ghi nhận nhưng không phải repo defect.
- CandD "B38 đã sửa xong": **đính chính** — chỉ bỏ `readyState > 2`, chưa đủ điều kiện đóng ledger.

## Câu hỏi mở

1. Có symbolize được PDB cho Electron 43.4.0 x64 cho 3 dump P0, hay chốt `--disable-gpu` / native dialog guard?
2. Nâng `FREEZE_SLO.peakTotalWorkingSetMB` 1600→1750 MB hay ép baseline <1450 MB?
3. 5 probe scripts (`probe-renderer-*.cjs`) — archive vào `scripts/probes/` hay xoá?
4. Maintainer duyệt purge 87 fixture rows + archive quarantine partitions?
