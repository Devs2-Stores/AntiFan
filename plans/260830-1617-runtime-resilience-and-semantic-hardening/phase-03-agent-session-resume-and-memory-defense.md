---
phase: 3
title: "Conditional Agent Session Resume & ArtifactStore Retention Cleaner"
status: completed
priority: P2
effort: "2-3d"
dependencies: ["phase-02-snapshot-first-terminal-and-async-qa"]
---

# Phase 3: Conditional Agent Session Resume & ArtifactStore Retention Cleaner

<!-- Updated: Validation Session 1 - Startup + Idle sweep trigger confirmed -->

## Overview
Nâng cao tính bền vững khi vận hành dài lâu: Triển khai bộ điều phối phục hồi phiên Agent có điều kiện (*"nếu provider AI / backend hỗ trợ"*) bằng cách ghi manifest phiên ra đĩa; và bổ sung module `ArtifactRetentionCleaner` tự động dọn dẹp các file `.artifact` cũ trong `ArtifactStore` theo TTL (24 giờ) hoặc giới hạn dung lượng tổng ($200\text{ MB}$) chạy vào lúc khởi động và định kỳ khi idle.

---

## Requirements

### Functional:
1. **Conditional Agent Session Resume (`SessionResumeController`)**:
   - Ghi file manifest phiên `%APPDATA%/antifan-browser-desktop/sessions/<sessionId>.json` mỗi khi tạo/cập nhật phiên PTY.
   - Khi khởi động lại ứng dụng:
     - Kiểm tra nếu tiến trình agent cũ còn sống (OS PID probe) và provider AI hỗ trợ resume $\to$ tự động gắn lại PTY stream.
     - Nếu tiến trình đã tắt hoặc provider không hỗ trợ $\to$ nạp transcript cũ ở chế độ chỉ đọc và hiển thị nhãn `[Session Restored - Read Only]`.
2. **ArtifactStore Retention Cleaner (`ArtifactRetentionCleaner`)**:
   - Tự động kích hoạt 1 lần khi khởi động app + định kỳ mỗi 1 giờ khi app ở trạng thái Idle (không chặn luồng khi đang stream).
   - Tự động xóa các file có tuổi thọ $> 24\text{ giờ}$ hoặc khi tổng dung lượng thư mục $> 200\text{ MB}$ (ưu tiên giữ file mới nhất theo LRU).

### Non-Functional:
- Quét dọn đĩa chạy ngầm, không gây nghẽn I/O khi agent đang stream.

---

## Architecture

```
+---------------------------------------------------------------------------------+
|                       Session Resume & Disk Retention Architecture              |
|                                                                                 |
|  [App Shutdown / Crash] ---> Write Session Manifest                             |
|                              - sessionId, cwd, capsuleId, lastCommandDigest     |
|                              - Saved in: %APPDATA%/sessions/<id>.json           |
|                                                                                 |
|  [App Restart]          ---> SessionResumeController.scan()                     |
|                              ├── 1. Probe PID liveness (OS Process Check)       |
|                              ├── 2. Check AI Provider Resume Capability         |
|                              ├── If YES -> Re-attach to running PTY             |
|                              └── If NO  -> Fallback to Fresh Session + History  |
|                                                                                 |
|  [Artifact Retention]   ---> ArtifactRetentionCleaner.sweep()                   |
|                              ├── Trigger: App Startup + Hourly Idle Timer       |
|                              ├── Max Directory Budget: 200 MB                   |
|                              ├── Max File Age (TTL): 24 Hours                   |
|                              └── Unlink stale .artifact binary files            |
+---------------------------------------------------------------------------------+
```

---

## Related Code Files
- Create: `src/main/agent/session-resume-controller.ts` (Quản lý manifest và liveness probe)
- Create: `src/main/tools/artifact-retention-cleaner.ts` (Quét dọn file artifact theo TTL/LRU)
- Modify: `src/main/tools/artifact-store.ts` (Tích hợp cleaner vào chu kỳ lưu)
- Modify: `src/main/browser/terminal-manager.ts` (Lưu manifest khi session thay đổi)
- Test: `test/main/workspace-file-port.test.ts` (Kiểm chứng dọn dẹp file và đọc manifest)

---

## Implementation Steps

1. **Xây dựng `ArtifactRetentionCleaner` (`src/main/tools/artifact-retention-cleaner.ts`)**:
   ```typescript
   export class ArtifactRetentionCleaner {
     public static sweep(rootDir: string, maxBytes = 200 * 1024 * 1024, maxAgeMs = 24 * 3600 * 1000) {
       // Quét các file .artifact, sắp xếp theo mtime
       // Xóa file quá hạn maxAgeMs hoặc vượt quá maxBytes
     }
   }
   ```
2. **Xây dựng `SessionResumeController` (`src/main/agent/session-resume-controller.ts`)**:
   ```typescript
   export interface SessionManifest {
     sessionId: string;
     workspaceRoot: string;
     lastPid?: number;
     createdAt: number;
     updatedAt: number;
   }
   ```
   - Hỗ trợ kiểm tra `isProcessAlive(pid)` đa nền tảng.
3. **Tích hợp vào `TerminalManager` & `ArtifactStore`**:
   - Ghi manifest khi tạo/tắt session.
   - Kích hoạt `ArtifactRetentionCleaner.sweep()` khi khởi tạo app và định kỳ qua idle timer.
4. **Kiểm thử tự động**:
   - Viết unit test tạo các file giả lập quá 24h và kiểm tra cleaner xóa chính xác.

---

## Success Criteria
- [ ] Manifest phiên OMP được ghi/đọc đầy đủ qua các lần tắt/mở ứng dụng.
- [ ] Thư mục `.antifan/artifacts/` tự động được dọn dẹp khi khởi động và idle, không vượt quá giới hạn 200MB.
- [ ] Toàn bộ unit test kiểm thử dọn dẹp chạy xanh.

---

## Risk Assessment
- **Rủi ro:** Xóa nhầm file artifact đang được một phiên OMP khác đọc.
- **Biện pháp:** Không bao giờ xóa file có thời gian sửa đổi (mtime) dưới 1 giờ dù thư mục đầy.
