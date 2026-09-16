/**
 * IssueRegister taxonomy extension (Phase 6 item 16): issueClass/reasonCode/
 * affected are additive; existing consumers keep working; root-cause grouping
 * flows through the single register — no second register exists.
 */
import { after, test, describe } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { IssueRegister, classifyIssue } from '../../src/main/session/issue-register';
import { StorageLocations } from '../../src/main/config/storage-locations';

const originalDataRoot = process.env.ANTIFAN_DATA_ROOT;
const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-issue-taxonomy-'));
process.env.ANTIFAN_DATA_ROOT = dataRoot;
StorageLocations.resetCache();

after(() => {
  (IssueRegister as unknown as { instance: IssueRegister | null }).instance = null;
  if (originalDataRoot === undefined) delete process.env.ANTIFAN_DATA_ROOT;
  else process.env.ANTIFAN_DATA_ROOT = originalDataRoot;
  StorageLocations.resetCache();
  fs.rmSync(dataRoot, { recursive: true, force: true });
});

describe('IssueRegister taxonomy extension', () => {
  test('classifyIssue: explicit field > errorCode > tool prefix > uncategorized', () => {
    assert.equal(classifyIssue({ toolName: 'x', issueClass: 'bridge' }), 'bridge');
    assert.equal(classifyIssue({ toolName: 'x', errorCode: 'BRIDGE_CONTEXT_FAILED' }), 'bridge');
    assert.equal(classifyIssue({ toolName: 'core.query' }), 'core-store');
    assert.equal(classifyIssue({ toolName: 'theme.qa_validate' }), 'theme');
    assert.equal(classifyIssue({ toolName: 'mystery' }), 'uncategorized');
  });

  test('record accepts new taxonomy fields and list() filters by them', () => {
    const reg = IssueRegister.getInstance();
    reg.record({ toolName: 'bridge.hook', errorMessage: 'core down', errorCode: 'BRIDGE_CONTEXT_FAILED', severity: 'P1', reasonCode: 'BRIDGE_CONTEXT_FAILED', affected: ['session-1'] });
    reg.record({ toolName: 'browser.screenshot', errorMessage: 'timeout', errorCode: 'CAPTURE_TIMEOUT', severity: 'P2' });
    reg.record({ toolName: 'browser.screenshot', errorMessage: 'timeout again', errorCode: 'CAPTURE_TIMEOUT', severity: 'P0' });

    const bridgeIssues = reg.list({ issueClass: 'bridge' });
    assert.equal(bridgeIssues.length, 1);
    assert.equal(bridgeIssues[0]?.errorCode, 'BRIDGE_CONTEXT_FAILED');

    const byCode = reg.list({ errorCode: 'CAPTURE_TIMEOUT' });
    assert.equal(byCode.length, 2);
  });

  test('summarizeOpen groups by errorCode with worst severity + affected union', () => {
    const reg = IssueRegister.getInstance();
    const groups = reg.summarizeOpen();
    const cap = groups.find((g) => g.key === 'CAPTURE_TIMEOUT');
    assert.ok(cap, 'CAPTURE_TIMEOUT group exists');
    assert.equal(cap.count, 2);
    assert.equal(cap.worstSeverity, 'P0');
    assert.equal(cap.issueClass, 'browser');
    const bridge = groups.find((g) => g.key === 'BRIDGE_CONTEXT_FAILED');
    assert.ok(bridge);
    assert.equal(bridge.issueClass, 'bridge');
    assert.ok(bridge.affected.includes('session-1'));
  });

  test('resolved issues drop out of summarizeOpen', () => {
    const reg = IssueRegister.getInstance();
    const rec = reg.record({ toolName: 'terminal.write', errorMessage: 'e', severity: 'P3' });
    assert.ok(reg.summarizeOpen().some((g) => g.key === 'terminal.write'));
    reg.resolve(rec.id, 'fixed');
    assert.ok(!reg.summarizeOpen().some((g) => g.key === 'terminal.write'));
  });
});
