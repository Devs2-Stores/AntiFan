# Ultra Debug Final — Chrome Profile Sync Diagnosis & Extension-Removal Plan (2026-09-05)

**Mode:** `ak:debug --ultra` — **same-tier best-of-5** (runtime không hỗ trợ per-subagent model-tier routing: 5 candidates + 1 verifier chạy cùng tier, độc lập sampling + rubric selection; KHÔNG phải asymmetric verification).
**Controller:** Main · **Candidates:** A, B, C, D, E (read-only, 1 wave) · **Verifier:** reviewer agent.
**Evidence packet (immutable):** `plans/reports/ultra-260905-chrome-profile-sync-evidence-packet.md`
**Candidate artifacts:** `plans/reports/ultra-260905-chrome-profile-sync-candidates/candidate-{a..e}.md`

---

## 1. Verdict (executive)

3 triệu chứng người dùng báo cáo là **3 đường lỗi khác biệt, không phải một bug**:

| Triệu chứng | Root cause | Mức xác nhận |
|---|---|---|
| **Mất cookie** | Partition mismatch: extension/native-messaging handshake néo target `persist:capsule-default` (`src/main/index.ts:321-331`), trong khi tab người dùng chạy `persist:profile-default` (`src/main/browser/native-tab-host.ts:3064-3071`) → cookies được import vào một partition KHÔNG được render. Cộng thêm: delta-removal propagate logout từ Chrome; `syncProfile()` chỉ đếm cookie (no-op); `--load-extension` silent-fail khi Chrome đang chạy; automation tabs dùng `ephemeral-*` volatile. | **CONFIRMED** (verifier 0.98; controller re-verify độc lập) |
| **Mất cache** | Không có code sync cache từ Chrome (kỳ vọng vốn không được implement) + nút "Xóa Cookies & Cache của trang này" gọi `ses.clearStorageData({storages:[...]})` **không có `origin`** (`native-tab-host.ts:2388-2404`) → xoá sạch cookies+localStorage+cache của **toàn bộ partition** (mọi site). Giới hạn `disk-cache-size=128MB` (`index.ts:115-116`). | **CONFIRMED** |
| **Password ko lưu** | **Missing feature hoàn toàn**: 0 code đọc `Login Data`, 0 DPAPI/`safeStorage`; Electron không có password-manager UI delegate (`enable-features=PasswordManager` ở `index.ts:118` là inert); Chrome 127+ App-Bound Encryption (v20) chặn decrypt ngoài chrome.exe; extension MV3 không có API password (`chrome.passwordsPrivate` cấm third-party). | **CONFIRMED** |

## 2. Ranking appendix (verifier, 1–20 mỗi tiêu chí)

| Candidate | C1 Evidence | C2 Rival | C3 Specificity | C4 Testability | C5 Feasibility | Total |
|---|:-:|:-:|:-:|:-:|:-:|:-:|
| **C — WINNER** | 20 | 20 | 20 | 19 | 20 | **99** |
| A | 18 | 18 | 19 | 17 | 19 | 91 |
| D | 17 | 18 | 19 | 18 | 18 | 90 |
| E | 16 | 17 | 16 | 17 | 17 | 83 |
| B | 16 | 15 | 16 | 14 | 16 | 77 |

**Winner (materialized unchanged):** `plans/reports/ultra-260905-chrome-profile-sync-candidates/candidate-c.md` — 100% anchor chính xác (26+ file:line spot-check), rival-elimination dựa test thực tế trong repo, probe Windows chạy được, architecture extension-removal enterprise-aware.

**Factual corrections (verifier) cho các candidate không thắng:**
1. `disk-cache-size`/`media-cache-size` **CÓ tồn tại** (`index.ts:115-116`, 128MB/64MB) — A & B sai khi cho rằng không có. Không đổi root cause.
2. Filter `cause === 'explicit'` nằm ở `src/extension/cookie-debouncer.ts:59-63` (không phải `background.ts:106-116` như D, hay `background.ts:285-300` như E).
3. `clearStorageData` thiếu `origin` là bug (E chỉ coi là manual clear bình thường).

## 3. Fresh-verification của controller (độc lập với candidates, sau khi có winner)

- `index.ts:321-331` — handshake callback: `activePartition = activeCapsule ? deriveCapsulePartition(activeCapsule.id) : deriveCapsulePartition('default')` → `persist:capsule-default`; kèm `installNativeHost(COMPANION_EXTENSION_ID)` auto-register (Registry HKCU). ✓
- `createTab` call sites (grep toàn repo): không call-site nào trong luồng user truyền `isolateSession:true`; tất cả rơi vào `getSharedProfilePartition()` → `persist:profile-<key>`. Chỉ automation paths (`bridge-server.ts:1020`, `browser-action-registry.ts:97`, `browser-control-port.ts:899/2999`) truyền `{ephemeral}` → volatile. ✓
- `browser-session-partition.ts:17-37`: non-ephemeral → `persist:capsule-<id>`/`persist:profile-...`; ephemeral → `ephemeral-<id>-<nonce>` (RAM-only). ✓
- `bridge-server.ts:411-560`: `persistSession = data.persistSessionCookies !== false` (mặc định true → session cookie nâng lên 30 ngày), xử lý `removed` → `cookies.remove`, delta thiếu partition → 400 `MISSING_TARGET_PARTITION`. ✓
- `native-tab-host.ts:2388-2404`: `clearStorageData` không origin. ✓
- grep `safeStorage|password|Login Data` → 0 code path. ✓

## 4. Phương án bỏ Extension (winner C, khả thi 100%)

Bản đầy đủ: `candidate-c.md` (Section C). Cốt lõi:

**Xoá:** `extension/`, `src/extension/`, `src/main/native-messaging/` (manifest-installer, local-ipc-server/client, host-runner, framing, windows-acl), `bin/antifan-bridge-host.exe`, registry HKCU `NativeMessagingHosts\com.antifan.bridge` (Chrome/Edge/Brave), `index.ts:317-342` startup + `installNativeHost`, IPC `launch-with-extension`/`open-extension-folder`, `/api/cookies/import` delta routing, `scripts/build-extension.mjs` + `smoke:native-messaging*`.

**Thay bằng (local-first, độc lập):**
1. **Hydration một chiều qua CDP** — `LocalSessionVault.importFromLiveChromeCDP()` (đã implement sẵn): mở Chrome `--remote-debugging-port=<port ngẫu nhiên ephemeral>` + `--remote-allow-origins`, `Network.getAllCookies`, import vào **cùng partition mà tab dùng** (`persist:profile-${safeProfileKey}`), đóng WS ngay. Bỏ Delta sync real-time (nguồn logout chéo). Bổ sung fallback import JSON (Cookie-Editor).
2. **Thống nhất partition** — tab + import cùng `persist:profile-*`; migrate 1 lần `persist:capsule-*` → `persist:profile-*`.
3. **Sửa `clearStorageForActiveTab()`** — thêm `origin = new URL(activeTab.state.url).origin` vào `clearStorageData`.
4. **Bookmarks** — chỉ đọc `getChromeBookmarks()`, bỏ `saveChromeBookmark`/`removeChromeBookmark` (ghi đè file Bookmarks của Chrome đang chạy = race).
5. **Password (tùy chọn phase 2)** — vault local bằng Electron `safeStorage` (DPAPI) + preload capture form; KHÔNG thể import password từ Chrome (App-Bound v20) — nói rõ cho user.

**Rủi ro CDP:** mở port debug cho phép tiến trình local đọc cookie → port ngẫu nhiên + one-shot + đóng ngay; nếu Chrome đang chạy → probe `/json/version` trước, hoặc fallback JSON.

## 5. Next step (đề xuất, chờ quyết định)

1. Implement plan trên theo winner C (xoá extension/native-messaging, CDP hydration, fix clearStorage, partition unification) — **là thay đổi destructive → cần approval rõ ràng.**
2. Chọn phạm vi password: A) vault safeStorage internal, B) CSV import, C) bỏ qua.

Trạng thái: **VERIFIED_COMPLETE** (diagnosis + phương án). Chưa thực hiện mutation nào.