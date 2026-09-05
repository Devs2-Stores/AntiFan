# BÁO CÁO ĐÁNH GIÁ KỸ THUẬT COMMIT `f041ffc` & KẾ HOẠCH TRIỂN KHAI THEO ROADMAP

**Dự án:** AntiFan Theme Engineering Cockpit (`Devs2-Stores/AntiFan`)  
**Commit kiểm tra:** `f041ffc55db555097ae37c0f75502af69a653199`  
**Ngày đánh giá:** 2026-09-05  
**Môi trường:** Windows 11 Pro, Node.js v22.18.0, TypeScript, Electron, Chromium  

---

## 1. TỔNG QUAN & BỐI CẢNH KIẾN TRÚC

Commit `f041ffc` (`feat(native-messaging,security): restore native messaging host, secure extension pipeline, add e2e failure tests`) tác động lên 25 files (+2,791 dòng, -263 dòng). 

Mục đích chính của commit này là đảo ngược giải pháp kết nối loopback tạm bợ tại `93c0169` (vốn mở endpoint HTTP loopback `/api/extension/handshake` không xác thực), đồng thời khôi phục kênh giao tiếp **Native Messaging Host** có kiểm soát quyền truy cập cấp hệ điều hành (Windows DACL).

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                    KIẾN TRÚC GIAO TIẾP TẠI COMMIT f041ffc                   │
│                                                                             │
│  Google Chrome (Companion Extension)                                        │
│         │                                                                   │
│         ├── stdio (Chromium 4-byte LE length framing)                       │
│         ▼                                                                   │
│  antifan-bridge-host.exe (Native Messaging Host Shim)                       │
│         │                                                                   │
│         ├── Đọc bridge-auth.json (bảo vệ bởi Windows DACL)                  │
│         ├── Windows Named Pipe: \\.\pipe\antifan-bridge-ipc-<uuid>          │
│         ▼                                                                   │
│  LocalIpcServer (Desktop Main Process)                                      │
│         │                                                                   │
│         ├── Xác thực launchNonce (32-byte cryptographically secure random)  │
│         ▼                                                                   │
│  Trả về: { token, port, activeCapsuleId, activePartition }                  │
│                                                                             │
│  [Bề mặt HTTP Bridge]:                                                      │
│  • /api/extension/handshake ──► 404 Not Found (ĐÃ XÓA)                      │
│  • /status                  ──► Bắt buộc Bearer Token                       │
│  • CORS Origin              ──► Khóa cứng chrome-extension://khjcaa...      │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 2. PHÂN TÍCH KỸ THUẬT COMMIT `f041ffc`
### 2.1 Các cải tiến bảo mật tầng truyền dẫn đã hoàn thành (Transport Hardening)
1. **Triệt tiêu nguy cơ rò rỉ loopback HTTP:** Xóa bỏ hoàn toàn route `/api/extension/handshake` trong `src/main/bridge/bridge-server.ts`. Các tiến trình khác trên localhost quét cổng Bridge sẽ nhận `404 Not Found`. Endpoint `/status` được gắn thêm middleware xác thực `isBridgeToken`.
2. **Kiểm soát truy cập tầng OS bằng Windows DACL:** `src/main/native-messaging/windows-acl.ts` sử dụng PowerShell áp đặt DACL nghiêm ngặt lên `%LOCALAPPDATA%\AntiFan\runtime`: tắt quyền kế thừa (`SetAccessRuleProtection($true, $false)`), chỉ cho phép duy nhất 2 ACEs: User SID hiện tại và SYSTEM (`S-1-5-18`) với quyền `FullControl`.
3. **Vòng đời thông tin xác thực in-memory:** `src/extension/background.ts` loại bỏ hoàn toàn việc lưu token vào `chrome.storage.local`. Khi Desktop ngắt kết nối (`onDisconnect`), extension xóa sạch token trong RAM, ngăn ngừa việc gửi nhầm cookie sang cổng cũ (stale port).
4. **Lọc delta removal phía client:** Extension lọc mảng `removed` trước khi gửi, giữ đúng bất biến additive-only của server.

---

### 2.2 Các lỗ hổng phân quyền P0 còn tồn đọng (Least Authority Gaps)

Mặc dù `f041ffc` đã giải quyết tốt an toàn tầng truyền dẫn (Transport Security), **nó chưa đạt tiêu chuẩn hoàn tất (Exit Criterion) của Phase A** trong tài liệu Roadmap Haravan (`antifan-latest-commit-haravan-roadmap-2026-09-05.md`, dòng 838–850):

> *"Exit Criterion: A Chrome extension instance can hydrate only the currently authorized Haravan workspace session and cannot perform any other Bridge action."*

#### Bằng chứng mã nguồn:

1. **Native IPC bàn giao trực tiếp Master Bridge Token (`src/main/index.ts:332–339`):**
   ```typescript
   await localIpcServer.start(bridgePort, () => {
     const activeCapsule = capsuleManager?.getActive();
     const activePartition = tabHost!.getSharedProfilePartition('clean');
     return {
       token: bridgeServer!.getToken(), // <-- MASTER BRIDGE TOKEN CẤP CHO EXTENSION!
       port: bridgePort,
       activeCapsuleId: activeCapsule?.id,
       activePartition,
     };
   }, StorageLocations.getRuntimeDir());
   ```

2. **Master Token mở khóa toàn bộ endpoint nhạy cảm (`src/main/bridge/bridge-server.ts:220–235`):**
   Token extension nhận được thỏa mãn kiểm tra `isBridgeToken`, cho phép gọi thành công:
   - `/api/screenshot` (Chụp màn hình tab/desktop)
   - `/api/remote-info`, `/api/qr`, `/api/lan-ips` (Thông tin mạng)
   - `/status`

3. **Chấp nhận partition đăng ký tùy ý trong Cookie Import (`src/main/bridge/bridge-server.ts:509–524`):**
   Khi nhánh xác thực dùng master token, request import cookie từ extension được phép truyền `requestedPartition`. Server chấp nhận bất kỳ partition nào đã được đăng ký hợp lệ (`isValidCapsulePartition`), thay vì khóa cứng duy nhất vào partition do server ấn định riêng cho grant đó.

4. **Hành động `SYNC_ALL_COOKIES` vẫn tồn tại (`src/extension/background.ts:344–350`):**
   Vẫn còn listener xử lý `request.action === 'SYNC_ALL_COOKIES'` gọi `chrome.cookies.getAll({})`, chưa được thay thế hoàn toàn bằng sync theo domain của active store context.

5. **Khoảng trống trong kiểm thử (Verification Gap - `test/main/extension-companion-pipeline.test.ts:99–105`):**
   ```typescript
   const validAuth: BridgeAuth = {
     port,
     token: server.getToken(), // Master token
     activePartition: 'persist:profile-default',
   };
   assert.strictEqual(await validateBridgeAuth(validAuth), true);
   ```
   Bộ test suite mới chỉ xác nhận token dùng được cho cookie import và status. **Hoàn toàn chưa có Capability Denial Test (kiểm tra phủ định)** để chứng minh extension bị từ chối với mã lỗi 403 khi gọi screenshot hay các endpoint khác ngoài import cookie.

---

## 3. HIỆN TRẠNG KIỂM THỬ WORKSPACE

- **Bộ kiểm thử chính (`npm run test:main`):** **PASS 883/883 tests (144 suites, ~35.3s)**. Bao phủ unit test, authority contracts, IPC table, Native Messaging framing, installer và companion pipeline.
- **Bộ kiểm thử toàn cục (`npm test`):** Kết quả đầy đủ của toàn bộ test suite chạy nền chưa được trích xuất chi tiết từ kết quả bất đồng bộ; không tính vào số liệu nghiệm thu chính thức. Kết quả xác minh trực tiếp được ghi nhận qua `npm run test:main`.
- **Đánh giá bộ test mới của `f041ffc`:** Cung cấp regression coverage tốt cho việc bắt tay Native Host và xử lý disconnect, nhưng chưa chứng minh được ranh giới phân quyền tối thiểu (least authority).

---

## 4. ĐÁNH GIÁ HIỆN TRẠNG THEO LỘ TRÌNH 7 GIAI ĐOẠN (A–G)

| Giai đoạn | Trạng thái kỹ thuật | Hiện trạng thực tế trong codebase |
|:---|:---:|:---|
| **Phase A: Session Bridge Hardening** | **Chưa hoàn tất (Blocked P0)** | Đã khôi phục Native Messaging và DACL (`f041ffc`). Còn nợ: tách `ExtensionSessionGrant`, khóa partition theo grant, loại bỏ `SYNC_ALL_COOKIES`, và viết capability denial tests. |
| **Phase B: ThemeWorkspaceContext** | **Chưa bắt đầu** | Chưa có đối tượng canonical context tập trung cho Haravan store/theme/tab/terminal. Nguy cơ `STORE_CONTEXT_MISMATCH` vẫn tồn tại. |
| **Phase C: Haravan Dialect Contract** | **Chưa bắt đầu** | Chưa có schema chuẩn hóa cú pháp DotLiquid/F1GENZ và bộ golden fixtures. |
| **Phase D: Safe Workspace Mutation** | **Đã có một phần (Partial)** | `src/main/qa/theme-qa-repair-coordinator.ts` và `workspace-snapshot-rollback.ts` đã có sẵn cơ chế tạo snapshot R0 (`createWorkspaceSnapshotManifest`) và tự động rollback khi phát hiện hồi quy. Việc còn lại là tổng quát hóa thành cơ chế ghi file CAS (`expectedSha256`) dùng chung ngoài phạm vi QA. |
| **Phase E: Haravan Dev Lifecycle** | **Chưa bắt đầu** | Chưa có adapter chuyên biệt bắt sự kiện đồng bộ theme (sync settle) từ stdout của tiến trình dev terminal. |
| **Phase F: TaskLoopCoordinator** | **Chưa bắt đầu** | Chưa có vòng lặp điều phối OMP gắn chặt với 5 Invariants và chính sách effect-aware retry. |
| **Phase G: Real Haravan Task Certification** | **Chưa bắt đầu** | Chưa chạy bộ 20 task kiểm chuẩn storefront thực tế. |

---

## 5. KẾ HOẠCH HÀNH ĐỘNG TRIỂN KHAI (ACTIONABLE ROADMAP)

### Bước 1: Khép lại Phase A (Ưu tiên P0)
1. **Cài đặt `ExtensionSessionGrant`:**
   - Tạo interface `ExtensionSessionGrant` (`token`, `workspaceId`, `targetPartitionId`, `capabilities: ['session.cookies.import']`, `allowedDomains`, `expiresAt`).
   - Trong `src/main/bridge/bridge-server.ts`: Quản lý danh sách grant hoạt động.
   - Trong `src/main/index.ts`: Callback cấp cho `LocalIpcServer` gọi `bridgeServer.issueExtensionGrant(...)`, không trả về `bridgeServer.getToken()`.
2. **Khóa quyền tại `BridgeServer`:**
   - `/api/cookies/import`: Chỉ chấp nhận grant còn hạn; ép ghi vào đúng `targetPartitionId` của grant, không nhận partition client chỉ định.
   - `/api/screenshot`, `/api/remote-info`, `/api/qr`, `/api/lan-ips`, `/api/terminal/*`: Trả về `403 Forbidden` nếu caller dùng extension grant.
3. **Loại bỏ `SYNC_ALL_COOKIES`:**
   - Thay thế hoàn toàn bằng sync scoped theo domain của active store.
4. **Bổ sung Capability Denial Tests (`test/main/extension-companion-pipeline.test.ts`):**
   - Test: Dùng extension grant gọi `/api/screenshot` $\to$ Assert trả về 403 Forbidden.
   - Test: Dùng extension grant gọi `/api/cookies/import` với cookie ngoài `allowedDomains` $\to$ Assert bị loại bỏ.
5. **Feature Freeze:** Đóng băng việc phát triển tính năng mới tại `src/main/bridge` và `src/main/native-messaging`.

---

### Bước 2: Triển khai Phase B & C (Nền tảng Cockpit & Cú pháp Haravan)
1. **Khởi tạo `ThemeWorkspaceContext` (Phase B):**
   - Định nghĩa canonical model: `storeId`, `storeDomain`, `adminOrigin`, `themeId`, `browserProfileId`, `terminalSessionId`.
   - Thực thi guard `STORE_CONTEXT_MISMATCH` ngăn chặn thao tác nhầm store.
2. **Xây dựng `HaravanDialectContract` & Golden Fixtures (Phase C):**
   - Thu thập fixture theme legacy (`settings.html`, `{% include %}`) và hiện đại (`settings_schema.json`, `{% section %}`).
   - Cài đặt bộ kiểm tra cú pháp DotLiquid, chặn đứng việc dùng cú pháp không tương thích của Shopify OS 2.0.

---

### Bước 3: Hoàn thiện Phase D & E (Đột biến an toàn & Vòng đời Dev)
1. **Tổng quát hóa `MutationSession` (Phase D):**
   - Tận dụng logic R0 snapshot và rollback sẵn có từ `ThemeQaRepairCoordinator`.
   - Bổ sung cơ chế ghi file Compare-And-Swap (CAS) với `expectedSha256`.
   - Tách biệt rõ 2 chế độ compiler: `new-theme` (sở hữu thư mục) và `patch-existing` (chỉ sửa file theo manifest, không xóa file ngầm).
2. **Cài đặt `HaravanDevAdapter` (Phase E):**
   - Giám sát tiến trình watch/upload theme qua terminal, cung cấp hàm `waitUntilSynced()` để điều phối thời điểm kiểm thử browser sau khi CDN settle.

---

### Bước 4: Triển khai Phase F & G (Điều phối OMP & Chứng nhận thực tế)
1. **Cài đặt `TaskLoopCoordinator` (Phase F):**
   - Ràng buộc OMP theo 5 Invariants: Agent không có quyền tự phán quyết; bằng chứng phải có lineage; lỗi tràn ngang (`horizontalOverflow == true`) hoặc lỗi Liquid phủ quyết claim ngay lập tức; tự động rollback về R0 khi thất bại.
   - Áp dụng chính sách effect-aware retry (không retry mù quáng thao tác đột biến).
2. **Chứng nhận bộ 20 Task Storefront Haravan (Phase G):**
   - Thực thi chuỗi 20 task thực tế (Header, Mobile Menu, Slider, Product Card, Cart Drawer, Responsive 375px,...).
   - Đo lường các chỉ số: Tỷ lệ hoàn thành tự động, số lần nhầm store (mục tiêu: 0), độ tin cậy rollback khi gặp lỗi.
