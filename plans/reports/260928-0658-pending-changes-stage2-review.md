# Review Stage 2 — thay đổi đang chờ: độ trung thực của kiểm chứng

- **Thời điểm tổng hợp:** 2026-09-28 06:58 (giờ local), trên cây làm việc tại `E:/Work/apps/AntiFan`.
- **Chế độ:** read-only. Không chạy build/lint/test; không sửa file nào ngoài chính báo cáo này.
- **Nguồn:** ba payload của scout (`ScoutUnitMain`, `ScoutE2EProbe`, `ScoutCIWiring`), đã gộp trùng và
  đối chiếu lại `file:line` trực tiếp trên cây. Mọi dòng được trích trong báo cáo này đã được đọc/grep
  lại; các vị trí scout ghi lệch đã sửa và nêu ở mục *Bổ sung khi đối chiếu*.
- **Kết quả:** 34 finding sau khi gộp — **2 Critical**, **13 Important**, **19 Minor**.

Thang mức độ: *Critical* = một cổng/nhãn kiểm chứng có thể sai mà không ai biết; *Important* = một
verdict (PASS/FAIL) có thể sai hoặc một test không thể đỏ khi sản phẩm hỏng; *Minor* = suy giảm độ
phủ/độ chính xác của bằng chứng, không tạo verdict sai.

---

## CRITICAL

### C1 — Lane `typecheck` không tồn tại trong pipeline, nên `npm test` / `npm run verify` không bao giờ kiểm type

**Vị trí:** `scripts/run-test-pipeline.mjs:23-43` (TEST_LANES), `:47-55` (KNOWN_LANES), `:107`; `package.json:30` (`typecheck`), `package.json:49-50` (`test`/`verify`).

**Nhận định:** Cổng test hợp nhất của repo không chạy `tsc --noEmit`, và gọi lane tên `typecheck` sẽ ném lỗi thay vì chạy nó.

**Bằng chứng:**

- `scripts/run-test-pipeline.mjs:47-55`: `const KNOWN_LANES = new Set([...STATIC_LANES, ...TEST_LANES, 'test:unit', 'test:e2e', 'test:probes'])` — không có `'typecheck'`.
- `scripts/run-test-pipeline.mjs:107`: `else if (!KNOWN_LANES.has(arg)) throw new Error(\`Unknown lane '${arg}' (known: ${[...KNOWN_LANES].sort().join(', ')})\`)`.
- `package.json:30`: `"typecheck": "tsc -p ./ --noEmit --tsBuildInfoFile .compiled/.tsbuildinfo.typecheck"` — chỉ chạy khi gõ tay.
- `package.json:49-50`: `"test": "node scripts/run-test-pipeline.mjs"`, `"verify": "node scripts/run-test-pipeline.mjs --verify"` — chạy đúng TEST_LANES khi không nêu lane.

**Tác động:** Mọi câu "typecheck xanh" (ví dụ `CHANGELOG.md:39`) là bằng chứng thủ công, không phải cổng. Trong pipeline chỉ có lane `compile` (`tsc -p ./` emit) tình cờ phủ lỗi type; nếu compile bị bỏ qua (`--no-compile`) hoặc lane compile chạy trên tree khác thì lỗi type không có cổng nào chặn.

**Sửa tối thiểu:** Thêm `'typecheck'` vào `NON_COMPILE_LANES` (`scripts/run-test-pipeline.mjs:56`) và vào `KNOWN_LANES`/`TEST_LANES`, hoặc xoá script `typecheck` và ngừng coi nó là cổng.

*Nguồn: ScoutCIWiring (đã đối chiếu trực tiếp).*

### C2 — Không có CI: mọi lane và mọi receipt chỉ chạy tay

**Vị trí:** toàn repo (không tồn tại `.github/`, `.gitlab-ci.yml`, `.circleci/`, `Jenkinsfile`, `azure-pipelines*`, `ci/`); `.coderabbit.yaml:1-46`.

**Nhận định:** Không có workflow nào gọi `npm test` / `npm run verify`, nên không có gì gate kết quả lane hay receipt nghiệm thu.

**Bằng chứng:**

- Liệt kê gốc repo: không có thư mục/file CI nào; glob `.github`, `.gitlab-ci.yml` trả về *"Skipped missing paths"*.
- `.coderabbit.yaml` chỉ có `reviews:` với `path_filters`/`path_instructions` (bot review PR), không có lệnh test nào; `.omp/config.yml` là cấu hình harness.
- Kết quả nghiệm thu (`plans/260927-0315-project-windows/reports/project-windows-matrix.json`, `quit-coordination-probe.json`, evidence của e2e) chỉ được ghi ra `plans/**/reports/` và không có bước nào đọc lại để gate.

**Tác động:** Trạng thái "xanh" của repo phụ thuộc hoàn toàn vào việc ai đó chạy tay đúng lệnh. Một thay đổi làm đỏ lane `test:main` không bị chặn ở đâu cả ngoài kỷ luật con người; receipt có thể cũ hàng ngày mà vẫn nằm trong repo như thể là bằng chứng hiện tại.

**Sửa tối thiểu:** Nếu định gate thật: thêm một workflow gọi `npm run verify` (kèm `typecheck` sau khi sửa C1). Nếu không: ghi rõ trong `docs/` rằng cổng hiện là local-only để người đọc receipt không nhầm nó là gate của CI.

*Nguồn: ScoutCIWiring (đã đối chiếu trực tiếp).*

---

## IMPORTANT

### I1 — Row R2b: lệnh gửi xuyên cửa sổ không được assert, nên "bị từ chối" không phân biệt được với "chưa hề gửi"

**Vị trí:** `scripts/probe-project-windows-matrix.cjs:1905-1910` (gửi), `:1928-1930` (ghi vào `observed`), `:1964-1966` (khẳng định duy nhất).

**Nhận định:** Khẳng định của row chỉ dựa trên marker không xuất hiện; biến `crossSent` (kết quả thực thi lời gọi) được ghi vào receipt nhưng không bao giờ được kiểm.

**Bằng chứng:** `const crossSent = await send(sidebarA, \`(() => { try { window.antifanStandalone.sendTerminalInputTo(...); return { sent: true }; } catch (err) { return { sent: false, error: ... }; } })()\`, 'A cross-window send');` (`:1905-1908`) — nhưng assert duy nhất là `expect(neverSawMarker(crossReachedB), ...)` (`:1964`). Kênh ship là fire-and-forget: `sendTerminalInputTo: (id, input) => ipcRenderer.send('antifan:terminal:input-session', { id, input })` (`src/preload/standalone-preload.ts:39`) trên route `kind: 'on'` (`src/main/browser/native-tab-host.ts:2532-2533`).

**Tác động:** Nếu `sendTerminalInputTo` bị đổi tên/undefined/throw trong renderer, wrapper trả `{sent:false}`, marker không bao giờ tới B, và row **PASS** trong khi lời khẳng định "ghi tên session của cửa sổ khác bị từ chối" chưa từng được thực thi. Receipt nghiệm thu ghi một PASS không có đối tượng.

**Sửa tối thiểu:** Thêm `expect(crossSent && crossSent.sent === true, ...)` ngay trước `expect(neverSawMarker(...))`.

*Nguồn: ScoutE2EProbe (đã đối chiếu trực tiếp).*

### I2 — Row R7: popout không mở được nhưng row vẫn PASS, dù chính `observed` ghi "unproven"

**Vị trí:** `scripts/probe-project-windows-matrix.cjs:3020-3028`.

**Nhận định:** Khi `togglePopoutTerminal` thất bại, nửa "cửa sổ phụ còn nguyên" của tiêu chí R7 không quan sát được, nhưng row vẫn kết thúc PASS.

**Bằng chứng:** `const popoutOpened = betaHostNow.togglePopoutTerminal(terminalSessionId);` (`:2969`); nhánh else (`:3024-3027`) chỉ ghi chú `row.observed.auxiliaryNote = 'the terminal popout could not be opened in this environment, so the auxiliary-survival half of this row is unproven; ...'` rồi rơi vào `expect(app.isReady() === true, ...)`. Cơ chế PASS nằm ở `:724-726`: `expect(Object.keys(row.observed || {}).length > 0, ...)` rồi `row.status = 'PASS'` khi không ném.

**Tác động:** Trên môi trường luôn mở hụt popout, R7 là PASS rỗng vĩnh viễn; receipt chứa một dòng tự mâu thuẫn (verdict PASS + "unproven") mà máy đọc receipt không phát hiện được. So sánh: các row khác đã dùng đúng mẫu BLOCKED (`:2645-2647`, `:3743-3746`).

**Sửa tối thiểu:** Trong nhánh else: `row.status = 'BLOCKED'; row.reason = 'the terminal popout could not be opened in this environment'; return;`.

*Nguồn: ScoutE2EProbe (đã đối chiếu trực tiếp).*

### I3 — Row R9E: truy vấn descendant thất bại bị đọc thành "không còn tiến trình nào sống sót"

**Vị trí:** `scripts/probe-project-windows-matrix.cjs:3826-3843` (`query`/`alive` trả `null` khi OS không trả lời), `:3862-3863` (`const survivorCheckRan = hostGone;`), `:3886-3889` (`if (alive(pid) === true) survivingPids.push(pid);`), `:3891-3898` (listing có thể `null`), `:3919` (`descendantCheckSupported: true`), `:195-202` (phán quyết phía merge).

**Nhận định:** Phía merge coi "survivor scan đã chạy" là đủ, trong khi mỗi truy vấn con có thể thất bại và biến thành mảng rỗng — tức "không đọc được" bị tính là "sạch".

**Bằng chứng:** `/ ** true = alive, false = the OS says absent, null = the OS could not answer. */ const alive = (pid) => { const out = query(...); if (out === null) return null; ... }` (`:3834-3843`); `const survivorCheckRan = hostGone;` (`:3863` — không gắn với kết quả truy vấn nào); `const ok = observationAvailable && survivorPids.length === 0 && commandLineMatches.length === 0;` với `const observationAvailable = supported && hostGone && survivorCheckRan;` (`:195-196`, `:202`). Report của watcher chỉ mang `ancestorQueryUnanswered: unansweredPolls` (`:3916`) — đếm poll phía **host**, không có trường nào cho biết truy vấn descendant đã được trả lời; `descendantCheckSupported: true` bị hardcode ở `:3919`.

**Tác động:** Một lần PowerShell timeout/thất bại thoáng qua sau khi host đã chết ⇒ `survivingPids`/`commandLineMatches` rỗng ⇒ R9E được merge thành `verdict: PASS - no owned process survived the GUI exit` cho một observation chưa từng được thực hiện. Không có trường nào trong report cho phép người đọc phát hiện điều đó.

**Sửa tối thiểu:** Ghi lại `descendantQueryFailed`/`childrenQueryFailed` (hoặc các trường `null`) vào report watcher và đưa chúng vào điều kiện `observationAvailable`; khi truy vấn con thất bại thì để R9E ở BLOCKED thay vì PASS.

*Nguồn: ScoutE2EProbe (đã đối chiếu trực tiếp).*

### I4 — e2e driver: row quá hạn không bị huỷ, judge "zombie" tiếp tục chạy và ghi vào receipt

**Vị trí:** `test/e2e/project-windows.test.ts:331-346` (`ROW_TIMEOUT_MS = 90000`; `await Promise.race([fn(), rowTimeout.promise])`; catch rồi chạy tiếp), `:1615-1625` (ghi evidence trong `.finally`).

**Nhận định:** `Promise.race` không huỷ `fn()`; row hết hạn vẫn đang điều khiển cửa sổ/tab và vẫn kịp ghi vào `observations` trước khi receipt được ghi.

**Bằng chứng:** `catch (err) { checks.push({ name: name, ok: false, error: messageOf(err) }); ... }` — sau đó vòng lặp chạy tiếp row kế; receipt được ghi ở cuối: `.finally(async function () { await cleanup(); ... fs.writeFileSync(EVIDENCE_FILE, JSON.stringify(result, null, 2), 'utf8'); })` với `observations: observations` (`:1620-1625`), trong khi suite cha đọc `evidence.observations` (`:1727+`). Probe cùng nhiệm vụ đã chọn fail-stop: `probe-project-windows-matrix.cjs:740-744` — *"Fail-stop, by design: the rows behind this one would read windows an abandoned judge is still driving."*

**Tác động:** Rot của row sau bị quy sai nguyên nhân bởi trạng thái rác do judge bỏ hoang để lại; muộn hơn nữa, judge đó còn có thể ghi `observations` sau khi row đã FAIL, làm receipt vừa mâu thuẫn vừa không tái lập được. `waitFor` (`:297-313`) chờ `predicate()` không có hạn cho từng lần poll nên judge treo là treo vĩnh viễn.

**Sửa tối thiểu:** Khi row hết hạn, dừng run theo đúng mẫu của matrix probe (ném sau khi ghi row để `.finally` ghi receipt với các row chưa chạy là BLOCKED), hoặc ít nhất chụp sâu (deep clone) `observations` trước khi ghi evidence.

*Nguồn: ScoutE2EProbe (đã đối chiếu trực tiếp).*

### I5 — e2e driver: lỗi cleanup chỉ là NOTE ra stdout, không vào receipt

**Vị trí:** `test/e2e/project-windows.test.ts:352-358` (hàm `check`), và các điểm cùng dạng `:704`, `:933`, `:945`, `:1109`, `:1594`, `:1599`.

**Nhận định:** Cleanup thất bại không được ghi vào evidence, nên một row PASS có thể đã để lại trạng thái bẩn cho các row sau mà receipt không nói gì.

**Bằng chứng:** `if (cleanup) { try { await cleanup(); } catch (err) { console.log('  NOTE  row cleanup failed: ' + messageOf(err)); } }` (`:353-357`); row được ghi chỉ có `{name, ok, error?}`; các NOTE khác cùng dạng: `':704'` ("the diagnostic popup tab could not be closed"), `':933'` ("the active capsule could not be restored during cleanup"), `':945'`, `':1109'` (release CLI session), `':1594'`/`':1599'`.

**Tác động:** Ví dụ cụ thể: khôi phục capsule thất bại ở row popup để capsule active ở BETA cho mọi row sau; hai CLI session còn sống làm các row close "address a window that is rightly busy" — verdict của row sau bị bóp méo, receipt vẫn sạch.

**Sửa tối thiểu:** Đẩy lỗi cleanup vào evidence: ví dụ `checks.push({ name: name + ' [cleanup]', ok: false, error })` hoặc thêm trường `cleanupErrors` vào row/result.

*Nguồn: ScoutE2EProbe (đã đối chiếu trực tiếp).*

### I6 — Test alt-screen tự khẳng định regex do chính nó định nghĩa

**Vị trí:** `test/unit/browser/terminal-transcript-lifecycle.test.ts:114-124`.

**Nhận định:** Khối "Alt-Screen Detection Guard" không import gì từ production; nó định nghĩa `isAltScreenEnter`/`isAltScreenExit` ba dòng phía trên rồi assert chúng.

**Bằng chứng:** `describe('Alt-Screen Detection Guard', () => { const isAltScreenEnter = (data: string) => /\x1b\[\?1049h/.test(data); const isAltScreenExit = (data: string) => /\x1b\[\?1049l/.test(data); it('detects xterm alt-screen buffer switch (vim, htop, less)', () => { assert.strictEqual(isAltScreenEnter('some text\x1b[?1049hmore text'), true); ...` — trong khi khối anh em ngay phía trên dùng hằng số ship kèm chú thích (`:59-63`): *"Asserted against the shipped constant, never a local copy: the duplicated pattern this block used to hold is exactly how a case-sensitivity defect stayed hidden behind a green spec."*

**Tác động:** Nếu production xử lý alt-screen bị hỏng/đổi, khối này vẫn xanh — nó là tautology trên `new RegExp(...).test(...)`. Đây đúng là chế độ hỏng mà chú thích của chính file đặt tên.

**Sửa tối thiểu:** Xoá khối này (bản hành vi thật nằm ở `test/unit/browser/terminal-alt-screen-scan.test.ts`, chạy `TerminalManager` thật), hoặc export bộ nhận dạng alt-screen từ `terminal-manager.ts` và assert trên hằng số ship như khối `CLEAR_SCREEN_COMMAND_RE`.

*Nguồn: ScoutUnitMain (đã đối chiếu trực tiếp; dòng scout ghi 119-124, thực tế 114-124).*

### I7 — Test 5 của provenance daemon cài đặt lại chính đường dispatch của production

**Vị trí:** `test/main/terminal-daemon-provenance.test.ts:241-325` (đoạn cài đặt lại ở `:294-296`, `:300-312`), đối chiếu `src/main/terminal-daemon/daemon-entry.ts:284-289` và `:195-197`.

**Nhận định:** Test mang tên "Daemon entry dispatch threads capsuleId into TerminalManager.createSession and startTerminal" nhưng không hề thực thi `daemon-entry.ts`; nó tự trích xuất tham số rồi thay `spawn` bằng hàm giả tự đóng dấu `capsuleId`.

**Bằng chứng:** Trong test: `const cwdNew = typeof pNew.cwd === 'string' && pNew.cwd ? pNew.cwd : undefined; const capsuleIdNew = typeof pNew.capsuleId === 'string' && pNew.capsuleId ? pNew.capsuleId : undefined; const sessionIdNew = tm.createSession(cwdNew, capsuleIdNew);` (`:294-296`) — production thật: `case HOST_METHOD.newSession: { const cwd = typeof p.cwd === 'string' && p.cwd ? p.cwd : undefined; const capsuleId = typeof p.capsuleId === 'string' && p.capsuleId ? p.capsuleId : undefined; ... tm.createSession(cwd, capsuleId) }` (`daemon-entry.ts:284-289`, `:195-197` cho `startTerminal`). Thân test còn thay `tmInternal.spawn` rồi tự ghi `capsuleId` lên record và assert chính giá trị đó.

**Tác động:** Hai nửa của lời khẳng định ("threads capsuleId" và "vào createSession/startTerminal") đều không thể quan sát được: production đổi cách trích `capsuleId` hay bỏ đóng dấu thì test vẫn xanh. Test 1-3 của file dùng proxy/socket thật nên vẫn có giá trị, nhưng test 5 tạo cảm giác đã phủ đường daemon-entry.

**Sửa tối thiểu:** Gửi frame `HOST_METHOD.newSession` thật qua WebSocket hiện có (hoặc import bảng route/handler của `daemon-entry.ts`) rồi assert `tm.getSession(id).capsuleId` do `spawn` thật đóng dấu; bỏ phần mô phỏng inline.

*Nguồn: ScoutUnitMain (đã đối chiếu trực tiếp; dòng scout ghi 305-332, thực tế khối test 241-325).*

### I8 — `ipc-audit` ghim văn bản nguồn của `native-tab-host.ts` để khẳng định hành vi affinity

**Vị trí:** `test/main/ipc-audit.test.ts:554-583` (khối cắt `sessionCreatedBlock`), `:597-598`, `:633-635`.

**Nhận định:** Các assert dùng `block.includes('<chuỗi nguồn chính xác>')` nên vừa có thể xanh khi hành vi hỏng (chuỗi chỉ cần xuất hiện, kể cả trong comment/dead code) vừa có thể đỏ khi refactor lành.

**Bằng chứng:** `const sessionCreatedBlock = content.slice(sessionCreatedIdx, sessionCreatedRegistrationIdx);` (`:555`) rồi `assert.strictEqual(sessionCreatedBlock.includes('let targetTab = this.activeTabId;'), false, ...)` (`:559-561`), `assert.ok(sessionCreatedBlock.includes('const parentAffinity = this.getTerminalAgentAffinity(parentId);'), ...)` (`:569`), `assert.ok(sessionCreatedBlock.includes('this.bindTerminalAgentAffinity(id, generation || 1, targetTab);'), ...)` (`:581`). Cùng dạng: `startHandlerBlock.includes('bindTerminalAgentAffinity')` / `newSessionBlock.includes('bindTerminalAgentAffinity')` (`:597-598`, `:633-635`).

**Tác động:** Một dòng `// this.bindTerminalAgentAffinity(...)` còn sót cũng đủ thoả `includes`, nên đường bind thật có thể hỏng mà suite vẫn xanh; ngược lại, xuống dòng/đổi tên biến khi refactor sẽ làm đỏ dù hành vi giữ nguyên. Bản hành vi đã tồn tại (`test/main/terminal-sleep-affinity-host.test.ts` chạy qua `CHROME_ROUTES` thật, harness ở `test/support/chrome-route-harness.ts`).

**Sửa tối thiểu:** Thay bằng lời gọi route thật qua harness và assert trạng thái manager/host sau `antifan:terminal:new-session`/`START`; hoặc xoá các case này vì đã có phủ hành vi.

*Nguồn: ScoutUnitMain (đã đối chiếu trực tiếp; khối bắt đầu trước `:554`).*

### I9 — Hai dụng cụ nghiệm thu chính (matrix + quit probe) không nằm trong lane nào và không có package script

**Vị trí:** `scripts/probe-project-windows-matrix.cjs:38` (`Run: node scripts/run-electron.cjs scripts/probe-project-windows-matrix.cjs`), `scripts/probe-quit-coordination.cjs:31` (dòng Run tương tự); `package.json` (không có script nào trỏ tới hai file này); `scripts/run-test-pipeline.mjs:23-43` (TEST_LANES không chứa chúng).

**Nhận định:** Hai công cụ tạo ra receipt nghiệm thu multi-window và quit chỉ chạy khi có người gõ tay.

**Bằng chứng:** Header của matrix probe (`:38`) và quit probe (`:31`) chỉ ghi lệnh chạy tay; grep `package.json` không có `probe-project-windows-matrix`/`probe-quit-coordination`. Thiết kế đã ghi nhận điều này là **có chủ ý**: `docs/superpowers/specs/2026-09-27-project-windows-design.md:189-192` — *"they are deliberately not package-script lanes, and an unrun probe proves nothing."*

**Tác động:** `npm test` xanh không nói gì về 36 row matrix hay 22 check quit; receipt trong repo có thể cũ hơn cây code mà không ai biết. Vì thiết kế nói "cố ý", đây là lỗ hổng gate chứ không phải bug cài đặt — nhưng người đọc receipt phải biết.

**Sửa tối thiểu:** Hoặc thêm lane `smoke:project-windows` (run-electron wrapper + phase 2 `--verify-orphans` + quit probe) vào TEST_LANES, hoặc gate receipt theo kiểu `plans:check` để buộc receipt phải mới hơn cây.

*Nguồn: ScoutCIWiring (đã đối chiếu trực tiếp; tài liệu thiết kế tự khai báo tính cố ý).*

### I10 — Một test bị skip vĩnh viễn cho một contract RED, con trỏ theo dõi không tồn tại

**Vị trí:** `test/main/dispatch-socket-teardown.test.ts:404-412`.

**Nhận định:** Contract "teardown không được giết những call mà nó không mang" bị skip không điều kiện; tài liệu được dẫn để theo dõi việc mở lại không tồn tại trong repo.

**Bằng chứng:** `it('4. [activate with the proxy fix] a teardown must not destroy calls it did not carry', { skip: 'pending scripts/antifan-omp-mcp.cjs socket-scoped rejection (see antifan-core/dispatch-ws-crash.md P1)' }, ...)` (`:412`); chú thích `:404-410` nói rõ *"this assertion would fail on today's code — which is precisely why it is skipped rather than green-washed."* Grep toàn repo cho `dispatch-ws-crash`: chỉ có chính dòng này; không có thư mục `antifan-core/`.

**Đối chiếu (sửa lại payload):** Payload nói "fix không có trong cây" là chưa chính xác — `scripts/antifan-omp-mcp.cjs` **có** trong cây; cái chưa có là bản fix. Xác nhận bằng code: `ws.once('close', (code, reason) => { ... for (const [, entry] of pendingDispatchCalls.entries()) { clearTimeout(entry.timer); entry.reject(transportError('CONNECTION_CLOSED', ...)); } pendingDispatchCalls.clear(); })` (`scripts/antifan-omp-mcp.cjs:1497-1507`) — mọi call đang bay đều chết theo socket đóng, đúng trạng thái "every in-flight call dies" mà chú thích test mô tả.

**Tác động:** Không có cổng nào nhắc rằng contract này đang đỏ; con trỏ tài liệu chết nên người sau không có đường tra cứu lý do/điều kiện mở lại.

**Sửa tối thiểu:** Land hunk socket-scoped rejection (chỉ từ chối call của chính socket đã chết) và bỏ `skip` trong cùng thay đổi; nếu chưa làm được thì thay con trỏ chết bằng một tham chiếu tồn tại trong repo.

*Nguồn: ScoutCIWiring (đã đối chiếu + chỉnh lại bằng chứng trực tiếp).*

### I11 — Contract pairing bị gate sau biến môi trường mà không lane nào đặt

**Vị trí:** `test/main/bridge-pairing-queue-concurrency.test.ts:224-239`.

**Nhận định:** Suite RED được skip mặc định; biến `ANTIFAN_PAIRING_CONTRACT` không được set ở bất kỳ script/lane/workflow nào, và tài liệu được dẫn không tồn tại.

**Bằng chứng:** `const CONTRACT_GATE = process.env.ANTIFAN_PAIRING_CONTRACT === '1' ? false : 'RED until the bridge-side refill patch lands; run with ANTIFAN_PAIRING_CONTRACT=1 to enforce';` (`:234-237`) và `describe('pairing queue serves a concurrent burst inside the client budget', { skip: CONTRACT_GATE }, ...)` (`:239`). Grep toàn repo cho `ANTIFAN_PAIRING_CONTRACT`: chỉ có file này. Tài liệu dẫn `antifan-core/pairing-autoheal-hardening.md` (`:225`) không tồn tại (không có thư mục `antifan-core/`). File tái hiện `scratch/pairing-concurrency-probe.cjs` **có** trong cây (`:231-232` dẫn đúng).

**Tác động:** Contract "queue phục vụ burst đồng thời trong ngân sách client" tiếp tục đỏ một cách im lặng; không có bằng chứng nào trong lane mặc định cho biết điều đó.

**Sửa tối thiểu:** Áp hunk refill phía bridge rồi xoá gate (chú thích của chính test đã nói vậy), hoặc ghi lại con trỏ tồn tại và thêm một lane opt-in thực sự chạy nó.

*Nguồn: ScoutCIWiring (đã đối chiếu trực tiếp).*

### I12 — Test build-report tự skip khi thiếu fixture: contract không được kiểm đúng ở nơi cần nhất

**Vị trí:** `test/unit/build-report-bundle-ordering.test.mjs:40`, `test/unit/build-report-embedded-drift.test.mjs:17`, `test/unit/build-report-next-action.test.mjs:14`, `test/unit/core-health-service.test.ts:435`.

**Nhận định:** Bốn điểm skip trả về sớm khi thiếu bằng chứng replay (`test/fixtures/canary-run`) hoặc nguồn `packages/super-core`.

**Bằng chứng:** `t.skip(assessment.reason); return false;` (bundle-ordering `:40-41`), `t.skip(replay.reason); return;` (embedded-drift `:17-18`), `t.skip(replay.reason); return false;` (next-action `:14-15`), `t.skip('super-core source ${f} is absent from this checkout'); ... return;` (core-health-service `:435-437`).

**Tác động:** Trên checkout thiếu các điều kiện đó, thứ tự report/embedded drift/next-action không được verify nhưng lane vẫn "xanh với vài skip" — đúng chỗ dễ hiểu nhầm nhất (build report là bề mặt đọc trạng thái build).

**Sửa tối thiểu:** Commit fixture replay tối thiểu để lane luôn chạy assert, hoặc fail loudly như `core-health-service.ts:449-452` làm với build hỏng.

*Nguồn: ScoutCIWiring (đã đối chiếu trực tiếp).*

### I13 — Lane daemon probe (`test:probes`) nằm ngoài mọi lane mặc định

**Vị trí:** `scripts/run-test-pipeline.mjs:44-46` (chú thích opt-in), `package.json:48` (`"test:probes": "node scripts/run-daemon-probes.mjs"`), `scripts/run-daemon-probes.mjs:34-40`.

**Nhận định:** Các probe RPC/persistence nặng nhất của terminal-daemon — hệ thống đang được siết theo cửa sổ — không chạy trong `npm test`.

**Bằng chứng:** `scripts/run-test-pipeline.mjs:44-46`: `// 'test:probes' stays opt-in: it stages a daemon bundle and spawns detached hosts, which is heavier than every other lane...`; `package.json:48` trỏ tới `scripts/run-daemon-probes.mjs`, nơi gom `probe-daemon-reattach`, `probe-staged-host-rpc`, `probe-terminal-host-survival`, `probe-rpc-surface-coverage`, `probe-persist-cost`. Lane này nằm trong `KNOWN_LANES` nhưng không trong `TEST_LANES` (`:23-43`, `:47-55`).

**Tác động:** Regression của daemon (đường ống mà các row per-window phụ thuộc) vô hình với lane mặc định; người đọc "test xanh" có thể tin terminal-daemon đã được phủ.

**Sửa tối thiểu:** Đưa `test:probes` vào TEST_LANES (wrapper đã pin `ANTIFAN_DATA_ROOT` dùng-một-lần theo payload `run-daemon-probes.mjs:48-58`), hoặc ít nhất nối `probe-rpc-surface-coverage` vào `test:main`.

*Nguồn: ScoutCIWiring (đã đối chiếu trực tiếp).*

---

## MINOR

### M1 — "Audit script tag chết/trùng" chỉ assert `>= 1`

**Vị trí:** `test/main/ipc-audit.test.ts:87-98`. **Bằng chứng:** `it('scans renderer HTML templates for dead or duplicate script tags', ...)` với `assert.ok(externalScriptTags.length >= 1, ...)` (`:97`). **Tác động:** tag trùng (`length === 2`) và tag trỏ file đã xoá đều PASS; chỉ đỏ khi file mất hết script. **Sửa:** assert tính duy nhất của `src` và sự tồn tại của file đích, hoặc đổi tên test cho đúng điều nó kiểm. *Nguồn: ScoutUnitMain (đối chiếu trực tiếp).*

### M2 — Audit listener trùng chỉ chặn `> 1`, không chặn `0`

**Vị trí:** `test/main/ipc-audit.test.ts:126-151`. **Bằng chứng:** `assert.ok(matches.length <= 1, \`Button variable ${btn} has duplicate addEventListener bindings (${matches.length}) in toolbar.ts\`)` (`:148-151`). **Tác động:** xoá hẳn listener của một nút (nút chết) vẫn PASS. **Sửa:** đổi thành `matches.length === 1`, hoặc drive DOM thật để bấm nút. *Nguồn: ScoutUnitMain (đối chiếu trực tiếp).*

### M3 — Kiểm "có handler IPC" bằng `content.includes('channel: ...')` trên văn bản nguồn

**Vị trí:** `test/main/ipc-audit.test.ts:50-55`, `:65-69`, `:80-84`, `:429-433`. **Bằng chứng:** `content.includes(\`channel: ${channel}\`) || content.includes(\`ipcMain.handle(${channel}\`)` (`:52`, `:66`, `:81`); và `nativeTabHost.includes(\`channel: '${ch}'\`) || nativeTabHost.includes(\`ipcMain.handle('${ch}'\`) || nativeTabHost.includes(\`ipcMain.on('${ch}'\`)` (`:430-431`). **Tác động:** chuỗi trong comment/dead code vẫn thoả; một route khai báo qua bảng `CHROME_ROUTES` với khoảng trắng khác vẫn có thể đỏ dù đã đăng ký. Đã có bản audit thật trên bảng route ở `test/main/chrome-ipc-routes.test.ts`. **Sửa:** bỏ các kiểm trùng này hoặc chuyển sang duyệt bảng `CHROME_ROUTES`. *Nguồn: ScoutUnitMain (đối chiếu trực tiếp).*

### M4 — File re-export trùng khiến một suite chạy hai lần mỗi pipeline

**Vị trí:** `test/unit/browser/render-surface-and-viewport-gates.test.ts:1`. **Bằng chứng:** toàn bộ nội dung file là `import '../../main/render-surface-and-viewport-gates.test';`, trong khi bản gốc `test/main/render-surface-and-viewport-gates.test.ts` được lane `test:main` chạy trực tiếp (`package.json:45`) và bản shim được lane `test:unit` chạy (`package.json:44`). **Tác động:** toàn bộ suite 535 dòng (scope `listTabs`, quota, capture transaction) chạy hai lần mỗi lần gọi hai lane này, không thêm phủ, và một lỗi hiện ở hai lane. **Sửa:** xoá shim hoặc xoá bản gốc, giữ đúng một chỗ. *Nguồn: ScoutUnitMain (đối chiếu trực tiếp).*

### M5 — `chrome-ipc-routes`: bỏ qua file không tồn tại và khớp định danh bằng `includes` thô

**Vị trí:** `test/main/chrome-ipc-routes.test.ts:116`, `:122`. **Bằng chứng:** `if (!fs.existsSync(fullPath)) continue;` (`:116`) và `const hasIdent = idents.some((id) => fileContent.includes(id));` (`:122`). **Tác động:** xoá/đổi tên một renderer/preload (ví dụ `tab-preload.ts`) sẽ thu nhỏ bề mặt được audit mà không đỏ; tên hằng xuất hiện trong comment/type annotation cũng đủ thoả "renderer caller được phép". **Sửa:** assert `existsSync` và neo khớp vào call site `ipcRenderer.send(...)`/`api.<method>`. *Nguồn: ScoutUnitMain (đối chiếu trực tiếp; dòng scout ghi 85-88, thực tế 116/122).*

### M6 — `native-popup-inheritance` chỉ phủ một giá trị `disposition` và không phủ nhánh `isDisposed`

**Vị trí:** `test/main/native-popup-inheritance.test.ts:172`, `:199`, `:214`. **Bằng chứng:** cả ba `it(...)` đều gọi `harness.windowOpenHandler()({ url: 'https://example.com/native-popup', disposition: 'new-window' })`; không có row nào dùng `'background-tab'`/`'save-to-disk'` hay dựng `host.isDisposed = true` trước lượt `setImmediate`. **Tác động:** nếu production sau này truyền `disposition` vào `onNewTabRequested` hoặc guard `isDisposed` hồi quy, suite này không thấy. **Sửa:** thêm hai row tương ứng, assert `activate` và `created` rỗng. *Nguồn: ScoutUnitMain (đối chiếu trực tiếp; dòng scout ghi 172-210).*

### M7 — "Đóng băng" receipt cho judge quá hạn chỉ sâu một tầng

**Vị trí:** `scripts/probe-project-windows-matrix.cjs:736`. **Bằng chứng:** `const recorded = budgetExpired ? { ...row, observed: { ...row.observed }, ids: { ...row.ids } } : row;` — các object lồng bên trong `observed`/`ids` vẫn là tham chiếu sống. **Tác động:** judge zombie vẫn có thể ghi `row.observed.<nhánh>.x = ...` sau mốc đóng băng, tức bảo vệ chỉ có tác dụng ở tầng ngoài cùng. **Sửa:** deep clone (`structuredClone`) khi `budgetExpired`. *Nguồn: ScoutE2EProbe (đối chiếu trực tiếp).*

### M8 — Cửa sổ phủ định của marker (1.5 s) không neo vào thời gian giao hàng thực tế

**Vị trí:** `scripts/probe-project-windows-matrix.cjs:1884`, `:1901`, `:1910`. **Bằng chứng:** `const sawMarker = async (sessionId, marker, ms = 8000) => ...` (`:1833`); các lần đọc "không bao giờ tới" dùng `sawMarker(sessionB, markerOwn, 1500)` (`:1884`), `sawMarker(sessionB, markerAfterSwitch, 1500)` (`:1901`), `sawMarker(sessionB, markerCross, 1500)` (`:1910`). **Tác động:** một rò rỉ xuyên cửa sổ tới muộn hơn 1.5 s (echo PTY, độ trễ proxy daemon) bị tuyên bố "không tới" — khẳng định phủ định có thể xanh dù marker tới ngay sau khi cửa sổ đọc đóng. **Sửa:** neo cửa sổ phủ định vào thời gian giao hàng dương đã quan sát (hoặc dùng trọn 8 s). *Nguồn: ScoutE2EProbe (đối chiếu trực tiếp; dòng scout ghi 1910).*

### M9 — `journalEvents()` biến "không đọc được journal" thành "không có sự kiện"

**Vị trí:** `scripts/probe-quit-coordination.cjs:335-348`. **Bằng chứng:** `} catch (err) { return []; }` (`:348`), trong khi các khẳng định phủ định dựa trên danh sách rỗng này: `expect(!auxJournal.some((entry) => entry.event === 'shutdown.begin'), ...)` (`:1027`), `expect(!events.includes('shutdown.forceExit'), ...)` (`:1281`), `expect(!events.some((event) => String(event).startsWith('shutdown.step.failed')), ...)` (`:1282`). **Tác động:** nửa "không teardown nào chạy" của row veto và "không có gì cưỡng chế exit" thoả mãn bằng một file log không đọc được. **Sửa:** trả `null` khi đọc lỗi và bắt buộc khác `null` ở nơi dùng, hoặc ghi `journalReadError` vào `observed`. *Nguồn: ScoutE2EProbe (đối chiếu trực tiếp).*

### M10 — `probe-two-shell-ipc` bỏ ba row route mà receipt không ghi gì

**Vị trí:** `scripts/probe-two-shell-ipc.cjs:179-181`; `:40-46`. **Bằng chứng:** `} else { console.log('  SKIP  route-dependent checks (route table unavailable)'); }` (`:180`) — không có entry nào trong `checks`; thêm nữa `function check(name, fn) { try { fn(); ...` (`:40-43`) là đồng bộ, `fn()` không được `await`. **Tác động:** khi bảng route rỗng/không có, probe báo "passed N/N" trên tập row đã bị thu nhỏ — probe dựa vào route đã biến mất khỏi bằng chứng. **Sửa:** phát row skipped vào `checks` (hoặc fail loudly); nếu cần async thì `await fn()`. *Nguồn: ScoutE2EProbe (đối chiếu trực tiếp).*

### M11 — `probe-daemon-reattach` coi mọi lỗi kết nối là "token bị từ chối"

**Vị trí:** `scripts/probe-daemon-reattach.cjs:159-167` (và dạng tương tự `:257-266`, `probe-staged-host-rpc.cjs:206-208`). **Bằng chứng:** `try { await badProxy.connect(); } catch { tokenRejected = true; }` (`:161-163`) rồi `record('invalid token rejected by host (token mismatch rejection)', tokenRejected);`. **Tác động:** host không tới được, timeout hay lỗi transport đều cho PASS cho khẳng định "token sai bị từ chối"; ở pha 2 row này còn đứng độc lập nên trông như một sự thật đã kiểm. **Sửa:** bắt error và assert đúng lớp lỗi xác thực (auth/handshake, 401/403), fail với timeout/ECONNREFUSED. *Nguồn: ScoutE2EProbe (đối chiếu trực tiếp).*

### M12 — `userAgentMode` của popup chỉ so cha-với-con, không ghim giá trị kỳ vọng

**Vị trí:** `test/e2e/project-windows.test.ts:892-895`. **Bằng chứng:** `expect(child.tab.userAgentMode === parentTab.userAgentMode, 'the popup user agent mode was ' + String(...) + ' while its parent was ' + String(...));` — trong khi `capsuleId` được ghim vào hằng ALPHA/BETA và `partition` ghim `/^persist:/`. **Tác động:** nếu trường không bao giờ được điền, `undefined === undefined` vẫn xanh — khẳng định "popup thừa hưởng UA của cha" có thể PASS với trường trống ở cả hai phía. **Sửa:** assert `typeof parentTab.userAgentMode === 'string'` (hoặc bằng hằng mode đã biết) trước khi so. *Nguồn: ScoutE2EProbe (đối chiếu trực tiếp).*

### M13 — Fixture preload mô hình hoá contract `invoke` mà sản phẩm không có

**Vị trí:** `test/e2e/e2e-combined-preload.js:12`. **Bằng chứng:** `sendTerminalInputTo: (id, input) => ipcRenderer.invoke('antifan:terminal:input-session', { id, input })` — trong khi bản ship là `ipcRenderer.send(...)` (`src/preload/standalone-preload.ts:39`) và route đăng ký `kind: 'on'` (`src/main/browser/native-tab-host.ts:2532-2533`), tức không có handler `invoke` cho kênh này. **Tác động:** smoke tương lai gọi nó sẽ hoặc đỏ giả, hoặc bị "sửa" bằng cách đăng ký một handler mà app thật không có — kiểm một contract bịa. Hiện đang ngủ (không smoke nào gọi). **Sửa:** đổi fixture sang `ipcRenderer.send` (fire-and-forget), hoặc xoá method. *Nguồn: ScoutE2EProbe (đối chiếu trực tiếp).*

### M14 — Row BLOCKED vì lý do khác phần cứng nằm lẫn trong một danh sách

**Vị trí:** `scripts/probe-project-windows-matrix.cjs:2645-2647`, `:2772-2774`, `:3671-3673`, `:3743-3746`; `test/e2e/project-windows.test.ts:88-97` (`DEFERRED_ROWS`). **Bằng chứng:** `row.reason = \`this build root (${compiledRoot}) ships no renderer bundle ...\`` (`:2646`, và `:2773`), `no staged daemon bundle exists at ...` (`:3672`), `the teardown never committed (will-quit settled '${...}')` (`:3745`); phía e2e: `const DEFERRED_ROWS: readonly string[] = ['physical.two-monitor-surfaces', ... 'native.unload-veto-and-close-races', ...]` (`:88-97`). **Tác động:** đây là các row **đúng đắn là không PASS**, nhưng một receipt "0 FAIL / 3 BLOCKED" có thể gộp "không có màn hình thứ hai" với "quên `npm run compile`" và "bị cascade từ row khác". **Sửa:** phân nhóm/lọc được lý do BLOCKED (hardware / thiếu artifact / cascade) trong receipt. *Nguồn: ScoutE2EProbe (đối chiếu trực tiếp; dòng scout ghi 2644-2648 và DEFERRED_ROWS 75-82, thực tế 88-97).*

### M15 — Skip canary theo PID reuse là trung thực nhưng để lại phủ trống

**Vị trí:** `test/unit/canary/canary-evidence-provenance.test.mjs:369`. **Bằng chứng:** `t.skip(\`pid ${deadPid} is not observable as absent on this host (${proof.reason}); the OS reused it\`); return;` (`:369-370`). **Tác động:** lý do là thật (không thể assert ngữ nghĩa PID khi OS tái dùng); trên host rơi vào nhánh này, kiểm provenance không chạy. **Sửa:** không bắt buộc; có thể chọn dải PID chắc chắn đã chết. *Nguồn: ScoutCIWiring (đối chiếu trực tiếp).*

### M16 — Nhóm skip theo nền tảng/quyền (Windows-only, junction/symlink)

**Vị trí:** `test/main/windows-acl-timeout-guard.test.ts:27,57,82,107,137`; `test/main/windows-acl.test.ts:249`; `test/main/control-plane-contracts.test.ts:59`; `test/main/workspace-file-port.test.ts:124,148`. **Bằng chứng:** `t.skip('Windows only')` ×5; `t.skip('Skipping live Windows DACL enforcement test on non-Windows platform (deferred to Phase 6)')`; `t.skip(\`host cannot create symlinks/junctions (${code}); reparse-traversal check not exercised\`)`; `t.skip(\`host cannot create junctions (${code}); ...\`)` ×2. **Tác động:** trên host non-Windows hoặc bị hạn chế quyền, các khẳng định ACL/junction không bao giờ chạy. **Sửa:** giữ nguyên; chỉ cần biết để không đọc số "skip" thành phủ. *Nguồn: ScoutCIWiring (đối chiếu trực tiếp).*

### M17 — `CHANGELOG` ghi "1 skip có sẵn" trong khi cây hiện có hai điểm skip mặc định ở lane main

**Vị trí:** `CHANGELOG.md:39`. **Bằng chứng:** `npm run test:main trên cây này **1785 test / 1784 pass / 0 fail** (1 skip có sẵn)` — trong khi lane main hiện có hai điểm skip mặc định: `describe(..., { skip: CONTRACT_GATE }, ...)` (`test/main/bridge-pairing-queue-concurrency.test.ts:239`) và `it(..., { skip: 'pending ...' })` (`test/main/dispatch-socket-teardown.test.ts:412`). **Tác động:** con số "1 skip" nhiều khả năng cũ hơn cây hiện tại (hoặc đo trên cây khác); báo cáo sau này trích lại sẽ mô tả sai độ phủ. Đây là bản ghi có tính lịch sử, không phải authority thường trực. **Sửa:** chạy lại `test:main` và cập nhật số skip, hoặc chú thích dòng đó là số tại thời điểm ghi. *Nguồn: ScoutCIWiring (đối chiếu trực tiếp; dòng scout ghi 30, thực tế 39).*

### M18 — Ba probe là file untracked, chỉ chạy tay

**Vị trí:** `scripts/probe-project-windows.cjs:20`, `scripts/probe-background-full-page.cjs:49`, `scripts/probe-headless-full-page.cjs`. **Bằng chứng:** `git status --short` liệt kê cả ba là `??` (untracked); `scripts/probe-project-windows.cjs` được dẫn trong chú thích nguồn tại `src/main/index.ts:1764` và `:2778` — *"Exported for the live probe (`scripts/probe-project-windows.cjs`)"* — nhưng không được tham chiếu bởi lệnh nào tự chạy được; dòng chạy là `node scripts/run-electron.cjs ...` thủ công. **Tác động:** các dụng cụ được nêu tên trong bằng chứng nghiệm thu nhưng chưa được commit/lane-hoá, nên "đã chạy" phụ thuộc vào máy của người chạy. **Sửa:** commit + nối lane cho probe còn giá trị, xoá các probe mồ côi. *Nguồn: ScoutCIWiring (đối chiếu trực tiếp).*

### M19 — `test/e2e/test-preload.js` không được tham chiếu ở đâu

**Vị trí:** `test/e2e/test-preload.js`. **Bằng chứng:** file tồn tại (416 B) nhưng grep `test-preload` trên toàn repo không có kết quả nào; các preload của e2e dùng `./e2e-combined-preload.js`. **Tác động:** code chết trong cây test; dễ bị nhầm là preload đang dùng. **Sửa:** xoá hoặc ghi rõ người dùng của nó. *Nguồn: ScoutCIWiring (đối chiếu trực tiếp).*

---

## Đã kiểm tra và thấy vững (verified sound)

- `scripts/probe-terminal-host-survival.cjs` — verdict dựa trên giá trị sống (ticks tăng, so pid, hiệu ứng marker file); không có assert bị nuốt. Payload ScoutE2EProbe kết luận **CLEAN**.
- `scripts/probe-project-windows.cjs` — `check()` await `fn` và ghi lỗi; `waitForApi` catch→`false` chỉ kết thúc vòng poll, không quyết định PASS. Payload ScoutE2EProbe kết luận **CLEAN** (kèm nit: không có hạn cho từng row, treo là treo thật — đã ghi ở I4 theo hướng ngược lại cho driver e2e).
- `scripts/probe-project-windows-matrix.cjs:724-725` — PASS bị chặn khi `observed` rỗng: `expect(Object.keys(row.observed || {}).length > 0, \`row ${id} recorded no observation, so it cannot be reported as a pass\`)`.
- `scripts/probe-project-windows-matrix.cjs:730-744` — fail-stop khi judge vượt ngân sách, kèm lý do rõ (*"the rows behind this one would read windows an abandoned judge is still driving"*): đây là mẫu mà driver e2e còn thiếu (I4).
- `scripts/probe-project-windows-matrix.cjs:3826-3862` — poll phía host coi "OS không trả lời" là UNKNOWN, chỉ "absent" mới kết thúc chờ; nhánh non-win32 ghi `supported: false` thay vì tuyên bố sạch.
- `scripts/probe-project-windows-matrix.cjs:212-235` — R9E chuyển BLOCKED khi không có report/không quan sát được, xoá `error` cũ để receipt không tự mâu thuẫn.
- `test/e2e/project-windows.test.ts:1713-1724` — suite cha kiểm mọi row mong đợi đều được báo, row PASS lạ bị từ chối, và mọi row phải `ok === true`; `deferred` phải khớp `DEFERRED_ROWS` (`:1725`).
- `src/preload/standalone-preload.ts:39` + `src/main/browser/native-tab-host.ts:2532-2533` — kênh `antifan:terminal:input-session` đúng là `send` + `kind: 'on'` (dùng để xác nhận I1/M13, và xác nhận fixture `e2e-combined-preload.js` lệch contract).
- Các hạ tầng thay thế cho những chỗ bị ghim văn bản nguồn tồn tại thật: `test/support/chrome-route-harness.ts`, `test/main/terminal-sleep-affinity-host.test.ts`, `test/unit/browser/terminal-alt-screen-scan.test.ts`, `test/main/project-window-persistence.test.ts`.
- `.coderabbit.yaml` chỉ là cấu hình bot review (path_filters/path_instructions), không có lệnh test — dùng để xác nhận C2.

## Ghi chú phạm vi (chưa bao phủ)

- **Không chạy gì:** không build, không test, không lint, không chạy harness Electron (theo yêu cầu review read-only). Mọi kết luận về hành vi là đọc mã + đối chiếu chéo payload.
- **Không bao phủ:** phần lớn `src/**` (logic sản phẩm) — báo cáo này chỉ soi độ trung thực của kiểm chứng (test/unit/main, e2e + probe, pipeline/CI) như ba payload đã làm.
- **Không bao phủ:** `plans/**` và `plans/reports/**` như code (theo packet: churn artefact bằng chứng), `packages/site-clone`, `packages/super-core` (chỉ được nhắc qua các điểm skip ở I12).
- **Không xác minh lại:** con số "1820 passed / 0 failed" của `test:main` và mốc thời gian receipt matrix trong packet — được dùng như dữ kiện đã biết, không chạy lại.
- **Không bao phủ:** các suite chưa được payload nào quét (ví dụ `test/integration/**`, `test/renderer/**`); kết luận "vững" ở trên chỉ áp dụng cho các file được nêu tên.
- **Hai payload là "CLEAN"** (`probe-terminal-host-survival.cjs`, `probe-project-windows.cjs`) được ghi lại nguyên trạng, không kiểm lại từng dòng.

## Bổ sung khi đối chiếu

1. **Một phần số dòng trong payload lệch** (nội dung đúng, vị trí sai); báo cáo này dùng số đã kiểm:
   - alt-screen: payload 119-124 → thực tế `test/unit/browser/terminal-transcript-lifecycle.test.ts:114-124` (helper ở `:115-116`).
   - provenance test 5: payload 305-332 → thực tế khối `:241-325` (đoạn cài đặt lại ở `:294-296`).
   - `daemon-entry.ts`: payload 285-289 → thực tế `:284-289`.
   - `chrome-ipc-routes`: payload 85-88 → thực tế `:116` và `:122`.
   - `CHANGELOG`: payload :30 → thực tế `:39`.
   - `DEFERRED_ROWS`: payload 75-82 → thực tế `:88-97`.
   - Merge R9E: payload 224-226/227 → thực tế `:195-196` (`observationAvailable`) và `:202` (`ok`).
   - `probe-daemon-reattach`: payload 159-167 → thực tế `:161-163`.
2. **Payload CI nói "fix không có trong cây" là chưa đúng** ở chỗ `scripts/antifan-omp-mcp.cjs` tồn tại; cái thiếu là hunk socket-scoped rejection (bằng chứng: `:1497-1507` từ chối và xoá **mọi** call đang bay khi socket đóng) và tài liệu `antifan-core/dispatch-ws-crash.md` không tồn tại. Đã sửa lại trong I10.
3. **Mở rộng của M4 (kiểm trực tiếp, ngoài payload):** shim `test/unit/browser/render-surface-and-viewport-gates.test.ts` còn được lane `test:fast` chạy (`package.json:40` cũng glob `.compiled/test/unit/**/*.test.js`), nên trong một lần `npm test` suite render-surface chạy **hai** lần (test:fast qua shim + test:main qua bản gốc), và lần thứ ba nếu chạy tay `npm run test:unit`. Đây là cùng một khiếm khuyết với M4, chỉ mở rộng phạm vi thực thi.
4. **[INFERENCE]** Không có mục nào ở trên suy diễn về hành vi sản phẩm khi chưa đọc mã; các nhận định "có thể xanh dù hỏng" đều dựa trên chính cấu trúc assert đã trích, không dựa trên việc chạy lại suite.
