# Anonymized candidate scout reports — ultra-retention-2026-10-10

Five independent read-only scout passes over the same evidence packet (`plans/reports/261010-cookie-cache-retention-ultra-packet.md`). Labels X1..X5 carry no ordering meaning.

## X1

```json
{
 "relevantFiles": [
  {
   "path": "plans/reports/261010-cookie-cache-retention-ultra-packet.md",
   "role": "Phạm vi T1–T6 và số liệu đo dung lượng; dùng làm nguồn Tier-1, không đo lại DB."
  },
  {
   "path": "src/main/browser/chrome-profile-sync.ts",
   "role": "Hàm chuyển đổi cookie import, expiry hiện hữu và TTL mặc định/tuỳ chọn cho cookie phiên."
  },
  {
   "path": "src/main/browser/local-session-vault.ts",
   "role": "Xuất vault JSON dạng plaintext và import cookie phiên với TTL 30 ngày."
  },
  {
   "path": "src/main/browser/cookie-durability.ts",
   "role": "Flush cookie-store có debounce sau khi cookie thay đổi."
  },
  {
   "path": "src/main/browser/browser-session-partition.ts",
   "role": "Phân biệt partition bền vững/ephemeral và gắn cookie durability cho partition persist:."
  },
  {
   "path": "src/main/browser/native-tab-host.ts",
   "role": "Xoá dữ liệu origin, reload thường, tự reload sau thay đổi preview và flush session khi dispose."
  },
  {
   "path": "src/main/browser/dead-store-cleaner.ts",
   "role": "Xác định partition/cache/file cụ thể có thể được thu hồi và các điều kiện bảo vệ."
  },
  {
   "path": "src/main/index.ts",
   "role": "Cấu hình các cache switches và gọi housekeeping lúc khởi động."
  },
  {
   "path": "src/main/config/storage-locations.ts",
   "role": "Hằng số cache default-session, các thư mục dữ liệu và khởi tạo DACL trên Windows."
  },
  {
   "path": "src/main/security/windows-acl.ts",
   "role": "Thiết lập/xác minh DACL chỉ cấp quyền cho user hiện tại và SYSTEM."
  },
  {
   "path": "src/extension/cookie-debouncer.ts",
   "role": "Chính sách đồng bộ cookie từ extension, loại bỏ các removal không explicit."
  },
  {
   "path": "src/main/tools/artifact-retention-cleaner.ts",
   "role": "Thu hồi artifact theo tuổi/ngân sách, phạm vi chỉ áp dụng artifact run-scoped."
  },
  {
   "path": "src/main/control-plane/control-plane-runtime.ts",
   "role": "Bật cleaner artifact theo mặc định và cho phép override ngưỡng bằng biến môi trường."
  },
  {
   "path": "src/main/tools/browser-control-port.ts",
   "role": "Triển khai reload thường và reload zero-network cho trang local."
  }
 ],
 "findings": [
  {
   "target": "T1",
   "claim": "TTL cookie được quyết định ở nơi cấp cookie: cookie import có expiry rõ ràng giữ expiry đó; chỉ cookie phiên được cấu hình persist mới được gán expiry mặc định 30 ngày. Vault import bật chế độ này; mã nguồn không chỉ ra TTL tổng quát áp cho cookie do trang tự set.",
   "evidence": [
    "src/main/browser/chrome-profile-sync.ts:44-44,79-83: chỉ khi không có expires hợp lệ và persistSessionCookies bật thì gán expirationDate; TTL lấy từ options hoặc 30 ngày.",
    "src/main/browser/chrome-profile-sync.ts:120-121,156-177: import extension giữ expirationDate có sẵn; chỉ persistSessionCookies hoặc cookie.persistSession mới nâng cookie phiên thành cookie có expiry.",
    "src/main/browser/local-session-vault.ts:454-457: vault import bật persistSessionCookies và truyền 30 ngày.",
    "src/main/browser/cookie-durability.ts:18-24,32-34: mọi thay đổi cookie được debounce một giây rồi gọi flushStore; đây là durability xuống store, không phải gia hạn expiry.",
    "src/main/browser/browser-session-partition.ts:124-132: chỉ partition bắt đầu persist: được arm cookie durability.",
    "plans/reports/261010-cookie-cache-retention-ultra-packet.md §3: trước đó đo được 0 session cookies trên 86 stores; xa nhất 2027-10-10. Phân phối expiry của DB đang chạy lần này chưa đo."
   ],
   "verified": true,
   "answerImpact": "Không ủng hộ giữ mọi cookie càng lâu càng tốt: tuổi thọ dài không cứu token đã bị server thu hồi/rotate; TTL 30 ngày chỉ áp cho một số cookie phiên được import. Flush một giây cải thiện sống sót khi app bị kill nhưng không thay đổi chính sách expiry."
  },
  {
   "target": "T1",
   "claim": "[EXTERNAL] Tài liệu Chromium Cookie Manager quy định cookie persistent có expiry do thời điểm hết hạn quyết định và Chromium áp dụng giới hạn lifetime/expiry riêng; chưa xác minh tài liệu/version cụ thể cho runtime đang dùng nên không kết luận giới hạn số ngày ở đây.",
   "evidence": [
    "plans/reports/261010-cookie-cache-retention-ultra-packet.md §5 yêu cầu mọi hành vi expiry cap Chromium phải ghi nhãn external; tài liệu Chromium không được mở trong lượt scout này."
   ],
   "verified": false,
   "answerImpact": "Cần giữ bất định về giới hạn expiry tối đa của Chromium; không dùng con số cap chưa kiểm chứng để khuyến nghị retention."
  },
  {
   "target": "T2",
   "claim": "Nút clear site data chỉ xoá cookies, localStorage và CacheStorage của origin HTTP(S) hiện tại, sau đó reload; các URL không có HTTP(S) origin bị từ chối để tránh xoá cả partition.",
   "evidence": [
    "src/main/browser/native-tab-host.ts:6963-6975: chỉ chấp nhận origin HTTP(S), thiếu origin thì trả UNSUPPORTED_ORIGIN.",
    "src/main/browser/native-tab-host.ts:6978-6988: clearStorageData({origin, storages:['cookies','localstorage','cachestorage']}) rồi reload desktop/mobile view.",
    "src/main/browser/native-tab-host.ts:6120-6122: menu site hiển thị mục Clear Cookies & Cache for this site.",
    "src/main/browser/app-menu.ts:720-722: menu app gọi cùng clearStorageForActiveTab."
   ],
   "verified": true,
   "answerImpact": "Có thao tác xoá có chủ đích nhưng phạm vi được khóa theo origin hiện tại; nên phân biệt dọn đúng một origin với việc xoá cache HTTP hoặc mọi dữ liệu partition."
  },
  {
   "target": "T2",
   "claim": "Cleaner tự động chỉ xoá partition legacy có tên khớp hai mẫu chết; cache Profile/Cache chỉ bị dọn khi không có tab dùng default session và thư mục im lặng ít nhất một ngày. Cleaner không phải cơ chế xoá jar profile sống hay cache partition hiện hành.",
   "evidence": [
    "src/main/browser/dead-store-cleaner.ts:13-29: inventory giới hạn ở capsule-capsule-*, profile-capsule-*, default Profile/Cache, duplicate saved-tabs và temp files.",
    "src/main/browser/dead-store-cleaner.ts:48-57: regex partition chết chỉ khớp hai namespace legacy.",
    "src/main/browser/dead-store-cleaner.ts:195-215: xoá dead partition trừ partition đang live; default cache chỉ khi không live default và quiet một ngày.",
    "src/main/index.ts:4583-4616: boot pass lấy live partitions, chạy dry-run rồi áp dụng pruneDeadStores.",
    "plans/reports/261010-cookie-cache-retention-ultra-packet.md §3: số liệu báo Profile/Cache 5.6 MB; không báo thao tác dọn partition sống."
   ],
   "verified": true,
   "answerImpact": "Housekeeping bảo vệ jar đang dùng và không đặt giới hạn tuổi tối đa cho dữ liệu partition đó. Giữ lâu được, nhưng phần dữ liệu orphan/legacy sẽ được thu hồi có điều kiện."
  },
  {
   "target": "T2",
   "claim": "Extension không gửi removal cookie do eviction/expiry/overwrite sang AntiFan; chỉ removal cause explicit mới được đồng bộ. Do đó không thể coi extension là đường đồng bộ đầy đủ cho mọi thao tác hết hạn hoặc eviction.",
   "evidence": [
    "src/extension/cookie-debouncer.ts:55-64: removal có cause khác explicit bị bỏ; comment nêu mục đích duy trì lifetime riêng của AntiFan.",
    "src/extension/cookie-debouncer.ts:66-70: cookie đã hết hạn bị loại khỏi hàng đợi upsert."
   ],
   "verified": true,
   "answerImpact": "Cookie trong AntiFan có thể tồn tại độc lập sau khi nguồn Chrome/extension đã bị eviction hoặc expiry; đây là rủi ro stale credential, không phải căn cứ để tăng retention."
  },
  {
   "target": "T2",
   "claim": "Partition ephemeral được đặt tên không bền vững và được xác định là không thể persist; cleanup policy cụ thể khi đóng tab/app không được chứng minh bởi đoạn mã đã đọc.",
   "evidence": [
    "src/main/browser/browser-session-partition.ts:20-27: isEphemeralSession nhận dạng ephemeral-* và non-persistent session.",
    "src/main/browser/browser-session-partition.ts:51-70: partition ephemeral gồm nonce, còn partition thường được đặt persist:capsule-*.",
    "src/main/browser/browser-session-partition.ts:115-117: unconfigure chỉ xoá tracking của ephemeral partition, không thể hiện thao tác xoá storage."
   ],
   "verified": false,
   "answerImpact": "Không nên mặc định mọi trạng thái browser đều cần retention dài; ephemeral có nghĩa vụ sống khác hẳn. Việc xác định chính xác thời điểm thu hồi dữ liệu ephemeral còn thiếu."
  },
  {
   "target": "T3",
   "claim": "Các cache switches đặt 128 MB disk/64 MB media và GPU cache có đường dẫn riêng, nhưng comment vận hành nói chúng chỉ ràng buộc default-session cache; cache của partition sống không bị giới hạn bởi --disk-cache-size và tự eviction theo chính sách Chromium.",
   "evidence": [
    "src/main/config/storage-locations.ts:12-19: DISK_CACHE_BYTES=128 MB và MEDIA_CACHE_BYTES=64 MB, mô tả là ngân sách default-session.",
    "src/main/index.ts:295-305: --disk-cache-dir bị bỏ; comment nói switch không giới hạn cache partition, đo 168–171 MB khi switch là 128 MB.",
    "src/main/index.ts:305,318-319: gpu-cache-dir, disk-cache-size và media-cache-size được cấu hình.",
    "plans/reports/261010-cookie-cache-retention-ultra-packet.md §3: cache HTTP partition 150.0 MB, Code Cache/js 301.1 MB, Code Cache/wasm 450.8 MB, Service Worker CacheStorage 204.9 MB, ScriptCache 6.9 MB; IndexedDB 32.6 MB."
   ],
   "verified": true,
   "answerImpact": "HTTP cache partition có eviction quan sát được (150 MB/727 file, rolling khoảng 8 ngày theo packet), nhưng tổng các vùng cache/code/service worker/IndexedDB lớn hơn nhiều; không có một budget tổng thể được xác nhận cho partition. ‘Giữ cache càng lâu càng tốt’ không đồng nghĩa không tốn dung lượng."
  },
  {
   "target": "T3",
   "claim": "[EXTERNAL] Chính sách quota/eviction của Chromium cho CacheStorage, IndexedDB và V8 Code Cache có thể khác giới hạn disk-cache-size; nguồn Chromium không được tra cứu trong lượt này, nên không suy ra ngưỡng/cơ chế cụ thể từ số liệu thư mục.",
   "evidence": [
    "plans/reports/261010-cookie-cache-retention-ultra-packet.md §3: số liệu hiện trường riêng cho CacheStorage, Code Cache và IndexedDB; packet không cung cấp ngưỡng eviction của chúng.",
    "src/main/index.ts:295-305: chỉ khẳng định qua comment rằng disk-cache-size không giới hạn per-partition HTTP cache."
   ],
   "verified": false,
   "answerImpact": "Không thể cam kết Code Cache, CacheStorage hay IndexedDB sẽ tự thu gọn theo cùng budget HTTP cache; các vùng tăng trưởng lớn là điểm cần cân nhắc dung lượng."
  },
  {
   "target": "T4",
   "claim": "Reload chung gọi WebContents.reload() thông thường; đường reloadZeroNetwork là capability riêng, chỉ chấp nhận localhost, 127.0.0.1 hoặc file và chặn network trong transaction. Mã đọc được không cho thấy một hành động reload-ignore-cache cho preview từ xa.",
   "evidence": [
    "src/main/browser/native-tab-host.ts:10663-10687: reload gọi wc.reload() cho view, không truyền cờ ignore cache.",
    "src/main/tools/browser-control-port.ts:2320-2345: reloadZeroNetwork được mô tả là opt-in, không áp dụng remote storefront reload.",
    "src/main/tools/browser-control-port.ts:2350-2378: zero-network reload từ chối domain ngoài local origins.",
    "src/main/tools/browser/browser-control-port.ts:2282-2298: đường reload thông thường gọi host.reloadAndWait hoặc host.reload."
   ],
   "verified": true,
   "answerImpact": "Không có bằng chứng reload thường bỏ qua cache; với storefront/theme preview từ xa, cache có thể ảnh hưởng khả năng thấy output mới. Không nên hứa việc reload tiêu chuẩn luôn lấy tài nguyên mới."
  },
  {
   "target": "T4",
   "claim": "Đường preview watcher có xử lý đổi CSS bằng cách thêm tham số antifan_ts vào URL stylesheet; thay đổi khác gọi reload thông thường cho desktop/mobile. Không có bằng chứng cơ chế cache-bust tương đương cho mọi JS/Liquid/resource.",
   "evidence": [
    "src/main/browser/native-tab-host.ts:15519-15533: dispatchScopedReload chọn nhánh css-swap, sửa href stylesheet với antifan_ts; nhánh khác gọi reload()."
   ],
   "verified": true,
   "answerImpact": "Đổi CSS qua watcher có cache-busting rõ ràng, nhưng không thể khái quát sang mọi tài nguyên; khi dev thấy output cũ, còn cần kiểm tra loại thay đổi/path."
  },
  {
   "target": "T4",
   "claim": "Clear site data không dọn HTTP cache theo danh sách storages được truyền vào; CacheStorage được xoá, nhưng HTTP cache không được nêu. Không tìm thấy trong các tìm kiếm mã đã thực hiện cờ DevTools disable cache hoặc service-worker bypass.",
   "evidence": [
    "src/main/browser/native-tab-host.ts:6981-6981: danh sách clear là cookies, localstorage, cachestorage; không có HTTP cache trong đối số.",
    "src/main/browser/native-tab-host.ts:6963-6965: comment chỉ cảnh báo clearStorageData thiếu origin sẽ xoá cả partition.",
    "Tìm kiếm literal trên src/main cho disableCache, setCacheEnabled, bypassServiceWorker, Network.setCacheDisabled và setBypassServiceWorker chỉ trả về các khớp clearStorageData; kết quả tìm kiếm là evidence search, không xác nhận mọi cách triển khai gián tiếp."
   ],
   "verified": true,
   "answerImpact": "Nút ‘Clear Cookies & Cache’ không nên được hiểu là đã xoá mọi tầng cache; HTTP cache và DevTools cache bypass chưa được chứng minh trong code đã khảo sát."
  },
  {
   "target": "T5",
   "claim": "Session vault xuất toàn bộ cookie dưới dạng JSON plaintext; không thấy mã hoá bằng safeStorage tại đường export. Data root có cơ chế thiết lập DACL Windows cho user hiện tại và SYSTEM, nhưng việc enforcement là async/best-effort ở ensureDirectories và vault file không có DACL riêng được chứng minh.",
   "evidence": [
    "src/main/browser/local-session-vault.ts:260-260: tên file mặc định session-vault.json.",
    "src/main/browser/local-session-vault.ts:301-341: cookie được serialize gồm name/value/domain/... rồi writeFile JSON UTF-8; không gọi safeStorage/encryption.",
    "src/main/config/storage-locations.ts:134-158: ensureDirectories gọi resolve SID/enforce DACL trên data root không đồng bộ và bắt lỗi để tiếp tục.",
    "src/main/security/windows-acl.ts:239-255: enforceProtectedDirectoryDacl kiểm tra DACL rồi sửa nếu cần và xác minh lại.",
    "src/main/security/windows-acl.ts:186-215: verifyProtectedSddl đòi DACL protected với đúng hai ACE SYSTEM/user.",
    "plans/reports/261010-cookie-cache-retention-ultra-packet.md §3: repo grep EnableCookieEncryption/flipFuses/FuseV1Options/@electron/fuses = 0 matches."
   ],
   "verified": true,
   "answerImpact": "Đây là lý do mạnh để không giữ bản export cookie lâu tuỳ tiện: vault là plaintext credential backup, dù data root có ý định giới hạn ACL. Cookie trong partition được bảo vệ bởi hệ lưu trữ Chromium, nhưng bật Electron cookie-encryption fuse không được chứng minh."
  },
  {
   "target": "T5",
   "claim": "Không thể khẳng định trạng thái ACL thực tế hiện tại hoặc hiệu lực của Electron cookie encryption fuse từ lượt đọc code; packet ghi nhận không tìm thấy cấu hình fuse nhưng không chứng minh hành vi mã hoá mặc định của Electron/Chromium.",
   "evidence": [
    "plans/reports/261010-cookie-cache-retention-ultra-packet.md §3: grep các cấu hình fuse bằng 0 match; không có kiểm tra live DACL trong packet.",
    "src/main/config/storage-locations.ts:154-158: lỗi enforce DACL bị bỏ qua."
   ],
   "verified": false,
   "answerImpact": "Nguy cơ at-rest không nên bị bỏ qua chỉ vì ACL được cài đặt trong code; cần xác minh trạng thái ACL đang áp dụng và semantics mã hoá runtime trước khi khuyến nghị giữ cookie vô thời hạn."
  },
  {
   "target": "T6",
   "claim": "Có dọn boot cho các partition legacy unreachable, cache default cũ, state duplicate và temp file; cache partition đang live không nằm trong inventory cleaner. Artifact run-scoped có cleaner riêng với giới hạn mặc định 200 MB/24 giờ; report evidence được loại trừ.",
   "evidence": [
    "src/main/browser/dead-store-cleaner.ts:13-29: phạm vi inventory cleaner.",
    "src/main/browser/dead-store-cleaner.ts:48-57,195-215: mẫu dead partition và điều kiện default cache.",
    "src/main/index.ts:4583-4616: gọi dry-run rồi apply sau migration.",
    "src/main/tools/artifact-retention-cleaner.ts:4-12,31-36: mặc định max 200 MB, age 24h, miễn artifact được bảo vệ; chỉ run-scoped artifacts.",
    "src/main/control-plane/control-plane-runtime.ts:90-106: retention bật vô điều kiện; env có thể chỉnh ngưỡng artifact."
   ],
   "verified": true,
   "answerImpact": "Housekeeping chỉ giải quyết một số nhóm dữ liệu; không phải bảo đảm cho toàn bộ data root. Có thể giữ cache làm tăng dung lượng lâu dài ở các vùng không thuộc cleaner."
  },
  {
   "target": "T6",
   "claim": "Số đo dung lượng cho thấy các vùng lớn ngoài HTTP cache gồm Code Cache/js, Code Cache/wasm và Service Worker CacheStorage; data root còn có baselines/control-plane/runtime/daemon-host. Số liệu là ảnh chụp ngày đo, không đủ để kết luận tốc độ tăng hoặc lifetime vô hạn.",
   "evidence": [
    "plans/reports/261010-cookie-cache-retention-ultra-packet.md §3: Code Cache/js 301.1 MB; Code Cache/wasm 450.8 MB; CacheStorage 204.9 MB; baseline 263.6 MB, control-plane-v2 175.5 MB, runtime 109.5 MB, daemon-host 82.5 MB.",
    "plans/reports/261010-cookie-cache-retention-ultra-packet.md §3: drive E có 95.6 GB free."
   ],
   "verified": true,
   "answerImpact": "Hiện có dư địa ổ đĩa theo snapshot, nhưng số liệu không chứng minh cache có thể tăng vô hạn an toàn. Giữ cache theo nhu cầu tiện dụng được, song không nên đặt mục tiêu tối đa lifetime bất kể dung lượng."
  }
 ],
 "unresolved": [
  "Không đọc database Cookies theo ràng buộc; phân phối expiry của jar sống chưa đo trong đợt này. Không xác định được cookie cụ thể nào sẽ hết hạn trước.",
  "Không xác minh được giới hạn expiry tối đa và chính sách quota/eviction chính xác của Chromium/Electron đang chạy; cần tra tài liệu chính thức có phiên bản hoặc runtime evidence.",
  "Không xác minh được liệu có DevTools UI/config khác hoặc service-worker bypass gián tiếp ngoài các pattern literal đã tìm; mã đã đọc không cho thấy toggle như vậy.",
  "Không xác minh trạng thái ACL live cho data root và không tìm thấy cấu hình cookie-encryption fuse; hiệu quả at-rest của cookie partition cần probe an toàn khác, không mở DB.",
  "Không khảo sát toàn bộ các thao tác xoá cookies/site data ngoài các kết quả search và code path được trích; không thấy cookies.remove trong search nhưng đây không phải chứng minh không tồn tại qua API/abstraction khác.",
  "Không có số đo xu hướng tăng trưởng theo thời gian cho Code Cache, CacheStorage, IndexedDB, baseline hoặc các thư mục data-root khác; snapshot hiện tại không dự báo dung lượng tương lai."
 ]
}
```

## X2

```json
{
 "relevantFiles": [
  {
   "path": "src/main/browser/chrome-profile-sync.ts",
   "role": "Converts imported cookie expiry/session attributes into Electron cookie-set details."
  },
  {
   "path": "src/main/browser/local-session-vault.ts",
   "role": "Exports cookie values as plaintext JSON and imports cookies with a 30-day TTL for session cookies."
  },
  {
   "path": "src/main/browser/cookie-durability.ts",
   "role": "Debounces durable cookie-store flushes after cookie changes."
  },
  {
   "path": "src/main/browser/browser-session-partition.ts",
   "role": "Defines persistent/capsule/ephemeral partitions and arms cookie durability on persistent partitions."
  },
  {
   "path": "src/main/browser/native-tab-host.ts",
   "role": "Implements site-scoped storage clearing and ordinary reload behavior."
  },
  {
   "path": "src/main/browser/app-menu.ts",
   "role": "Exposes cookie/site-data clearing UI and vault controls."
  },
  {
   "path": "src/main/browser/tab-context-menu.ts",
   "role": "Exposes per-site clear cookies/cache action."
  },
  {
   "path": "src/main/browser/dead-store-cleaner.ts",
   "role": "Guarded boot housekeeping for unreachable partitions and stale default-session cache."
  },
  {
   "path": "src/main/index.ts",
   "role": "Sets Chromium cache switches and invokes dead-store housekeeping and shutdown cookie flushes."
  },
  {
   "path": "src/main/config/storage-locations.ts",
   "role": "Defines cache-size constants, data-root paths, and Windows data-root DACL setup."
  },
  {
   "path": "src/main/security/windows-acl.ts",
   "role": "Implements restricted Windows directory ACL enforcement."
  },
  {
   "path": "src/main/server/preview-protocol-handler.ts",
   "role": "Serves local preview files with explicit no-cache/no-store response headers."
  },
  {
   "path": "docs/research-cache-cookie-mechanism.md",
   "role": "Prior read-only cookie/cache forensics and documented historical findings; some claims predate later fixes."
  },
  {
   "path": "plans/reports/261010-cookie-cache-retention-ultra-packet.md",
   "role": "Evidence packet including controller-measured storage sizes and stated repo fuse-search result."
  }
 ],
 "findings": [
  {
   "target": "T1",
   "claim": "Cookie persistence is not equivalent to keeping every cookie indefinitely: explicit imported expiry is preserved, while imported session cookies may be converted into 30-day persistent cookies; cookies set by pages are not given that application-level TTL. Persistent app-configured partitions flush changed cookies after a 1-second debounce, and shutdown also flushes sessions. Therefore durability improves restart survival, not server-side validity or the cookie's configured expiration.",
   "evidence": [
    "src/main/browser/chrome-profile-sync.ts:165-178 — expired imports are skipped; explicit expirationDate is preserved; absent expiry is raised to configurable/default TTL only when persistSessionCookies or cookie.persistSession is true.",
    "src/main/browser/local-session-vault.ts:454-456 — vault JSON import sets persistSessionCookies and 30-day TTL.",
    "src/main/browser/browser-session-partition.ts:127-132 — arms cookie durability only for persist: partitions.",
    "src/main/browser/cookie-durability.ts:20-23,43-59 — 1000ms trailing debounce; calls flushStore after cookie changes.",
    "src/main/index.ts:4890-4894 — shutdown flushes host sessions and default-session cookies.",
    "plans/reports/261010-cookie-cache-retention-ultra-packet.md §3 — historical prior measurement found zero session cookies across 86 stores; current live expiry distribution was not measured."
   ],
   "verified": true,
   "answerImpact": "A solo dev should retain needed persistent login cookies for convenience, but 'as long as possible' is not a universal rule: imported session cookies have a 30-day app TTL, explicit expiry remains, and durable storage cannot prevent site-side invalidation. Current live expiry mix remains unknown."
  },
  {
   "target": "T1",
   "claim": "[EXTERNAL] Chromium's maximum accepted cookie lifetime/expiry cap was not established from repository evidence or a cited external Chromium source in this scout.",
   "evidence": [
    "plans/reports/261010-cookie-cache-retention-ultra-packet.md §1-§6 — asks to consider Chromium expiry cap but provides no cap value or source."
   ],
   "verified": false,
   "answerImpact": "Do not claim that cookies can persist indefinitely or cite a specific Chromium cap based on this pass; the app's TTL and incoming expiry are verified, but platform cap is unresolved."
  },
  {
   "target": "T2",
   "claim": "The app's explicit Clear Cookies & Site Cache action is site-scoped and clears only cookies, localstorage, and cachestorage for the active HTTP(S) origin; it refuses unsupported origins rather than clearing the whole partition. It reloads the active view after clearing. No cookies.remove or other direct Electron cookie-removal call was found in the searched src tree.",
   "evidence": [
    "src/main/browser/native-tab-host.ts:6958-6981 — derives active page origin, refuses unsupported origin, invokes clearStorageData with storages ['cookies','localstorage','cachestorage'].",
    "src/main/browser/native-tab-host.ts:6982-6988 — reloads active and split mobile views after clearing.",
    "src/main/browser/app-menu.ts:721-722 — menu label/action.",
    "src/main/browser/native-tab-host.ts:6121-6122; src/main/browser/tab-context-menu.ts:374-375 — per-site context menu action.",
    "Search of src for cookies.remove, cookies.delete, removeCookie, clearStorageData found only this clearStorageData call."
   ],
   "verified": true,
   "answerImpact": "The built-in clear action can intentionally log the developer out of the active site's origin, so retention is user-reversible; it does not appear to be a global cookie purge."
  },
  {
   "target": "T2",
   "claim": "Boot housekeeping deletes only narrowly-patterned unreachable legacy capsule partitions and stale default-session cache/state debris, with live-partition vetoes and deferred deletion when files are held; it is not a routine purge of the live profile cookie jar.",
   "evidence": [
    "src/main/browser/dead-store-cleaner.ts:4-30 — enumerates legacy/unresolvable partitions and stale default-session cache, describes live/conflict/path guards.",
    "src/main/browser/dead-store-cleaner.ts:42-48 — exact dead partition name pattern excludes ordinary profile partitions.",
    "src/main/browser/dead-store-cleaner.ts:152-172 — live partition set and held-path deferral.",
    "src/main/index.ts:4595-4603 — passes live tab and derivable profile partitions to dry-run and apply cleaner."
   ],
   "verified": true,
   "answerImpact": "Retention of the live jar is not contradicted by current boot housekeeping; stale/orphaned data is reclaimed separately."
  },
  {
   "target": "T3",
   "claim": "The configured 128 MB disk-cache and 64 MB media-cache switches are explicitly documented as applying to the default session, not as bounds on the live explicit partition cache. The GPU cache directory switch points at a separate app cache directory; measured live profile data shows substantial Code Cache and Service Worker CacheStorage beyond HTTP cache.",
   "evidence": [
    "src/main/config/storage-locations.ts:13-20 — DISK_CACHE_BYTES=128 MB and MEDIA_CACHE_BYTES=64 MB.",
    "src/main/index.ts:295-305,318-319 — no disk-cache-dir; comment says switches do not bound per-partition caches, and sets gpu-cache-dir, disk-cache-size and media-cache-size.",
    "plans/reports/261010-cookie-cache-retention-ultra-packet.md §3 — measured live partition: HTTP Cache 150.0 MB, Code Cache/js 301.1 MB, Code Cache/wasm 450.8 MB, Service Worker/CacheStorage 204.9 MB, IndexedDB 32.6 MB; profile total 1,213.7 MB."
   ],
   "verified": true,
   "answerImpact": "Keeping all browsing data indefinitely is not free: the measured live partition's non-cookie caches dwarf cookies, while the configured switches are not a demonstrated global cap. Retain cookies intentionally, but not necessarily all cache/site data."
  },
  {
   "target": "T3",
   "claim": "[EXTERNAL] The precise eviction/bound behavior for live partition HTTP cache, V8 JS/Wasm Code Cache, Service Worker CacheStorage, and IndexedDB quota was not verified against an external Chromium/Electron source in this pass. The packet's observed rolling HTTP cache age/size is measurement, not a source-backed guarantee for future behavior.",
   "evidence": [
    "plans/reports/261010-cookie-cache-retention-ultra-packet.md §3 — measured cache sizes and HTTP cache oldest/newest mtimes; §4 identifies cache configuration anchors.",
    "src/main/index.ts:299-301 — code comment says partition backends evict under Chromium policy, but gives no algorithm/guaranteed ceiling."
   ],
   "verified": false,
   "answerImpact": "The observed HTTP cache is rolling, but do not promise bounded disk use or assume all other cache stores self-evict at a safe rate; storage headroom is a reason not to maximize retention indiscriminately."
  },
  {
   "target": "T4",
   "claim": "Ordinary reload uses WebContents.reload(), not an explicit reload-ignoring-cache operation; no reloadIgnoringCache token was found. The local preview protocol returns Cache-Control: no-cache, no-store, must-revalidate. The built-in clear action removes cache-storage but does not list HTTP cache, so it is not an HTTP cache invalidation control.",
   "evidence": [
    "src/main/browser/native-tab-host.ts:10663-10689 — reload() calls webContents.reload() for normal and split tabs.",
    "Search of src for reloadIgnoringCache found no matches.",
    "src/main/server/preview-protocol-handler.ts:73-78 — local preview response sends no-cache/no-store/must-revalidate.",
    "src/main/browser/native-tab-host.ts:6981 — clear storages omit HTTP cache; service worker CacheStorage is included."
   ],
   "verified": true,
   "answerImpact": "For locally served antifan-preview files, explicit no-store headers support freshness. For remote theme previews, this scout found no app-level cache-bypass guarantee; a developer should use DevTools/browser cache controls or verify the actual network response rather than assume reload gives fresh CSS/JS."
  },
  {
   "target": "T4",
   "claim": "[INFERENCE] This pass found no app source implementation of a DevTools disable-cache toggle or service-worker bypass control in the targeted source search; absence of a matching string does not prove Electron/DevTools lacks such a user-operated feature.",
   "evidence": [
    "Search of src/main for serviceWorker, disableCache, bypass.*cache, cache-bust, no-cache, Cache-Control, ignoreCache yielded only preview-protocol-handler.ts's response header.",
    "src/main/browser/native-tab-host.ts:10663-10689 — normal reload path."
   ],
   "verified": false,
   "answerImpact": "Do not present an app-provided bypass as confirmed; stale remote preview output remains a practical development risk outside the local preview handler."
  },
  {
   "target": "T5",
   "claim": "Session-vault.json is not encrypted by the code shown: export serializes cookie name/value/domain/path and other metadata directly to JSON and writes UTF-8. This differs from the separate password vault, which uses safeStorage. The data root attempts to enforce a user-and-SYSTEM-only DACL, but its setup is asynchronous and failures are non-fatal, so that is not proof every vault file is currently protected.",
   "evidence": [
    "src/main/browser/local-session-vault.ts:318-332 — exports cookie values into VaultCookie records.",
    "src/main/browser/local-session-vault.ts:355-363 — writes JSON as UTF-8 plaintext.",
    "src/main/browser/local-credential-vault.ts:2-5,15-18 — separate password vault uses safeStorage encryption.",
    "src/main/config/storage-locations.ts:145-159 — schedules root DACL enforcement asynchronously and catches failures.",
    "src/main/security/windows-acl.ts:225-257 — directory ACL grants full control to current user and SYSTEM with inheritance disabled; verifies after repair."
   ],
   "verified": true,
   "answerImpact": "Long-lived cookies in the browser jar and especially manual session-vault exports are credential material. Keep only what is useful, protect the machine/account, and treat exported session-vault.json as plaintext secrets; 'keep as long as possible' increases exposure duration."
  },
  {
   "target": "T5",
   "claim": "[INFERENCE] The packet reports zero source matches for Electron cookie-encryption fuse configuration, so this pass has no evidence that Electron's cookie-encryption fuse is explicitly enabled. No external Electron source was consulted to establish default behavior.",
   "evidence": [
    "plans/reports/261010-cookie-cache-retention-ultra-packet.md §3 — repository search result is 0 matches for EnableCookieEncryption, flipFuses, FuseV1Options, @electron/fuses."
   ],
   "verified": false,
   "answerImpact": "At-rest protection for Chromium cookie DB encryption is unresolved; do not assume the browser cookie store is encrypted from the fuse based on this evidence. Plaintext vault export is independently verified."
  },
  {
   "target": "T6",
   "claim": "The only cookie/profile housekeeping path found is guarded dead-store cleanup at boot, including unheld stale default-session HTTP cache; the packet's measured profile/live partition occupies about 1.2 GB and drive free space is about 95.6 GB. Current measurements show substantial cache/storage growth but do not establish an unbounded growth rate.",
   "evidence": [
    "src/main/index.ts:4595-4616 — boot dead-store cleanup after legacy migration.",
    "src/main/browser/dead-store-cleaner.ts:10-19,27-30 — cleanup inventory includes dead partition patterns and stale default cache, guarded/idempotent.",
    "plans/reports/261010-cookie-cache-retention-ultra-packet.md §3 — Profile 1,213.7 MB; live partition 1,200.8 MB; free drive 95.6 GB; largest measured caches as listed in T3."
   ],
   "verified": true,
   "answerImpact": "Space is not presently near exhaustion per the packet's measurement, but caches and site storage constitute most of the profile. Keep the working cookie jar; use selective site-data cleanup or inspect disk growth rather than retaining every cache forever."
  }
 ],
 "unresolved": [
  "Current live cookie expiry distribution was not measured in this session (packet §3); the earlier 2026-09-19 result is historical and from 86 stores.",
  "Chromium/Electron maximum cookie expiration cap and exact cache quota/eviction policies need a source-backed external check.",
  "It is not established whether Electron cookie DB encryption is enabled by packaging/runtime fuse settings; packet reports zero matching source references.",
  "No evidence from this read-only source pass establishes current effective NTFS ACLs on the live data root or the actual ACL of session-vault.json.",
  "Remote storefront/preview cache behavior and whether DevTools disable-cache/service-worker bypass is enabled in the user's current session were not live-tested."
 ]
}
```

## X3

```json
{
 "relevantFiles": [
  {
   "path": "plans/reports/261010-cookie-cache-retention-ultra-packet.md",
   "role": "Defines the six scouting targets and supplies the controller's measured disk/cache facts."
  },
  {
   "path": "src/main/browser/chrome-profile-sync.ts",
   "role": "Builds cookies.set payloads and determines whether imported session cookies gain an expiry."
  },
  {
   "path": "src/main/browser/local-session-vault.ts",
   "role": "Exports cookies as plaintext JSON and imports them with a 30-day fallback TTL."
  },
  {
   "path": "src/main/browser/cookie-durability.ts",
   "role": "Debounces cookie changes and flushes durable cookie stores."
  },
  {
   "path": "src/main/browser/browser-session-partition.ts",
   "role": "Classifies persistent, ephemeral, and capsule sessions and arms cookie durability for persistent partitions."
  },
  {
   "path": "src/main/browser/native-tab-host.ts",
   "role": "Clears active-site storage, reloads tabs, and applies workspace preview change reloads."
  },
  {
   "path": "src/main/browser/dead-store-cleaner.ts",
   "role": "Deletes only enumerated dead partitions and guarded stale cache/state artifacts."
  },
  {
   "path": "src/main/index.ts",
   "role": "Configures Chromium cache switches and runs guarded dead-store cleanup at startup."
  },
  {
   "path": "src/main/config/storage-locations.ts",
   "role": "Defines cache budgets, data-root paths, and asynchronous user-only DACL setup."
  },
  {
   "path": "src/main/security/windows-acl.ts",
   "role": "Implements Windows protected-directory DACL checks and enforcement helpers."
  },
  {
   "path": "src/main/bridge/bridge-server.ts",
   "role": "Refuses extension-side cookie removals and performs additive cookie hydration."
  },
  {
   "path": "src/extension/cookie-debouncer.ts",
   "role": "Suppresses non-explicit extension cookie-removal events before sync."
  },
  {
   "path": "src/main/browser/app-menu.ts",
   "role": "Exposes the Clear Cookies & Site Cache menu action."
  },
  {
   "path": "docs/research-cache-cookie-mechanism.md",
   "role": "Earlier cookie/cache forensic findings and stated post-fix status, used as contextual evidence only."
  }
 ],
 "findings": [
  {
   "target": "T1",
   "claim": "A cookie's expiry is generally retained from its source; only imports configured to persist session cookies promote a no-expiry cookie to a persistent cookie, with the session-vault path assigning 30 days. This is not an instruction to keep every cookie indefinitely.",
   "evidence": [
    "src/main/browser/chrome-profile-sync.ts:59-75 — explicit positive expiry is retained (after expired-cookie rejection); absent expiry is promoted only when persistSessionCookies is true, using sessionTtlSeconds/default TTL.",
    "src/main/browser/chrome-profile-sync.ts:166-180 — extension-import path likewise uses expirationDate when provided and only otherwise assigns TTL when configured or cookie.persistSession is true.",
    "src/main/browser/local-session-vault.ts:447-449 — vault imports pass persistSessionCookies:true and a 30*24*60*60-second TTL.",
    "src/main/browser/local-session-vault.ts:476-491 — vault imports set cookies and explicitly flush the store."
   ],
   "verified": true,
   "answerImpact": "Keep ordinary source-defined expiry semantics; the 30-day fallback is an import policy, not a reason to extend all cookies. The user's 'as long as possible' premise is unsafe for copied/session credentials; a copied cookie may no longer be valid server-side."
  },
  {
   "target": "T1",
   "claim": "Persistent partition cookie changes are flushed after a trailing-edge 1,000 ms quiet period; ephemeral partitions are intentionally non-durable. This supports restart survival but does not mean session cookies with no Expires become persistent.",
   "evidence": [
    "src/main/browser/cookie-durability.ts:20-31 — documents the debounce and flushStore behavior.",
    "src/main/browser/cookie-durability.ts:43-64 — on changed, resets timer and calls flushStore after debounceMs; default is 1000 ms at line 29.",
    "src/main/browser/browser-session-partition.ts:124-133 — configures session and arms durability only for partition names starting with persist:.",
    "src/main/browser/browser-session-partition.ts:16-28 — identifies ephemeral sessions as in-memory/nonpersistent."
   ],
   "verified": true,
   "answerImpact": "The current durability path reduces loss of persistent cookie writes but does not warrant artificially lengthening cookie expiry. Whether an actual browser-issued session cookie survives process restart depends on Chromium/Electron behavior not fully established by these code lines."
  },
  {
   "target": "T1",
   "claim": "[INFERENCE] The repo evidence does not establish Chromium's maximum persistent-cookie expiry cap or prove the live jar's current session-cookie survival; consult Chromium/Electron primary documentation or a safe non-credential test before making either claim.",
   "evidence": [
    "plans/reports/261010-cookie-cache-retention-ultra-packet.md §3: live Cookies DB is locked and expiry distribution was not measured; prior 2026-09-19 measurement reported zero session cookies across 86 stores.",
    "src/main/browser/chrome-profile-sync.ts:59-75 — app maps supplied expiry values but has no visible cap enforcement in the inspected function."
   ],
   "verified": false,
   "answerImpact": "Do not promise unlimited cookie lifetime or assert a specific expiry cap. The controller's prior measurement is historical and cannot establish current live expiry."
  },
  {
   "target": "T2",
   "claim": "The user-facing clear-site-data action clears cookies, local storage, and CacheStorage for only the active HTTP(S) origin; it refuses unsupported URLs to avoid an unscoped whole-partition clear.",
   "evidence": [
    "src/main/browser/native-tab-host.ts:6963-6976 — derives an http(s) origin and refuses unsupported protocols.",
    "src/main/browser/native-tab-host.ts:6978-6988 — calls clearStorageData with that origin and only cookies/localstorage/cachestorage, then reloads views.",
    "src/main/browser/app-menu.ts:721-722 — exposes 'Clear Cookies & Site Cache' to call clearStorageForActiveTab().",
    "src/main/browser/tab-context-menu.ts:374-375 — exposes 'Clear Cookies & Cache for this site'."
   ],
   "verified": true,
   "answerImpact": "Users have an explicit, origin-scoped reset for stale preview state; there is no need to retain all site data just to avoid destructive global clearing."
  },
  {
   "target": "T2",
   "claim": "The Companion/extension sync does not propagate cookie removals into AntiFan: the extension drops non-explicit removal causes and the bridge refuses pure-removal batches and ignores removals in mixed batches.",
   "evidence": [
    "src/extension/cookie-debouncer.ts:54-64 — only removals with cause 'explicit' enter the queue; other causes are suppressed.",
    "src/main/bridge/bridge-server.ts:1708-1722 — comments and response explicitly make removals unsupported; mixed batches hydrate upserts while ignoring removals."
   ],
   "verified": true,
   "answerImpact": "Cookie retention can outlive the source browser's eviction or expiry event on this sync path. That argues against maximizing retention indiscriminately, especially for credentials whose source state was cleared or invalidated."
  },
  {
   "target": "T2",
   "claim": "Startup housekeeping deletes a narrowly allowlisted set of dead partition directories and stale state/cache files; it does not target the active named profile partition, and held paths are deferred.",
   "evidence": [
    "src/main/browser/dead-store-cleaner.ts:31-54 — exact dead partition pattern, quiet-periods, and named reclaim scope.",
    "src/main/browser/dead-store-cleaner.ts:184-204 — matches only dead partition names and vetoes partitions listed live.",
    "src/main/browser/dead-store-cleaner.ts:208-219 — removes default-session cache only when default is not live and the cache is quiet for a day.",
    "src/main/index.ts:4583-4616 — builds live partition veto list, performs dry-run then applied cleanup after migration."
   ],
   "verified": true,
   "answerImpact": "Housekeeping is not a general cookie/cache expiration policy: it preserves the active profile jar while reclaiming unreachable stores. Long-lived data still needs deliberate user-controlled cleanup."
  },
  {
   "target": "T2",
   "claim": "Ephemeral partitions are nonpersistent and use nonce-bearing names; persistent capsules use separately scoped persistent partitions. A partition can therefore retain its own state without sharing the common profile jar.",
   "evidence": [
    "src/main/browser/browser-session-partition.ts:31-65 — ephemeral partition includes random nonce; capsule partitions use persist:capsule-* names.",
    "src/main/browser/browser-session-partition.ts:16-28 — ephemeral/nonpersistent and capsule-specific classification."
   ],
   "verified": true,
   "answerImpact": "Partition isolation is not the same as a centrally controlled retention period. Ephemeral use is a suitable short-lived option, while persistent workspace jars can accumulate independently."
  },
  {
   "target": "T3",
   "claim": "The configured 128 MB disk-cache and 64 MB media-cache switches apply to the default-session cache, not the live named partition cache; gpu-cache-dir is separately configured. Controller measurements show substantial partition Code Cache and CacheStorage growth beyond the HTTP Cache.",
   "evidence": [
    "src/main/config/storage-locations.ts:18-19 — DISK_CACHE_BYTES=128 MB and MEDIA_CACHE_BYTES=64 MB.",
    "src/main/index.ts:295-305 — explicitly says named partition caches are not redirected/bounded by these switches and describes Chromium's own policy for partition HTTP caches; configures gpu-cache-dir.",
    "src/main/index.ts:318-319 — appends disk-cache-size and media-cache-size switches.",
    "plans/reports/261010-cookie-cache-retention-ultra-packet.md §3 — measured live partition: HTTP Cache 150.0 MB, Code Cache/js 301.1 MB, Code Cache/wasm 450.8 MB, CacheStorage 204.9 MB, IndexedDB 32.6 MB; default-session Profile/Cache 5.6 MB."
   ],
   "verified": true,
   "answerImpact": "The main disk-growth concern is not a reason to retain more: configured switches do not cap the biggest observed per-partition consumers. The active partition alone is about 1.2 GB per §3, so cleanup/reset controls and disk budgeting matter."
  },
  {
   "target": "T3",
   "claim": "The inspected application code supplies no app-level bounds for Code Cache, Service Worker CacheStorage, or IndexedDB/quota; the reported usage shows these stores can materially outgrow the nominal HTTP cache budget. Chromium-specific eviction/quota behavior remains external and unverified here.",
   "evidence": [
    "plans/reports/261010-cookie-cache-retention-ultra-packet.md §3 — measured Code Cache/js, Code Cache/wasm, CacheStorage, IndexedDB sizes.",
    "src/main/index.ts:295-305 — documents that partition cache bounds are left to Chromium's own policy; this passage specifically concerns partition HTTP cache, not proof of limits for other stores.",
    "src/main/browser/native-tab-host.ts:6981 — clear action includes CacheStorage, but does not include IndexedDB or Code Cache."
   ],
   "verified": true,
   "answerImpact": "Avoid equating 'cache' with the bounded HTTP cache. Long retention of all browser state can have substantial and partly unbounded disk costs; don't claim specific Chromium eviction limits without an external primary source."
  },
  {
   "target": "T4",
   "claim": "Workspace preview updates have explicit cache-correctness behavior: CSS changes rewrite stylesheet URLs with an AntiFan timestamp, while other preview changes reload the matching capsule's tabs; ordinary reload calls WebContents.reload().",
   "evidence": [
    "src/main/browser/native-tab-host.ts:15519-15533 — css-swap appends/updates antifan_ts on stylesheet URLs; other change types reload desktop/mobile views.",
    "src/main/browser/native-tab-host.ts:10663-10686 — reload method invokes webContents.reload() for active tab views.",
    "src/main/browser/native-tab-host.ts:9043-9047 — subscribes capsule preview tabs to scoped reload events."
   ],
   "verified": true,
   "answerImpact": "Theme preview is not wholly reliant on preserving cache freshness: the workspace watcher busts CSS URLs and reloads for other changes. Ordinary reload is not evidence of cache-bypass semantics, so stale-cache risk is not fully eliminated."
  },
  {
   "target": "T4",
   "claim": "[INFERENCE] The inspected search/read pass found no app-level reloadIgnoringCache, DevTools cache-disabled toggle, or service-worker-bypass call; lack of a match is not proof that Chromium DevTools or all workflows cannot bypass cache.",
   "evidence": [
    "src/main/browser/native-tab-host.ts:10663-10686 — ordinary reload implementation uses reload(), with no cache-bypass option in the inspected method.",
    "src/main/browser/native-tab-host.ts:6981-6988 — the explicit site-clear path clears CacheStorage and reloads, but no service-worker bypass is configured there.",
    "Search of src for reloadIgnoringCache, setCacheDisabled, Network.setCacheDisabled, setBypassServiceWorker, and disableCache returned no matches."
   ],
   "verified": false,
   "answerImpact": "Do not promise every development reload is cache-free. For theme debugging, use the existing explicit per-site clear action if stale content persists; no code evidence supports telling the user cache can be kept indefinitely without correctness tradeoffs."
  },
  {
   "target": "T5",
   "claim": "Session-vault exports contain cookie values in plaintext JSON and are not encrypted with Electron safeStorage in the export/import implementation. This is a material at-rest risk for long-lived credentials.",
   "evidence": [
    "src/main/browser/local-session-vault.ts:209-218 — vault path is config/session-vault.json and credential-jar gating is separate from encryption.",
    "src/main/browser/local-session-vault.ts:324-350 — serializes cookie name/value and writes JSON.stringify(...), utf8.",
    "src/main/browser/local-session-vault.ts:359-379 — reads the vault as UTF-8 text and JSON parses it."
   ],
   "verified": true,
   "answerImpact": "Do not advise keeping exported cookies as long as possible or treating session-vault.json as a protected backup; it contains bearer-like cookie values in plaintext."
  },
  {
   "target": "T5",
   "claim": "The Windows data-root setup intends to restrict access to the current user and SYSTEM via a protected NTFS DACL, but enforcement is asynchronous and failures are non-fatal; this code alone does not prove the live root's ACL was successfully applied.",
   "evidence": [
    "src/main/config/storage-locations.ts:145-162 — calls resolveCurrentUserSid/enforceProtectedDirectoryDacl asynchronously and catches failures without failing setup.",
    "src/main/security/windows-acl.ts:1-5 — describes intended protected DACL with SYSTEM and current user only.",
    "src/main/security/windows-acl.ts:174-199 — verification requires protected DACL with exactly the expected two ACEs."
   ],
   "verified": true,
   "answerImpact": "Filesystem ACL hardening is a useful layer, not a guarantee that compensates for plaintext vault exports; do not equate intended enforcement with observed live ACL state."
  },
  {
   "target": "T5",
   "claim": "The packet reports no repo matches for Electron cookie-encryption fuse setup; therefore the repo evidence does not establish that Chromium cookie databases are protected by that fuse. Do not extend this into a claim about the actual encrypted state of the live Cookies DB.",
   "evidence": [
    "plans/reports/261010-cookie-cache-retention-ultra-packet.md §3 — repo grep for EnableCookieEncryption, flipFuses, FuseV1Options, and @electron/fuses yielded 0 matches."
   ],
   "verified": true,
   "answerImpact": "At-rest protection of the live cookie database is unresolved by the code packet; that uncertainty is another reason against a blanket 'keep everything indefinitely' recommendation."
  },
  {
   "target": "T6",
   "claim": "The data root is already materially occupied, with the active profile partition consuming about 1.2 GB and other persistent directories including baselines, control-plane, runtime, and daemon-host; the HTTP cache is a minority of the measured partition total.",
   "evidence": [
    "plans/reports/261010-cookie-cache-retention-ultra-packet.md §3 — Profile 1,213.7 MB; active partition 1,200.8 MB; Cache 150 MB; Code Cache and CacheStorage total much more; other dirs listed as baselines 263.6 MB, control-plane-v2 175.5 MB, runtime 109.5 MB, daemon-host 82.5 MB."
   ],
   "verified": true,
   "answerImpact": "The measured 95.6 GB free gives comfortable current headroom, but per-partition browser state and non-profile artifacts are significant. Retaining all caches indefinitely has a real disk-budget cost."
  },
  {
   "target": "T6",
   "claim": "The cleaner has no general age/size policy for the active partition's Code Cache, CacheStorage, IndexedDB, or cookies; it targets dead partition directories and a few guarded stale files/cache locations. Those active-profile stores can continue to grow unless Chromium or the user clears them.",
   "evidence": [
    "src/main/browser/dead-store-cleaner.ts:13-30 — enumerated cleanup scope excludes active partition internals.",
    "src/main/browser/dead-store-cleaner.ts:184-219 — deletion logic only removes dead partition names, quiet default cache, stale saved-tabs, and guarded temp leftovers.",
    "src/main/browser/native-tab-host.ts:6981 — explicit active-site clear removes cookies, localstorage, and cachestorage, not IndexedDB/Code Cache."
   ],
   "verified": true,
   "answerImpact": "Keep useful cookies only as long as valid, preserve caches for speed where helpful, and clean site data/old partitions when needed; the repo does not provide a universal active-profile retention cap."
  }
 ],
 "unresolved": [
  "What expiry distribution exists in the currently locked live Cookies DB; packet §3 explicitly says it was not measured.",
  "Whether Chromium's cookie expiry cap affects this app's current Electron build, and how it applies; no external Chromium/Electron source was consulted.",
  "Whether page-set session cookies survive restart in this precise Electron/Chromium build despite persistent partition behavior; the code only guarantees flushes, not browser expiry semantics.",
  "Whether the current live Windows data-root DACL has successfully been applied; setup is async and failures are swallowed.",
  "Whether Electron's packaging enables Chromium cookie encryption; packet reports no fuse-configuration matches, but the compiled/packaged binary fuse state was not inspected.",
  "Whether DevTools/UI or additional runtime tooling has a cache-disable or service-worker-bypass path beyond the searched application source.",
  "Specific Chromium eviction/quota limits for Code Cache, CacheStorage, and IndexedDB were not verified against primary external documentation."
 ]
}
```

## X4

```json
{
 "relevantFiles": [
  {
   "path": "src/main/browser/chrome-profile-sync.ts",
   "role": "Cookie import mapping and session-cookie expiration policy."
  },
  {
   "path": "src/main/browser/cookie-durability.ts",
   "role": "Debounced persistent cookie-store flush."
  },
  {
   "path": "src/main/browser/browser-session-partition.ts",
   "role": "Partition naming, persistent versus ephemeral sessions, cookie-durability setup."
  },
  {
   "path": "src/main/browser/native-tab-host.ts",
   "role": "Site-data clearing, session selection/flush, and normal reload behavior."
  },
  {
   "path": "src/main/browser/dead-store-cleaner.ts",
   "role": "Narrowly scoped dead-partition, stale-cache, and orphan-state cleanup."
  },
  {
   "path": "src/main/index.ts",
   "role": "Chromium cache switches, partition cache caveat, and boot cleanup invocation."
  },
  {
   "path": "src/main/config/storage-locations.ts",
   "role": "Cache budget constants, data-root directory layout, and root DACL invocation."
  },
  {
   "path": "src/main/browser/local-session-vault.ts",
   "role": "Plain JSON session-vault export/import and import TTL application."
  },
  {
   "path": "src/main/security/windows-acl.ts",
   "role": "Windows user-and-SYSTEM-only directory DACL implementation."
  },
  {
   "path": "src/main/bridge/bridge-server.ts",
   "role": "Companion cookie-removal propagation refusal."
  },
  {
   "path": "src/extension/cookie-debouncer.ts",
   "role": "Suppresses non-explicit extension cookie removals."
  },
  {
   "path": "docs/research-cache-cookie-mechanism.md",
   "role": "Prior measured findings and historical durability/housekeeping results; used only where corroborated by current code or packet facts."
  },
  {
   "path": "package.json",
   "role": "Dependency/build configuration checked for fuse-package references only indirectly; no fuse configuration established."
  }
 ],
 "findings": [
  {
   "target": "T1",
   "claim": "Lifetime is not uniformly maximized by the app: imports preserve an incoming persistent expiration, skip already-expired cookies, and only elevate session cookies when requested; the vault explicitly requests a 30-day TTL. Current code arms a one-second trailing-edge flush for every configured persist: partition. Whether a page-set session cookie survives restart, and Chromium's maximum accepted cookie expiration, are not established by the code evidence read.",
   "evidence": [
    "src/main/browser/chrome-profile-sync.ts:39-87 — persistent expiry is retained (expired inputs return null); session cookies receive expiration only with persistSessionCookies.",
    "src/main/browser/chrome-profile-sync.ts:159-185 — extension import keeps expirationDate or conditionally assigns configured/default TTL.",
    "src/main/browser/local-session-vault.ts:450-457 — vault JSON import requests a 30-day session-cookie TTL.",
    "src/main/browser/browser-session-partition.ts:123-133 — persistent partitions are armed for cookie durability.",
    "src/main/browser/cookie-durability.ts:20-27,43-65 — page cookie changes trigger a debounced flush after 1000 ms.",
    "plans/reports/261010-cookie-cache-retention-ultra-packet.md §3 — prior measurement found zero session cookies across 86 stores on 2026-09-19; this is not a measurement of current live expiry."
   ],
   "verified": true,
   "answerImpact": "Do not recommend extending every cookie blindly: imported session cookies already get a finite 30-day fallback, while server-issued expiry and session-cookie restart semantics bound retention. Durable flush reduces loss after abrupt termination but does not extend server validity. The session-cookie restart behavior and Chromium expiry cap remain unresolved."
  },
  {
   "target": "T2",
   "claim": "The current explicit clear-site-data action is origin-scoped and clears only cookies, localStorage, and CacheStorage for the active HTTP(S) origin; non-HTTP(S) pages fail closed. The dead-store cleaner removes only matching legacy/dead partition names and a quiet default-session HTTP cache plus stale state/temp files. Ephemeral partitions are memory-only by naming/configuration. No cookies.remove callsite was found in the targeted src/main search; extension delta removals are suppressed except explicit removals, while the receiver rejects pure removal batches.",
   "evidence": [
    "src/main/browser/native-tab-host.ts:6958-6985 — clearStorageForActiveTab validates HTTP(S) origin and calls clearStorageData with origin plus ['cookies','localstorage','cachestorage']; reloads the page after clear.",
    "src/main/browser/app-menu.ts:721-722 and src/main/browser/tab-context-menu.ts:374-375 — user-facing clear-site-data actions route to that method.",
    "src/main/browser/dead-store-cleaner.ts:48-58,179-205,208-218 — exact dead-partition pattern and live-partition veto; cache cleanup only targets quiet Profile/Cache when default session is not live.",
    "src/main/browser/browser-session-partition.ts:20-24,52-83,114-132 — ephemeral-* partitions are non-durable; persistent capsule/profile partitions have persistent naming.",
    "src/extension/cookie-debouncer.ts:55-63 — ignores non-explicit removal events.",
    "src/main/bridge/bridge-server.ts:1707-1723 — pure removal batches are rejected and mixed removals ignored.",
    "plans/reports/261010-cookie-cache-retention-ultra-packet.md §3 — measured cache/site-data and data-root inventory (no locked cookie DB was read)."
   ],
   "verified": true,
   "answerImpact": "Retention is not absolute: a user can clear the active origin, and ephemeral tabs intentionally lose state. Ordinary profile partitions are not swept by the dead-store cleaner, but legacy unreachable partitions can be reclaimed. The clear action's exact effect on HTTP disk cache is not established by its listed storage categories."
  },
  {
   "target": "T3",
   "claim": "The 128 MB disk and 64 MB media cache switches and GPU cache directory are configured, but source comments state they bind default-session caches, not the live named partition. The live partition's observed HTTP Cache is 150.0 MB; Code Cache js/wasm totals 751.9 MB and Service Worker CacheStorage 204.9 MB per packet. No app-level size/eviction configuration for these latter stores was found in the targeted source search; Chromium's own eviction/quota limits were not established.",
   "evidence": [
    "src/main/config/storage-locations.ts:12-19 — DISK_CACHE_BYTES=128 MiB and MEDIA_CACHE_BYTES=64 MiB, described as default-session budgets.",
    "src/main/index.ts:292-319 — no disk-cache-dir; partition Cache directories are per partition; code says size switch is not their bound and Chromium evicts them on its own policy; GPU, disk, and media switches are configured.",
    "plans/reports/261010-cookie-cache-retention-ultra-packet.md §3 — live profile partition HTTP Cache 150.0 MB, Code Cache/js 301.1 MB, Code Cache/wasm 450.8 MB, CacheStorage 204.9 MB, IndexedDB 32.6 MB."
   ],
   "verified": true,
   "answerImpact": "Keeping caches 'as long as possible' is not an app-controlled promise: the main cache switches do not cap the active named partition's measured HTTP cache, and other major stores already consume substantial disk. Let browser-managed cache eviction operate rather than treating these stores as durable user data."
  },
  {
   "target": "T4",
   "claim": "The host's normal reload path calls WebContents.reload() without a cache-bypass option; a targeted source search did not find an app-level ignore-cache, DevTools disable-cache, or service-worker-bypass control. The clear-site-data action is scoped to one origin and reloads afterward, but its selected storage categories do not include an explicit HTTP-cache entry.",
   "evidence": [
    "src/main/browser/native-tab-host.ts:10663-10689 — reload calls webContents.reload() for desktop/mobile views, with no options.",
    "src/main/browser/native-tab-host.ts:6978-6985 — clear path specifies cookies, localstorage, cachestorage and then reloads.",
    "src/main/browser/app-menu.ts:280-288,630-650 — keyboard/menu reload routes call host.reload.",
    "src/main/browser/native-tab-host.ts search for cache-bypass terms returned no matching app-level control; absence is limited to the searched source paths."
   ],
   "verified": true,
   "answerImpact": "For theme preview correctness, ordinary reload is not documented here as a cache bypass. If stale CSS/JS matters, site-data clearing is available but may not clear HTTP cache; any stronger cache-bypass workflow was not verified, so do not promise that cache can safely be retained without stale-output risk."
  },
  {
   "target": "T5",
   "claim": "Session-vault export writes cookie values as unencrypted JSON to session-vault.json; unlike the password vault, it does not use safeStorage. The data-root setup attempts a protected Windows DACL granting FullControl only to the current user SID and SYSTEM, but enforcement is asynchronous/nonfatal. The evidence packet reports zero repo matches for Electron cookie-encryption fuse configuration; current fuse/build state is therefore not proven from code read.",
   "evidence": [
    "src/main/browser/local-session-vault.ts:269-276 — default vault path is config/session-vault.json.",
    "src/main/browser/local-session-vault.ts:305-355 — exports cookie values and metadata via JSON.stringify to a file using writeFile.",
    "src/main/browser/local-credential-vault.ts:1-5 — safeStorage encryption is explicitly for the separate password-vault.",
    "src/main/config/storage-locations.ts:136-159 — ensures directories, then asynchronously attempts root DACL enforcement and swallows failure.",
    "src/main/security/windows-acl.ts:239-264 — DACL uses protected ACL, current user SID and SYSTEM FullControl, then verifies.",
    "plans/reports/261010-cookie-cache-retention-ultra-packet.md §3 — repo grep for EnableCookieEncryption/flipFuses/FuseV1Options/@electron/fuses returned zero matches."
   ],
   "verified": true,
   "answerImpact": "Long-lived cookies are credentials, not inert cache. Avoid exporting the session vault unless needed and protect the data root; the repo's vault export is plaintext JSON, while the root DACL attempt is not proof of actual ACL state. Cookie encryption-fuse status remains an evidence gap."
  },
  {
   "target": "T6",
   "claim": "The measured active profile partition already occupies 1,200.8 MB, predominantly Code Cache and Service Worker CacheStorage; the whole Profile is 1,213.7 MB. Boot housekeeping is narrowly scoped to unreachable legacy partition names, quiet default-session cache, and stale/temp state files—it does not impose a global cap or target the live profile partition's caches. Other data-root directories also consume substantial space.",
   "evidence": [
    "plans/reports/261010-cookie-cache-retention-ultra-packet.md §3 — measured Profile, active partition and cache subdirectory sizes; also other data-root directory sizes and 95.6 GB free drive space.",
    "src/main/browser/dead-store-cleaner.ts:7-24,48-58 — documented cleaner inventory is limited to dead legacy partitions, default cache, duplicate saved-tabs, and tmp files.",
    "src/main/browser/dead-store-cleaner.ts:179-258 — partition name filter, default-cache quiet check, and temp/stale-file cleanup implementation.",
    "src/main/index.ts:4579-4616 — boot reclaim runs after migration and supplies live partitions as vetoes."
   ],
   "verified": true,
   "answerImpact": "A solo local developer currently has ample measured free space, but retention without limits is not cost-free: the active profile's caches already exceed 1.2 GB and housekeeping does not reclaim those live-partition caches. Treat cookies/site state deliberately, but let cache eviction/maintenance—not maximum retention—govern expendable cache."
  }
 ],
 "unresolved": [
  "T1: Chromium/Electron's cookie lifetime cap and the exact behavior for page-set session cookies across normal restart were not verified from an authoritative external Chromium source or a permitted runtime measurement; the live Cookies DB was expressly locked and not queried.",
  "T2: No cookies.remove callsite was found in the targeted source search; confirm broader extensions/platform or UI paths if an exhaustive whole-repository deletion inventory is required. Partition deletion outside the dead-store cleaner was not established.",
  "T3: No quota configuration or eviction guarantees for CacheStorage, IndexedDB, V8 Code Cache, or service-worker data were established; packet measurements describe sizes only. Chromium external behavior requires a cited source.",
  "T4: No cache-busting preview URL or DevTools disable-cache path was located in the searched source paths; there is no verification of manual DevTools behavior or actual HTTP cache behavior on reload. clearStorageData's explicit categories omit HTTP cache, but exact Electron semantics were not independently established.",
  "T5: The actual ACL on the current data root and vault file was not measured. Fuse packaging/build configuration was not exhaustively located; packet search reports no matching fuse configuration symbols. No safeStorage protection applies to session-vault.json exports.",
  "T6: No global size cap or cleanup policy for the live partition's Code Cache, CacheStorage, IndexedDB, or other listed data-root directories was found in the files searched; their future growth rates are unknown."
 ]
}
```

## X5

```json
{
 "relevantFiles": [
  {
   "path": "plans/reports/261010-cookie-cache-retention-ultra-packet.md",
   "role": "Immutable task scope, measured disk inventory, prior expiry observations, and explicit evidence constraints."
  },
  {
   "path": "src/main/config/storage-locations.ts",
   "role": "Declares default-session disk/media cache budgets, storage paths, and asynchronous data-root ACL setup."
  },
  {
   "path": "src/main/index.ts",
   "role": "Applies Chromium cache switches, explains partition cache behavior, performs dead-store housekeeping, and flushes default-session cookies on shutdown."
  },
  {
   "path": "src/main/browser/cookie-durability.ts",
   "role": "Debounces durable cookie-store flushes after cookie changes."
  },
  {
   "path": "src/main/browser/browser-session-partition.ts",
   "role": "Defines persistent, capsule, and ephemeral partition naming and arms cookie durability for persistent sessions."
  },
  {
   "path": "src/main/browser/chrome-profile-sync.ts",
   "role": "Maps imported cookie expiry values and applies optional TTL to session cookies."
  },
  {
   "path": "src/main/browser/local-session-vault.ts",
   "role": "Exports plaintext cookie JSON and imports cookies with a 30-day TTL for session cookies."
  },
  {
   "path": "src/main/browser/native-tab-host.ts",
   "role": "Implements origin-scoped clear-site-data action, generic reload, and migration/flush paths."
  },
  {
   "path": "src/main/browser/dead-store-cleaner.ts",
   "role": "Deletes narrowly matched dead partition directories and stale default-session cache/state debris."
  },
  {
   "path": "src/main/security/windows-acl.ts",
   "role": "Builds and enforces user+SYSTEM DACLs for the data root and specified paths."
  },
  {
   "path": "src/main/tools/browser-control-port.ts",
   "role": "Implements generic reload and explicitly gated zero-external-network reload."
  },
  {
   "path": "src/main/tools/browser-capabilities.ts",
   "role": "Exposes ordinary reload and zero-network reload capabilities."
  },
  {
   "path": "src/main/browser/app-menu.ts",
   "role": "Exposes Clear Cookies & Site Cache menu action and describes password-vault encryption."
  },
  {
   "path": "docs/research-cache-cookie-mechanism.md",
   "role": "Prior dated forensic findings on session cookies, cache placement, and cookie-store measurements."
  }
 ],
 "findings": [
  {
   "target": "T1",
   "claim": "Cookie lifetime is primarily inherited from each site-set cookie's expiry; explicit import paths can instead persist a no-expiry cookie for a configured TTL (the vault path uses 30 days). Persistent partition cookie changes are now flushed after a trailing-edge 1-second debounce, reducing the post-change crash-loss window, but this does not extend a server-issued expiry or establish that session cookies survive app restart.",
   "evidence": [
    "src/main/browser/chrome-profile-sync.ts:70-83 — expired imported persistent cookies are rejected; no-expiry cookies receive expirationDate only when persistSessionCookies is set, using the configured/default TTL.",
    "src/main/browser/local-session-vault.ts:454-456 — vault JSON imports set persistSessionCookies=true and sessionTtlSeconds=30 days; lines 473-475 explicitly flush after import.",
    "src/main/browser/cookie-durability.ts:20-32, 47-60 — debounce is 1,000 ms and invokes cookies.flushStore after cookie changes.",
    "src/main/browser/browser-session-partition.ts:124-132 — only persist: partitions are armed for cookie durability.",
    "plans/reports/261010-cookie-cache-retention-ultra-packet.md §3 — prior measurement found zero session cookies across 86 stores on 2026-09-19; live expiry distribution was not measured this session."
   ],
   "verified": true,
   "answerImpact": "Don't equate 'keep as long as possible' with extending every cookie: the app only adds the explicit 30-day lifetime for qualifying imports; site expiry and server-side validity remain outside that policy. Durability has improved for persistent jars, but the current session-cookie restart behavior and Chromium expiry caps remain unverified."
  },
  {
   "target": "T1",
   "claim": "[EXTERNAL] Whether Chromium caps persistent cookie expiry, and whether native session cookies persist across restart under any Electron/Chromium configuration, is not established by the inspected repo evidence.",
   "evidence": [
    "plans/reports/261010-cookie-cache-retention-ultra-packet.md §3 — live cookie expiry distribution was not measured; prior measurement is dated 2026-09-19.",
    "src/main/browser/chrome-profile-sync.ts:70-83 — app sets expirationDate but contains no app-level maximum-expiry cap."
   ],
   "verified": false,
   "answerImpact": "Do not recommend manually maximizing cookie expiry based on an assumed Chromium cap or persistence rule; this is an unresolved platform behavior."
  },
  {
   "target": "T2",
   "claim": "The explicit user-facing clear action is origin-scoped and clears only cookies, localstorage, and cachestorage, then reloads the active view; it refuses URLs for which it cannot determine an HTTP(S) origin rather than clearing an entire partition.",
   "evidence": [
    "src/main/browser/native-tab-host.ts:6963-6981 — comments explain fail-closed behavior; clearStorageData receives the origin and storages array ['cookies','localstorage','cachestorage'].",
    "src/main/browser/app-menu.ts:721-722 — menu label is 'Clear Cookies & Site Cache' and invokes clearStorageForActiveTab().",
    "src/main/browser/native-tab-host.ts:6982-6988 — successful clear reloads desktop and optional mobile view."
   ],
   "verified": true,
   "answerImpact": "The available clear command does not amount to a broad profile wipe, but the label overstates the explicit storage list: HTTP cache and IndexedDB are not named in this call. Clearing a site can still intentionally remove that site's login cookies."
  },
  {
   "target": "T2",
   "claim": "Boot housekeeping deletes only exact legacy partition namespaces plus quiet stale/default state debris; it protects live/derivable partitions and defers paths held by the OS. Ephemeral partitions are in-memory by naming/contract rather than being retained jars to clean later.",
   "evidence": [
    "src/main/browser/dead-store-cleaner.ts:36-47 — exact dead partition name regex and quiet-period constants.",
    "src/main/browser/dead-store-cleaner.ts:153-180 — live partition and path containment checks precede recursive removal; EPERM/EBUSY is deferred.",
    "src/main/browser/dead-store-cleaner.ts:183-204 — default Profile/Cache is eligible only when no default partition is live and it is quiet for 24 hours.",
    "src/main/index.ts:4583-4616 — housekeeping runs a dry-run report and then applies cleanup after legacy migration; gathers live partitions and derivable profiles.",
    "src/main/browser/browser-session-partition.ts:54-68, 124-132 — ephemeral names omit persist: while persistent partitions use persist:; ephemeral session partitions are not armed for durable cookie flushing."
   ],
   "verified": true,
   "answerImpact": "Cleanup is not a reason to fear that healthy profile cookies/cache are periodically purged: the identified cleaner targets unreachable legacy jars and stale default cache, not the live profile partition. Ephemeral browsing deliberately does not preserve site state."
  },
  {
   "target": "T2",
   "claim": "[INFERENCE] No app-side cookies.remove call was found in the searched src tree; observed cookie removal is through the scoped clearStorageData call or removal of whole dead partition directories, not a separate logout/delete-cookie API in the inspected paths.",
   "evidence": [
    "Search of src/ for cookies.remove returned no matches.",
    "src/main/browser/native-tab-host.ts:6981 — sole clearStorageData call found in src/ clears scoped storage types.",
    "src/main/browser/dead-store-cleaner.ts:153-180 — recursive removal is guarded by exact dead partition matching and live-partition checks."
   ],
   "verified": false,
   "answerImpact": "There is no evidence here of a hidden routine that aggressively shortens cookie lifetimes, but the search alone cannot establish all Electron/platform deletion causes."
  },
  {
   "target": "T3",
   "claim": "The configured 128 MB disk and 64 MB media cache switches are explicitly documented in startup code as default-session controls, not bounds on the live per-partition HTTP cache; the measured live partition cache was 150.0 MB while the measured default Profile/Cache was 5.6 MB.",
   "evidence": [
    "src/main/config/storage-locations.ts:18-19 — DISK_CACHE_BYTES=128 MiB and MEDIA_CACHE_BYTES=64 MiB.",
    "src/main/index.ts:295-305, 318-319 — comments state partition sessions keep caches under userData/Partitions and the size switches do not bound those caches; gpu-cache-dir is configured separately.",
    "plans/reports/261010-cookie-cache-retention-ultra-packet.md §3 — live Cache measured 150.0 MB, Code Cache/js 301.1 MB, Code Cache/wasm 450.8 MB, Service Worker/CacheStorage 204.9 MB, IndexedDB 32.6 MB; GPUCache 5.8 MB."
   ],
   "verified": true,
   "answerImpact": "Keeping every cache 'as long as possible' is not a controllable or necessary policy: the nominal cache budgets do not constrain the main live partition HTTP cache, while other large caches are not bounded by the shown switches."
  },
  {
   "target": "T3",
   "claim": "[INFERENCE] No app-side explicit Code Cache, Service Worker CacheStorage, IndexedDB quota, or eviction policy was found in the targeted source search; the large Code Cache and CacheStorage figures in the packet are live measured occupancy, not proof they grow without limit.",
   "evidence": [
    "Search for cache/quota/service-worker control terms in src/ found the cache switch and clearStorageData call, but no explicit partition cache quota or Code Cache policy.",
    "plans/reports/261010-cookie-cache-retention-ultra-packet.md §3 — measured Code Cache/js 301.1 MB, Code Cache/wasm 450.8 MB, Service Worker/CacheStorage 204.9 MB, IndexedDB 32.6 MB."
   ],
   "verified": false,
   "answerImpact": "The repo evidence does not support asserting that retaining these caches longer is beneficial or that they are unbounded; Chromium's eviction and quota behavior must be separately sourced/measured."
  },
  {
   "target": "T4",
   "claim": "Ordinary reload uses WebContents.reload() and has no app-level ignore-cache option; the separate zero-network reload is explicitly limited to verified local origins and blocks external networking, rather than serving as a general cache-bypass control for storefront preview URLs.",
   "evidence": [
    "src/main/browser/native-tab-host.ts:10677-10687 — generic reload invokes webContents.reload() for desktop and optional mobile view.",
    "src/main/tools/browser-control-port.ts:2275-2295 — normal browser reload delegates to the host reload path.",
    "src/main/tools/browser-control-port.ts:2320-2358 — zero-network reload validates localhost/127.0.0.1/file origins and wraps reload in a zero-network denial transaction.",
    "src/main/tools/browser-capabilities.ts:432-445 — ordinary reload and reload_zero_network are separate exposed capabilities."
   ],
   "verified": true,
   "answerImpact": "A normal reload is the only generic app-provided refresh path found; there is no evidenced app-level 'disable cache' mode for remote theme previews. Don't promise that retaining cache is harmless for fresh CSS/JS/Liquid preview output."
  },
  {
   "target": "T4",
   "claim": "The built-in site-data clearing action is not a complete HTTP-cache/IndexedDB/service-worker reset based on the storage types explicitly passed; it clears named stores for one origin and reloads afterward.",
   "evidence": [
    "src/main/browser/native-tab-host.ts:6981 — storages passed are exactly cookies, localstorage, cachestorage.",
    "src/main/browser/native-tab-host.ts:6963-6965 — whole-partition clear is explicitly avoided when origin cannot be determined.",
    "plans/reports/261010-cookie-cache-retention-ultra-packet.md §3 — live partition contains HTTP Cache, Service Worker/CacheStorage, ScriptCache, and IndexedDB."
   ],
   "verified": true,
   "answerImpact": "If a developer sees stale preview assets, the existing clear command may not clear all relevant storage layers; cache retention should be paired with an explicit refresh/debug workflow rather than assumed invalidation."
  },
  {
   "target": "T5",
   "claim": "The session vault export writes serialized cookie name/value and metadata directly as UTF-8 JSON, with no encryption step in the export path. That is distinct from the local password vault, which uses safeStorage; neither the safeStorage password-vault description nor repo search demonstrates encryption of Chromium's cookie database.",
   "evidence": [
    "src/main/browser/local-session-vault.ts:325-341 — maps live cookie values into serializable records and writes JSON.stringify(...) as UTF-8.",
    "src/main/browser/app-menu.ts:423-425 — UI describes password vault entries as encrypted by safeStorage/DPAPI.",
    "src/main/browser/local-credential-vault.ts:3-5, 213-219 — password vault uses Electron safeStorage and encryptString.",
    "plans/reports/261010-cookie-cache-retention-ultra-packet.md §3 — repo search for EnableCookieEncryption, flipFuses, FuseV1Options, and @electron/fuses returned 0 matches."
   ],
   "verified": true,
   "answerImpact": "Long-lived cookies are credentials: exporting them to session-vault.json creates a plaintext-at-rest copy, so 'keep them as long as possible' should not mean exporting/duplicating them casually. Password-vault encryption is not evidence that cookies are encrypted."
  },
  {
   "target": "T5",
   "claim": "[INFERENCE] Data-root ACL setup intends to restrict access to SYSTEM and the current user, but initialization is asynchronous and swallows enforcement failures; no evidence read here verifies effective ACLs on the live cookie database or session-vault.json.",
   "evidence": [
    "src/main/config/storage-locations.ts:137-161 — ensureDirectories launches DACL enforcement asynchronously and catches failures without surfacing them.",
    "src/main/security/windows-acl.ts:304-324 — generated ACL script creates only current-user and SYSTEM full-control rules and protects inheritance.",
    "src/main/security/windows-acl.ts:346-367 — enforcement routine validates paths and can return platform-specific results.",
    "plans/reports/261010-cookie-cache-retention-ultra-packet.md §3 — locked cookie DB was not opened or measured; packet only reports fuse grep result, not effective ACL verification."
   ],
   "verified": false,
   "answerImpact": "Data-root ACL hardening is a meaningful protection intent, not proof that every sensitive artifact is protected successfully. Treat disk-held session material as sensitive and don't claim cookie encryption/ACL assurance."
  },
  {
   "target": "T6",
   "claim": "Housekeeping is bounded and selective: it reclaims exact unreachable legacy partition directories, a quiet default-session HTTP cache, stale duplicate state, and old atomic-write leftovers; the packet still measures substantial live Code Cache and Service Worker CacheStorage occupancy.",
   "evidence": [
    "src/main/browser/dead-store-cleaner.ts:12-25 — enumerates the cleanup categories and states live partition traffic is elsewhere.",
    "src/main/browser/dead-store-cleaner.ts:153-204 — exact-name/live-use/quiet-period conditions for removals.",
    "src/main/index.ts:4598-4616 — boot pass reports planned and applied reclaim.",
    "plans/reports/261010-cookie-cache-retention-ultra-packet.md §3 — Profile total 1,213.7 MB; live partition 1,200.8 MB; largest listed components are Code Cache/js 301.1 MB, Code Cache/wasm 450.8 MB, and CacheStorage 204.9 MB."
   ],
   "verified": true,
   "answerImpact": "There is around 95.6 GB free per the packet, so current disk pressure is not a reason to purge valuable cookies, but the measured profile is already about 1.2 GB and housekeeping does not target the largest active cache layers. Retain useful state selectively, not indiscriminately."
  }
 ],
 "unresolved": [
  "What is the live cookie expiry/session-cookie distribution now? The packet says the live Cookies database was exclusively locked and not measured; the prior zero-session-cookie scan is from 2026-09-19 (§3).",
  "What Chromium/Electron upstream expiry caps and persistent-session-cookie restart rules apply to this exact runtime? No external source was consulted in this scout pass.",
  "What are Chromium's actual eviction/quotas for the live partition's HTTP cache, V8 Code Cache, CacheStorage, and IndexedDB, and do the measured large stores currently churn or grow?",
  "Does Electron package/runtime enable cookie encryption via a fuse despite the repository search finding no fuse configuration? Effective binary fuse state was not inspected.",
  "Are effective Windows ACLs present on the live Cookies database and session-vault.json? ACL setup is asynchronous and failures are swallowed; live ACLs were not checked.",
  "Does the site clear action clear all intended data through Electron's underlying implementation beyond the explicit cookies/localstorage/cachestorage list? HTTP cache, IndexedDB, Service Worker registrations, and other stores are not named in the call.",
  "Which theme-preview workflow provides cache bypass or deterministic freshness for remote CSS/JS/Liquid output? The inspected generic reload path does not expose ignore-cache behavior."
 ]
}
```
