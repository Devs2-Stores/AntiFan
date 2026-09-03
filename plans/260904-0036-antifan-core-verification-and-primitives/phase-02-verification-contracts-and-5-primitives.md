---
phase: 2
title: "Verification Contracts & 5 Primitives"
status: complete
priority: P1
effort: "1.5d"
dependencies: ["phase-01"]
---

# Phase 2: Verification Contracts & 5 Primitives

## Overview
Giai đoạn này quy tụ toàn bộ năng lực của AntiFan Core về **Ngũ Đại Nguyên Thủy (5 Lean Primitives)**: `OBSERVE`, `CONTROL`, `RECORD`, `COMPARE`, `VERIFY`. Đồng thời, giai đoạn này xây dựng **Verification Contract Engine** và mở rộng cấu trúc `IssueRegister` singleton để lưu trữ hồ sơ bằng chứng (`ProofProfile`), loại bỏ hoàn toàn ý tưởng xây dựng Claim Ledger subsystem cồng kềnh.

## Requirements
- Functional:
  - Phân loại rõ ràng 5 Primitives trong interface của Core:
    1. `OBSERVE`: DOM, computed styles, bounding box, screenshot, trace.
    2. `CONTROL`: Tab lifecycle, PTY process, media freeze, isolation.
    3. `RECORD`: Lưu trữ Evidence, Provenance, DocumentGeneration, Freshness.
    4. `COMPARE`: Tính toán sai số Pixel Diff, Delta Height, Bbox overlap.
    5. `VERIFY`: Đối chiếu Evidence với Verification Contract.
  - Xây dựng kiểu dữ liệu `VerificationContract`:
    $$\text{Deterministic Evidence} + \text{Semantic Evidence} + \text{Policy} \xrightarrow{\text{Contract Evaluation}} \text{Verdict}$$
  - Mở rộng `IssueRegister` singleton với các trường `claim`, `proofObligations`, `proofProfile`, `verdict`, `inconclusiveReason`.
  - Triển khai cỗ máy 5 trạng thái: `VERIFIED`, `PARTIAL`, `REJECTED`, `INCONCLUSIVE`, `UNVERIFIED`.
- Non-functional:
  - Thao tác ghi và đọc bằng chứng trong `IssueRegister` đạt hiệu năng $\le 2\text{ms}$ (in-memory + append-only JSONL).
  - Không sinh thêm bất kỳ database subsystem nào (không SQLite DB riêng, không EventStore, không GraphDB).

## Architecture
```text
           ┌───────────────────────────────────────────────┐
           │                 ANTIFAN CORE                  │
           │                                               │
           │  1. OBSERVE (browser.dom, inspectStyles...)    │
           │  2. CONTROL (browser.navigate, mediaFreeze...) │
           │  3. RECORD  (IssueRegister, ArtifactStore)     │
           │  4. COMPARE (styleDiff, visualCompare...)     │
           │  5. VERIFY  (evaluateVerificationContract)     │
           └───────────────────────┬───────────────────────┘
                                   │
                                   ▼
                      VerificationContract Evaluator
        ┌──────────────────────────┼──────────────────────────┐
        ↓                          ↓                          ↓
  Deterministic Metric       Semantic Witness          Workflow Policy
  (CSS, Bbox, Console)       (LLM Role Assertion)      (Tolerance, Scope)
        │                          │                          │
        └──────────────────────────┼──────────────────────────┘
                                   │
                                   ▼
             IssueRegister: VerificationRecord Entry
   [ID, Claim, ProofProfile, Provenance, Verdict: VERIFIED/INCONCLUSIVE...]
```

## Related Code Files
- Create: `src/main/verification/verification-contract.ts`
- Create: `src/main/verification/verification-evaluator.ts`
- Modify: `src/main/session/issue-register.ts` (Owning file: Thêm `VerificationRecord`, `VerificationVerdict`, `StalemateState`, và storage riêng tách bạch với `IssueRecord.status`)
- Modify: `src/main/tools/browser-capabilities.ts` (Expose capability wrappers delegating to `IssueRegister.getInstance()`)
- Modify: `src/main/tools/browser-control-port.ts`
- Modify: `src/shared/contracts.ts`
## Implementation Steps
1. **Định nghĩa Interface Verification Contract & Proof Profile:**
   - Trong `src/main/verification/verification-contract.ts`, định nghĩa cấu trúc:
     ```typescript
     export interface ProofProfile {
       completeness: 'FULL' | 'PARTIAL' | 'EMPTY';
       freshness: 'FRESH' | 'STALE';
       determinism: 'CODE_METRIC' | 'SEMANTIC_WITNESS' | 'UNCHECKED';
       coverage: { desktop: boolean; tablet: boolean; mobile: boolean; interactionStates: string[] };
       provenance: { toolName: string; timestamp: number; artifactId?: string };
     }
     export interface VerificationContract {
       claim: string;
       scope: { tabId: string; selector?: string; viewport?: string };
       proofObligations: Array<{ id: string; metric: string; tolerance?: number }>;
       policy: { maxDeltaPercent?: number; requireQuiescence?: boolean };
     }
     ```
2. **Mở rộng `IssueRegister` Singleton Tại Owning File (`src/main/session/issue-register.ts`):**
   - Giữ nguyên `IssueRecord.status: 'OPEN' | 'RESOLVED' | 'BYPASSED'` để đảm bảo backward compatibility tuyệt đối với hệ thống diagnostics và tool `anti.diagnostics.*`.
   - Định nghĩa model xác minh riêng biệt trong `src/main/session/issue-register.ts`:
     ```typescript
     export type VerificationVerdict = 'VERIFIED' | 'PARTIAL' | 'REJECTED' | 'INCONCLUSIVE' | 'UNVERIFIED';
     export type InconclusiveReason = 'RESAMPLE' | 'NEED_INPUT' | 'UNOBSERVABLE' | 'UNSUPPORTED';
     export type StalemateState = 'ACTIVE' | 'STALEMATE' | 'EXEMPTION_WAIVED';

     export interface VerificationRecord {
       id: string;
       claim: string;
       actor: 'agent' | 'user';
       scope: { tabId: string; selector?: string; viewport?: string };
       proofObligations: Array<{ id: string; metric: string; tolerance?: number }>;
       proofProfile?: ProofProfile;
       verdict: VerificationVerdict;
       inconclusiveReason?: InconclusiveReason;
       stalemateState?: StalemateState;
       exemptionReason?: string;
       timestamp: number;
       timeFormatted: string;
       linkedIssueId?: string;
     }
     ```
   - Trong class `IssueRegister`, bổ sung `private readonly verifications: VerificationRecord[] = [];` cùng các API tương ứng: `recordVerification(record)`, `listVerifications(filter)`, và `updateVerificationStalemate(claimId, state, exemptionReason)`.
   - Trong `src/main/tools/browser-capabilities.ts`, chỉ đăng ký các tool wrapper MCP (`anti.verification.record_claim`, `anti.verification.list`) gọi sang `IssueRegister.getInstance()`.
3. **Triển khai `VerificationEvaluator`:**
   - Đánh giá bằng chứng cơ học trước: Kiểm tra tính tươi mới (`documentGeneration`), tính toàn vẹn và dung sai sai số.
   - Nếu bằng chứng cơ học fail $\to$ Phát `REJECTED`.
   - Nếu môi trường chưa ổn định $\to$ Phát `INCONCLUSIVE` kèm lý do (`RESAMPLE`, `NEED_INPUT`, `UNOBSERVABLE`, `UNSUPPORTED`).
   - Chỉ khi mọi điều khoản cơ học đạt chuẩn và nhân chứng ngữ nghĩa (nếu có) xác nhận $\to$ Cấp `VERIFIED`.

## Success Criteria
- [x] Interface 5 Primitives được phân định rõ ràng trong mã nguồn.
- [x] `VerificationEvaluator` xử lý chuẩn xác 5 trạng thái phán quyết, không cho phép LLM tự ý nâng hạng thành `VERIFIED` khi bằng chứng cơ học thất bại.
- [x] `IssueRegister` lưu trữ và truy xuất thông suốt các bản ghi nghiệm thu mà không gây chậm hệ thống.

## Risk Assessment
- *Nguy cơ:* Bằng chứng ngữ nghĩa từ LLM bị chậm trễ gây nghẽn luồng xử lý của Verifier.
- *Tín hiệu nhận biết:* `evaluateVerificationContract` mất $> 5\text{s}$ để trả về kết quả.
- *Phản ứng dự phòng:* Đặt timeout cho nhánh Semantic Witness (tối đa 3s); nếu quá hạn $\to$ Trả về `INCONCLUSIVE(reason: 'NEED_INPUT')` thay vì treo cả Core.
