#!/usr/bin/env node
/**
 * verify-changed: run only the checks a change affects.
 *
 *   node scripts/verify-changed.mjs [--base <git ref>] [--files a,b,...] [--plan]
 *                                   [--no-typecheck] [--out <dir>] [--jobs <n>]
 *
 * Plain `.mjs` unit tests run directly. TypeScript changes need one `tsc` pass and the compiled
 * tests that import the changed file; that pass emits into a private out dir (never `.compiled/`,
 * which a running desktop app loads), incrementally, so the next run is fast.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { availableParallelism } from 'node:os';
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SCRIPT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const DEFAULT_OUT_DIR = '.compiled-verify';

/** More compiled tests than this depend on a file: run its whole lane instead of listing them. */
export const DEPENDANT_THRESHOLD = 40;

/**
 * Where a changed file's tests live when it has too many dependants to list. First matching
 * prefix wins; a TypeScript file that matches none falls back to the `main` lane.
 */
export const LANE_BY_PREFIX = [
  { prefix: 'src/renderer/', lanes: ['renderer'], reason: 'renderer sources are exercised by the renderer lane' },
  { prefix: 'src/main/', lanes: ['main', 'src-tests'], reason: 'main-process sources are exercised by the main lane and colocated tests' },
  { prefix: 'src/shared/', lanes: ['main', 'renderer', 'unit'], reason: 'shared sources are used by main and renderer' },
  { prefix: 'src/omp-hooks/', lanes: ['unit'], reason: 'hook sources are covered by the unit lane' },
  { prefix: 'test/', lanes: ['main'], reason: 'shared test helpers are used mostly by the main lane' },
];
const DEFAULT_FALLBACK_LANES = ['main'];

/** Compiled test lanes: a source directory (and the file suffix that marks a test in it). */
export const LANES = {
  main: { dir: 'test/main', reason: 'package.json test:main' },
  renderer: { dir: 'test/renderer', reason: 'package.json test:renderer lane (test:fast)' },
  unit: { dir: 'test/unit', reason: 'package.json test:unit (compiled half)' },
  integration: { dir: 'test/integration', reason: 'package.json test:integration' },
  benchmark: { dir: 'test/benchmark', reason: 'package.json test:fast (benchmark)' },
  'src-tests': { dir: 'src', reason: 'tests colocated under src/ (test:fast)' },
};
/** Lanes that are a package of their own and run through npm. */
export const EXTERNAL_LANES = {
  'super-core': { cmd: ['npm', ['test', '--prefix', 'packages/super-core']], reason: 'package.json test:super-core' },
  'site-clone': { cmd: ['npm', ['run', 'test:site-clone']], reason: 'package.json test:site-clone' },
};

/**
 * Mapping from a changed file to checks. First matching rule wins; each rule says why.
 * `actions`: unit-self | unit-refs | typecheck | compiled-dependants | lane:<name> | static
 */
export const RULES = [
  { id: 'docs', match: /^(plans|reports|docs|scratch|clone)\/|\.md$|^LICENSE|^\.gitignore$/i, actions: [], reason: 'documentation and records have no executable check' },
  { id: 'package-json', match: /^package(-lock)?\.json$/, actions: [], reason: 'dependency or script change: needs the full pipeline (npm test), not a per-file check' },
  { id: 'tsconfig', match: /^tsconfig[^/]*\.json$/, actions: ['typecheck'], reason: 'compiler configuration changes only the type check' },
  { id: 'super-core', match: /^packages\/super-core\//, actions: ['lane:super-core'], reason: 'the package has its own test script' },
  { id: 'site-clone', match: /^packages\/site-clone\//, actions: ['lane:site-clone'], reason: 'the package has its own test script' },
  { id: 'unit-test', match: /^test\/unit\/.*\.test\.mjs$/, actions: ['unit-self'], reason: 'a unit test runs itself with plain node --test, no compile' },
  { id: 'omp-hook-ts', match: /^src\/omp-hooks\/.*\.ts$/, actions: ['unit-refs', 'typecheck', 'compiled-dependants'], reason: 'hook sources are copied by unit tests and also compiled by tsc' },
  { id: 'typescript', match: /^(src|test|scripts)\/.*\.tsx?$/, actions: ['typecheck', 'compiled-dependants'], reason: 'TypeScript needs one tsc pass and the compiled tests that import it' },
  { id: 'renderer-asset', match: /^src\/renderer\/.*\.(html|css|js)$/, actions: ['lane:renderer', 'static'], reason: 'static renderer assets are copied into the build and read by the renderer tests' },
  { id: 'script-or-hook', match: /^(scripts|\.omp\/hooks)\/|^test\/(fixtures|support)\//, actions: ['unit-refs', 'compiled-dependants'], reason: 'scripts, hooks and fixtures are exercised by the unit tests that reference them' },
];

const GRAPH_DIRS = ['src', 'test', 'scripts', '.omp/hooks'];
const GRAPH_EXT = /\.(ts|tsx|js|mjs|cjs)$/;
const SKIP_DIR = /^(node_modules|\.git|dist|\.compiled.*|\.omp-cache)$/;
const GENERIC_STEMS = new Set(['index', 'types', 'utils', 'util', 'main', 'shared', 'common', 'constants']);

const posix = (p) => p.split(sep).join('/');

function walk(root, rel, out) {
  let entries;
  try { entries = readdirSync(join(root, rel), { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const child = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) {
      if (!SKIP_DIR.test(e.name)) walk(root, child, out);
    } else if (e.isFile()) {
      out.push(child);
    }
  }
}

/** Repository context with cached scans, so a plan reads each file at most once. */
export function createContext(root) {
  const text = new Map();
  const readText = (rel) => {
    if (!text.has(rel)) {
      try { text.set(rel, readFileSync(join(root, rel), 'utf8')); } catch { text.set(rel, ''); }
    }
    return text.get(rel);
  };
  let files = null;
  const allFiles = () => {
    if (!files) {
      files = [];
      for (const d of GRAPH_DIRS) walk(root, d, files);
    }
    return files;
  };
  let graph = null;
  let unitTests = null;
  return {
    root,
    readText,
    allFiles,
    get graph() { return (graph ??= buildImportGraph(allFiles(), readText)); },
    get unitTests() {
      return (unitTests ??= allFiles().filter((f) => /^test\/unit\/.*\.test\.mjs$/.test(f)));
    },
  };
}

const SPECIFIER_RE = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|\bimport\s+)(['"])(\.{1,2}\/[^'"\n]*)\1/g;

/** Resolve a relative specifier written in `fromFile` to a known repo file, or null. */
export function resolveSpecifier(fromFile, spec, known) {
  const base = posix(join(dirname(fromFile), spec));
  const stripped = base.replace(/\.(m|c)?js$/, '');
  const candidates = [
    base, `${stripped}.ts`, `${stripped}.tsx`, `${base}.ts`, `${base}.tsx`, `${base}.js`, `${base}.cjs`, `${base}.mjs`,
    `${base}/index.ts`, `${base}/index.js`,
  ];
  return candidates.find((c) => known.has(c)) ?? null;
}

/** Static scan of import / export-from / require / dynamic-import specifiers. Returns reverse edges. */
export function buildImportGraph(files, readText) {
  const known = new Set(files.filter((f) => GRAPH_EXT.test(f)));
  const dependants = new Map();
  for (const f of known) {
    const src = readText(f);
    SPECIFIER_RE.lastIndex = 0;
    let m;
    while ((m = SPECIFIER_RE.exec(src))) {
      const target = resolveSpecifier(f, m[2], known);
      if (!target || target === f) continue;
      let set = dependants.get(target);
      if (!set) dependants.set(target, (set = new Set()));
      set.add(f);
    }
  }
  return { known, dependants };
}

/** Every file that transitively imports `file` (not including it). */
export function transitiveDependants(graph, file) {
  const seen = new Set();
  const stack = [file];
  while (stack.length) {
    const cur = stack.pop();
    for (const d of graph.dependants.get(cur) ?? []) {
      if (!seen.has(d)) { seen.add(d); stack.push(d); }
    }
  }
  return seen;
}

/** A TypeScript test that `node --test` can run from the compiled tree. */
export function isCompiledTest(rel) {
  if (!/\.test\.tsx?$/.test(rel)) return false;
  if (rel.startsWith('test/e2e/')) return false; // electron-driven; not part of the compiled lanes
  return rel.startsWith('test/') || rel.startsWith('src/');
}

export function compiledPathOf(rel, out) {
  return posix(join(out, rel.replace(/\.tsx?$/, '.js')));
}

/** Unit tests whose text names `file` (repo-relative path, basename, or a distinctive stem). */
export function unitTestsReferencing(ctx, file) {
  const base = basename(file);
  const stem = base.replace(/\.[^.]+$/, '');
  const noExt = file.replace(/\.[^.]+$/, '');
  const stemRe = GENERIC_STEMS.has(stem) ? null : new RegExp(`(?<![\\w.-])${stem.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w-])`);
  return ctx.unitTests.filter((t) => {
    const s = ctx.readText(t);
    return s.includes(file) || s.includes(noExt) || s.includes(base) || (stemRe !== null && stemRe.test(s));
  });
}

function laneTests(ctx, name) {
  const lane = LANES[name];
  return ctx.allFiles().filter((f) => f.startsWith(`${lane.dir}/`) && isCompiledTest(f) && (name !== 'src-tests' || f.startsWith('src/')));
}

function fallbackLanes(file) {
  const hit = LANE_BY_PREFIX.find((r) => file.startsWith(r.prefix));
  return hit ? { lanes: hit.lanes, reason: hit.reason } : { lanes: DEFAULT_FALLBACK_LANES, reason: 'default lane for compiled sources' };
}

/**
 * Pure planner. `changed` are repo-relative posix paths; `exists` reports whether a file is
 * still on disk (deleted files cannot run, but a deleted TypeScript file still needs the check).
 */
export function planChecks({ root, changed, noTypecheck = false, threshold = DEPENDANT_THRESHOLD, ctx = createContext(root), exists = (f) => existsSync(join(root, f)) }) {
  const unit = new Set();
  const compiled = new Set();
  const lanes = new Set();
  const skipped = [];
  const notes = [];
  let typecheck = false;
  let staticAssets = false;

  for (const file of changed) {
    const rule = RULES.find((r) => r.match.test(file));
    if (!rule) { skipped.push({ file, reason: 'no rule maps this file to a check' }); continue; }
    if (rule.actions.length === 0) { skipped.push({ file, reason: rule.reason }); continue; }
    const gone = !exists(file);
    let produced = false;

    for (const action of rule.actions) {
      if (action === 'typecheck') { typecheck = true; produced = true; continue; }
      if (action === 'static') { staticAssets = true; continue; }
      if (action.startsWith('lane:')) { lanes.add(action.slice(5)); produced = true; continue; }
      if (gone) continue;
      if (action === 'unit-self') { unit.add(file); produced = true; continue; }
      if (action === 'unit-refs') {
        const closure = [file, ...transitiveDependants(ctx.graph, file)];
        for (const f of closure) for (const t of unitTestsReferencing(ctx, f)) { unit.add(t); produced = true; }
        continue;
      }
      if (action === 'compiled-dependants') {
        const closure = new Set([file, ...transitiveDependants(ctx.graph, file)]);
        const tests = [...closure].filter(isCompiledTest);
        if (tests.length > threshold) {
          const fb = fallbackLanes(file);
          for (const l of fb.lanes) lanes.add(l);
          notes.push(`${file}: ${tests.length} compiled tests depend on it (limit ${threshold}); running lane(s) ${fb.lanes.join(', ')} instead — ${fb.reason}`);
        } else {
          for (const t of tests) compiled.add(t);
        }
        produced = true;
      }
    }
    if (gone && !produced) skipped.push({ file, reason: 'deleted file: nothing left to run' });
    else if (!produced) skipped.push({ file, reason: 'no unit or compiled test references this file' });
  }

  // A selected lane already covers its own files.
  for (const l of lanes) {
    if (!LANES[l]) continue;
    for (const t of laneTests(ctx, l)) compiled.delete(t);
  }
  const compiledList = [...compiled].sort();
  const laneList = [...lanes].sort();
  const needsEmit = compiledList.length > 0 || laneList.some((l) => LANES[l]);
  if (needsEmit) typecheck = true;
  if (noTypecheck) {
    typecheck = needsEmit; // the emit pass is the only way to get compiled tests; it also reports type errors
    if (!needsEmit) notes.push('--no-typecheck: type check skipped');
  }
  return {
    changed: [...changed],
    typecheck,
    unit: [...unit].sort(),
    compiled: compiledList,
    lanes: laneList,
    skipped,
    emit: needsEmit,
    staticAssets: staticAssets || needsEmit,
    notes,
  };
}

/** Out dir must be private: never `.compiled`, never source, never outside the repo. */
export function resolveOutDir(root, out = DEFAULT_OUT_DIR) {
  const abs = resolve(root, out);
  const rel = posix(relative(root, abs));
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) throw new Error(`refusing --out ${out}: it must be a directory inside the repository`);
  const top = rel.split('/')[0];
  // Windows folds case and drops trailing dots/spaces, so `.Compiled.` is the live build too.
  const key = process.platform === 'win32' ? top.toLowerCase().replace(/[. ]+$/, '') : top;
  if (key === '.compiled' || /^(src|test|scripts|packages|node_modules|\.git|themes)$/.test(key)) {
    throw new Error(`refusing --out ${out}: ${key === '.compiled' ? 'the running app loads .compiled/' : `${top}/ holds sources`}`);
  }
  return abs;
}

/** Changed file list: explicit, else git diff against base plus untracked files (read-only git). */
export function collectChanged({ root, base = 'HEAD', files = null, git = defaultGit }) {
  let raw;
  if (files) raw = files;
  else raw = [...git(root, ['diff', '--name-only', base]), ...git(root, ['ls-files', '--others', '--exclude-standard'])];
  const out = new Set();
  for (const f of raw) {
    const t = f.trim();
    if (!t) continue;
    const abs = isAbsolute(t) ? t : resolve(root, t);
    const rel = posix(relative(root, abs));
    if (rel && !rel.startsWith('..')) out.add(rel);
  }
  return [...out].sort();
}

function defaultGit(root, args) {
  const r = spawnSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${(r.stderr || '').trim()}`);
  return r.stdout.split(/\r?\n/).filter(Boolean);
}

export function defaultJobs() {
  const n = typeof availableParallelism === 'function' ? availableParallelism() : 2;
  return Math.max(1, Math.min(4, n - 1));
}

function defaultRun(cmd, args, opts) {
  const r = spawnSync(cmd, args, { ...opts, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, shell: opts.shell ?? false });
  return { status: r.status ?? 1, stdout: r.stdout ?? '', stderr: (r.stderr ?? '') + (r.error ? `\n${r.error.message}` : '') };
}

/**
 * Turn a plan into ordered checks, each `{ name, steps: [{ cmd, args, env?, shell? }] }`.
 * A check fails when any of its steps exits non-zero.
 */
export function buildChecks(plan, { root, out, jobs, tscBin }) {
  const checks = [];
  const testFlags = ['--require', './scripts/test-file-roots.cjs', '--test', '--test-force-exit', `--test-concurrency=${jobs}`];
  const nodeModules = join(root, 'node_modules');
  const compiledEnv = {
    ANTIFAN_COMPILED_ROOT: out,
    NODE_PATH: [nodeModules, process.env.NODE_PATH].filter(Boolean).join(delimiter),
  };
  const buildInfo = (name) => join(out, name);
  const toOut = (rel) => compiledPathOf(rel, relative(root, out));

  if (plan.unit.length) {
    checks.push({ name: `unit (${plan.unit.length} file${plan.unit.length === 1 ? '' : 's'})`, steps: [{ cmd: process.execPath, args: [...testFlags, ...plan.unit] }] });
  }
  if (plan.emit) {
    checks.push({
      name: 'tsc emit + static assets',
      steps: [
        { cmd: process.execPath, args: [tscBin, '-p', '.', '--outDir', out, '--tsBuildInfoFile', buildInfo('.tsbuildinfo')], mkdir: out },
        { cmd: process.execPath, args: ['scripts/copy-static.mjs'], env: { ANTIFAN_COMPILED_ROOT: out } },
      ],
      gate: 'emit',
    });
  } else if (plan.typecheck) {
    checks.push({ name: 'typecheck', steps: [{ cmd: process.execPath, args: [tscBin, '-p', '.', '--noEmit', '--tsBuildInfoFile', buildInfo('.tsbuildinfo.typecheck')], mkdir: out }] });
  }
  if (plan.compiled.length) {
    checks.push({ name: `compiled tests (${plan.compiled.length})`, needs: 'emit', steps: [{ cmd: process.execPath, args: [...testFlags, ...plan.compiled.map(toOut)], env: compiledEnv }] });
  }
  for (const lane of plan.lanes) {
    if (EXTERNAL_LANES[lane]) {
      const [cmd, args] = EXTERNAL_LANES[lane].cmd;
      checks.push({ name: `lane ${lane}`, steps: [{ cmd, args, shell: process.platform === 'win32' }] });
    } else if (plan.laneFiles?.[lane]?.length) {
      checks.push({ name: `lane ${lane} (${plan.laneFiles[lane].length})`, needs: 'emit', steps: [{ cmd: process.execPath, args: [...testFlags, ...plan.laneFiles[lane].map(toOut)], env: compiledEnv }] });
    }
  }
  return checks;
}

/** Run checks through an injectable runner. Child output is shown only for failing checks. */
export function executePlan(plan, { root, out, jobs, run = defaultRun, log = console.log, now = () => Date.now(), tscBin = resolveTsc(root), mkdir = (d) => mkdirSync(d, { recursive: true }) }) {
  const started = now();
  const checks = buildChecks(plan, { root, out, jobs, tscBin });
  let failed = 0;
  let emitFailed = false;
  for (const check of checks) {
    if (check.needs === 'emit' && emitFailed) {
      failed += 1;
      log(`FAIL  ${check.name} — not run: the emit step failed`);
      continue;
    }
    const t0 = now();
    let bad = null;
    for (const step of check.steps) {
      if (step.mkdir) mkdir(step.mkdir);
      const res = run(step.cmd, step.args, { cwd: root, env: { ...process.env, ...(step.env ?? {}) }, shell: step.shell });
      if (res.status !== 0) { bad = res; break; }
    }
    const secs = ((now() - t0) / 1000).toFixed(1);
    if (bad) {
      failed += 1;
      if (check.gate === 'emit') emitFailed = true;
      log(`FAIL  ${check.name} (${secs}s)`);
      const body = `${bad.stdout ?? ''}${bad.stderr ?? ''}`.trimEnd();
      if (body) log(body);
    } else {
      log(`PASS  ${check.name} (${secs}s)`);
    }
  }
  const total = ((now() - started) / 1000).toFixed(1);
  log(`VERIFY-CHANGED: ${failed === 0 ? 'PASS' : 'FAIL'} (${checks.length} checks, ${failed} failed, ${total} s)`);
  return { ok: failed === 0, checks: checks.length, failed };
}

function resolveTsc(root) {
  return createRequire(join(root, 'package.json')).resolve('typescript/bin/tsc');
}

export function parseArgs(argv) {
  const opts = { base: 'HEAD', files: null, plan: false, noTypecheck: false, out: DEFAULT_OUT_DIR, jobs: defaultJobs() };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const val = () => {
      if (i + 1 >= argv.length) throw new Error(`${a} needs a value`);
      return argv[++i];
    };
    if (a === '--base') opts.base = val();
    else if (a === '--files') opts.files = val().split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--plan') opts.plan = true;
    else if (a === '--no-typecheck') opts.noTypecheck = true;
    else if (a === '--out') opts.out = val();
    else if (a === '--jobs') {
      const n = Number(val());
      if (!Number.isInteger(n) || n < 1) throw new Error('--jobs needs a positive integer');
      opts.jobs = n;
    } else throw new Error(`unknown argument ${a}`);
  }
  return opts;
}

/** Full CLI flow with injectable collaborators; returns the exit code. */
export function main(argv, { root = SCRIPT_ROOT, run = defaultRun, log = console.log, git = defaultGit, now = () => Date.now() } = {}) {
  let opts;
  try { opts = parseArgs(argv); } catch (e) { log(`verify-changed: ${e.message}`); return 2; }
  let out;
  try { out = resolveOutDir(root, opts.out); } catch (e) { log(`verify-changed: ${e.message}`); return 2; }
  const changed = collectChanged({ root, base: opts.base, files: opts.files, git });
  const ctx = createContext(root);
  const plan = planChecks({ root, changed, noTypecheck: opts.noTypecheck, ctx });
  plan.laneFiles = Object.fromEntries(plan.lanes.filter((l) => LANES[l]).map((l) => [l, laneTests(ctx, l)]));
  if (opts.plan) {
    const { laneFiles, emit, staticAssets, ...shown } = plan;
    log(JSON.stringify({ ...shown, emit, staticAssets, out: posix(relative(root, out)) }, null, 2));
    return 0;
  }
  if (!plan.unit.length && !plan.typecheck && !plan.compiled.length && !plan.lanes.length) {
    log(`VERIFY-CHANGED: PASS (0 checks, 0 failed, 0.0 s) — nothing to run for ${changed.length} changed file(s)`);
    return 0;
  }
  return executePlan(plan, { root, out, jobs: opts.jobs, run, log, now }).ok ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = main(process.argv.slice(2));
}
