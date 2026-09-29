---
title: "Smooth multi-project terminal + project manager"
description: "AntiFan mượt với 5-7 dự án; trình quản lý dự án có CRUD"
status: pending
priority: P1
effort: "~3 tuần"
tags: [performance, terminal, electron, project-windows, ui]
created: 2026-09-28
---

# Smooth multi-project terminal + project manager

## Overview
Giữ kiến trúc multi-window (spec `docs/superpowers/specs/2026-09-27-project-windows-design.md`: 3 màn hình, xem đồng thời). Sửa nghẽn main thread, định tuyến O(1), batching, backpressure, lazy xterm, hibernate tab Chrome nền 15 phút; thay native dialog bằng project manager có CRUD.
Research: `plans/reports/research-260928-terminal-smooth-5-7-projects.md`.

## Contract
- **Outcome:** 7 dự án mở, terminal + Chrome mượt; quản lý dự án trong app.
- **Constraints:** Level 0 AGENTS.md; không xoá file dự án; không push theme; giữ kiểm tra quyền ở main (keystroke đi qua main); capture nền phải còn chạy.
- **Non-goals:** gộp 1 cửa sổ (chỉ xét lại nếu phase 11 fail vì RAM); data plane daemon→renderer trực tiếp; WebGL (B37); nhân bản dự án.
- **Acceptance:** gates phase 11.

## Rejected alternatives
- **1 cửa sổ + tear-off:** không chữa nghẽn statSync; user 3 màn hình sẽ tách lại.
- **MessagePort daemon↔renderer:** mọi nguồn lập port qua `utilityProcess.fork` + `child.postMessage(..., [port])`. Daemon AntiFan là tiến trình detached `ELECTRON_RUN_AS_NODE` nối WS (`daemon-entry.ts`, `daemon-client.ts`); main không thể chuyển MessagePort vào tiến trình nó không fork. Muốn làm phải respawn daemon thành `utilityProcess` → mất tính sống sót qua restart GUI. Đổi lấy đó không đáng khi nghẽn thật là statSync + fan-out.
- **WS trực tiếp daemon→renderer:** bỏ qua kiểm tra quyền ở main.

## Phases
| # | Phase | Depends | Status |
|---|-------|---------|--------|
| 01 | [Baseline Instrumentation](./phase-01-start.md) | — | Pending |
| 02 | [Picker Root-Cause Repro](./phase-02-picker-root-cause-repro.md) | — | Pending |
| 03 | [Zero-I/O Affiliation Cache](./phase-03-zero-io-affiliation-cache.md) | 1 | Pending |
| 04 | [O(1) Session Routing](./phase-04-o1-session-routing.md) | 3 | Pending |
| 05 | [Daemon Output Batching](./phase-05-daemon-batching.md) | 3 | Pending |
| 06 | [Session Broadcast Pruning (P3, off critical path)](./phase-06-session-broadcast-pruning.md) | 4 | Pending |
| 07 | [Renderer Lazy Xterm](./phase-07-renderer-lazy-xterm.md) | 4 | Pending |
| 08 | [End-to-End Backpressure](./phase-08-end-to-end-backpressure.md) | 4,5,7 | Pending |
| 09 | [Chrome Tab Hibernation (15 phút)](./phase-09-chrome-tab-hibernation.md) | 1 | Pending |
| 10 | [Project Manager UI + CRUD](./phase-10-project-manager-ui-crud.md) | 2 | Pending |
| 11 | [Certification 7 Projects](./phase-11-certification-7-projects.md) | 3,4,5,7,8,9,10 | Pending |
| 12 | [Code Review --ultra --pending --advice](./phase-12-code-review-ultra.md) | 11 | Pending |
| 13 | [Test --ultra --advice](./phase-13-test-ultra.md) | 12 | Pending |

## Success Criteria
- [ ] Main event-loop p99 < 50ms khi burst ở N=7
- [ ] statSync trên data path = 0
- [ ] WS frames ≥10× ít hơn baseline
- [ ] Keystroke→echo p95 ≤ 100ms với build nền
- [ ] 0 mất output (journal seq)
- [ ] RSS N=7 giảm, đo được
- [ ] `window.background-surface-and-capture-ready` pass
- [ ] Project manager: tạo/mở/đổi tên/bỏ khỏi danh sách, không xoá file
- [ ] Code review ultra: 0 blocker; test ultra xanh

## Red-team (kongming) applied
Sửa: dòng trích dẫn phase 3; route popout/Unassigned phase 4; tránh double-batching phase 5; phase 6 hạ P3; suppress IPC ở main phase 7; phase 8 dùng kênh ack có sẵn + seq window + ring buffer (winpty mặc định, verified); phase 9 recreate qua switchTab/restoreTabs + mobileView; phase 10 đi qua ProjectCloseCoordinator.

## Open Questions
- Authority của tên dự án: capsule hay registry — quyết định phase 10.

<!-- slug: smooth-multi-project-terminal -->
