import { after, test, describe } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { IssueRegister } from '../../src/main/session/issue-register';
import { CapabilityCatalogue } from '../../src/main/tools/capability-catalogue';
import { registerBrowserCapabilities } from '../../src/main/tools/browser-capabilities';
import { BrowserControlPort } from '../../src/main/tools/browser-control-port';
import { StorageLocations } from '../../src/main/config/storage-locations';

const originalDataRoot = process.env.ANTIFAN_DATA_ROOT;
const issueRegisterDataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-issue-register-'));
process.env.ANTIFAN_DATA_ROOT = issueRegisterDataRoot;
StorageLocations.resetCache();

after(() => {
  (IssueRegister as unknown as { instance: IssueRegister | null }).instance = null;
  if (originalDataRoot === undefined) delete process.env.ANTIFAN_DATA_ROOT;
  else process.env.ANTIFAN_DATA_ROOT = originalDataRoot;
  StorageLocations.resetCache();
  fs.rmSync(issueRegisterDataRoot, { recursive: true, force: true });
});

describe('Browser Tab Identity & Durable Issue Register Suite', () => {

  describe('IssueRegister (Durable Issue Logging)', () => {
    test('records issues with unique IDs and default P2 severity', () => {
      const register = IssueRegister.getInstance();
      const issue = register.record({
        toolName: 'anti.browser.evaluate',
        errorMessage: 'Trusted Type violation on docs.google.com',
        errorCode: 'CSP_ERROR',
        workaroundApplied: 'Fetched via in-tab GViz protocol',
        status: 'BYPASSED',
      });

      assert.ok(issue.id.startsWith('ISS-'));
      assert.strictEqual(issue.toolName, 'anti.browser.evaluate');
      assert.strictEqual(issue.status, 'BYPASSED');
      assert.strictEqual(issue.severity, 'P2');
    });

    test('lists recorded issues with status filter and sorting', () => {
      const register = IssueRegister.getInstance();
      register.record({
        toolName: 'anti.agent.cursor.type',
        errorMessage: 'Element obscured by modal overlay',
        severity: 'P1',
        status: 'OPEN',
      });

      const openIssues = register.list({ status: 'OPEN' });
      assert.ok(openIssues.length >= 1);
      assert.strictEqual(openIssues[0]?.status, 'OPEN');
    });

    test('resolves an issue by ID', () => {
      const register = IssueRegister.getInstance();
      const issue = register.record({
        toolName: 'test.tool',
        errorMessage: 'Temporary network glitch',
        severity: 'P3',
        status: 'OPEN',
      });

      const resolved = register.resolve(issue.id, 'Self-healed on retry');
      assert.strictEqual(resolved, true);

      const found = register.list().find((i) => i.id === issue.id);
      assert.strictEqual(found?.status, 'RESOLVED');
      assert.ok(found?.notes?.includes('Self-healed on retry'));
    });
  });

  describe('Capability Catalogue & Tab ID Target Resolution', () => {
    test('registers anti.diagnostics and anti.sheet.extract capabilities', () => {
      const catalogue = new CapabilityCatalogue({ runtime: { allowEval: true } as any, projectId: 'p1', workspaceId: 'w1', runtimeId: 'r1' });
      const mockHost: any = {
        getTabList: () => [
          { id: 'tab-1', url: 'https://admin.shopify.com' },
          { id: 'tab-2', url: 'https://docs.google.com/spreadsheets/d/123' },
          { id: 'tab-3', url: 'https://store.vn' },
        ],
        hasTab: (id: string) => ['tab-1', 'tab-2', 'tab-3'].includes(id),
        isTabAllowed: () => true,
        switchTab: (id: string) => true,
        evalJs: async () => ({ success: true, targetRow: 34 }),
      };
      const port = new BrowserControlPort(mockHost);
      registerBrowserCapabilities(catalogue, port);

      assert.ok(catalogue.get('anti.diagnostics.list_issues'));
      assert.ok(catalogue.get('antifan_list_issues'));
      assert.ok(catalogue.get('anti.diagnostics.record_issue'));
      assert.ok(catalogue.get('anti.sheet.extract'));
      assert.ok(catalogue.get('antifan_sheet_extract'));

      // Switch using the actual browser tab ID.
      const mockTarget = {
        projectId: 'p1',
        workspaceId: 'w1',
        runtimeId: 'r1',
        tabId: 'tab-1',
        browserEpoch: 1,
        documentGeneration: 1,
      };
      const switchResult = port.switchTab('tab-1', { target: mockTarget });
      assert.strictEqual(switchResult.switched, true);
      assert.strictEqual(switchResult.tabId, 'tab-1');
      assert.throws(() => port.switchTab('@admin', { target: mockTarget }), /unknown tab/);
    });
    test('resolves numeric #N tab references in switchTab and target resolution', () => {
      let lastSwitchedId = '';
      const mockHost: any = {
        getTabList: () => [
          { id: 'tab-1', url: 'https://store1.vn' },
          { id: 'tab-2', url: 'https://store2.vn' },
          { id: 'tab-3', url: 'https://store3.vn' },
        ],
        hasTab: (id: string) => ['tab-1', 'tab-2', 'tab-3'].includes(id),
        isTabAllowed: () => true,
        switchTab: (id: string) => { lastSwitchedId = id; return true; },
      };
      const port = new BrowserControlPort(mockHost);
      const testTarget = {
        projectId: 'p1',
        workspaceId: 'w1',
        runtimeId: 'r1',
        tabId: 'tab-1',
        browserEpoch: 1,
        documentGeneration: 1,
      };

      const res1 = port.switchTab('#1', { target: testTarget });
      assert.strictEqual(res1.switched, true);
      assert.strictEqual(res1.tabId, 'tab-1');
      assert.strictEqual(lastSwitchedId, 'tab-1');

      const res2 = port.switchTab('#2', { target: testTarget });
      assert.strictEqual(res2.switched, true);
      assert.strictEqual(res2.tabId, 'tab-2');
      assert.strictEqual(lastSwitchedId, 'tab-2');

      const res3 = port.switchTab('#3', { target: testTarget });
      assert.strictEqual(res3.switched, true);
      assert.strictEqual(res3.tabId, 'tab-3');
      assert.strictEqual(lastSwitchedId, 'tab-3');
    });
  });
});
