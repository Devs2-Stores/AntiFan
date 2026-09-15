# Goal packet (from ak:goal-warmup)

**State: `Ready`** — không còn blocker. Phase 1–6 khởi động ngay; phase 7 cũng chạy được ngay ở chế độ đo theme **như đang publish** (`https://hangquoctai.myharavan.com/`), **không cần push, không cần approve**.

> Warmup **không** tự khởi động goal. Packet này là thứ để user tự dán vào `/goal` hoặc một long-run session.

## Outcome contract (LOCKED — v6)

- **Intended result**: **100%** hạng mục **P0-A → P1** của MASTER UPGRADE đạt `PASS` có receipt revision-bound. Mẫu số là **31 hạng mục** (`reports/ladder-31-items.md`). Trên nền plan đã duyệt `260914-1248` (contract **C1–C8**), tiếp nối sau khi upstream phases 1–10 đã xong.
- **In scope**: phase 11–15 của plan `260914-1248` + Core Health UI + MCP Reliability + lớp đo **B23/B30/B32**. Chế độ **test + fix**, không phải test-only.
- **Out of scope**: nới/làm yếu bất kỳ tiêu chí nào để đạt 100% · sửa test để ép verdict · auto-promote candidate (giữ luật `adjudications.scope`) · `git reset --hard` / `clean` / `push --force` · `haravan theme push*` khi chưa được duyệt · feature ngoài plan.
- **Acceptance signals**: mỗi hạng mục có verdict terminal `PASS|FAIL|NOT_IMPLEMENTED|BLOCKED`; **0 SKIP, 0 TIMEOUT**; điều kiện Final là `PASS == 31`; mọi `PASS` có receipt revision-bound (git SHA + `exit` + `finishedAt` + `routeIdentity` khác null); mọi fix có test **fail trước / pass sau**.
- **Constraints**: **không có mốc thời gian** — biên tiến độ là **phase gate**; chạy unattended; runner **deterministic là xương sống**, agent chỉ triage khi fail; checkpoint atomic tại mỗi phase gate; watchdog + **giám sát ngoài runner**; health abort theo ngưỡng chốt trước; single-runner; không secret trong artifact.
- **Allowed substitutions**: retire 21 shadow row bằng derive **hoặc** reconcile kèm proof riêng · Core Health surface **tích hợp vào Hub sẵn có** (`toolbar.html:442-559`) thay vì dựng overlay mới · **chủ thể đo ở phase 7**: (A) push `Storefront` lên remote rồi đo URL platform, **hoặc** (B) đo trên site live sẵn có và ghi rõ verdict **không** đại diện cho `Storefront` · hạng mục không kịp → `NOT_IMPLEMENTED`/`BLOCKED` + blocker nêu tên.
  - **KHÔNG** được thay bằng Liquid engine tự dựng — đó là render giả, verdict không hợp lệ.
- **Decision owner**: user.

**Bất biến**: contract bất động sau khi duyệt. Thay đổi outcome/scope → dừng, trình user.

## Plan

- **Path**: `plans/260915-1658-goal-p0-retrieval-bridge-completion/` — 8 phase, 97 task, `ak plan validate` OK.
- **Repo**: `E:/Work/apps/AntiFan` — branch `main`, HEAD `43ffb89`.
- **Traceability**: present — bảng 4 cột (Phase ↔ Contract items ↔ Acceptance signals ↔ Facts/assumptions/prereqs/user decisions) trong `plan.md`.
- **Artifacts kèm**: `reports/ladder-31-items.md` (mẫu số của 100%) · `reports/preflight-matrix.md` · `reports/review-classification.md`.

### Chuỗi phase

| # | Phase | Hạng mục ladder | Block |
|---|---|---|---|
| 1 | Safety substrate — checkpoint/resume, watchdog, **giám sát ngoài** | — (hạ tầng) | 1 |
| 2 | Retrieval integrity — platform isolation, pack identity, confidence thật | 4, 5, 26, 27, 30 | 1 |
| 3 | Context Bridge — OMP hook, `preserveData`, fail-open | 1, 2, 3, 6, 7, 8, 9, 10 | 1 |
| 4 | Verified learning — `observations` producer, không self-promote | 31 | 2 |
| 5 | MCP reliability — catalogue là nguồn duy nhất, parity gate | 18–25 | 2 |
| 6 | Core Health + 5 surface — snapshot có `reasonCode` | 11–17, 28, 29 | 2 |
| 7 | Measurement layer — B23/B30/B32 | — (mở khoá) | 3 |
| 8 | Re-acceptance — ladder 31 dòng, revision-bound | verify toàn bộ | 3 |

Dependency: `1 → 2 → 3 → 4 → 5 → 6 → 7 → 8`. Không đảo **5 trước 6** (UI đọc trạng thái MCP).

## Preflight

- **Blocking: none.**
  - `packages/super-core/dist/` **đã build** trên E:
  - `.super-core/core.db` **đã populate** — 20.832 claims, 184.835 artifacts, 63.654 platformSemantics, 10.275 principles
  - **Đường render phase 7 ĐÃ CÓ**: `https://hangquoctai.myharavan.com/` — store của org `1000405253`, **đang phục vụ theme `1001357480` ("Hrv Glasses")**. **Không cần push, không cần approve.**
    - **Chứng minh phân biệt được** (không phải suy từ tên): plain `/` render **byte-identical** (`sha256 b95ac59f3fad98`, 283.726 byte) với `/?theme_id=1001357480`, và **khác** theme anh em `/?theme_id=1001357481` (`8bb8908c…`, 167.277 byte). Tham số `theme_id` được platform tôn trọng — 5 URL cho 4 hash khác nhau.
    - Vì sao cần bước này: `1001357480` và `1001357481` **cùng codebase** nên **chia sẻ asset** — kiểm marker không phân biệt được. Chỉ so hash theo `theme_id` mới kết luận được đúng theme nào đang publish.
- **PHÁT HIỆN QUAN TRỌNG — campaign cũ đo sai chủ thể**: `TARGET_PAGES` (`fifteen-pages-run.mjs:52+`) hardcode `hoplongtech.com`, thuộc **org khác** (Hợp Long). Nên mọi verdict hiện có trong `.canary/15-pages/` **không nói gì** về theme đội đang build. Phase 7 phải **re-target** sang `hangquoctai.myharavan.com`.
  - Kèm theo: nghi vấn `/cart` trùng byte là **đặc thù hoplongtech**. Trên target đúng cả 4 route đều khác nhau (`/cart` = 164.531 byte, title "Giỏ hàng của bạn") → **B32 là defect writer** (`campaign-verdicts.mjs:272`), không phải lỗi site.
- **Cần chốt trước khi chạy** (executor tự quyết, mặc định đã đề xuất):
  1. Transport bridge = **CLI** (`scripts/antifan-core.cjs`) → **không cần** `ANTIFAN_BRIDGE_TOKEN` (đang missing). Nếu đổi sang bridge HTTP thì cần token qua env.
  2. Ngưỡng health abort (RSS drift/giờ, heap trần, N verify fail, headroom đĩa).
  3. Ngưỡng xếp hạng tổ hợp ở phase 2 — khoá **trước** khi đo.
  4. `core.db-wal` đang **174 MB và chưa checkpoint** — chốt chế độ WAL/`busy_timeout` trước khi thêm writer.
  5. Chính sách cho **2.905 claim untagged (13,9%)** — loại hoàn toàn (mặc định đề xuất) hay backfill từ `units.markers`.
- **Cổng cần user (chặn phase 7)**: `haravan theme push*` bị cấm mặc định. Muốn đo theme `Storefront` thật thì phải push lên remote (org `1000405253` / theme `1001357480`) → **cần phê duyệt tường minh**.
- **Deferred**: B19 (settle gate đếm childList) · B20 (cap 16384px) · B21 (repo root hygiene).
- **Rủi ro đã biết, không giấu**:
  - **Không** ước lượng được số phase-block tới Final. Floor: ≥ 8 phase + re-verify. Deal thật của phase 12/13 (cross-process bridge, learning producer) và phase 6 (5 surface) chưa đo được cho tới khi làm.
  - **Nghi vấn route `/cart`**: `hoplongtech.com/` và `/cart` trả cùng 338.594 byte và cùng `<title>` nhưng hash khác → `/cart` có thể không render đúng. Liên quan trực tiếp B32 (`routeIdentity` null ở 24/45 case). Điều tra trước khi tin verdict cũ.
  - `isForbiddenTool()` trong `.omp/extensions/antifan-fix-guard/index.ts` là **stub luôn trả `false`** — guard hiện không chặn gì. **Không** dựa vào nó làm cơ chế an toàn.
  - Main app **thiếu** `--disable-background-timer-throttling` (`src/main/index.ts:167-182` set nhiều switch nhưng không có cờ này).

## Scope guard (MUST follow during long-run)

Tại **mỗi** phase boundary:

1. Diff việc định làm so với contract đã khoá ở trên.
2. Lệch material → **dừng, hỏi user**. Không hoàn thành dưới scope bị thu hẹp.
3. **Không** làm yếu, bỏ, hay xoá test để thoả điều kiện dừng.
4. Dừng để user quyết thay vì tự chọn sản phẩm/hành vi.
5. **Chế tạo kết quả để lấp chỗ trống = vi phạm contract → abort** (giả `replayResult`, đánh `PASS` vì UI/bảng tồn tại, đánh `PASS` vì "đã có code").
6. `NOT_IMPLEMENTED` / `BLOCKED` là verdict hợp lệ để **báo cáo**, nhưng nghĩa là **goal CHƯA đạt** — phải nêu như blocker cần user quyết, không phải kết thúc gọn gàng.

## Codex opener

```
/goal Đạt 100% hạng mục P0-A→P1 của MASTER UPGRADE: Core retrieval cách ly platform,
OMP Context Bridge fail-open, verified learning không self-promote, MCP parity gate,
Core Health có reasonCode, và lớp đo B23/B30/B32 đóng — tất cả có receipt revision-bound.

Read first: plans/260915-1658-goal-p0-retrieval-bridge-completion/plan.md
            plans/260915-1658-goal-p0-retrieval-bridge-completion/reports/ladder-31-items.md
            plans/260915-1658-goal-p0-retrieval-bridge-completion/reports/preflight-matrix.md

Repo: E:/Work/apps/AntiFan (branch main). Không có mốc thời gian — biên là phase gate.

Constraints: không nới tiêu chí để đạt 100%; không sửa test để ép verdict;
không auto-promote candidate; không git reset --hard / clean / push --force;
haravan theme push* chỉ khi được duyệt; không secret trong artifact.

Validate at each phase gate: npm run compile · node scripts/check-mcp-budget-dominance.mjs ·
node scripts/check-bottlenecks.mjs · super-core + site-clone suites · git SHA vào receipt.
Mỗi fix phải có test FAIL trước / PASS sau.

Stop when PASS == 31 với receipt revision-bound, hoặc khi cần quyết định của con người.
Follow the scope guard above.
```

## Claude long-run opener

```
Đạt 100% hạng mục P0-A→P1 của MASTER UPGRADE trên repo E:/Work/apps/AntiFan.

Read first: plans/260915-1658-goal-p0-retrieval-bridge-completion/plan.md
            và reports/ladder-31-items.md (mẫu số 31 hạng mục).

Honor the LOCKED outcome contract in plan.md. Không có mốc thời gian: tiến độ đo bằng
phase gate, không bằng đồng hồ. Runner deterministic là xương sống; agent chỉ triage khi fail.

Validate: mỗi hạng mục có verdict terminal PASS|FAIL|NOT_IMPLEMENTED|BLOCKED, 0 skip,
0 timeout; mọi PASS có receipt revision-bound (git SHA + exit + finishedAt + routeIdentity);
mọi fix có test fail-trước/pass-sau.

At each phase boundary apply the scope guard in plan.md.
Stop when done or when a human decision is required.
Do not auto-expand scope. Do not weaken tests. Do not fabricate results.
```

---

## Scope note (không chặn — chọn một lần, ngay khi bắt đầu phase 7)

Đường render **đã có**: `https://hangquoctai.myharavan.com/` phục vụ theme `1001357480`. Không cần push, không cần approve, cho **chế độ mặc định**.

Ranh giới duy nhất cần chốt:

| Chế độ đo | Cần gì | Verdict nói về |
|---|---|---|
| **Published** (mặc định) | Chỉ URL. Không push, không approve | Theme **như đang sống trên store** |
| **Local edits chưa publish** | `theme push-only` / `theme dev` → **cần user phê duyệt** (ghi lên remote) | Sửa đổi local trong `Storefront/` |

Phase 7 chạy được ngay ở chế độ **published**. Chỉ khi phase cần chứng minh một **sửa đổi local cụ thể** thì mới phát sinh cổng phê duyệt push — và lúc đó nên dùng **theme dev riêng** thay vì ghi đè theme `1001357480` đang publish.

**Cảnh báo vận hành**: `theme dev` đẩy **mọi thay đổi file** trong lúc watch. Trong một run dài nhiều ngày, đừng để nó chạy nền không giám sát — sẽ ghi liên tục lên store remote.

**Việc bắt buộc của phase 7 bất kể chế độ nào**: **re-target** campaign khỏi `hoplongtech.com` (org khác) sang `hangquoctai.myharavan.com`. Nếu bỏ bước này, mọi verdict mới vẫn nói về site của người khác.
