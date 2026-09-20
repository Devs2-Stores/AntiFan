# AntiFan Soak Switch Latency Tail & Distribution Shift Analysis (2026-09-20)

## 0. Executive Summary & Context

- **Gate Status Note**: Per operator decision on 2026-09-20 (`plans/260920-0100-soak-4h-workflow-performance/plan.md`, Phase 3c), the 35 ms `max` bound is **no longer a gate**. The production soak SLO is `p50 <= 12 ms && p95 <= 18 ms` evaluated strictly on the `workload` phase. The maximum latency (`switchLatencyMaxMs`) is reported as diagnostic context only (`latencyMaxGated: false`). The `switchMax <= 35` term was removed from `evaluateFreezeVerdict` in `scripts/benchmark-real-soak-8h.cjs` and is defended against regression by `test/unit/soak-latency-gate.test.mjs` (which fails 2 of 6 test cases if the threshold is reinstated).
- **Core Empirical Question**: In the 2 h run (`real-soak-2h.json`), maximum switch latency was 42.112 ms against a 35 ms bound while p95 was 6.821 ms (1 sample out of 1756). Is that maximum an isolated one-off outlier, or a repeating steady-state condition?
- **Finding from Committed Disk Payloads**:
  1. **Not a one-off outlier**: The tail (>35 ms) is a **repeating, steady-state condition**. In the full-series checkpoint (`real-soak-8h-legs4h-checkpoint.json`, N=1143), 22 switches (1.92%) exceeded 35 ms and 9 switches (0.79%) exceeded 40 ms. In the 4 h soak (`real-soak-8h-soak4h.json`), 8 of the 10 slowest switches fell in the steady-state workload phase, reaching 50.976 ms.
  2. **Not a destination artifact**: All 6 tab destinations breach 35 ms across multiple runs (in `legs4h`, all 6 breach 35 ms; in `soak4h`, all 6 reach 38.10–50.98 ms; in `preflight-fixed`, all 6 reach 41.22–50.51 ms). The hypothesis that stalls were an idiosyncratic cost of external pages (Wikipedia/Google) is refuted.
  3. **Not a harness scrape collision**: Stalls do not cluster around the harness's 60 s process-tree sampling tick; when binned across 12 five-second intervals of the 60 s sampling period, stalls land across 9 of the 12 bins with no concentration at bin 0.
  4. **Global distribution shift**: Across comparable runs, the entire switch distribution shifted upward by ~2.5×. Minimum latency shifted from 3.092 ms (2 h baseline) to 6.76–8.98 ms; median (p50) shifted from 4.972 ms to 10.35–12.64 ms; p95 shifted from 6.821 ms to 15.51–17.58 ms. Telemetry traces in `stdoutBenchmarkTail` confirm this shift occurred directly inside the synchronous main-process execution of `NativeTabHost.switchTab()` (`tabs.switched` increased from ~3.2–4.2 ms to ~8.0–11.3 ms), while layout execution remained negligible (<0.2 ms).

---

## 1. Cross-Payload Inventory & Exceedance Counts (>35 ms, >40 ms, >50 ms)

Every soak report artifact on disk was inspected for switch latency metrics, individual sample series, and top-ten slow sample lists.

| Artifact (`plans/reports/runtime-verification/`) | Total Switches | Min (ms) | P50 (ms) | P95 (ms) | Max (ms) | >35 ms Count (Denom) | >40 ms Count (Denom) | >50 ms Count (Denom) | Available Telemetry Granularity |
|---|---|---|---|---|---|---|---|---|---|
| `real-soak-2h.json` (2026-09-19) | 1,756 | 3.092 | 4.972 | 6.821 | 42.112 | ≥ 1 / 1,756 | ≥ 1 / 1,756 | 0 / 1,756 | Quantiles only (series not retained) |
| `real-soak-partial-20260919-0820.json` | 1,362 | 6.800 | 9.120 | 12.028 | 41.752 | ≥ 1 / 1,362 | ≥ 1 / 1,362 | 0 / 1,362 | Quantiles only |
| `real-soak-8h.json` (2026-09-04) | 5,450 | 5.153 | 7.513 | 9.161 | 34.147 | 0 / 5,450 | 0 / 5,450 | 0 / 5,450 | Quantiles only (clean baseline) |
| `real-soak-8h-diag1.json` | 769 | 7.376 | 9.630 | 12.276 | 43.904 | **6 / 769 (0.78%)** | 1 / 769 (0.13%) | 0 / 769 (0.00%) | `slowSwitchSamples` (10 items; #7 is 34.81 ms, so 6 is exact) |
| `real-soak-8h-soak4h.json` (2026-09-20) | 4,090 | 6.760 | 10.346 | 15.513 | 50.976 | ≥ 10 / 4,090 | ≥ 10 / 4,090 | ≥ 1 / 4,090 | `switchLatencyByTab` (6/6 tabs >35 ms) + `slowSwitchSamples` (all 10 >40 ms) |
| `real-soak-8h-preflight-fixed.json` | 1,163 (wl) / 1,409 (all) | 8.984 | 12.318 | 16.779 | 50.505 (all) / 47.869 (wl) | ≥ 10 / 1,409 | ≥ 10 / 1,409 | ≥ 1 / 1,409 | `switchLatencyByTab` (6/6 tabs >41 ms) + `slowSwitchSamples` (all 10 >40 ms) |
| `real-soak-8h-legs4h-checkpoint.json` | 1,143 (572 wl) | 7.171 | 12.640 | 17.584 | 45.476 | **22 / 1,143 (1.92%)** | **9 / 1,143 (0.79%)** | **0 / 1,143 (0.00%)** | **Full series retained** (1,143 rows with timestamps, phase, leg, tabId) |

*Field tracing notes*:
- `Total Switches`: tracked in `counters.switches`, `stats.switches`, or `metrics.switchLatencyWorkloadCount`.
- `Quantiles`: tracked in `metrics.switchLatencyMs` (and `metrics.switchLatencyWarmupMs` / `switchLatencyAllPhasesMs` in newer runs).
- `slowSwitchSamples`: array of `{ at, ms, tabId, phase, leg }` capturing the 10 slowest switches in runs predating the full-series writer.
- `switchSamples`: array of every individual switch event introduced in commit `b341f4a` / CHANGELOG 2026-09-20.

---

## 2. Full-Series Analysis (`real-soak-8h-legs4h-checkpoint.json`, N=1,143)

`real-soak-8h-legs4h-checkpoint.json` is the single artifact carrying the **complete switch series** (1,143 switches over 63 minutes before being stopped by operator request at 08:10 local). It provides empirical counts with exact denominators.

### 2.1 Breakdown by Phase and Leg

| Group | Total Switches (Denom) | >35 ms Count (%) | >40 ms Count (%) | >50 ms Count (%) | P50 (ms) | P95 (ms) | Max (ms) |
|---|---|---|---|---|---|---|---|
| **All Samples** | 1,143 | **22 (1.92%)** | **9 (0.79%)** | 0 (0.00%) | 12.822 | 18.205 | 45.476 |
| **Warmup Phase** (leg: null) | 571 | 12 (2.10%) | 4 (0.70%) | 0 (0.00%) | 13.011 | 18.876 | 43.855 |
| **Workload Phase** (leg: `baseline#1`) | 572 | 10 (1.75%) | 5 (0.87%) | 0 (0.00%) | 12.640 | 17.584 | 45.476 |

The stall rate is virtually identical between warmup (21.02 per 1,000) and steady-state workload (17.48 per 1,000). The tail is not a transient ramp-up artifact.

### 2.2 Breakdown by Destination Tab

| Destination URL | Tab ID | Total Switches | >35 ms Count (%) | >40 ms Count (%) | >50 ms Count (%) | Tab P50 (ms) | Tab P95 (ms) | Tab Max (ms) |
|---|---|---|---|---|---|---|---|---|
| `http://127.0.0.1:51339/store-home` | `a2810597` | 191 | 4 (2.09%) | 2 (1.05%) | 0 (0.00%) | 13.122 | 23.926 | 43.855 |
| `http://127.0.0.1:51339/collection-featured` | `ff5c9a1c` | 191 | 7 (3.66%) | 1 (0.52%) | 0 (0.00%) | 12.611 | 23.250 | 40.258 |
| `http://127.0.0.1:51339/product-test-1` | `88fa5d53` | 191 | 2 (1.05%) | 1 (0.52%) | 0 (0.00%) | 12.246 | 16.366 | 41.450 |
| `http://127.0.0.1:51339/product-test-2` | `29fb34db` | 190 | 3 (1.58%) | 1 (0.53%) | 0 (0.00%) | 12.324 | 16.571 | 42.780 |
| `https://example.com` | `c49550af` | 190 | 1 (0.53%) | 0 (0.00%) | 0 (0.00%) | 12.401 | 17.100 | 36.988 |
| `https://www.wikipedia.org` | `6a69f961` | 190 | 5 (2.63%) | 4 (2.11%) | 0 (0.00%) | 14.574 | 18.876 | 45.476 |

**Finding**: **Every single destination tab exceeds 35 ms**, and 5 of the 6 exceed 40 ms. The exceedances are not driven by external complexity or page weight: local test fixtures (`collection-featured`, `store-home`) exhibit equal or greater stall counts than Wikipedia.

### 2.3 Temporal Distribution & Gap Analysis (>35 ms)

Across the 63-minute duration of the run, exactly 22 switch events exceeded 35 ms.

| # | Timestamp (UTC) | Latency (ms) | Gap to Prev (s) | Phase | Leg | Destination |
|---|---|---|---|---|---|---|
| 1 | 00:15:36.307 | 41.446 | N/A | warmup | null | `https://www.wikipedia.org` |
| 2 | 00:16:33.312 | 39.986 | 57.0s | warmup | null | `https://www.wikipedia.org` |
| 3 | 00:19:48.894 | 36.873 | 195.6s | warmup | null | `.../collection-featured` |
| 4 | 00:20:15.288 | 42.780 | 26.4s | warmup | null | `.../product-test-2` |
| 5 | 00:22:01.312 | 35.205 | 106.0s | warmup | null | `.../collection-featured` |
| 6 | 00:22:55.184 | 43.855 | 53.9s | warmup | null | `.../store-home` |
| 7 | 00:23:45.976 | 36.988 | 50.8s | warmup | null | `https://example.com` |
| 8 | 00:27:04.700 | 37.531 | 198.7s | warmup | null | `.../collection-featured` |
| 9 | 00:28:01.598 | 38.436 | 56.9s | warmup | null | `.../collection-featured` |
| 10 | 00:32:24.977 | 39.239 | 263.4s | warmup | null | `.../store-home` |
| 11 | 00:33:49.727 | 39.117 | 84.8s | warmup | null | `.../product-test-2` |
| 12 | 00:36:34.704 | 40.258 | 165.0s | warmup | null | `.../collection-featured` |
| 13 | 00:38:02.385 | 40.602 | 87.7s | workload | `baseline#1` | `https://www.wikipedia.org` |
| 14 | 00:39:47.025 | 36.818 | 104.6s | workload | `baseline#1` | `.../product-test-1` |
| 15 | 00:40:56.388 | 39.621 | 69.4s | workload | `baseline#1` | `.../store-home` |
| 16 | 00:42:28.811 | 41.866 | 92.4s | workload | `baseline#1` | `https://www.wikipedia.org` |
| 17 | 00:43:31.846 | 39.886 | 63.0s | workload | `baseline#1` | `.../collection-featured` |
| 18 | 00:45:38.100 | 45.476 | 126.3s | workload | `baseline#1` | `https://www.wikipedia.org` |
| 19 | 00:58:54.356 | 41.090 | 796.3s | workload | `baseline#1` | `.../store-home` |
| 20 | 01:00:39.202 | 36.338 | 104.8s | workload | `baseline#1` | `.../product-test-2` |
| 21 | 01:03:45.533 | 41.450 | 186.3s | workload | `baseline#1` | `.../product-test-1` |
| 22 | 01:06:30.174 | 36.812 | 164.6s | workload | `baseline#1` | `.../collection-featured` |

**Gap summary statistics** (N = 21 consecutive intervals):
- Minimum gap: **26.4 s**
- Median gap: **104.6 s** (~1.75 minutes)
- Mean gap: **145.4 s** (~2.4 minutes)
- Maximum gap: **796.3 s** (~13.3 minutes)

**Verdict on Clustering vs. Scattering**: The exceedances **do not cluster in a single burst or storm**. They are uniformly scattered across the entire run, occurring roughly every 1 to 3 minutes, with an occasional longer quiet period.

### 2.4 Correlation with Harness 60 s Scrapes

The soak harness executes a process-tree memory walk every 60 s (`sampleIntervalSeconds: 60`). If switch stalls were caused by CPU starvation during the tree walk, stalls would concentrate within the first few seconds of each 60 s cycle.

Position of all switches and stalls within the 60 s cycle divided into twelve 5-second bins:

| 5-second Bin | 0–5 s | 5–10 s | 10–15 s | 15–20 s | 20–25 s | 25–30 s | 30–35 s | 35–40 s | 40–45 s | 45–50 s | 50–55 s | 55–60 s |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| **Stalls (≥35 ms)** | 4 | 0 | 0 | 1 | 1 | 1 | 4 | 3 | 0 | 5 | 1 | 2 |
| **All Switches** | 102 | 91 | 73 | 97 | 101 | 90 | 103 | 99 | 92 | 102 | 97 | 96 |

Stalls are distributed across 9 of the 12 bins (including bins 15–20s, 30–35s, 45–50s, 55–60s). There is no pile-up at bin 0 (4 stalls out of 22). The scrape-collision hypothesis is refuted.

---

## 3. Shifted Distribution Across Comparable Runs

Comparing directly comparable runs on the repository reveals a macro-level shift in the entire latency distribution:

| Run Artifact | Workload Config | Total Switches | Min Latency (ms) | P50 Latency (ms) | P95 Latency (ms) | Max Latency (ms) |
|---|---|---|---|---|---|---|
| `real-soak-2h.json` | 60 min workload (30m wu / 30m rec) | 1,756 | **3.092** | **4.972** | **6.821** | **42.112** |
| `real-soak-partial-20260919-0820.json` | 40 min workload | 1,362 | **6.800** | **9.120** | **12.028** | **41.752** |
| `real-soak-8h-soak4h.json` | 180 min workload | 4,090 | **6.760** | **10.346** | **15.513** | **50.976** |
| `real-soak-8h-preflight-fixed.json` | 60 min workload | 1,163 (wl) | **8.984** | **12.318** | **16.779** | **47.869** |
| `real-soak-8h-legs4h-checkpoint.json` | 30 min workload (`baseline#1`) | 572 (wl) | **7.171** | **12.640** | **17.584** | **45.476** |

### Shift Quantification:
1. **Floor (Min)**: Shifted from **3.092 ms** (baseline 2 h) to **6.76–8.98 ms** (~2.2× to 2.9× increase).
2. **Median (P50)**: Shifted from **4.972 ms** to **10.35–12.64 ms** (~2.1× to 2.5× increase).
3. **95th Percentile (P95)**: Shifted from **6.821 ms** to **15.51–17.58 ms** (~2.3× to 2.6× increase).
4. **Tail (Max)**: Shifted from **42.112 ms** to **45.48–50.98 ms**.

### Grounding via App Internal Telemetry (`stdoutBenchmarkTail`)
Inside `src/main/browser/native-tab-host.ts:4599`, the Electron main process records its own synchronous execution time for `switchTab`:
```typescript
recordBenchmark({
  surface: 'tabs',
  name: 'switched',
  value: performance.now() - switchStartMs,
  extra: { attachedViews: this.countAttachedViews() },
});
```
Inspecting `stdoutBenchmarkTail` in the respective artifacts reveals:
- In `real-soak-2h.json`: internal `tabs.switched` samples averaged **~3.2–4.2 ms** (samples: 2.48, 3.17, 3.23, 3.24, 3.38, 4.02, 4.14, 4.20, 5.18 ms).
- In `real-soak-8h-preflight-fixed.json` and `real-soak-8h-legs4h-checkpoint.json`: internal `tabs.switched` samples averaged **~8.8–11.3 ms** (samples: 7.23, 7.77, 8.02, 8.18, 8.44, 8.85, 8.88, 8.89, 9.15, 9.92, 9.95, 9.97, 10.02, 10.53, 10.65, 10.80, 11.08, 11.24, 11.32, 13.52 ms).
- `tabs.layout` stayed negligible across all runs: **0.11–0.22 ms**.
- The delta between the internal timer and the outer harness RPC round-trip timer is stable at **~1.5–2.0 ms** across all runs (accounting for WebSocket framing, loopback dispatch, and serialization).
- **Conclusion**: The entire distribution shift occurred **internally within the main-process synchronous execution of `NativeTabHost.switchTab()`**, not on the transport plane.

---

## 4. Attribution Boundaries: What the Data Can and Cannot Say

### What the Data CAN Say (Observed Facts)
1. **The tail is a steady-state property**: Stalls >35 ms happen during active workload, not merely startup or tab creation.
2. **The tail is global across all destinations**: Every open tab experiences stalls >35 ms at approximately 1% to 3% frequency.
3. **The tail is not harness scrape interference**: Stalls do not correlate with the 60 s process walk.
4. **The tail is not clustered**: Stalls are separated by a median interval of ~105 s.
5. **The shift is in synchronous main-process execution**: The execution duration of `switchTab` itself increased from ~3.6 ms to ~10.5 ms.

### What the Data CANNOT Say (Attribution Gaps)
1. **Contamination vs. Internal Regression**:
   - The baseline 2 h run ran in an isolated session with 0 machine sleep and minimal background activity.
   - Later runs (`soak4h`, `preflight-fixed`, `legs4h`) ran on a 4-core host (Intel i5-9300H, 4 cores / 8 threads) concurrently sharing the machine with user applications (Zalo instances, browser, terminal host daemon) and active background development tasks (TypeScript compilation, test suite executions).
   - The data cannot mathematically separate what portion of the shift (from 5 ms to 12 ms p50) is OS CPU thread scheduling starvation versus internal JavaScript / DOM state overhead.
2. **Sub-Step Breakdown within `switchTab`**:
   - `NativeTabHost.switchTab()` executes several synchronous operations in sequence:
     - View attachment / detachment in Electron `contentView` (`removeChildView` / `addChildView`).
     - Inactive view cleanup loop over all entries in `this.tabs`.
     - Orphan view sweep walking `this.window.contentView.children`.
     - `this.updateLayout()` (verified negligible at ~0.15 ms).
     - Microtask queueing for `broadcastState()`.
     - `webContents.focus()` and `webContents.invalidate()`.
   - The current internal telemetry emits only one aggregated `tabs.switched` timer. The data on disk cannot tell which specific sub-step is responsible for the occasional 40–50 ms spikes.
3. **Terminal PTY Burst Volume Correlation**:
   - Because the 4 h leg bisect was stopped after Leg 1 (`baseline#1`), Leg 2 (`burst4x` at 1,200 lines/30s) and Leg 3 (`burst-off` at 1 line/600s) never executed. The hypothesis that heavy PTY writes starve the switch path remains unverified across burst volume regimes.

### The Single Next Probe to Identify the Stall Source
- **Does it need a live run?** **YES**. Existing payloads only record the monolithic timer.
- **Probe Specification**:
  A non-invasive 10-minute targeted probe (or brief test run) instrumenting `NativeTabHost.switchTab()` with fine-grained sub-step monotonic timings:
  ```typescript
  // Emitted under surface: 'tabs', name: 'switchBreakdown'
  {
    viewHierarchyMs: t1 - t0,       // removeChildView + addChildView + orphan sweep
    layoutMs: t2 - t1,              // updateLayout()
    focusInvalidateMs: t3 - t2,     // webContents.focus() + webContents.invalidate()
    eventLoopLagMs: currentLag,     // monitorEventLoopDelay sampling
    totalMs: performance.now() - switchStartMs
  }
  ```
  If a 45 ms stall has `focusInvalidateMs = 40 ms`, the root cause is Chromium renderer message-pump synchronization. If `viewHierarchyMs = 40 ms`, the root cause is Windows DWM / DirectComposition child view manipulation. If `totalMs = 45 ms` while all internal steps sum to 4 ms, the stall is event-loop queue latency before `switchTab` is entered.

---

## 5. Recomputation & Reproduction Commands

All counts, quantiles, destination tables, temporal gaps, and sampling bin histograms in this report can be recomputed directly from the disk artifacts in under 1 second using the helper script:

```bash
node plans/reports/runtime-verification/analyze-tail-spikes.cjs
```

Or via inline command:
```bash
node -e "const fs = require('fs'); const d = JSON.parse(fs.readFileSync('plans/reports/runtime-verification/real-soak-8h-legs4h-checkpoint.json')); const s = d.switchSamples; console.log({ total: s.length, gt35: s.filter(x => x.ms > 35).length, gt40: s.filter(x => x.ms > 40).length, gt50: s.filter(x => x.ms > 50).length });"
```
*Expected output*: `{ total: 1143, gt35: 22, gt40: 9, gt50: 0 }`.
