---
title: "terminal-daemon-and-throughput"
description: "Lock the terminal-daemon design: a detached headless host that owns PTYs so GUI restarts during dogfooding never kill agent sessions. TerminalManager's import closure is Electron-free (verified), so the daemon reuses it verbatim instead of reimplementing a PTY layer."
status: completed
priority: P0
effort: "1d (P0) + 1d (P1 storage)"
tags: [terminal-daemon, pty-host, dogfooding, windows-conpty, single-writer]
created: 2026-09-19
blockedBy: []
blocks: []
---

# terminal-daemon-and-throughput

## Overview

AntiFan is developed and operated in the same loop. Every iteration that touches main/bridge/renderer
code needs `npm run compile` plus a GUI restart, and today that restart **kills every live terminal
session** — including OMP agent TUIs sitting at a prompt mid-task.

### Goal (the only P0 goal)

> After the user restarts / recompiles the AntiFan GUI, every previously running terminal session is
> still alive with the same shell process, same cwd, same scrollback, and same running child process.

Everything else in this plan is secondary and explicitly sequenced after that.

---

## Decisive finding (verified, not assumed)

`src/main/browser/terminal-manager.ts` — the whole terminal subsystem — has **no dependency on
Electron**. Verified by walking the full transitive import graph with a script this session:

```
files in closure: 8
electron imports: 0   []
unresolved (type-only or external): []
```

Imports are exactly: `node-pty`, `node:fs`, `node:path`, `node:os`, `node:child_process`, `events`,
`node:perf_hooks`, `../benchmark/telemetry`, `../config/storage-locations`,
`../../shared/control-plane-contracts`, `../../shared/contracts`.

**Consequence (DERIVED):** the daemon does not need a new PTY layer, a new persistence engine, or a
new session model. It runs the *existing* `TerminalManager` in a detached headless runtime. The work
is therefore **process lifecycle + transport + client proxy**, not a terminal reimplementation.

### Consequences for the earlier draft of this plan

Three pieces of the first draft were over-built and are now cut or resequenced:

| First-draft item | Verdict | Why |
| :--- | :--- | :--- |
| Custom Named-Pipe framing protocol (`CLIENT_HELLO`, `DATA_CHUNK`, 4-byte length prefix, …) | **CUT** | `bridge-server.ts` already implements a token-authenticated JSON RPC envelope with heartbeat and congestion FIFOs. A second framing convention beside it is prohibited and pointless. |
| Monotonic chunk-seq + ring-buffer catch-up replay | **CUT for P0** | The daemon holds the authoritative transcript (`getFullBuffer` / `composeTranscript`). Re-attach = full rehydrate, exactly what the GUI already does on tab switch. Seq is a redraw-polish item, not a correctness item. |
| Auto-sleep idle sessions | **CUT (P0). See the hazard note below.** | `sleeping` means KILL. Auto-sleeping on idle destroys the exact sessions this plan exists to protect. |

---

## Survival proven before building (verified, live)

`scripts/probe-terminal-host-survival.cjs` runs the whole premise end to end and is the gate for
everything below. It uses a **relay** (a process that spawns the host detached and exits at once), so
"the host is still alive" is an observation about the host, never a self-report.

```
[Terminal Host Survival Probe] host=13380 child=9464 hostAlive=true childAlive=true
  ticks=22->28 heartbeat=0->1789753383661 relayExited=true
PROBE_RESULT {"ok":true,...,"relayDead":true,"hostAlive":true,"childAlive":true,"ticks1":22,"ticks2":28}
```

What this establishes, all measured:

- The compiled `TerminalManager` boots and spawns a PTY under `ELECTRON_RUN_AS_NODE=1` — the
  Electron-free finding holds at runtime, not just in the import graph.
- The host **and its shell child** both outlive the process that spawned them (`relayDead: true`,
  `hostAlive: true`, `childAlive: true`).
- The shell keeps doing work across the window (`ticks 22 → 28`, matching the 400 ms job cadence),
  so liveness is real progress, not an unreaped process.

### New invariant discovered by the probe: input must be gated on the prompt

The first probe run reported a live host with a dead shell. Root cause, then isolated with a direct
`node-pty` matrix (no `TerminalManager` involved):

| Trial | Payload | Delay | Result |
| :--- | :--- | :--- | :--- |
| `A` | `…\r` | 2000 ms | **dropped** |
| `B` | `…\n` | 2000 ms | dropped (never submits) |
| `C` | `…\r\n` | 2000 ms | accepted |
| `D` | `…\r` | 6000 ms | accepted |
| `E` | `…\r` (winpty) | 2000 ms | accepted |

The same write both fails and succeeds at the same nominal delay, so the discriminator is **not time
but whether the shell has started reading stdin**. ConPTY silently discards input written into that
window, and — measured directly — the PowerShell **banner is emitted before the prompt**, so
"any output seen" is not a readiness signal:

```
t=417ms  len=8    t=829ms  len=218  (banner only)   t=4195ms len=278  (prompt present)
```

**Invariant (new, mandatory for the daemon):** never treat PTY creation — or first output — as
"ready to accept input". Gate on the observed prompt. The probe implements this as
`stripAnsi(buffer).slice(-400)` matched against a prompt regex, and publishes a separate `armed.json`
marker only after the shell has echoed the command, so the measurement window can never include the
not-yet-started gap.

[INFERENCE] This also explains a class of "the terminal silently ate my first command" reports; it is
a ConPTY timing property, not an AntiFan bug, and the daemon inherits the same duty.

---

## Hazard: `sleeping` is a kill, not a park

Verified at `src/main/browser/terminal-manager.ts`:

- `sleepSession(id)` (line ~1855) delegates per record to `parkRecord()` (line ~1880).
- `parkRecord()` calls `teardownSessionPty(s)` (line ~1887) → the shell **and its whole process tree
  are released/killed**; the transcript is folded into `restoredTail`.

So `state: 'sleeping'` = *dead shell, retained transcript*. Waking spawns a **new** shell.

**Therefore auto-sleep gated on "no output for N minutes" is a correctness bug, not a tuning knob.**
An OMP agent idling at an input prompt produces no output and would be killed — destroying the P0
goal. Any future auto-sleep must be all of:

1. **Opt-in per session** (never a global default), and
2. gated on `altScreen === false` — an active TUI (agent spinner, editor, pager) owns the alt screen;
   the signal already exists (`Session.altScreen`, set at line ~1383 from `\x1b[?1049`), and
3. gated on an empty process tree for that shell (a background job under a bare prompt is still
   work). `altScreen` alone is not enough — it only covers full-screen TUIs; line-mode foreground
   work (REPLs, `ssh`, `npm run dev` between bursts, an OMP agent waiting silently at a prompt)
   produces no alt-screen signal and no output, so it must be detected by process tree, not by
   output. Probe: `Get-CimInstance Win32_Process -Filter "ParentProcessId=<shellPid>"` via
   `powershell.exe -NoProfile -NonInteractive` — the same fallback `process-registry.ts:124` already
   uses (`wmic` is deprecated/absent on newer Windows 11 builds, so CIM is the durable probe).

Until all three exist, no automatic sleep path ships.

---

## Locked design

### 1. Process topology

```
AntiFan GUI (Electron, BrowserWindow)          <- restarts freely, owns nothing durable
        |  loopback RPC (existing bridge envelope: {id,method,params} / {event,data})
        v
Terminal Host daemon  (process.execPath + ELECTRON_RUN_AS_NODE=1, detached)
        |  owns: TerminalManager, PTYs, transcripts, state files
        v
powershell / bash / OMP agent TUIs             <- survive GUI restarts
```

The daemon must run under **Electron's** Node runtime: `node-pty` is a native addon rebuilt against
Electron's ABI, so a plain system `node` would fail to load it `[DERIVED from electron-rebuild
requirement — confirm at implementation time by loading node-pty in both runtimes]`.

### 2. Staged, versioned host root (why: dogfooding must not deadlock)

The daemon must **never** execute files out of `apps/AntiFan/`. A running host maps the native
addons it loads, and a mapped addon is held write-deny — measured live while a workspace-launched
host ran: `open(path, 'r+')` on the workspace `pty.node` fails `EBUSY` (rename still succeeds, so
delete+recreate survives, but any in-place rewrite — `electron-rebuild`, a patching `npm install` —
fails). Staging into `<dataRoot>/daemon-host/<hash>/` keeps the workspace's own binaries unheld.

**Correction to the earlier draft:** it claimed the hazard was "`npm run compile` fails EBUSY".
Measured: `tsc` writes only `.compiled/` and never touches `node_modules`, so the compile is
unaffected. The real hazard is dependency rewrite of the mapped natives, stated above.

```
E:\Work\apps\AntiFan\                        DEV WORKSPACE - always unlocked
        |  (staged on GUI boot when version hash differs)
        v
E:\Work\.antifan-data\daemon-host\<version-hash>\
        daemon-entry.js  +  node_modules/node-pty/... (conpty.node, OpenConsole.exe)
```

Staging key = hash of the compiled daemon bundle. A changed hash means a **new directory**, so the
old host keeps running while the new one starts; the GUI connects to the new one and rehydrates.

### 3. Start / survive chain (with honest limits)

```
L0  re-attach  read the live-instance record, ping it; reuse if healthy (the common restart path)
      | no live host
      v
L1  spawn(execPath, [entry], {detached:true, stdio:'ignore'}) + unref()
      | probe RPC health within ~500ms
      v  fail
L2  WMI Win32_Process.Create — the child is parented to wmiprvse.exe, which lives OUTSIDE the GUI's
    job object, so it survives even under JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
      | probe health within ~1000ms
      v  fail
L3  record STRICT_JOB_OBJECT_ENFORCED and continue *without* a daemon:
    in-process PTYs, i.e. today's (working) behaviour.
```

**Mechanism correction (verified while implementing):** the earlier draft named
`powershell Start-Process` as the L2 escape. It does not escape — a process created that way still
inherits the caller's job object, so it would die with the GUI exactly like L1. The mechanism that
actually escapes is WMI's `Win32_Process.Create`, because the created process is parented to
`wmiprvse.exe`, which is not in the GUI's job. `daemon-spawner.ts` uses WMI and does not use
`Start-Process`.

**Why job membership is detected rather than inferred:** an L1 child can boot, answer health checks,
and still be job-bound — that only becomes visible when the GUI exits, which is far too late to fix.
`IsProcessInJob` is therefore queried before spawning; when the GUI is in a job, L1 is skipped
entirely and the chain goes straight to the WMI escape.

**Known limitation (stated, not hidden):** when AntiFan is itself launched from a job with
`JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` (some CI runners, nested agent harnesses), nothing spawned by
the GUI can outlive it. L3 detects that case and degrades to current behaviour instead of pretending.
No broker over Windows Task Scheduler is built in P0.

### 4. Storage ownership (single writer)

The daemon is the **only** writer. The GUI never touches terminal state files; it sends metadata
mutations over RPC.

| File | Owner | Note |
| :--- | :--- | :--- |
| `terminal-sessions.json` | daemon only | unchanged format in P0; decomposition is P1 |
| GUI session metadata (active tab, tab order) | daemon, via RPC | GUI is stateless for terminal data |

### 5. Re-attach = rehydrate

On connect the GUI calls `listSessions()` then `getFullBuffer(id)` per session and repaints. This is
the identical path the GUI already uses on tab switch, so it is proven, not new.

---

## Phases

### Phase 0 — Lock (this document)

- [x] Verify `TerminalManager` is Electron-free (script walk: 8 files, 0 electron imports).
- [x] Verify `sleeping` ⇒ `teardownSessionPty` kill semantics.
- [x] Verify `altScreen` signal exists for future gating.
- [x] Verify persistence call graph (see P1 justification below).
- [x] Cut over-built pieces (custom framing, seq protocol, auto-sleep).

### Phase 1 — Daemon host + spawner (P0)

- [x] `scripts/probe-terminal-host-survival.cjs`: prove detached survival end to end (relay → host →
      PTY child) and extract the input-gating invariant. `ok: true`.
- [x] `scripts/stage-daemon-host.mjs`: content-hash the daemon bundle, copy entry + `node-pty` native
      binaries into `.antifan-data/daemon-host/<hash>/`, atomically publish a `current` pointer.
- [x] `src/main/terminal-daemon/daemon-entry.ts`: headless entry; boots `TerminalManager`, listens
      loopback-only, token-gated, reusing the `{id,method,params}` / `{event,data}` envelope.
- [x] `scripts/probe-staged-host-rpc.cjs`: end-to-end proof — staged host boots, authenticates,
      serves the terminal RPC surface, gates input on the prompt, maps natives from the staged dir
      only, and survives client disconnect. `ok: true`.
- [x] `src/main/terminal-daemon/daemon-spawner.ts`: L0 re-attach → L1 detached → L2 WMI escape →
      L3 `STRICT_JOB_OBJECT_ENFORCED` degrade, with a health probe and a live-instance record.
- [x] `src/main/terminal-daemon/protocol.ts`: shared method/event names imported by both sides, so a
      method added on one side cannot silently answer `UNKNOWN_METHOD` on the other.
- [x] `src/main/terminal-daemon/daemon-client.ts`: RPC transport + `TerminalManager`-shaped async
      proxy the GUI consumes.
- [x] `scripts/probe-daemon-reattach.cjs`: the P0 goal through the production path — two processes,
      the second re-attaching to the same host pid with the session, scrollback, and a live child
      process intact. `ok: true`.
- [ ] Wire the GUI's `TerminalManager.getInstance()` to the proxy behind a flag so the in-process path
      remains as the L3 fallback. Blocked on making the ~50 synchronous call sites `await` the async
      proxy (the proxy cannot be synchronous over a socket).
- [ ] Menu action: `Thoát hoàn toàn (dừng cả GUI và Terminal Host)`.

### Phase 2 — Full IPty / session surface over RPC

**Status: the RPC surface is complete and machine-gated; the GUI cutover is what remains.**

Every manager member the GUI actually calls now has a host handler and a proxy method. The
distinction that mattered: `getSession()` is called 27 times as a *truthiness oracle*, so the RPC
returns scalars without the buffer (a faithful copy of the in-process object would ship up to 4 MiB
per liveness check); `includeBuffer: true` exists for the rare caller that wants the transcript.

- [x] Cover the surface: `getSession`, `getCurrentCwd`, `closeSplitSession`, `reorderSessions`,
      `wakeSession`, `setCapsule`, `recordSubscriberAck` added to protocol + host dispatch + proxy;
      `kill` modelled as `shutdownHost` (see the invariant note below).
- [x] `scripts/probe-rpc-surface-coverage.cjs` — the drift gate, two passes:
      - **static:** reads the five GUI sources, extracts every method called on a manager instance,
        and requires each to be proxy-implemented or allowlisted with a written reason
        (`LOCAL_ONLY`). Falsified deliberately: injecting `TerminalManager.getInstance().setCwd('/')`
        into `app-menu.ts` made it fail with the exact `file:line`; reverting restored
        `ok: true` (md5 pinned).
      - **live:** boots a real staged host and calls all 38 proxy methods, asserting real answers
        (never `UNKNOWN_METHOD`), exercising mutating calls on throwaway sessions, and running
        `shutdownHost` last on its own host.
      Result: `ok: true`, 33 GUI-referenced methods covered, 38/38 live calls ok.
- [x] Two payload-fidelity defects the gate caught on its first real run, both invisible to a
      typecheck because the host rebuilds each payload field by field:
      1. `recordSubscriberAck` read `appliedSeq` where `TerminalAckPayload` names the field `seq`, so
         every ack recorded `seq: 0` — ack-latency accounting would have silently never advanced.
         (The `as never` cast that hid it is gone; the handler is typed against the real contract.)
      2. `getSubscribers` returned `{ subscribers: [...] }` while `TerminalManager` returns an array,
         so the proxy handed call sites a different shape than the in-process manager. The handler is
         now a raw passthrough like every sibling, and the probe asserts the array shape.
- [ ] Wire the GUI's `TerminalManager.getInstance()` to the proxy behind a flag so the in-process path
      remains as the L3 fallback. Blocked on making the ~50 synchronous call sites `await` the async
      proxy (the proxy cannot be synchronous over a socket). Two call sites also need a real change
      rather than a mechanical `await`: the `did-finish-load` paths read `getSession().buffer`, which
      the RPC deliberately omits — they must use `getFullBuffer()`.
- [ ] Menu action: `Thoát hoàn toàn (dừng cả GUI và Terminal Host)` — the only sanctioned caller of
      `shutdownHost`. **Invariant:** the daemon must never be shut down from the GUI's own shutdown
      path, or the feature it was built for (outliving the GUI) is deleted by the code that uses it.

The proxy must cover the *whole* `TerminalManager` surface, not "PTY operations" in the abstract.
Enumerated from source, this is the contract:

| Surface | Source anchor | Why it is not optional |
| :--- | :--- | :--- |
| `write` / input | `writeTo` | keystrokes |
| `resize` | `resizeTo` (~1602) | carries `pendingCols/pendingRows`, `lastCols/lastRows`, and `MIN_TERMINAL_ROWS` / `MIN_SPLIT_TERMINAL_ROWS` clamps — a naive proxy loses the clamps |
| `kill` / teardown | `teardownSessionPty` (~1626) | includes the **macrotask yield guard** (~1649-1653): write+close in one event-loop turn deadlocks shutdown on Windows |
| `onData` / `onExit` subscriptions | `spawn` (~1335) | subscription lifecycle must be torn down before kill or chunks land after the fold |
| backpressure `pause`/`resume` | `teardownSessionPty` (~1642) | a paused PTY must be resumed before kill or the shell cannot drain |
| `pid` | `Session.pty.pid` | feeds `killProcessTree` (`taskkill /T /F`) |
| start/restart, spawn args, env | `spawn` (~1252) | `ANTIFAN_CONFIG_DIR`, `ANTIFAN_DATA_ROOT`, scripts dir on PATH |
| deferred start queue | `deferredPtyIds`, `reserveRestoredSession` | restored background sessions start lazily; the queue lives in the daemon now |
| sleep / wake | `sleepSession` / `wakeSession` | state machine incl. `sleptAt`, `restoredTail` fold |
| split hierarchy | `splitOf`, `parentGeneration` | a pane cannot outlive its parent shell |
| generation counters | `sessionGenerations`, `sessionGeneration` | agent affinity + renderer chunk-generation continuity |
| delivery journal + ack | `deliveryJournal`, `TerminalAckPayload` | ack-latency accounting |
| terminal state flags | `altScreen`, `pendingClearScreen` | drive renderer wipe decisions |
| transcript composition | `composeTranscript` (~1965) | `restoredTail` + `\r\n── phiên trước ──\r\n` + live buffer |
| `listSessions` / `getFullBuffer` / `getDelta` | ~2000s | rehydrate + live views |
| rename / close / category | `renameSession`, `closeSession` | sidebar grouping parity |

### Phase 3 — Storage decomposition (P1, justified honestly)

**Correct justification (the first draft got this wrong):**

**Measured, not estimated** (`scripts/probe-persist-cost.cjs`, production `persistSync` over RPC,
transport subtracted; state files seeded as sleeping sessions so the size under test is exact):

| sessions | state file | flush (warm) | disk write | main-thread join |
| :--- | :--- | :--- | :--- | :--- |
| 1 | 0.26 MB | 2.5 ms | 0.5 ms | 2.1 ms (82%) |
| 1 | 1.02 MB | 10.3 ms | 1.5 ms | 8.7 ms (85%) |
| 8 | 8.12 MB | 55.0 ms | 5.0 ms | 50.0 ms (91%) |
| 16 | 16.25 MB | 105.0 ms | 9.9 ms | **95.1 ms (91%)** |

Three findings, each of which changes the design:

1. **Cost tracks bytes, not sessions.** 8 sessions × 1 MiB and 16 × 1 MiB cost 55 ms and 105 ms —
   proportional to file size. Session count has no independent cost.
2. **The join dominates the write (~91%).** `serializePersistPayload()` is main-thread string work;
   the disk write is ~10%. `persistAsync()` offloads only the write, so the *main thread still blocks
   on the join* — at the 16 MiB cap that is a ~105 ms GUI stall per flush, every 5 s of busy output.
3. **The fragment cache is not saving what it looks like.** Cold ≈ warm at equal size, because for
   clean sessions the "cache" still means joining every cached fragment into one string. The cache
   avoids re-`JSON.stringify`, not the join.

Consequence for the split: per-session files remove the join from the hot path entirely (each dirty
session writes only its own fragment), which is the dominant cost — so the split is justified by
flush cost, not merely by blast radius. It also fixes the other two reasons below.

- `serializePersistPayload()` does **not** re-serialize everything each time — it reuses
  `persistedFragments` per session and only re-serializes dirty ones (`serializeSessionFragment`,
  ~line 748; cache lookup at ~760; payload assembly ~800).
- `persistSync()` is **not** the hot path. It runs on shutdown/relaunch only
  (`index.ts:713`, `app-menu.ts:78`, `app-menu.ts:110`, `native-tab-host.ts:8198`,
  `terminal-manager.ts:2393`). The hot path is `persistAsync()`, debounced 5000 ms via
  `schedulePersist` (~line 932).

So the real reasons to split per session are:

1. **Write amplification:** each flush rewrites the *entire* file (join of all fragments + one
   full-file write), so one busy session's new output costs a rewrite proportional to total history.
2. **Corrupt blast radius:** the payload is a single JSON line; an interrupted or truncated write
   costs *every* session's transcript, not one. (Mitigated today by temp-file+rename, but rename
   fallback writes directly to the target on Windows.)
3. **Restore cost:** restore parses the whole document to recover any one session.

`[INFERENCE]` — the earlier draft's "freeze 300–800 ms" figure was never measured and is withdrawn.
P1 must start with a measurement, not a number.

- [x] Measure current flush cost vs file size (instrument, do not guess). Delivered as
      `scripts/probe-persist-cost.cjs`; results in the table above. The earlier draft's claimed
      "300-800 ms freeze" was withdrawn as unobserved and is replaced by ~6.5 ms/MB of main-thread
      join, ~105 ms at the 16 MiB cap.
- [ ] Split to `terminal-manifest.json` (metadata) + `sessions/<id>.journal` (append-only).
- [ ] Keep atomic temp+rename with a Windows-safe fallback.

### Phase 4 — Throughput (P2, measurement-gated)

- [ ] Measure first under N concurrent sessions; only then choose throttling.
- [ ] Candidate: foreground flush ~16 ms, background batch ~150 ms.
- [ ] Auto-sleep only under the three-part gate above (opt-in + no alt-screen + empty process tree).
- [ ] Reaper: define "idle" as *no connected client for N minutes* **and** *no session with a live
      PTY*. Never reap a session that owns a live shell.

---

## Invariants

1. The GUI holds no durable terminal state. Killing it may only cost repaint.
2. The daemon is the single writer of terminal state files.
3. The daemon never executes from `apps/AntiFan/`.
4. No automatic path may kill a session that owns a live child process.
5. If the daemon cannot be started, AntiFan works exactly as it does today (L3), never worse.
6. PTY creation and first output are **not** readiness. Input is gated on the observed shell prompt.

## Regression gate

```bash
npm run test:probes                             # all five probes, in order, against one pinned root
node scripts/probe-terminal-host-survival.cjs   # detached survival: relay -> host -> PTY child
node scripts/probe-staged-host-rpc.cjs          # staged host RPC + module-map + input gating
node scripts/probe-rpc-surface-coverage.cjs     # GUI -> proxy drift gate (static + live dispatch)
node scripts/probe-persist-cost.cjs             # storage cost baseline (flush vs file size)

# The P0 goal itself, through the production spawner and client proxy. Two processes, in order:
# phase 1 spawns the host and exits; phase 2 (a different OS process) must re-attach to the SAME
# host pid, still holding the previous session, scrollback, and a live child process of that shell.
node scripts/probe-daemon-reattach.cjs --phase=1
node scripts/probe-daemon-reattach.cjs --phase=2
```

All must exit 0 (`PROBE_RESULT.ok === true`). `npm run test:probes` is the one-command form: it stages
the daemon into a fresh temp root, points every probe at that root, runs the re-attach pair in
sequence, and removes the root. It stays out of `npm test` on cost, not on reliability — it stages a
full host bundle and spawns detached hosts.
The first asserts the host survives its parent and the
shell keeps working; the second asserts the staged host serves the real RPC surface, maps natives
only from the staged dir, and gates input on the prompt; the pair asserts the daemon's entire
reason to exist — a GUI restart costs a repaint, not a session.

## Risks

| Risk | Mitigation |
| :--- | :--- |
| Strict parent job object (CI/nested runner) kills the daemon with the GUI | L3 detection + degrade to in-process; stated as a known limit |
| `node-pty` ABI mismatch under a non-Electron runtime | daemon always launched via `process.execPath` with `ELECTRON_RUN_AS_NODE=1`; verify by loading the addon |
| Two hosts of different versions both alive after an upgrade | versioned directories + `current` pointer; GUI rehydrates from the one it connected to |
| Protocol drift between proxy and daemon | single shared envelope module, imported by both sides |

---

## Stage 2 review (`ak:code-review --pending --ultra`, 2026-09-19)

Best-of-5 independent review + single verifier. Outcome: **winner CandB** (data-root + WMI-pid +
quoting + env stripping, 87/100), runner-up CandD (87, under-calibrated the data-root defect),
CandE 86, CandA 72, CandC 72. Verifier swapped the CandC/CandD attributions; the union below is
re-anchored by the controller and each item was re-checked against the file on disk.

**Headline: the P0 goal is currently unreachable outside the probes.** Nothing imports
`src/main/terminal-daemon/*` (grep empty) — but fixing the cutover alone would not help, because the
daemon cannot boot in the shipping app at all (B1) and both escape mechanisms are broken (B2, B3).
Every probe is green because each one pins `ANTIFAN_DATA_ROOT` to its own directory and runs from a
parent that is not inside a kill-on-close job object.

### Blockers (verified live)

| # | Defect | Anchor | Evidence |
| :--- | :--- | :--- | :--- |
| B1 | **Staged bundle is unreachable in production.** `dataRoot()` falls back to `%LOCALAPPDATA%\antifan-data`, while the stager requires `ANTIFAN_DATA_ROOT` and wrote to `E:\Work\.antifan-data\daemon-host\474289b9585ae820\`. `index.ts:165-166` sets only `ANTIFAN_CONFIG_DIR`. | `daemon-spawner.ts:77`, `stage-daemon-host.mjs:42-46` | Reproduced: `C:\Users\Admin\AppData\Local\antifan-data\daemon-host` does not exist → `resolveStagedEntry()` null → `ensureDaemon()` returns `in-process` |
| B2 | **The L2 (WMI) command line cannot launch anything.** `""${path}""` doubling is not cmd syntax. | `daemon-spawner.ts:186` | cmd-layer repro: `'""C:\Program' is not recognized`; real `Win32_Process.Create`: `ReturnValue=0`, no process ran. Corrected shape (`set "K=V"&& "<exe>" …`) verified working through real WMI |
| B3 | **L2 aborts on the launcher's pid, not the host's.** WMI returns the `cmd.exe` pid; cmd exits as soon as it launches the GUI-subsystem electron.exe, so `!alive(spawnedPid)` cancels the handshake wait before the host publishes it. | `daemon-spawner.ts:213` + `waitForHandshake` | Static read; consequence: L2 never succeeds exactly in the job-object case it exists for |

### Major

| # | Defect | Anchor |
| :--- | :--- | :--- |
| M1 | WMI seeds only 4 env vars: `ANTIFAN_CONFIG_DIR` and user `PATH` additions are lost (verified: WMI env dump has no `ANTIFAN_*`; daemon then resolves a different journal) | `daemon-spawner.ts:156-163` |
| M2 | The drift gate omits `src/main/tools/terminal-capabilities.ts`, so `waitTerminal` (called at line 248) is absent from protocol/host/proxy while the gate reports `ok:true` — it cannot certify the cutover it exists to guard | `probe-rpc-surface-coverage.cjs:65-71` |
| M3 | `shutdown` calls `tm.kill()` (active session + its split only) then exits → every other shell is orphaned; "quit everything" does not | `daemon-entry.ts:379`, `terminal-manager.ts:1724` |
| M4 | Nine handlers pass a domain boolean as the RPC `success` flag, so a legitimate `false` becomes a thrown error and its payload is dropped — semantics differ from the in-process manager | `daemon-entry.ts:258,266,278,290,…` |
| M5 | Job detection returning `unknown` is treated as `free`, and the docstring's "post-spawn survival check" does not exist in the body | `daemon-spawner.ts:125-126,280` |
| M6 | An alive-but-unhealthy host is discarded (`clearLiveRecord()` on health-probe failure) and a second host is spawned → two writers on one journal; the failed mechanism's process is also left alive on `continue` | `daemon-spawner.ts:246-250,289` |
| M7 | The client proxy holds a static `{port, token}`; a respawned host has a new port and token, so reconnect retries a dead endpoint forever — nothing re-consults `ensureDaemon()` | `daemon-client.ts:150-190` |
| M8 | Preserved shells get no bridge address: `ANTIFAN_BRIDGE_*` is added only from `this.bridgeEndpoint`, which the daemon never sets, and `...process.env` freezes the old GUI's values → agent tooling inside a restored terminal cannot reach the current bridge | `terminal-manager.ts:1281-1295` |

### Minor

- `probe-daemon-reattach.cjs` phase 2 never assigns `spawnedPid`, so its `catch` cannot clean up (leaks host + shell child); `probe-staged-host-rpc.cjs` pushes the pid only after `launchHost` returns, so a handshake timeout leaks the detached host.
- `probe-daemon-reattach.cjs --phase=1` on its own always leaves the host it spawned running, which is
  the point of the split but also means a failed phase 1 leaks a detached host and the staged tree it
  holds (only phase 2 kills it). `test:probes` therefore runs both phases; a red phase 1 needs a manual
  `Stop-Process` before the temp root can be removed.
- No `'error'` listener on accepted sockets and no process-level guard — hardening only: the "host dies when the GUI is killed" trigger was **refuted** by reproduction (RST and mid-stream kills both fold into `close`; host survives).
- The re-attach probe asserts host pid + heartbeat child but never cwd or shell pid, so a restored-but-fresh session would still pass.
- `daemon-entry.ts:6-7` repeats the withdrawn `npm run compile` EBUSY claim that this plan refuted.

### Open design conflict (not a code bug)

The versioned staging story says a changed hash starts a new host while the old one keeps running and
"the GUI connects to the new one and rehydrates" — but the old host still owns and writes the same
journal, and the new host's sessions are restored *fresh shells*, not the live ones. Continuity and
version-switching therefore need an explicit decision (adopt or hand over), not a version check.

### Provenance of the union (candidate vs. controller evidence)

Neither controller-only finding was dropped from the union; both were independently rediscovered by
candidates, and the controller's live reproductions upgraded the two data-root/env items from
"claimed by tracing" to "reproduced".

| Finding | Candidates that found it | Controller evidence |
| :--- | :--- | :--- |
| B1 staged bundle unreachable (data root) | CandE (Critical), CandD (Major) | V1 live: `%LOCALAPPDATA%\antifan-data\daemon-host` absent, stager required `ANTIFAN_DATA_ROOT` |
| B2 WMI quoting | CandD, CandB, CandE | V2 live: cmd layer + real `Win32_Process.Create`; corrected shape verified to run |
| B3 WMI pid gate | CandB, CandE (Critical) | static read of `waitForHandshake` |
| M1 WMI env gap (`ANTIFAN_CONFIG_DIR`, `PATH`) | CandB, CandD, CandE | V3 live: WMI env dump — 64 vars, no `ANTIFAN_*`, user `PATH` entries absent; `E:\Work\.antifan-data\config` vs `%LOCALAPPDATA%\antifan-data\config` reproduced numerically |
| M2 gate hole (`waitTerminal`) | CandC only | V6 live: `waitTerminal` grep empty under `src/main/terminal-daemon/` |
| M3 `kill()` vs `dispose()` | CandA, CandB, CandE | read: `kill()` touches the active session and its split only |
| M4 domain boolean as `success` | CandA only | read: 9 handlers, client throws on `!resp.success` |
| M5 phantom post-spawn check, `unknown` ⇒ `free` | CandB, CandD, CandE | Stage 1 read of the docstring vs the body |
| M6 live record cleared on health failure / orphan on `continue` | CandE, CandB | read of the L0 branch and the mechanism loop |
| M7 static endpoint, no host rediscovery | controller only | read of `daemon-client.ts` reconnect path |
| M8 no bridge address in preserved shells | CandE | read of `terminal-manager.ts:1281-1295` |
| Minor: probe scripts leak hosts | CandC | both anchors re-read (`spawnedPid` never assigned in phase 2; `hosts.push` after `launchHost`) |
| Minor: ws `'error'` listener | CandA | refuted by two reproductions → downgraded to hardening |

---

## Stage 2 addendum - three advisory claims tested (2026-09-19)

Supersedes specific Stage 2 rows. Everything below is live evidence, not proposal.

### A. L2 env gap is worse than "ANTIFAN_CONFIG_DIR is dropped" (amends M1)

`ProcessStartupInformation.EnvironmentVariables` **replaces** the environment block; it does not merge.
Verified: a child launched with a 3-entry list reported `envCount=3`, and with a 6-entry list reported
`envCount=6` - no `PATH`, no `SystemRoot`, no user vars unless explicitly passed. So the L2 daemon today
runs on a minimal environment (PTY shells spawned by it inherit that), and the fix must serialise the
*whole* environment, not just add two keys.

### B. New consequence: PTY children get a WRONG data root even under L1 (extends B1/V1)

Read, with exact anchors:

- `daemon-spawner.ts:150-158` `daemonEnv()` = `{...process.env, ELECTRON_RUN_AS_NODE, TOKEN, VERSION, ...extra}`.
- `daemon-spawner.ts:280` passes `extra = { ANTIFAN_DATA_ROOT: dataRoot() }`, i.e. the
  `%LOCALAPPDATA%\antifan-data` fallback **overrides** the inherited value.
- `terminal-manager.ts:1282` builds each shell's env as
  `ANTIFAN_DATA_ROOT: process.env.ANTIFAN_DATA_ROOT || StorageLocations.getDataRoot()` - and inside the
  daemon that variable is now *set*, so the fallback value wins.

Net: a shell spawned by the daemon sees `%LOCALAPPDATA%\antifan-data`, while the same shell spawned
in-process by the GUI sees `E:\Work\.antifan-data`. Terminal-launched tooling that resolves the data
root therefore changes behaviour depending on who spawned the shell. One fix closes B1, M1 and this:
`spawner.dataRoot()` must delegate to `StorageLocations.getDataRoot()`, and `ANTIFAN_CONFIG_DIR` must be
forwarded explicitly instead of relying on inheritance.

### C. Verified fix shape for B2 + B3 (supersedes the "rebuild the command line" note)

Tested end-to-end through real `Win32_Process.Create`:

- CommandLine `"C:\Program Files\nodejs\node.exe" "<entry>"` - **no `cmd.exe` layer** - returned
  `ReturnValue=0`. CreateProcess parses the quoted image correctly, so the `""")` doubling that broke
  the cmd layer never happens.
- `New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{ EnvironmentVariables = <list> }`
  passed as `ProcessStartupInformation` delivered `ELECTRON_RUN_AS_NODE=1`, `ANTIFAN_CONFIG_DIR`,
  `ANTIFAN_DATA_ROOT`, `PATH`, `SystemRoot` into the child - including `ELECTRON_RUN_AS_NODE`, which
  cannot be expressed in argv.
- **The WMI-returned `ProcessId` equals the child pid** (`childpid == ProcessId`, 15920). With no `cmd`
  intermediate the pid gate has nothing to be wrong about - **B3 dissolves as a side effect of dropping
  the wrapper**, and the token leaves the command line (no longer visible in `Win32_Process` listings).

Implementation caveats found while testing. Three variants were measured, and the discriminator is
literal vs. runtime-constructed entries - not the PowerShell cast:

| Entry construction | Result |
| :--- | :--- |
| inline literals `@('K=V', ...)` | constructs; `Create` `RV=0`; env delivered |
| runtime concatenation, no cast | `New-CimInstance` throws a PSObject cast error; `$startup` is null; `RV=0` **without** env |
| `[string[]]` cast of concatenated entries | constructs; `Create` returns `21` (`E_INVALIDARG`) |

Since the shipping spawner is TypeScript emitting script text, its entries are literals by
construction, so the working variant is the one an implementation naturally produces. Scale check with
the real payload: 128 parent entries serialised to a `System.String[]` of 6003 bytes -> `RV=0`,
`ProcessId` == child pid, child `envCount=130` (whole block delivered, well inside the ~32 KB Windows
limit). Control run of the identical CommandLine outside WMI exits `0` and writes its output, so
failures in this area are never attributable to the payload.

Two further findings: `[wmiclass]::CreateInstance('Win32_ProcessStartup')` has no such overload -
`Invoke-CimMethod` + `New-CimInstance` is the working route; and Windows needs `SystemRoot` present in
the replacement block.

### D. ws `'error'` finding stays hardening, with the third reproduction recorded (amends the Minor row)

Three independent triggers now fail to crash the host: idle RST, RST mid-stream (4 KB every 2 ms), and
`_socket.destroy()` followed immediately by `send()`, plus `send()` on a CLOSING socket. No synchronous
throw, no unhandled `'error'`, host alive in all cases. Absence of a listener remains a legitimate
hazard class (a callback-less `send()` is documented to emit `'error'`), so the one-line listener plus a
process-level guard are still worth adding - but the severity is "unproven, hardening", not "latent
Major", and the two earlier reproductions do not prove the mechanism is unreachable.
