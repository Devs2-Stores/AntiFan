import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import {
  AGENT_CONTRACT_VERSION,
  buildAgentTaskHeader,
  buildSelfQaDirective,
  SELF_QA_DIRECTIVE,
  SELF_QA_DIRECTIVE_READONLY,
} from '../../src/shared/annotation-prompt';

describe('Annotation prompt self-QA directive', () => {
  it('bumps AGENT_CONTRACT_VERSION to 3.5.0-lean', () => {
    assert.strictEqual(AGENT_CONTRACT_VERSION, '3.5.0-lean');
  });

  it('directive permits static bypass for pure-CSS micro edits (lane 9)', () => {
    const header = buildAgentTaskHeader('fix lỗi lệch header trên mobile');
    assert.ok(header.includes('QA_MICRO_STATIC'));
    assert.ok(header.includes('assets/'));
    assert.ok(header.includes('*.css'));
    assert.ok(header.includes('*.scss'));
    const forbiddenExt = ['*', 'css', 'liquid'].join('.');
    assert.ok(!header.includes(forbiddenExt));
    assert.ok(header.includes('≤ 10'));
    assert.ok(header.includes('thêm + xoá'));
  });

  it('implementation intents carry the mandatory self-QA directive', () => {
    const header = buildAgentTaskHeader('fix lỗi lệch header trên mobile');
    assert.ok(header.includes('theme.qa_validate'));
    assert.ok(header.includes('summary.passed'));
    assert.ok(header.includes('criticalCount'));
    assert.ok(header.includes('SAU KHI SỬA'));
    assert.ok(header.includes('CẤM bịa kết quả'));
  });

  it('directive handles the auth-error branches for MCP tools (Finding 5)', () => {
    const header = buildAgentTaskHeader('fix lỗi lệch header trên mobile');
    assert.ok(header.includes('ATTACHMENT_REQUIRED'));
    assert.ok(header.includes('ATTACHMENT_INVALID'));
    assert.ok(header.includes('MCP_CONTEXT_REQUIRED'));
  });

  it('directive covers capability, transient-gate, and target-mismatch branches', () => {
    const header = buildAgentTaskHeader('fix lỗi lệch header trên mobile');
    assert.ok(header.includes('CAPABILITY_NOT_FOUND'));
    assert.ok(header.includes('SETTLE_INCOMPLETE'));
    assert.ok(header.includes('CAPTURE_NOT_READY'));
    assert.ok(header.includes('TARGET_MISMATCH'));
    assert.ok(header.includes('anti.browser.rebind_target'));
  });

  it('directive mandates live-view inspection and QA binding params before reporting done', () => {
    const header = buildAgentTaskHeader('fix lỗi lệch header trên mobile');
    assert.ok(header.includes('anti.inspect.dom'));
    assert.ok(header.includes('anti.inspect.styles'));
    assert.ok(header.includes('anti.screenshot.viewport'));
    assert.ok(header.includes('QA Binding'));
    assert.ok(header.includes('expectedUrl'));
    assert.ok(header.includes('verification pending theme sync'));
  });

  it('directive requires a terminal qaStatus token and receipt evidence', () => {
    const header = buildAgentTaskHeader('fix lỗi lệch header trên mobile');
    assert.ok(header.includes('qaStatus'));
    assert.ok(header.includes('QA_PASSED'));
    assert.ok(header.includes('QA_FAILED'));
    assert.ok(header.includes('QA_INCONCLUSIVE'));
    assert.ok(header.includes('QA_UNAVAILABLE'));
    assert.ok(header.includes('qa-receipts'));
    assert.ok(header.includes('annotationId'));
  });

  it('directive re-probes CAPABILITY_NOT_FOUND once instead of inheriting absence', () => {
    const header = buildAgentTaskHeader('fix lỗi lệch header trên mobile');
    assert.ok(header.includes('re-probe'));
    assert.ok(header.includes('KHÔNG kế thừa'));
  });

  it('directive permits up to two self-fix rounds inside the same turn', () => {
    const header = buildAgentTaskHeader('fix lỗi lệch header trên mobile');
    assert.ok(header.includes('2 vòng'));
  });

  it('read-only intents get the non-mandatory evidence variant, not the implementation one', () => {
    const header = buildAgentTaskHeader('research cách lazy load ảnh trên theme');
    assert.ok(!header.includes('SAU KHI SỬA'));
    assert.ok(header.includes(SELF_QA_DIRECTIVE_READONLY));
    assert.ok(!header.includes('CẤM bịa kết quả'));
  });

  it('reads-only intents still may mention the QA tool for evidence', () => {
    const header = buildAgentTaskHeader('research cách lazy load ảnh trên theme');
    assert.ok(header.includes('theme.qa_validate'));
  });

  it('buildSelfQaDirective selects variants by intent', () => {
    assert.strictEqual(buildSelfQaDirective('bug-fix'), SELF_QA_DIRECTIVE);
    assert.strictEqual(buildSelfQaDirective('review'), SELF_QA_DIRECTIVE_READONLY);
    assert.strictEqual(buildSelfQaDirective('security'), SELF_QA_DIRECTIVE_READONLY);
    assert.strictEqual(buildSelfQaDirective('testing'), SELF_QA_DIRECTIVE_READONLY);
    assert.strictEqual(buildSelfQaDirective('documentation'), SELF_QA_DIRECTIVE_READONLY);
    assert.strictEqual(buildSelfQaDirective('extract-component'), SELF_QA_DIRECTIVE_READONLY);
  });

  it('directive appears exactly once, after the invariant ledger block', () => {
    const header = buildAgentTaskHeader('fix lỗi lệch header trên mobile');
    const occurrences = header.split('## Self-QA bắt buộc sau khi sửa').length - 1;
    assert.strictEqual(occurrences, 1);
    const ledgerIndex = header.indexOf('Fable-Thinking Invariant Ledger');
    const directiveIndex = header.indexOf('## Self-QA bắt buộc sau khi sửa');
    const contractIndex = header.indexOf('## Core Execution Invariants');
    assert.ok(ledgerIndex !== -1 && directiveIndex !== -1 && contractIndex !== -1);
    assert.ok(ledgerIndex < directiveIndex && directiveIndex < contractIndex);
  });
});