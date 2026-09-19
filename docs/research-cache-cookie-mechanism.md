# Nghiên Cứu Cơ Chế Cache/Cookie Hiện Tại — AntiFan Desktop Browser

**Triệu chứng người dùng:** "Rất nhanh hết, lúc ăn lúc không, không đồng bộ được từ Chrome."
**Ngày đo:** 2026-09-19 (Tier-1 live telemetry: MCP `anti.browser.*`, registry, SQLite trên đĩa, `main.log`)
**Chế độ:** Read-only. Không sửa file, không đổi trạng thái app. Mọi kết luận dưới đây gắn với bằng chứng đo được hoặc `file:line`.
**Máy đo:** data root `E:/Work/.antifan-data`, Chrome thật `153.0.8010.50`, app Electron `43.4.0`.

---

## 1. Tóm Tắt Thực Thi

Cơ chế hiện tại **không có một kho cookie duy nhất**. Nó có **86 kho cookie** trên đĩa: **1 kho đang sống** (`persist:profile-profile-2`) và **85 kho đã chết** (25.756 cookie, 8,76 MB) mà không đường code nào đọc tới. Ba trong số nhiều nguyên nhân gốc:

| # | Nguyên nhân gốc | Bằng chứng (Tier-1) | Triệu chứng khớp |
|---|---|---|---|
| **RC1** | **Menu "Sync Google Chrome Profile" ghi cookie vào jar của *tab đang focus***, không phải jar của profile. Nếu tab đang focus là capsule cô lập hoặc tab ephemeral (in-memory) thì cookie ghi vào RAM và **chết khi đóng tab**. | `native-tab-host.ts:2895` và `tab-context-menu.ts:272` truyền `getActiveTabSession()`; chỉ menu hệ thống `app-menu.ts:195` dùng `getSharedProfileSession('clean', p.id)`. Live: bound tab hiện tại là `ephemeral-profile-profile-2-6g9ayx3i` (in-memory). | "rất nhanh hết", "lúc ăn lúc không" |
| **RC2** | **Vault backup/restore cũng dùng jar của tab đang focus, và vault trên đĩa không hề chứa cookie đăng nhập Google.** Đường CDP import cố tình **không** ghi vault. | `session-vault.json` = 267 cookie, mtime `2026-09-05 13:40`, Google chỉ có `NID`/`SNID`(path `/verify`)/`OTZ`/`SEARCH_SAMESITE` — **không có `SID`, `HSID`, `SSID`, `__Secure-1PSIDTS`**; `local-session-vault.ts:417-421` ghi chú "NO plaintext backup here". | "không đồng bộ được từ Chrome" |
| **RC3** | **Mọi capsule cô lập = một vũ trụ cookie vĩnh viễn.** `deriveCapsulePartition` trả `persist:capsule-<id>`; migration Sep 5 copy sang `persist:profile-capsule-<uuid>` — **tên không code nào resolve**. | `browser-session-partition.ts:31-33`; `capsule-partition-migration.ts:92-93`; `grep 'profile-capsule' src/ scripts/` → **0 match**; 41 thư mục `profile-capsule-*` tồn tại trên đĩa. | "không đồng bộ được", mất session cũ |
| **RC4** | **Tab tạo không có `partition` rơi vào `session.defaultSession`, và jar default RỖNG.** | `Profile/Network/Cookies` = 20.480 B (SQLite rỗng); `persist:profile-default` **không tồn tại**; `getTabSession` fallback `session.defaultSession` (`native-tab-host.ts:3449-3452`). | "lúc ăn lúc không" |
| **RC5** | **Session cookie không bao giờ sống qua lần thoát app.** Chỉ đường *import* mới nâng session cookie lên TTL 30 ngày. | Quét toàn bộ 86 store: `session(expires_utc=0) = 0`. `local-session-vault.ts:145-147`. | "rất nhanh hết" |
| **RC6** | **Cache cấu hình sai chỗ:** `--disk-cache-dir` chỉ áp cho partition default ⇒ thư mục cache đó rỗng; cache thật nằm per-partition. ~219 MiB cache mồ côi. | `Profile-cache/network` = **0 B**; `Profile/Cache` = 224.350 KB (default, mtime Aug 30, không tab nào dùng); `Partitions/profile-profile-2/Cache` = 171.073 KB; `index.ts:196-198, 211`. | cảm giác "cache không ăn" |

Ngoài ra, **đồng bộ từ Chrome là bất khả thi về mặt kỹ thuật với profile thật** trên Chrome ≥ 127 (App-Bound Encryption v20): cơ chế "owned clone" trả 0 cookie, và app đã tự ghi nhận điều này trong comment `chrome-profile-sync.ts:497-503`.

---

## 2. Kiến Trúc Hiện Tại (As-Is)

### 2.1 Bốn loại "phiên" (session/partition)

| Loại | Partition string | Lưu trên đĩa? | Nơi tạo |
|---|---|---|---|
| Shared profile (đang dùng thật) | `persist:profile-<profileId thường hoá>` → `persist:profile-profile-2` | Có | `native-tab-host.ts:3523-3526` |
| Capsule cô lập | `persist:capsule-<capsuleId>` | Có | `browser-session-partition.ts:31-33` |
| Ephemeral (RAM) | `ephemeral-profile-<key>-<nonce>` | **Không** | `native-tab-host.ts:3519-3521` |
| Default | `defaultSession` | Có (`Profile/Network`) nhưng **rỗng** | fallback `native-tab-host.ts:3450` |

`getSharedProfilePartition()` lấy `profileId` từ tham số, nếu không có thì lấy `ChromeProfileSyncManager.activeProfileId` (**biến toàn cục, đổi được từ menu sync**), mặc định `'Default'`.

### 2.2 Đường đi của cookie (4 cửa vào, 3 đích)

```
Chrome thật ──(1) owned clone + headless CDP──┐
                                              ├─► importVaultFromJson() ─► targetSession  (jar nào tuỳ caller)
session-vault.json ──(2) importVaultFromFile──┘
Extension bridge ──(3) POST /api/cookies/import──► targetSession (theo partition/tabId khai báo)
Trang web tự set ──(4) không cần app ────────────► jar của tab đó
```

TTL: chỉ nhánh import set `persistSessionCookies: true, sessionTtlSeconds: 30*24*3600` (`local-session-vault.ts:145-147`). Cookie do trang tự set giữ nguyên đặc tính gốc ⇒ session cookie chết cùng tiến trình.

Flush: thoát graceful có `tabHost.flushAllSessions` + `cookies.flushStore` (`main.log`: `shutdown.step.begin/done cookies.flushStore`) ⇒ cookie do trang set được ghi xuống đĩa **chỉ khi thoát êm**. Kill/crash ⇒ mất phần cookie set trong phiên.

### 2.3 Kiểm kê kho cookie trên đĩa (đo trực tiếp)

```
stores: 85 dead + 1 live        cookies: 25.756        bytes: 8,76 MB
capsule-capsule-*: 43   profile-capsule-*: 41   profile-profile-*: 1 (LIVE)
stores có cookie Google: 76     stores có cookie Google AUTH (SID/PSID/PSIDTS): 58
session cookies trên toàn bộ 86 store: 0
```

Ví dụ store lớn nhất: `capsule-capsule-d25c1188-…` = 724 cookie / 243 host / 146 cookie Google / 15 cookie auth, expiry xa nhất 2027-10-10 — **một phiên đăng nhập Google hoàn chỉnh bị bỏ rơi**.

### 2.4 Cache

| Đường dẫn | Kích thước | Vai trò thực tế |
|---|---|---|
| `Profile-cache/network` | **0 B** | Đích của `--disk-cache-dir` — không bao giờ được ghi, vì mọi tab sống trong partition có tên |
| `Profile-cache/gpu` | 0 B | Tương tự |
| `Profile/Cache` | 224.350 KB (~219 MiB) | Cache của partition **default** — không tab nào dùng (mtime Aug 30) |
| `Profile/Partitions/profile-profile-2/Cache` | 171.073 KB (~167 MiB) | **Cache đang thực sự phục vụ** |

Hệ quả: đổi profile = cache lạnh; `--disk-cache-size=134217728` (128 MiB) chỉ ràng buộc partition default nên không giới hạn cache thật (cache sống 167 MiB > 128 MiB); ~219 MiB đĩa bị lãng phí.

---

## 3. Cơ Chế Của Từng Triệu Chứng

### 3.1 "Không đồng bộ được từ Chrome" — 6 rào chắn xếp theo thứ tự chặn

1. **Allowlist bên nhận bỏ toàn bộ nhóm Google** (đo + sửa 2026-09-19): đây là rào chắn chặn **kênh extension Companion** — đường vẫn được coi là "chạy được". Extension lọc theo `SCOPE_PROFILES` (`src/extension/domain-scoper.ts:3-21`) có đủ 6 miền Google, nhưng allowlist bên nhận `DEFAULT_EXTENSION_ALLOWED_DOMAINS` (`src/main/bridge/bridge-server.ts`) chỉ có 10 miền thương mại điện tử, nên `rawCookies.filter(...)` trong handler `/api/cookies/import` bỏ **hết** cookie Google/YouTube trước khi ghi vào jar. Ca thật (probe dùng đúng route thật, grant mặc định): 3 cookie Google/YouTube + 1 cookie ngoài phạm vi ⇒ `importedCount: 0, skippedCount: 0, failedCount: 0` — không đếm, không log, popup vẫn báo "✅ thành công" vì `SYNC_ACTIVE_TAB` trả `targetCookies.length` (số *đã thử gửi*) chứ không phải số bên nhận thực nhận. Đã sửa: bổ sung 7 miền còn thiếu vào allowlist, phản hồi thêm `filteredCount`, popup trả số thật và cảnh báo khi 0; test `extension-companion-pipeline` chạy một lượt import cho **mỗi** regex trong `SCOPE_PROFILES` nên hai danh sách lệch nhau lần nữa là đỏ CI.
2. **App-Bound Encryption v20**: Chrome ≥127 mã hoá cookie bằng khoá gắn máy (DPAPI + App-Bound). Clone profile sang temp dir ⇒ khoá không đi theo ⇒ `Network.getAllCookies` trả 0. App tự thừa nhận tại `chrome-profile-sync.ts:501-503`. Đã kiểm chứng độc lập ở probe trước: jar clone có 1.415 hàng cookie nhưng **0 cookie đọc được**, và Chromium **xoá luôn** các hàng không giải mã được (ABE key changed) — tức không thể "đọc lén" DB.
3. **Yêu cầu đóng hẳn Chrome**: `hydrateCookiesViaOwnedChrome` trả sớm nếu Chrome đang chạy (`chrome-profile-sync.ts:445-447`). Người dùng đang mở Chrome ⇒ "không đồng bộ được" mà không rõ lý do.
4. **Cổng 9222 không thuộc profile thật**: trên máy tồn tại `Chrome/User Data/CodexRemote9222/DevToolsActivePort` nội dung `9222` — một tiến trình Chrome khác (do extension OpenAI Codex) mở CDP trên 9222 nhưng dùng **user-data-dir riêng**. Nhánh "Import từ Chrome đang chạy qua port 9222" sẽ nói chuyện với profile **rỗng** đó.
5. **Vault không chứa cookie đăng nhập**: kể cả khi import thành công, `session-vault.json` là snapshot `2026-09-05 13:40` — Google chỉ có `NID`, `SNID` (path `/verify`), `OTZ`. Không `SID` ⇒ restore vault xong vẫn phải đăng nhập lại. 29/267 cookie trong vault **đã hết hạn** tại thời điểm đo. UI nay đếm cookie đăng nhập Google trong file (`googleAuthCount`) và cảnh báo khi bằng 0, nên trường hợp này không còn được báo là "nạp thành công".
6. **Ghi vào sai jar**: hai trong ba menu sync ghi vào `getActiveTabSession()` (xem RC1).

### 3.2 "Rất nhanh hết"

- **Cookie rotating bị copy**: Google phát `__Secure-1PSIDTS`/`__Secure-3PSIDTS` và cặp `*PSIDRTS` TTL **vài phút** (bản ghi Chrome thật cho thấy `__Secure-3PSIDRTS` hết hạn trong ~10 phút). Copy sang AntiFan ⇒ **hai client cùng tranh một token xoay vòng**; client nào request sau với TS cũ sẽ bị Google vô hiệu ⇒ đăng xuất. Đây là cơ chế "đăng nhập rồi bị đá ra" đúng nghĩa.
- **TTL 30 ngày che lỗi thời giá trị**: import cấp cho *session cookie* 30 ngày, nhưng **giá trị** vẫn là bản sao cũ ⇒ server-side đã invalid từ lâu. Vault restore vì thế "thành công" nhưng không đăng nhập được.
- **Session cookie = 0 trên toàn bộ đĩa**: bất kỳ site nào đăng nhập bằng session cookie (không có `Expires`) sẽ mất khi đóng app, trừ khi đi qua đường import.
- **Kill/crash mất cookie chưa flush**: `main.log.1` có 13 sự kiện `crashed-terminal-session`/`crashed-run`. Bản ghi recovery hiện tại: `cleanShutdown: false`.
- **Import vào tab ephemeral**: nếu lúc bấm sync/restore mà tab đang focus là tab ephemeral (đang tồn tại thật: `ephemeral-profile-profile-2-6g9ayx3i`, in-memory), toàn bộ cookie vào RAM và **mất khi tab đóng** — biểu hiện "ăn" rồi "không ăn" ngay trong một phiên.

### 3.3 "Lúc ăn lúc không" — ma trận đích ghi

| Hành động | Jar đích | Sống qua đóng tab | Sống qua restart | Sống qua kill |
|---|---|---|---|---|
| Menu hệ thống → Sync (app-menu) | `persist:profile-<id>` | ✅ | ✅ (flush êm) | ⚠️ mất phần chưa flush |
| Toolbar/Context menu → Sync | `getActiveTabSession()` | ❌ nếu tab ephemeral/capsule | ❌ (ephemeral) | ❌ |
| Vault Export/Import | `getActiveTabSession()` | ❌ nếu tab ephemeral | ❌ | ❌ |
| Page tự set cookie | jar của tab | ✅ | ✅ | ⚠️ |
| Capsule cô lập (mở tab isolate) | `persist:capsule-<id>` | ✅ | ✅ | ⚠️ nhưng **không UI nào truy cập lại** |

### 3.4 Về fingerprint (yếu tố phụ nhưng đo được)

- UA app phát ra: `Mozilla/5.0 (Windows NT 10.0; Win64; x64) … Chrome/150.0.7871.224 Safari/537.36` — **lệch 3 major** so với Chrome thật đã tạo cookie (`153.0.8010.50`).
- `navigator.userAgentData.brands` = `[]` (rỗng) trong khi Chrome thật luôn trả 3 brand ⇒ bất thường client-hint trên mọi request `https://`.
- `setupClientHintsOverride` ghi đè `sec-ch-ua` sang major của Electron cho toàn bộ request https.
- Cookie Google hiện diện trong live jar **đọc được bằng `document.cookie`**: `SID`, `APISID`, `SAPISID`, `__Secure-1PAPISID`, `__Secure-3PAPISID`, `OTZ`, `SEARCH_SAMESITE`, `SIDCC` — các cookie này ở Chrome thật là `HttpOnly`. Việc chúng lộ ra JS nghĩa là một đường ghi **không phải Chrome** đã tạo/đè hàng cookie đó (đường import hoặc JS của trang), tạo khả năng tồn tại **cặp cookie trùng tên** (bản HttpOnly cũ vs bản mới) → request nào gặp bản sai thì "không ăn".
  Trạng thái đo được tại thời điểm này: `https://myaccount.google.com/` → chuyển tới `www.google.com/account/about/?hl=en-US`, tức **phiên Google đang hợp lệ** ⇒ triệu chứng là *mất phiên muộn*, không phải hỏng ngay.

---

## 4. Phụ Lục Bằng Chứng (tái lập được)

```bash
# 1. Kiểm kê kho cookie + số cookie có auth Google
python - <<'PY'
import os,sqlite3
base=r'E:/Work/.antifan-data/Profile/Partitions'
for d in sorted(os.listdir(base)):
    ck=os.path.join(base,d,'Network','Cookies')
    if not os.path.exists(ck): continue
    con=sqlite3.connect('file:'+ck.replace('\\','/')+'?mode=ro',uri=True)
    n=con.execute('select count(*) from cookies').fetchone()[0]
    auth=con.execute("select count(*) from cookies where name in ('SID','HSID','SSID','__Secure-1PSID','__Secure-3PSID','__Secure-1PSIDTS','__Secure-3PSIDTS')").fetchone()[0]
    print(f'{d:56s} cookies={n:5d} auth={auth}')
PY

# 2. Vault: có cookie auth Google không?
python -c "import json;d=json.load(open(r'E:/Work/.antifan-data/config/session-vault.json',encoding='utf-8'));print(len(d),[c['name'] for c in d if 'google' in c['domain']])"

# 3. Cache: cấu hình vs thực tế
du -sk E:/Work/.antifan-data/Profile-cache E:/Work/.antifan-data/Profile/Cache \
       E:/Work/.antifan-data/Profile/Partitions/profile-profile-2/Cache

# 4. Hai file state trùng tên, hai profile khác nhau
grep -o '"activeChromeProfileId"[^,]*' E:/Work/.antifan-data/config/saved-tabs.json \
                                       E:/Work/.antifan-data/Profile/saved-tabs.json

# 5. Native messaging host (extension path) có đăng ký nhưng extension không cài
reg query "HKCU\Software\Google\Chrome\NativeMessagingHosts" /s
```

Live probe (MCP): `anti.browser.tabs.list` → 10 tab, `partition = persist:profile-profile-2`, 1 tab `ephemeral-profile-profile-2-…`; `anti.browser.evaluate` trên tab jar-chung → UA `Chrome/150.0.7871.224`, `userAgentData.brands = []`, `document.cookie` chứa `SID`.

---

## 5. Đã Thực Hiện + Bằng Chứng (cập nhật 2026-09-19, sau khi bản nghiên cứu này chốt)

Trạng thái từng đề xuất ở §5 bản gốc. Mọi dòng "đã" dưới đây đều có lệnh chạy lại được.

### P0 — đúng đắn ("lúc ăn lúc không")
1. **Đã** — `getActiveTabSession()` bị xoá hẳn khỏi `src/main` (grep = 0 lần gọi). Mọi đường ghi credential đi qua một resolver duy nhất `NativeTabHost.resolveTargetProfileSession(profileId?, userAgentMode?)`, fail-closed: partition phải khớp `persist:profile-*`, nếu không thì ném `TARGET_SESSION_INVALID` thay vì ghi. Sáu điểm vào dùng nó: `app-menu.ts:195,213,228`, `native-tab-host.ts:2903` (toolbar), `tab-context-menu.ts:277`, `native-tab-host.ts:1437` (IPC).
2. **Đã** — `local-session-vault.ts:236-246` (`resolveCredentialJar`) chặn ở tầng thấp: `EPHEMERAL_TARGET_REJECTED` cho jar RAM, `CAPSULE_TARGET_REJECTED` cho jar workspace; export/import/CDP đều phải qua hàm này trước khi chạm một cookie nào.
3. **Đã** — export trả `targetJar` và UI in ra; thêm `EMPTY_STORE_REJECTED` để "backup của rỗng" không ghi đè bản tốt (`local-session-vault.ts:264-266`). Cảnh báo "vault này không có phiên Google" **đã làm**: `local-session-vault.ts` đếm cookie đăng nhập Google (`SID`/`HSID`/`SSID`/`APISID`/`SAPISID`/`__Secure-1PSID`/`__Secure-3PSID`/`__Secure-1PAPISID`/`__Secure-3PAPISID`/`LOGIN_INFO` trên miền `google.com`/`google.com.vn`/`youtube.com`, biên `SID@.notgoogle.com` bị loại) và trả `googleAuthCount` cho cả export lẫn import; `app-menu.ts` chuyển hộp thoại restore sang `warning` kèm `detail` khi file không có cookie đăng nhập nào.
4. **Đã** — allowlist bên nhận của kênh extension Companion được bổ sung 7 miền mà extension gửi nhưng bên nhận chưa nhận (`google.com`, `youtube.com`, `googleusercontent.com`, `gstatic.com`, `google.com.vn`, `shopifycloud.com`, `bizweb.vn`) sau khi chứng minh bằng probe rằng một lượt import thật trả `importedCount: 0` cho cookie Google; `/api/cookies/import` thêm `filteredCount` và popup extension chỉ báo thành công khi bên nhận ghi được > 0 cookie. Danh sách vẫn giữ **thủ công** (không suy ra từ `SCOPE_PROFILES`) vì đây là biên giới hạn quyền; hợp đồng giữa hai danh sách do test `extension-companion-pipeline` chốt.

### P1 — vệ sinh dữ liệu
4. **Đã (và đã chạy thật)** — `capsule-partition-migration.ts:99-109` cắt *mọi* tiền tố `capsule-` rồi mới ánh xạ `persist:profile-<id>`, nên đích migration là namespace resolver thật sự mở được. 84 store chết (43 `capsule-capsule-*` + 41 `profile-capsule-*`) đã được thu hồi: `node scripts/prune-dead-stores.cjs --apply` → `deletedPartitions: 84`, `errors: []`, chạy lại `scanned: 0` (idempotent). Chỉ còn `Partitions/profile-profile-2` (jar sống, được veto).
5. **Đã** — `config/saved-tabs.json` (bản Default cũ) + 2 file `saved-tabs.json.tmp.*` + 2 file `.bridge-dev.json.tmp.*` nằm trong `deletedFiles` của cùng lượt reclaim.
6. **Đã** — switch `--disk-cache-dir` đã bỏ khỏi `src/main/index.ts` kèm ghi chú đo được; `Profile/Cache` (220 MB, mtime 2026-08-30) được thu hồi về 2 KB. Lưu ý đã hiệu chỉnh lại nhận định cũ: `--disk-cache-size` **không** chặn cache của partition (`Partitions/profile-profile-2/Cache` đo được 168–171 MB trong khi switch đặt 128 MB) — cache partition do Chromium tự evict, nên ghi chú trong code nay nói đúng như vậy.

### P2 — tính bền của phiên ("rất nhanh hết")
7. **Chấp nhận, không sửa bằng code** — cookie xoay vòng của Google (`*PSIDTS`/`*PSIDRTS`) là single-owner; copy sang client thứ hai thì hai client đá nhau. Chiến lược chốt: coi AntiFan là owner riêng (đăng nhập một lần trong app) hoặc dùng vault như bản sao một chiều, không share vòng xoay.
8. **Không làm** — không thêm "keep-alive + re-import định kỳ": thay vào đó TTL 30 ngày cho cookie session khi import (`chrome-profile-sync.ts:100`) và flush theo thay đổi (mục 9) đã đủ để phiên sống qua restart; re-import định kỳ sẽ tranh vòng xoay ở mục 7.
9. **Đã, có kiểm chứng bằng kill thật** — `browser/cookie-durability.ts` gắn listener `cookies.on('changed')` cho mọi partition cấu hình qua đường app, debounce 1000 ms rồi `flushStore()`. Smoke `test/e2e/cookie-hardkill-worker.cjs` (2 jar: một qua `configureBrowserSessionPartition`, một mở trực tiếp) → `SET_JSON.armedReArm=false` (đường production thật sự đã arm), `FLUSH_OBSERVED` trước khi kill, `taskkill /F` rồi đọc lại: jar armed **còn** cookie, jar control **mất** — đúng như khiếm khuyết dự đoán. Chạy cả khi app thật đang mở và khi suite full đang chạy: PASS.
10. **Chưa kết luận** — A/B fingerprint (UA `Chrome/150.0.7871.224` + `userAgentData.brands = []` so với UA đồng bộ) vẫn chưa chạy; giữ nguyên là suy luận có căn cứ số liệu, không phải nguyên nhân đã xác nhận.

### Lệnh tái lập
```bash
npm run compile
npm run test:main                      # 1365 test, 0 fail (2026-09-19)
npm run prune:dead-stores              # dry-run: inventory + veto list
npm run prune:dead-stores -- --apply   # thu hồi; chạy lại phải là no-op
node scripts/smoke-cookie-hardkill-durability.cjs   # durability sau kill cứng
node scripts/smoke-boot-housekeeping.cjs            # reclaim ở boot (2 lần boot, root tạm)
node scripts/smoke-cdp-hydration.cjs                # import CDP → jar đúng, cookie đọc lại được
```
