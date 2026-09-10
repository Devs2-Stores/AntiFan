# EVIDENCE PACKET — AntiFan bottleneck scout (--ultra)

## 0. Verbatim request (Vietnamese, Tier-0 intent)
"--ultra Trên cương vị là một Solo Developer Local, tôi không muốn bất kì điểm nghẽn nào chặn quá trình tôi làm việc, App này là của riêng tôi, hoạt động local, và không bao giờ public. Vì vậy, phân tích sâu cho tôi các điểm còn nghẽn đi"

Translation: as a solo local developer, no bottleneck may block my work process. The app is mine, runs local, is never public. Deep-analyze the REMAINING bottlenecks.

## 1. Confirmed constraints (do not violate in recommendations)
- Single developer, single machine, Windows 11 Pro (build 22000), x64, Intel i5-9300H, Intel UHD 630 (integrated GPU).
- Scope is LOCAL ONLY. Out of scope by declaration: public distribution, Chrome Web Store, code signing/EV cert, auto-update infrastructure, multi-tenant security hardening.
- Repo root: `E:/Work/apps/AntiFan`. App = Electron 43 Chromium desktop browser + extension bridge + MCP server + terminal, used for Haravan/Sapo/Shopify theme QA and AI-agent driving.
- Existing root contract: `E:/Work/apps/AntiFan/AGENTS.md` (v1.2.0), `CLAUDE.md`.
- Prior reports exist (do not re-derive, but you MAY check whether their findings were actually closed):
  - `AntiFan-Final-Repo-Analysis-2026-08-26.md`
  - `AntiFan-HEAD-9e06cc4-Final-Deep-Audit-Report.md`
  - `antifan-deep-architecture-6-plan-review.md`
  - `AntiFan-improvement-report.md`, `AntiFan-improvement-report-final.md`, `ANTIFAN_IMPROVEMENTS.md`
  - `RESEARCH_REPORT_ANTIFAN_VISUAL_QA_RESOLUTION.md`, `AntiFan-Final-Fix-Report-ae6b435.md`
  - `plans/` (485 MB of plan/report state), `plans/reports/`

## 2. Controller-measured facts (Tier-1 telemetry, measured 2026-09-10)
Working tree is ~4.6 GB excl. node_modules internals.

| Path | Size | Files |
|---|---|---|
| `appdata/` | 1885 MB | 10305 |
| `.canary/` | 955 MB | 4083 |
| `out/` | 699 MB | 78 |
| `node_modules/` | 498 MB | 5710 |
| `plans/` | 486 MB | 878 |
| `.antifan/` | 32 MB | 1572 |
| `.git/` | 14 MB | 1207 tracked files |
| `.compiled/` | 10 MB | 647 |
| `reports/` | 1.6 MB | 23 |
| `test/` | 2.7 MB | 197 files |

Code LOC measured (excluding node_modules/.compiled/out/.canary/plans/appdata):
- `src/main` 62,121 LOC — `test/main` 41,474 LOC — `test/unit` 10,532 — `src/renderer` 10,892 — `packages/site-clone` 10,742 — `test/e2e` 2,763.

Largest source files (LOC):
- `src/main/browser/native-tab-host.ts` — 6,749
- `src/main/tools/browser-control-port.ts` — 6,033

Test inventory: `test/main` 129 files, `test/unit` 25, `test/integration` 5, `test/e2e` 13, `test/benchmark` 2.
Scripts: 71 files in `scripts/` (long list of `smoke-*.cjs`, `benchmark-*.cjs`, `certify-*.cjs`, `audit-*.mjs`, `serve-*.mjs`, `run-*.cjs`).
Root-level clutter: 14 loose `*.md` reports + ~20 loose `*.png` diffs/screenshots + `e2e-fail.log`, `e2e-results.log`, `probe.js`, `trees_all.txt`, `main.cjs`, `run-antifan.vbs` at repo root.
`git status --porcelain` = clean (0 entries), 1,144 tracked files.
`.gitignore` excludes `out/`, `.compiled/`, `.canary/`, `appdata/`, `.antifan/`, `scratch/`, `tmp/`, `plans/**/reports/smoke/*.log`, `*.png` (except icons), `*.log`.

npm script graph (from `package.json`, verbatim keys): `compile = clean && build-native-host-shim.mjs && tsc -p ./ && copy-static.mjs && build-extension`. `test = clean && compile && test:fast && test:site-clone && test:integration && test:main && test:e2e`. `verify = typecheck && test`. Every `smoke:*` script re-runs `npm run compile` first. `dev`/`start:dev` = `node --max-old-space-size=4096 scripts/dev.mjs`.

`scripts/dev.mjs` behavior (read by controller): singleton PID lock at `node_modules/.cache/antifan-dev.pid`, blocking `execSync('npm run compile')` at startup, spawns `tsc -p ./ --watch` with `--max-old-space-size=4096`, hot-swap/soft-reload per changed file, polling mtime watcher for its own scripts every 2 s.

## 3. Scout target areas (all five must be covered in your report)
- **T1 Dev inner loop** — compile/watch/electron-relaunch path, typecheck cost, incremental vs full rebuild, dev lock, hot-swap correctness, cold start, script sprawl in `scripts/`.
- **T2 Build & test gates** — `npm test` chain cost and redundancy (clean+compile repeated, `compile` re-run inside every smoke), test-suite structure (129 `test/main` files), certify/benchmark tooling, missing fast feedback path.
- **T3 Runtime & architecture bottlenecks** — oversized modules (`native-tab-host.ts`, `browser-control-port.ts`), IPC/CDP queueing, session/terminal/bridge coupling, memory & GPU behavior on this hardware, anything that makes a single dev change expensive or fragile.
- **T4 Agent & tool surface friction** — MCP tool count and duplication vs WebSocket RPC methods, `ALLOW_EVAL` gating, validation/verification ceremony the solo dev must perform (`scripts/audit-core-purity.ts`, `certify-core-freeze.cjs`, `freeze-certification-core.cjs`), manifest/config sprawl (`AGENTS.md`, `CLAUDE.md`, `.cursor/`, `.antigravity/`, `plugins/`, `specs/`).
- **T5 Workspace & environment hygiene** — 4.6 GB working tree, `appdata/` 1.9 GB, `.canary/` 955 MB with ~15 duplicate `run3-attemptN` trees, `out/` 699 MB, `plans/` 486 MB, root doc/screenshot sprawl, duplicated/overlapping reports, backup/sync cost, orphaned processes/ports.

## 4. Hard rules for candidates
- READ-ONLY. Do not edit, create, or delete any file. Do not run builds, tests, formatters, or long-running processes. Do not push or mutate git.
- Every claim MUST cite a path (and line range when quoting behavior). No claim without evidence.
- Unverified reasoning MUST be marked `[INFERENCE]`.
- Do NOT recommend public-distribution work (signing, store, auto-update, multi-tenant hardening) — explicitly out of scope per Tier-0.
- Do NOT pad with generic advice ("write more tests", "add CI", "refactor for SOLID"). Findings must be concrete and specific to this repo, with the cost quantified where possible (file count, MB, LOC, number of scripts, number of duplicated steps).
- Distinguish BOTTLENECK (blocks or materially slows the dev's daily loop) from SMELL (untidy but harmless). Rank by impact on a solo local dev.
- Be honest about gaps: list what you could not verify.

## 5. Rubric (verifier scores each candidate 1-20 per criterion)
1. **Coverage** — all five target areas T1-T5 addressed with real substance.
2. **Evidence quality** — paths/line refs/measured numbers verified against the live repo; no hallucinated files.
3. **Signal density** — findings are specific and non-generic; no filler.
4. **Pathology accuracy** — correct separation of true bottlenecks from harmless smells; correct severity ordering.
5. **Gap honesty** — explicit statement of unverified areas and unresolved questions.

## 6. Required output shape
```markdown
# Scout Report — Candidate <N>
## Relevant Files
- `path` — role in the bottleneck (one line)
## Bottlenecks (ranked)
### B1. <name> [severity: blocking|high|medium|low]
- Evidence: `path:lines` / measured number
- Why it blocks a solo local dev
- Concrete removal/mitigation option
...
## Smells (not bottlenecks)
## Unresolved Questions
```
