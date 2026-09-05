import { after, test, describe } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { IssueRegister } from '../../src/main/session/issue-register';
import { inferTabSemanticRole } from '../../src/main/browser/native-tab-host';
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

describe('Semantic Tab Aliasing & Durable Issue Register Suite', () => {
  describe('inferTabSemanticRole', () => {
    test('classifies Google Sheets URL as @sheet by default', () => {
      const role = inferTabSemanticRole('https://docs.google.com/spreadsheets/d/12345/edit#gid=0');
      assert.strictEqual(role.alias, '@sheet');
      assert.strictEqual(role.role, 'feedback');
      assert.strictEqual(role.aliasColor, '#16a34a');
    });

    test('classifies Báo Giá spreadsheet as @pricing', () => {
      const role = inferTabSemanticRole('https://docs.google.com/spreadsheets/d/12345/edit', 'Bảng Báo Giá Thiết Bị T9 - Google Trang tính');
      assert.strictEqual(role.alias, '@pricing');
      assert.strictEqual(role.role, 'pricing');
      assert.strictEqual(role.aliasColor, '#f59e0b');
    });

    test('classifies Google Docs or Brief as @spec', () => {
      const role = inferTabSemanticRole('https://docs.google.com/document/d/abcde/edit', 'Brief Yêu Cầu Dự Án');
      assert.strictEqual(role.alias, '@spec');
      assert.strictEqual(role.role, 'spec');
      assert.strictEqual(role.aliasColor, '#06b6d4');
    });

    test('classifies Feedback checklist as @feedback', () => {
      const role = inferTabSemanticRole('file:///E:/Work/feedback-t9.xlsx', 'Tổng hợp feedback sửa lỗi');
      assert.strictEqual(role.alias, '@feedback');
      assert.strictEqual(role.role, 'feedback');
    });

    test('classifies product data as @data', () => {
      const role = inferTabSemanticRole('file:///E:/Work/products.csv', 'Danh mục sản phẩm master data');
      assert.strictEqual(role.alias, '@data');
      assert.strictEqual(role.role, 'data');
    });
    test('classifies Haravan admin URL as @admin', () => {
      const role = inferTabSemanticRole('https://mystore.myharavan.com/admin/products');
      assert.strictEqual(role.alias, '@admin');
      assert.strictEqual(role.role, 'admin');
      assert.strictEqual(role.aliasColor, '#2563eb');
    });

    test('classifies Shopify admin URL as @admin', () => {
      const role = inferTabSemanticRole('https://admin.shopify.com/store/test/products/new');
      assert.strictEqual(role.alias, '@admin');
      assert.strictEqual(role.role, 'admin');
    });

    test('classifies Sapo admin URL as @admin', () => {
      const role = inferTabSemanticRole('https://shop.mysapo.vn/admin/orders');
      assert.strictEqual(role.alias, '@admin');
      assert.strictEqual(role.role, 'admin');
    });

    test('classifies generic storefront live URL as @storefront', () => {
      const role = inferTabSemanticRole('https://mystore.com.vn/products/ao-thun-nam');
      assert.strictEqual(role.alias, '@storefront');
      assert.strictEqual(role.role, 'storefront');
      assert.strictEqual(role.aliasColor, '#9333ea');
    });

    test('returns empty for about:blank or empty URL', () => {
      const role = inferTabSemanticRole('about:blank');
      assert.deepStrictEqual(role, {});
    });
  });

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

  describe('Capability Catalogue & Alias Target Resolution', () => {
    test('registers anti.diagnostics and anti.sheet.extract capabilities', () => {
      const catalogue = new CapabilityCatalogue({ runtime: { allowEval: true } as any, projectId: 'p1', workspaceId: 'w1', runtimeId: 'r1' });
      const mockHost: any = {
        getTabList: () => [
          { id: 'tab-1', url: 'https://admin.shopify.com', alias: '@admin', role: 'admin' },
          { id: 'tab-2', url: 'https://docs.google.com/spreadsheets/d/123', alias: '@feedback', role: 'feedback' },
          { id: 'tab-3', url: 'https://store.vn', alias: '@storefront', role: 'storefront' },
        ],
        hasTab: (id: string) => ['tab-1', 'tab-2', 'tab-3'].includes(id),
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

      // Test switchTab with alias
      const switchResult = port.switchTab('@admin');
      assert.strictEqual(switchResult.switched, true);
    });
    test('resolves numeric #N tab references in switchTab and target resolution', () => {
      let lastSwitchedId = '';
      const mockHost: any = {
        getTabList: () => [
          { id: 'tab-1', url: 'https://store1.vn', alias: '@storefront', role: 'storefront' },
          { id: 'tab-2', url: 'https://store2.vn', role: 'storefront' },
          { id: 'tab-3', url: 'https://store3.vn', role: 'storefront' },
        ],
        hasTab: (id: string) => ['tab-1', 'tab-2', 'tab-3'].includes(id),
        switchTab: (id: string) => { lastSwitchedId = id; return true; },
      };
      const port = new BrowserControlPort(mockHost);

      const res1 = port.switchTab('#1');
      assert.strictEqual(res1.switched, true);
      assert.strictEqual(lastSwitchedId, 'tab-1');

      const res2 = port.switchTab('#2');
      assert.strictEqual(res2.switched, true);
      assert.strictEqual(lastSwitchedId, 'tab-2');

      const res3 = port.switchTab('#3');
      assert.strictEqual(res3.switched, true);
      assert.strictEqual(lastSwitchedId, 'tab-3');
    });
  });
});
