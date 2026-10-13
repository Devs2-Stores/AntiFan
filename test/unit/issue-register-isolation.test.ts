import { describe, it, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { IssueRegister } from '../../src/main/session/issue-register';
import { StorageLocations } from '../../src/main/config/storage-locations';

describe('IssueRegister isolation and test runner redirection', () => {
  const originalDataRoot = process.env.ANTIFAN_DATA_ROOT;
  const originalIssueRegisterDir = process.env.ANTIFAN_ISSUE_REGISTER_DIR;
  const originalVerificationRegisterDir = process.env.ANTIFAN_VERIFICATION_REGISTER_DIR;
  const originalNodeTestContext = process.env.NODE_TEST_CONTEXT;
  const originalAntifanTestRun = process.env.ANTIFAN_TEST_RUN;

  let createdTempDirs: string[] = [];

  function makeTempDir(prefix: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    createdTempDirs.push(dir);
    return dir;
  }

  // Private seams, reached through a cast like the other register suites reach the singleton.
  const defaultRegisterDir = (liveDir: string): string =>
    (IssueRegister as unknown as { defaultRegisterDir(dir: string): string }).defaultRegisterDir(liveDir);
  const pathsOf = (reg: IssueRegister): { logPath: string; verificationsPath: string } =>
    reg as unknown as { logPath: string; verificationsPath: string };

  beforeEach(() => {
    IssueRegister.resetInstanceForTests();
    StorageLocations.resetCache();
    delete process.env.ANTIFAN_ISSUE_REGISTER_DIR;
    delete process.env.ANTIFAN_VERIFICATION_REGISTER_DIR;
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
    if (originalVerificationRegisterDir === undefined) {
      delete process.env.ANTIFAN_VERIFICATION_REGISTER_DIR;
    } else {
      process.env.ANTIFAN_VERIFICATION_REGISTER_DIR = originalVerificationRegisterDir;
    }
    if (originalNodeTestContext === undefined) {
      delete process.env.NODE_TEST_CONTEXT;
    } else {
      process.env.NODE_TEST_CONTEXT = originalNodeTestContext;
    }
    if (originalAntifanTestRun === undefined) {
      delete process.env.ANTIFAN_TEST_RUN;
    } else {
      process.env.ANTIFAN_TEST_RUN = originalAntifanTestRun;
    }
    StorageLocations.resetCache();

    for (const dir of createdTempDirs) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {}
    }
    createdTempDirs = [];
  });

  it('IssueRegister redirects test-runner writes to tmp even when ANTIFAN_DATA_ROOT points to the live default directory', () => {
    process.env.NODE_TEST_CONTEXT = '1';
    const liveDefaultRoot = StorageLocations.resolveDefaultDataRoot();
    process.env.ANTIFAN_DATA_ROOT = liveDefaultRoot;
    StorageLocations.resetCache();

    const liveIssuesDir = path.join(liveDefaultRoot, 'issues');
    const resolvedDir = defaultRegisterDir(liveIssuesDir);

    const expectedTmpPrefix = path.join(os.tmpdir(), `antifan-test-registers-${process.pid}`);
    assert.strictEqual(
      path.resolve(resolvedDir).toLowerCase(),
      path.resolve(expectedTmpPrefix).toLowerCase(),
      'defaultRegisterDir must redirect to per-process tmp dir when ANTIFAN_DATA_ROOT matches live default root'
    );
    assert.notStrictEqual(
      path.resolve(resolvedDir).toLowerCase(),
      path.resolve(liveIssuesDir).toLowerCase(),
      'defaultRegisterDir must not write to the live issues directory'
    );

    const reg = IssueRegister.getInstance();
    const resolvedLogDir = path.dirname(pathsOf(reg).logPath);
    assert.strictEqual(
      path.resolve(resolvedLogDir).toLowerCase(),
      path.resolve(expectedTmpPrefix).toLowerCase()
    );
    assert.notStrictEqual(
      path.resolve(pathsOf(reg).logPath).toLowerCase(),
      path.resolve(path.join(liveIssuesDir, 'issue-register.jsonl')).toLowerCase()
    );
  });

  it('IssueRegister keeps <scratch>/issues when ANTIFAN_DATA_ROOT is pinned to a custom scratch directory', () => {
    process.env.NODE_TEST_CONTEXT = '1';
    const scratchRoot = makeTempDir('antifan-scratch-isolation-');
    process.env.ANTIFAN_DATA_ROOT = scratchRoot;
    StorageLocations.resetCache();

    const scratchIssuesDir = path.join(scratchRoot, 'issues');
    const resolvedDir = defaultRegisterDir(scratchIssuesDir);

    assert.strictEqual(
      path.resolve(resolvedDir).toLowerCase(),
      path.resolve(scratchIssuesDir).toLowerCase(),
      'defaultRegisterDir must keep <scratch>/issues when pinned to a non-default custom scratch root'
    );

    const reg = IssueRegister.getInstance();
    assert.strictEqual(
      path.resolve(pathsOf(reg).logPath).toLowerCase(),
      path.resolve(path.join(scratchIssuesDir, 'issue-register.jsonl')).toLowerCase()
    );
    assert.strictEqual(
      path.resolve(pathsOf(reg).verificationsPath).toLowerCase(),
      path.resolve(path.join(scratchIssuesDir, 'verification-register.jsonl')).toLowerCase()
    );
  });

  it('IssueRegister respects explicit ANTIFAN_ISSUE_REGISTER_DIR override even under test runner', () => {
    process.env.NODE_TEST_CONTEXT = '1';
    const customIssueDir = makeTempDir('antifan-explicit-issue-dir-');
    process.env.ANTIFAN_ISSUE_REGISTER_DIR = customIssueDir;

    const reg = IssueRegister.getInstance();
    assert.strictEqual(
      path.resolve(path.dirname(pathsOf(reg).logPath)).toLowerCase(),
      path.resolve(customIssueDir).toLowerCase(),
      'explicit ANTIFAN_ISSUE_REGISTER_DIR must win over test-runner defaults'
    );
  });

  it('defaultRegisterDir returns liveDir when not under a test runner', () => {
    delete process.env.NODE_TEST_CONTEXT;
    delete process.env.ANTIFAN_TEST_RUN;

    const dummyLiveDir = 'E:\\Work\\.antifan-data\\issues';
    const result = defaultRegisterDir(dummyLiveDir);
    assert.strictEqual(result, dummyLiveDir, 'defaultRegisterDir must return liveDir directly in production');
  });
});
