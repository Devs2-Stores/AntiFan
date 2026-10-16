import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import {
  AGENT_CONTRACT_VERSION,
  buildAgentTaskHeader,
  buildSelfQaDirective,
  classifyTaskIntent,
  getInitialTerminalState,
  hasExplicitEditModeTag,
  SELF_QA_DIRECTIVE,
  SELF_QA_DIRECTIVE_FAST,
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
    assert.ok(header.includes('CAPTURE_FRAME_STARVATION'));
    assert.ok(header.includes('CAPTURE_TIMEOUT'));
    assert.ok(header.includes('TARGET_BUSY_DRAINING'));
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
    assert.ok(header.includes('QA_PENDING_SYNC'), 'unsynced storefront has a dedicated non-BLOCKED terminal status');
    assert.ok(header.includes('DONE_WITH_CONCERNS'));
  });

  it('directive requires a terminal qaStatus token and receipt evidence', () => {
    const header = buildAgentTaskHeader('fix lỗi lệch header trên mobile');
    assert.ok(header.includes('qaStatus'));
    assert.ok(header.includes('QA_PASSED'));
    assert.ok(header.includes('QA_FAILED'));
    assert.ok(header.includes('QA_INCONCLUSIVE'));
    assert.ok(header.includes('QA_UNAVAILABLE'));
    assert.ok(header.includes('QA_PENDING_SYNC'));
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

  it('resolves compound intent with defect cues to bug-fix instead of pure testing', () => {
    const compoundInstruction = 'Chữ ko có in đậm, màu sắc bị sai, test tính năng Filter cho tôi';
    const intent = classifyTaskIntent(compoundInstruction);
    assert.strictEqual(intent, 'bug-fix', 'compound request with defect cues must resolve to bug-fix');

    const header = buildAgentTaskHeader(compoundInstruction);
    assert.ok(header.includes('Gated by core contract, fresh evidence, and intent verification.'));
    assert.ok(!header.includes('READ-ONLY analysis'));
    assert.ok(header.includes(SELF_QA_DIRECTIVE));
  });

  it('keeps pure testing instructions as read-only testing intent', () => {
    const pureTestInstruction = 'Viết unit test cho hàm applyFilters';
    const intent = classifyTaskIntent(pureTestInstruction);
    assert.strictEqual(intent, 'testing', 'pure test request must resolve to testing');

    const header = buildAgentTaskHeader(pureTestInstruction);
    assert.ok(header.includes('READ-ONLY analysis'));
    assert.ok(header.includes(SELF_QA_DIRECTIVE_READONLY));
  });

  it('an explicit [Direct-Edit] tag never parks an otherwise-unclassifiable request at DECISION REQUIRED', () => {
    const armed = '/queue [Direct-Edit] Cho phép settings_data.json';
    const header = buildAgentTaskHeader(armed);
    assert.ok(header.includes('Current state: READY'), header);
    assert.ok(!header.includes('DECISION REQUIRED'), 'armed edit must not carry a clarification gate');
    assert.ok(header.includes('MUTATION AUTHORIZED'));
    assert.ok(header.includes('User-Armed Edit'));
    assert.ok(!header.includes('No implementation occurs until the intended outcome is clarified.'));

    const unarmed = buildAgentTaskHeader('Cho phép settings_data.json');
    assert.ok(unarmed.includes('Current state: DECISION REQUIRED'), 'the same text without a tag keeps the gate');
  });

  it('mode tags are stripped before intent classification', () => {
    assert.strictEqual(classifyTaskIntent('[⚡Direct-Edit] fix lỗi lệch header'), 'bug-fix');
    assert.strictEqual(classifyTaskIntent('[Super-Fast] font-size 14px'), 'tweak');
  });

  it('Super-Fast replaces the mandatory 8-step QA directive with the no-round-trip variant', () => {
    const tagged = buildAgentTaskHeader('[🚀Super-Fast] sửa lề nút cart 12px');
    assert.ok(tagged.includes(SELF_QA_DIRECTIVE_FAST), 'the typed tag arms the fast directive');
    assert.ok(!tagged.includes(SELF_QA_DIRECTIVE), 'a fast brief must not demand theme.qa_validate rounds');

    const chip = buildAgentTaskHeader('sửa lề nút cart 12px', undefined, 'fast');
    assert.ok(chip.includes(SELF_QA_DIRECTIVE_FAST), 'the Element Picker chip arms it without a typed tag');

    const direct = buildAgentTaskHeader('[⚡Direct-Edit] sửa lề nút cart 12px');
    assert.ok(direct.includes(SELF_QA_DIRECTIVE), 'Direct-Edit keeps the mandatory QA directive');
    assert.ok(!direct.includes(SELF_QA_DIRECTIVE_FAST));
  });

  it('treats fast and direct actionChips as explicit edit-mode authorization even when intent is unknown and instruction has no tag', () => {
    const untaggedUnknown = 'Đổi chữ sang Mua ngay';
    assert.strictEqual(classifyTaskIntent(untaggedUnknown), 'unknown');
    assert.strictEqual(hasExplicitEditModeTag(untaggedUnknown), false);
    assert.strictEqual(hasExplicitEditModeTag(untaggedUnknown, 'fast'), true);
    assert.strictEqual(hasExplicitEditModeTag(untaggedUnknown, 'direct'), true);
    assert.strictEqual(getInitialTerminalState(untaggedUnknown, 'unknown'), 'decision-required');
    assert.strictEqual(getInitialTerminalState(untaggedUnknown, 'unknown', 'fast'), 'ready');
    assert.strictEqual(getInitialTerminalState(untaggedUnknown, 'unknown', 'direct'), 'ready');

    const fastHeader = buildAgentTaskHeader(untaggedUnknown, undefined, 'fast');
    assert.ok(fastHeader.includes('Current state: READY'), fastHeader);
    assert.ok(!fastHeader.includes('DECISION REQUIRED'));
    assert.ok(!fastHeader.includes('NO MUTATION'));
    assert.ok(!fastHeader.includes('Do not modify files yet'));
    assert.ok(!fastHeader.includes('No implementation occurs until the intended outcome is clarified.'));
    assert.ok(fastHeader.includes('MUTATION AUTHORIZED'));
    assert.ok(fastHeader.includes('User-Armed Edit'));
    assert.ok(fastHeader.includes(SELF_QA_DIRECTIVE_FAST));

    const directHeader = buildAgentTaskHeader(untaggedUnknown, undefined, 'direct');
    assert.ok(directHeader.includes('Current state: READY'), directHeader);
    assert.ok(!directHeader.includes('DECISION REQUIRED'));
    assert.ok(!directHeader.includes('NO MUTATION'));
    assert.ok(!directHeader.includes('Do not modify files yet'));
    assert.ok(!directHeader.includes('No implementation occurs until the intended outcome is clarified.'));
    assert.ok(directHeader.includes('MUTATION AUTHORIZED'));
    assert.ok(directHeader.includes('User-Armed Edit'));
    assert.ok(directHeader.includes(SELF_QA_DIRECTIVE));
  });
});

import { isReadOnlyAnalysis } from '../../src/shared/annotation-prompt';

describe('Annotation prompt read-only gating', () => {
  const READ_ONLY_TEXT = 'READ-ONLY analysis';

  it('a security request that also asks for a fix is not READ-ONLY and carries the full self-QA directive', () => {
    const instruction = 'audit the XSS in the header menu and fix it';
    const intent = classifyTaskIntent(instruction);
    assert.strictEqual(intent, 'security');
    assert.strictEqual(isReadOnlyAnalysis(intent, instruction), false);
    assert.strictEqual(buildSelfQaDirective(intent, instruction), SELF_QA_DIRECTIVE);
    const header = buildAgentTaskHeader(instruction);
    assert.ok(!header.includes(READ_ONLY_TEXT), header);
    assert.ok(header.includes('Gated by core contract, fresh evidence, and intent verification.'));
    assert.ok(header.includes(SELF_QA_DIRECTIVE));
  });

  it('a documentation request that also asks for a fix is not READ-ONLY', () => {
    const instruction = 'update the README guide and fix the broken install link';
    const intent = classifyTaskIntent(instruction);
    assert.strictEqual(intent, 'documentation');
    assert.strictEqual(isReadOnlyAnalysis(intent, instruction), false);
    assert.strictEqual(buildSelfQaDirective(intent, instruction), SELF_QA_DIRECTIVE);
    assert.ok(!buildAgentTaskHeader(instruction).includes(READ_ONLY_TEXT));
  });

  it('review and research with a fix verb are not READ-ONLY (patch, implement, Vietnamese sua loi)', () => {
    assert.strictEqual(isReadOnlyAnalysis('review', 'review the header and patch the overflow'), false);
    assert.strictEqual(isReadOnlyAnalysis('research', 'research the cache layer and implement the winner'), false);
    assert.strictEqual(isReadOnlyAnalysis('review', 'xem lai header roi sua loi tran ngang'), false);
    assert.strictEqual(buildSelfQaDirective('review', 'review the header and patch the overflow'), SELF_QA_DIRECTIVE);
    assert.strictEqual(buildSelfQaDirective('research', 'research the cache layer and implement the winner'), SELF_QA_DIRECTIVE);
  });

  it('analysis-only requests stay READ-ONLY, including words that merely contain "fix"', () => {
    const pure = 'audit prefix handling and the suffix parser for security';
    const intent = classifyTaskIntent(pure);
    assert.strictEqual(intent, 'security');
    assert.strictEqual(isReadOnlyAnalysis(intent, pure), true);
    assert.strictEqual(buildSelfQaDirective(intent, pure), SELF_QA_DIRECTIVE_READONLY);
    assert.ok(buildAgentTaskHeader(pure).includes(READ_ONLY_TEXT));

    assert.strictEqual(isReadOnlyAnalysis('review', 'review the header spacing'), true);
    assert.strictEqual(isReadOnlyAnalysis('documentation', ''), true);
    assert.strictEqual(buildSelfQaDirective('documentation'), SELF_QA_DIRECTIVE_READONLY);
  });

  it('other intents are never classified as read-only analysis', () => {
    assert.strictEqual(isReadOnlyAnalysis('bug-fix', 'fix the header'), false);
    assert.strictEqual(isReadOnlyAnalysis('testing', 'run the tests'), false);
  });
});