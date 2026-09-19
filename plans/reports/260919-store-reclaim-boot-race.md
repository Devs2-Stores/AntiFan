# Store reclaim — boot-path race with the legacy migration

Ngày: 2026-09-19. Tiếp nối `plans/reports/260919-cookie-cache-ultra-packet.md` (packet giữ nguyên, không sửa).
Trạng thái: đã sửa + đã kiểm chứng; phần "live apply" trên data root thật chờ một lần restart app.

## Triệu chứng quan sát được

Smoke boot đầu tiên (`scripts/smoke-boot-housekeeping.cjs`, root tạm có seed) báo:

```
deletedPartitions: ["profile-capsule-5b0f2c77-…"]
errors: ["delete failed for …\\Profile\\Partitions\\capsule-capsule-81ca1de4-…: EPERM, Permission denied"]
```

Store chết thứ hai không xoá được, và pass bị ghi nhận là **có lỗi**. Trên máy này, cùng thời điểm, `fs.renameSync` lên chính thư mục đó trả `EBUSY` còn hai thư mục khác trong `Partitions/` thì `free` — tức có tiến trình đang giữ nó, không phải lỗi quyền.

## Bằng chứng (Tier 1, đo trên máy này)

| Bước | Kết quả |
|---|---|
| Seed 3 store chết trong root tạm, **không** boot app, `rmSync` từng cái | cả 3 `deleted` → không phải lỗi của FS/seed |
| Boot app thật (root tạm), probe `renameSync` tại t=3s và t=12s | `capsule-capsule-<uuid>` = `EPERM` (giữ liên tục), `profile-profile-2` = `free`, `profile-default` = `EPERM` (session sống, đúng) |
| Journal của chính app | `housekeeping.deadStores.{planned,applied}` ghi `deletedPartitions=["profile-capsule-…"]`, `errors=[EPERM …]` |
| Đọc code | `src/main/browser/native-tab-host.ts:3592` liệt kê `Partitions/*` bắt đầu bằng `capsule-`; `:3595` mở partition đó bằng `cookies.get({})` |

## Nguyên nhân gốc (file:line)

`src/main/index.ts:533` (bản cũ) gọi migration **fire-and-forget**:

```ts
void tabHost.migrateLegacyCapsuleToProfile().then(...);   // không await
// …và ngay sau đó, cùng tick:
const applied = pruneDeadStores(cleanupTargets);
```

`migrateLegacyCapsuleToProfile()` (`native-tab-host.ts:3580`) đọc mọi partition `persist:capsule-*` để copy cookie sang `persist:profile-*`. Việc đọc **mở cookie database của partition nguồn**, và handle đó sống hết vòng đời tiến trình (Electron không có API huỷ partition). Vì pass reclaim chạy song song, hai hệ quả:

1. **Xoá được ghi nhận là thất bại (EPERM)** — quan sát được ở trên. Journal nhiễu, và trên data root thật store đó sẽ không bao giờ được reclaim nếu lần nào cũng vấp.
2. **Rủi ro thứ tự (đã kiểm chứng lại bằng falsification, xem dưới):** về lý thuyết, nếu reclaim chạy *trước* lúc migration mở thư mục nguồn thì nó xoá nguồn, migration đọc ra 0 cookie, `continue`, không tính là lỗi ⇒ ghi done-marker ⇒ cookie mất im lặng. **[INFERENCE — không tái hiện được]** Trên bản compiled bị patch về fire-and-forget, store nguồn vẫn **deferred** (không bị xoá): prologue đồng bộ của `migrateLegacyCapsuleToProfile()` mở partition ngay trong cùng tick, trước khi `reclaimDeadStores()` chạy. Nghĩa là dạng lỗi quan sát được của race là **ordering violation + pass ghi lỗi giả**, chứ chưa chứng minh được mất cookie. Việc chain vẫn đúng và cần (đảm bảo pass luôn thấy đĩa tĩnh) — nhưng báo cáo này không claim nó chặn một vụ mất dữ liệu đã đo được.

Không có test nào phủ thứ tự này: unit test của cleaner chỉ nhìn bàn giao diện `pruneDeadStores(...)`, còn smoke cũ chỉ chạy cleaner ngoài app. Smoke mới thêm assertion mốc thời gian để phủ đúng thứ tự đó.

## Sửa

1. **Serialize tại call site** (`src/main/index.ts`): migration trở thành `const legacyMigration = tabHost.migrateLegacyCapsuleToProfile()...`, và reclaim được chain sau nó: `void legacyMigration.then(reclaimDeadStores)`. Reclaim luôn thấy đĩa đã tĩnh. Việc treo bridge/native-IPC không bị ảnh hưởng: `startBridgeAndIpc` vẫn theo timer 1500ms độc lập.
2. **Deferral là kết quả hợp lệ, không phải lỗi** (`src/main/browser/dead-store-cleaner.ts`): `CleanupReport.deferredPaths: string[]` mới; `removePath` phân loại `EPERM`/`EBUSY` vào `deferredPaths` (không vào `errors`) — một store đang bị giữ là việc phải hoãn sang lần khởi động sau, không phải pass hỏng. Log boot in thêm `(N deferred: in use)`.
3. Marker của migration (`config/antifan-migration-capsule-to-profile.done`) là cơ chế làm deferral hữu hạn: lần boot sau migration tự no-op ⇒ không mở store nào ⇒ không còn ai giữ ⇒ reclaim thành công. Không cần đợi vô hạn, và không có đường nào xoá nguồn giữa lúc copy.

## Kiểm chứng

| AC | Cách chứng minh | Kết quả |
|---|---|---|
| AC5 (guarded, idempotent, auditable) | `npm run smoke:dead-stores` — cleaner thật trên root seed: dead xoá, live-named bị tab chiếm thì veto, cache chỉ khi không tab nào ở default, dup chỉ khi bản live tồn tại, temp torn/dot-prefixed/giữ lại theo quiet period, pass 2 = no-op, **store bị process khác giữ ⇒ `deferredPaths` + 0 error, và reclaim đúng sau khi holder chết** | PASSED (24 assert) |
| AC5 live run | `npm run smoke:boot-housekeeping` — app thật, 2 lần boot: lần 1 migration chạy → `profile-capsule-*` xoá, `capsule-capsule-*` **deferred + 0 error**, marker đã ghi; lần 2 marker gate ⇒ store bị giữ được reclaim (`reclaimedBytes=105044`), live partition + live tab state còn nguyên | PASSED (16 assert) |
| AC7/AC8 (durability, có repro trước fix) | `npm run smoke:cookie-durability` — Electron thật: 1 partition có debounce + 1 partition không (đúng hành vi runtime cũ), set cookie từ HTTP thật rồi `taskkill /F` (không graceful, không flush): jar có debounce **giữ** cookie, jar không debounce **mất** ⇒ pre-fix repro chạy được ngay trên cây đã sửa | PASSED |
| Không hồi quy | `node --test .compiled/test/main/dead-store-cleaner.test.js .compiled/test/main/capsule-partition-migration.test.js` | 8/8 pass |

Kiểm kê read-only trên data root thật (`npm run inventory:dead-stores`, tương đương `node scripts/inventory-dead-stores.cjs`; app cũ đang chạy, không mutate gì và truyền `livePartitions` rỗng nên là kịch bản xấu nhất):

```
marker present: true
partitions total: 85 | dead-named: 84 | live-named (untouched): 1   -> ["profile-profile-2"]
dead bytes: 5,164,437,097 = 4.81 GB
dry-run plan: scanned=90 partitions=84 files=6 reclaimMB=5144.2 deferred=0 errors=[]
```

⇒ Từ lần khởi động tới (build mới), journal sẽ ghi `housekeeping.deadStores.applied` với 84 partition + 6 file và `deferredPaths: []`, vì marker đã có nên migration không mở store nào. Đây là "live apply" — cố ý để đường in-app thực hiện, không xoá 5 GB trong profile người dùng bằng script rời.

## Ghi chú còn lại

- `scannedCount` trong report đếm cả temp/state; đừng đọc nó như số partition.
- Deferral là cơ chế chung: bất kỳ ai giữ thư mục (session đang mở, tiến trình khác) đều được hoãn thay vì tạo lỗi giả, nên housekeeping chạy mỗi boot vẫn an toàn.
- Nếu sau này thêm một reader chạy song song khác (ví dụ import CDP mở `persist:profile-capsule-*`), phải chain theo cùng cách: chia sẻ một promise và cho reclaim chạy sau.
