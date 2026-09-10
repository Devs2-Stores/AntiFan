#!/usr/bin/env node
/**
 * Structural gate for a Haravan theme source tree and for its captured pages.
 *
 * Renders nothing and needs no browser: it answers "did this theme declare what it
 * reads, can its schema be parsed, do its assets exist, and did a rendered page leak
 * a Liquid failure" from the source and the captured HTML alone. A pixel verdict over
 * a page that silently contains `Liquid error` would publish a number that looks like
 * fidelity, which is why this gate runs beside the capture rather than after it.
 *
 *   node scripts/theme-checks.mjs --theme <themeDir> [--html <captured.html>]... [--out <report.json>]
 *
 * Exit codes: 0 everything checked is clean, 2 usage, 3 at least one check refused.
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  scanRenderFailures,
  validateThemeSchemas,
  checkSettingsBinding,
  checkAssetReferences,
} from './lib/theme-checks.mjs';

function parseArgv(argv) {
  const options = { themeDir: null, htmlFiles: [], outFile: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--theme') { options.themeDir = argv[++i] ?? null; continue; }
    if (arg === '--html') { const file = argv[++i]; if (file) options.htmlFiles.push(file); continue; }
    if (arg === '--out') { options.outFile = argv[++i] ?? null; continue; }
    return { ok: false, reason: `unrecognised argument '${arg}'` };
  }
  if (!options.themeDir) return { ok: false, reason: '--theme <themeDir> is required' };
  return { ok: true, options };
}

const parsed = parseArgv(process.argv.slice(2));
if (!parsed.ok) {
  console.error(`[theme-checks] USAGE (exit 2): ${parsed.reason}`);
  console.error('  node scripts/theme-checks.mjs --theme <themeDir> [--html <captured.html>]... [--out <report.json>]');
  process.exit(2);
}
const { themeDir, htmlFiles, outFile } = parsed.options;
if (!fs.existsSync(themeDir) || !fs.statSync(themeDir).isDirectory()) {
  console.error(`[theme-checks] THEME_DIR_UNREADABLE (exit 2): ${themeDir} is not a directory`);
  process.exit(2);
}

const schemas = validateThemeSchemas(themeDir);
const binding = checkSettingsBinding(themeDir);
const assets = checkAssetReferences(themeDir);
const renders = htmlFiles.map((file) => {
  const html = fs.readFileSync(file, 'utf8');
  const result = scanRenderFailures(html);
  return { file: path.basename(file), ok: result.ok, failures: result.failures };
});
const refusals = [];
if (!schemas.ok) refusals.push({ check: 'schema', failures: schemas.failures });
if (!binding.ok) refusals.push({ check: 'settings-binding', failures: binding.failures });
if (!assets.ok) refusals.push({ check: 'assets', failures: assets.localMissing.map((a) => ({ rule: 'ASSET_MISSING_LOCAL', ...a })) });
for (const render of renders) {
  if (!render.ok) refusals.push({ check: 'render', file: render.file, failures: render.failures });
}

const report = {
  themeDir: path.resolve(themeDir),
  generatedAt: new Date().toISOString(),
  ok: refusals.length === 0,
  schemas: { ok: schemas.ok, schemaFiles: schemas.schemaFiles, sectionCount: schemas.sections.length, failures: schemas.failures },
  settingsBinding: { ok: binding.ok, undeclared: binding.undeclared, dead: binding.dead, failures: binding.failures },
  assets: { ok: assets.ok, counts: assets.counts, localMissing: assets.localMissing, remote: assets.remote },
  renders,
  refusals,
};
if (outFile) fs.writeFileSync(outFile, JSON.stringify(report, null, 2));

console.log(`[theme-checks] theme=${report.themeDir}`);
console.log(`[theme-checks] schema: schemaFiles=${schemas.schemaFiles.length} sections=${schemas.sections.length} failures=${schemas.failures.length}`);
console.log(`[theme-checks] settings: undeclared=${binding.undeclared.length} dead=${binding.dead.length} failures=${binding.failures.length}`);
console.log(`[theme-checks] assets: localPresent=${assets.counts.localPresent} localMissing=${assets.counts.localMissing} remote=${assets.counts.remote}`);
for (const render of renders) {
  console.log(`[theme-checks] render ${render.file}: ok=${render.ok} failures=${render.failures.length}`);
}
if (outFile) console.log(`[theme-checks] report -> ${path.resolve(outFile)}`);
if (!report.ok) {
  console.error(`[theme-checks] REFUSED (exit 3): ${refusals.map((r) => r.check).join(', ')}`);
  process.exit(3);
}
console.log('[theme-checks] clean');
