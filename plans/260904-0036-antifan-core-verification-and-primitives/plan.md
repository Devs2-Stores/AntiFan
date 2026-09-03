---
title: "AntiFan Core Runtime Verification, 5 Primitives & Verification Contracts"
description: "Kế hoạch kỹ thuật triển khai kiến trúc AntiFan Universal Web/UI Runtime theo bản đại chốt: xác nhận Core Runtime, thiết lập Ngũ Đại Nguyên Thủy, Verification Contract Engine và 4 chốt chặn cơ học."
status: pending
priority: P1
effort: "5d"
tags: ["antifan", "core", "verification-authority", "anti-hallucination", "primitives"]
created: 2026-09-04
---

# AntiFan Core Runtime Verification, 5 Primitives & Verification Contracts

## Overview

Kế hoạch này hiện thực hóa toàn bộ các quyết sách đã được đồng thuận trong Bản Đại Tổng Hợp (Grand Synthesis):
1. Đóng băng Core Runtime, xác nhận tính toàn vẹn của các thành phần đã xuất xưởng (`ExecutionControl` và `browser.wait`), và thiết lập bằng chứng thực nghiệm cho bài test Windows soak dài hạn.
2. Thiết lập **Ngũ Đại Nguyên Thủy (5 Lean Primitives)** trong Core: `OBSERVE`, `CONTROL`, `RECORD`, `COMPARE`, `VERIFY`.
3. Triển khai **Verification Contract Engine** kết hợp bằng chứng cơ học (Deterministic Code) và nhân chứng ngữ nghĩa (Semantic Witness từ LLM/Vision), quản lý qua Hồ sơ Bằng chứng 4 chiều (`ProofProfile`) trong `IssueRegister`.
4. Thiết lập **4 Chốt Chặn Cơ Học**: Canonical Proof Templates, `StabilityPolicy`, DocumentGeneration Barrier, và Target Boundary Masking.
5. Triển khai Hệ thống Cổng Kiểm chuẩn Đa tầng (`SPEC_READY`, `LAYOUT_READY`, `RESPONSIVE_READY`, `INTERACTION_READY`, `MOTION_READY`) và chứng thực toàn bộ ma trận Benchmark A–F.

## Goals

| # | Goal | Priority |
|---|------|----------|
| 1 | Xác thực độ tin cậy của Core Runtime trên Windows 11 qua bài test soak 45 phút và phân loại dứt điểm cơ chế settlement | P1 |
| 2 | Quy tụ năng lực Core về Ngũ Đại Nguyên Thủy (`OBSERVE`, `CONTROL`, `RECORD`, `COMPARE`, `VERIFY`) và cô lập ranh giới nhận thức | P1 |
| 3 | Xây dựng Verification Contract Engine với 5 trạng thái phán quyết (`VERIFIED`, `PARTIAL`, `REJECTED`, `INCONCLUSIVE`, `UNVERIFIED`) | P1 |
| 4 | Cài đặt 4 Chốt chặn Cơ học và Circuit Breaker `VERIFICATION_STALEMATE` chống Livelock | P1 |
| 5 | Module hóa 5 cổng nghiệm thu cơ học trong Core và vượt qua bài test Benchmark F (Anti-Hallucination Barrier) | P1 |

## Phases

| # | Phase | Status | Priority | Effort |
|---|-------|--------|----------|--------|
| 1 | [Phase 1: Core Runtime Verification & Soak Baseline](./phase-01-start.md) | Complete | P1 | 1d |
| 2 | [Phase 2: Verification Contracts & 5 Primitives](./phase-02-verification-contracts-and-5-primitives.md) | Complete | P1 | 1.5d |
| 3 | [Phase 3: Semantic Evidence Lean & Mechanical Guardrails](./phase-03-semantic-evidence-and-mechanical-guardrails.md) | Complete | P1 | 1.5d |
| 4 | [Phase 4: Modular Gates & Benchmark Certification](./phase-04-modular-gates-and-benchmark-certification.md) | Complete | P1 | 1d |

## Success Criteria

- [ ] Bài test Windows soak 45 phút chạy trơn tru với zero tiến trình con `node-pty` mồ côi và rò rỉ RAM Electron $\le 30\text{MB}$ (baseline quick-workload đã xác lập; kịch bản 45m soak sẵn sàng).
- [x] Mọi capability execution context đều nhận `signal` và `control` xuyên suốt từ `capability-transport.ts`.
- [x] `IssueRegister` singleton được mở rộng để lưu trữ `ProofProfile`, `proofObligations`, và `verdict` mà không sinh thêm subsystem DB cồng kềnh.
- [x] Core hoàn toàn sạch bóng các engine nhận thức (`VisualEntityEngine`, `SpatialSemanticGraph`); chỉ lưu trữ `VisualRegion` thô và nhận định ngữ nghĩa của OMP kèm provenance.
- [x] Circuit breaker `VERIFICATION_STALEMATE` kích hoạt chuẩn xác sau khi vượt `RetryBudget`, cấm con người làm giả trạng thái `VERIFIED`.
- [x] Vượt qua Benchmark F: Verifier đánh chặn thành công mọi claim sai lệch từ Agent và trả về `REJECTED`/`PARTIAL`.

<!-- slug: antifan-core-verification-and-primitives -->
