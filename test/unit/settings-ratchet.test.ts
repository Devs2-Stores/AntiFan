// A reviewed baseline recorded before a rule existed must not read that rule's findings as
// regressions: the first evaluation under the newer rule set absorbs them as legacy debt.
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { evaluateSettingsRatchet, loadOrBootstrapBaseline, SETTINGS_RULESET_VERSION, type SettingsFinding } from '../../src/main/qa/settings-ratchet';

const legacyFinding: SettingsFinding = { rule: 'HARAVAN_SETTING_UNRESOLVED', id: 'old', file: 'snippets/a.liquid' };
const deadSetting = (id: string): SettingsFinding => ({ rule: 'dead-setting', id, file: 'config/settings_schema.json' });

function reviewedV1Baseline(): { root: string; baselinePath: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'settings-ratchet-'));
  const baselinePath = path.join(root, '.antifan', 'settings-baseline.json');
  fs.mkdirSync(path.dirname(baselinePath), { recursive: true });
  fs.writeFileSync(baselinePath, JSON.stringify({
    reviewed: true,
    bootstrappedAt: '2026-01-01T00:00:00.000Z',
    counts: { 'HARAVAN_SETTING_UNRESOLVED::old::snippets/a.liquid': 1 },
    totalFindings: 1,
  }), 'utf8');
  return { root, baselinePath };
}

describe('settings ratchet across rule-set versions', () => {
  it('absorbs findings of rules added since the baseline instead of failing the theme', () => {
    const { root, baselinePath } = reviewedV1Baseline();
    try {
      const findings = [legacyFinding, deadSetting('footer_text')];
      const result = evaluateSettingsRatchet(loadOrBootstrapBaseline(root, findings), findings, { workspaceRoot: root });
      assert.strictEqual(result.ok, true);
      assert.deepStrictEqual(result.newFailures, []);
      assert.ok(result.legacyDebt.some((f) => f.rule === 'dead-setting'));
      assert.strictEqual('baseline' in result, false, 'the mutable baseline stays private');
      const persisted = JSON.parse(fs.readFileSync(baselinePath, 'utf8'));
      assert.strictEqual(persisted.rulesetVersion, SETTINGS_RULESET_VERSION);
      assert.strictEqual(persisted.counts['dead-setting::footer_text::config/settings_schema.json'], 1);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('still fails a new finding of an added rule once the baseline knows the rule', () => {
    const { root } = reviewedV1Baseline();
    try {
      const first = [legacyFinding, deadSetting('footer_text')];
      evaluateSettingsRatchet(loadOrBootstrapBaseline(root, first), first, { workspaceRoot: root });
      const next = [...first, deadSetting('header_note')];
      const result = evaluateSettingsRatchet(loadOrBootstrapBaseline(root, next), next, { workspaceRoot: root });
      assert.strictEqual(result.ok, false);
      assert.deepStrictEqual(result.newFailures.map((f) => f.id), ['header_note']);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('still fails a regression of a rule the baseline already ran', () => {
    const { root } = reviewedV1Baseline();
    try {
      const findings = [legacyFinding, { ...legacyFinding, id: 'new' }];
      const result = evaluateSettingsRatchet(loadOrBootstrapBaseline(root, findings), findings, { workspaceRoot: root, persist: false });
      assert.strictEqual(result.ok, false);
      assert.deepStrictEqual(result.newFailures.map((f) => f.id), ['new']);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
