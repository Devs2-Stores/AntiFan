# Soak 4h workflow-performance — verdict và bang chung (2026-09-20)

Run: `scripts/benchmark-real-soak-8h.cjs`, `SOAK_DURATION_MINUTES=240` (warmup 30 / workload 180 / recovery 30)
Cua so: `2026-09-19T17:52:10.754Z` -> `2026-09-19T21:52:38.353Z` (local 00:52:10 -> 04:52:38, 2026-09-20)
Profile `.antifan-soak-8h` xoa truoc khi launch, root pid 28216, 6 tab + 1 terminal + 1 pty session khong ai yeu cau, 242 mau, 240 frame telemetry x 8 pid, 4090 switch, 0 phut may sleep, teardown sach (6/6 tab + terminal dong).
Config day du trong artifact: `switchIntervalMs 3000`, `burstIntervalMs 30000`, `burstLines 300`, `fixtureTickMs 200`, `tabRounds 1`, `reportTag soak4h`.
Nguon so: `real-soak-8h-soak4h.json` (final payload) + `real-soak-8h-soak4h-checkpoint.json` (242 mau tung phut) + `scripts/analyze-soak-app-only.cjs` (doc lap, chay tren payload cuoi).

## 1. Verdict

**`FAILED`** (`status: failed`, process exit 1).

| Gate | Nguong | Do duoc | Ket qua | Gate nay do cai gi |
|---|---|---|---|---|
| `slopeOk` (overall) | ≤ 0.35 MB/min | 0.275229 | v | ca cay process, ke ca process ngoai app |
| `slopeOk` (renderer) | ≤ 0.15 MB/min | 0.038949 | v | **8 renderer** (app 5 + Zalo 3) |
| `memoryOk` (peak active) | ≤ 1600 MB | **2126.06** | x | cung cay do, peak luc 18:13:11Z |
| `latencyOk` (switch max) | ≤ 35 ms | **50.976** | x | switch cua warmup + workload gop chung |
| `latencyOk` (p50 / p95) | ≤ 12 / ≤ 18 ms | 10.346 / 15.513 | v | nhu tren |
| `processOk` (orphan) | 0 | **11** | x | pid `pidsBeforeKill` con song sau khi kill app |
| `executionOk` | khong loi | khong loi | v | |
| `teardownOk` | khong degraded | 6/6 tab + terminal dong | v | |

Ba gate do (`memoryOk`, `processOk`, `latencyOk`) va mot gate bao pass sai (`slopeOk` renderer) duoc phan tich duoi day. Dong `rendererActiveSlopeMBPerMin` **khong** phai so cua app.

## 2. Gate do sai: cay process khong phai cua app (do duoc, khong suy dien)

`collectProcessTree` di theo parent pid. Tren desktop nay no nuot process cua app khac: Windows bao parent cua Zalo la pid 11704 (crashpad handler cua chinh app soak) vi parent that da thoat va pid duoc cap lai.

| Bang chung | Do duoc |
|---|---|
| `byType.renderer.count` trong **moi** frame workload | **8** (app 5 + Zalo 3) |
| `byType.gpu.count` / `utility.count` workload | 2 (app 1 + Zalo 1) / 5 (app 1 + Zalo 4) |
| `byType.other.count` workload | 10 (pty chain cua app + Zalo + crashpad) |
| tong walk trong workload | 2019.92 -> 2094.23, peak **2126.06** |
| peak app-owned (telemetry, 8 pid) | **1278.34 MB** luc `2026-09-19T18:13:11.941Z` |
| app-owned + pty chain (~166 MB do o 129 phut) | **≈ 1444-1490 MB** (can tren) |

Offset ngoai app tai peak ≈ **682 MB**. Peak 2126.06 MB ma gate `memoryOk` bao fail la peak cua **Zalo + app**, khong phai cua app.

### `processOk: false` (11 orphan) la false-fail — bang chung song

`pidsBeforeKill` duoc lay tu cung cay do (dong 1225-1230), nen process ngoai app nam trong danh sach "phai chet" roi duoc tinh la orphan khi chung van song.

- Sau khi run ket thuc: `Get-Process Zalo,ZaloCall,ZaloCap` = **11 process** — dung bang so orphan harness bao (11).
- `Get-CimInstance Win32_Process` loc theo `antifan-soak-8h` = **0 process** (app tree da chet hoan toan), nen 11 pid con song khong the la cua app.

## 3. Doc lai app-only (so quyet dinh, tu 240 frame telemetry cua app)

Cua so workload 178 phut / 179 frame; app-owned 8 pid.

| series (app-only) | first -> last | LSQ | sd | range | amplitude/drift |
|---|---|---|---|---|---|
| Tab sum `workingSetMB` | 731.50 -> 737.16 | **−0.10 MB/min** | 11.40 | 42.42 | 7.5x (khong doc duoc trend) |
| Tab sum `privateBytesMB` | 267.02 -> 293.55 | **+0.12 MB/min** | 6.82 | 32.73 | |
| rieng pid 47536 `privateBytesMB` | **87.78 -> 117.54 (+29.76 MB)** | **+0.17 MB/min** | 8.79 | | floor +0.167 |

Tung process, cua so workload (private): 47536 **+0.17**; 34196 (GPU) −0.05; 33800 (4 fixture tab) −0.03; 11244 (wikipedia) −0.01; 25348, 44852, 46880, 28216 ~ 0.00. **Mot process tang, khong con process nao khac.**

Process do la **pid 47536**, `role = chrome:standalone+chrome:toolbar+chrome:frame-backdrop`, `url = file:///E:/Work/apps/AntiFan/.compiled/src/renderer/standalone.html` — lay tu chinh telemetry cua app (khong phai tu walk), tuc day la renderer chrome dung chung cua toolbar + terminal sidebar + frame backdrop.

Hinh dang: floor (rolling-min) khong phang — +0.167 -> +0.162 -> +0.159 qua 60 phut dau / 60 phut cuoi / 30 phut cuoi, tuc **khong plateau**; va recovery tra lai **25.04 MB tren 29.76 MB (84 %)** roi dung yen 7 frame. Ket luan: **view-lifetime retention** — tich luy trong luc view song, tra lai khi view dong, con du ~5.47 MB.

## 4. Tieu chi 2: KHONG dat theo dung dac ta da sua

- `rendererActiveSlopeMBPerMin` bao **0.038949** la so cua 8 renderer (co Zalo) — no bao pass cho mot run ma process duy nhat dang lon la renderer UI cua chinh app.
- Doc lai app-only: **aggregate** nam trong nguong (−0.10 WS / +0.12 private) nhung **per-process max = +0.17 MB/min** > 0.15. Day dung la cai ma B39/B41 da sua: tong co the bi che boi mot process khac di ngang hoac giam (o day GPU tra −21.22 MB private trong cung cua so).
- Chua co fix cho retention: allocation giu memory **chua duoc dinh vi**. Danh sach nghi van (doc read-only, 4 consumer chay moi broadcast 5 Hz): `updateAffinityBadges()` tu fetch lai list (`standalone.js:4685` -> `:2710-2775`) va `renderTabs()` chay lai theo title (`toolbar.ts:2413`); hai cai con lai (`renderThemeQa`, `updateControls`) da bi loai bang bang chung.
- Quy mo: ~10 MB/h, ~30 MB qua 3 gio, tra lai 84 % khi dong view. Do la defect that (khong co bound), nhung **khong phai** cai chan "lam nhieu viec cung luc" — cai chan la CPU tren thread pool dung chung va duoi latency.

## 5. Tieu chi 3: latency — breach duoc dac ta hoa (khong phai one-off, khong phai mot destination)

| | gia tri |
|---|---|
| p50 / p95 / max (warmup + workload gop) | 10.346 / 15.513 / **50.976 ms** |
| max tren **workload** | **50.976 ms** (8 trong 10 switch cham nhat la workload: 50.976, 44.773, 44.071, 43.066, 42.163, 42.020, 41.533, 40.631; 2 la warmup 46.014 / 45.652) |
| theo destination (682 switch moi cai) | p50 10.13-10.88, p95 14.62-16.94, max **38.10-50.98** — **ca 6 destination deu vuot 35** |
| tan suat | ~0.2 % cua 4090 switch |
| so sanh baseline 2h | baseline fastest 3.092 ms, run nay 6.76 ms -> ca phan phoi bi dich, khong chi duoi |

Ket luan: day la **stall toan cuc o steady state**, khong phai chi phi rieng cua wikipedia/google (gia thuyet cua run 2h) va khong phai artifact khoi dong. Giai thich bang scrape cua chinh harness cung da bi bac: 1 trong 10 switch cham nhat nam trong 3 s cua mot scrape va no la cai **nho nhat** (17.0 ms).

Day la **quyet dinh cua user**, khong phai fix (Phase 3c): gate `max` (hien 50.976 vs 35) hay gate mot percentile va bao cao max. Nguong **da duoc quyet trong luc run leg 4 h chay** (muc 9): chon phuong an (b) — gate percentile, `max` chi bao cao; nguong cu khong con trong source, nhung run leg dang chay van dung instrument cu nen verdict cua no phai doc theo ca hai dinh nghia (muc 11).

## 6. Acceptance criteria

| # | Ket qua | Bang chung |
|---|---|---|
| 1. Bao cao goi ten process da lon, theo role + URL, tu telemetry cua app | **DAT** | pid 47536 / `chrome:standalone+chrome:toolbar+chrome:frame-backdrop` / `file:///.../standalone.html`, tu `processSeries` (240 frame) |
| 2. App-owned renderer slope trong 0.15 MB/min va fix truy duoc ve mot allocation giu memory | **KHONG DAT** | app-only per-process private **+0.17** > 0.15 (~10 MB/h, 84 % tra lai o recovery); allocation giu memory chua duoc dinh vi |
| 3. Latency max trong 35 ms tren workload **hoac** outlier duoc dac ta hoa kem bang chung; warmup in canh | **DAT (nhanh dac ta hoa)** | breach that o steady state, toan cuc, ca 6 destination, 0.2 % so switch; quyet dinh nguong chuyen user |
| 4. Moi gate ma run truoc pass van pass (khong mua pass bang cach noi gate) | **DAT kem canh bao, da dinh luong** | app-owned: memory ≈1444-1490 MB ≤ 1600 (van pass), p50/p95 latency van pass. Hai gate bao fail moi (`memoryOk`, `processOk`) la do contamination — da sua trong source. Ba dieu kien moi (B39/B40/B42) deu **chat hon**, khong noi cai nao |
| 5. `npm run compile` + cac suite bi anh huong xanh | xem muc 8 | |

## 7. Sua instrument da vao HEAD (run nay chua dung duoc chung)

Cac sua nay vao source **sau** khi run launch (00:52), nen so o muc 1-3 la so cua instrument cu; chung co hieu luc cho run sau:

- **B40** — `collectProcessTree(all, rootPid, markers)` co ownership test (command line phai mang project root hoac data root cua run, bien theo separator; hoac la executable PTY cua app) va tra `{ tree, refused }`; moi lan tu choi duoc ghi vao mau (`refusedProcessCount` / `refusedProcessWorkingSetMB` / `refusedProcessNames`) + in ra verdict. Sua nay dong thoi sua luon `processOk` (11 "orphan" la Zalo).
- **B39** — moi row per-process co ca `slopePrivateMBPerMin`; payload them `appPrivateMaxSlopeMBPerMin` / `appPrivateMaxRole` / `appPrivateMaxUrl` / `appPrivateMaxPid` + cua so fit (`processSlopeWindowStart` / `End`).
- **B41** — tieu chi 2 them dieu kien `privateSlopeOk` (per-process private max ≤ nguong renderer, va series phai ton tai); dieu kien renderer-sum cu van giu, nen chieu la chat hon.
- **B42** — `switchLatencyMs` gio la quantile cua **workload**; `switchLatencyWarmupMs` va `switchLatencyAllPhasesMs` in canh; gate doi series workload khong rong va doc quantile null la `Infinity` (rong => fail, khong pass nho fallback `|| 0`).

B40 va B42 duoc `scripts/check-bottlenecks.mjs` xac nhan la khong con tai HEAD (FIXED_UNRECORDED -> da flip `closed`), B39 va B41 duoc ghi `closed` voi predicate la chinh marker cua fix (xoa fix => row reopen). Ledger: 46 row, CLOSED=33, OPEN=1 (B23), MANUAL=8, REFUTED_OK=4, 0 error.

## 8. Sau run: hai fix da vao HEAD (co bang chung), mot gia thuyet da bi bac

Section 7 ghi cac sua *instrument*; duoi day la cac sua *san pham* dua tren so cua run nay.

| # | Muc trong muc tieu throughput | Trang thai | Bang chung do duoc |
|---|---|---|---|
| 1 | `updateAffinityBadges()` goi lai `api.getTabs()` moi luot broadcast | **da ap dung** | list da giao thang tren duong `onTabsUpdated`; 5 call site khong giu list thi van fetch. Test ghim "list da giao khong duoc fetch lai" (2 nguon dat title khac nhau), **dot bien tren chinh bundle ma harness nap** => 46 pass / 1 fail dung ca do; hoan nguyen => 47/47 |
| 2 | `renderTabs()` parse 48 selector moi lan render | **da ap dung** | cache ref 7 con theo tung element (`WeakMap`), tra tab bang mot luot quet `children`. Probe DOM that tren bundle da emit: luot render dau **54** `querySelector` (42 = 7 x 6 tab dien cache + 6 `.tab-close` + 6 `.tab-audio-btn`), steady-state **0**, them 1 tab = 9, xoa 1 tab = 0; cache khong lam cu noi dung (title/badge/spinner/audio deu doi dung) |
| 3 | pty thu hai khong ai yeu cau (boot ~1.1 s, ~83 MB idle) | **bi bac** | `#terminal` la container vinh vien trong renderer, khong co affordance thu gon; chinh loi goi do cung la duong restore session da luu, nen "spawn lazy khi dock duoc mount" khong co diem mount de bam vao |

Co che giu bo nho *ben trong* Blink (attribute/string table + buffer IPC giu page committed toi luc view bi teardown) van la **[INFERENCE]**: hai fix duoc bien minh bang *cong viec moi luot broadcast bi xoa* (do duoc), khong phai bang mot allocation duoc dinh vi.

**Nghiem thu (dang chay)**: `SOAK_DURATION_MINUTES=90 SOAK_WARMUP_MINUTES=15 SOAK_RECOVERY_MINUTES=15 SOAK_REPORT_TAG=preflight-fixed` — cua so workload 60 phut la dung do cua floor rolling-min cua pid 47536 (0.17 MB/min = drift +10 MB tren nen nhieu ~1 MB, nen 60 phut la du va them 4 h nua thi khong). Ket qua duoc ghi vao muc 9 khi run ket thuc; neu floor khong phang thi ket luan co che trong CHANGELOG phai duoc rut lai, khong duoc giu nguyen.

## 9. Quyet dinh nguong latency (cua user, khong tu quyet)

`max` 50.976 ms vuot 35 ms o ~0.2 % so switch (4090), ca 6 destination deu vuot, p50 10.346 / p95 15.513 van trong nguong, va ca phan phoi bi dich so voi baseline 2 h (fastest 3.092 -> 6.76 ms) nen day la dich chuyen that chu khong phai mot outlier. Ba lua chon: (a) giu gate `max` 35 ms => run nao cung fail; (b) doi sang gate percentile (p95 <= 18 ms) va bao `max` nhu so chan doan; (c) nang `max` len muc do duoc tren may 4 nhan dang chia se voi app cua user + session nay + terminal daemon.

**DA QUYET (2026-09-20, user chon (b))**: gate cham **p50 <= 12 ms va p95 <= 18 ms** tren workload phase; `max` **chi bao cao**, khong cham. Da ap dung trong source:

- `scripts/benchmark-real-soak-8h.cjs`: so hang `switchLatencyMaxMs: 35` **bi xoa khoi `FREEZE_SLO`** (mot nguong nam trong object SLO ma khong ai cham la bay cho nguoi doc sau), dieu kien `switchMax <= ...` bi xoa khoi `latencyOk`, comment ghi ro ly do + ngay. Payload them `switchLatencyMaxMs` (so do) va `latencyMaxGated: false` (hinh dang gate), printer doi `max=... (SLO <= 35ms)` thanh `(reported, not graded)` — neu chi bo dieu kien ma khong ghi, mot nguong bi bo va mot nguong duoc pass se doc ra giong nhau.
- Bang chung: `test/unit/soak-latency-gate.test.mjs` (6 case) goi **chinh** `evaluateFreezeVerdict` xuat tu harness, khong phai ban sao. **Doi khang duoc kiem**: dat lai so hang `switchMax <= 35` => 2 case do (`max` 50.976 va `max` 900 voi p50/p95 dung bien) fail; hoan nguyen => 6/6 pass. Case "series rong khong duoc pass" giu bat bien cu cua B42.
- Entry point khong doi: `main()` duoc boc trong `if (require.main === module)`, than `main().catch(...)` giu nguyen tung chu; **khong** chay thu harness bang lenh that vi no `rmSync` chinh profile `.antifan-soak-8h` cua run dang chay — thay bang probe 3 dong chung minh dung ngu nghia guard (`node file` => chay `main`, `require(file)` => khong), cong voi test unit da chung minh `require` tra ve hai export va khong khoi dong run.
- Run leg 4 h dang chay van la instrument cu (harness da nap vao bo nho truoc khi sua), nen verdict cua no co the `FAILED` o `max`; khi ghi muc 11 phai doc lai theo dinh nghia moi va noi ro ca hai, khong duoc im lang bo qua.

## 10. Preflight post-fix (da ket thuc) — ket luan co che trong CHANGELOG bi RUT LAI

Run: `SOAK_DURATION_MINUTES=90 SOAK_WARMUP_MINUTES=15 SOAK_RECOVERY_MINUTES=15 SOAK_REPORT_TAG=preflight-fixed`,
bundle **da sua** (2 fix broadcast + cache ref tab), cung driver rate nhu run 4 h (switch 3 s / burst 300 dong moi 30 s / fixture tick 200 ms).
Hai so duoc do **cung mot cua so** — workload phase, cung role `chrome:standalone+chrome:toolbar+chrome:frame-backdrop`, cung cot `privateBytesMB`, fit LSQ tren tung frame 60 s:

| Run | Bundle | Cua so workload | pv dau -> cuoi | Do doc ± 1se | resid sd | 2nd half |
|---|---|---|---|---|---|---|
| 4h | truoc sua | 179 phut | 85.48 -> 117.54 (+32.06 MB) | **0.1699 ± 0.0010** | 0.66 | 0.166 |
| preflight | sau sua | 58 phut | 82.43 -> 94.13 (+11.70 MB) | **0.2234 ± 0.0070** | 0.92 | 0.209 |

Doc duoc, khong suy dien:

- Do doc **cao hon** sau khi sua (+0.0535 MB/phut, ~7.5σ theo 1se cua hai fit) va **khong he giam** ⇒ hai fix broadcast **khong so huu** do troi nay. Ket luan co che trong CHANGELOG bi **rut lai** nhu da ghi truoc o muc 8; hai fix duoc bien minh dung nhu da viet — bang **cong viec moi luot broadcast bi xoa** (probe dem mutation), khong bang do troi.
- Do troi **tuyen tinh va on dinh** ca cua so (2nd half 0.209 ≈ 1st half 0.243; floor rolling-min 10 frame **van leo** +2.79 MB trong 20 phut cuoi) ⇒ khong phai "buffer co tran day roi phang": xterm scrollback la **10.000 dong** (`src/renderer/standalone.js:2034`), nen neu la scrollback thi phai phang sau ~16 phut — do khong phang.
- Cung mot chi phi tren **moi dong output terminal**: 4 h = 32.06 MB / 107.400 dong = **298 B/dong**; preflight = 11.70 MB / 34.800 dong = **336 B/dong**. Hai bundle khac nhau, gan cung mot chi phi/dong ⇒ nghi pham chuyen tu "broadcast" sang **duong ghi terminal**. Gioi han cua bang chung nay: ca hai run deu ~10 dong/giay, nen mot driver ti le voi **thoi gian** cung khop so lieu y het; phan biet hai gia thuyet do la **leg bisect** (muc 11), khong phai suy luan them.

## 11. Leg bisect — cung mot run, ba muc burst khac nhau (dang chay)

Instrument moi trong `scripts/benchmark-real-soak-8h.cjs`: `SOAK_LEGS="ten:phut:burstLines:burstIntervalMs,..."` chia **workload phase** thanh cac leg lien tiep, moi leg mot muc burst khac nhau; report mang `config.legs` (schedule) + `legSlopes` (do doc + top process theo **tung leg**, cua so lay tu moc chuyen leg thuc te) + so burst **quan sat duoc** tung leg (mot leg ghi hong se doc thanh "driver nay khong ton gi" neu thieu). Leg key gom ca ten **va** cua so, nen mot bisect quay lai regime cu (`baseline,burst4x,baseline`) van la ba leg. Vi workload cua leg run la **co y khac nhau**, gate do doc **khong cham diem** run nay: `slopeSloSatisfied: null` + `slopeGateApplicable: false` + verdict `PASSED_SLOPE_NOT_GRADED` (mot so do doc gop cua ba regime la so vo nghia, do khong phai mot ket luan).

Run: `SOAK_DURATION_MINUTES=240 SOAK_WARMUP_MINUTES=30 SOAK_RECOVERY_MINUTES=30 SOAK_REPORT_TAG=legs4h SOAK_LEGS="baseline:60:300:30000,burst4x:60:1200:30000,burst-off:60:1:600000"`

| Leg | Phut | Burst | Tra loi cau hoi |
|---|---|---|---|
| `baseline` | 60 | 300 dong / 30 s (10 dong/s) | do doc chuan cua bundle hien tai (tai lap 0.2234) |
| `burst4x` | 60 | **1200 dong / 30 s** (40 dong/s) | neu chi phi theo **dong** thi do doc ≈ 4x leg 1; neu theo **thoi gian** thi ≈ leg 1 |
| `burst-off` | 60 | 1 dong / 600 s (≈ tat) | neu theo dong thi ≈ 0; neu theo thoi gian thi ≈ leg 1 |

Cung run do luon **thong luong** thuc te khi terminal nhan 40 dong/giay trong khi switch tab moi 3 s — truc tiep la cau hoi "lam duoc nhieu viec cung luc" — qua `switchLatencyMs` va so burst quan sat duoc cua leg 2.
