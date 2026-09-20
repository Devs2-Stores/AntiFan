const fs = require('fs');
const path = require('path');

const dir = path.join(__dirname);
const files = [
  'real-soak-2h.json',
  'real-soak-partial-20260919-0820.json',
  'real-soak-8h.json',
  'real-soak-8h-diag1.json',
  'real-soak-8h-soak4h.json',
  'real-soak-8h-preflight-fixed.json',
  'real-soak-8h-legs4h-checkpoint.json'
];

console.log('========================================================================');
console.log('ANTI-FAN SOAK SWITCH LATENCY TAIL & DISTRIBUTION ANALYSIS');
console.log('========================================================================\n');

console.log('--- SECTION 1: CROSS-PAYLOAD SUMMARY & EXCEEDANCE COUNTS ---');
console.log(
  'File'.padEnd(42) +
  'TotalSw'.padStart(9) +
  'Min(ms)'.padStart(9) +
  'P50(ms)'.padStart(9) +
  'P95(ms)'.padStart(9) +
  'Max(ms)'.padStart(9) +
  '  >35ms'.padEnd(14) +
  '  >40ms'.padEnd(14) +
  '  >50ms'.padEnd(10)
);
console.log('-'.repeat(125));

for (const f of files) {
  const full = path.join(dir, f);
  if (!fs.existsSync(full)) continue;
  const d = JSON.parse(fs.readFileSync(full, 'utf8'));
  const m = d.metrics || {};
  const q = m.switchLatencyMs || {};
  const total = m.switchLatencyWorkloadCount ?? d.counters?.switches ?? d.stats?.switches ?? d.switches ?? 0;
  
  const samples = d.switchSamples || [];
  const slow = d.slowSwitchSamples || m.slowSwitchSamples || [];
  
  let c35 = 'N/A';
  let c40 = 'N/A';
  let c50 = 'N/A';
  
  if (samples.length > 0) {
    const n35 = samples.filter(s => s.ms > 35).length;
    const n40 = samples.filter(s => s.ms > 40).length;
    const n50 = samples.filter(s => s.ms > 50).length;
    c35 = `${n35}/${samples.length} (${(n35/samples.length*100).toFixed(2)}%)`;
    c40 = `${n40}/${samples.length} (${(n40/samples.length*100).toFixed(2)}%)`;
    c50 = `${n50}/${samples.length} (${(n50/samples.length*100).toFixed(2)}%)`;
  } else if (slow.length > 0) {
    const n35 = slow.filter(s => s.ms > 35).length;
    const n40 = slow.filter(s => s.ms > 40).length;
    const n50 = slow.filter(s => s.ms > 50).length;
    if (slow.length === 10 && slow[9].ms < 35) {
      c35 = `${n35}/${total} (exact)`;
      c40 = `${n40}/${total} (exact)`;
      c50 = `${n50}/${total} (exact)`;
    } else {
      c35 = `≥${n35}/${total} (top10)`;
      c40 = `≥${n40}/${total} (top10)`;
      c50 = `≥${n50}/${total} (top10)`;
    }
  } else if (q.max !== undefined && q.max !== null) {
    c35 = q.max > 35 ? `≥1/${total}` : `0/${total}`;
    c40 = q.max > 40 ? `≥1/${total}` : `0/${total}`;
    c50 = q.max > 50 ? `≥1/${total}` : `0/${total}`;
  }
  
  const minStr = q.min !== undefined && q.min !== null ? q.min.toFixed(3) : '-';
  const p50Str = q.p50 !== undefined && q.p50 !== null ? q.p50.toFixed(3) : '-';
  const p95Str = q.p95 !== undefined && q.p95 !== null ? q.p95.toFixed(3) : '-';
  const maxStr = q.max !== undefined && q.max !== null ? q.max.toFixed(3) : '-';

  console.log(
    f.padEnd(42) +
    String(total).padStart(9) +
    minStr.padStart(9) +
    p50Str.padStart(9) +
    p95Str.padStart(9) +
    maxStr.padStart(9) +
    '  ' + c35.padEnd(14) +
    '  ' + c40.padEnd(14) +
    '  ' + c50.padEnd(10)
  );
}

// Deep dive into real-soak-8h-legs4h-checkpoint.json
const legsCheckpoint = path.join(dir, 'real-soak-8h-legs4h-checkpoint.json');
if (fs.existsSync(legsCheckpoint)) {
  const d = JSON.parse(fs.readFileSync(legsCheckpoint, 'utf8'));
  const samples = d.switchSamples || [];
  const tabUrls = {};
  if (d.metrics && d.metrics.switchLatencyByTab) {
    for (const t of d.metrics.switchLatencyByTab) tabUrls[t.tabId] = t.url;
  }

  console.log('\n--- SECTION 2: FULL-SERIES ANALYSIS (real-soak-8h-legs4h-checkpoint.json, N=1143) ---');
  
  const warmup = samples.filter(s => s.phase === 'warmup');
  const workload = samples.filter(s => s.phase === 'workload');
  
  function stats(rows, label) {
    const t = rows.length;
    const n35 = rows.filter(s => s.ms > 35).length;
    const n40 = rows.filter(s => s.ms > 40).length;
    const n50 = rows.filter(s => s.ms > 50).length;
    return {
      label,
      total: t,
      gt35: n35,
      pct35: t ? (n35 / t * 100).toFixed(2) + '%' : '0%',
      gt40: n40,
      pct40: t ? (n40 / t * 100).toFixed(2) + '%' : '0%',
      gt50: n50,
      pct50: t ? (n50 / t * 100).toFixed(2) + '%' : '0%',
    };
  }

  console.log('\n2.1 Breakdown by Phase and Leg:');
  console.table([
    stats(samples, 'All samples'),
    stats(warmup, 'Warmup phase (leg: null)'),
    stats(workload, 'Workload phase (leg: baseline#1)')
  ]);

  console.log('\n2.2 Breakdown by Destination Tab:');
  const byTab = {};
  for (const s of samples) {
    if (!byTab[s.tabId]) byTab[s.tabId] = [];
    byTab[s.tabId].push(s);
  }
  const tabRows = [];
  for (const [tabId, rows] of Object.entries(byTab)) {
    const url = tabUrls[tabId] || tabId;
    tabRows.push(stats(rows, url));
  }
  console.table(tabRows);

  console.log('\n2.3 Temporal Gap Analysis between Consecutive >35ms Exceedances:');
  const over35 = samples.filter(s => s.ms > 35);
  let prevAt = null;
  const gapsSec = [];
  over35.forEach((s, idx) => {
    const gap = prevAt !== null ? (s.at - prevAt) / 1000 : null;
    if (gap !== null) gapsSec.push(gap);
    prevAt = s.at;
    const timeStr = new Date(s.at).toISOString().substring(11, 23);
    console.log(
      `  Exceedance #${String(idx + 1).padStart(2)}: ${timeStr} | ${s.ms.toFixed(3).padStart(6)} ms | gap: ${gap !== null ? (gap.toFixed(1) + 's').padStart(7) : '    N/A'} | phase: ${s.phase.padEnd(8)} | leg: ${String(s.leg).padEnd(10)} | dest: ${tabUrls[s.tabId] || s.tabId}`
    );
  });

  const sortedGaps = [...gapsSec].sort((a, b) => a - b);
  const minGap = sortedGaps[0];
  const maxGap = sortedGaps[sortedGaps.length - 1];
  const medGap = sortedGaps[Math.floor(sortedGaps.length / 2)];
  const meanGap = gapsSec.reduce((a, b) => a + b, 0) / gapsSec.length;
  console.log(`\n  Gap Summary (N=${gapsSec.length}): min = ${minGap.toFixed(1)}s, median = ${medGap.toFixed(1)}s, mean = ${meanGap.toFixed(1)}s, max = ${maxGap.toFixed(1)}s`);

  console.log('\n2.4 Position inside the Harness 60s Sampling Interval:');
  const intervalMs = 60000;
  const BINS = 12;
  const binOf = (at) => Math.min(BINS - 1, Math.floor(((at % intervalMs) + intervalMs) % intervalMs / (intervalMs / BINS)));
  const stallBins = new Array(BINS).fill(0);
  for (const s of over35) stallBins[binOf(Number(s.at))]++;
  const allBins = new Array(BINS).fill(0);
  for (const s of samples) allBins[binOf(Number(s.at))]++;
  const width = intervalMs / BINS / 1000;
  console.log('  ' + 'bin(s)'.padEnd(10) + Array.from({ length: BINS }, (_, i) => `${(i * width).toFixed(0)}-${((i + 1) * width).toFixed(0)}`.padEnd(8)).join(''));
  console.log('  ' + '>=35ms'.padEnd(10) + stallBins.map(v => String(v).padEnd(8)).join(''));
  console.log('  ' + 'all'.padEnd(10) + allBins.map(v => String(v).padEnd(8)).join(''));
}
