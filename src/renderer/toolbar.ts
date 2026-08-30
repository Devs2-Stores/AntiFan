/**
 * AntiFan Browser Desktop — Toolbar Client Script
 * Classic Antigravity Browser UI Logic (Original VS Code Dark Theme).
 */

interface AntiFanTab {
  id: string;
  url: string;
  title: string;
  favicon?: string;
  isLoading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  zoomFactor: number;
  devicePresetId?: string;
  crashed?: boolean;
  isAudible?: boolean;
  isMuted?: boolean;
  scrollX?: number;
  scrollY?: number;
  aiState?: 'idle' | 'thinking' | 'streaming' | 'completed' | 'agent_working';
  isAgentControlled?: boolean;
  themeError?: string | null;
  terminalSessionId?: string;
  splitMode?: boolean;
  splitDesktopPresetId?: string;
  splitMobilePresetId?: string;
  splitFocusedPane?: 'desktop' | 'mobile';
  splitError?: string;
}
interface ThemeQaState { status: 'idle' | 'running' | 'pass' | 'fail' | 'error'; issueCount: number; reportArtifactId?: string; report?: Record<string, unknown>; error?: string; updatedAt: number; }
interface AntiFanToolbarApi {
  getInitialState: () => Promise<any>;
  createTab: (url?: string) => Promise<string>;
  switchTab: (tabId: string) => Promise<boolean>;
  closeTab: (tabId: string) => Promise<boolean>;
  moveTab: (tabId: string, toIndex: number) => Promise<boolean>;
  duplicateTab: (tabId: string) => Promise<string>;
  closeOtherTabs: (tabId: string) => Promise<void>;
  closeTabsToRight: (tabId: string) => Promise<void>;
  setTabTerminalSession: (tabId: string, terminalSessionId: string) => Promise<boolean>;
  navigate: (url: string, tabId?: string) => Promise<boolean>;
  reload: (tabId?: string) => Promise<boolean>;
  reloadWindow: () => Promise<boolean>;
  stopLoading: (tabId?: string) => Promise<boolean>;
  goBack: (tabId?: string) => Promise<boolean>;
  goForward: (tabId?: string) => Promise<boolean>;
  toggleInspect: () => Promise<boolean>;
  toggleFontFinder: () => Promise<boolean>;
  toggleLens: () => Promise<boolean>;
  toggleRuler: () => Promise<boolean>;
  toggleDevTools: () => Promise<void>;
  toggleSidebar: () => Promise<boolean>;
  setDevicePreset: (presetId: string, tabId?: string) => Promise<boolean>;
  setZoom: (zoom: number, tabId?: string) => Promise<boolean>;
  toggleMute: (tabId?: string) => Promise<boolean>;
  captureFullPage: () => Promise<string>;
  captureViewport: () => Promise<string>;
  openExternal: (url?: string) => Promise<boolean>;
  openInVSCode: () => Promise<{ ok: boolean; error?: string; workspacePath?: string }>;
  getBookmarks: () => Promise<any>;
  findInPage: (text: string, forward?: boolean, findNext?: boolean) => Promise<void>;
  stopFindInPage: () => Promise<void>;
  showMenu: () => Promise<void>;
  setOverlay: (active: boolean, customHeight?: number) => Promise<void>;
  getWorkflowState: () => Promise<{ tools: any[]; workflows: any[] }>;
  runWorkflow: (payload: { workflowId?: string; workflowDef?: any }) => Promise<any>;
  abortWorkflow: () => Promise<boolean>;
  saveWorkflow: (item: { id?: string; name: string; description?: string; steps: any[] }) => Promise<any>;
  deleteWorkflow: (id: string) => Promise<boolean>;
  getWorkflowArtifact: (artifactId: string) => Promise<any>;
  onWorkflowEvent: (callback: (event: any) => void) => () => void;
  clearStorage: () => Promise<void>;
  getChromeProfiles: () => Promise<any>;
  syncChromeProfile: (profileId: string) => Promise<any>;
  toggleBookmarkBar: () => Promise<boolean>;
  addBookmark: (title: string, url: string) => Promise<any>;
  removeBookmark: (url: string) => Promise<any>;
  checkUpdates?: () => Promise<void>;
  popoutTerminal?: () => Promise<boolean>;
  getSuggestions: (query: string) => Promise<{ suggestions: Array<{ type: 'search' | 'url' | 'bookmark' | 'history' | 'tab'; text: string; url?: string; tabId?: string; subText?: string }> }>;
  toggleSplitReview: (tabId?: string, enabled?: boolean) => Promise<boolean>;
  setSplitPreset: (paneId: 'desktop' | 'mobile', presetId: string, tabId?: string) => Promise<boolean>;
  setSplitFocusedPane: (paneId: 'desktop' | 'mobile', tabId?: string) => Promise<boolean>;
  onStateUpdated: (callback: (state: any) => void) => () => void;
  onElementPicked: (callback: (element: any) => void) => () => void;
  onFocusFind: (callback: () => void) => () => void;
  onFocusOmnibox: (callback: () => void) => () => void;
  onShowShortcuts: (callback: () => void) => () => void;
  onFindResult: (callback: (result: any) => void) => () => void;
  onScreenshotCaptured?: (callback: () => void) => () => void;
  runThemeQa: (options?: { workspaceRoot?: string }) => Promise<{ ok: boolean; report?: any; error?: string }>;
  onThemeQaState: (callback: (state: ThemeQaState) => void) => () => void;
}

declare global {
  interface Window {
    antifanToolbar?: AntiFanToolbarApi;
  }
}

function getApi(): AntiFanToolbarApi | undefined {
  return window.antifanToolbar;
}
function showToolbarToast(message: string, duration = 2500) {
  const toast = document.getElementById('toolbarToast');
  if (!toast) return;
  toast.innerHTML = message;
  toast.style.display = 'flex';
  setTimeout(() => {
    toast.style.display = 'none';
  }, duration);
}
function renderThemeQa(state: ThemeQaState, report?: Record<string, unknown>) {
  themeQaState = state;
  if (report) {
    lastThemeQaReport = report;
  } else if (state.report) {
    lastThemeQaReport = state.report;
  }
  if (!btnThemeQa || !themeQaText) return;
  btnThemeQa.classList.remove('status-pass', 'status-fail');
  if (state.status === 'running') {
    themeQaText.textContent = 'Checking…';
    btnThemeQa.disabled = true;
  } else if (state.status === 'pass') {
    themeQaText.textContent = 'QA Clean';
    btnThemeQa.classList.add('status-pass');
    btnThemeQa.disabled = false;
  } else if (state.status === 'fail') {
    themeQaText.textContent = `${state.issueCount} Issues`;
    btnThemeQa.classList.add('status-fail');
    btnThemeQa.disabled = false;
  } else if (state.status === 'error') {
    themeQaText.textContent = 'QA Error';
    btnThemeQa.classList.add('status-fail');
    btnThemeQa.disabled = false;
  } else {
    themeQaText.textContent = 'QA';
    btnThemeQa.disabled = false;
  }
}
function openThemeQaSummary() {
  if (!themeQaOverlay || !themeQaSummary) return;
  const report = (lastThemeQaReport || themeQaState.report) as Record<string, unknown> | undefined;
  const findings = report?.findings as Record<string, unknown> | undefined;
  const summary = report?.summary as Record<string, unknown> | undefined;
  const platform = findings?.platform as Record<string, unknown> | undefined;
  const liquid = findings?.liquid as { errors?: Array<{ message?: string }> } | undefined;
  const overflow = findings?.overflow as { culprits?: Array<{ selector?: string }> } | undefined;
  const assets = findings?.assets as { brokenAssets?: Array<{ url?: string; src?: string }> } | undefined;
  const hsRules = findings?.hsRules as { totalViolations?: number; violations?: Array<{ ruleId?: string; message?: string }> } | undefined;
  const diagnosticIssues = findings?.diagnosticIssues as Array<{ kind?: string; message?: string; origin?: string }> | undefined;
  const diagnosticWarnings = findings?.diagnosticWarnings as Array<{ kind?: string; message?: string; origin?: string }> | undefined;

  const lines = findings ? [
    `Platform: ${platform?.platform || 'unknown'}`,
    `Result: ${summary?.passed ? 'PASSED' : 'FAILED'} (Critical: ${summary?.criticalCount ?? liquid?.errors?.length ?? 0}, Total: ${summary?.totalIssues ?? 0})`,
    `Liquid errors: ${liquid?.errors?.length || 0}`,
    `Layout overflow culprits: ${overflow?.culprits?.length || 0}`,
    `Broken assets: ${assets?.brokenAssets?.length || 0}`,
    `HS violations: ${hsRules?.totalViolations || 0}`,
    `Diagnostic issues (critical): ${diagnosticIssues?.length || 0}`,
    `Diagnostic warnings: ${diagnosticWarnings?.length || 0}`,
    '',
    ...(liquid?.errors || []).map((item) => `[Liquid] ${item.message || 'unknown error'}`),
    ...(overflow?.culprits || []).map((item) => `[Overflow] ${item.selector || 'unknown element'}`),
    ...(assets?.brokenAssets || []).map((item) => `[Asset] ${item.url || item.src || 'unknown asset'}`),
    ...(hsRules?.violations || []).map((item) => `[HS] ${item.ruleId || 'rule'}: ${item.message || ''}`),
    ...(diagnosticIssues || []).map((item) => `[Diagnostics Critical] [${item.kind || 'issue'}] ${item.message || ''}${item.origin ? ` (${item.origin})` : ''}`),
    ...(diagnosticWarnings || []).map((item) => `[Diagnostics Warning] [${item.kind || 'warning'}] ${item.message || ''}${item.origin ? ` (${item.origin})` : ''}`),
  ] : [themeQaState.error || 'No validation has been run.'];
  themeQaSummary.textContent = lines.join('\n');
  themeQaOverlay.style.display = 'flex';
  getApi()?.setOverlay(true);
}

let currentTabs: AntiFanTab[] = [];
let currentBookmarks: Array<{ id: string; title: string; url: string }> = [];
let activeTabId: string = '';
let isInspecting = false;
let isFontFinderActive = false;
let isLensActive = false;
let isRulerActive = false;
let themeQaState: ThemeQaState = { status: 'idle', issueCount: 0, updatedAt: Date.now() };
let lastThemeQaReport: any = null;
const btnPopoutTerminal = document.getElementById('btnPopoutTerminal') as HTMLButtonElement | null;

// DOM Elements
const tabList = document.getElementById('tabList')!;
const btnNewTab = document.getElementById('btnNewTab')!;
const btnBack = document.getElementById('btnBack') as HTMLButtonElement;
const btnForward = document.getElementById('btnForward') as HTMLButtonElement;
const btnReload = document.getElementById('btnReload') as HTMLButtonElement;
const urlInput = document.getElementById('urlInput') as HTMLInputElement;
const btnClearOmnibox = document.getElementById('btnClearOmnibox') as HTMLButtonElement;
const deviceSelect = document.getElementById('deviceSelect') as HTMLSelectElement;
const btnToggleSplit = document.getElementById('btnToggleSplit') as HTMLButtonElement | null;
const splitControlsContainer = document.getElementById('splitControlsContainer') as HTMLElement | null;
const splitDesktopSelect = document.getElementById('splitDesktopSelect') as HTMLSelectElement | null;
const splitMobileSelect = document.getElementById('splitMobileSelect') as HTMLSelectElement | null;
const btnSplitFocusDesktop = document.getElementById('btnSplitFocusDesktop') as HTMLButtonElement | null;
const btnSplitFocusMobile = document.getElementById('btnSplitFocusMobile') as HTMLButtonElement | null;
const agentActiveBadge = document.getElementById('agentActiveBadge') as HTMLElement | null;

// Zoom Stepper Elements
const zoomLabel = document.getElementById('zoomLabel')!;
const btnZoomOutPop = document.getElementById('btnZoomOutPop') as HTMLButtonElement;
const btnZoomInPop = document.getElementById('btnZoomInPop') as HTMLButtonElement;

// Tool Buttons
const btnThemeQa = document.getElementById('btnThemeQa') as HTMLButtonElement | null;
const btnQuickInspect = document.getElementById('btnQuickInspect') as HTMLButtonElement;
const themeQaText = document.getElementById('themeQaText') as HTMLElement | null;
const themeQaOverlay = document.getElementById('themeQaOverlay') as HTMLElement | null;
const themeQaClose = document.getElementById('themeQaClose') as HTMLButtonElement | null;
const themeQaSummary = document.getElementById('themeQaSummary') as HTMLElement | null;
const btnFontFinder = document.getElementById('btnFontFinder') as HTMLButtonElement;
const btnRuler = document.getElementById('btnRuler') as HTMLButtonElement;
const btnCaptureFullPage = document.getElementById('btnCaptureFullPage') as HTMLButtonElement;
const btnMobileRemote = document.getElementById('btnMobileRemote') as HTMLButtonElement;
const mobileRemoteOverlay = document.getElementById('mobileRemoteOverlay')!;
const mobileRemoteClose = document.getElementById('mobileRemoteClose') as HTMLButtonElement;
const mobileRemoteQrContainer = document.getElementById('mobileRemoteQrContainer')!;
const mobileRemoteUrlsList = document.getElementById('mobileRemoteUrlsList')!;
const btnDevTools = document.getElementById('btnDevTools') as HTMLButtonElement;
const btnToggleSidebar = document.getElementById('btnToggleSidebar') as HTMLButtonElement;
const btnChromeProfile = document.getElementById('btnChromeProfile') as HTMLButtonElement;
const profileAvatar = document.getElementById('profileAvatar')!;
const profileName = document.getElementById('profileName')!;
const profileDropdownMenu = document.getElementById('profileDropdownMenu')!;
const profileDropdownList = document.getElementById('profileDropdownList')!;
const btnMenu = document.getElementById('btnMenu') as HTMLButtonElement;
const codexMainMenu = document.getElementById('codexMainMenu')!;

let activeProfileInfo: any = null;
let availableChromeProfiles: any[] = [];

// Menu Items
const menuFind = document.getElementById('menuFind')!;
const menuQuickAnnotate = document.getElementById('menuQuickAnnotate')!;
const menuFontFinder = document.getElementById('menuFontFinder')!;
const menuLens = document.getElementById('menuLens')!;
const menuOpenBrowser = document.getElementById('menuOpenBrowser')!;
const menuShortcuts = document.getElementById('menuShortcuts')!;

// Find Bar
const findBar = document.getElementById('findBar')!;
const findInput = document.getElementById('findInput') as HTMLInputElement;
const findCount = document.getElementById('findCount')!;
const findPrev = (document.getElementById('btnFindPrev') || document.getElementById('findPrev')) as HTMLButtonElement;
const findNext = (document.getElementById('btnFindNext') || document.getElementById('findNext')) as HTMLButtonElement;
const findClose = (document.getElementById('btnFindClose') || document.getElementById('findClose')) as HTMLButtonElement;

// Shortcuts Overlay
const shortcutsOverlay = document.getElementById('shortcutsOverlay')!;
const shortcutsClose = document.getElementById('shortcutsClose') as HTMLButtonElement;

// Workflow & MCP Hub Elements
const btnWorkflowHub = document.getElementById('btnWorkflowHub') as HTMLButtonElement | null;
const workflowHubOverlay = document.getElementById('workflowHubOverlay') as HTMLElement | null;
const btnWorkflowHubClose = document.getElementById('btnWorkflowHubClose') as HTMLButtonElement | null;
const tabNavWorkflows = document.getElementById('tabNavWorkflows') as HTMLButtonElement | null;
const tabNavMcp = document.getElementById('tabNavMcp') as HTMLButtonElement | null;
const badgeWorkflowCount = document.getElementById('badgeWorkflowCount') as HTMLElement | null;
const badgeMcpCount = document.getElementById('badgeMcpCount') as HTMLElement | null;
const hubSearchInput = document.getElementById('hubSearchInput') as HTMLInputElement | null;
const hubSearchClear = document.getElementById('hubSearchClear') as HTMLButtonElement | null;
const btnHubNewWorkflow = document.getElementById('btnHubNewWorkflow') as HTMLButtonElement | null;
const hubItemsList = document.getElementById('hubItemsList') as HTMLElement | null;
const hubDetailEmpty = document.getElementById('hubDetailEmpty') as HTMLElement | null;
const hubWfDetail = document.getElementById('hubWfDetail') as HTMLElement | null;
const hubMcpDetail = document.getElementById('hubMcpDetail') as HTMLElement | null;

const wfDetailCategory = document.getElementById('wfDetailCategory') as HTMLElement | null;
const wfDetailName = document.getElementById('wfDetailName') as HTMLElement | null;
const wfDetailDesc = document.getElementById('wfDetailDesc') as HTMLElement | null;
const btnRunWorkflow = document.getElementById('btnRunWorkflow') as HTMLButtonElement | null;
const btnStopWorkflow = document.getElementById('btnStopWorkflow') as HTMLButtonElement | null;
const btnCopyWorkflowJson = document.getElementById('btnCopyWorkflowJson') as HTMLButtonElement | null;
const btnDeleteCustomWf = document.getElementById('btnDeleteCustomWf') as HTMLButtonElement | null;

const hubRunStatusBar = document.getElementById('hubRunStatusBar') as HTMLElement | null;
const runStatusPill = document.getElementById('runStatusPill') as HTMLElement | null;
const runCurrentStepText = document.getElementById('runCurrentStepText') as HTMLElement | null;
const runTimerText = document.getElementById('runTimerText') as HTMLElement | null;
const hubProgressBar = document.getElementById('hubProgressBar') as HTMLElement | null;
const wfStepsCount = document.getElementById('wfStepsCount') as HTMLElement | null;
const wfStepsContainer = document.getElementById('wfStepsContainer') as HTMLElement | null;
const wfArtifactsSection = document.getElementById('wfArtifactsSection') as HTMLElement | null;
const wfArtifactsGrid = document.getElementById('wfArtifactsGrid') as HTMLElement | null;

const mcpDetailCategory = document.getElementById('mcpDetailCategory') as HTMLElement | null;
const mcpDetailName = document.getElementById('mcpDetailName') as HTMLElement | null;
const mcpDetailDesc = document.getElementById('mcpDetailDesc') as HTMLElement | null;
const mcpDetailPermission = document.getElementById('mcpDetailPermission') as HTMLElement | null;
const mcpSchemaCode = document.getElementById('mcpSchemaCode') as HTMLElement | null;

let hubActiveTab: 'workflows' | 'mcp' = 'workflows';
let hubWorkflows: any[] = [];
let hubMcpTools: any[] = [];
let hubSelectedWorkflow: any = null;
let hubSelectedMcpTool: any = null;
let isWorkflowRunning = false;
let runStartTime = 0;
let runTimerInterval: any = null;

function getStepIcon(type: string): string {
  if (type.startsWith('browser.navigate')) return '🌐';
  if (type.startsWith('browser.click')) return '👆';
  if (type.startsWith('browser.type')) return '✍️';
  if (type.startsWith('browser.scroll')) return '📜';
  if (type.startsWith('browser.hover')) return '🎯';
  if (type.startsWith('browser.highlight')) return '✨';
  if (type.startsWith('browser.wait')) return '⏳';
  if (type.startsWith('browser.screenshot')) return '📸';
  if (type.startsWith('browser.extract')) return '🔍';
  if (type.startsWith('browser.set_')) return '📱';
  if (type.startsWith('qa.')) return '🛡️';
  if (type.startsWith('file.')) return '📄';
  if (type.startsWith('report.')) return '📊';
  return '⚡';
}

async function openWorkflowHub() {
  if (!workflowHubOverlay) return;
  workflowHubOverlay.style.display = 'flex';
  getApi()?.setOverlay(true);

  try {
    const res = await getApi()?.getWorkflowState();
    if (res) {
      hubWorkflows = res.workflows || [];
      hubMcpTools = res.tools || [];
      if (badgeWorkflowCount) badgeWorkflowCount.textContent = String(hubWorkflows.length);
      if (badgeMcpCount) badgeMcpCount.textContent = String(hubMcpTools.length);
    }
  } catch (err) {
    console.error('[workflow hub] Failed to fetch state:', err);
  }

  renderHubList();
  if (hubActiveTab === 'workflows' && hubWorkflows.length > 0 && !hubSelectedWorkflow) {
    selectWorkflow(hubWorkflows[0]);
  } else if (hubActiveTab === 'mcp' && hubMcpTools.length > 0 && !hubSelectedMcpTool) {
    selectMcpTool(hubMcpTools[0]);
  }
}

function closeWorkflowHub() {
  if (!workflowHubOverlay) return;
  workflowHubOverlay.style.display = 'none';
  getApi()?.setOverlay(false);
}

function renderHubList() {
  if (!hubItemsList) return;
  hubItemsList.innerHTML = '';
  const search = (hubSearchInput?.value || '').toLowerCase().trim();

  if (hubActiveTab === 'workflows') {
    const filtered = hubWorkflows.filter((w) =>
      w.name.toLowerCase().includes(search) ||
      (w.description && w.description.toLowerCase().includes(search)) ||
      (w.category && w.category.toLowerCase().includes(search))
    );

    if (filtered.length === 0) {
      hubItemsList.innerHTML = '<div style="color:#64748b;font-size:12px;padding:20px;text-align:center;">Không tìm thấy kịch bản nào.</div>';
      return;
    }

    filtered.forEach((wf) => {
      const item = document.createElement('div');
      item.className = `hub-list-item ${hubSelectedWorkflow?.id === wf.id ? 'selected' : ''}`;
      const catClass = `pill-${wf.category || 'qa'}`;
      const stepsCount = wf.definition?.steps?.length || 0;

      item.innerHTML = `
        <div class="hub-item-top">
          <span class="hub-item-title">${escapeHtml(wf.name)}</span>
          <span class="hub-item-pill ${catClass}">${escapeHtml(wf.category || 'QA')}</span>
        </div>
        <div class="hub-item-desc">${escapeHtml(wf.description || 'Chưa có mô tả')}</div>
        <div class="hub-item-meta">
          <span>📑 ${stepsCount} bước</span>
          <span>•</span>
          <span>${wf.isBuiltIn ? '🔒 Mặc định' : '✏️ Tùy chỉnh'}</span>
        </div>
      `;
      item.onclick = () => selectWorkflow(wf);
      hubItemsList.appendChild(item);
    });
  } else {
    const filtered = hubMcpTools.filter((t) =>
      t.name.toLowerCase().includes(search) ||
      (t.description && t.description.toLowerCase().includes(search)) ||
      (t.category && t.category.toLowerCase().includes(search))
    );

    if (filtered.length === 0) {
      hubItemsList.innerHTML = '<div style="color:#64748b;font-size:12px;padding:20px;text-align:center;">Không tìm thấy MCP Tool nào.</div>';
      return;
    }

    filtered.forEach((tool) => {
      const item = document.createElement('div');
      item.className = `hub-list-item ${hubSelectedMcpTool?.id === tool.id ? 'selected' : ''}`;
      const catClass = `pill-${tool.category || 'browser'}`;

      item.innerHTML = `
        <div class="hub-item-top">
          <span class="hub-item-title">${escapeHtml(tool.name)}</span>
          <span class="hub-item-pill ${catClass}">${escapeHtml(tool.category || 'tool')}</span>
        </div>
        <div class="hub-item-desc">${escapeHtml(tool.description || 'Không có mô tả')}</div>
        <div class="hub-item-meta">
          <span>Quyền: ${(tool.permissions || ['read']).join(', ')}</span>
        </div>
      `;
      item.onclick = () => selectMcpTool(tool);
      hubItemsList.appendChild(item);
    });
  }
}

function selectWorkflow(wf: any) {
  hubSelectedWorkflow = wf;
  hubSelectedMcpTool = null;
  renderHubList();

  if (hubDetailEmpty) hubDetailEmpty.style.display = 'none';
  if (hubMcpDetail) hubMcpDetail.style.display = 'none';
  if (hubWfDetail) hubWfDetail.style.display = 'flex';

  if (wfDetailCategory) {
    wfDetailCategory.textContent = (wf.category || 'QA').toUpperCase();
    wfDetailCategory.className = `hub-cat-pill pill-${wf.category || 'qa'}`;
  }
  if (wfDetailName) wfDetailName.textContent = wf.name;
  if (wfDetailDesc) wfDetailDesc.textContent = wf.description || '';
  if (btnDeleteCustomWf) {
    btnDeleteCustomWf.style.display = wf.isBuiltIn ? 'none' : 'inline-block';
  }

  const steps = wf.definition?.steps || [];
  if (wfStepsCount) wfStepsCount.textContent = `${steps.length} Bước`;
  if (wfStepsContainer) {
    wfStepsContainer.innerHTML = '';
    steps.forEach((step: any, idx: number) => {
      const card = document.createElement('div');
      card.className = 'hub-step-card';
      card.id = `step-card-${step.id || idx}`;

      const icon = getStepIcon(step.type);
      const paramsSummary = Object.entries(step.params || {})
        .map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`)
        .join(' | ');

      card.innerHTML = `
        <div class="hub-step-idx">${idx + 1}</div>
        <div class="hub-step-icon">${icon}</div>
        <div class="hub-step-info">
          <div class="hub-step-title">${escapeHtml(step.name)}</div>
          <div class="hub-step-meta">
            <span class="hub-step-tag">${escapeHtml(step.type)}</span>
            ${paramsSummary ? `<span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(paramsSummary)}</span>` : ''}
          </div>
        </div>
        <div class="hub-step-status step-status-pending" id="step-status-${step.id || idx}">PENDING</div>
      `;
      wfStepsContainer.appendChild(card);
    });
  }

  if (hubRunStatusBar) hubRunStatusBar.style.display = 'none';
  if (wfArtifactsSection) wfArtifactsSection.style.display = 'none';
  if (wfArtifactsGrid) wfArtifactsGrid.innerHTML = '';
}

function selectMcpTool(tool: any) {
  hubSelectedMcpTool = tool;
  hubSelectedWorkflow = null;
  renderHubList();

  if (hubDetailEmpty) hubDetailEmpty.style.display = 'none';
  if (hubWfDetail) hubWfDetail.style.display = 'none';
  if (hubMcpDetail) hubMcpDetail.style.display = 'flex';

  if (mcpDetailCategory) {
    mcpDetailCategory.textContent = (tool.category || 'BROWSER').toUpperCase();
    mcpDetailCategory.className = `hub-cat-pill pill-${tool.category || 'browser'}`;
  }
  if (mcpDetailName) mcpDetailName.textContent = tool.name;
  if (mcpDetailDesc) mcpDetailDesc.textContent = tool.description || 'Không có mô tả chi tiết.';
  if (mcpDetailPermission) {
    mcpDetailPermission.textContent = `Quyền Yêu Cầu: ${(tool.permissions || ['read']).join(', ')}`;
  }
  if (mcpSchemaCode) {
    try {
      mcpSchemaCode.textContent = JSON.stringify(tool.inputSchema || {}, null, 2);
    } catch {
      mcpSchemaCode.textContent = String(tool.inputSchema);
    }
  }
}

async function runActiveWorkflow() {
  if (!hubSelectedWorkflow || isWorkflowRunning) return;
  isWorkflowRunning = true;

  if (btnRunWorkflow) btnRunWorkflow.style.display = 'none';
  if (btnStopWorkflow) btnStopWorkflow.style.display = 'flex';
  if (hubRunStatusBar) hubRunStatusBar.style.display = 'flex';
  if (runStatusPill) {
    runStatusPill.className = 'hub-status-pill pill-running';
    runStatusPill.textContent = 'RUNNING';
  }
  if (runCurrentStepText) runCurrentStepText.textContent = 'Bắt đầu khởi chạy workflow...';
  if (hubProgressBar) hubProgressBar.style.width = '5%';

  const steps = hubSelectedWorkflow.definition?.steps || [];
  steps.forEach((s: any, idx: number) => {
    const pill = document.getElementById(`step-status-${s.id || idx}`);
    if (pill) {
      pill.className = 'hub-step-status step-status-pending';
      pill.textContent = 'PENDING';
    }
    const card = document.getElementById(`step-card-${s.id || idx}`);
    if (card) {
      card.className = 'hub-step-card';
    }
  });

  runStartTime = Date.now();
  if (runTimerInterval) clearInterval(runTimerInterval);
  runTimerInterval = setInterval(() => {
    const elapsed = ((Date.now() - runStartTime) / 1000).toFixed(1);
    if (runTimerText) runTimerText.textContent = `${elapsed}s`;
  }, 100);

  try {
    const res = await getApi()?.runWorkflow({ workflowId: hubSelectedWorkflow.id, workflowDef: hubSelectedWorkflow.definition });
    if (res) {
      const isPassed = res.status === 'passed';
      if (runStatusPill) {
        runStatusPill.className = `hub-status-pill ${isPassed ? 'pill-passed' : 'pill-failed'}`;
        runStatusPill.textContent = isPassed ? 'PASSED (100%)' : (res.status || 'FAILED').toUpperCase();
      }
      if (runCurrentStepText) {
        runCurrentStepText.textContent = `Hoàn thành: ${res.passedSteps || 0}/${steps.length} bước thành công (${((res.totalDurationMs || 0) / 1000).toFixed(2)}s)`;
      }
      if (hubProgressBar) hubProgressBar.style.width = '100%';

      if (res.artifacts && res.artifacts.length > 0 && wfArtifactsSection && wfArtifactsGrid) {
        wfArtifactsSection.style.display = 'flex';
        wfArtifactsGrid.innerHTML = '';
        for (const art of res.artifacts) {
          const card = document.createElement('div');
          card.className = 'hub-artifact-card';
          card.innerHTML = `
            <div class="hub-artifact-preview">
              <span style="font-size:32px;">📸</span>
            </div>
            <div class="hub-artifact-meta">
              <div class="hub-artifact-title">${escapeHtml(art.name || art.id)}</div>
              <div class="hub-artifact-desc">${escapeHtml(art.mimeType || 'artifact')} (${Math.round((art.sizeBytes || 0) / 1024)} KB)</div>
            </div>
          `;
          try {
            getApi()?.getWorkflowArtifact(art.id).then((fullArt) => {
              if (fullArt && fullArt.data && fullArt.mimeType.startsWith('image/')) {
                const preview = card.querySelector('.hub-artifact-preview');
                if (preview) {
                  preview.innerHTML = `<img src="${fullArt.data}" alt="${escapeHtml(art.name || '')}" />`;
                }
              }
            });
          } catch {}
          wfArtifactsGrid.appendChild(card);
        }
      }
      showToolbarToast(isPassed ? '✅ Workflow chạy hoàn tất thành công!' : '⚠️ Workflow kết thúc có lỗi.');
    }
  } catch (err: any) {
    console.error('[workflow] Run failed:', err);
    if (runStatusPill) {
      runStatusPill.className = 'hub-status-pill pill-failed';
      runStatusPill.textContent = 'ERROR';
    }
    if (runCurrentStepText) runCurrentStepText.textContent = `Lỗi: ${err.message || String(err)}`;
    showToolbarToast(`❌ Lỗi chạy workflow: ${err.message || String(err)}`);
  } finally {
    isWorkflowRunning = false;
    if (runTimerInterval) {
      clearInterval(runTimerInterval);
      runTimerInterval = null;
    }
    if (btnRunWorkflow) btnRunWorkflow.style.display = 'flex';
    if (btnStopWorkflow) btnStopWorkflow.style.display = 'none';
  }
}

async function stopActiveWorkflow() {
  try {
    await getApi()?.abortWorkflow();
    showToolbarToast('⏹ Đã yêu cầu dừng Workflow.');
  } catch (err) {
    console.error('[workflow] Failed to abort:', err);
  }
}
function hostname(u: string): string {
  try {
    return new URL(u).hostname || u;
  } catch {
    return u;
  }
}

function escapeHtml(text: string): string {
  return (text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

let draggedTabId: string | null = null;

function renderTabs() {
  if (!tabList) return;

  const currentTabIds = new Set(currentTabs.map((t) => t.id));
  
  // 1. Remove closed tabs
  Array.from(tabList.children).forEach((child) => {
    const tabId = child.getAttribute('data-tab-id');
    if (tabId && !currentTabIds.has(tabId)) {
      child.remove();
    }
  });

  // 2. Update or insert tabs
  currentTabs.forEach((tab, index) => {
    let tabEl = tabList.querySelector(`[data-tab-id="${tab.id}"]`) as HTMLElement;
    const isActive = tab.id === activeTabId;

    if (!tabEl) {
      tabEl = document.createElement('div');
      tabEl.setAttribute('data-tab-id', tab.id);
      tabEl.setAttribute('role', 'tab');
      tabEl.setAttribute('draggable', 'true');
      
      tabEl.innerHTML = `
        <span class="tab-spinner" style="display:none;"></span>
        <img class="tab-icon" src="" alt=""/>
        <span class="tab-agent-badge" style="display:none;">🤖 AGENT</span>
        <span class="tab-title"></span>
        <span class="tab-audio-btn" style="display:none;" title="Tắt tiếng tab"></span>
        <span class="tab-status-dot done" title="Ready"></span>
        <span class="tab-close" title="Close Tab"></span>
      `;

      const closeBtn = tabEl.querySelector('.tab-close');
      if (closeBtn) {
        closeBtn.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          getApi()?.closeTab(tab.id);
        });
        closeBtn.addEventListener('mousedown', (e) => {
          e.stopPropagation();
        });
      }

      tabEl.querySelector('.tab-audio-btn')?.addEventListener('click', (e) => {
        e.stopPropagation();
        getApi()?.toggleMute(tab.id);
      });

      tabEl.addEventListener('click', (e) => {
        const target = e.target as HTMLElement | null;
        if (target && target.closest('.tab-close, .tab-audio-btn')) return;
        hideTabContextMenu();
        getApi()?.switchTab(tab.id);
      });

      tabEl.addEventListener('auxclick', (e) => {
        if (e.button === 1) {
          e.preventDefault();
          e.stopPropagation();
          getApi()?.closeTab(tab.id);
        }
      });

      tabEl.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        e.stopPropagation();
        showTabContextMenu(e.clientX, e.clientY, tab.id);
      });

      // Drag and Drop Tab Reordering
      tabEl.addEventListener('dragstart', (e) => {
        draggedTabId = tab.id;
        tabEl.classList.add('tab-dragging');
        if (e.dataTransfer) {
          e.dataTransfer.effectAllowed = 'move';
          e.dataTransfer.setData('text/plain', tab.id);
        }
      });

      tabEl.addEventListener('dragend', () => {
        draggedTabId = null;
        document.querySelectorAll('.tab').forEach((el) => {
          el.classList.remove('tab-dragging', 'drag-over');
        });
      });

      tabEl.addEventListener('dragover', (e) => {
        e.preventDefault();
        if (e.dataTransfer) {
          e.dataTransfer.dropEffect = 'move';
        }
        if (draggedTabId && draggedTabId !== tab.id) {
          tabEl.classList.add('drag-over');
        }
      });

      tabEl.addEventListener('dragleave', () => {
        tabEl.classList.remove('drag-over');
      });

      tabEl.addEventListener('drop', (e) => {
        e.preventDefault();
        tabEl.classList.remove('drag-over');
        if (!draggedTabId || draggedTabId === tab.id) return;
        
        const toIndex = currentTabs.findIndex((t) => t.id === tab.id);
        if (toIndex !== -1) {
          getApi()?.moveTab(draggedTabId, toIndex);
        }
      });

      tabList.appendChild(tabEl);
    }

    // Sync tab position if reordered
    if (tabList.children[index] !== tabEl) {
      tabList.insertBefore(tabEl, tabList.children[index] || null);
    }
    // Update classes & aria
    const isAiStreaming = tab.aiState === 'streaming' || tab.aiState === 'thinking';
    const isAiCompleted = tab.aiState === 'completed';
    const isAgentWorking = tab.aiState === 'agent_working';
    const isAgentControlled = tab.isAgentControlled === true;
    const hasThemeError = Boolean(tab.themeError);

    tabEl.className = `tab ${isActive ? 'active' : ''} ${isAgentControlled ? 'agent-controlled' : ''} ${isAgentWorking ? 'agent-working' : isAiStreaming ? 'ai-streaming' : ''} ${hasThemeError ? 'tab-has-error' : ''}`;
    tabEl.setAttribute('aria-selected', isActive ? 'true' : 'false');
    // Update Spinner & Icon
    const spinner = tabEl.querySelector('.tab-spinner') as HTMLElement;
    const icon = tabEl.querySelector('.tab-icon') as HTMLImageElement;
    const statusDot = tabEl.querySelector('.tab-status-dot') as HTMLElement;
    const agentBadge = tabEl.querySelector('.tab-agent-badge') as HTMLElement;
    const titleSpan = tabEl.querySelector('.tab-title') as HTMLElement;
    const audioBtn = tabEl.querySelector('.tab-audio-btn') as HTMLElement;

    // Keep the ownership badge visible for the automation target even when
    // the short-lived activity state has returned to idle.
    if (agentBadge) {
      if (isAgentWorking) {
        agentBadge.style.display = 'inline-flex';
        agentBadge.className = 'tab-agent-badge agent';
        agentBadge.textContent = '🤖 AGENT';
      } else if (isAgentControlled) {
        agentBadge.style.display = 'inline-flex';
        agentBadge.className = 'tab-agent-badge controlled';
        agentBadge.textContent = '🎯 AGENT TAB';
      } else if (isAiStreaming) {
        agentBadge.style.display = 'inline-flex';
        agentBadge.className = 'tab-agent-badge ai';
        agentBadge.textContent = '⚡ AI';
      } else {
        agentBadge.style.display = 'none';
      }
    }
    // Update Audio & Mute State
    if (audioBtn) {
      if (tab.isAudible || tab.isMuted) {
        audioBtn.style.display = 'inline-flex';
        if (tab.isMuted) {
          audioBtn.className = 'tab-audio-btn muted';
          audioBtn.title = 'Bật tiếng tab (Muted)';
          audioBtn.innerHTML = `<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 5L6 9H2v6h4l5 4V5z"/><line x1="23" y1="9" x2="17" y2="15"/><line x1="17" y1="9" x2="23" y2="15"/></svg>`;
        } else {
          audioBtn.className = 'tab-audio-btn playing';
          audioBtn.title = 'Tắt tiếng tab (Đang phát âm thanh)';
          audioBtn.innerHTML = `<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 5L6 9H2v6h4l5 4V5z"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/></svg>`;
        }
      } else {
        audioBtn.style.display = 'none';
      }
    }


    if (hasThemeError) {
      if (spinner) spinner.style.display = 'none';
      if (icon) icon.style.display = 'inline-block';
      if (statusDot) {
        statusDot.style.display = 'inline-block';
        statusDot.className = 'tab-status-dot theme-error';
        statusDot.title = `⚠️ Lỗi Theme: ${tab.themeError}`;
      }
    } else if (tab.isLoading) {
      if (spinner) spinner.style.display = 'inline-block';
      if (icon) icon.style.display = 'none';
      if (statusDot) {
        statusDot.style.display = 'inline-block';
        statusDot.className = 'tab-status-dot loading';
        statusDot.title = 'Đang tải trang...';
      }
    } else {
      if (spinner) spinner.style.display = 'none';
      if (icon) {
        icon.style.display = 'inline-block';
        icon.src = tab.favicon || 'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="%2394a3b8" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"/><path d="M2 12h20"/></svg>';
      }
      if (statusDot) {
        if (isAgentWorking) {
          statusDot.style.display = 'inline-block';
          statusDot.className = 'tab-status-dot agent-working';
          statusDot.title = '🤖 AI Agent đang điều phối tab này!';
        } else if (isAiStreaming) {
          statusDot.style.display = 'inline-block';
          statusDot.className = 'tab-status-dot ai-streaming';
          statusDot.title = '⚡ AI đang phản hồi...';
        } else if (isAiCompleted) {
          statusDot.style.display = 'inline-block';
          statusDot.className = 'tab-status-dot ai-completed';
          statusDot.title = '✓ AI đã phản hồi xong!';
        } else {
          statusDot.style.display = 'none';
          statusDot.className = 'tab-status-dot';
          statusDot.title = '';
        }
      }
    }
    const baseTitle = tab.title || hostname(tab.url) || 'New Tab';
    if (titleSpan && titleSpan.textContent !== baseTitle) {
      titleSpan.textContent = baseTitle;
    }
  });
}

function updateControls() {
  const activeTab = currentTabs.find((t) => t.id === activeTabId);
  if (activeTab) {
    if (document.activeElement !== urlInput && urlInput) {
      urlInput.value = activeTab.url === 'about:blank' ? '' : activeTab.url;
    }
    if (btnBack) btnBack.disabled = !activeTab.canGoBack;
    if (btnForward) btnForward.disabled = !activeTab.canGoForward;
    
    const pct = `${Math.round(activeTab.zoomFactor * 100)}%`;
    if (zoomLabel) zoomLabel.textContent = pct;

    if (activeTab.devicePresetId && deviceSelect) {
      deviceSelect.value = activeTab.devicePresetId;
    }
    if (activeTab.splitMode) {
      if (btnToggleSplit) btnToggleSplit.classList.add('mode-active');
      if (splitControlsContainer) splitControlsContainer.style.display = 'flex';
      if (deviceSelect) deviceSelect.style.display = 'none';
      if (splitDesktopSelect && activeTab.splitDesktopPresetId) {
        splitDesktopSelect.value = activeTab.splitDesktopPresetId;
      }
      if (splitMobileSelect && activeTab.splitMobilePresetId) {
        splitMobileSelect.value = activeTab.splitMobilePresetId;
      }
      const focusedPane = activeTab.splitFocusedPane || 'desktop';
      if (btnSplitFocusDesktop) btnSplitFocusDesktop.classList.toggle('active', focusedPane === 'desktop');
      if (btnSplitFocusMobile) btnSplitFocusMobile.classList.toggle('active', focusedPane === 'mobile');
    } else {
      if (btnToggleSplit) btnToggleSplit.classList.remove('mode-active');
      if (splitControlsContainer) splitControlsContainer.style.display = 'none';
      if (deviceSelect) deviceSelect.style.display = 'inline-block';
    }

    if (agentActiveBadge) {
      agentActiveBadge.style.display = activeTab.isAgentControlled ? 'inline-flex' : 'none';
    }
  }
  if (btnClearOmnibox && urlInput) {
    btnClearOmnibox.style.display = urlInput.value ? 'block' : 'none';
  }

  if (btnQuickInspect) {
    if (isInspecting) btnQuickInspect.classList.add('mode-active');
    else btnQuickInspect.classList.remove('mode-active');
  }

  if (btnFontFinder) {
    if (isFontFinderActive) btnFontFinder.classList.add('mode-active');
    else btnFontFinder.classList.remove('mode-active');
  }

  if (btnRuler) {
    if (isRulerActive) btnRuler.classList.add('mode-active');
    else btnRuler.classList.remove('mode-active');
  }
}

const bookmarkBar = document.getElementById('bookmarkBar')!;
const bookmarkItems = document.getElementById('bookmarkItems')!;
const btnStarBookmark = document.getElementById('btnStarBookmark') as HTMLButtonElement;
const btnBookmarksMenu = document.getElementById('btnBookmarksMenu') as HTMLButtonElement | null;
const bookmarksDropdownMenu = document.getElementById('bookmarksDropdownMenu') as HTMLElement | null;
const bookmarksCountPill = document.getElementById('bookmarksCountPill') as HTMLElement | null;
const inputBookmarkSearch = document.getElementById('inputBookmarkSearch') as HTMLInputElement | null;
const bookmarksDropdownList = document.getElementById('bookmarksDropdownList') as HTMLElement | null;

let bookmarkSearchQuery = '';

function renderBookmarksDropdown() {
  if (!bookmarksDropdownList) return;
  if (bookmarksCountPill) {
    bookmarksCountPill.textContent = String(currentBookmarks.length);
  }

  const query = bookmarkSearchQuery.toLowerCase().trim();
  const filtered = query
    ? currentBookmarks.filter((b) => (b.title || '').toLowerCase().includes(query) || (b.url || '').toLowerCase().includes(query))
    : currentBookmarks;

  bookmarksDropdownList.innerHTML = '';

  if (filtered.length === 0) {
    bookmarksDropdownList.innerHTML = `<div class="bookmarks-empty-hint">${query ? 'No matching bookmarks' : 'No bookmarks saved yet. Click the ⭐ icon in the address bar to bookmark pages.'}</div>`;
    return;
  }

  filtered.forEach((bm) => {
    const item = document.createElement('div');
    item.className = 'bookmark-pop-item';
    item.title = `${bm.title}\n${bm.url}`;

    const icon = document.createElement('img');
    icon.className = 'bookmark-pop-icon';
    let domain = '';
    try { domain = new URL(bm.url).hostname; } catch {}
    icon.src = `https://www.google.com/s2/favicons?domain=${domain}&sz=32`;

    const info = document.createElement('div');
    info.className = 'bookmark-pop-info';
    info.innerHTML = `
      <span class="bookmark-pop-title">${escapeHtml(bm.title || domain || bm.url)}</span>
      <span class="bookmark-pop-url">${escapeHtml(bm.url)}</span>
    `;

    const btnDel = document.createElement('button');
    btnDel.type = 'button';
    btnDel.className = 'bookmark-pop-del';
    btnDel.title = 'Delete Bookmark';
    btnDel.innerHTML = '✕';
    btnDel.onclick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      currentBookmarks = currentBookmarks.filter((b) => b.url !== bm.url);
      renderBookmarksDropdown();
      getApi()?.removeBookmark(bm.url);
    };
    item.appendChild(icon);
    item.appendChild(info);
    item.appendChild(btnDel);

    item.onclick = () => {
      getApi()?.navigate(bm.url, activeTabId);
      if (bookmarksDropdownMenu) bookmarksDropdownMenu.style.display = 'none';
    };

    item.onauxclick = (e) => {
      if (e.button === 1) {
        getApi()?.createTab(bm.url);
        if (bookmarksDropdownMenu) bookmarksDropdownMenu.style.display = 'none';
      }
    };

    bookmarksDropdownList.appendChild(item);
  });
}

function renderBookmarks() {
  renderBookmarksDropdown();

  const activeTab = currentTabs.find((t) => t.id === activeTabId);
  const isBookmarked = activeTab && currentBookmarks.some((b) => b.url === activeTab.url);
  if (btnStarBookmark) {
    btnStarBookmark.classList.toggle('active', !!isBookmarked);
    if (isBookmarked) {
      btnStarBookmark.innerHTML = `<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M3.612 15.443c-.386.198-.824-.149-.746-.592l.83-4.73L.173 6.765c-.329-.314-.158-.888.283-.95l4.898-.696L7.538.792c.197-.39.73-.39.927 0l2.184 4.327 4.898.696c.441.062.612.636.282.95l-3.522 3.356.83 4.73c.078.443-.36.79-.746.592L8 13.187l-4.389 2.256z"/></svg>`;
    } else {
      btnStarBookmark.innerHTML = `<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M2.866 14.85c-.078.444.36.791.746.593l4.39-2.256 4.389 2.256c.386.198.824-.149.746-.592l-.83-4.73 3.522-3.356c.33-.314.16-.888-.282-.95l-4.898-.696L8.465.792a.513.513 0 0 0-.927 0L5.354 5.12l-4.898.696c-.441.062-.612.636-.283.95l3.523 3.356-.83 4.73zm4.905-2.767-3.686 1.894.694-3.957a.565.565 0 0 0-.163-.505L1.71 6.745l4.052-.576a.525.525 0 0 0 .393-.288L8 2.223l1.847 3.658a.525.525 0 0 0 .393.288l4.052.575-2.906 2.77a.565.565 0 0 0-.163.506l.694 3.957-3.686-1.895a.5.5 0 0 0-.461 0z"/></svg>`;
    }
  }
  if (bookmarkBar) {
    bookmarkBar.style.display = 'none';
  }
}

if (btnBookmarksMenu && bookmarksDropdownMenu) {
  btnBookmarksMenu.onclick = (e) => {
    e.stopPropagation();
    const isHidden = bookmarksDropdownMenu.style.display === 'none';
    bookmarksDropdownMenu.style.display = isHidden ? 'flex' : 'none';
    getApi()?.setOverlay(isHidden);
    if (isHidden) {
      renderBookmarksDropdown();
      setTimeout(() => inputBookmarkSearch?.focus(), 50);
    }
  };
}

if (inputBookmarkSearch) {
  inputBookmarkSearch.addEventListener('input', (e) => {
    bookmarkSearchQuery = (e.target as HTMLInputElement).value;
    renderBookmarksDropdown();
  });
  inputBookmarkSearch.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (bookmarksDropdownMenu) bookmarksDropdownMenu.style.display = 'none';
      getApi()?.setOverlay(false);
    }
  });
}

document.addEventListener('click', (e) => {
  if (bookmarksDropdownMenu && bookmarksDropdownMenu.style.display !== 'none') {
    const path = e.composedPath ? e.composedPath() : [];
    const isInsideMenu = path.includes(bookmarksDropdownMenu) || bookmarksDropdownMenu.contains(e.target as Node);
    const isMenuButton = (btnBookmarksMenu && path.includes(btnBookmarksMenu)) || e.target === btnBookmarksMenu;
    if (!isInsideMenu && !isMenuButton) {
      bookmarksDropdownMenu.style.display = 'none';
      getApi()?.setOverlay(false);
    }
  }
});

// Navigation Listeners
if (btnNewTab) btnNewTab.addEventListener('click', () => getApi()?.createTab());
if (btnBack) btnBack.addEventListener('click', () => getApi()?.goBack());
if (btnForward) btnForward.addEventListener('click', () => getApi()?.goForward());
if (btnReload) {
  btnReload.title = 'Reload page (Ctrl+R) • Right-click or Ctrl+Alt+R for Reload Window';
  btnReload.addEventListener('click', (e) => {
    if (e.altKey || e.ctrlKey || e.metaKey) {
      getApi()?.reloadWindow();
    } else {
      getApi()?.reload();
    }
  });
  btnReload.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    getApi()?.reloadWindow();
  });
}

if (btnStarBookmark) {
  btnStarBookmark.addEventListener('click', () => {
    const activeTab = currentTabs.find((t) => t.id === activeTabId);
    if (!activeTab || !activeTab.url || activeTab.url === 'about:blank') return;
    const isBookmarked = currentBookmarks.some((b) => b.url === activeTab.url);
    if (isBookmarked) {
      getApi()?.removeBookmark(activeTab.url);
      showToolbarToast('⭐ Đã xóa dấu trang');
    } else {
      getApi()?.addBookmark(activeTab.title || activeTab.url, activeTab.url);
      showToolbarToast('⭐ Đã lưu dấu trang thành công');
    }
  });
}

// Device Viewport
if (deviceSelect) {
  deviceSelect.addEventListener('change', () => {
    getApi()?.setDevicePreset(deviceSelect.value);
  });
}
// Split Review Controls
if (btnToggleSplit) {
  btnToggleSplit.addEventListener('click', () => {
    const activeTab = currentTabs.find((t) => t.id === activeTabId);
    const nextEnabled = !(activeTab && activeTab.splitMode);
    getApi()?.toggleSplitReview(activeTabId, nextEnabled);
  });
}
if (splitDesktopSelect) {
  splitDesktopSelect.addEventListener('change', () => {
    getApi()?.setSplitPreset('desktop', splitDesktopSelect.value, activeTabId);
  });
}
if (splitMobileSelect) {
  splitMobileSelect.addEventListener('change', () => {
    getApi()?.setSplitPreset('mobile', splitMobileSelect.value, activeTabId);
  });
}
if (btnSplitFocusDesktop) {
  btnSplitFocusDesktop.addEventListener('click', () => {
    getApi()?.setSplitFocusedPane('desktop', activeTabId);
  });
}
if (btnSplitFocusMobile) {
  btnSplitFocusMobile.addEventListener('click', () => {
    getApi()?.setSplitFocusedPane('mobile', activeTabId);
  });
}

// Zoom Stepper Controls
if (zoomLabel) {
  zoomLabel.addEventListener('click', () => {
    getApi()?.setZoom(1.0);
  });
}

if (btnZoomInPop) {
  btnZoomInPop.addEventListener('click', () => {
    const activeTab = currentTabs.find((t) => t.id === activeTabId);
    if (activeTab) {
      getApi()?.setZoom(Math.min(activeTab.zoomFactor + 0.1, 3.0));
    }
  });
}

if (btnZoomOutPop) {
  btnZoomOutPop.addEventListener('click', () => {
    const activeTab = currentTabs.find((t) => t.id === activeTabId);
    if (activeTab) {
      getApi()?.setZoom(Math.max(activeTab.zoomFactor - 0.1, 0.5));
    }
  });
}

// Tools
if (btnThemeQa) {
  btnThemeQa.addEventListener('click', async () => {
    const report = lastThemeQaReport || themeQaState.report;
    if (report && (themeQaState.status === 'pass' || themeQaState.status === 'fail' || themeQaState.status === 'error')) {
      openThemeQaSummary();
      return;
    }
    showToolbarToast('Theme QA: Validating Storefront…');
    const result = await getApi()?.runThemeQa();
    if (result?.report) {
      lastThemeQaReport = result.report;
      renderThemeQa({ ...themeQaState, report: result.report }, result.report);
      openThemeQaSummary();
    } else if (result && !result.ok) {
      showToolbarToast(`Theme QA: ${result.error || 'validation failed'}`);
    }
  });
}
const btnThemeQaRerun = document.getElementById('btnThemeQaRerun') as HTMLButtonElement | null;
btnThemeQaRerun?.addEventListener('click', async () => {
  showToolbarToast('Theme QA: Re-validating Storefront…');
  const result = await getApi()?.runThemeQa();
  if (result?.report) {
    lastThemeQaReport = result.report;
    renderThemeQa({ ...themeQaState, report: result.report }, result.report);
    openThemeQaSummary();
  } else if (result && !result.ok) {
    showToolbarToast(`Theme QA: ${result.error || 'validation failed'}`);
  }
});
themeQaClose?.addEventListener('click', () => { if (themeQaOverlay) themeQaOverlay.style.display = 'none'; getApi()?.setOverlay(false); });
themeQaOverlay?.addEventListener('click', (event) => { if (event.target === themeQaOverlay) { themeQaOverlay.style.display = 'none'; getApi()?.setOverlay(false); } });
if (btnQuickInspect) btnQuickInspect.addEventListener('click', () => getApi()?.toggleInspect());
if (btnFontFinder) btnFontFinder.addEventListener('click', () => getApi()?.toggleFontFinder());
if (btnRuler) btnRuler.addEventListener('click', () => getApi()?.toggleRuler());
if (btnDevTools) btnDevTools.addEventListener('click', () => getApi()?.toggleDevTools());
if (btnToggleSidebar) btnToggleSidebar.addEventListener('click', () => getApi()?.toggleSidebar());
if (btnPopoutTerminal) btnPopoutTerminal.addEventListener('click', () => getApi()?.popoutTerminal?.());

if (btnCaptureFullPage) {
  btnCaptureFullPage.addEventListener('click', async () => {
    btnCaptureFullPage.style.color = '#22c55e';
    await getApi()?.captureViewport();
    showToolbarToast('📸 Đã sao chép ảnh chụp màn hình vào Clipboard!');
    setTimeout(() => {
      btnCaptureFullPage.style.color = '';
    }, 1500);
  });
}

function renderChromeProfiles() {
  if (profileName) {
    profileName.textContent = activeProfileInfo?.name || 'Default';
  }
  if (profileAvatar) {
    profileAvatar.textContent = '👤';
  }
  if (!profileDropdownList) return;
  profileDropdownList.innerHTML = '';

  availableChromeProfiles.forEach((p) => {
    const item = document.createElement('div');
    const isActive = activeProfileInfo && activeProfileInfo.id === p.id;
    item.className = `profile-dropdown-item ${isActive ? 'active' : ''}`;
    item.innerHTML = `
      <span>👤 ${escapeHtml(p.name || p.id)}</span>
      ${isActive ? '<span style="color:#22c55e;font-size:11px;">● Active</span>' : '<span style="font-size:10px;color:#94a3b8;">Sync</span>'}
    `;
    item.onclick = async () => {
      profileDropdownMenu.style.display = 'none';
      getApi()?.setOverlay(false);
      showToolbarToast(`🔄 Đang đồng bộ Chrome Profile: ${p.name || p.id}...`);
      const res = await getApi()?.syncChromeProfile(p.id);
      if (res && res.success !== false) {
        activeProfileInfo = p;
        renderChromeProfiles();
        renderAppMenuProfiles();
        if (res.isLocked) {
          showToolbarToast(`⚠️ Chrome đang mở: Đã nạp ${res.bookmarksCount || 0} bookmarks. Hãy đóng Google Chrome rồi bấm Đồng bộ lại để nạp cookies!`, 5000);
        } else {
          const cookieNote = res.cookiesCount > 0 ? ` (${res.cookiesCount} cookies, ${res.bookmarksCount || 0} bookmarks)` : '';
          showToolbarToast(`✅ Đã đồng bộ Chrome Profile: ${p.name || p.id}${cookieNote}`, 3000);
        }
      } else {
        showToolbarToast(`⚠️ Không thể đồng bộ: ${res?.message || 'Lỗi profile'}`, 4000);
      }
    };
    profileDropdownList.appendChild(item);
  });
}

if (btnChromeProfile) {
  btnChromeProfile.addEventListener('click', async (e) => {
    e.stopPropagation();
    const isHidden = profileDropdownMenu.style.display === 'none';
    if (isHidden) {
      if (bookmarksDropdownMenu) bookmarksDropdownMenu.style.display = 'none';
      if (appDropdownMenu) appDropdownMenu.style.display = 'none';
      const profiles = await getApi()?.getChromeProfiles();
      if (profiles && Array.isArray(profiles)) {
        availableChromeProfiles = profiles;
      }
      renderChromeProfiles();
      profileDropdownMenu.style.display = 'flex';
      getApi()?.setOverlay(true);
    } else {
      profileDropdownMenu.style.display = 'none';
      getApi()?.setOverlay(false);
    }
  });
}

document.addEventListener('click', (e) => {
  if (profileDropdownMenu && profileDropdownMenu.style.display !== 'none') {
    if (!profileDropdownMenu.contains(e.target as Node) && !btnChromeProfile.contains(e.target as Node)) {
      profileDropdownMenu.style.display = 'none';
      getApi()?.setOverlay(false);
    }
  }
});

// Modern App Dropdown Menu (Three-dot ⋮)
const appDropdownMenu = document.getElementById('appDropdownMenu') as HTMLElement | null;
const menuProfileSubList = document.getElementById('menuProfileSubList') as HTMLElement | null;
const menuItemSyncProfile = document.getElementById('menuItemSyncProfile') as HTMLElement | null;
const menuProfileContainer = document.getElementById('menuProfileContainer') as HTMLElement | null;

function renderAppMenuProfiles() {
  if (!menuProfileSubList) return;
  if (!availableChromeProfiles || availableChromeProfiles.length === 0) {
    menuProfileSubList.innerHTML = '<div class="profile-sub-item disabled">Không tìm thấy Chrome Profile</div>';
    return;
  }
  menuProfileSubList.innerHTML = '';
  availableChromeProfiles.forEach((p) => {
    const item = document.createElement('div');
    const isActive = activeProfileInfo && activeProfileInfo.id === p.id;
    item.className = `profile-sub-item ${isActive ? 'active' : ''}`;
    item.innerHTML = `
      <span>👤 ${escapeHtml(p.name || p.id)}</span>
      ${isActive ? '<span style="font-size:10px;color:#4ade80;">● Đang dùng</span>' : '<span style="font-size:10px;color:#38bdf8;">Đồng bộ</span>'}
    `;
    item.onclick = async (e) => {
      e.stopPropagation();
      closeAppMenu();
      showToolbarToast(`🔄 Đang đồng bộ Chrome Profile: ${p.name || p.id}...`);
      const res = await getApi()?.syncChromeProfile(p.id);
      if (res && res.success !== false) {
        activeProfileInfo = p;
        renderChromeProfiles();
        if (res.isLocked) {
          showToolbarToast(`⚠️ Chrome đang mở: Đã nạp ${res.bookmarksCount || 0} bookmarks. Hãy đóng Google Chrome rồi bấm Đồng bộ lại để nạp cookies!`, 5000);
        } else {
          const cookieNote = res.cookiesCount > 0 ? ` (${res.cookiesCount} cookies, ${res.bookmarksCount || 0} bookmarks)` : '';
          showToolbarToast(`✅ Đã đồng bộ Chrome Profile: ${p.name || p.id}${cookieNote}`, 3000);
        }
      } else {
        showToolbarToast(`⚠️ Không thể đồng bộ: ${res?.message || 'Lỗi profile'}`, 4000);
      }
    };
    menuProfileSubList.appendChild(item);
  });
}

function closeAppMenu() {
  if (appDropdownMenu && appDropdownMenu.style.display !== 'none') {
    appDropdownMenu.style.display = 'none';
    if (menuProfileContainer) {
      menuProfileContainer.style.display = 'none';
    }
    menuItemSyncProfile?.classList.remove('expanded');
    getApi()?.setOverlay(false);
  }
}

async function toggleAppMenu() {
  if (!appDropdownMenu) return;
  const isHidden = appDropdownMenu.style.display === 'none';
  if (isHidden) {
    if (bookmarksDropdownMenu) bookmarksDropdownMenu.style.display = 'none';
    if (profileDropdownMenu) profileDropdownMenu.style.display = 'none';
    
    // Pre-fetch Chrome profiles asynchronously
    getApi()?.getChromeProfiles().then((profiles) => {
      if (profiles && Array.isArray(profiles)) {
        availableChromeProfiles = profiles;
        renderChromeProfiles();
        renderAppMenuProfiles();
      }
    }).catch(() => {});

    renderAppMenuProfiles();
    appDropdownMenu.style.display = 'flex';
    getApi()?.setOverlay(true);
  } else {
    closeAppMenu();
  }
}

if (btnMenu && appDropdownMenu) {
  btnMenu.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleAppMenu();
  });
}

if (menuItemSyncProfile) {
  menuItemSyncProfile.addEventListener('click', async (e) => {
    e.stopPropagation();
    if (!menuProfileContainer) return;
    const isExpanded = menuProfileContainer.style.display !== 'none';
    if (isExpanded) {
      menuProfileContainer.style.display = 'none';
      menuItemSyncProfile.classList.remove('expanded');
    } else {
      if (!availableChromeProfiles || availableChromeProfiles.length === 0) {
        const profiles = await getApi()?.getChromeProfiles();
        if (profiles && Array.isArray(profiles)) {
          availableChromeProfiles = profiles;
          renderChromeProfiles();
        }
      }
      renderAppMenuProfiles();
      menuProfileContainer.style.display = 'block';
      menuItemSyncProfile.classList.add('expanded');
    }
  });
}

// App Menu Items Clicks
document.getElementById('menuItemCheckUpdates')?.addEventListener('click', (e) => {
  e.stopPropagation();
  closeAppMenu();
  getApi()?.checkUpdates?.();
});

document.getElementById('menuItemBookmarkTab')?.addEventListener('click', (e) => {
  e.stopPropagation();
  closeAppMenu();
  const star = document.getElementById('btnStarBookmark');
  if (star) star.click();
});

document.getElementById('menuItemToggleBookmarksBar')?.addEventListener('click', (e) => {
  e.stopPropagation();
  closeAppMenu();
  getApi()?.toggleBookmarkBar();
});

document.getElementById('menuItemFindInPage')?.addEventListener('click', (e) => {
  e.stopPropagation();
  closeAppMenu();
  showFindBar();
});

document.getElementById('menuItemQuickInspect')?.addEventListener('click', (e) => {
  e.stopPropagation();
  closeAppMenu();
  getApi()?.toggleInspect();
});

document.getElementById('menuItemFontFinder')?.addEventListener('click', (e) => {
  e.stopPropagation();
  closeAppMenu();
  getApi()?.toggleFontFinder();
});

document.getElementById('menuItemGpuLens')?.addEventListener('click', (e) => {
  e.stopPropagation();
  closeAppMenu();
  getApi()?.toggleLens();
});

document.getElementById('menuItemScreenshot')?.addEventListener('click', (e) => {
  e.stopPropagation();
  closeAppMenu();
  getApi()?.captureViewport();
});

document.getElementById('menuItemOpenSystemBrowser')?.addEventListener('click', (e) => {
  e.stopPropagation();
  closeAppMenu();
  getApi()?.openExternal();
});

document.getElementById('menuItemDevTools')?.addEventListener('click', (e) => {
  e.stopPropagation();
  closeAppMenu();
  getApi()?.toggleDevTools();
});

document.getElementById('menuItemClearStorage')?.addEventListener('click', async (e) => {
  e.stopPropagation();
  closeAppMenu();
  await getApi()?.clearStorage();
  showToolbarToast('Đã xóa Cookies & Cache của trang này');
});

document.getElementById('menuItemShortcuts')?.addEventListener('click', (e) => {
  e.stopPropagation();
  closeAppMenu();
  openShortcutsOverlay();
});
function openShortcutsOverlay() {
  if (!shortcutsOverlay) return;
  getApi()?.setOverlay(true);
  shortcutsOverlay.style.display = 'flex';
}

function closeShortcutsOverlay() {
  if (!shortcutsOverlay) return;
  shortcutsOverlay.style.display = 'none';
  getApi()?.setOverlay(false);
}

if (shortcutsClose) shortcutsClose.addEventListener('click', closeShortcutsOverlay);
if (shortcutsOverlay) {
  shortcutsOverlay.addEventListener('click', (e) => {
    if (e.target === shortcutsOverlay) closeShortcutsOverlay();
  });
}

async function openMobileRemoteModal() {
  if (!mobileRemoteOverlay) return;
  getApi()?.setOverlay(true);
  mobileRemoteOverlay.style.display = 'flex';

  try {
    const info = await (getApi() as any)?.getMobileRemoteInfo?.();
    if (info) {
      if (mobileRemoteQrContainer && info.qrSvg) {
        mobileRemoteQrContainer.innerHTML = info.qrSvg;
      }
      if (mobileRemoteUrlsList && Array.isArray(info.urls)) {
        mobileRemoteUrlsList.innerHTML = '';
        info.urls.forEach((url: string) => {
          const item = document.createElement('div');
          item.className = 'mobile-url-item';
          item.innerHTML = `
            <span class="mobile-url-text">${escapeHtml(url)}</span>
            <button class="btn-copy-url">Sao chép</button>
          `;
          item.querySelector('.btn-copy-url')?.addEventListener('click', (e) => {
            e.stopPropagation();
            navigator.clipboard.writeText(url);
            showToolbarToast('📋 Đã sao chép liên kết Mobile Remote!');
          });
          mobileRemoteUrlsList.appendChild(item);
        });
      }
    }
  } catch (e) {
    console.error('Failed to load mobile remote info', e);
  }
}

function closeMobileRemoteModal() {
  if (!mobileRemoteOverlay) return;
  mobileRemoteOverlay.style.display = 'none';
  getApi()?.setOverlay(false);
}

if (btnMobileRemote) {
  btnMobileRemote.addEventListener('click', openMobileRemoteModal);
}
if (mobileRemoteClose) {
  mobileRemoteClose.addEventListener('click', closeMobileRemoteModal);
}
if (mobileRemoteOverlay) {
  mobileRemoteOverlay.addEventListener('click', (e) => {
    if (e.target === mobileRemoteOverlay) closeMobileRemoteModal();
  });
}

if (menuFind) {
  menuFind.addEventListener('click', () => {
    showFindBar();
  });
}

if (menuQuickAnnotate) {
  menuQuickAnnotate.addEventListener('click', () => {
    getApi()?.toggleInspect();
  });
}

if (menuFontFinder) {
  menuFontFinder.addEventListener('click', () => {
    getApi()?.toggleFontFinder();
  });
}

if (menuLens) {
  menuLens.addEventListener('click', () => {
    getApi()?.toggleLens();
  });
}

if (menuOpenBrowser) {
  menuOpenBrowser.addEventListener('click', () => {
    getApi()?.openExternal();
  });
}

if (menuShortcuts) {
  menuShortcuts.addEventListener('click', () => {
    openShortcutsOverlay();
  });
}

// Close menus when clicking outside
// TAB CONTEXT MENU
const tabContextMenu = document.getElementById('tabContextMenu') as HTMLDivElement | null;
const menuItemNewTabRight = document.getElementById('menuItemNewTabRight');
const menuItemDuplicateTab = document.getElementById('menuItemDuplicateTab');
const menuItemReloadTab = document.getElementById('menuItemReloadTab');
const menuItemCopyUrl = document.getElementById('menuItemCopyUrl');
const menuItemCloseTab = document.getElementById('menuItemCloseTab');
const menuItemCloseOtherTabs = document.getElementById('menuItemCloseOtherTabs');
const menuItemCloseTabsToRight = document.getElementById('menuItemCloseTabsToRight');

let contextMenuTargetTabId: string | null = null;

function hideTabContextMenu() {
  if (!tabContextMenu) return;
  tabContextMenu.classList.remove('active');
  tabContextMenu.style.display = 'none';
  contextMenuTargetTabId = null;
  getApi()?.setOverlay(false);
}

function showTabContextMenu(x: number, y: number, tabId: string) {
  if (!tabContextMenu) return;
  contextMenuTargetTabId = tabId;

  const tabIndex = currentTabs.findIndex((t) => t.id === tabId);
  const totalTabs = currentTabs.length;

  if (menuItemCloseOtherTabs) {
    if (totalTabs <= 1) {
      menuItemCloseOtherTabs.classList.add('disabled');
    } else {
      menuItemCloseOtherTabs.classList.remove('disabled');
    }
  }

  if (menuItemCloseTabsToRight) {
    if (tabIndex === -1 || tabIndex >= totalTabs - 1) {
      menuItemCloseTabsToRight.classList.add('disabled');
    } else {
      menuItemCloseTabsToRight.classList.remove('disabled');
    }
  }

  getApi()?.setOverlay(true);
  tabContextMenu.style.display = 'flex';
  tabContextMenu.classList.add('active');

  const menuWidth = 210;
  const maxX = window.innerWidth - menuWidth - 8;
  const targetX = Math.max(8, Math.min(x, maxX));
  const targetY = Math.max(4, y);

  tabContextMenu.style.left = `${targetX}px`;
  tabContextMenu.style.top = `${targetY}px`;
}

if (menuItemNewTabRight) {
  menuItemNewTabRight.addEventListener('click', () => {
    if (contextMenuTargetTabId) {
      const idx = currentTabs.findIndex((t) => t.id === contextMenuTargetTabId);
      getApi()?.createTab('https://www.google.com').then((newId: string) => {
        if (newId && idx !== -1) {
          getApi()?.moveTab(newId, idx + 1);
        }
      });
    }
    hideTabContextMenu();
  });
}

if (menuItemDuplicateTab) {
  menuItemDuplicateTab.addEventListener('click', () => {
    if (contextMenuTargetTabId) {
      getApi()?.duplicateTab(contextMenuTargetTabId);
    }
    hideTabContextMenu();
  });
}

if (menuItemReloadTab) {
  menuItemReloadTab.addEventListener('click', () => {
    if (contextMenuTargetTabId) {
      getApi()?.reload(contextMenuTargetTabId);
    }
    hideTabContextMenu();
  });
}

if (menuItemCopyUrl) {
  menuItemCopyUrl.addEventListener('click', () => {
    if (contextMenuTargetTabId) {
      const targetTab = currentTabs.find((t) => t.id === contextMenuTargetTabId);
      if (targetTab && targetTab.url) {
        navigator.clipboard.writeText(targetTab.url).then(() => {
          showToolbarToast('Đã sao chép liên kết tab');
        }).catch(() => {});
      }
    }
    hideTabContextMenu();
  });
}

if (menuItemCloseTab) {
  menuItemCloseTab.addEventListener('click', () => {
    if (contextMenuTargetTabId) {
      getApi()?.closeTab(contextMenuTargetTabId);
    }
    hideTabContextMenu();
  });
}

if (menuItemCloseOtherTabs) {
  menuItemCloseOtherTabs.addEventListener('click', () => {
    if (contextMenuTargetTabId) {
      getApi()?.closeOtherTabs(contextMenuTargetTabId);
    }
    hideTabContextMenu();
  });
}

if (menuItemCloseTabsToRight) {
  menuItemCloseTabsToRight.addEventListener('click', () => {
    if (contextMenuTargetTabId) {
      getApi()?.closeTabsToRight(contextMenuTargetTabId);
    }
    hideTabContextMenu();
  });
}

// Close menus when clicking outside
document.addEventListener('click', (e) => {
  if (appDropdownMenu && appDropdownMenu.style.display !== 'none') {
    const path = (e.composedPath && typeof e.composedPath === 'function') ? e.composedPath() : [];
    const isInsideMenu = path.includes(appDropdownMenu) || appDropdownMenu.contains(e.target as Node);
    const isMenuButton = (btnMenu && path.includes(btnMenu)) || e.target === btnMenu;
    if (!isInsideMenu && !isMenuButton) {
      closeAppMenu();
    }
  }
  if (codexMainMenu && !codexMainMenu.contains(e.target as Node) && e.target !== btnMenu) {
    codexMainMenu.classList.remove('active');
  }
  if (tabContextMenu && !tabContextMenu.contains(e.target as Node)) {
    hideTabContextMenu();
  }
});

// Google Omnibox Suggest Dropdown
const omniboxSuggestDropdown = document.getElementById('omniboxSuggestDropdown') as HTMLDivElement | null;
const omniboxSuggestList = document.getElementById('omniboxSuggestList') as HTMLDivElement | null;

let suggestItems: Array<{ type: 'search' | 'url' | 'bookmark' | 'history' | 'tab'; text: string; url?: string; tabId?: string; subText?: string }> = [];
let selectedSuggestIndex = -1;
let suggestDebounceTimer: any = null;

function hideSuggestDropdown() {
  if (!omniboxSuggestDropdown) return;
  omniboxSuggestDropdown.style.display = 'none';
  selectedSuggestIndex = -1;
  suggestItems = [];
  getApi()?.setOverlay(false);
}

async function updateSuggestDropdown(query: string) {
  if (!omniboxSuggestDropdown || !omniboxSuggestList) return;
  const q = (query || '').trim();
  try {
    const res = await getApi()?.getSuggestions(q);
    if (res && Array.isArray(res.suggestions) && res.suggestions.length > 0) {
      suggestItems = res.suggestions;
      selectedSuggestIndex = -1;
      renderSuggestItems(q);
      omniboxSuggestDropdown.style.display = 'block';
      getApi()?.setOverlay(true, 420);
    } else {
      hideSuggestDropdown();
    }
  } catch {
    hideSuggestDropdown();
  }
}

function renderSuggestItems(query: string) {
  if (!omniboxSuggestList) return;
  omniboxSuggestList.innerHTML = '';
  const lowerQ = (query || '').toLowerCase();

  suggestItems.forEach((item, idx) => {
    const el = document.createElement('div');
    el.className = `suggest-item ${idx === selectedSuggestIndex ? 'selected' : ''}`;

    let iconSvg = '';
    if (item.type === 'tab') {
      iconSvg = '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="#38bdf8" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="12" height="10" rx="2"/><line x1="2" y1="7" x2="14" y2="7"/></svg>';
    } else if (item.type === 'bookmark') {
      iconSvg = '<svg width="13" height="13" viewBox="0 0 16 16" fill="#f59e0b"><path d="M3.612 15.443c-.386.198-.824-.149-.746-.592l.83-4.73L.173 6.765c-.329-.314-.158-.888.283-.95l4.898-.696L7.538.792c.197-.39.73-.39.927 0l2.184 4.327 4.898.696c.441.062.612.636.282.95l-3.522 3.356.83 4.73c.078.443-.36.79-.746.592L8 13.187l-4.389 2.256z"/></svg>';
    } else if (item.type === 'history') {
      iconSvg = '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="#60a5fa" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="8" r="6"/><polyline points="8 5 8 8 10.5 9.5"/></svg>';
    } else if (item.type === 'url') {
      iconSvg = '<svg width="13" height="13" viewBox="0 0 16 16" fill="#a78bfa"><path d="M4.715 6.542 3.343 7.914a3 3 0 1 0 4.243 4.243l1.828-1.829A3 3 0 0 0 8.586 5.5L8 6.086a1.002 1.002 0 0 0-.154.199 2 2 0 0 1 .861 3.337L6.88 11.45a2 2 0 1 1-2.83-2.83l.793-.792a4.018 4.018 0 0 1-.128-1.287z"/><path d="M6.586 4.672A3 3 0 0 0 7.414 9.5l.775-.776a2 2 0 0 1-.896-3.346L9.12 3.55a2 2 0 1 1 2.83 2.83l-.793.792c.112.42.155.855.128 1.287l1.372-1.372a3 3 0 1 0-4.243-4.243L6.586 4.672z"/></svg>';
    } else {
      iconSvg = '<svg width="13" height="13" viewBox="0 0 16 16" fill="#9ca3af"><path d="M11.742 10.344a6.5 6.5 0 1 0-1.397 1.398h-.001c.03.04.062.078.098.115l3.85 3.85a1 1 0 0 0 1.415-1.414l-3.85-3.85a1.007 1.007 0 0 0-.115-.1zM12 6.5a5.5 5.5 0 1 1-11 0 5.5 5.5 0 0 1 11 0z"/></svg>';
    }

    let matchHtml = escapeHtml(item.text);
    if (lowerQ && item.text.toLowerCase().includes(lowerQ)) {
      const startIdx = item.text.toLowerCase().indexOf(lowerQ);
      const before = item.text.slice(0, startIdx);
      const match = item.text.slice(startIdx, startIdx + lowerQ.length);
      const after = item.text.slice(startIdx + lowerQ.length);
      matchHtml = `${escapeHtml(before)}<b>${escapeHtml(match)}</b>${escapeHtml(after)}`;
    }

    const subText = item.subText || (item.type === 'search' ? 'Google Search' : (item.url ? hostname(item.url) : ''));

    el.innerHTML = `
      <span class="suggest-icon">${iconSvg}</span>
      <div class="suggest-content">
        <span class="suggest-text">${matchHtml}</span>
        ${subText ? `<span class="suggest-subtext">${escapeHtml(subText)}</span>` : ''}
      </div>
    `;

    el.addEventListener('mousedown', (e) => {
      e.preventDefault();
      if (item.type === 'tab' && item.tabId) {
        getApi()?.switchTab(item.tabId);
        hideSuggestDropdown();
        return;
      }
      const targetNav = item.url || item.text;
      if (targetNav === 'antifan:command:reload-window') {
        getApi()?.reloadWindow();
        hideSuggestDropdown();
        return;
      }
      if (urlInput) urlInput.value = targetNav;
      getApi()?.navigate(targetNav);
      hideSuggestDropdown();
    });
    omniboxSuggestList.appendChild(el);
  });
}

// Omnibox Event Listeners
if (urlInput) {
  urlInput.addEventListener('input', () => {
    const val = urlInput.value;
    if (btnClearOmnibox) btnClearOmnibox.style.display = val ? 'block' : 'none';
    clearTimeout(suggestDebounceTimer);
    suggestDebounceTimer = setTimeout(() => {
      updateSuggestDropdown(val);
    }, 120);
  });

  urlInput.addEventListener('focus', () => {
    urlInput.select();
    updateSuggestDropdown(urlInput.value);
  });
  urlInput.addEventListener('click', () => {
    if (omniboxSuggestDropdown && omniboxSuggestDropdown.style.display === 'none') {
      updateSuggestDropdown(urlInput.value);
    }
  });
  urlInput.addEventListener('blur', () => {
    setTimeout(() => {
      if (document.activeElement !== urlInput) {
        hideSuggestDropdown();
      }
    }, 200);
  });

  urlInput.addEventListener('keydown', (e) => {
    if (omniboxSuggestDropdown && omniboxSuggestDropdown.style.display !== 'none' && suggestItems.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        selectedSuggestIndex = (selectedSuggestIndex + 1) % suggestItems.length;
        renderSuggestItems(urlInput.value);
        const sel = suggestItems[selectedSuggestIndex];
        if (sel) {
          urlInput.value = sel.url || sel.text;
        }
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        selectedSuggestIndex = (selectedSuggestIndex - 1 + suggestItems.length) % suggestItems.length;
        renderSuggestItems(urlInput.value);
        const sel = suggestItems[selectedSuggestIndex];
        if (sel) {
          urlInput.value = sel.url || sel.text;
        }
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        hideSuggestDropdown();
        return;
      }
    }

    if (e.key === 'Enter') {
      const val = urlInput.value.trim();
      if (val === 'antifan:command:reload-window' || val.toLowerCase() === '> reload window' || val.toLowerCase() === '> reload' || val.toLowerCase() === '> developer: reload window') {
        getApi()?.reloadWindow();
        hideSuggestDropdown();
        urlInput.blur();
        return;
      }
      if (val) {
        if (selectedSuggestIndex >= 0 && selectedSuggestIndex < suggestItems.length) {
          const item = suggestItems[selectedSuggestIndex];
          if (item && item.type === 'tab' && item.tabId) {
            getApi()?.switchTab(item.tabId);
            hideSuggestDropdown();
            urlInput.blur();
            return;
          }
        }
        getApi()?.navigate(val);
        hideSuggestDropdown();
        urlInput.blur();
      }
    }
  });
}

const omniboxEl = document.querySelector('.omnibox') as HTMLDivElement | null;
if (omniboxEl && urlInput) {
  omniboxEl.addEventListener('click', (e) => {
    const target = e.target as HTMLElement | null;
    if (target && target.closest('#btnStarBookmark, #btnClearOmnibox')) return;
    if (document.activeElement !== urlInput) {
      urlInput.focus();
      urlInput.select();
    } else if (omniboxSuggestDropdown && omniboxSuggestDropdown.style.display === 'none') {
      updateSuggestDropdown(urlInput.value);
    }
  });
}

document.addEventListener('click', (e) => {
  if (omniboxSuggestDropdown && omniboxSuggestDropdown.style.display !== 'none') {
    if (!omniboxSuggestDropdown.contains(e.target as Node) && e.target !== urlInput) {
      hideSuggestDropdown();
    }
  }
});

if (btnClearOmnibox && urlInput) {
  btnClearOmnibox.addEventListener('click', () => {
    urlInput.value = '';
    urlInput.focus();
    btnClearOmnibox.style.display = 'none';
    hideSuggestDropdown();
  });
}

// Find In Page
function showFindBar() {
  if (!findBar || !findInput) return;
  findBar.style.display = 'flex';
  getApi()?.setOverlay(true, 50);
  findInput.focus();
  findInput.select();
  const q = findInput.value.trim();
  if (q) {
    getApi()?.findInPage(q, true, false);
  }
}

function hideFindBar() {
  if (!findBar) return;
  findBar.style.display = 'none';
  if (findCount) findCount.textContent = '0/0';
  getApi()?.stopFindInPage();
  getApi()?.setOverlay(false);
}

if (findInput) {
  findInput.addEventListener('input', () => {
    const q = findInput.value.trim();
    if (q) {
      getApi()?.findInPage(q, true, false);
    } else {
      if (findCount) findCount.textContent = '0/0';
      getApi()?.stopFindInPage();
    }
  });

  findInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      const q = findInput.value.trim();
      if (q) {
        getApi()?.findInPage(q, !e.shiftKey, true);
      }
    } else if (e.key === 'Escape') {
      e.preventDefault();
      hideFindBar();
    }
  });
}

if (findNext && findInput) {
  findNext.addEventListener('click', () => {
    const q = findInput.value.trim();
    if (q) getApi()?.findInPage(q, true, true);
  });
}
if (findPrev && findInput) {
  findPrev.addEventListener('click', () => {
    const q = findInput.value.trim();
    if (q) getApi()?.findInPage(q, false, true);
  });
}
if (findClose) {
  findClose.addEventListener('click', hideFindBar);
}

// Shortcuts Overlay
if (shortcutsClose && shortcutsOverlay) {
  shortcutsClose.addEventListener('click', () => {
    shortcutsOverlay.style.display = 'none';
  });
}

if (shortcutsOverlay) {
  shortcutsOverlay.addEventListener('click', (e) => {
    if (e.target === shortcutsOverlay) shortcutsOverlay.style.display = 'none';
  });
}


async function initToolbar() {
  const api = getApi();
  if (!api) return;

  try {
    const state = await api.getInitialState();
    if (state) {
      currentTabs = state.tabs || [];
      activeTabId = state.activeTabId || '';
      if (state.bookmarks) currentBookmarks = state.bookmarks;
      if (state.activeChromeProfile) activeProfileInfo = state.activeChromeProfile;
      if (state.chromeProfiles) availableChromeProfiles = state.chromeProfiles;
      isInspecting = !!state.isInspecting;
      isFontFinderActive = !!state.isFontFinderActive;
      isLensActive = !!state.isLensActive;
      isRulerActive = !!state.isRulerActive;
      if (state.themeQa) renderThemeQa(state.themeQa);
      renderTabs();
      renderBookmarks();
      renderChromeProfiles();
      updateControls();
    }
  } catch (err) {
    console.error('[antifan toolbar] Failed to load initial state:', err);
  }

  api.onStateUpdated((state: any) => {
    if (state) {
      currentTabs = state.tabs || [];
      activeTabId = state.activeTabId || '';
      if (state.bookmarks) currentBookmarks = state.bookmarks;
      if (state.activeChromeProfile) activeProfileInfo = state.activeChromeProfile;
      if (state.chromeProfiles) availableChromeProfiles = state.chromeProfiles;
      isInspecting = !!state.isInspecting;
      isFontFinderActive = !!state.isFontFinderActive;
      isLensActive = !!state.isLensActive;
      isRulerActive = !!state.isRulerActive;
      if (state.themeQa) renderThemeQa(state.themeQa);
      renderTabs();
      renderBookmarks();
      renderChromeProfiles();
      updateControls();
    }
  });
  api.onThemeQaState((state) => renderThemeQa(state));

  api.onFocusFind(() => {
    showFindBar();
  });

  api.onFocusOmnibox(() => {
    urlInput.focus();
    urlInput.select();
  });

  api.onShowShortcuts(() => {
    openShortcutsOverlay();
  });

  api.onFindResult((result: any) => {
    if (result && result.matches !== undefined && findCount) {
      findCount.textContent = `${result.activeMatchOrdinal || 0}/${result.matches}`;
    }
  });
  if (api.onScreenshotCaptured) {
    api.onScreenshotCaptured(() => {
      showToolbarToast('📸 Đã sao chép ảnh chụp màn hình vào Clipboard!');
    });
  }

  // Wire Workflow & MCP Hub Events
  btnWorkflowHub?.addEventListener('click', openWorkflowHub);
  btnWorkflowHubClose?.addEventListener('click', closeWorkflowHub);
  workflowHubOverlay?.addEventListener('click', (e) => {
    if (e.target === workflowHubOverlay) closeWorkflowHub();
  });
  tabNavWorkflows?.addEventListener('click', () => {
    hubActiveTab = 'workflows';
    tabNavWorkflows.classList.add('active');
    tabNavMcp?.classList.remove('active');
    renderHubList();
    if (hubWorkflows.length > 0) selectWorkflow(hubWorkflows[0]);
  });
  tabNavMcp?.addEventListener('click', () => {
    hubActiveTab = 'mcp';
    tabNavMcp.classList.add('active');
    tabNavWorkflows?.classList.remove('active');
    renderHubList();
    if (hubMcpTools.length > 0) selectMcpTool(hubMcpTools[0]);
  });
  hubSearchInput?.addEventListener('input', () => {
    if (hubSearchClear && hubSearchInput) {
      hubSearchClear.style.display = hubSearchInput.value ? 'inline-block' : 'none';
    }
    renderHubList();
  });
  hubSearchClear?.addEventListener('click', () => {
    if (hubSearchInput) hubSearchInput.value = '';
    if (hubSearchClear) hubSearchClear.style.display = 'none';
    renderHubList();
  });
  btnRunWorkflow?.addEventListener('click', runActiveWorkflow);
  btnStopWorkflow?.addEventListener('click', stopActiveWorkflow);
  btnCopyWorkflowJson?.addEventListener('click', () => {
    if (hubSelectedWorkflow) {
      navigator.clipboard.writeText(JSON.stringify(hubSelectedWorkflow.definition, null, 2));
      showToolbarToast('📋 Đã sao chép kịch bản JSON vào Clipboard!');
    }
  });
  btnDeleteCustomWf?.addEventListener('click', async () => {
    if (hubSelectedWorkflow && !hubSelectedWorkflow.isBuiltIn) {
      await getApi()?.deleteWorkflow(hubSelectedWorkflow.id);
      const res = await getApi()?.getWorkflowState();
      hubWorkflows = res?.workflows || [];
      renderHubList();
      if (hubWorkflows.length > 0) selectWorkflow(hubWorkflows[0]);
      showToolbarToast('🗑️ Đã xóa kịch bản custom.');
    }
  });
  btnHubNewWorkflow?.addEventListener('click', async () => {
    const name = prompt('Nhập tên Workflow mới:');
    if (!name || !name.trim()) return;
    const description = prompt('Nhập mô tả kịch bản (tùy chọn):') || '';
    const newWf = {
      name: name.trim(),
      description: description.trim(),
      steps: [
        {
          id: 'step-navigate',
          name: 'Mở trang web mục tiêu',
          type: 'browser.navigate' as const,
          params: { url: 'https://example.com' },
          timeoutMs: 8000,
          retryCount: 0,
          continueOnError: false,
        },
        {
          id: 'step-screenshot',
          name: 'Chụp ảnh màn hình kiểm thử',
          type: 'browser.screenshot' as const,
          params: { format: 'png' },
          timeoutMs: 10000,
          retryCount: 0,
          continueOnError: false,
        },
      ],
    };
    try {
      await getApi()?.saveWorkflow(newWf);
      const res = await getApi()?.getWorkflowState();
      hubWorkflows = res?.workflows || [];
      renderHubList();
      const created = hubWorkflows.find((w) => w.name === newWf.name);
      if (created) selectWorkflow(created);
      showToolbarToast('✅ Đã tạo kịch bản Workflow mới!');
    } catch (err: any) {
      alert(`Lỗi tạo workflow: ${err.message || String(err)}`);
    }
  });

  if (api.onWorkflowEvent) {
    api.onWorkflowEvent((event: any) => {
      if (!event) return;
      if (event.type === 'step:start' && event.stepId) {
        const card = document.getElementById(`step-card-${event.stepId}`);
        if (card) card.className = 'hub-step-card step-running';
        const pill = document.getElementById(`step-status-${event.stepId}`);
        if (pill) {
          pill.className = 'hub-step-status step-status-running';
          pill.textContent = 'RUNNING';
        }
        if (runCurrentStepText) {
          runCurrentStepText.textContent = `Đang chạy: ${event.stepName || event.stepId}...`;
        }
      } else if (event.type === 'step:end' && event.stepId) {
        const isPassed = event.status === 'passed';
        const card = document.getElementById(`step-card-${event.stepId}`);
        if (card) card.className = `hub-step-card ${isPassed ? 'step-passed' : 'step-failed'}`;
        const pill = document.getElementById(`step-status-${event.stepId}`);
        if (pill) {
          pill.className = `hub-step-status ${isPassed ? 'step-status-passed' : 'step-status-failed'}`;
          pill.textContent = (event.status || 'DONE').toUpperCase();
        }
      }
    });
  }

  window.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === 'W' || e.key === 'w')) {
      e.preventDefault();
      if (workflowHubOverlay && workflowHubOverlay.style.display === 'flex') {
        closeWorkflowHub();
      } else {
        openWorkflowHub();
      }
    } else if (e.key === 'Escape' && workflowHubOverlay && workflowHubOverlay.style.display === 'flex') {
      closeWorkflowHub();
    }
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initToolbar);
} else {
  initToolbar();
}

