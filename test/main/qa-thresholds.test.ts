import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DEFAULT_QA_PROFILE, DEFAULT_QA_THRESHOLDS, resolveQaThresholds } from '../../src/main/qa/qa-thresholds';
import { DEFAULT_QA_PROFILE as workflowProfile } from '../../src/main/qa/theme-qa-workflow';

function findRoot(): string {
  for (let dir = __dirname; ; dir = path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, 'scripts', 'run-electron.cjs'))) return dir;
    if (path.dirname(dir) === dir) return process.cwd();
  }
}

function workspaceWithContract(contract: string | null): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-qa-thresholds-'));
  if (contract !== null) {
    fs.mkdirSync(path.join(root, 'deliverables'), { recursive: true });
    fs.writeFileSync(path.join(root, 'deliverables', 'FULL_REMAKE_CONTRACT.json'), contract, 'utf8');
  }
  return root;
}

const contractWith = (typeScale: unknown): string => JSON.stringify({ designDefaults: { typeScale } });

describe('built-in QA thresholds', () => {
  it('equal the values the visual-quality fixture corpus grades against', () => {
    const fixture = JSON.parse(fs.readFileSync(path.join(findRoot(), 'test', 'fixtures', 'visual-quality', 'thresholds.json'), 'utf8'));
    assert.deepStrictEqual({ ...DEFAULT_QA_THRESHOLDS }, fixture);
  });

  it('grade under build-strict when the caller names no profile, in the workflow and in the resolver module', () => {
    assert.strictEqual(DEFAULT_QA_PROFILE, 'build-strict');
    assert.strictEqual(workflowProfile, DEFAULT_QA_PROFILE);
  });
});

describe('resolveQaThresholds', () => {
  it('prefers explicit thresholds over the workspace contract', () => {
    const root = workspaceWithContract(contractWith({ minTextPx: 16 }));
    const explicit = { minTextPx: 13, minTapHitPx: 26 };
    const resolved = resolveQaThresholds({ explicit, workspaceRoot: root });
    assert.strictEqual(resolved.source, 'explicit');
    assert.deepStrictEqual(resolved.thresholds, explicit);
  });

  it('falls back to the defaults with no workspace root and no contract file', () => {
    assert.deepStrictEqual(resolveQaThresholds({}), { thresholds: { ...DEFAULT_QA_THRESHOLDS }, source: 'default' });
    const bare = resolveQaThresholds({ workspaceRoot: workspaceWithContract(null) });
    assert.strictEqual(bare.source, 'default');
    assert.deepStrictEqual(bare.thresholds, { ...DEFAULT_QA_THRESHOLDS });
    assert.strictEqual(bare.note, undefined);
  });

  it('returns a copy so a caller cannot change the built-in values', () => {
    const resolved = resolveQaThresholds({});
    resolved.thresholds.minTextPx = 99;
    assert.strictEqual(DEFAULT_QA_THRESHOLDS.minTextPx, 12);
    assert.strictEqual(resolveQaThresholds({}).thresholds.minTextPx, 12);
  });

  it('lets a contract tighten a threshold and never loosen one', () => {
    const tighter = resolveQaThresholds({ workspaceRoot: workspaceWithContract(contractWith({ minTextPx: 14, minTapHitPx: 32 })) });
    assert.strictEqual(tighter.source, 'contract');
    assert.strictEqual(tighter.thresholds.minTextPx, 14);
    assert.strictEqual(tighter.thresholds.minTapHitPx, 32);

    const looser = resolveQaThresholds({ workspaceRoot: workspaceWithContract(contractWith({ minTextPx: 10 })) });
    assert.strictEqual(looser.source, 'contract');
    assert.strictEqual(looser.thresholds.minTextPx, DEFAULT_QA_THRESHOLDS.minTextPx);
  });

  it('does not accept the removed control-height floor from a contract', () => {
    const legacy = resolveQaThresholds({ workspaceRoot: workspaceWithContract(contractWith({ minTextPx: 14, minControlPx: 44 })) });
    assert.strictEqual(legacy.source, 'default');
    assert.match(legacy.note ?? '', /minControlPx is not a known threshold/);
    assert.deepStrictEqual(legacy.thresholds, { ...DEFAULT_QA_THRESHOLDS });
  });

  it('reads a contract that starts with a byte-order mark', () => {
    const resolved = resolveQaThresholds({ workspaceRoot: workspaceWithContract(`\uFEFF${contractWith({ minTextPx: 15 })}`) });
    assert.strictEqual(resolved.source, 'contract');
    assert.strictEqual(resolved.thresholds.minTextPx, 15);
  });

  it('ignores a contract without a typeScale and says nothing about it', () => {
    const resolved = resolveQaThresholds({ workspaceRoot: workspaceWithContract(JSON.stringify({ designDefaults: { mobileRootFontPx: 14 } })) });
    assert.strictEqual(resolved.source, 'default');
    assert.strictEqual(resolved.note, undefined);
  });

  it('never throws on a malformed contract: it uses the defaults and names the problem', () => {
    const cases: Array<[string, RegExp]> = [
      ['{ not json', /not valid JSON/],
      [contractWith('large'), /typeScale is not an object/],
      [contractWith([12]), /typeScale is not an object/],
      [contractWith({ minTextPx: '14' }), /minTextPx="14" is not a positive number/],
      [contractWith({ minTextPx: -1 }), /minTextPx=-1 is not a positive number/],
      [contractWith({ minTextPx: 14, headingPx: 30 }), /headingPx is not a known threshold/],
    ];
    for (const [contract, note] of cases) {
      const resolved = resolveQaThresholds({ workspaceRoot: workspaceWithContract(contract) });
      assert.strictEqual(resolved.source, 'default', contract);
      assert.deepStrictEqual(resolved.thresholds, { ...DEFAULT_QA_THRESHOLDS }, contract);
      assert.match(resolved.note ?? '', note, contract);
    }
  });
});
