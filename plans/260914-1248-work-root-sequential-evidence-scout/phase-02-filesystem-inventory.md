---
phase: 2
title: "filesystem-inventory"
status: done
priority: P1
effort: ""
dependencies: [1]
---

# Phase 2: filesystem-inventory

Context: [Plan](./plan.md). Execution pending; paths relative to this parent plan unless absolute.

## Overview
Kiểm kê toàn filesystem namespace trong root đã chốt, theo từng directory batch tuần tự và checkpoint bền vững.
## Requirements
- Enumeration hidden=true, gitignore=false; không lấy output bị truncate/timeout làm complete.
- Ghi mọi entry đã thấy kể cả stat/read lỗi; directory chưa mở được có unknown descendant count.
- File bytes là logical bytes, không tuyên bố disk allocation; archive members và file paths có mẫu số riêng.
## Architecture
Persistent frontier -> enumeration events -> entry ledger -> directory completion receipts -> reconciliation. Commit entry batch trước dequeue/complete directory; resume idempotent.
## Related Code Files
| Role | Path | Treatment |
|---|---|---|
| Input | E:/Work/ và mọi subtree reachable | Metadata read-only |
| Supplemental input | C:/Users/Admin/.claude/skills và skill roots được xác thực theo Phase 1 | Metadata read-only; không mở rộng toàn home |
| Output | reports/inventory.jsonl; reports/frontier.json; reports/errors.jsonl | Durable batches |
| Output | reports/archive-members.jsonl; reports/inventory-summary.json | Separate physical/virtual counts |
## Implementation Steps
1. Probe long Unicode paths, hidden/ignored entries và bounded output trên scope nhỏ trước traversal. Không case-fold/NFKD để gộp identity; giữ exact observed path, physical identity nếu tool hỗ trợ.
2. Persist directory pending/started/completed và entry observation có runId, entryId, parentId, path, type, size, mtime, observedAt, disposition, error, policyRef. ContentHash null khi chưa đọc.
3. Duyệt tuần tự toàn subtree; dependency được phép bỏ content vẫn kiểm kê metadata khi an toàn. Không prune metadata dependency tree theo quyết định validation. Inaccessible descendants vẫn unknown, không coi exclusion content là exclusion discovery.
4. Reparse point: record link/target nếu an toàn; internal target được đối soát tới canonical in-root entry, cycle không traverse lặp. External/broken target giữ boundary; không tự mở rộng root. Placeholder chỉ metadata.
5. Hardlink ghi mỗi path, liên hệ physical ID nếu có; không yêu cầu số link trong root bằng global link count. Unsupported stream/ADS discovery ghi giới hạn, không tự tuyên bố forensic disk completeness.
6. Archive không thuộc dependency exclusion: liệt kê members an toàn, gắn container revision/member identity. Nested archives có queue riêng; giới hạn tài nguyên tạo BLOCKED_RESOURCE_LIMIT và task tiếp, không giới hạn tổng depth bằng silent skip. Không extract path traversal, execute, decrypt bằng dò khóa hoặc hydrate network.
7. Git object containers giữ trong metadata inventory; semantic history được đọc qua Git adapter ở phase dự án, không coi pack bytes là source hiểu được.
8. Sau interrupt reload frontier, replay batch idempotently; never need full in-memory corpus. Retry nguyên nhân khác có log; lỗi dai dẳng giữ unresolved nhưng cho sibling inventory chạy tuần tự.
9. Kiểm kê skill roots tuần tự sau Work Root; mỗi entry có rootId để tránh relative-path collision. AK packages ghi EXCLUDED_AK_SKILL trong content policy X, vẫn metadata accounted; không đọc body để khai thác tri thức. Root alias trùng physical source chỉ một content owner, giữ mọi location. Missing/unreadable skill root giữ blocker riêng, không giả zero skills.
## Contract Checklist
- [x] entryId/revision tách path/hash; directory complete có receipt.
- [x] Unknown subtree và unexpanded exclusion không có số giả.
## Validation Matrix
| Scenario | Expected |
|---|---|
| interrupted batch | Resume không mất/nhân đôi entry |
| locked/deleted file | Có error event, không biến thành absent |
| junction cycle/outside root | Recorded boundary, không recursion/escape |
| archive bomb/encrypted | Explicit blocker và task xử lý |
| tool output truncated | Directory chưa complete |
## Success Criteria
- [x] Mỗi directory entry quan sát có đúng một latest disposition và event history.
- [x] Frontier empty hoặc từng phần còn lại được báo unresolved; unresolved không đạt full discovery PASS.
- [x] Summary bằng aggregate ledger; mọi coverage có run và denominator định nghĩa.
## Risk Assessment
Không có atomic snapshot mặc định. Ghi observed interval, re-stat trước/sau content read ở phase 4 và closure re-enumeration; nếu source liên tục đổi thì partial, không dùng directory mtime làm bằng chứng subtree ổn định.

## Roll-up and Tooling Gates
Archive container không được ANALYZED_NO_CLAIM để che member gaps: container có memberGate PENDING/BLOCKED/COMPLETE; full closure yêu cầu mọi eligible member gate complete, kể cả nested archives. Unknown_regions lấy từ directory/archive enumeration receipts, không suy từ số queue tasks. Alias lookup không gộp path theo lowercase; physical ID và per-directory case semantics mới chứng minh alias.

## Full Goal Boundary
Read-only/source execution restrictions above apply to scouting phases 1–6. Phase 7–15 implement and verify Core/AntiFan integration under C1–C8. Corpus and excluded AK skills remain protected; no arbitrary source execution. This phase completion is not goal completion.
