import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { pathToFileURL } from 'node:url';

const mod = await import(pathToFileURL(join(import.meta.dirname, '..', '..', 'scripts', 'verify-changed.mjs')).href);
const { planChecks, createContext, resolveOutDir, main, executePlan, collectChanged, buildImportGraph, RULES } = mod;

let root;
const put = (rel, text = '') => {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), text);
};

before(() => {
  root = mkdtempSync(join(tmpdir(), 'verify-changed-'));
  put('test/unit/board.test.mjs', "import { buildBoard } from '../../scripts/leader/board.mjs';\n");
  put('test/unit/hook.test.mjs', "const src = readFileSync(join(root, 'src/omp-hooks/guard.ts'));\n");
  put('test/unit/other.test.mjs', "import 'node:test';\n");
  put('scripts/leader/board.mjs', 'export const buildBoard = () => [];\n');
  put('src/omp-hooks/guard.ts', 'export const g = 1;\n');
  put('src/main/x.ts', 'export const x = 1;\n');
  put('src/main/mid.ts', "import { x } from './x.js';\nexport const mid = x;\n");
  put('test/main/x.test.ts', "import { mid } from '../../src/main/mid.js';\nmid;\n");
  put('test/main/unrelated.test.ts', "import { y } from '../../src/main/y.js';\ny;\n");
  put('src/main/y.ts', 'export const y = 1;\n');
  put('src/shared/wide.ts', 'export const wide = 1;\n');
  for (let i = 0; i < 5; i += 1) put(`test/renderer/w${i}.test.ts`, "import { wide } from '../../src/shared/wide.js';\nwide;\n");
  put('README.md', '# readme\n');
});
after(() => rmSync(root, { recursive: true, force: true }));

const plan = (changed, extra = {}) => planChecks({ root, changed, ctx: createContext(root), ...extra });

describe('planChecks', () => {
  it('a changed unit test plans itself and needs no compile', () => {
    const p = plan(['test/unit/other.test.mjs']);
    assert.deepEqual(p.unit, ['test/unit/other.test.mjs']);
    assert.equal(p.typecheck, false);
    assert.deepEqual(p.compiled, []);
  });

  it('a changed script plans the unit tests that import or name it', () => {
    const p = plan(['scripts/leader/board.mjs']);
    assert.deepEqual(p.unit, ['test/unit/board.test.mjs']);
    assert.equal(p.typecheck, false);
  });

  it('a changed hook source plans the unit tests that reference its path, plus a typecheck', () => {
    const p = plan(['src/omp-hooks/guard.ts']);
    assert.deepEqual(p.unit, ['test/unit/hook.test.mjs']);
    assert.equal(p.typecheck, true);
  });

  it('a changed TypeScript source plans one typecheck and the compiled test importing it through an intermediate module', () => {
    const p = plan(['src/main/x.ts']);
    assert.equal(p.typecheck, true);
    assert.equal(p.emit, true);
    assert.deepEqual(p.compiled, ['test/main/x.test.ts']);
    assert.deepEqual(p.unit, []);
  });

  it('a changed compiled test plans itself', () => {
    assert.deepEqual(plan(['test/main/unrelated.test.ts']).compiled, ['test/main/unrelated.test.ts']);
  });

  it('markdown plans nothing and is listed as skipped with a reason', () => {
    const p = plan(['README.md']);
    assert.equal(p.typecheck, false);
    assert.deepEqual([p.unit, p.compiled, p.lanes], [[], [], []]);
    assert.equal(p.skipped.length, 1);
    assert.equal(p.skipped[0].file, 'README.md');
    assert.ok(p.skipped[0].reason.length > 0);
  });

  it('a file with more dependants than the threshold falls back to its lane', () => {
    const p = plan(['src/shared/wide.ts'], { threshold: 3 });
    assert.deepEqual(p.compiled, []);
    assert.ok(p.lanes.includes('renderer'));
    assert.ok(p.notes.some((n) => n.includes('src/shared/wide.ts')));
    const listed = plan(['src/shared/wide.ts'], { threshold: 10 });
    assert.equal(listed.compiled.length, 5);
    assert.deepEqual(listed.lanes, []);
  });

  it('a selected lane absorbs compiled tests it already covers', () => {
    const p = plan(['src/shared/wide.ts', 'test/renderer/w1.test.ts'], { threshold: 3 });
    assert.deepEqual(p.compiled, []);
  });

  it('super-core files map to their own lane', () => {
    const p = plan(['packages/super-core/src/a.ts']);
    assert.deepEqual(p.lanes, ['super-core']);
  });

  it('--no-typecheck drops a typecheck-only check but keeps the emit that compiled tests need', () => {
    assert.equal(plan(['src/main/y.ts'], { noTypecheck: true }).typecheck, true);
    assert.equal(plan(['tsconfig.json'], { noTypecheck: true }).typecheck, false);
  });

  it('every rule states a reason', () => {
    for (const r of RULES) assert.ok(r.reason && r.id, r.id);
  });
});

describe('import graph', () => {
  it('resolves .js specifiers to .ts sources and records reverse edges', () => {
    const files = ['a/b.ts', 'a/c.ts', 'a/d/index.ts'];
    const src = { 'a/b.ts': "import { c } from './c.js';\nexport * from './d';\n", 'a/c.ts': '', 'a/d/index.ts': '' };
    const g = buildImportGraph(files, (f) => src[f]);
    assert.deepEqual([...g.dependants.get('a/c.ts')], ['a/b.ts']);
    assert.deepEqual([...g.dependants.get('a/d/index.ts')], ['a/b.ts']);
  });
});

describe('out dir and runner', () => {
  it('refuses .compiled, anything inside it, source dirs and paths outside the repo', () => {
    const bads = ['.compiled', '.compiled/x', '.compiled/sub', './.compiled', 'src', '..', '.'];
    // Windows folds case and strips trailing dots/spaces; the same names must not slip through there.
    if (process.platform === 'win32') bads.push('.COMPILED', '.Compiled', 'SRC', 'Test', '.compiled.', '.compiled ', '.COMPILED/sub');
    for (const bad of bads) {
      assert.throws(() => resolveOutDir(root, bad), /refusing/, bad);
    }
    assert.ok(resolveOutDir(root).endsWith('.compiled-verify'));
  });

  it('main refuses --out .compiled before doing anything', () => {
    const calls = [];
    const lines = [];
    const code = main(['--out', '.compiled', '--files', 'README.md'], { root, run: (...a) => calls.push(a), log: (l) => lines.push(l) });
    assert.equal(code, 2);
    assert.deepEqual(calls, []);
    assert.match(lines.join('\n'), /refusing/);
  });

  it('--plan prints JSON and spawns nothing', () => {
    const calls = [];
    const lines = [];
    const code = main(['--plan', '--files', 'src/main/x.ts,README.md'], { root, run: (...a) => calls.push(a), log: (l) => lines.push(l) });
    assert.equal(code, 0);
    assert.deepEqual(calls, []);
    const out = JSON.parse(lines.join('\n'));
    assert.deepEqual(out.changed, ['README.md', 'src/main/x.ts']);
    assert.equal(out.typecheck, true);
    assert.deepEqual(out.compiled, ['test/main/x.test.ts']);
    assert.equal(out.skipped[0].file, 'README.md');
  });

  it('collectChanged merges git diff and untracked files and stays inside the repo', () => {
    const git = (_r, args) => (args[0] === 'diff' ? ['src/main/x.ts'] : ['scripts/new.mjs']);
    assert.deepEqual(collectChanged({ root, git }), ['scripts/new.mjs', 'src/main/x.ts']);
    assert.deepEqual(collectChanged({ root, files: [join(root, 'a.ts'), '../outside.ts'], git }), ['a.ts']);
  });

  it('executePlan runs units, one emit, then the compiled tests from the out dir; output only for failures', () => {
    const p = { ...plan(['test/unit/other.test.mjs', 'src/main/x.ts']), laneFiles: {} };
    const calls = [];
    const lines = [];
    const out = join(root, '.compiled-verify');
    const res = executePlan(p, {
      root, out, jobs: 2, tscBin: 'tsc-bin', mkdir: () => {}, log: (l) => lines.push(l),
      run: (cmd, args, opts) => {
        calls.push({ args, env: opts.env });
        const isCompiled = args.some((a) => String(a).includes('.compiled-verify/test/main'));
        return isCompiled ? { status: 1, stdout: 'boom-output', stderr: '' } : { status: 0, stdout: 'quiet-output', stderr: '' };
      },
    });
    assert.equal(res.ok, false);
    assert.equal(res.checks, 3);
    assert.equal(res.failed, 1);
    const emitCall = calls.find((c) => c.args.includes('--outDir'));
    assert.equal(emitCall.args[emitCall.args.indexOf('--outDir') + 1], out);
    assert.ok(emitCall.args.includes('--tsBuildInfoFile'));
    const staticCall = calls.find((c) => c.args.includes('scripts/copy-static.mjs'));
    assert.equal(staticCall.env.ANTIFAN_COMPILED_ROOT, out);
    const testCall = calls.find((c) => c.args.some((a) => String(a).endsWith('test/main/x.test.js')));
    assert.ok(testCall.env.NODE_PATH.includes('node_modules'));
    const text = lines.join('\n');
    assert.match(text, /boom-output/);
    assert.doesNotMatch(text, /quiet-output/);
    assert.match(text, /VERIFY-CHANGED: FAIL \(3 checks, 1 failed, /);
  });

  it('a failed emit marks the dependent compiled check as failed without running it', () => {
    const p = { ...plan(['src/main/x.ts']), laneFiles: {} };
    const calls = [];
    const res = executePlan(p, {
      root, out: join(root, '.compiled-verify'), jobs: 1, tscBin: 'tsc-bin', mkdir: () => {}, log: () => {},
      run: (cmd, args) => { calls.push(args); return { status: args.includes('--outDir') ? 2 : 0, stdout: '', stderr: 'type error' }; },
    });
    assert.equal(res.failed, 2);
    assert.equal(calls.length, 1);
  });

  it('a typecheck-only plan uses --noEmit and never --outDir', () => {
    const p = { ...plan(['tsconfig.json']), laneFiles: {} };
    const calls = [];
    executePlan(p, { root, out: join(root, '.compiled-verify'), jobs: 1, tscBin: 't', mkdir: () => {}, log: () => {}, run: (c, a) => { calls.push(a); return { status: 0, stdout: '', stderr: '' }; } });
    assert.equal(calls.length, 1);
    assert.ok(calls[0].includes('--noEmit'));
    assert.ok(!calls[0].includes('--outDir'));
  });
});
