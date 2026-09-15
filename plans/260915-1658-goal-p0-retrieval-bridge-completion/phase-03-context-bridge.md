---
phase: 3
title: "Context Bridge — Core context vào OMP agent turn"
status: done
priority: P0
effort: ""
dependencies: [2]
---

# Phase 3: Context Bridge — Core context vào OMP agent turn

## Overview
Locked contract items: C5, C6. Block 1. Ứng với upstream phase 12 ("AntiFan and OMP integration") và P0-A của MASTER UPGRADE.

Mục tiêu: task OMP thật nhận được Core pack trong turn, pack **sống qua compaction**, và khi Core/AntiFan không sẵn sàng thì **session vẫn chạy tiếp** (fail-open) — không bao giờ treo agent vì Core.

Hiện trạng: `contextPack` mới chỉ được gọi advisory trong `scripts/clone-site.mjs` (một script), **chưa** vào đường agent turn. Grep `taskRunId|task_run|bridge_events|context_bindings|ompSessionId|ompTurnId` trên `src/ scripts/ packages/` = **0 hit** → spine chưa tồn tại.

## Requirements

### R1 — Transport: dùng boundary đã có, không thêm network surface
- Bridge gọi `scripts/antifan-core.cjs <cmd> '<json>'` (92 dòng, đã phơi `pack`/`query`/`receipt`/`recommend`).
- CLI đã tự trả `{"available":false,"reason":"..."}` và exit 2 khi Core không nạp được → **tín hiệu fail-open đã có sẵn**, không cần phát minh.
- **Không** thêm route RPC mới vào bridge HTTP (bridge hiện chỉ có `/status` và các `/api/*` cụ thể).

### R2 — Hook đặt đúng chỗ được nạp
- Đặt tại `.omp/hooks/pre/antifan-core-bridge.ts`.
- **Bẫy đã xác minh**: factory đặt **trực tiếp** trong `.omp/hooks/` sẽ **không được nạp và không báo lỗi**. Bắt buộc nằm trong `pre/` hoặc `post/`.
- `.omp/hooks/` hiện **chưa tồn tại** → tạo mới là thay đổi additive.
- Giữ nguyên `.omp/extensions/antifan-fix-guard` — không sửa extension đang chạy.

### R3 — Seed đúng một message, không re-inject mỗi turn
- `before_agent_start` trả **một** message chứa pack. Hợp đồng runtime đã xác minh: **chỉ message đầu tiên được giữ**, các message sau bị bỏ.
- **Không** re-inject mỗi turn: điều đó gây pack spam, đuổi prompt cache, và ghép độ trễ cross-process vào mọi lượt.
- `context` là lever mỗi call (chuỗi thay thế `messages`) — dùng nó để **giữ ngân sách**, tức loại các pack injection cũ đã hết hạn.

### R4 — Sống qua compaction
- `session.compacting` trả `preserveData` chứa `packId`, `coreRelease`, `taskHash` để danh tính pack không mất khi nén context.
- Kèm `session_before_compact` nếu cần chặn/huỷ theo hợp đồng runtime.

### R5 — Fail-open có bằng chứng, không im lặng
- Core/AntiFan không sẵn sàng, timeout, hoặc CLI exit 2 → session **chạy tiếp**, và phát **đúng một** event `BRIDGE_CONTEXT_FAILED` cho mỗi session (dedupe, không phải mỗi call).
- Có timeout cứng cho spawn; không chờ vô hạn.

### R6 — Chính sách theo loại hành động
- Task **advisory** → được chạy tiếp, có nhãn "không có Core context".
- Hành động **receipt-required** → **từ chối** khi Core unavailable. Không được hạ cấp thành advisory im lặng.

### R7 — Danh tính và quyền lan truyền
- `taskHash`, danh tính project (theo project root, không theo `cwd` mù), và `permissionScope = 'eligible-content-only'` phải đi cùng pack vào message.
- Core **không** được nâng quyền cho task.

## Architecture
```
OMP session
  ├─ before_agent_start ─→ [Core Bridge hook] ─→ antifan-core.cjs pack ─→ 1 message (pack)
  ├─ context (per call)  ─→ budget: strip stale pack injections
  ├─ session.compacting  ─→ preserveData {packId, coreRelease, taskHash}
  └─ (Core unavailable)  ─→ no message + exactly 1 BRIDGE_CONTEXT_FAILED
```

## Related Code Files
- `.omp/config.yml` — đang nạp `./.omp/extensions/antifan-fix-guard`.
- `.omp/extensions/antifan-fix-guard/index.ts` — extension đang chạy; `ExtensionAPI` đã có overload `on?(event: string, handler)` nên **không cần sửa core** để nhận event mới.
- `.omp/extensions/antifan-fix-guard/hooks/pre/tool-guard.ts` — quy ước `hooks/<phase>/<name>.ts` của repo.
- Đề xuất tạo: `.omp/hooks/pre/antifan-core-bridge.ts` — **đề xuất ownership**, chưa khẳng định module tồn tại.
- `scripts/antifan-core.cjs` — CLI Core (`pack`/`query`/`receipt`), DB path `SUPER_CORE_DB || <cwd>/.super-core/core.db`, nạp `packages/super-core/dist/index.js`.
- `scripts/clone-site.mjs` — caller advisory hiện có của `contextPack`.
- `src/main/` — authority/identity phía AntiFan cần trace trước khi sửa (MCP registration, `scripts/check-mcp-budget-dominance.mjs`).

## Implementation Steps
1. Trace `scripts/antifan-omp-mcp.cjs`, `scripts/antifan-agent.cjs`, `scripts/check-mcp-budget-dominance.mjs` và vòng đời authority của Main **trước** khi thêm bất kỳ tool nào.
2. Xác nhận cơ chế nạp hook: `.omp/hooks/pre/` (đường native) và/hoặc `omp.extensions` trong package (đường extension). Chọn một, ghi lý do.
3. Viết bridge hook: spawn CLI có timeout, parse JSON, trả đúng một message ở `before_agent_start`.
4. Thêm `context` handler giữ ngân sách: loại pack injection cũ, **không** thêm mới mỗi turn.
5. Thêm `session.compacting` giữ `preserveData`.
6. Thêm dedupe + phát `BRIDGE_CONTEXT_FAILED` đúng một lần/session.
7. Cài chính sách advisory vs receipt-required khi Core unavailable.
8. **Probe thứ tự load**: nếu extension khác cũng trả message ở `before_agent_start`, xác định ai thắng (hợp đồng: message đầu tiên được giữ).
9. Chạy session OMP thật trong workspace local cô lập; thu bằng chứng load + side effect.

## Contract and Test Matrix
- [ ] Session OMP thật nhận pack: có load evidence và side effect quan sát được, chạy trên **surface thật**, không phải echo giả.
- [ ] `packId` bất biến qua compaction.
- [ ] AntiFan/Core tắt → session chạy tiếp, và **đúng một** `BRIDGE_CONTEXT_FAILED` cho cả session.
- [ ] Hành động receipt-required **từ chối** khi Core unavailable; task advisory chạy tiếp có nhãn.
- [ ] Pack không xuất hiện lặp mỗi turn (đếm trong messages qua nhiều turn).
- [ ] Hook đặt sai chỗ (trực tiếp trong `.omp/hooks/`) **không** được nạp — test khẳng định bẫy này để không tái phạm.
- [ ] Không test nào assert wiring/source text; assert hành vi quan sát được.
- [ ] Caller bị ảnh hưởng đã trace trước khi đổi contract.

## Success Criteria
- [ ] Tất cả Requirements R1-R7 delivered và evidence linked.
- [ ] Session OMP thật lấy được pack và trả về verification evidence; project không liên quan bị cô lập; không nâng quyền; không auto-publish.
- [ ] Không mục nào của phase này bị chuyển thành documentation-only; không adapter echo giả.

## Risk Assessment
- **Message bị shadow**: hợp đồng ghi rõ "message đầu tiên được giữ, các message sau bị bỏ" — nếu extension khác trả message trước, bridge có thể **im lặng thua** theo thứ tự nạp. Phải probe và có test khẳng định.
- **Prerequisite đã đo**: trên repo chuẩn `E:/Work/apps/AntiFan`, `packages/super-core/dist/` **đã build** và `.super-core/core.db` **đã populate** (20.832 claims) → bridge **có** dữ liệu để inject. Ghi chú lịch sử: một bản copy tạm trên C: (`…\Temp\antifan-head`) **thiếu** cả dist lẫn DB và probe trả `{"available":false,"reason":"…Cannot find module '../packages/super-core/dist/index.js'"}` — đó là lý do phải chạy trên E:. Root `npm run compile` **không** build `packages/super-core`; nếu dist biến mất, build bằng `npm --prefix packages/super-core run build`.
- `core.db-wal` hiện **174 MB và chưa checkpoint**. Trước khi thêm writer (bridge + runner), phải chốt chế độ WAL/`busy_timeout` để không hỏng đọc.
- Độ trễ spawn Node mỗi lần seed: chấp nhận cho seed một lần/session; **không** áp cho mỗi turn.
- Adapter mismatch → **blocker**, phải giải quyết mọi caller; không dựng control plane song song.
