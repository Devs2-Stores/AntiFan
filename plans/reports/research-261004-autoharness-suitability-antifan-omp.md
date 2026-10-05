# Research Report: Suitability Analysis of `tigerless-labs/autoharness` for AntiFan and OMp

> **Timestamp:** 2026-10-04T16:35:00Z  
> **Evaluation Mode:** Ultra Verifier Mode (`--ultra`, Best-of-5 Asymmetric Wave)  
> **Evaluator:** OMp Principal Systems & Reliability Engineer  
> **Target Repository:** [`tigerless-labs/autoharness`](https://github.com/tigerless-labs/autoharness)  
> **Evaluated Targets:** AntiFan Local Desktop Control Plane (`E:\Work\apps\AntiFan`) & OMp Agent Harness  

---

## Table of Contents
1. [Executive Summary](#1-executive-summary)
2. [Research Methodology & Evidence Packet](#2-research-methodology--evidence-packet)
3. [Technology Overview: `tigerless-labs/autoharness`](#3-technology-overview-tigerless-labsautoharness)
4. [Current State & Internal Mechanisms](#4-current-state--internal-mechanisms)
5. [Comparative Analysis](#5-comparative-analysis)
   - [5.1 Autoharness vs. AntiFan Super Core](#51-autoharness-vs-antifan-super-core)
   - [5.2 Autoharness vs. OMp Autolearn & Runtime Harness](#52-autoharness-vs-omp-autolearn--runtime-harness)
6. [Architectural Fit Assessment for AntiFan](#6-architectural-fit-assessment-for-antifan)
7. [Architectural Fit Assessment for OMp](#7-architectural-fit-assessment-for-omp)
8. [Integration Feasibility & Implementation Options](#8-integration-feasibility--implementation-options)
9. [Strategic Recommendations & Actionable Next Steps](#9-strategic-recommendations--actionable-next-steps)
10. [Unresolved Questions](#10-unresolved-questions)
11. [Appendix: Ultra Verifier Ranking & Candidate Scoring](#11-appendix-ultra-verifier-ranking--candidate-scoring)

---

## 1. Executive Summary

`tigerless-labs/autoharness` is a self-learning skill layer engineered as an Anthropic Claude Code CLI plugin. It operates entirely **without a daemon or background service**, using hook-triggered episodic reflection: intercepting lifecycle events (`SessionStart`, `Stop`, `PreToolUse`, `SessionEnd`), evaluating tool-call counts, spawning detached background subagents (`claude -p --agent reflector` or `--resume --fork-session`) to distill reusable patterns from session transcripts, validating proposals through a deterministic gatekeeper (`promoter.py`), and managing skill retention via empirical call-rate lifecycle mechanics (`lifecycle.py`).

### High-Level Verdicts

| Target | Verdict | Fit Score | Strategic Decision |
| :--- | :--- | :---: | :--- |
| **AntiFan** | **HARD REFUSAL / ARCHITECTURALLY UNFIT** | **3 / 20** | **Do NOT adopt inside AntiFan.** AntiFan's primary contract establishes it as an execution and empirical verification plane (*"External agents own reasoning; AntiFan owns execution & verification; không chứa AI loop hoặc daemon riêng"*). AntiFan already houses a relational SQLite evidence store in `packages/super-core`. |
| **OMp** | **HIGH VALUE ALGORITHMIC ADOPTION / UNVERIFIED DIRECT FIT** | **16 / 20** | **Direct drop-in integration is an unverified risk `[INFERENCE]`.** OMp's support for Claude Code `hooks.json` or external `claude -p` execution is unproven in this workspace. However, the core algorithmic mechanics (Promoter Gate, Call-rate Lifecycle, and Curator Consolidation) provide high architectural value for adaptation into OMp's native `cfg://autolearn` `[INFERENCE]`. |

---

## 2. Research Methodology & Evidence Packet

- **Mode:** Ultra Verifier Mode (`--ultra`) running a 5-candidate independent evaluation wave.
- **Evidence Base:**
  - Live inspection of `tigerless-labs/autoharness` (`hooks.json`, `dispatch.py`, `config.py`, `lifecycle.py`, `promoter.py`, `format_spec.md`, `reflector.md`, `curator.md`).
  - Live inspection of AntiFan codebase (`package.json`, `README.md`, `docs/operations.md`, `packages/super-core/src/schema.ts`, `scripts/antifan-core.cjs`, `scripts/antifan-omp-mcp.cjs`).
  - Live inspection of OMp runtime configuration (`cfg://autolearn`, `cfg://skills`, `cfg://memory`, `cfg://task`, `proc://`).

---

## 3. Technology Overview: `tigerless-labs/autoharness`

`autoharness` operates on the premise that an agent's skill library can maintain itself through bounded, empirical usage rather than static benchmarks or dedicated eval runs.

### Key Characteristics & Tunable Parameters (`src/autoharness/config.py`)
- **Runtime:** Zero third-party Python dependencies (Python 3.11+ stdlib only).
- **Target Platform:** Claude Code CLI (`.claude-plugin/plugin.json`, `marketplace.json`).
- **Reflection Cadence:** Triggered on tool calls, default `AUTOHARNESS_REFLECT_EVERY_N=50` (configurable via env).
- **Consolidation Cadence:** Curator library-wide pass, default `AUTOHARNESS_CONSOLIDATE_EVERY_N=250`.
- **Subagent Spawning:** Detached background process running `claude -p --agent reflector` (or `--resume --fork-session`) with `--dangerously-skip-permissions`.
- **Altitude Limit:** Root `SKILL.md` body cap default `AUTOHARNESS_SKILL_BODY_MAX_LINES=25` non-blank lines (enforced by promoter).
- **Description Budget:** Capped at Anthropic host limit `AUTOHARNESS_SKILL_DESC_MAX_CHARS=1024`; session index scan line capped at `AUTOHARNESS_INDEX_DESC_MAX_CHARS=60`.
- **Layer Capacity:** Default `AUTOHARNESS_CAPACITY_PROJECT=50`, `AUTOHARNESS_CAPACITY_GLOBAL=20`.
- **Maturity Threshold:** Default `AUTOHARNESS_MATURITY_PROJECT=100`, `AUTOHARNESS_MATURITY_GLOBAL=300`.

---

## 4. Current State & Internal Mechanisms

```
+-----------------------------------------------------------------------------------+
|                            Claude Code Agent Loop                                 |
|  [SessionStart] ---> [PreToolUse] (N tool calls) ---> [Stop] ---> [SessionEnd]    |
+---------+-------------------+----------------------------+----------------+-------+
          |                   |                            |                |
          v                   v                            v                v
+-----------------------------------------------------------------------------------+
|                     src/autoharness/hook/dispatch.py                              |
+-----------------------------------------------------------------------------------+
          |                                                |
          | (if calls >= AUTOHARNESS_REFLECT_EVERY_N)      | (lifecycle audit)
          v                                                v
+------------------------------------+         +------------------------------------+
|  Detached Subprocess Reflection    |         |   src/autoharness/lib/             |
|  `claude -p --agent reflector`     |         |   lifecycle.py                     |
|  (Proposes intents via MCP tool)   |         |   Call-rate evaluation & pruning   |
+-----------------+------------------+         +-----------------+------------------+
                  |                                              |
                  v                                              v
+------------------------------------+         +------------------------------------+
|   src/autoharness/hook/promoter.py |         |   agents/curator.md                |
|   - Single-line trigger budget     |         |   Periodic consolidation of        |
|   - Non-blank line cap <= 25       |         |   overlapping skills               |
|   - Subfile whitelisting           |         +------------------------------------+
|   - Atomic swap -> .claude/skills/ |
+------------------------------------+
```

### 4.1 Promoter Admission Gate (`promoter.py`)
Deterministic validator preventing skill bloat and corrupted state:
1. **Rule-Altitude (Line Cap):** Root `SKILL.md` body must be $\le 25$ non-blank lines by default (`SKILL_BODY_MAX_LINES`). Detailed reference material must be placed in `references/`.
2. **Trigger Density Budget:** Frontmatter `description` must carry an explicit trigger cue (`Use when...`) and fit within character limits.
3. **Subfile Whitelist:** Permitted subdirectories are strictly restricted to `references/`, `templates/`, `scripts/`, `assets/`.
4. **Pointer Integrity:** Relative links in `SKILL.md` must resolve locally; referenced Python files must parse without syntax errors.
5. **Atomic Commit:** Files are written to temporary locations and swapped atomically via `os.replace` into `.claude/skills/<name>/`.

### 4.2 Lifecycle Contention Engine (`lifecycle.py`)
- **Call-Rate Metric:**
  $$\text{Rate}(s) = \frac{\text{Invocations}(s)}{\max(1, \text{RequestCount}_{\text{current}} - \text{RequestCount}_{\text{anchor}}(s))}$$
- **Probation:** Newly admitted skills sit in probation until request count reaches maturity threshold.
- **Graduation Review:** Mature skills with $\text{use} = 0 \land \text{view} = 0$ are marked dormant and archived.
- **Capacity Contention:** When the active mature pool exceeds capacity (e.g. 50 in project layer), the lowest-rate skills are archived.

---

## 5. Comparative Analysis

### 5.1 Autoharness vs. AntiFan Super Core

| Architectural Dimension | `tigerless-labs/autoharness` | AntiFan Super Core (`packages/super-core`) |
| :--- | :--- | :--- |
| **System Philosophy** | Metacognitive prompt/skill text generation. | Relational evidence, provenance, and verification store. |
| **Storage Architecture** | File-system Markdown (`SKILL.md`) + JSON sidecars. | SQLite WAL mode (`core.db`), Schema v12, FTS5 index. |
| **Data Entities** | Skills, usage rates, candidate proposals. | Claims, Artifacts, Units, Evidence, Conflicts, Cases, Candidates, Adjudications, Receipts, Graph Nodes/Edges, Fix Patterns, Anti-Patterns, Workarounds. |
| **Epistemic Model** | LLM transcript introspection (`claude -p`). | Multi-tier evidence: Live Telemetry (Tier 1) > Committed Disk (Tier 2) > Model Priors (Tier 3). |
| **Verification Gate** | Syntax/structure (regex, line count, link check). | Cryptographic SHA-256 hashes, DOM/CDP visual receipts, multi-stage phase gates. |
| **Human/Authority Gate** | Automatic promotion if static checks pass. | Explicit formal adjudication (`adjudications.scope IN ('production', 'acceptance-test')`). |
| **Execution Model** | Detached Python subprocesses running external CLI. | In-process native `node:sqlite` queries (zero daemon). |

### 5.2 Autoharness vs. OMp Autolearn & Runtime Harness

| Architectural Dimension | `tigerless-labs/autoharness` | OMp Host Harness & Runtime |
| :--- | :--- | :--- |
| **System Identity** | Plugin running *inside* an agent runtime. | The Host Agent Harness itself. |
| **Reflection Engine** | Subprocess invocation of `claude -p` CLI. | Native `task` subagent dispatcher (`maxConcurrency: 32`, multi-model routing via `modelRoles`). |
| **Session Reflection Hook** | Intercepts `Stop` and `SessionEnd` via Python hook. | Native `cfg://autolearn` (`enabled: false`, `minToolCalls: 5`). |
| **Long-Term Memory** | Flat file mutations in `.claude/skills/`. | Memory options: `mnemopi` (episodic vector/FTS SQLite) and `hindsight` (mental models, world/experience recall). |
| **Skill Management** | Single target: `.claude/skills/`. | Multi-tier skill paths: `.agents/skills`, `.claude/skills`, `.pi/skills`, `skills.registryUrl`. |
| **Permission Model** | Bypasses safety via `--dangerously-skip-permissions`. | Strict tool approvals (`tools.approvalMode`), interceptors, and sandboxes. |

---

## 6. Architectural Fit Assessment for AntiFan

### Verdict: HARD REFUSAL / ARCHITECTURALLY UNFIT (Score: 3/20)

1. **Breach of Execution-Only Invariant:**
   - AntiFan's primary contract states (`README.md#29`, `docs/operations.md#3-6`):
     > *"External agents own reasoning and authorized repairs; AntiFan owns execution and verification evidence. Không chứa AI loop hoặc daemon riêng; Chromium, Terminal và Bridge chạy trong một ứng dụng desktop cục bộ."*
   - Even though `autoharness` is hook-triggered rather than a continuous daemon, embedding background LLM reflection processes inside AntiFan violates AntiFan's non-cognitive boundary.
2. **Subprocess and Process Boundaries:**
   - AntiFan runs inside an Electron desktop shell alongside Chromium `WebContentsView`, active CDP connections, and terminal PTYs. Detaching background Python CLI runs inside the desktop app risks socket leaks and process contention.
3. **Data Redundancy with Super Core:**
   - AntiFan already provides a production-grade relational knowledge system in `packages/super-core`. Storing loose markdown skills inside AntiFan creates split-brain state and conflicts with Super Core's formal `receipt_v2` and `ingest_outcome` contracts.

---

## 7. Architectural Fit Assessment for OMp

### Verdict: HIGH VALUE ALGORITHMIC ADOPTION / UNVERIFIED DIRECT FIT (Score: 16/20)

1. **Integration Realities & Risks `[INFERENCE]`:**
   - OMp does not expose an established Claude Code plugin lifecycle hook runner (`hooks.json`) in inspected settings.
   - Invoking `claude -p` requires external authentication and CLI availability, bypassing OMp's unified provider routing (`modelRoles`).
   - Detached subprocesses evade OMp's active process supervision (`proc://`) and job tracking.
2. **Algorithmic Value for OMp's `cfg://autolearn`:**
   - OMp already has `cfg://autolearn` (`enabled: false`, `minToolCalls: 5`), but lacks automated promoter filtering and call-rate pruning.
   - Porting `autoharness`'s **Promoter Gate** (rule-altitude line cap, trigger regex, subfile whitelist) protects OMp from skill bloat.
   - Porting the **Lifecycle Contention Engine** ($use / (requests - anchor)$) gives OMp automated garbage collection for `.agents/skills/`.

---

## 8. Integration Feasibility & Implementation Options

```
+-----------------------------------------------------------------------------------+
|                        Conceptual Architecture (Inference)                        |
|                                                                                   |
|   +----------------------------+             +--------------------------------+   |
|   | AntiFan Browser Desktop    |             | OMp Host Agent Harness         |   |
|   | - WebContentsView / CDP    |             | - Core Agent Loop              |   |
|   | - Terminal PTYs            |             | - cfg://autolearn              |   |
|   | - Super Core (core.db)     |             | - Native `task` Subagents      |   |
|   +--------------+-------------+             +---------------+----------------+   |
|                  |                                           |                    |
|                  | (Verified Receipts / Evidence)            | (Trigger at Stop)  |
|                  v                                           v                    |
|   +----------------------------+             +--------------------------------+   |
|   | Super Core Outcome Adapter |             | Native OMp Extension /         |   |
|   | ingestOutcome / receipts   |             |   Autolearn Promoter           |   |
|   +--------------+-------------+             +---------------+----------------+   |
|                  |                                           |                    |
|                  +---------------------+---------------------+                    |
|                                        |                                          |
|                                        v                                          |
|                         +------------------------------+                          |
|                         | Deterministic Promoter Gate  |                          |
|                         | - Rule-altitude body cap     |                          |
|                         | - Single-line trigger budget |                          |
|                         | - Whitelist / Atomic commit  |                          |
|                         +--------------+---------------+                          |
|                                        |                                          |
|                                        v                                          |
|                         +------------------------------+                          |
|                         | .agents/skills/ (OMp Skills) |                          |
|                         | Lifecycle: use/(reqs-anchor) |                          |
|                         +------------------------------+                          |
+-----------------------------------------------------------------------------------+
```

### Implementation Options
- **Option A (Direct Plugin):** `[NOT RECOMMENDED / UNVERIFIED]` Attempting to drop `.claude-plugin/` directly into OMp. Highly likely to fail due to hook interface mismatch.
- **Option B (Super Core Read-Only Exporter):** `[FEASIBLE]` A utility compiling verified `core.fix_patterns` from AntiFan Super Core into standard `.agents/skills/` without adding cognitive loops to AntiFan.
- **Option C (Native OMp Algorithmic Port):** `[RECOMMENDED INFERENCE]` Re-implement the promoter linter and lifecycle mathematics in TypeScript/Node for OMp, using OMp's native `task` subagent for reflection instead of external CLI binaries.

---

## 9. Strategic Recommendations & Actionable Next Steps

1. **For AntiFan:** **Do NOT adopt autoharness.** Maintain AntiFan's strict role as an execution, telemetry, and verification engine. Keep reasoning and skill synthesis in external agents.
2. **For OMp:** **Do not rely on direct plugin compatibility.** Instead, extract the promoter validation and lifecycle contention algorithms to power OMp's native `cfg://autolearn`.
3. **Immediate Action:** Keep `cfg://autolearn.enabled: false` until an admission gatekeeper is in place to avoid uncurated skill accumulation.

---

## 10. Unresolved Questions

1. Does OMp support native event listeners on turn completion inside `.omp/extensions/*`, or does autolearn run solely through harness internals?
2. When skills are retired via capacity contention, should OMp archive them to disk (`.agents/skills-archive/`) or tombstone them in an internal SQLite table?

---

## 11. Appendix: Ultra Verifier Ranking & Candidate Scoring

Five independent candidate evaluations were executed in parallel.

### Candidate Anonymization Mapping
- **Candidate A:** Candidate 2 (Full-depth systems & reliability engineering report)
- **Candidate B:** Candidate 1 (Comparative Markdown report)
- **Candidate C:** Candidate 4 (Structured JSON report with phased roadmap)
- **Candidate D:** Candidate 5 (Structured JSON report with boundary analysis)
- **Candidate E:** Candidate 3 (Concise mathematical JSON report)

### Scoring Matrix (Scale 1–20 per criterion, Max 100)

| Candidate | 1. Tech Depth | 2. Arch Alignment | 3. Feasibility | 4. Evidence | 5. Actionability | Total Score | Verdict |
| :--- | :---: | :---: | :---: | :---: | :---: | :---: | :--- |
| **Candidate A (Cand 2)** | **19** | **20** | **19** | **20** | **19** | **97 / 100** | **WINNER (Selected)** |
| **Candidate B (Cand 1)** | 17 | 18 | 16 | 17 | 16 | 84 / 100 | Defeated (Truncated scope) |
| **Candidate C (Cand 4)** | 16 | 18 | 17 | 15 | 18 | 84 / 100 | Defeated (JSON outline only) |
| **Candidate D (Cand 5)** | 16 | 17 | 16 | 15 | 17 | 81 / 100 | Defeated (Summary format) |
| **Candidate E (Cand 3)** | 15 | 16 | 15 | 14 | 16 | 76 / 100 | Defeated (Minimalist payload) |

### Verifier Rationale
Candidate A (Candidate 2) demonstrated superior grounding across all dimensions, inspecting the exact schemas (`schema.ts`), documentation (`operations.md`, `README.md`), and OMp settings (`cfg://`). It correctly recognized the non-cognitive invariant of AntiFan, addressed the runtime divergence of the Claude Code plugin model, and provided concrete mathematical and architectural specifications for potential porting.
