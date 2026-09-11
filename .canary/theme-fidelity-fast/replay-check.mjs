// Scratch (untracked): replay every recorded leg of the retained run through the peer's
// checkObservedUrl, extracted verbatim from .canary/tools/theme-fidelity.mjs, to test whether
// wiring it in converts previously-measured legs into route refusals.
import fs from 'node:fs';
import path from 'node:path';

const tool = fs.readFileSync('.canary/tools/theme-fidelity.mjs', 'utf8');
const start = tool.indexOf('/** Normalize a route pathname');
const end = tool.indexOf('async function closeTab');
if (start < 0 || end < 0 || end <= start) {
  console.error('EXTRACT_FAILED ' + JSON.stringify({ start, end }));
  process.exit(2);
}
const extracted = tool.slice(start, end);
// The real helper throws a typed error; only its codes matter here, so a plain recorder stands in.
const refuse = (code, exitCode, message, detail) => ({ code, exitCode, message, detail });
const checkObservedUrl = new Function('refuse', extracted.replace(/\bexport /g, '') + '\nreturn checkObservedUrl;')(refuse);

const root = '.canary/theme-fidelity-run4/compare';
const sets = fs.readdirSync(root).filter((d) => fs.statSync(path.join(root, d)).isDirectory());
const rows = [];
for (const set of sets) {
  const dir = path.join(root, set);
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.json') && x !== 'index.json')) {
    const j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    for (const side of ['reference', 'subject']) {
      const p = j.provenance && j.provenance[side];
      if (!p) continue;
      const requested = p.url || null;
      const observed = (p.dom && p.dom.observedUrl) || null;
      const verdict = checkObservedUrl({ name: `${set}:${f}:${side}`, url: requested }, observed);
      rows.push({ set, file: f, side, requested, observed, refused: verdict ? verdict.code : null });
    }
  }
}

const byCode = {};
for (const r of rows) byCode[r.refused || 'OK'] = (byCode[r.refused || 'OK'] || 0) + 1;
console.log('legs replayed: ' + rows.length);
console.log('outcome by code: ' + JSON.stringify(byCode));
const bad = rows.filter((r) => r.refused);
console.log('refusing legs: ' + bad.length);
for (const r of bad.slice(0, 12)) {
  console.log('  ' + r.set + '/' + r.file + ' [' + r.side + '] ' + r.refused);
  console.log('     requested=' + r.requested);
  console.log('     observed =' + r.observed);
}
const noTheme = rows.filter((r) => {
  try { return !new URL(r.requested).searchParams.get('themeid'); } catch { return true; }
});
console.log('legs whose requested url carries no themeid: ' + noTheme.length);
for (const r of noTheme.slice(0, 5)) console.log('  ' + r.set + '/' + r.file + ' [' + r.side + '] requested=' + r.requested);
