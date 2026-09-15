---
phase: 5
title: "MCP reliability — catalogue là nguồn duy nhất, parity gate"
status: done
priority: P1
effort: ""
dependencies: [4]
---

# Phase 5: MCP reliability — catalogue là nguồn duy nhất, parity gate

## Overview
Locked contract items: P0-C của MASTER UPGRADE. Block 2.

Mục tiêu: không còn hai nguồn sự thật cho schema tool. Catalogue đã là canonical — việc cần làm là **ép** mọi surface khớp với nó, chứ **không** dựng manifest mới.

Số đo được: **237 capabilities · 116 advertised tools · 21 routing row shadow một registration**. Gate `scripts/check-mcp-budget-dominance.mjs` đã tồn tại và đang pass (`OK: one ceiling dominates every server policy`).

## Requirements
### R1 — Một nguồn schema
- `CapabilityDefinition.inputSchema` (`src/shared/control-plane-contracts.ts:618`) **đã** là nguồn. Không tạo "Canonical Tool Manifest" mới — đó là trùng lặp, không phải cải thiện.
- Mọi surface phơi schema phải **dẫn xuất** từ đây, không chép tay.

### R2 — Parity gate ép được
- Thêm kiểm tra parity vào `scripts/check-mcp-budget-dominance.mjs` để lệch schema làm **fail build**, không lọt.
- Gate phải chứng minh nó bắt được lỗi: cố ý làm lệch schema → gate **fail**.

### R3 — Retire 21 shadow row, mỗi dòng có proof
- **21** routing row đang shadow một catalogue registration. Mỗi dòng phải được xử lý bằng **derive** (trỏ về registration) **hoặc reconciliation** kèm proof riêng.
- Không xoá mù; không để lại dòng nào không giải thích được.
- Ghi vào ledger theo luật B29.
- **Lưu ý số lượng đã dịch chuyển**: row B29 trong `plans/bottlenecks.json` ghi **23** row tại thời điểm nó được viết, và nêu `anti.browser.tabs.list` là một instance **đã sửa**. Gate hiện tại báo **21**. Phải lấy số từ gate tại HEAD, không lấy từ ledger — ledger là evidence lịch sử.
- B29 nói rõ: *"a row's removal is a behaviour change that needs its own proof"* — một số alias `anti.*` là **bản cài lại độc lập** với default khác. Bỏ row là **đổi hành vi**, nên mỗi dòng cần proof riêng. Không được xoá hàng loạt cho đủ số 0.

## Related Code Files
- `src/shared/control-plane-contracts.ts:618` — `CapabilityDefinition.inputSchema` (nguồn duy nhất).
- `scripts/check-mcp-budget-dominance.mjs` — gate cần mở rộng (hiện kiểm budget/ceiling).
- `scripts/generate-mcp-capability-map.mjs` — sinh bản đồ capability.
- `scripts/antifan-omp-mcp.cjs` — MCP server (proxy ceiling 240000 ms; `DEFAULT_CLIENT_TIMEOUT_MS` tại `:595`).
- `plans/bottlenecks.json` — B29 liên quan (luật proof từng dòng).

## Implementation Steps
1. Chạy `node scripts/check-mcp-budget-dominance.mjs` và ghi lại baseline: 237/116/21.
2. Trace ba surface đang khai báo schema (catalogue, `scripts/antifan-omp-mcp.cjs`, proxy) và ghi rõ chỗ lệch.
3. Dẫn xuất surface từ catalogue; xoá khai báo chép tay.
4. Thêm parity check vào gate.
5. Với từng shadow row: quyết định derive hay reconcile; ghi proof từng dòng vào ledger.
6. Test: cố ý làm lệch schema → gate **fail**; khôi phục → gate pass.

## Contract and Test Matrix
- [ ] Gate **fail** khi schema bị cố ý làm lệch. (fail trước khi thêm check)
- [x] **20/20** shadow row có proof từng dòng: mỗi row được đo bằng recording-port probe — 19 row bind **cùng** port method + cùng required + cùng risk với routing target (bỏ row là behaviour-preserving ở tầng port), 1 row lệch thật đã sửa: `anti.agent.cursor.move` khai "move" nhưng registration bind `agentHover` trong khi row route tới `browser.agent-move` (`agentMove`) → registration nay bind `agentMove`. Invariant được assert từng row bởi `test/unit/mcp-core-parity.test.mjs` ("every shadowing routing row agrees with its registration on the port method").
- [ ] **CHƯA ĐẠT — còn 20 row chưa retire.** Đây là mục duy nhất của phase 5 không đạt tiêu chí như viết. Lý do có bằng chứng: retire một row là **đổi wire-name** nên cần proof hành vi riêng (luật B29), và 2 row (`anti.browser.tabs.create`, `anti.agent.sequence`) quảng bá inputSchema **khác** target → bỏ row sẽ chuyển cả payload validation. Không xoá hàng loạt cho đủ số 0. Trạng thái đúng được ghi ở `plans/bottlenecks.json` B29 (predicate `manual`, còn `open`).
- [ ] **Hạng mục 20 (Conformance runner)**: runner chạy được và tái lập được, không chỉ tồn tại.
- [ ] **Hạng mục 22 (Transport test)**: transport bị kiểm bằng hành vi quan sát được, không phải bằng việc module tồn tại.
- [ ] **Hạng mục 23 (Failure/retry test)**: phân loại retry được chứng minh trên lỗi thật (timeout, connection drop), có trace.
- [ ] **Hạng mục 24 (Idempotency test)**: gọi lặp cùng input cho **cùng** kết quả và không tạo hiệu ứng phụ tăng dần.
- [ ] **Hạng mục 25 (MCP health metrics)**: metric có nguồn thật và có `reasonCode`; không phát ra con số khi nguồn trống.
- [ ] Không manifest/authority mới song song với catalogue.
- [ ] `npm run compile` vẫn xanh sau thay đổi gate.
- [ ] Che giấu timeout/ceiling không bị nới để gate pass.
- [ ] Không test nào assert wiring/source text.

## Success Criteria
- [ ] R1-R3 delivered và evidence linked.
- [ ] Một nguồn schema duy nhất, được gate ép.
- [ ] Không mục nào chuyển thành documentation-only.

## Risk Assessment
- Gate nằm trong `npm run compile` (đường compile chạy `check-mcp-budget-dominance.mjs`) → một check quá chặt sẽ chặn mọi build. Ngưỡng phải chốt trước và có đường sửa rõ ràng.
- Nếu một shadow row thật sự cần thiết (không derive được), phải reconcile kèm proof — không được xoá để đạt số 0 cho đẹp.
