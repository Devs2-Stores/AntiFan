# Ultra Debug — Chrome Profile Sync: Hard-Stop Report + Controller-Verified Diagnosis & Extension-Removal Path

**Ngày:** 2026-09-05 · **Repo:** `antifan-browser-desktop` v1.3.5 (Electron 43, CJS) · **Host:** Windows 11 x64
**Mode:** `ak:debug --ultra` (same-tier best-of-5) — **KẾT QUẢ: HARD-STOP theo fail-closed rule. Không có verifier, không materialize ultra-winner.**

---

## 1. Kết quả ultra run (per-slot gate)

| Slot | Wave 1 | Bounded retry | Usable (call OK + full skill-shaped report) |
|---|---|---|---|
| A | completed (561B summary — không đủ) | A2 **completed** (29.8KB report full) | ✅ |
| B | failed (yield null, report recovered 24.3KB) | B2 **completed** (30.6KB) | ✅ |
| C | failed (yield null, report recovered 36.3KB) | C2 **completed** (33.4KB) | ✅ |
| D | failed (yield null, report recovered 31.2KB) | D2 **failed** (yield null, report recovered 31.9KB) | ❌ **FAILED** |
| E | failed (yield null, report recovered 27.2KB) | E2 **completed** (30.9KB) | ✅ |

- Usable pool = **4/5** (A, B, C, E). Slot D hỏng sau đúng 1 bounded retry — không còn quyền re-dispatch.
- Per protocol: *"If fewer than five are usable after that, hard-stop."* → **KHÔNG dispatch verifier**, không chọn winner, không relabel thành ultra success.
- Nguyên nhân hệ thống: task agents của runtime này kết thúc bằng `yield(null)` (terminal error) khi trả report văn bản dài — đúng 1 mẫu A/A2/B2/C2/E2 thành công nhờ structured JSON payload `{candidate, report}`. Đây là hạn chế delivery của runtime, không phải lỗi nội dung: **các report recovered vẫn đầy đủ và dùng được làm evidence tham khảo** (mục 5), chỉ không đạt chuẩn ultra-usable.

**Hệ quả:** không có "winning diagnosis" do verifier chọn. Toàn bộ nội dung dưới đây là **controller-side, đã verify bằng read tươi** (iron law) hoặc **evidence từ candidates (đánh dấu rõ)**.

---

## 2. Controller-verified root causes (fresh reads, từng claim đối chiếu file:line)

### 2.1 Mất cookie — nguyên nhân chính: partition mismatch (CONFIRMED, verify trực tiếp)

Chuỗi bằng chứng đầy đủ (tôi đã tự đọc tất cả các đoạn code này trong phiên này):

1. `src/main/index.ts:321-331` — handshake Native Messaging trả `activePartition`:
   ```ts
   const activeCapsule = capsuleManager?.getActive();
   const activePartition = activeCapsule ? deriveCapsulePartition(activeCapsule.id) : deriveCapsulePartition('default');
   ```
   → `browser-session-partition.ts:28-34`: non-ephemeral ⇒ `persist:capsule-<id>` (mặc định `persist:capsule-default`).
2. `src/extension/background.ts:56-64,161-165` (bundle `extension/background.js`): extension lưu `bridgeAuth.activePartition` và **ép** mọi payload `/api/cookies/import` với `partition: currentAuth.activePartition`.
3. `src/main/bridge/bridge-server.ts:489-498`: bridge nhận partition đó → `targetSession = this.tabHost.getPartitionSession('persist:capsule-default')` → cookies được `cookies.set()` vào **jar `persist:capsule-default`**.
4. `src/main/browser/native-tab-host.ts:3064-3071`: tab thường (toolbar/app menu/bookmark/restore) KHÔNG truyền `isolateSession` → rơi vào nhánh `else`: `partition = this.getSharedProfilePartition(...)` → `native-tab-host.ts:2573-2575`: `persist:profile-<profileKey>` → **`persist:profile-default`**.
5. Electron partition là 2 SQLite cookie jar riêng biệt (`Partitions\capsule-default\Cookies` vs `Partitions\profile-default\Cookies`). Extension báo "imported N cookies" thành công nhưng tab của user đọc jar rỗng → **đăng nhập mọi nơi = 0 cookie**.

Kết luận: tính năng sync cookies hiện gần như luôn rơi vào partition KHÔNG được hiển thị. Đây chính là "mất cookie tùm lum" chủ lực.

### 2.2 Mất cookie — vector phụ (CONFIRMED)

- **Delta removal propagation:** `extension/background.js` (CookieDebouncer): `if (removed) { if (cause && cause !== 'explicit') return; }` → user logout / xoá cookies / clear-site-data trong Chrome (`cause: 'explicit'`) được chuyển tiếp → `bridge-server.ts:524-542`: `targetSession.cookies.remove(...)` → **logout Chrome = logout cả app**. Vi phạm trực tiếp tiêu chí "Local và độc lập".
- **`syncProfile()` là no-op:** `chrome-profile-sync.ts:522-559` chỉ đọc bookmarks + đếm cookies CÓ SẴN trong target session; không import gì. Nút "Sync Profile" trong UI (native-tab-host.ts:983-999, app-menu.ts:118-130, tab-context-menu.ts:264-276) không hút được cookie nào.
- **`--load-extension` silent no-op khi Chrome đang chạy:** `chrome-profile-sync.ts:400-433` vẫn trả `success: true` + warning "đóng hẳn Chrome hoặc Load unpacked". User tưởng đã bật sync, thực tế extension không nạp → 0 cookie.
- **`clearStorageForActiveTab` xoá toàn bộ session:** `native-tab-host.ts:2388-2404`: `ses.clearStorageData({ storages: ['cookies','localstorage','cachestorage'] })` KHÔNG có `origin` → xoá **toàn bộ cookies + localStorage + Cache Storage API của cả partition** (mọi domain), dù menu ghi "Clear Cookies & Cache **for this site**" (native-tab-host.ts:2198, tab-context-menu.ts:329). Một lần bấm "xoá cache trang này" = mất hết cookies profile. → vector "mất cookie" do chính UI.
- **Ephemeral partitions:** `browser-session-partition.ts:19-27` + `native-tab-host.ts:2567-2572`: partition không có prefix `persist:` là **in-memory** — mất sạch khi đóng tab/app. Automation tạo tab `ephemeral: operationType === 'write'` (`browser-control-port.ts:2998-2999`, `browser-action-registry.ts:92-98`). Nếu hydration (full sync không partition → default active tab) rơi vào tab automation ⇒ cookie vào RAM ⇒ mất.

### 2.3 Mất cache (CONFIRMED cho phần "không có code", CORRECTED cho phần clearStorage)

- **Zero cache-sync code:** không tồn tại code nào copy `User Data\<profile>\Cache` / `Code Cache` của Chrome vào app (grep toàn repo). Tab app luôn khởi động với cache lạnh → cảm giác "mất cache".
- **CORRECTION (quan trọng):** `clearStorageData({storages:['cookies','localstorage','cachestorage']})` chỉ xoá cookies/localStorage/**Cache Storage API** — KHÔNG xoá HTTP disk cache (cái đó là `session.clearCache()`). Mọi khẳng định trong candidate reports rằng thao tác này xoá "HTTP cache/disk cache" là overclaim, đã bị loại. HTTP cache của app vẫn nằm dưới userData partition (mặc định Chromium; không thấy code clearCache).
- Candidate C đề xuất giới hạn `--disk-cache-size` 128MB — **CHƯA VERIFY** [INFERENCE, cần kiểm chứng riêng].

### 2.4 Password không lưu — missing feature (CONFIRMED)

- Grep toàn repo (`src/`, `extension/`, `scripts/`): **0 code** đọc `Login Data`, 0 DPAPI, 0 `safeStorage`, 0 lưu/autofill credential. Chỉ có: flag `enable-features=PasswordManager,Autofill` (index.ts:118 — vô hiệu trong Electron vì thiếu UI layer `//chrome` của Chromium), redaction log, và smoke test chỉ *phát hiện* `input[type=password]`.
- Chrome 127+ App-Bound Encryption (v20) khóa decrypt `Login Data` từ ngoài Chrome — kể cả DPAPI. → **Không đọc được password Chrome khi Chrome đang chạy**; import password về cơ bản bất khả thi tự động. Password phải là tính năng mới của riêng app (vault nội bộ).

---

## 3. Phương án bỏ Extension (local & độc lập) — đánh giá của controller

**Kết luận: khả thi hoàn toàn.** Extension + Native Messaging hiện chỉ làm 2 việc mà CDP + session persistence của chính app đã có thể thay:

| Capability của Extension | Thay thế local, không extension | Rủi ro / ghi chú |
|---|---|---|
| **Full cookie hydration** (`chrome.cookies.getAll` → POST bridge) | **CDP one-shot**: `LocalSessionVault.importFromLiveChromeCDP()` đã tồn tại (`local-session-vault.ts` — đọc `Network.getAllCookies` qua `--remote-debugging-port`, "bypass v20 cleanly"). Launch bằng `launchChromeWithCdp()` có sẵn. | Chrome phải đóng trước khi launch (code đã chặn). CDP không có cookie-change events. |
| **Delta sync** (`cookies.onChanged`) | **Bỏ hẳn.** App là trình duyệt độc lập: cookies thay đổi trong app thì app tự lưu. Sync live 2 chiều chính là nguồn của delta-removal bug (mục 2.2). | Đánh đổi: mất "đồng bộ thời gian thực" — nhưng đó chính là thứ đang gây mất cookie. |
| **Auth/handshake** (native messaging + registry + host binary + 2.5k dòng IPC) | Loại bỏ toàn bộ: CDP chạy loopback 127.0.0.1, không cần manifest/registry/file auth. | CDP mở cổng local = bất kỳ process nào của user cũng đọc được cookies → phải giảm thiểu (dưới). |
| **Bookmarks** | Giữ read-import từ `Bookmarks` JSON; **bỏ ghi ngược** vào file Chrome sống (race — Chrome flush đè/ghi đè trạng thái mới hơn). Lưu bookmark riêng trong app. | |
| **Password** | Tính năng MỚI: vault nội bộ dùng `safeStorage` (DPAPI), lưu `credentials.enc` trong app data; autofill trong tab app. | Phạm vi sản phẩm — cần user quyết. Import từ Chrome bất khả thi tự động (v20). |

### Files sẽ xoá (khi implement)
`extension/`, `src/extension/`, `src/main/native-messaging/`, `bin/antifan-bridge-host.exe` + build scripts (`build-extension.mjs`, `build-native-host-shim.mjs`), registry `HKCU\Software\Google\Chrome|Edge|Brave\NativeMessagingHosts\com.antifan.bridge`, IPC handlers `antifan:chrome:launch-with-extension` / `open-extension-folder`, nhánh `chrome-extension-delta` + `COMPANION_EXTENSION_ID` trong bridge-server.

### Files sẽ sửa
1. **`src/main/index.ts:321-331`** — bỏ LocalIpcServer/installNativeHost; handshake không còn.
2. **Unified partition:** mọi tab + mọi cookie import dùng chung **một** session `persist:profile-<activeProfileId>` (hoặc quyết định capsule policy rõ ràng). Đây là fix gốc của mục 2.1.
3. **`native-tab-host.ts:2388-2404`** — `clearStorageData` phải kèm `origin` của trang đang active (xoá đúng site), hoặc đổi nhãn menu thành "Xoá cookies & dữ liệu của toàn profile" để không đánh lừa.
4. **`chrome-profile-sync.ts`** — xoá launch-with-extension; `syncProfile` đổi thành "hút cookies qua CDP vào partition duy nhất" hoặc bỏ nhánh cookie count.
5. **Bridge** — giữ `/api/cookies/import` cho CDP/vault import (có thể giữ token auth local).

### Rủi ro CDP & giảm thiểu (cần có trong design)
- Random port thay vì 9222 cố định; `--remote-allow-origins=http://127.0.0.1:<port>` chống DNS-rebinding.
- One-shot: kết nối WS → `Network.getAllCookies` → đóng ngay; không giữ cổng mở; tự động kill instance sau khi đọc.
- Cân nhắc launch Chrome với `--user-data-dir` tạm + CDP-ready thay vì profile thật để tránh đụng profile đang dùng; hoặc chấp nhận quy trình "đóng Chrome → launch CDP profile thật → đọc → đóng".
- Điều kiện hiện tại: `launchChromeWithCdp` từ chối khi Chrome đang chạy — giữ nguyên hành vi này.

### Migration & rollback
- Registry cleanup: `reg.exe delete "HKCU\Software\Google\Chrome\NativeMessagingHosts\com.antifan.bridge" /f` (+ Edge/Brave); xoá `%LOCALAPPDATA%\AntiFan\extension` + `NativeMessagingHosts`.
- Data giữ nguyên: cookies đã có trong `persist:profile-*`/`persist:capsule-*` không bị đụng; export vault JSON trước khi thay đổi.
- Rollback: cài lại manifest registry + build extension cũ — không có schema migration.

---

## 4. Verification plan (Windows, chạy được ngay, read-only)

```powershell
# Probe 1 — xác nhận partition mismatch (cần build:.compiled hoặc đọc code là đủ):
# index.ts:321-331 -> deriveCapsulePartition('default') = 'persist:capsule-default'
# native-tab-host.ts:2573-2575 -> 'persist:profile-default'  (2 jar khác nhau)

# Probe 2 — smoke hiện có:
npm run smoke:google        # cookie import + Google auth qua extension (validate hành vi hiện tại)
npm run smoke:persistence   # ghi cookie/localStorage/IndexedDB -> restart Electron -> verify còn

# Probe 3 — CDP hydration (sau khi đóng hẳn Chrome):
"C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222 --profile-directory=Default --no-first-run
# rồi: GET http://127.0.0.1:9222/json/version -> webSocketDebuggerUrl
# sau đó chạy snack importFromLiveChromeCDP (hoặc test script mới) -> đếm cookies trong persist:profile-default
```

---

## 5. Evidence từ 5 candidate reports (recovered — KHÔNG phải ultra-usable, dùng làm tham chiếu)

Các report full (A2/B2/C2/E2 completed; D/D2/E/B/C recovered từ artifact) đều **hội tụ về cùng chuỗi nguyên nhân** mục 2 — tín hiệu mạnh về độ tin cậy dù không qua verifier:
- A2 (`agent://CandidateA2`), B2 (`agent://CandidateB2`), C2 (`agent://CandidateC2`), E2 (`agent://CandidateE2`) — completed, report full.
- D/D2 (`agent://CandidateD2`), E/B/C originals (`agent://CandidateE`, `agent://CandidateB`, `agent://CandidateC`, `agent://CandidateD`) — terminal error, report recovered.
- Điểm bổ sung đáng chú ý từ candidates: restore path cũng tách partition (`native-tab-host.ts:5100-5119`: restore tabs → `persist:profile-*` nhưng sync gọi vào `persist:capsule-<id>`); độ mong manh của host binary (`manifest-installer.ts` 3 candidate paths); CORS/port cố định 20129/20130 trong `extension/manifest.json` host_permissions vs port fallback động (edge case).
- **Overclaim đã bị loại:** "clearStorageData xoá HTTP cache" (sai — xem correction 2.3); "128MB disk-cache limit" [INFERENCE chưa verify].

---

## 6. Next steps (đề xuất)

1. Chốt quyết định scope với user (2 câu hỏi duy nhất — xem reply).
2. Lập plan implement (`ak:plan`) cho: unified partition fix + clearStorage scoped + xoá extension/native-messaging + CDP one-shot hydration + vault password (nếu chọn).
3. Test: dùng Probe 1-3 ở mục 4 trước/sau khi đổi code.