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
  it('bumps AGENT_CONTRACT_VERSION to 3.2.0-lean', () => {
    assert.strictEqual(AGENT_CONTRACT_VERSION, '3.2.0-lean');
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