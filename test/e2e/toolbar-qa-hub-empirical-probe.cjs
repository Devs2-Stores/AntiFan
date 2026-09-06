/**
 * AntiFan Toolbar Controls Empirical Probe: #btnThemeQa & #btnWorkflowHub
 *
 * Exercises:
 * 1. #btnThemeQa lifecycle:
 *    - Click on non-storefront tab
 *    - Click when state is 'pass' (modal behavior)
 *    - Second click / re-run behavior
 * 2. #btnWorkflowHub lifecycle:
 *    - Modal opening & get-state IPC
 *    - Workflows list rendering (built-in count, steps, category)
 *    - MCP Tools list rendering & detail card (hardcoded mock detection)
 *    - Run workflow IPC & live execution state UI
 *    - New workflow prompt behavior
 */

const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('no-sandbox');
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('disable-software-rasterizer');

const telemetry = {
  timestamp: new Date().toISOString(),
  themeQa: {},
  workflowHub: {},
  ipcCalls: [],
  rendererLogs: [],
};

let win = null;
let themeQaInvocations = 0;
let getWorkflowStateInvocations = 0;
let runWorkflowInvocations = 0;

app.whenReady().then(async () => {
  // 1. Initial state handler
  ipcMain.handle('antifan:toolbar:get-initial-state', () => {
    telemetry.ipcCalls.push({ channel: 'antifan:toolbar:get-initial-state', time: Date.now() });
    return {
      tabs: [
        { id: 'tab-1', url: 'https://example.com', title: 'Example Page', state: { url: 'https://example.com' } }
      ],
      activeTabId: 'tab-1',
      bookmarks: [],
      chromeProfiles: [],
      themeQa: { status: 'idle', issueCount: 0, updatedAt: Date.now() }
    };
  });

  // 2. Theme QA Run handler
  ipcMain.handle('antifan:toolbar:theme-qa-run', async (_event, options) => {
    themeQaInvocations++;
    telemetry.ipcCalls.push({ channel: 'antifan:toolbar:theme-qa-run', options, time: Date.now() });
    
    // Simulate real ThemeQaWorkflow output for a non-storefront page (platform: unknown)
    const report = {
      summary: { passed: true, totalIssues: 0, criticalCount: 0 },
      findings: {
        platform: { platform: 'unknown', confidence: 1 },
        liquid: { errors: [] },
        overflow: { culprits: [] },
        assets: { brokenAssets: [] },
        hsRules: { totalViolations: 0, violations: [] },
        diagnosticIssues: [],
        diagnosticWarnings: []
      }
    };
    return { ok: true, report };
  });

  // 3. Workflow Hub handlers
  ipcMain.handle('antifan:workflow:get-state', () => {
    getWorkflowStateInvocations++;
    telemetry.ipcCalls.push({ channel: 'antifan:workflow:get-state', time: Date.now() });
    // Mirror exact native-tab-host.ts implementation
    const workflows = [
      {
        id: 'wf-storefront-qa',
        name: 'Haravan / Sapo Theme Storefront QA & Audit',
        description: 'Tự động kiểm tra vỡ layout ngang (overflow), ảnh hỏng 404, lỗi console JS và chụp ảnh báo cáo.',
        version: '1.0',
        category: 'qa',
        isBuiltIn: true,
        definition: {
          version: '1.0',
          name: 'Haravan / Sapo Theme Storefront QA & Audit',
          description: 'Tự động kiểm tra vỡ layout ngang (overflow), ảnh hỏng 404, lỗi console JS và chụp ảnh báo cáo.',
          steps: [
            { id: 'step-viewport', name: 'Thiết lập Viewport Desktop Full HD', type: 'browser.set_viewport' },
            { id: 'step-overflow', name: 'Quét phần tử tràn ngang', type: 'qa.check_overflow' },
            { id: 'step-images', name: 'Kiểm tra ảnh hỏng 404', type: 'qa.check_broken_images' },
            { id: 'step-console', name: 'Thu thập lỗi JS Console', type: 'qa.check_console_errors' },
            { id: 'step-screenshot', name: 'Chụp ảnh màn hình Viewport', type: 'browser.screenshot' },
            { id: 'step-report', name: 'Tạo báo cáo tổng hợp QA', type: 'report.generate' }
          ]
        }
      }
    ];

    const tools = [
      { id: 'antifan_open_tab', name: 'antifan_open_tab', description: 'Mở tab Chromium mới trong AntiFan Desktop', category: 'browser', permissions: ['execute'] },
      { id: 'antifan_navigate_tab', name: 'antifan_navigate_tab', description: 'Điều hướng tab hiện tại đến URL chỉ định', category: 'browser', permissions: ['execute'] },
      { id: 'antifan_screenshot_tab', name: 'antifan_screenshot_tab', description: 'Chụp ảnh màn hình Viewport hoặc toàn trang (.PNG)', category: 'media', permissions: ['read'] },
      { id: 'antifan_execute_javascript', name: 'antifan_execute_javascript', description: 'Thực thi mã JavaScript trong trang web đang mở', category: 'eval', permissions: ['eval'] },
      { id: 'antifan_click_element', name: 'antifan_click_element', description: 'Click vào phần tử theo CSS selector hoặc XPath', category: 'browser', permissions: ['execute'] },
      { id: 'antifan_input_text', name: 'antifan_input_text', description: 'Nhập văn bản vào input hoặc textarea trên trang', category: 'browser', permissions: ['execute'] },
      { id: 'antifan_inspect_element', name: 'antifan_inspect_element', description: 'Phân tích phần tử DOM tại tọa độ (x, y)', category: 'inspect', permissions: ['read'] },
      { id: 'antifan_find_elements', name: 'antifan_find_elements', description: 'Tìm danh sách phần tử khớp CSS selector', category: 'inspect', permissions: ['read'] },
      { id: 'antifan_set_device_preset', name: 'antifan_set_device_preset', description: 'Chuyển đổi chuẩn thiết bị mô phỏng di động', category: 'device', permissions: ['execute'] },
      { id: 'antifan_sync_chrome_profile', name: 'antifan_sync_chrome_profile', description: 'Đồng bộ Bookmarks, Cookies và History từ Chrome', category: 'auth', permissions: ['read', 'write'] },
      { id: 'antifan_write_terminal', name: 'antifan_write_terminal', description: 'Gửi lệnh thực thi vào phiên Terminal', category: 'terminal', permissions: ['execute'] },
      { id: 'antifan_switch_capsule', name: 'antifan_switch_capsule', description: 'Chuyển đổi dự án Workspace Capsule đang hoạt động', category: 'workspace', permissions: ['write'] }
    ];

    return { workflows, tools };
  });

  ipcMain.handle('antifan:workflow:run', async (_event, payload) => {
    runWorkflowInvocations++;
    telemetry.ipcCalls.push({ channel: 'antifan:workflow:run', payload, time: Date.now() });
    return {
      ok: true,
      status: 'passed',
      passedSteps: 6,
      failedSteps: 0,
      totalDurationMs: 1200,
      stepResults: [],
      artifacts: []
    };
  });

  ipcMain.handle('antifan:toolbar:set-overlay', () => true);
  ipcMain.handle('antifan:tabs:get-list', () => []);
  ipcMain.handle('antifan:toolbar:get-mobile-remote-info', () => null);

  win = new BrowserWindow({
    width: 1200,
    height: 700,
    show: false,
    webPreferences: {
      preload: path.resolve(__dirname, '../../.compiled/src/preload/toolbar-preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  win.webContents.on('console-message', (_e, level, msg) => {
    if (!msg.includes('Insecure Content-Security-Policy')) {
      telemetry.rendererLogs.push({ level, msg });
    }
  });

  const htmlPath = path.resolve(__dirname, '../../.compiled/src/renderer/toolbar.html');
  await win.loadFile(htmlPath);

  // Allow DOMContentLoaded to execute initToolbar
  await new Promise((r) => setTimeout(r, 500));

  console.log('[PROBE] Toolbar loaded. Executing Empirical Traces...');

  // -------------------------------------------------------------
  // TRACE 1: #btnThemeQa click
  // -------------------------------------------------------------
  const t1 = await win.webContents.executeJavaScript(`
    (async () => {
      const btn = document.getElementById('btnThemeQa');
      const textSpan = document.getElementById('themeQaText');
      const overlay = document.getElementById('themeQaOverlay');
      const summary = document.getElementById('themeQaSummary');
      
      const beforeClick = {
        btnText: textSpan?.textContent,
        btnDisabled: btn?.disabled,
        overlayDisplay: overlay?.style.display
      };

      // Click 1: trigger validation
      btn?.click();
      
      // Wait for async validation to resolve
      await new Promise(r => setTimeout(r, 200));

      const afterClick1 = {
        btnText: textSpan?.textContent,
        btnDisabled: btn?.disabled,
        overlayDisplay: overlay?.style.display,
        summaryText: summary?.textContent
      };

      // Close modal
      const closeBtn = document.getElementById('themeQaClose');
      closeBtn?.click();

      const afterClose = {
        overlayDisplay: overlay?.style.display
      };

      // Click 2: should directly open modal without re-running
      btn?.click();
      await new Promise(r => setTimeout(r, 100));

      const afterClick2 = {
        btnText: textSpan?.textContent,
        overlayDisplay: overlay?.style.display
      };

      return { beforeClick, afterClick1, afterClose, afterClick2 };
    })()
  `);
  telemetry.themeQa = { ...t1, invocations: themeQaInvocations };

  // -------------------------------------------------------------
  // TRACE 2: #btnWorkflowHub click & tabs inspection
  // -------------------------------------------------------------
  const t2 = await win.webContents.executeJavaScript(`
    (async () => {
      const btnHub = document.getElementById('btnWorkflowHub');
      const overlay = document.getElementById('workflowHubOverlay');
      const tabWorkflows = document.getElementById('tabNavWorkflows');
      const tabMcp = document.getElementById('tabNavMcp');
      const badgeWf = document.getElementById('badgeWorkflowCount');
      const badgeMcp = document.getElementById('badgeMcpCount');
      const itemsList = document.getElementById('hubItemsList');
      const wfDetail = document.getElementById('hubWfDetail');
      const mcpDetail = document.getElementById('hubMcpDetail');
      const btnRun = document.getElementById('btnRunWorkflow');
      const btnNewWf = document.getElementById('btnHubNewWorkflow');

      // Click 1: Open Hub
      btnHub?.click();
      await new Promise(r => setTimeout(r, 200));

      const afterOpen = {
        overlayDisplay: overlay?.style.display,
        badgeWfCount: badgeWf?.textContent,
        badgeMcpCount: badgeMcp?.textContent,
        itemsCount: itemsList?.querySelectorAll('.hub-list-item').length,
        firstItemTitle: itemsList?.querySelector('.hub-item-title')?.textContent,
        firstItemDesc: itemsList?.querySelector('.hub-item-desc')?.textContent,
        firstItemPill: itemsList?.querySelector('.hub-item-pill')?.textContent,
        wfDetailVisible: wfDetail?.style.display !== 'none',
        btnRunVisible: btnRun?.style.display !== 'none'
      };

      // Click MCP tab
      tabMcp?.click();
      await new Promise(r => setTimeout(r, 200));

      const firstMcpItem = itemsList?.querySelector('.hub-list-item');
      firstMcpItem?.click();
      await new Promise(r => setTimeout(r, 100));

      const mcpDetailName = document.getElementById('mcpDetailName')?.textContent;
      const mcpDetailDesc = document.getElementById('mcpDetailDesc')?.textContent;
      const mcpDetailPerm = document.getElementById('mcpDetailPermission')?.textContent;
      const mcpSchemaCode = document.getElementById('mcpSchemaCode')?.textContent;
      const mcpDetailRunBtn = mcpDetail?.querySelector('.hub-btn-run');

      const afterMcpTab = {
        itemsCount: itemsList?.querySelectorAll('.hub-list-item').length,
        selectedMcpName: mcpDetailName,
        selectedMcpDesc: mcpDetailDesc,
        selectedMcpPerm: mcpDetailPerm,
        selectedMcpSchema: mcpSchemaCode,
        hasRunButton: !!mcpDetailRunBtn
      };

      // Switch back to Workflows tab and test Run
      tabWorkflows?.click();
      await new Promise(r => setTimeout(r, 200));

      btnRun?.click();
      await new Promise(r => setTimeout(r, 300));

      const runStatusPill = document.getElementById('runStatusPill')?.textContent;
      const runCurrentStepText = document.getElementById('runCurrentStepText')?.textContent;

      const afterRunWorkflow = {
        runStatusPill,
        runCurrentStepText
      };

      return { afterOpen, afterMcpTab, afterRunWorkflow };
    })()
  `);
  telemetry.workflowHub = { ...t2, getWorkflowStateInvocations, runWorkflowInvocations };

  console.log('[PROBE RESULTS]');
  console.log(JSON.stringify(telemetry, null, 2));

  fs.writeFileSync(
    path.resolve(__dirname, '../../plans/reports/toolbar-qa-hub-empirical-telemetry.json'),
    JSON.stringify(telemetry, null, 2),
    'utf8'
  );

  app.quit();
});
