import { describe, it, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  IssueRegister,
  normalizeErrorMessageForDedupe,
} from '../../src/main/session/issue-register';
import { StorageLocations } from '../../src/main/config/storage-locations';

describe('IssueRegister deduplication', () => {
  const originalDataRoot = process.env.ANTIFAN_DATA_ROOT;
  const originalIssueRegisterDir = process.env.ANTIFAN_ISSUE_REGISTER_DIR;
  let scratchRoot: string;

  beforeEach(() => {
    scratchRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-dedupe-test-'));
    process.env.ANTIFAN_DATA_ROOT = scratchRoot;
    process.env.ANTIFAN_ISSUE_REGISTER_DIR = scratchRoot;
    StorageLocations.resetCache();
    IssueRegister.resetInstanceForTests();
  });

  afterEach(() => {
    IssueRegister.resetInstanceForTests();
    if (originalDataRoot === undefined) {
      delete process.env.ANTIFAN_DATA_ROOT;
    } else {
      process.env.ANTIFAN_DATA_ROOT = originalDataRoot;
    }
    if (originalIssueRegisterDir === undefined) {
      delete process.env.ANTIFAN_ISSUE_REGISTER_DIR;
    } else {
      process.env.ANTIFAN_ISSUE_REGISTER_DIR = originalIssueRegisterDir;
    }
    StorageLocations.resetCache();
    try {
      fs.rmSync(scratchRoot, { recursive: true, force: true });
    } catch {}
  });

  describe('normalizeErrorMessageForDedupe unit behavior', () => {
    it('masks full UUIDs', () => {
      const msg1 = 'Error on tab 01a134a4-c1fc-748b-809c-5d4bfbcfabb9 during dispatch';
      const msg2 = 'Error on tab e88c9e5b-7b2a-43c2-a9b0-1234567890ab during dispatch';
      assert.strictEqual(normalizeErrorMessageForDedupe(msg1), normalizeErrorMessageForDedupe(msg2));
    });

    it('masks tab- prefixed IDs', () => {
      const msg1 = "Cannot target tab 'tab-1': live document generation is unavailable.";
      const msg2 = "Cannot target tab 'tab-non-existent-999': live document generation is unavailable.";
      assert.strictEqual(normalizeErrorMessageForDedupe(msg1), normalizeErrorMessageForDedupe(msg2));
    });

    it('masks quoted hex tab IDs', () => {
      const msg1 = "Target tab 'e88c9e5b' is not owned by any live window";
      const msg2 = "Target tab 'ff12606e' is not owned by any live window";
      assert.strictEqual(normalizeErrorMessageForDedupe(msg1), normalizeErrorMessageForDedupe(msg2));
    });

    it('masks generation and epoch numbers', () => {
      const msg1 = 'Browser target document generation (1) is stale compared to live document generation (2)';
      const msg2 = 'Browser target document generation (15) is stale compared to live document generation (16)';
      assert.strictEqual(normalizeErrorMessageForDedupe(msg1), normalizeErrorMessageForDedupe(msg2));

      const epoch1 = 'Target browser epoch mismatch: active 1, requested 2';
      const epoch2 = 'Target browser epoch mismatch: active 5, requested 6';
      assert.strictEqual(normalizeErrorMessageForDedupe(epoch1), normalizeErrorMessageForDedupe(epoch2));
    });

    it('leaves distinct error messages unmatched', () => {
      const msg1 = 'Mobile drawer menu fails to open on tap';
      const msg2 = 'Cart modal styling mismatch';
      assert.notStrictEqual(normalizeErrorMessageForDedupe(msg1), normalizeErrorMessageForDedupe(msg2));
    });
  });

  describe('IssueRegister.record integration deduplication', () => {
    it('IssueRegister deduplicates error records sharing the same tool and error pattern despite varying tab UUIDs', () => {
      const reg = IssueRegister.getInstance();

      const rec1 = reg.record({
        toolName: 'anti.inspect.dom',
        errorMessage: 'Failed to inspect tab 01a134a4-c1fc-748b-809c-5d4bfbcfabb9: target timeout',
        errorCode: 'TARGET_TIMEOUT',
        status: 'OPEN',
        tabId: '01a134a4-c1fc-748b-809c-5d4bfbcfabb9',
      });

      const rec2 = reg.record({
        toolName: 'anti.inspect.dom',
        errorMessage: 'Failed to inspect tab e88c9e5b-7b2a-43c2-a9b0-1234567890ab: target timeout',
        errorCode: 'TARGET_TIMEOUT',
        status: 'OPEN',
        tabId: 'e88c9e5b-7b2a-43c2-a9b0-1234567890ab',
      });

      assert.strictEqual(rec1.id, rec2.id, 'deduplicated record must reuse existing record id');

      const openIssues = reg.list({ status: 'OPEN' }).filter((i) => i.toolName === 'anti.inspect.dom');
      assert.strictEqual(openIssues.length, 1, 'must have exactly 1 OPEN row after deduplication');

      const current = openIssues[0]!;
      assert.strictEqual(
        current.errorMessage,
        'Failed to inspect tab e88c9e5b-7b2a-43c2-a9b0-1234567890ab: target timeout',
        'matched row must refresh errorMessage to the latest incoming value'
      );
      assert.strictEqual(
        current.tabId,
        'e88c9e5b-7b2a-43c2-a9b0-1234567890ab',
        'matched row must refresh tabId'
      );
    });

    it('deduplicates error records with varying tab- prefixed fixture IDs', () => {
      const reg = IssueRegister.getInstance();

      reg.record({
        toolName: 'anti.browser.tabs',
        errorMessage: "Cannot target tab 'tab-1': live document generation is unavailable.",
        errorCode: 'TARGET_STALE',
      });

      reg.record({
        toolName: 'anti.browser.tabs',
        errorMessage: "Cannot target tab 'tab-non-existent-999': live document generation is unavailable.",
        errorCode: 'TARGET_STALE',
      });

      const openIssues = reg.list({ status: 'OPEN' }).filter((i) => i.toolName === 'anti.browser.tabs');
      assert.strictEqual(openIssues.length, 1);
    });

    it('deduplicates error records with varying document generation drift', () => {
      const reg = IssueRegister.getInstance();

      reg.record({
        toolName: 'browser.set-viewport',
        errorMessage: 'Browser target document generation (1) is stale compared to live document generation (2)',
        errorCode: 'TARGET_STALE',
      });

      reg.record({
        toolName: 'browser.set-viewport',
        errorMessage: 'Browser target document generation (8) is stale compared to live document generation (9)',
        errorCode: 'TARGET_STALE',
      });

      const openIssues = reg.list({ status: 'OPEN' }).filter((i) => i.toolName === 'browser.set-viewport');
      assert.strictEqual(openIssues.length, 1);
    });

    it('does not deduplicate records when error codes differ', () => {
      const reg = IssueRegister.getInstance();

      reg.record({
        toolName: 'anti.browser.evaluate',
        errorMessage: "Target tab 'e88c9e5b' was refused",
        errorCode: 'TARGET_STALE',
      });

      reg.record({
        toolName: 'anti.browser.evaluate',
        errorMessage: "Target tab 'ff12606e' was refused",
        errorCode: 'TARGET_CLOSED',
      });

      const openIssues = reg.list({ status: 'OPEN' }).filter((i) => i.toolName === 'anti.browser.evaluate');
      assert.strictEqual(openIssues.length, 2, 'records with differing error codes must not deduplicate');
    });

    it('does not deduplicate records when tool names differ', () => {
      const reg = IssueRegister.getInstance();

      reg.record({
        toolName: 'anti.browser.reload',
        errorMessage: "Target tab 'e88c9e5b' failed",
        errorCode: 'TARGET_STALE',
      });

      reg.record({
        toolName: 'anti.browser.navigate',
        errorMessage: "Target tab 'e88c9e5b' failed",
        errorCode: 'TARGET_STALE',
      });

      assert.strictEqual(reg.list({ status: 'OPEN' }).length, 2);
    });

    it('does not deduplicate genuinely different error messages', () => {
      const reg = IssueRegister.getInstance();

      reg.record({
        toolName: 'theme.qa',
        errorMessage: 'Mobile drawer menu fails to open on tap',
        errorCode: 'MENU_INOPERATIVE',
      });

      reg.record({
        toolName: 'theme.qa',
        errorMessage: 'Cart modal styling mismatch',
        errorCode: 'MENU_INOPERATIVE',
      });

      const openIssues = reg.list({ status: 'OPEN' }).filter((i) => i.toolName === 'theme.qa');
      assert.strictEqual(openIssues.length, 2, 'genuinely different error messages must not deduplicate');
    });
  });
});
