# IMMUTABLE EVIDENCE PACKET — ak:test Full E2E failure triage
Repo: E:/Work/apps/AntiFan. Command: npm test (scripts/run-test-pipeline.mjs, all default lanes).
Env: live AntiFan Electron app RUNNING (bridge pid 10696); single-instance DEV lock observed in logs; pipeline runs lanes sequentially.
Result: 14 lanes passed; 5 failed: audit, test:fast, test:main, test:e2e:strict, smoke:site-mute. Re-run of each failed lane reproduced every failure (logs: plans/reports/test-e2e-ultra/*.log).

## Lane: audit (node scripts/check-bottlenecks.mjs, exit 1)
Register bookkeeping, not code-under-test:
- ERROR REOPENED B28: 'test/main/omp-mcp-adapter.test.ts !~ /dispatches anti\.browser\.tabs\.list under its own name/' — marked closed but predicate still fires.
- ERROR FIXED_UNRECORDED B43: dispatch-socket teardown defect absent at HEAD; register must flip to closed.
- WARNs: B21/B34–B37 STALE (newer plan landed).

## Lane: smoke:site-mute (exit 1)
test/e2e/site-mute-smoke.cjs:302 — saved.mutedSites lacks '127.0.0.1' even though isAudioMuted()==true held at :284,:292,:297. A 'Persisted tabs sync' entry preceded the read, so the file WAS written. Suspect: mutedSites not projected/serialized, or persist raced.
c to: C:\Users\Admin\AppData\Local\Temp\antifan-site-mute-smoke-QRM1zs\saved-tabs.json
[SMOKE-MUTE] Fatal error: AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:

false !== true

    at runMainPhase (E:\Work\apps\AntiFan\test\e2e\site-mute-smoke.cjs:302:12)
    at async E:\Work\apps\AntiFan\test\e2e\site-mute-smoke.cjs:331:8 {
  generatedMessage: true,
  code: 'ERR_ASSERTION',
  actual: false,
  expected: true,
  operator: 'strictEqual',
  diff: 'simple'
}


## Lane: test:fast (1796/1797 pass; 1 suite fails)
CoreHealthService CLI deadline handling:
)
[IssueRegister] Loaded 1001 verification record(s).
▶ CoreHealthService CLI deadline handling
  ✖ cli() settles on deadline when grandchild holds pipes open, and second call on same key also settles (4143.6813ms)
  ✖ getSnapshot() public surface maps timed out CLI to UNAVAILABLE without hanging on grandchild (2586.7318ms)
✖ CoreHealthService CLI deadline handling (6733.3812ms)
(node:29228) Warning: The 'NO_COLOR' env is ignored due to the 'FORCE_COLOR' env being set.
(Use `node --trace-warnings ...` to show where the warning was created)
▶ CoreHealthService snapshot mapping
  ✔ all gates pass → HEALTHY with reasonCode, no percentage (38.4828ms)
  ✔ seeded degraded scenario (pending candidates) → DEGRADED + PENDING_CANDIDATES (1.7647ms)
  ✔ open P0 issue → DEGRADED + OPEN_HIGH_SEVERITY_ISSUES (1.5759ms)
  ✔ empty store → coverage reports UNKNOWN/EMPTY_STORE not a fake pass (4.9521ms)
  ✔ no regression run → UNKNOWN/NO_REGRESSION_RUN, not DEGRADED (1.6061ms)
  ✔ CLI failure → UNAVAILABLE + CORE_UNAVAILABLE (1.3997ms)
✔ CoreHealthService snapshot mapping (52.8535ms)
▶ CoreHealthService phase-9 surfaces
  ✔ two failed gates at the decisive severity are both named in reasonCode (2.1888ms)
  ✔ corpus-wide UNKNOWN uncertainty is reported but never caps the panel (2.49ms)
  ✔ usage line reads the dispatch aggregate: stats carry the count, check never gates (2.0094ms)
  ✔ unmeasured dispatch reports UNKNOWN without touching the count or the status (1.4547ms)
  ✔ connected is surface
Sibling suite 'real CLI path' passed with real spawn (3.5s/11.1s) → suggests spawn/execFile deadline-vs-grandchild-pipe handling under load or a real bug in CLI timeout settle.

## Lane: test:main (2346/2353; 7 fails)
failing tests:

test at .compiled\test\main\history-manager.test.js:230:24
✖ debounces a subsequent mutation after persistSync instead of flushing immediately (1011.7308ms)
  AssertionError [ERR_ASSERTION]: file mtime must update after quiet window elapses
      at TestContext.<anonymous> (E:\Work\apps\AntiFan\.compiled\test\main\history-manager.test.js:255:20)
      at async Test.run (node:internal/test_runner/test:1113:7)
      at async Suite.processPendingSubtests (node:internal/test_runner/test:788:7) {
    generatedMessage: false,
    code: 'ERR_ASSERTION',
    actual: 1791241307816.6833,
    expected: 1791241307816.6833,
    operator: 'notStrictEqual',
    diff: 'simple'
  }

test at .compiled\test\main\pairing-grant-authority.test.js:355:24
✖ scripts/antifan-agent.cjs declares requestedGrant and the bridge mints the eval attachment it asked for (33738.6709ms)
  Error: PAIRING_UNAVAILABLE after 4 attempts against 127.0.0.1:50939: PAIRING_TIMEOUT: Pairing request timeout after 8000ms (/api/pairing/challenge)
      at Object.performPairingExchange (E:\Work\apps\AntiFan\scripts\antifan-agent.cjs:375:17)
      at process.processTicksAndRejections (node:internal/process/task_queues:103:5)
      at async E:\Work\apps\AntiFan\.compiled\test\main\pairing-grant-authority.test.js:362:34
      at async withIsolatedRoots (E:\Work\apps\AntiFan\.compiled\test\main\pairing-grant-authority.test.js:148:9)
      at async TestContext.<anonymous> (E:\Work\apps\AntiFan\.compiled\test\main\pairing-grant-authority.test.js:356:9)
      at async Test.run (node:internal/test_runner/test:1113:7

## Lane: test:e2e:strict (8/10; 2 fails)
failing tests:

test at .compiled\test\e2e\terminal-capsule-assign.test.js:1026:24
✖ moves a session between project scopes through the real assign IPC, and refuses a window-less caller (39899.2673ms)
  Error: the capsule-assign scenario must exit cleanly
  stdout:
  [run-electron] eval flag: --allow-eval (source: dev-default (non-production start)); ANTIFAN_ALLOW_EVAL=<unset>; electron args: C:\Users\Admin\AppData\Local\Temp\antifan-tca-e2e-driver-0wBM5M\terminal-capsule-assign-driver.cjs --allow-eval
  
    FAIL  terminal.web-hub-and-manager-hold-project-scopes: the startup title was Project-project-00000000-0000-4000-8000-0000000000a1
  [native-tab-host] Persisted tabs async to: C:\Users\Admin\AppData\Local\Temp\antifan-tca-e2e-f3Yhvk\Profile\saved-tabs.json
  [native-tab-host] Persisted tabs async to: C:\Users\Admin\AppData\Local\Temp\antifan-tca-e2e-f3Yhvk\Profile\saved-tabs.json
  [antifan] Native Messaging Local IPC Server listening at \\.\pipe\antifan-bridge-ipc-a6c9079c-1d71-454c-a66c-4468cb705162
  [antifan] Persisted non-secret bridge info to C:\Users\Admin\AppData\Local\Temp\antifan-tca-e2e-f3Yhvk\config\bridge-dev.json
    FAIL  terminal.manager-window-lists-every-project-scope: timed out after 30000ms waiting for the manager window to list both projects sessions (last observed: false)
    FAIL  terminal.manager-assigns-session-through-ipc: Cannot read properties of null (reading 'executeJavaScript')
    FAIL  terminal.assignment-moves-session-stamp: Cannot read properties of null (reading 'executeJavaScript')
  [native-tab-host] Persisted tabs sync to: C:\Users\Admin\AppData\Local\Temp\antifan-tca-e2e-f3Yhvk\Profile\saved-tabs.json
    FAIL  terminal.assign-refuses-when-manager-window-absent: Cannot read properties of null (reading 'executeJavaScript')
    PASS  terminal.window-less-chrome-caller-refused
    PASS  terminal.window-less-mcp-caller-refused
  [native-tab-host] Persisted tabs sync to: C:\Users\Admin\AppData\Local\Temp\antifan-tca-e2e-f3Yhvk\Profile\saved-tabs.json
  [native-tab-host] Persisted tabs sync to: C:\Users\Admin\AppData\Local\Temp\antifan-tca-e2e-f3Yhvk\Profile\saved-tabs.json
    PASS  terminal.cleanup-closes-every-shell
    

## Logs dir: plans/reports/test-e2e-ultra/{audit,site-mute,test-fast,test-main,test-e2e}.log
## Task: classify each failure = PRODUCT_BUG | TEST_DEFECT | ENV_FLAKE(load/lock/live-app) | REGISTER_DRIFT. Cite evidence; propose the minimal correct fix owner (test vs source vs register).
