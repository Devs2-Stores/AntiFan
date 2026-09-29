const api = window.antifanStandalone;
const container = document.getElementById('terminal');
const mainPane = document.getElementById('terminal-main');
const tabsEl = document.getElementById('terminalTabs');
const contextMenu = document.getElementById('tabContextMenu');

const urlParams = new URLSearchParams(window.location.search);
const isPopoutMode = urlParams.get('mode') === 'popout';
if (isPopoutMode) {
  document.body.classList.add('popout-mode');
}

// ---------------------------------------------------------------------------
// Shell scope: one window, one project, one workspace.
//
// Main decides which project this shell shows and which workspace its terminals
// belong to. This renderer only paints that decision, and it passes the workspace back
// explicitly when it creates a terminal: leaving the cwd implicit lets the main process
// fall back to its one global "current workspace", which is how a terminal started in
// window B lands in window A's project after focus moves.
//
// Precedence is deliberately staged. `projectWindow` is the shell-scoped projection;
// `workspacePath`/`activeWorkspace` are the older per-surface fields Main already sends.
// Neither is guessed here — an absent identity simply draws nothing.
// ---------------------------------------------------------------------------
const shellScope = {
  ownerKind: '',      // 'project' | 'unassigned' | '' while Main has not described the shell
  projectId: '',
  title: '',
  pathLabel: '',
  workspacePath: '',
};
let shellScopeChip = null;
let shellScopeTitleEl = null;
let shellScopePathEl = null;
let shellScopeStatusEl = null;
let shellScopeOpenProjectBtn = null;
let shellScopeStatusTimer = null;

/**
 * Read the identity and workspace Main reported for this shell into `shellScope` and
 * repaint the header chip. Unrecognized shapes leave the shell scope unset rather than
 * half-populated from fields that were not meant to carry it.
 */
function applyShellScope(source) {
  const state = source && typeof source === 'object' ? source : null;
  const identity = state && state.projectWindow && typeof state.projectWindow === 'object' ? state.projectWindow : null;
  const owner = identity && identity.owner && typeof identity.owner === 'object' ? identity.owner : null;

  shellScope.ownerKind = '';
  shellScope.projectId = '';
  shellScope.title = '';
  shellScope.pathLabel = '';
  if (owner && owner.kind === 'project' && typeof owner.projectId === 'string' && owner.projectId) {
    shellScope.ownerKind = 'project';
    shellScope.projectId = owner.projectId;
    shellScope.title = typeof identity.title === 'string' ? identity.title : '';
    shellScope.pathLabel = typeof identity.pathLabel === 'string' ? identity.pathLabel : '';
  } else if (owner && owner.kind === 'unassigned') {
    shellScope.ownerKind = 'unassigned';
    shellScope.title = typeof identity.title === 'string' ? identity.title : '';
    shellScope.pathLabel = typeof identity.pathLabel === 'string' ? identity.pathLabel : '';
  }

  const scopedWorkspace = identity && typeof identity.workspacePath === 'string' && identity.workspacePath
    ? identity.workspacePath
    : '';
  const legacyWorkspace = typeof state?.workspacePath === 'string' && state.workspacePath
    ? state.workspacePath
    : (typeof state?.activeWorkspace === 'string' ? state.activeWorkspace : '');
  shellScope.workspacePath = scopedWorkspace || legacyWorkspace;

  renderShellScopeChip();

  // A manager shell presents terminals from many capsules and labels them by capsule, so it
  // needs the id→name index before it can name what it is showing. The picker refreshes
  // these labels when opened; project shells do not need the cross-project label map.
  if (isSharedManagerShell()) {
    void ensureCapsuleIndex().then((changed) => {
      if (changed && typeof renderTabs === 'function') renderTabs();
    });
  }
}

/**
 * What the header chip shows for a described shell. The decision lives in one place because
 * it is what makes "Open Project" reachable at all: a project window is the only window this
 * build boots, so a chip that offered the action only in an Unassigned shell — a shell no
 * launch path creates — would leave the action unreachable in every window the user can have.
 *
 * Only the described/un-described distinction matters here. Which project to open is never
 * this renderer's decision: the request carries no id, and Main answers with its own picker.
 */
function shellScopeActionPlan(scope) {
  const described = Boolean(scope && scope.ownerKind);
  return { chipVisible: described, openProjectVisible: described };
}

/**
 * The header chip names the shell's project and offers the explicit Open Project action in
 * every described shell: the project is this window's own, and the action opens another one
 * in its own window with its own tabs and terminals.
 */
function renderShellScopeChip() {
  const heading = document.querySelector('header .heading') || document.querySelector('.standalone header');
  if (!heading) return;
  if (!shellScopeChip) {
    shellScopeChip = document.createElement('div');
    shellScopeChip.id = 'shellScopeChip';
    shellScopeChip.className = 'shell-scope-chip';
    shellScopeChip.setAttribute('role', 'group');
    shellScopeChip.setAttribute('aria-label', 'Dự án của cửa sổ này');
    shellScopeChip.setAttribute('style', 'display:flex;align-items:center;gap:5px;margin-left:10px;height:20px;max-width:230px;padding:0 7px;border-radius:6px;background:rgba(56,189,248,0.10);border:1px solid rgba(56,189,248,0.35);font-size:10px;color:#e2e8f0;overflow:hidden;white-space:nowrap;');
    shellScopeTitleEl = document.createElement('span');
    shellScopeTitleEl.id = 'shellScopeTitle';
    shellScopeTitleEl.setAttribute('style', 'font-weight:600;overflow:hidden;text-overflow:ellipsis;');
    shellScopePathEl = document.createElement('span');
    shellScopePathEl.id = 'shellScopePath';
    shellScopePathEl.setAttribute('style', 'color:#64748b;overflow:hidden;text-overflow:ellipsis;max-width:110px;');
    shellScopeStatusEl = document.createElement('span');
    shellScopeStatusEl.id = 'shellScopeStatus';
    shellScopeStatusEl.setAttribute('role', 'status');
    shellScopeStatusEl.setAttribute('aria-live', 'polite');
    shellScopeStatusEl.setAttribute('style', 'overflow:hidden;text-overflow:ellipsis;max-width:150px;');
    shellScopeOpenProjectBtn = document.createElement('button');
    shellScopeOpenProjectBtn.id = 'btnOpenProject';
    shellScopeOpenProjectBtn.type = 'button';
    shellScopeOpenProjectBtn.textContent = 'Mở dự án…';
    shellScopeOpenProjectBtn.setAttribute('title', 'Mở một dự án trong cửa sổ riêng');
    shellScopeOpenProjectBtn.setAttribute('style', 'height:16px;padding:0 6px;border-radius:5px;border:1px solid rgba(148,163,184,0.5);background:transparent;color:#cbd5e1;font-size:10px;cursor:pointer;');
    shellScopeOpenProjectBtn.addEventListener('click', () => { void openProjectFromScope(); });
    shellScopeChip.appendChild(shellScopeTitleEl);
    shellScopeChip.appendChild(shellScopePathEl);
    shellScopeChip.appendChild(shellScopeStatusEl);
    shellScopeChip.appendChild(shellScopeOpenProjectBtn);
    heading.appendChild(shellScopeChip);
  }

  const plan = shellScopeActionPlan(shellScope);
  if (!plan.chipVisible) {
    // Main has not described this shell: showing "Unassigned" here would be this
    // renderer naming a project state it cannot see.
    shellScopeChip.style.display = 'none';
    shellScopeChip.removeAttribute('title');
    if (shellScopeOpenProjectBtn) shellScopeOpenProjectBtn.style.display = 'none';
    return;
  }

  const title = shellScope.title || (shellScope.ownerKind === 'project' ? shellScope.projectId : 'Unassigned');
  shellScopeChip.style.display = 'flex';
  shellScopeChip.classList.toggle('unassigned', shellScope.ownerKind === 'unassigned');
  shellScopeChip.title = shellScope.pathLabel ? `${title} — ${shellScope.pathLabel}` : title;
  shellScopeTitleEl.textContent = title;
  shellScopePathEl.textContent = shellScope.pathLabel || '';
  if (shellScopeOpenProjectBtn) {
    shellScopeOpenProjectBtn.style.display = plan.openProjectVisible ? 'inline-flex' : 'none';
  }
}

/**
 * The explicit user intention to open a project. It never carries a project id: which
 * project the user meant is Main's answer to give, and a renderer that sent its own window's
 * id would turn "open another project" into "focus the one I am already in". The outcome is
 * reported from what Main answers, never inferred from the click.
 */
async function openProjectFromScope() {
  if (!api?.openProject) {
    reportShellScope('preload thiếu openProject', true);
    return;
  }
  try {
    const result = await api.openProject();
    const status = result && typeof result === 'object' ? result.status : '';
    if (status === 'OPENED') reportShellScope(`Đã mở ${result.projectId}`, false);
    else if (status === 'FOCUSED') reportShellScope(`Đã chuyển tới ${result.projectId}`, false);
    else if (status === 'FAILED') reportShellScope(projectOpenFailureText(result.reason), true);
    // CANCELLED needs no message: the user closed the picker themselves.
  } catch (err) {
    reportShellScope(err instanceof Error ? err.message : String(err), true);
  }
}

/**
 * A refusal in the user's language. Main answers with the machine reason it recorded, which
 * is the right value on the wire and the wrong thing to show next to a button, so the codes
 * this surface can cause are named here and anything else is shown verbatim rather than
 * replaced by a guess.
 */
function projectOpenFailureText(reason) {
  if (reason === 'PROJECT_FOLDER_INVALID') return 'Thư mục không hợp lệ hoặc không truy cập được';
  if (reason === 'AMBIGUOUS_PROJECT_FOLDER') return 'Nhiều dự án cùng dùng thư mục này';
  if (reason === 'UNKNOWN_PROJECT') return 'Dự án này không còn tồn tại';
  if (reason === 'INVALID_PROJECT_ID') return 'Mã dự án không hợp lệ';
  return typeof reason === 'string' && reason ? reason : 'không rõ nguyên nhân';
}

/**
 * Show the last Open Project outcome inside the chip itself. The header is the only
 * surface this renderer owns, and a failed open that reported nowhere would look
 * exactly like a click that did nothing.
 */
function reportShellScope(message, isError) {
  if (!shellScopeStatusEl) return;
  shellScopeStatusEl.textContent = message;
  shellScopeStatusEl.style.color = isError ? '#f87171' : '#86efac';
  clearTimeout(shellScopeStatusTimer);
  shellScopeStatusTimer = setTimeout(() => {
    shellScopeStatusEl.textContent = '';
  }, 6000);
}

let terminalNoticeEl = null;
let terminalNoticeTimer = null;

/**
 * Box treatment shared by every notice tone; only the three colour declarations differ, so a
 * notice that moves from "opening…" to a refusal repaints instead of keeping the colour of
 * the step before it. Inline like the chip's own container: the notice must be readable even
 * when the stylesheet that ships with the panel is not what painted this shell.
 */
const TERMINAL_NOTICE_BASE_STYLE = 'position:fixed;top:10px;right:12px;z-index:60;max-width:min(440px,70%);'
  + 'padding:8px 10px;border-radius:8px;font-size:11px;line-height:1.35;'
  + 'box-shadow:0 6px 18px rgba(0,0,0,0.35);display:none;pointer-events:none;word-break:break-word;';

/** A refusal (the default), a completed move, and a step still in flight. */
const TERMINAL_NOTICE_TONES = {
  error: 'border:1px solid rgba(248,113,113,0.55);background:rgba(69,10,10,0.94);color:#fecaca;',
  success: 'border:1px solid rgba(74,222,128,0.5);background:rgba(6,45,26,0.94);color:#bbf7d0;',
  info: 'border:1px solid rgba(148,163,184,0.5);background:rgba(15,23,42,0.94);color:#cbd5e1;',
};

/**
 * Show a terminal-command outcome inside the panel the command was issued from.
 *
 * The shell chip is not a usable surface for this: Main hides it outright for a shell whose owner
 * it has not described (`renderShellScopeChip`), so a refusal reported there can be painted into an
 * element the user cannot see. This notice is created on demand in the panel itself, so it exists
 * whether or not the header knows what the shell belongs to.
 */
function showTerminalNotice(message, tone) {
  if (!terminalNoticeEl) {
    terminalNoticeEl = document.createElement('div');
    terminalNoticeEl.id = 'terminalNotice';
    terminalNoticeEl.setAttribute('role', 'status');
    document.body.appendChild(terminalNoticeEl);
  }
  const toneStyle = TERMINAL_NOTICE_TONES[tone] || TERMINAL_NOTICE_TONES.error;
  terminalNoticeEl.setAttribute('style', TERMINAL_NOTICE_BASE_STYLE + toneStyle);
  terminalNoticeEl.textContent = message;
  terminalNoticeEl.style.display = 'block';
  clearTimeout(terminalNoticeTimer);
  terminalNoticeTimer = setTimeout(() => {
    if (terminalNoticeEl) terminalNoticeEl.style.display = 'none';
  }, 8000);
}

let bridgeHealthChipEl = null;
let bridgeHealthBannerEl = null;
let bridgePollInterval = null;
let bridgeStatusUnsubscribe = null;
const BRIDGE_DISMISSED_KEY = 'antifan.bridgeHealth.dismissed';

const BRIDGE_CHIP_BASE_STYLE =
  'display:inline-flex;align-items:center;gap:4px;height:24px;padding:0 8px;border-radius:6px;font-size:11px;font-weight:600;cursor:pointer;user-select:none;font-family:inherit;line-height:1.2;';

const BRIDGE_CHIP_TONES = {
  listening: 'border:1px solid rgba(74,222,128,0.5);background:rgba(6,45,26,0.94);color:#bbf7d0;',
  degraded: 'border:1px solid rgba(251,191,36,0.55);background:rgba(69,45,10,0.94);color:#fef08a;',
  down: 'border:1px solid rgba(248,113,113,0.55);background:rgba(69,10,10,0.94);color:#fecaca;',
};

/**
 * Creates and updates the bridge health chip in header .header-actions.
 * Always rendered (including listening), carrying port + client count in tooltip,
 * showing lastFailure.code when degraded/down, clicking re-invokes getBridgeStatus.
 */
function renderBridgeChip(report) {
  if (!report || typeof report !== 'object') return;

  const headerActions = document.querySelector('header .header-actions') || document.querySelector('.header-actions');
  if (!headerActions) return;

  if (!bridgeHealthChipEl) {
    bridgeHealthChipEl = headerActions.querySelector('#bridgeHealthChip');
    if (!bridgeHealthChipEl) {
      bridgeHealthChipEl = document.createElement('button');
      bridgeHealthChipEl.id = 'bridgeHealthChip';
      bridgeHealthChipEl.setAttribute('type', 'button');
      bridgeHealthChipEl.className = 'bridge-health-chip';
      bridgeHealthChipEl.textContent = '● Bridge';
    }
  }
  bridgeHealthChipEl.onclick = () => {
    void refreshBridgeStatus();
  };

  // Prepend into header .header-actions: exactly one instance, at the beginning
  if (headerActions.firstChild !== bridgeHealthChipEl) {
    headerActions.insertBefore(bridgeHealthChipEl, headerActions.firstChild);
  }

  // Tones
  let chipTone = BRIDGE_CHIP_TONES.listening;
  if (report.state === 'down') {
    chipTone = BRIDGE_CHIP_TONES.down;
  } else if (report.state === 'degraded' || (report.clientFailures && report.clientFailures.count > 0)) {
    chipTone = BRIDGE_CHIP_TONES.degraded;
  }
  bridgeHealthChipEl.setAttribute('style', BRIDGE_CHIP_BASE_STYLE + chipTone);

  // Tooltip carries port + client count, shows lastFailure.code when degraded/down
  const port = typeof report.port === 'number' ? report.port : (report.port || 0);
  const clientCount = typeof report.clientCount === 'number' ? report.clientCount : (report.clientCount || 0);
  let tooltip = `Port: ${port}, Clients: ${clientCount}`;
  const failureCode = report.lastFailure?.code || report.reasonCode;
  if (report.state !== 'listening' && failureCode) {
    tooltip += ` (${failureCode})`;
  }
  bridgeHealthChipEl.title = tooltip;
  bridgeHealthChipEl.setAttribute('title', tooltip);
  bridgeHealthChipEl.textContent = '● Bridge';
}

/**
 * Signature rule: `state | lastFailure.code | hasClientFailures` (no timestamps).
 */
function getBridgeDismissSignature(report) {
  const state = report?.state || '';
  const code = report?.lastFailure?.code || report?.reasonCode || '';
  const hasClientFailures = Boolean(report?.clientFailures && report.clientFailures.count > 0);
  return `${state}|${code}|${hasClientFailures}`;
}

/**
 * Maintains exactly one #bridgeHealthBanner as the first child of main.standalone with role="alert".
 * Shown only while report.state !== 'listening' || report.clientFailures.count > 0.
 * Recovery to listening removes banner and clears stored signature.
 */
function renderBridgeBanner(report) {
  if (!report || typeof report !== 'object') return;

  const main = document.querySelector('main.standalone') || document.querySelector('.standalone');
  if (!main) return;

  // Listening with no client failures in the recency window is the healthy
  // state: any banner from an earlier condition is removed and its dismissal
  // cleared so a future outage surfaces fresh.
  const isHealthy =
    report.state === 'listening' && !(report.clientFailures && report.clientFailures.count > 0);
  if (isHealthy) {
    if (bridgeHealthBannerEl) {
      bridgeHealthBannerEl.remove();
      bridgeHealthBannerEl = null;
    }
    const existing = main.querySelector('#bridgeHealthBanner');
    if (existing) existing.remove();
    try {
      window.localStorage?.removeItem(BRIDGE_DISMISSED_KEY);
    } catch {}
    return;
  }

  // Dismissal check
  const signature = getBridgeDismissSignature(report);
  let dismissed = null;
  try {
    dismissed = window.localStorage?.getItem(BRIDGE_DISMISSED_KEY);
  } catch {}

  if (dismissed === signature) {
    // Dismissed signature stays dismissed across pushes of the same condition
    if (bridgeHealthBannerEl) {
      bridgeHealthBannerEl.remove();
      bridgeHealthBannerEl = null;
    }
    const existing = main.querySelector('#bridgeHealthBanner');
    if (existing) existing.remove();
    return;
  }

  // Determine branch message
  let message = '';
  let bannerClass = '';
  if (report.state === 'down') {
    const code = report.reasonCode || report.lastFailure?.code || 'UNKNOWN';
    message = `Bridge MCP không hoạt động — agent không thể điều khiển trình duyệt (${code})`;
    bannerClass = 'bridge-banner-down';
  } else if (report.state === 'degraded') {
    const code = report.lastFailure?.code || report.reasonCode || 'UNKNOWN';
    message = `Bridge MCP đang suy giảm — ${code}`;
    bannerClass = 'bridge-banner-degraded';
  } else if (report.clientFailures && report.clientFailures.count > 0) {
    const count = report.clientFailures.count;
    const sessionId = report.clientFailures.latest?.terminalSessionId;
    message = sessionId
      ? `${count} MCP client kết nối thất bại trong 2 phút qua — server vẫn đang lắng nghe (${sessionId})`
      : `${count} MCP client kết nối thất bại trong 2 phút qua — server vẫn đang lắng nghe`;
    bannerClass = 'bridge-banner-client-failures';
  }

  if (!bridgeHealthBannerEl) {
    bridgeHealthBannerEl = main.querySelector('#bridgeHealthBanner');
    if (!bridgeHealthBannerEl) {
      bridgeHealthBannerEl = document.createElement('div');
      bridgeHealthBannerEl.id = 'bridgeHealthBanner';
    }
  }
  bridgeHealthBannerEl.setAttribute('role', 'alert');

  bridgeHealthBannerEl.className = `bridge-health-banner ${bannerClass}`;

  // Content
  let textSpan = bridgeHealthBannerEl.querySelector('.bridge-health-banner-text');
  if (!textSpan) {
    textSpan = document.createElement('span');
    textSpan.className = 'bridge-health-banner-text';
    bridgeHealthBannerEl.appendChild(textSpan);
  }
  textSpan.textContent = message;

  let closeBtn = bridgeHealthBannerEl.querySelector('.bridge-health-banner-close');
  if (!closeBtn) {
    closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'bridge-health-banner-close';
    closeBtn.setAttribute('aria-label', 'Đóng thông báo');
    closeBtn.textContent = '✕';
    bridgeHealthBannerEl.appendChild(closeBtn);
  }
  closeBtn.onclick = () => {
    try {
      window.localStorage?.setItem(BRIDGE_DISMISSED_KEY, signature);
    } catch {}
    if (bridgeHealthBannerEl) {
      bridgeHealthBannerEl.remove();
      bridgeHealthBannerEl = null;
    }
  };
  // Inserted once as first child of main.standalone
  if (main.firstChild !== bridgeHealthBannerEl) {
    main.insertBefore(bridgeHealthBannerEl, main.firstChild);
  }
}

/**
 * Re-invokes getBridgeStatus and paints chip & banner.
 */
async function refreshBridgeStatus() {
  if (typeof api?.getBridgeStatus !== 'function') return;
  try {
    const report = await api.getBridgeStatus();
    if (report && typeof report === 'object') {
      renderBridgeChip(report);
      renderBridgeBanner(report);
    }
  } catch (err) {
    console.error('[bridge-health] refreshBridgeStatus error:', err);
  }
}

if (typeof api?.onBridgeStatus === 'function') {
  try {
    bridgeStatusUnsubscribe = api.onBridgeStatus((report) => {
      if (report && typeof report === 'object') {
        renderBridgeChip(report);
        renderBridgeBanner(report);
      }
    });
  } catch (err) {
    console.error('[bridge-health] onBridgeStatus subscription error:', err);
  }
}

window.renderBridgeChip = renderBridgeChip;
window.renderBridgeBanner = renderBridgeBanner;
window.refreshBridgeStatus = refreshBridgeStatus;
window.getBridgeDismissSignature = getBridgeDismissSignature;

/**
 * Run a terminal-creation request against Main and say why nothing appeared when it refuses.
 *
 * Session creation lives on the main side, so a rejection is the only explanation this renderer
 * ever gets: ignoring it made the button inert with nothing said anywhere, which is a dead click
 * the user has no way to diagnose.
 */
async function createTerminal() {
  if (!api?.newTerminal) {
    showTerminalNotice('Không tạo được Terminal: preload thiếu newTerminal');
    return;
  }
  try {
    // Explicit cwd: Main must not fall back to one global current workspace, or a terminal
    // started in this window can land in another project's directory.
    await api.newTerminal(shellScope.workspacePath || undefined);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    showTerminalNotice(`Không tạo được Terminal: ${message}`);
    console.error('[terminal] newTerminal refused:', message);
  }
}

// ---------------------------------------------------------------------------
// Terminal tab-strip layout: horizontal strip (default) <-> vertical sidebar.
//
// The durable preference is owned by the main process: it is validated by
// `applyTerminalTabPrefs()` in native-tab-host.ts, persisted into saved-tabs.json
// as `terminalTabLayout` / `terminalSidebarWidth`, and echoed back on boot inside
// `GET_INITIAL_STATE.terminalTabPrefs`. This renderer only paints that preference
// and asks for changes over TERMINAL_CHANNELS.SET_TAB_PREFS. It deliberately keeps
// no local copy, so a docked surface and a popout window cannot drift apart.
//
// The layout itself is pure CSS: `.standalone.tabs-sidebar` turns the root into a
// 3-column grid (tab column | resizer | terminal) whose first track is
// `var(--term-sidebar-w)`. The tab DOM is never restructured, which is why drag
// reordering and every existing tab interaction keep working in both layouts.
//
// Declared here, above `renderTabs`/`bootstrapTerminalState`, because both read
// the active layout during boot; a later `let` would put them in the temporal
// dead zone on the first render.
// ---------------------------------------------------------------------------
const TERMINAL_SIDEBAR_MIN_WIDTH = 140;
const TERMINAL_SIDEBAR_MAX_WIDTH = 400;
const TERMINAL_SIDEBAR_DEFAULT_WIDTH = 220;

const standaloneRoot = document.querySelector('.standalone');
const tabsSidebarResizer = document.getElementById('tabsSidebarResizer');
const terminalTabLayoutBtn = document.getElementById('btnTerminalTabLayout');

let terminalTabLayout = 'horizontal';
let terminalSidebarWidth = TERMINAL_SIDEBAR_DEFAULT_WIDTH;

function clampTerminalSidebarWidth(width) {
  if (typeof width !== 'number' || !Number.isFinite(width)) return TERMINAL_SIDEBAR_DEFAULT_WIDTH;
  return Math.max(TERMINAL_SIDEBAR_MIN_WIDTH, Math.min(Math.round(width), TERMINAL_SIDEBAR_MAX_WIDTH));
}

/** Paint a layout/width pair. Unknown values are ignored, never guessed. */
function applyTerminalTabLayout(layout, width) {
  const previousLayout = terminalTabLayout;
  if (layout === 'horizontal' || layout === 'sidebar') {
    terminalTabLayout = layout;
  }
  if (typeof width === 'number') {
    terminalSidebarWidth = clampTerminalSidebarWidth(width);
  }
  const isSidebar = terminalTabLayout === 'sidebar';

  if (standaloneRoot) {
    standaloneRoot.classList.toggle('tabs-sidebar', isSidebar);
    standaloneRoot.style.setProperty('--term-sidebar-w', terminalSidebarWidth + 'px');
  }
  if (terminalTabLayoutBtn) {
    terminalTabLayoutBtn.setAttribute('aria-pressed', isSidebar ? 'true' : 'false');
  }
  if (tabsSidebarResizer) {
    // The separator is operable only in the sidebar layout. Leaving it focusable
    // and exposed while the strip is horizontal would advertise a control the
    // user cannot actually use.
    tabsSidebarResizer.setAttribute('aria-hidden', isSidebar ? 'false' : 'true');
    tabsSidebarResizer.setAttribute('aria-valuenow', String(terminalSidebarWidth));
    tabsSidebarResizer.setAttribute('aria-valuemin', String(TERMINAL_SIDEBAR_MIN_WIDTH));
    tabsSidebarResizer.setAttribute('aria-valuemax', String(TERMINAL_SIDEBAR_MAX_WIDTH));
    tabsSidebarResizer.tabIndex = isSidebar ? 0 : -1;
  }
  // Grouping is painted by renderTabs (headers only exist in sidebar mode), so a
  // layout flip must repaint the strip. Guarded on an actual change so the
  // plain width echo from main does not re-render on every drag frame.
  if (previousLayout !== terminalTabLayout && typeof renderTabs === 'function') {
    renderTabs();
  }
}

/** Ask the main process to persist; its clamped echo is authoritative. */
function persistTerminalTabPrefs() {
  try {
    const result = api?.setTerminalTabPrefs?.({
      layout: terminalTabLayout,
      sidebarWidth: terminalSidebarWidth,
      collapsedCategories: Array.from(collapsedCategories),
      categories: terminalCategories.slice(),
      categoryColors: Object.assign({}, categoryColors),
      starredCategories: Array.from(starredCategories),
    });
    if (result && typeof result.then === 'function') {
      result
        .then((applied) => {
          if (applied && typeof applied === 'object') {
            // Only adopt the echo when main actually carried the field, so an
            // older/partial reply cannot wipe the local collapse state.
            if (Array.isArray(applied.collapsedCategories)) {
              applyCollapsedCategories(applied.collapsedCategories);
              if (typeof renderTabs === 'function') renderTabs();
            }
            if (Array.isArray(applied.categories)) {
              applyCategories(applied.categories);
              if (typeof renderTabs === 'function') renderTabs();
            }
            if (applied.categoryColors && typeof applied.categoryColors === 'object') {
              applyCategoryColors(applied.categoryColors);
              if (typeof renderTabs === 'function') renderTabs();
            }
            if (Array.isArray(applied.starredCategories)) {
              applyStarredCategories(applied.starredCategories);
              if (typeof renderTabs === 'function') renderTabs();
            }
            applyTerminalTabLayout(applied.layout, applied.sidebarWidth);
          }
        })
        .catch(() => {});
    }
  } catch {}
}

/** Sidebar width implied by a pointer at `clientX`. */
function sidebarWidthFromPointer(clientX) {
  const tabColumn = standaloneRoot?.querySelector('.controls');
  if (!tabColumn) return terminalSidebarWidth;
  return clampTerminalSidebarWidth(clientX - tabColumn.getBoundingClientRect().left);
}

/** The grid track changed size, so xterm must recompute cols/rows. */
function refitAfterLayoutChange() {
  if (typeof fitCurrentTerminal === 'function') {
    fitCurrentTerminal();
  }
}

if (terminalTabLayoutBtn) {
  terminalTabLayoutBtn.addEventListener('click', () => {
    applyTerminalTabLayout(terminalTabLayout === 'sidebar' ? 'horizontal' : 'sidebar');
    persistTerminalTabPrefs();
    requestAnimationFrame(refitAfterLayoutChange);
  });
}

if (tabsSidebarResizer) {
  let isResizingSidebar = false;
  let sidebarRafId = null;
  let pendingSidebarWidth = terminalSidebarWidth;

  const stopSidebarResize = (e) => {
    if (!isResizingSidebar) return;
    isResizingSidebar = false;
    tabsSidebarResizer.classList.remove('is-dragging');
    try {
      if (e && e.pointerId !== undefined) {
        tabsSidebarResizer.releasePointerCapture(e.pointerId);
      }
    } catch {}
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    if (sidebarRafId) {
      cancelAnimationFrame(sidebarRafId);
      sidebarRafId = null;
    }
    applyTerminalTabLayout('sidebar', pendingSidebarWidth);
    // Persist once per gesture instead of once per frame.
    persistTerminalTabPrefs();
    refitAfterLayoutChange();
  };

  tabsSidebarResizer.addEventListener('pointerdown', (e) => {
    if (terminalTabLayout !== 'sidebar') return;
    isResizingSidebar = true;
    pendingSidebarWidth = terminalSidebarWidth;
    tabsSidebarResizer.classList.add('is-dragging');
    try {
      tabsSidebarResizer.setPointerCapture(e.pointerId);
    } catch {}
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    e.preventDefault();
  });

  tabsSidebarResizer.addEventListener('pointermove', (e) => {
    if (!isResizingSidebar) return;
    pendingSidebarWidth = sidebarWidthFromPointer(e.clientX);
    if (sidebarRafId) return;
    sidebarRafId = requestAnimationFrame(() => {
      sidebarRafId = null;
      applyTerminalTabLayout('sidebar', pendingSidebarWidth);
      refitAfterLayoutChange();
    });
  });

  tabsSidebarResizer.addEventListener('pointerup', stopSidebarResize);
  tabsSidebarResizer.addEventListener('pointercancel', stopSidebarResize);

  // role="separator" with tabindex=0 must be keyboard-operable.
  tabsSidebarResizer.addEventListener('keydown', (e) => {
    if (terminalTabLayout !== 'sidebar') return;
    let next = null;
    if (e.key === 'ArrowLeft') next = terminalSidebarWidth - 16;
    else if (e.key === 'ArrowRight') next = terminalSidebarWidth + 16;
    else if (e.key === 'Home') next = TERMINAL_SIDEBAR_MIN_WIDTH;
    else if (e.key === 'End') next = TERMINAL_SIDEBAR_MAX_WIDTH;
    if (next === null) return;
    e.preventDefault();
    applyTerminalTabLayout('sidebar', next);
    persistTerminalTabPrefs();
    refitAfterLayoutChange();
  });
}

// Benchmark hook (phase-1): stamps T1 (IPC receipt) -> T2 (queueWrite entry) ->
// T3 (xterm parse complete) -> T4 (next rAF paint). Defined only under
// __bench=1 so the streaming hot path pays a single cached-boolean check.
const __terminalBench = urlParams.get('__bench') === '1' ? (() => {
  const events = [];
  return {
    record(stage, extra) {
      const entry = { stage, ts: performance.now() };
      if (extra) entry.extra = extra;
      events.push(entry);
    },
    snapshot() { return events.slice(); },
    clear() { events.length = 0; },
  };
})() : null;
if (__terminalBench) {
  window.__antifanTerminalBench = __terminalBench;
}

// T3/T4 share one stamp site: parse completion, then the next rAF paint.
function benchRecordPaint(sessionId) {
  if (!__terminalBench) return;
  __terminalBench.record('T3', { sessionId });
  requestAnimationFrame(() => __terminalBench.record('T4', { sessionId }));
}
const initialQuerySessionId = urlParams.get('sessionId') || '';
let activeId = initialQuerySessionId || '';
let sessions = [];
/**
 * The halves of the last `antifan:tabs:updated` broadcast.
 *
 * `renderTabs()` runs on the session push, which arrives at 5 Hz, and its badge repaint used to
 * pull both halves back over IPC (`getTabs()` + `getTerminalAffinities()`) even though the
 * broadcast had just delivered them — ~144,000 round trips and 144,000 deserializations in the
 * renderer over a 4 h soak, on the one process whose committed bytes are what grows. Passing the
 * delivered pair is the same data the broadcast already rendered from, so the badges cannot go
 * stale relative to today's behaviour; only the round trips go away.
 */
let deliveredTabs = null;
let deliveredAffinities = null;
let contextTargetSessionId = '';
let globalResizeObserver = null;
const MIN_TERMINAL_COLS = 40;
const MIN_TERMINAL_ROWS = 8;
const MIN_SPLIT_TERMINAL_ROWS = 4;
const DEFAULT_MAIN_SPLIT_RATIO = 0.8;
const SPLIT_TERMINAL_FRACTION = 0.2;

// ---------------------------------------------------------------------------
// Sleep / wake and tab categories (phase 5).
//
// A sleeping session has no PTY in the main process, so it must cost nothing
// here either: no xterm instance, no DOM pane, no delta bookkeeping. Its
// retained transcript stays readable through a lightweight read-only preview
// and the first keystroke asks the main process to wake it (`wakeTerminal`).
// `sessions[].state` is the only source of truth — the renderer never guesses
// that a session is asleep, so a stale session broadcast can never strand a
// pane, and a wake always repaints from main's authoritative state.
// ---------------------------------------------------------------------------
const UNCATEGORIZED_CATEGORY = '__uncategorized__';
const UNCATEGORIZED_CATEGORY_LABEL = 'Chưa phân nhóm';
/**
 * A state bucket, not a real category. Every sleeping session is presented here
 * instead of inside its own group, so an asleep tab is never mixed into a list of
 * live ones. It is never a drop target and is never renamed: it is derived from
 * `session.state`, so it cannot be created, typed into or filed under by hand.
 */
const SLEEPING_CATEGORY = '__sleeping__';
const SLEEPING_CATEGORY_LABEL = 'Đang ngủ';
const CATEGORY_CHIP_COLORS = ['#38bdf8', '#a78bfa', '#34d399', '#fbbf24', '#fb7185', '#22d3ee', '#f472b6', '#84cc16'];
const categoryHeaders = new Map();
/** Sticky order of category keys: a header keeps the slot it first appeared in. */
const categoryOrder = [];
const collapsedCategories = new Set();
/**
 * Session id of the tab currently being dragged, or null. A group header only
 * claims a drop while a real tab drag is in flight, so an unrelated drag (a file,
 * a link, a text selection) can never be read as a category assignment.
 */
let dragSourceSessionId = null;
let pointerTabDrag = null;

function commitCategoryDrop(sourceId, header) {
  if (!sourceId || !header) return;
  const key = header.getAttribute('data-category') || UNCATEGORIZED_CATEGORY;
  if (key === SLEEPING_CATEGORY) return;
  const session = findSession(sourceId);
  if (!session) return;
  const target = key === UNCATEGORIZED_CATEGORY ? '' : key;
  const wasSleeping = session.state === 'sleeping';
  if ((session.category || '') !== target) applyCategoryToSession(sourceId, target, null);
  // A closed/sleeping tab filed into a group must open immediately, otherwise the
  // group render hides it in the sleep bucket and the drop looks like it vanished.
  if (wasSleeping) {
    wakeSleepingSession(sourceId, '');
    activateTabLocally(sourceId);
  }
}

function commitTabReorder(sourceId, targetId) {
  if (!sourceId || !targetId || sourceId === targetId) return;
  const fromIdx = sessions.findIndex((x) => x.id === sourceId);
  const toIdx = sessions.findIndex((x) => x.id === targetId);
  if (fromIdx === -1 || toIdx === -1) return;
  const target = sessions[toIdx];
  const source = sessions[fromIdx];
  if (target && source && !target.splitOf && (source.category || '') !== (target.category || '')) {
    applyCategoryToSession(sourceId, target.category || '', null);
  }
  if (source && source.state === 'sleeping') {
    wakeSleepingSession(sourceId, '');
    activateTabLocally(sourceId);
  }
  const [moved] = sessions.splice(fromIdx, 1);
  const nextTo = sessions.findIndex((x) => x.id === targetId);
  if (nextTo === -1) return;
  sessions.splice(nextTo, 0, moved);
  renderTabs();
  if (api?.reorderTerminals) void api.reorderTerminals(sessions.map((x) => x.id));
}
window.addEventListener('pointermove', (e) => {
  const drag = pointerTabDrag;
  if (!drag || drag.pointerId !== e.pointerId) return;
  const dx = e.clientX - drag.startX;
  const dy = e.clientY - drag.startY;
  if (!drag.active) {
    if (dx * dx + dy * dy < 16) return;
    drag.active = true;
    dragSourceSessionId = drag.sessionId;
    drag.wrap.classList.add('dragging');
  }
  const hit = document.elementFromPoint(e.clientX, e.clientY);
  if (tabsEl) tabsEl.querySelectorAll('.drag-over').forEach((el) => el.classList.remove('drag-over'));
  const target = hit && hit.closest ? (hit.closest('.terminal-tab-category-header') || hit.closest('.terminal-tab-wrap')) : null;
  if (target && target !== drag.wrap) target.classList.add('drag-over');
});
window.addEventListener('pointerup', (e) => {
  const drag = pointerTabDrag;
  if (!drag || drag.pointerId !== e.pointerId) return;
  pointerTabDrag = null;
  dragSourceSessionId = null;
  drag.wrap.classList.remove('dragging');
  if (tabsEl) tabsEl.querySelectorAll('.drag-over').forEach((el) => el.classList.remove('drag-over'));
  if (!drag.active) return;
  const hit = document.elementFromPoint(e.clientX, e.clientY);
  const header = hit && hit.closest ? hit.closest('.terminal-tab-category-header') : null;
  if (header) {
    commitCategoryDrop(drag.sessionId, header);
    return;
  }
  const row = hit && hit.closest ? hit.closest('.terminal-tab-wrap') : null;
  const targetId = row ? row.getAttribute('data-session-id') : '';
  if (targetId) commitTabReorder(drag.sessionId, targetId);
});
window.addEventListener('pointercancel', () => {
  if (!pointerTabDrag) return;
  pointerTabDrag.wrap.classList.remove('dragging');
  pointerTabDrag = null;
  dragSourceSessionId = null;
  if (tabsEl) tabsEl.querySelectorAll('.drag-over').forEach((el) => el.classList.remove('drag-over'));
});



function findSession(sessionId) {
  if (!sessionId || !Array.isArray(sessions)) return null;
  return sessions.find((s) => s.id === sessionId) || null;
}

/** True only when main's last session broadcast said this session is asleep. */
function isSessionSleeping(sessionId) {
  const s = findSession(sessionId);
  return Boolean(s && s.state === 'sleeping');
}

/** Replace the collapsed-group set with the values main persisted. */
function applyCollapsedCategories(list) {
  collapsedCategories.clear();
  if (!Array.isArray(list)) return;
  for (const entry of list) {
    if (typeof entry === 'string' && entry) collapsedCategories.add(entry);
  }
}

/**
 * User-managed group names, in display order. This is the renderer's mirror of
 * `TerminalTabPrefs.categories`.
 *
 * Grouping is otherwise *derived* from `session.category`, which cannot represent a
 * group with no tabs in it. This list is what lets a named group exist — and survive
 * a restart — while empty, which is why creating a group has to be its own operation
 * rather than a side effect of filing a tab.
 */
let terminalCategories = [];

/** Replace the group list with the values main persisted or echoed back. */
function applyCategories(list) {
  if (!Array.isArray(list)) return;
  const out = [];
  const seen = new Set();
  for (const entry of list) {
    if (typeof entry !== 'string') continue;
    const name = entry.trim();
    if (!name) continue;
    // Case-insensitive de-dupe, mirroring the main process: two names differing
    // only in case would otherwise paint two headers for one group.
    const folded = name.toLowerCase();
    if (seen.has(folded)) continue;
    seen.add(folded);
    out.push(name);
  }
  terminalCategories = out;
}

function categoryKeyOf(session) {
  const raw = session && typeof session.category === 'string' ? session.category.trim() : '';
  return raw || UNCATEGORIZED_CATEGORY;
}

/**
 * The key a session is grouped under. Normally its own category — except for a split pane,
 * which is a pane of the tab that owns it: it is filed with its parent, so dragging the
 * parent into a group takes its panes along instead of leaving them behind in the catch-all.
 *
 * Display-only, exactly like the sleep bucket: `session.category` is never rewritten, so a
 * pane that is unsplit needs no bookkeeping. A pane whose parent is asleep never reaches
 * here — it is parked with that parent, which is also its wake path. One whose parent the
 * active filter dropped (or which is already gone) falls back to its own category and keeps
 * its own row, because a pane the sidebar drops is a pane that cannot be reached or closed.
 */
function groupKeyOf(session, keyBySessionId) {
  const parentId = (session && typeof session.splitOf === 'string') ? session.splitOf : '';
  const parentKey = parentId ? keyBySessionId.get(parentId) : undefined;
  return parentKey === undefined ? rowGroupKeyOf(session) : parentKey;
}

/** Category name -> user-chosen chip colour. Absence means "derive it from the name". */
let categoryColors = Object.create(null);
/** Categories the user marked with `*`. A marker only — `terminalCategories` orders. */
let starredCategories = new Set();

/** Replace the colour overrides with the values main persisted or echoed back. */
function applyCategoryColors(map) {
  categoryColors = Object.create(null);
  if (!map || typeof map !== 'object' || Array.isArray(map)) return;
  for (const [key, color] of Object.entries(map)) {
    if (!key || typeof color !== 'string') continue;
    if (!/^#[0-9a-f]{6}$/i.test(color)) continue;
    categoryColors[key] = color;
  }
}

/** Replace the starred set with the values main persisted or echoed back. */
function applyStarredCategories(list) {
  starredCategories = new Set();
  if (!Array.isArray(list)) return;
  for (const entry of list) {
    if (typeof entry === 'string' && entry) starredCategories.add(entry);
  }
}

function categoryLabelOf(key) {
  return key === UNCATEGORIZED_CATEGORY ? UNCATEGORIZED_CATEGORY_LABEL : key;
}

/** The colour a category derives from its own name, before any user choice. */
function derivedCategoryColorOf(key) {
  let hash = 0;
  for (let i = 0; i < key.length; i += 1) {
    hash = ((hash * 31) + key.charCodeAt(i)) | 0;
  }
  return CATEGORY_CHIP_COLORS[Math.abs(hash) % CATEGORY_CHIP_COLORS.length];
}

/** Deterministic palette pick so a category keeps its colour across renders. */
function categoryColorOf(key) {
  if (key === UNCATEGORIZED_CATEGORY) return '';
  // A user choice wins over the derived colour: the hash is a default, not a policy.
  const override = categoryColors[key];
  if (typeof override === 'string' && override) return override;
  return derivedCategoryColorOf(key);
}

// ---------------------------------------------------------------------------
// Capsules (projects): the axis a shared manager shell groups by.
//
// A window that owns a project shows that project's terminals, so its capsule is a constant
// there and grouping by it would add one useless header. The manager shell — a window Main
// has left Unassigned — shows terminals from every project instead, and there the capsule is
// the only thing that says which storefront a row belongs to.
// ---------------------------------------------------------------------------

/** Group-key namespace for a capsule section. Prefixed so a key can never collide with a
 *  user-typed group name (`terminalCategories` is what Main persists, so the two lists must
 *  stay distinguishable). */
const CAPSULE_GROUP_PREFIX = 'capsule:';

/**
 * True when this shell is the shared manager: no project of its own, so its view spans every
 * capsule. Main decides what a shell belongs to and this only reads the decision it sent — a
 * shell it has not described is not a manager, because nothing has said it is.
 */
function isSharedManagerShell() {
  return shellScope.ownerKind === 'unassigned';
}

function isCapsuleGroupKey(key) {
  return typeof key === 'string' && key.startsWith(CAPSULE_GROUP_PREFIX) && key.length > CAPSULE_GROUP_PREFIX.length;
}

/** Capsule id -> { id, name, workspacePath, projectId } behind the rows on screen. */
let capsuleIndex = new Map();
let capsuleIndexLoaded = false;
let capsuleIndexPending = null;

/** Normalize one capsule row. `resolvedProjectId` is Main's additively resolved affiliation
 *  for a capsule whose own record claims none. */
function capsuleEntryOf(capsule) {
  if (!capsule || typeof capsule !== 'object') return null;
  const id = typeof capsule.id === 'string' ? capsule.id.trim() : '';
  if (!id) return null;
  const resolved = typeof capsule.resolvedProjectId === 'string' ? capsule.resolvedProjectId.trim() : '';
  const claimed = typeof capsule.projectId === 'string' ? capsule.projectId.trim() : '';
  return {
    id,
    name: typeof capsule.name === 'string' && capsule.name.trim() ? capsule.name.trim() : id,
    workspacePath: typeof capsule.workspacePath === 'string' ? capsule.workspacePath : '',
    projectId: resolved || claimed,
  };
}

/** Load capsule labels for the shared manager's grouping, not project destinations. */
function ensureCapsuleIndex(force = false) {
  if (capsuleIndexPending) return capsuleIndexPending;
  if (capsuleIndexLoaded && !force) return Promise.resolve(false);
  const read = (async () => {
    if (!api?.listCapsules) {
      capsuleIndexLoaded = true;
      return false;
    }
    try {
      const reply = await api.listCapsules();
      const rows = reply && typeof reply === 'object' && Array.isArray(reply.capsules) ? reply.capsules : null;
      if (!rows) {
        capsuleIndexLoaded = true;
        return false;
      }
      const next = new Map();
      for (const row of rows) {
        const entry = capsuleEntryOf(row);
        if (entry) next.set(entry.id, entry);
      }
      capsuleIndex = next;
      capsuleIndexLoaded = true;
      return true;
    } catch {
      capsuleIndexLoaded = true;
      return false;
    }
  })();
  capsuleIndexPending = read;
  const settle = () => { if (capsuleIndexPending === read) capsuleIndexPending = null; };
  read.then(settle, settle);
  return read;
}

/** The capsule a session is filed under, or '' when it carries none. */
function capsuleIdOf(session) {
  return session && typeof session.capsuleId === 'string' ? session.capsuleId.trim() : '';
}

/** Display name for a capsule id. An id the index has never seen is shown as itself: the row
 *  still belongs to that capsule, and naming it something else would be a guess. */
function capsuleLabelOf(capsuleId) {
  const entry = capsuleIndex.get(capsuleId);
  return entry ? entry.name : capsuleId;
}

/** The workspace path behind a capsule id, or '' when the index has not named it. */
function capsulePathOf(capsuleId) {
  const entry = capsuleIndex.get(capsuleId);
  return entry ? entry.workspacePath : '';
}

/**
 * The group a row belongs in for this shell: its capsule in the manager, its category
 * everywhere else — and its category in the manager too when it carries no capsule, which is
 * what keeps a terminal that was never given a workspace reachable.
 */
function rowGroupKeyOf(session) {
  const capsuleId = isSharedManagerShell() ? capsuleIdOf(session) : '';
  return capsuleId ? CAPSULE_GROUP_PREFIX + capsuleId : categoryKeyOf(session);
}

/** The group record for one key: a capsule section in the manager, a category group otherwise. */
function buildGroupForKey(key) {
  if (isCapsuleGroupKey(key)) {
    const capsuleId = key.slice(CAPSULE_GROUP_PREFIX.length);
    return {
      key,
      kind: 'capsule',
      capsuleId,
      label: capsuleLabelOf(capsuleId),
      color: derivedCategoryColorOf(capsuleId),
      hint: capsulePathOf(capsuleId),
      items: [],
    };
  }
  return { key, kind: 'category', label: categoryLabelOf(key), color: categoryColorOf(key), items: [] };
}

/**
 * Bucket sessions by the group key this shell files rows under — a capsule in the manager,
 * a category otherwise — preserving the first-appearance order of each group. Iterating
 * `sessions` (which main owns) is what makes the group order stable across renders — a
 * hash-map or alphabetical sort would reshuffle the sidebar every time a tab's activity changed.
 */
function groupSessionsByCategory(list) {
  const groups = [];
  const byKey = new Map();
  // User-created groups seed the list first, in their own order, and are emitted even
  // with no tabs in them: `session.category` alone cannot represent an empty group,
  // and a group the user created has to stay visible whether or not anything is
  // currently filed under it.
  for (const name of terminalCategories) {
    if (byKey.has(name)) continue;
    const seeded = { key: name, kind: 'category', label: name, color: categoryColorOf(name), items: [] };
    byKey.set(name, seeded);
    groups.push(seeded);
    if (!categoryOrder.includes(name)) {
      // A group created at runtime must land with the real groups, not below the
      // "Chưa phân nhóm" catch-all — which already holds a slot by the time the user
      // creates one. Inserting in front of that slot leaves every existing key exactly
      // where it was, so the sticky order still holds for everything already on screen.
      const uncategorizedAt = categoryOrder.indexOf(UNCATEGORIZED_CATEGORY);
      if (uncategorizedAt === -1) categoryOrder.push(name);
      else categoryOrder.splice(uncategorizedAt, 0, name);
    }
  }
  // Every session's own key, so a pane can be filed under the key of the tab it splits.
  const keyBySessionId = new Map();
  for (const s of (list || [])) keyBySessionId.set(s.id, rowGroupKeyOf(s));
  for (const s of (list || [])) {
    const key = groupKeyOf(s, keyBySessionId);
    let group = byKey.get(key);
    if (!group) {
      group = buildGroupForKey(key);
      byKey.set(key, group);
      groups.push(group);
      if (!categoryOrder.includes(key)) categoryOrder.push(key);
    }
    group.items.push(s);
  }
  // A key keeps the slot it first appeared in, so dragging a tab between groups
  // can never reshuffle the sidebar: only the tabs inside a group move.
  const liveKeys = new Set(groups.map((g) => g.key));
  for (let i = categoryOrder.length - 1; i >= 0; i -= 1) {
    if (!liveKeys.has(categoryOrder[i])) categoryOrder.splice(i, 1);
  }
  groups.sort((a, b) => categoryOrder.indexOf(a.key) - categoryOrder.indexOf(b.key));
  return groups;
}

/**
 * Release every renderer-side resource for one pooled pane. Shared by the
 * closed-session sweep and the sleeping-session sweep so a sleeping tab can
 * never keep a live xterm (and its WebGL context) alive.
 */
function releaseTerminalPane(id, item) {
  if (!item) return;
  // Async work started while the pane was live (activate-time refits, settle timers, in-flight
  // hydration) holds this item directly, so disposal needs a flag: without it those paths call
  // into a dead xterm and throw.
  item.released = true;
  // The hydration continuation re-reads this epoch after every await, so bumping it here retires
  // work already in flight even along a path that only checks the epoch.
  item.hydrationEpoch = (item.hydrationEpoch || 0) + 1;
  try {
    if (item.writeTarget && window.globalTerminalWriteDispatcher) {
      window.globalTerminalWriteDispatcher.cancel(item.writeTarget);
    }
  } catch {}
  item.writeTarget = null;
  try { item.webLinksAddon?.dispose(); } catch {}
  try { item.webglAddon?.dispose(); } catch {}
  try { item.term.dispose(); } catch {}
  if (globalResizeObserver) {
    try { globalResizeObserver.unobserve(item.paneEl); } catch {}
  }
  try { item.paneEl.remove(); } catch {}
  rawTerminalPool.delete(id);
  sessionSplitRatios.delete(id);
}

// Keystrokes that triggered a wake are buffered until the fresh PTY has a pane,
// so the first character the user typed is never dropped on the floor.
const deferredWakeInput = new Map();
const wakeInFlight = new Set();

/**
 * Ask main to wake a sleeping session, buffering any input that caused the wake.
 * Safe to call repeatedly: at most one wake request is in flight per session.
 */
function wakeSleepingSession(sessionId, pendingInput) {
  if (!sessionId) return;
  if (pendingInput) {
    deferredWakeInput.set(sessionId, (deferredWakeInput.get(sessionId) || '') + pendingInput);
  }
  if (wakeInFlight.has(sessionId)) return;
  wakeInFlight.add(sessionId);
  let result;
  try {
    result = api?.wakeTerminal?.(sessionId);
  } catch {
    wakeInFlight.delete(sessionId);
    return;
  }
  Promise.resolve(result)
    .then(() => {
      wakeInFlight.delete(sessionId);
      flushDeferredWakeInput();
    })
    .catch(() => {
      wakeInFlight.delete(sessionId);
    });
}

/**
 * Deliver buffered wake keystrokes once main reports the session awake and a
 * pane exists again. Called after every session broadcast; entries whose
 * session is still asleep stay buffered.
 */
function flushDeferredWakeInput() {
  if (deferredWakeInput.size === 0) return;
  for (const [sessionId, text] of Array.from(deferredWakeInput.entries())) {
    if (isSessionSleeping(sessionId)) continue;
    if (!rawTerminalPool.has(sessionId)) continue;
    deferredWakeInput.delete(sessionId);
    api?.sendTerminalInputTo?.(sessionId, text);
  }
}

/** Single funnel for pane input so "typing wakes a sleeping session" is total. */
function sendTerminalInputFor(sessionId, data) {
  if (!sessionId || !data) return;
  const act = sessionActivity.get(sessionId);
  if (act && act.isWaiting) {
    act.isWaiting = false;
    updateTabActivityUi(sessionId);
  }
  if (isSessionSleeping(sessionId)) {
    // The pane is released for a sleeping session; if a keystroke still reaches
    // one (sleep raced the last paint) it is an explicit wake request.
    wakeSleepingSession(sessionId, data);
    return;
  }
  api?.sendTerminalInputTo?.(sessionId, data);
}

let sleepPreviewEl = null;
let sleepPreviewSessionId = '';
/** 'sleeping' | 'lossy' while a read-only transcript view is mounted ('' = live pane). */
let sleepPreviewMode = '';
/** Whether the mounted view already holds the full retained transcript. */
let sleepPreviewFullLoaded = false;
/** Session whose on-demand transcript view the user opened ('' = none). */
let transcriptPreviewSessionId = '';

function teardownSleepPreview() {
  if (!sleepPreviewEl) return;
  try { sleepPreviewEl.remove(); } catch {}
  sleepPreviewEl = null;
  sleepPreviewSessionId = '';
  sleepPreviewMode = '';
  sleepPreviewFullLoaded = false;
}

/**
 * Turn a retained PTY capture into readable plain text.
 *
 * The capture is raw terminal output, so it is dense with escape sequences: SGR colour,
 * line erase (`ESC[0K`), screen clear (`ESC[3J`), cursor moves, window titles. Rendering
 * them verbatim is what produced a wall of `[0m[0K[?25l` in the preview. A slept tab is a
 * FINISHED transcript, not a live terminal, so the honest treatment is to drop the control
 * sequences and keep the text, rather than pretend to emulate them.
 */
function transcriptToPlainText(raw) {
  if (typeof raw !== 'string' || !raw) return '';
  let text = raw;
  // OSC (window title, hyperlinks): ESC ] … terminated by BEL or ST.
  text = text.replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?/g, '');
  // CSI (colour, erase, cursor): ESC [ params/intermediates then a final byte.
  text = text.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '');
  // Any remaining two-character escape (charset selection, keypad modes, …).
  text = text.replace(/\u001b[@-Z\\-_]/g, '');
  // Leftover C0 controls other than tab/newline, plus DEL.
  text = text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
  // CRLF first, so the carriage-return pass below cannot mistake it for an overwrite.
  text = text.replace(/\r\n/g, '\n');
  // A bare CR is an in-place overwrite, and a terminal shows the last thing written to
  // that line — so keep the last non-empty segment. A partial overwrite therefore shows
  // the final write rather than a character-exact repaint: this is a transcript, not an
  // emulator, and saying so is better than half-emulating it.
  text = text.split('\n').map((line) => {
    if (!line.includes('\r')) return line;
    const written = line.split('\r').filter((part) => part.length > 0);
    return written.length > 0 ? written[written.length - 1] : '';
  }).join('\n');
  // Trailing spaces, and the dead space a capture ends parked on, are noise in a
  // read-only view.
  return text.replace(/[ \t]+$/gm, '').replace(/\n{3,}/g, '\n\n').trim();
}

/** Plain text for a read-only transcript view. */
function previewTranscriptText(session) {
  const raw = (session && typeof session.buffer === 'string') ? session.buffer : '';
  const text = transcriptToPlainText(raw);
  return text || '(Không có nội dung lưu lại)';
}

/**
 * The pushed `buffer` is a JSON-budgeted suffix of the transcript, so a mounted view
 * is upgraded to the full retained transcript once main answers. The load stays bound
 * to the element it was started for: a later mount (another session, another mode)
 * must never be overwritten by a slow answer.
 */
function loadFullTranscriptInto(el, sessionId, mode, body) {
  if (!api?.getFullBuffer) return;
  let pending;
  try { pending = api.getFullBuffer(sessionId); } catch { return; }
  Promise.resolve(pending)
    .then((result) => {
      if (sleepPreviewEl !== el || sleepPreviewSessionId !== sessionId || sleepPreviewMode !== mode) return;
      const full = transcriptToPlainText(typeof result?.buffer === 'string' ? result.buffer : '');
      if (!full) return;
      sleepPreviewFullLoaded = true;
      if (body.textContent !== full) body.textContent = full;
    })
    .catch(() => {});
}

/** Leave the on-demand transcript view and show the live pane again. */
function closeTranscriptPreview() {
  if (!transcriptPreviewSessionId) return;
  transcriptPreviewSessionId = '';
  syncTerminalPool(sessions, activeId);
}

/**
 * Read-only transcript mode for the active tab: '' (live pane), 'sleeping' (its PTY is
 * gone, so the retained transcript is all there is) or 'lossy' (the user asked for the
 * text view). A split is reachable while its parent is the active tab, because the main
 * process keeps the active session base-scoped and resolves a split to its parent.
 */
function resolveReadOnlyTranscriptMode(activeSession) {
  if (!activeSession) return '';
  if (activeSession.state === 'sleeping') return 'sleeping';
  if (!transcriptPreviewSessionId) return '';
  if (transcriptPreviewSessionId === activeSession.id) return 'lossy';
  const requested = findSession(transcriptPreviewSessionId);
  return requested && requested.splitOf === activeSession.id ? 'lossy' : '';
}

/**
 * Read-only transcript view over the live pane.
 *
 * `mode` is 'sleeping' (finished session, PTY released) or 'lossy' (a live tab read as
 * text — the honest answer for a full-screen TUI, whose alternate buffer offers no
 * scrollback to show). Both are plain text on purpose: no xterm, no PTY, no delta
 * cursor, and the capture is stripped of control codes rather than emulated.
 */
function renderSleepPreview(session, mode = 'sleeping') {
  if (!session || !mainPane) return;
  const requestedMode = mode === 'lossy' ? 'lossy' : 'sleeping';
  const text = previewTranscriptText(session);
  if (sleepPreviewEl && sleepPreviewSessionId === session.id && sleepPreviewMode === requestedMode) {
    // A view that already holds the full retained transcript is a snapshot: re-slicing
    // megabytes on every push would cost more than the staleness it removes.
    if (sleepPreviewFullLoaded) return;
    const body = sleepPreviewEl.querySelector('.terminal-sleep-preview-body');
    if (body && body.textContent !== text) body.textContent = text;
    return;
  }
  teardownSleepPreview();
  sleepPreviewSessionId = session.id;
  sleepPreviewMode = requestedMode;
  const isLossy = requestedMode === 'lossy';

  const el = document.createElement('div');
  el.className = 'terminal-sleep-preview';
  el.setAttribute('data-session-id', session.id);
  el.setAttribute('data-mode', requestedMode);
  el.tabIndex = 0;
  el.title = isLossy
    ? 'Bản ghi văn bản (lossy). Nhấn phím bất kỳ để quay lại terminal.'
    : 'Phiên đang ngủ. Transcript được giữ lại. Gõ phím để đánh thức.';

  const header = document.createElement('div');
  header.className = 'terminal-sleep-preview-header';
  const iconEl = document.createElement('span');
  iconEl.className = 'terminal-sleep-preview-icon';
  iconEl.innerHTML = iconSvg(isLossy ? ICON_LAYERS : ICON_MOON, 12);
  const badgeEl = document.createElement('span');
  badgeEl.className = 'terminal-sleep-preview-badge';
  badgeEl.textContent = isLossy ? 'Lossy' : 'Đang ngủ';
  const nameEl = document.createElement('span');
  nameEl.className = 'terminal-sleep-preview-name';
  nameEl.textContent = session.name || 'Terminal';
  const hintEl = document.createElement('span');
  hintEl.className = 'terminal-sleep-preview-hint';
  hintEl.textContent = isLossy
    ? (session.altScreen
      ? 'Đã lược bỏ mã điều khiển. TUI toàn màn hình không giữ scrollback — nhấn phím hoặc bấm tiêu đề để quay lại'
      : 'Bản ghi đã lược bỏ mã điều khiển — nhấn phím hoặc bấm tiêu đề để quay lại terminal')
    : 'PTY đã giải phóng. Gõ phím để đánh thức phiên này';
  header.append(iconEl, badgeEl, nameEl, hintEl);

  const body = document.createElement('pre');
  body.className = 'terminal-sleep-preview-body';
  body.textContent = text;

  el.append(header, body);
  if (isLossy) {
    el.addEventListener('keydown', (e) => {
      // Modified keys stay native so the selection can still be copied out.
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      e.preventDefault();
      closeTranscriptPreview();
    });
    // The header is the exit control; the body stays selectable for copying.
    header.addEventListener('click', () => closeTranscriptPreview());
  } else {
    registerWakeOnInput(el, session.id);
  }
  mainPane.appendChild(el);
  sleepPreviewEl = el;
  loadFullTranscriptInto(el, session.id, requestedMode, body);
}

/** Any first keystroke/paste on a sleeping surface wakes the session. */
function registerWakeOnInput(el, sessionId) {
  el.addEventListener('keydown', (e) => {
    if (!isSessionSleeping(sessionId)) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const key = typeof e.key === 'string' ? e.key : '';
    if (key.length !== 1) return;
    e.preventDefault();
    wakeSleepingSession(sessionId, key);
  });
  el.addEventListener('paste', (e) => {
    if (!isSessionSleeping(sessionId)) return;
    const text = e.clipboardData?.getData?.('text') || '';
    if (!text) return;
    e.preventDefault();
    wakeSleepingSession(sessionId, text);
  });
}

function getInitialSplitRows(term) {
  const parentRows = (term && typeof term.rows === 'number' && isFinite(term.rows) && term.rows > 0) ? term.rows : 30;
  return Math.max(MIN_SPLIT_TERMINAL_ROWS, Math.floor(parentRows * SPLIT_TERMINAL_FRACTION));
}

function scheduleFitTerminal(delay = 50) {
  requestAnimationFrame(() => {
    fitCurrentTerminal();
    if (delay > 0) {
      setTimeout(() => {
        fitCurrentTerminal();
      }, delay);
    }
  });
}
function writeClipboard(text) {
  if (!text) return;
  if (api?.copyToClipboard) {
    try { api.copyToClipboard(text); return; } catch {}
  }
  navigator.clipboard?.writeText?.(text).catch(() => {});
}

function readClipboard() {
  if (api?.readFromClipboard) {
    try { return api.readFromClipboard() || ''; } catch {}
  }
  return navigator.clipboard?.readText?.() || Promise.resolve('');
}

/**
 * Smart Newline Sanitizer & Classifier for Terminal Clipboard Pastes.
 * - If single line (or single line with trailing newlines): returns { isMultiline: false, text: trimmedEnd }
 *   -> Trailing newline is stripped so the command appears on the prompt without auto-submitting.
 * - If genuine multiline (2+ content lines): returns { isMultiline: true, text: rawText, lines }
 */
function sanitizePasteText(rawText) {
  if (typeof rawText !== 'string' || !rawText) {
    return { isMultiline: false, text: '', lines: [] };
  }
  // Strip trailing newlines (\r and \n)
  const trimmedEnd = rawText.replace(/[\r\n]+$/, '');
  const normalizedLines = trimmedEnd.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');

  if (normalizedLines.length <= 1) {
    return {
      isMultiline: false,
      text: trimmedEnd,
      lines: [trimmedEnd],
    };
  }

  return {
    isMultiline: true,
    text: rawText,
    lines: normalizedLines,
  };
}

let activePasteModalCleanup = null;

/**
 * Renders the accessible Multiline Paste Confirmation Modal.
 * Prompts the user before writing multiline content into PTY.
 */
function showMultilinePasteModal(rawText, lines, sendInput, targetTerm) {
  // If an active paste modal is already open, close it first
  if (typeof activePasteModalCleanup === 'function') {
    try { activePasteModalCleanup(); } catch {}
  }

  let backdrop = document.getElementById('multilinePasteBackdrop');
  if (!backdrop) {
    backdrop = document.createElement('div');
    backdrop.id = 'multilinePasteBackdrop';
    backdrop.className = 'multiline-paste-backdrop';
    document.body.appendChild(backdrop);
  }

  const lineCount = lines.length;
  const previewMax = 6;
  const displayLines = lines.slice(0, previewMax);
  const remainingCount = lineCount - previewMax;

  const previewHtml = displayLines.map((line, idx) => {
    const escaped = line
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
    return `<div><span class="line-num">${idx + 1}</span>${escaped}</div>`;
  }).join('');

  const moreHintHtml = remainingCount > 0
    ? `<div class="more-hint">+ ${remainingCount} dòng khác...</div>`
    : '';

  backdrop.innerHTML = `
    <div class="multiline-paste-modal" role="dialog" aria-modal="true" aria-labelledby="pasteModalTitle">
      <div class="multiline-paste-header">
        <div class="multiline-paste-icon">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
            <line x1="12" y1="9" x2="12" y2="13"/>
            <line x1="12" y1="17" x2="12.01" y2="17"/>
          </svg>
        </div>
        <div class="multiline-paste-title-group">
          <h3 id="pasteModalTitle" class="multiline-paste-title">Xác nhận dán nhiều dòng lệnh</h3>
          <p class="multiline-paste-desc">Clipboard chứa <strong>${lineCount}</strong> dòng văn bản. Việc dán trực tiếp có thể tự động kích hoạt thực thi các lệnh trong terminal.</p>
        </div>
      </div>
      <div class="multiline-paste-preview">${previewHtml}${moreHintHtml}</div>
      <div class="multiline-paste-actions">
        <button id="btnPasteCancel" type="button" class="multiline-paste-btn tertiary">Hủy (Esc)</button>
        <button id="btnPasteSingleLine" type="button" class="multiline-paste-btn secondary">Gộp thành 1 dòng</button>
        <button id="btnPasteMultiLine" type="button" class="multiline-paste-btn primary">Dán nhiều dòng (Enter)</button>
      </div>
    </div>
  `;

  backdrop.classList.add('active');

  const btnCancel = backdrop.querySelector('#btnPasteCancel');
  const btnSingle = backdrop.querySelector('#btnPasteSingleLine');
  const btnMulti = backdrop.querySelector('#btnPasteMultiLine');

  btnMulti?.focus();

  const closeModal = () => {
    backdrop.classList.remove('active');
    backdrop.innerHTML = '';
    window.removeEventListener('keydown', onKeyTrap, true);
    backdrop.removeEventListener('click', onBackdropClick);
    activePasteModalCleanup = null;
    try { targetTerm?.focus?.(); } catch {}
  };

  activePasteModalCleanup = closeModal;

  const onBackdropClick = (e) => {
    if (e.target === backdrop) {
      closeModal();
    }
  };

  const onKeyTrap = (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      closeModal();
      return;
    }
    if (e.key === 'Enter') {
      if (document.activeElement === btnSingle || document.activeElement === btnCancel) {
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      btnMulti?.click();
      return;
    }
    if (e.key === 'Tab') {
      const focusable = [btnMulti, btnSingle, btnCancel].filter(Boolean);
      const currentIndex = focusable.indexOf(document.activeElement);
      if (e.shiftKey) {
        if (currentIndex <= 0) {
          e.preventDefault();
          focusable[focusable.length - 1]?.focus();
        }
      } else {
        if (currentIndex === focusable.length - 1) {
          e.preventDefault();
          focusable[0]?.focus();
        }
      }
    }
  };

  window.addEventListener('keydown', onKeyTrap, true);
  backdrop.addEventListener('click', onBackdropClick);

  btnCancel?.addEventListener('click', () => {
    closeModal();
  });

  btnSingle?.addEventListener('click', () => {
    // Join commands with safe semicolon separator, ignoring comments & empty lines
    const joined = lines
      .map(l => l.trim())
      .filter(Boolean)
      .join('; ');
    closeModal();
    if (joined) {
      sendInput(joined);
    }
  });

  btnMulti?.addEventListener('click', () => {
    closeModal();
    sendInput(rawText);
  });
}

/**
 * Unified Ingress for all terminal paste channels.
 */
function dispatchSafePaste(rawText, sendInput, targetTerm) {
  if (!rawText) return;
  const classified = sanitizePasteText(rawText);
  if (classified.isMultiline) {
    showMultilinePasteModal(classified.text, classified.lines, sendInput, targetTerm);
  } else {
    sendInput(classified.text);
  }
}

async function handleTerminalPaste(sendInput, targetTerm) {
  // 1. Read text directly from clipboard
  const res = readClipboard();
  if (typeof res === 'string' && res) {
    dispatchSafePaste(res, sendInput, targetTerm);
    return true;
  } else if (res && typeof res.then === 'function') {
    try {
      const text = await res;
      if (text) {
        dispatchSafePaste(text, sendInput, targetTerm);
        return true;
      }
    } catch {}
  }

  // 2. If no text, check if clipboard has an image
  if (api?.pasteImageFromClipboard) {
    try {
      const imgRes = await api.pasteImageFromClipboard();
      if (imgRes && imgRes.ok && imgRes.imagePath) {
        sendInput(imgRes.imagePath);
        return true;
      }
    } catch {}
  }
  return false;
}

function setupTerminalClipboard(targetTerm, getSessionId) {
  if (!targetTerm) return;

  let lastPasteTimestamp = 0;
  let lastPastedText = '';

  const sendInput = (text) => {
    if (!text) return;
    const now = Date.now();
    // Guard against duplicate paste triggers occurring within 200ms
    if (text === lastPastedText && now - lastPasteTimestamp < 200) {
      return;
    }
    lastPasteTimestamp = now;
    lastPastedText = text;

    const sid = getSessionId ? getSessionId() : activeId;
    if (sid) api?.sendTerminalInputTo(sid, text);
    else api?.sendTerminalInput(text);
  };

  targetTerm.attachCustomKeyEventHandler((e) => {
    // Pass Alt key without browser menu interference or unwanted scrolling
    if (e.key === 'Alt' || e.keyCode === 18) {
      return true;
    }
    if (e.type !== 'keydown') return true;
    // If text is selected -> Copy to clipboard and PREVENT sending SIGINT (\x03)
    // If no text selected -> Pass through so it sends SIGINT (\x03) to break/cancel command
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && (e.key === 'c' || e.key === 'C')) {
      if (targetTerm.hasSelection()) {
        e.preventDefault();
        e.stopPropagation();
        const selected = targetTerm.getSelection();
        if (selected) {
          writeClipboard(selected);
        }
        return false; // Prevent sending SIGINT (\x03)
      }
      return true; // Send SIGINT when no selection
    }

    // Ctrl+Shift+C: Explicit copy selection
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && !e.altKey && (e.key === 'c' || e.key === 'C')) {
      e.preventDefault();
      e.stopPropagation();
      if (targetTerm.hasSelection()) {
        const selected = targetTerm.getSelection();
        if (selected) {
          writeClipboard(selected);
        }
      }
      return false;
    }

    // Ctrl+V / Cmd+V / Ctrl+Shift+V: Paste from clipboard (Text or Image)
    if ((e.ctrlKey || e.metaKey) && !e.altKey && (e.key === 'v' || e.key === 'V')) {
      e.preventDefault();
      e.stopPropagation();
      handleTerminalPaste(sendInput, targetTerm);
      return false;
    }

    // Ctrl+A / Cmd+A: Select all text in terminal
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && (e.key === 'a' || e.key === 'A')) {
      e.preventDefault();
      e.stopPropagation();
      targetTerm.selectAll();
      return false;
    }

    // F11: Fullscreen Toggle
    if (e.key === 'F11') {
      e.preventDefault();
      e.stopPropagation();
      api?.toggleFullScreen?.();
      return false;
    }

    // Ctrl+Shift+N: New Window
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === 'n' || e.key === 'N')) {
      e.preventDefault();
      e.stopPropagation();
      api?.openNewTerminalWindow?.(activeId);
      return false;
    }

    // Ctrl+K / Cmd+K: Clear scrollback buffer (shrink the tall scroll area back to the viewport)
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && (e.key === 'k' || e.key === 'K')) {
      e.preventDefault();
      e.stopPropagation();
      try { targetTerm.clear(); } catch {}
      return false;
    }

    // Ctrl+Shift+D / Alt+Shift+D / Ctrl+\: Toggle terminal split
    if (((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === 'd' || e.key === 'D')) ||
        (e.altKey && e.shiftKey && (e.key === 'd' || e.key === 'D')) ||
        ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key === '\\')) {
      e.preventDefault();
      e.stopPropagation();
      splitButton?.click();
      return false;
    }

    // Alt+Up / Ctrl+Alt+Up: Focus Main Pane
    if ((e.altKey && (e.key === 'ArrowUp' || e.key === 'Up')) ||
        ((e.ctrlKey || e.metaKey) && e.altKey && (e.key === 'ArrowUp' || e.key === 'Up'))) {
      e.preventDefault();
      e.stopPropagation();
      focusMainPane();
      return false;
    }

    // Alt+Down / Ctrl+Alt+Down: Focus Split Pane (if split is open)
    if ((e.altKey && (e.key === 'ArrowDown' || e.key === 'Down')) ||
        ((e.ctrlKey || e.metaKey) && e.altKey && (e.key === 'ArrowDown' || e.key === 'Down'))) {
      if (splitEnabled && splitTerm) {
        e.preventDefault();
        e.stopPropagation();
        focusSplitPane();
        return false;
      }
    }

    return true;
  });

  // DOM Event: Copy (e.g. from browser edit menu or accelerator)
  targetTerm.element?.addEventListener('copy', (e) => {
    const selected = targetTerm.getSelection();
    if (selected) {
      writeClipboard(selected);
      e.clipboardData?.setData('text/plain', selected);
      e.preventDefault();
    }
  });

  // DOM Event: Paste (e.g. from browser edit menu, middle-click, or accelerator)
  targetTerm.element?.addEventListener('paste', (e) => {
    e.preventDefault();
    e.stopPropagation();
    const text = e.clipboardData?.getData('text/plain');
    if (typeof text === 'string' && text) {
      dispatchSafePaste(text, sendInput, targetTerm);
      return;
    }

    handleTerminalPaste(sendInput, targetTerm);
  });

  // Right-Click Context Menu / Mouse Action (Windows Terminal / PowerShell standard)
  targetTerm.element?.addEventListener('contextmenu', async (e) => {
    e.preventDefault();
    e.stopPropagation();

    // If text is selected, right click COPIES and clears selection
    if (targetTerm.hasSelection()) {
      const selected = targetTerm.getSelection();
      if (selected) {
        writeClipboard(selected);
        targetTerm.clearSelection();
      }
    } else {
      // If no text selected, right click PASTES clipboard (Text or Image)
      handleTerminalPaste(sendInput, targetTerm);
    }
  });
}

const rawTerminalPool = new Map(); // id -> item
const terminalPool = {
  get(id) {
    let item = rawTerminalPool.get(id);
    if (!item && typeof id === 'string' && Array.isArray(sessions)) {
      const s = sessions.find((x) => x.id === id);
      // A sleeping session has no PTY: materializing an xterm here would undo
      // the entire zero-cost guarantee, so this chokepoint refuses. Callers
      // already tolerate `undefined`.
      if (s && s.state !== 'sleeping') {
        item = getOrCreateTerminalPane(id, typeof s.buffer === 'string' ? s.buffer : '', s.snapshotThroughSeq || 0, true);
      }
    }
    return item;
  },
  set(id, val) { return rawTerminalPool.set(id, val); },
  has(id) { return rawTerminalPool.has(id); },
  delete(id) { return rawTerminalPool.delete(id); },
  clear() { return rawTerminalPool.clear(); },
  entries() { return rawTerminalPool.entries(); },
  values() { return rawTerminalPool.values(); },
  keys() { return rawTerminalPool.keys(); },
  forEach(cb, thisArg) { return rawTerminalPool.forEach(cb, thisArg); },
  get size() { return rawTerminalPool.size; },
  [Symbol.iterator]() { return rawTerminalPool[Symbol.iterator](); },
};
if (typeof window !== 'undefined') {
  window.__antifanSanitizePasteText = sanitizePasteText;
  window.__antifanDispatchSafePaste = dispatchSafePaste;
  window.__antifanShowMultilinePasteModal = showMultilinePasteModal;
}
window.__antifanTerminalPool = terminalPool;
const rendererInstanceId = (typeof crypto !== 'undefined' && crypto.randomUUID) ? crypto.randomUUID() : `renderer-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
window.__antifanRendererInstanceId = rendererInstanceId;
window.__antifanTerminalHealth = function getTerminalHealthSnapshot() {
  const views = [];
  for (const [id, item] of terminalPool.entries()) {
    const s = Array.isArray(sessions) ? sessions.find((x) => x.id === id) : null;
    views.push({
      sessionId: id,
      generation: s?.sessionGeneration || 0,
      lastRenderedSeq: item.lastRenderedSeq || 0,
      lastAckedSeq: item.lastAckedSeq || item.lastRenderedSeq || 0,
      gapCount: item.gapCount || 0,
      resyncCount: item.resyncCount || 0,
      degradedCount: item.degradedCount || 0,
      recoveryQueueBytes: (item.liveQueue || []).reduce((acc, c) => acc + (c.data ? c.data.length : 0), 0),
      recoveryQueueChunks: (item.liveQueue || []).length,
      health: item.syncState === 'READY' ? 'SYNCED' : (item.syncState || 'SYNCED'),
      authority: {
        inputOwner: id === activeId && !splitEnabled,
        geometryOwner: id === activeId && !splitEnabled,
      },
    });
  }
  if (splitEnabled && splitId) {
    const s = Array.isArray(sessions) ? sessions.find((x) => x.id === splitId) : null;
    views.push({
      sessionId: splitId,
      generation: s?.sessionGeneration || 0,
      lastRenderedSeq: splitSessionState.lastRenderedSeq || 0,
      lastAckedSeq: splitSessionState.lastAckedSeq || splitSessionState.lastRenderedSeq || 0,
      gapCount: splitSessionState.gapCount || 0,
      resyncCount: splitSessionState.resyncCount || 0,
      degradedCount: splitSessionState.degradedCount || 0,
      recoveryQueueBytes: (splitSessionState.liveQueue || []).reduce((acc, c) => acc + (c.data ? c.data.length : 0), 0),
      recoveryQueueChunks: (splitSessionState.liveQueue || []).length,
      health: splitSessionState.syncState === 'READY' ? 'SYNCED' : (splitSessionState.syncState || 'SYNCED'),
      authority: {
        inputOwner: document.getElementById('terminal-split')?.classList.contains('focused-pane') || false,
        geometryOwner: true,
      },
    });
  }
  return {
    rendererInstanceId,
    timestamp: Date.now(),
    views,
  };
};
let splitEnabled = false;
let splitId = '';
let splitTerm = null;
let splitFitAddon = null;
let splitWebglAddon = null;
let splitWebLinksAddon = null;
let splitWriteTarget = null;
let isSplitUserScrolledUp = false;
let isSplitProgrammaticScroll = false;
let resizeDebounceTimer = null;
const sessionSplitRatios = new Map();

function focusSplitPane() {
  const lower = document.getElementById('terminal-split');
  if (lower) lower.classList.add('focused-pane');
  mainPane.classList.remove('focused-pane');
  document.querySelectorAll('.terminal-session-pane').forEach((p) => p.classList.remove('focused-pane'));
  try { splitTerm?.focus(); } catch {}
}

function focusMainPane() {
  const lower = document.getElementById('terminal-split');
  if (lower) lower.classList.remove('focused-pane');
  mainPane.classList.add('focused-pane');
  // A sleeping active tab has no pane; its read-only preview is the focus target
  // so the next keystroke is the wake gesture.
  if (sleepPreviewEl && isSessionSleeping(activeId)) {
    try { sleepPreviewEl.focus(); } catch {}
    return;
  }
  const activeItem = terminalPool.get(activeId);
  if (activeItem) {
    activeItem.paneEl.classList.add('focused-pane');
    try { activeItem.term.focus(); } catch {}
  }
}

const MAX_RECOVERY_QUEUE_BYTES = 1024 * 1024; // 1 MiB hard bound
const MAX_RECOVERY_QUEUE_CHUNKS = 2048; // 2,048 chunks hard bound
const coalescedAckMap = new Map();

function scheduleCoalescedAck(sessionId, generation, seq, role) {
  if (!sessionId || typeof seq !== 'number' || seq <= 0) return;
  const currentRole = role || (isPopoutMode ? 'POPOUT' : 'DOCK');
  let state = coalescedAckMap.get(sessionId);
  if (!state) {
    state = {
      pendingSeq: seq,
      generation: typeof generation === 'number' ? generation : 0,
      role: currentRole,
      unackedCount: 0,
      lastFlushTime: 0,
      timer: null,
    };
    coalescedAckMap.set(sessionId, state);
  }

  if (seq > state.pendingSeq) {
    state.pendingSeq = seq;
  }
  if (typeof generation === 'number' && generation > state.generation) {
    state.generation = generation;
  }
  state.role = currentRole;
  state.unackedCount++;

  const flush = () => {
    if (state.timer) {
      clearTimeout(state.timer);
      state.timer = null;
    }
    const rId = window.__antifanRendererInstanceId || 'unknown';
    try {
      api?.ackTerminalChunk?.({
        rendererInstanceId: rId,
        sessionId,
        generation: state.generation,
        seq: state.pendingSeq,
        role: state.role,
      });
    } catch {}
    state.unackedCount = 0;
    state.lastFlushTime = Date.now();
  };

  const now = Date.now();
  if (state.unackedCount >= 64 || (state.lastFlushTime > 0 && now - state.lastFlushTime >= 50)) {
    flush();
  } else if (!state.timer) {
    state.timer = setTimeout(flush, 50);
  }
}

function showDegradedBanner(viewState, sessionId) {
  if (!viewState || !viewState.paneEl) return;
  let banner = viewState.paneEl.querySelector('.terminal-degraded-banner');
  if (!banner) {
    banner = document.createElement('div');
    banner.className = 'terminal-degraded-banner';
    banner.style.cssText = 'position:absolute;top:0;left:0;right:0;background:#451a03;color:#fbbf24;border-bottom:1px solid #b45309;padding:6px 12px;font-size:12px;font-family:sans-serif;z-index:100;display:flex;align-items:center;justify-content:space-between;cursor:pointer;';
    banner.innerHTML = '<span>⚠️ Terminal Display Out of Sync. Process is Active</span><button style="background:#b45309;color:#fff;border:none;padding:2px 8px;border-radius:4px;cursor:pointer;font-size:11px;">Resync View</button>';
    banner.addEventListener('click', async (e) => {
      e.stopPropagation();
      await forceResyncPane(viewState, sessionId);
    });
    viewState.paneEl.appendChild(banner);
  }
}

function hideDegradedBanner(viewState) {
  if (!viewState || !viewState.paneEl) return;
  const banner = viewState.paneEl.querySelector('.terminal-degraded-banner');
  if (banner) {
    banner.remove();
  }
}

async function forceResyncPane(viewState, sessionId) {
  try {
    const fullBuffer = await api?.getFullBuffer?.(sessionId);
    if (viewState.term) {
      viewState.term.reset();
      if (fullBuffer) {
        const bufText = sliceHydrationTail(typeof fullBuffer === 'string' ? fullBuffer : (fullBuffer?.buffer || ''));
        if (bufText) await writeTermAsync(viewState.term, bufText);
      }
    }
    if (fullBuffer && typeof fullBuffer.snapshotThroughSeq === 'number') {
      viewState.lastRenderedSeq = fullBuffer.snapshotThroughSeq;
      viewState.pendingWriteAckSeq = fullBuffer.snapshotThroughSeq;
    }
    viewState.syncState = 'READY';
    viewState.liveQueue = [];
    hideDegradedBanner(viewState);
  } catch {}
}

const splitSessionState = {
  id: '',
  lastRenderedSeq: 0,
  sessionGeneration: 0,
  hydrationEpoch: 0,
  activeHydratingEpoch: null,
  liveQueue: [],
  syncState: 'READY',
  isFetchingDelta: false,
  pendingWriteAckSeq: 0,
  lastAckedSeq: 0,
  gapCount: 0,
  resyncCount: 0,
  degradedCount: 0,
};

function writeChunk(viewState, chunkData, isSplit) {
  if (isSplit) {
    writeToSplitPane(chunkData);
  } else {
    writeToTerminalPane(viewState, chunkData);
  }
}

async function processIncomingChunk(viewState, chunk, isSplit) {
  const chunkSeq = typeof chunk.seq === 'number' ? chunk.seq : 0;
  const chunkGen = typeof chunk.generation === 'number' ? chunk.generation : 0;
  const chunkData = chunk.data || '';

  // Coalesced batch envelope: the main-process coalescer merges contiguous
  // chunks into one payload carrying {fromSeq, throughSeq} (seq aliases
  // throughSeq). Treat it as ONE contiguous batch — running the per-chunk gap
  // check on it is exactly the resync storm the envelope exists to prevent.
  const batchFrom = (typeof chunk.fromSeq === 'number' && chunk.fromSeq > 0) ? chunk.fromSeq : 0;
  const batchThrough = (typeof chunk.throughSeq === 'number' && chunk.throughSeq > 0) ? chunk.throughSeq : 0;

  if (chunkGen > 0) {
    if (viewState.sessionGeneration > 0 && chunkGen !== viewState.sessionGeneration) {
      // Generational leap: the PTY for this session id was respawned and the main
      // process transcript restarts empty (respawn passes no restored buffer), so
      // the rendered history belongs to a process that no longer exists. Clear the
      // pane instead of appending the new shell's banner under stale output.
      viewState.sessionGeneration = chunkGen;
      viewState.lastRenderedSeq = 0;
      viewState.syncState = 'READY';
      viewState.liveQueue = [];
      try {
        if (isSplit) {
          if (splitTerm) splitTerm.reset();
        } else if (viewState.term) {
          viewState.term.reset();
        }
      } catch {}
      hideDegradedBanner(viewState);
    } else {
      viewState.sessionGeneration = chunkGen;
    }
  }

  if (viewState.activeHydratingEpoch !== null) {
    viewState.liveQueue.push({
      seq: chunkSeq,
      fromSeq: batchFrom || chunkSeq,
      throughSeq: batchThrough || chunkSeq,
      generation: chunkGen,
      data: chunkData,
      epoch: viewState.hydrationEpoch,
    });
    return;
  }

  if (viewState.syncState === 'DEGRADED') {
    return;
  }

  if (chunkSeq > 0 && chunkSeq <= viewState.lastRenderedSeq) {
    return; // Dedup (covers batchThrough <= lastRenderedSeq since seq === throughSeq)
  }

  if (batchFrom > 0 && batchThrough >= batchFrom) {
    if (batchFrom <= viewState.lastRenderedSeq + 1 && viewState.lastRenderedSeq + 1 <= batchThrough) {
      // Contiguous (or overlapping) continuation: advance straight to throughSeq.
      viewState.lastRenderedSeq = batchThrough;
      viewState.pendingWriteAckSeq = batchThrough;
      writeChunk(viewState, chunkData, isSplit);
      return;
    }
    // batchFrom > lastRenderedSeq + 1: genuine gap -> recovery below.
  } else if (chunkSeq === viewState.lastRenderedSeq + 1 || (viewState.lastRenderedSeq === 0 && chunkSeq === 1)) {
    viewState.lastRenderedSeq = chunkSeq;
    viewState.pendingWriteAckSeq = chunkSeq;
    writeChunk(viewState, chunkData, isSplit);
    return;
  }

  // Sequence gap detected: chunkSeq > viewState.lastRenderedSeq + 1
  await handleSequenceGap(viewState, chunk, isSplit);
}

// Effective seq range of a queued/live chunk: coalesced batches carry
// {fromSeq, throughSeq}; legacy single chunks only carry seq.
function chunkStartSeq(entry) {
  return (entry && typeof entry.fromSeq === 'number' && entry.fromSeq > 0) ? entry.fromSeq : (entry ? entry.seq : 0);
}
function chunkEndSeq(entry) {
  return (entry && typeof entry.throughSeq === 'number' && entry.throughSeq > 0) ? entry.throughSeq : (entry ? entry.seq : 0);
}

async function handleSequenceGap(viewState, chunk, isSplit) {
  viewState.gapCount = (viewState.gapCount || 0) + 1;
  const chunkBytes = (chunk && chunk.data ? chunk.data.length : 0);
  const currentQueueBytes = viewState.liveQueue.reduce((acc, c) => acc + (c.data ? c.data.length : 0), 0);

  if (
    currentQueueBytes + chunkBytes > MAX_RECOVERY_QUEUE_BYTES ||
    viewState.liveQueue.length >= MAX_RECOVERY_QUEUE_CHUNKS
  ) {
    viewState.syncState = 'DEGRADED';
    viewState.degradedCount = (viewState.degradedCount || 0) + 1;
    viewState.liveQueue = [];
    showDegradedBanner(viewState, viewState.id || (isSplit ? splitId : activeId));
    return;
  }

  if (chunk && !viewState.liveQueue.some((c) => c.seq === chunk.seq)) {
    viewState.liveQueue.push(chunk);
  }
  if (viewState.isFetchingDelta) {
    return; // Single-flight delta fetch
  }

  viewState.isFetchingDelta = true;
  viewState.syncState = 'GAPPED';

  const targetSessionId = viewState.id || (isSplit ? splitId : activeId);
  const fromSeq = viewState.lastRenderedSeq + 1;

  try {
    const deltaResult = await api?.getTerminalDelta?.(targetSessionId, viewState.sessionGeneration || 0, fromSeq);
    if (!deltaResult) {
      viewState.syncState = 'READY';
      while (viewState.liveQueue.length > 0) {
        const item = viewState.liveQueue.shift();
        if (item) {
          const end = chunkEndSeq(item);
          viewState.lastRenderedSeq = end;
          viewState.pendingWriteAckSeq = end;
          writeChunk(viewState, item.data, isSplit);
        }
      }
      return;
    }

    if (deltaResult.status === 'GENERATION_MISMATCH') {
      if (deltaResult.currentGeneration) {
        viewState.sessionGeneration = deltaResult.currentGeneration;
      }
      viewState.lastRenderedSeq = 0;
      viewState.syncState = 'READY';
      viewState.liveQueue = [];
      return;
    }

    if (deltaResult.status === 'DELTA_EXPIRED') {
      viewState.syncState = 'DEGRADED';
      viewState.degradedCount = (viewState.degradedCount || 0) + 1;
      viewState.liveQueue = [];
      showDegradedBanner(viewState, targetSessionId);
      return;
    }

    if (deltaResult.status === 'OK') {
      viewState.syncState = 'RESYNCING';
      if (Array.isArray(deltaResult.chunks)) {
        for (const deltaChunk of deltaResult.chunks) {
          if (deltaChunk.seq === viewState.lastRenderedSeq + 1) {
            viewState.lastRenderedSeq = deltaChunk.seq;
            viewState.pendingWriteAckSeq = deltaChunk.seq;
            writeChunk(viewState, deltaChunk.data, isSplit);
          }
        }
      }

      // Drain buffered liveQueue
      viewState.liveQueue.sort((a, b) => chunkStartSeq(a) - chunkStartSeq(b));
      while (viewState.liveQueue.length > 0) {
        const next = viewState.liveQueue[0];
        const nextStart = chunkStartSeq(next);
        const nextEnd = chunkEndSeq(next);
        if (nextEnd <= viewState.lastRenderedSeq) {
          viewState.liveQueue.shift();
        } else if (nextStart <= viewState.lastRenderedSeq + 1) {
          viewState.liveQueue.shift();
          viewState.lastRenderedSeq = nextEnd;
          viewState.pendingWriteAckSeq = nextEnd;
          writeChunk(viewState, next.data, isSplit);
        } else {
          break;
        }
      }

      if (viewState.liveQueue.length === 0) {
        viewState.syncState = 'READY';
        viewState.resyncCount = (viewState.resyncCount || 0) + 1;
      }
    }
  } catch (err) {
  } finally {
    viewState.isFetchingDelta = false;
    if (viewState.liveQueue.length > 0 && viewState.syncState !== 'DEGRADED') {
      const nextHead = viewState.liveQueue[0];
      if (nextHead && chunkStartSeq(nextHead) > viewState.lastRenderedSeq + 1) {
        setTimeout(() => {
          handleSequenceGap(viewState, null, isSplit);
        }, 20);
      }
    }
  }
}

async function syncPaneWithBackend(item, sessionId) {
  if (!item || !sessionId) return;
  try {
    const res = await api?.syncTerminalView?.({
      sessionId,
      knownGeneration: item.sessionGeneration || 0,
      lastAppliedSeq: item.lastRenderedSeq || 0,
    });
    if (!res) return;

    if (res.status === 'UP_TO_DATE') {
      item.syncState = 'READY';
      hideDegradedBanner(item);
    } else if (res.status === 'DELTA') {
      item.syncState = 'RESYNCING';
      if (Array.isArray(res.chunks)) {
        for (const c of res.chunks) {
          if (c.seq === item.lastRenderedSeq + 1) {
            item.lastRenderedSeq = c.seq;
            item.pendingWriteAckSeq = c.seq;
            writeToTerminalPane(item, c.data);
          }
        }
      }
      item.syncState = 'READY';
      hideDegradedBanner(item);
    } else if (res.status === 'DELTA_EXPIRED') {
      item.syncState = 'DEGRADED';
      item.degradedCount = (item.degradedCount || 0) + 1;
      showDegradedBanner(item, sessionId);
    } else if (res.status === 'GENERATION_CHANGED') {
      item.sessionGeneration = res.currentGeneration;
      item.lastRenderedSeq = 0;
      item.syncState = 'READY';
      hideDegradedBanner(item);
    }
  } catch {}
}

function writeTermAsync(term, data) {
  return new Promise((resolve) => {
    try {
      term.write(data, () => resolve());
    } catch {
      resolve();
    }
  });
}

// Session-state payloads only carry a JSON-budgeted *suffix* of each transcript
// (GLOBAL_JSON_BUFFER_BUDGET_BYTES in the main process: ~16 KiB for the active
// session, less for background ones), and the slice can start inside an escape
// sequence. Hydrating from that slice alone silently drops everything older than
// the last few hundred lines. The main process still owns the full retained
// transcript, so hydrate from getFullBuffer and keep the wired slice only as a
// fallback for callers whose backend cannot serve it.
// xterm retains 10k lines of scrollback on both panes. Writing a
// multi-megabyte transcript into a fresh pane only burns renderer parse frames on history
// the scrollback discards anyway, so hydration writes a trailing window aligned to a line
// boundary. The main process still owns the full transcript for delta recovery.
const MAX_HYDRATION_WRITE_CHARS = 256 * 1024;
function sliceHydrationTail(snapshot) {
  if (!snapshot || snapshot.length <= MAX_HYDRATION_WRITE_CHARS) return snapshot || '';
  let raw = snapshot.slice(-MAX_HYDRATION_WRITE_CHARS);
  if (raw.charCodeAt(0) >= 0xdc00 && raw.charCodeAt(0) <= 0xdfff) raw = raw.slice(1);
  const firstNl = raw.indexOf('\n');
  if (firstNl !== -1 && firstNl < 4096) raw = raw.slice(firstNl + 1);
  return `\x1b[0m${raw}`;
}

async function resolveHydrationSnapshot(sessionId, providedSnapshot, providedSeq) {
  if (api?.getFullBuffer) {
    try {
      const res = await api.getFullBuffer(sessionId);
      if (res && typeof res.buffer === 'string') {
        return { snapshot: sliceHydrationTail(res.buffer), snapshotSeq: res.snapshotThroughSeq || 0 };
      }
    } catch {}
  }
  return { snapshot: providedSnapshot || '', snapshotSeq: providedSeq || 0 };
}

async function atomicHydratePane(item, sessionId, providedSnapshot, providedSeq) {
  if (!item || !item.term || item.released) return;
  item.hydrationEpoch += 1;
  const currentEpoch = item.hydrationEpoch;
  item.activeHydratingEpoch = currentEpoch;

  try {
    const { snapshot, snapshotSeq } = await resolveHydrationSnapshot(sessionId, providedSnapshot, providedSeq);

    if (item.released || item.hydrationEpoch !== currentEpoch) return;

    try {
      if (item.writeTarget && window.globalTerminalWriteDispatcher) {
        window.globalTerminalWriteDispatcher.cancel(item.writeTarget);
      }
    } catch {}

    // Ensure terminal is sized to its container before resetting and writing snapshot
    try {
      const propose = item.fit?.proposeDimensions?.();
      if (propose && propose.cols >= MIN_TERMINAL_COLS && propose.rows >= MIN_TERMINAL_ROWS && item.paneEl && item.paneEl.clientWidth > 100) {
        if (item.term.cols !== propose.cols || item.term.rows !== propose.rows) {
          item.term.resize(propose.cols, propose.rows);
          api?.resizeTerminalTo(sessionId, propose.cols, propose.rows);
        }
      }
    } catch {}

    item.term.reset();
    if (snapshot && snapshot.length > 0) {
      await writeTermAsync(item.term, snapshot);
    }
    item.lastRenderedSeq = snapshotSeq || 0;

    while (item.liveQueue.length > 0) {
      if (item.released || item.hydrationEpoch !== currentEpoch) return;
      const batch = item.liveQueue.splice(0, item.liveQueue.length);
      const pending = batch
        .filter((entry) => entry.epoch === currentEpoch && chunkEndSeq(entry) > item.lastRenderedSeq)
        .sort((a, b) => chunkStartSeq(a) - chunkStartSeq(b));

      // Replay contiguous runs as one write each: the coalescer already orders
      // entries, so per-entry writes only multiply xterm parser ticks.
      let runData = '';
      let runEnd = 0;
      const flushRun = async () => {
        if (!runData) return;
        await writeTermAsync(item.term, runData);
        item.lastRenderedSeq = runEnd;
        runData = '';
      };
      for (const entry of pending) {
        const start = chunkStartSeq(entry);
        const end = chunkEndSeq(entry);
        if (runData && start > runEnd + 1) {
          await flushRun();
        }
        runData += entry.data;
        runEnd = end;
      }
      await flushRun();
    }

    if (item.isUserScrolledUp) {
      // Rehydration resets the buffer and rewrites the snapshot, which lands the viewport on the
      // live edge; the reader's line was recorded when the pane lost focus, so put it back.
      restoreSavedViewport(item);
    } else if (!item.released && item.paneEl && item.paneEl.classList.contains('active') && viewportAtBottom(item.term)) {
      item.term.scrollToBottom();
    }
  } finally {
    if (item.hydrationEpoch === currentEpoch) {
      item.activeHydratingEpoch = null;
    }
  }
}

async function atomicHydrateSplitPane(splitSessionId, providedSnapshot, providedSeq) {
  if (!splitTerm || !splitSessionId) return;
  splitSessionState.id = splitSessionId;
  splitSessionState.hydrationEpoch += 1;
  const currentEpoch = splitSessionState.hydrationEpoch;
  splitSessionState.activeHydratingEpoch = currentEpoch;

  try {
    const { snapshot, snapshotSeq } = await resolveHydrationSnapshot(splitSessionId, providedSnapshot, providedSeq);

    if (splitSessionState.hydrationEpoch !== currentEpoch) return;

    try {
      if (splitWriteTarget && window.globalTerminalWriteDispatcher) {
        window.globalTerminalWriteDispatcher.cancel(splitWriteTarget);
      }
    } catch {}

    // Ensure split terminal is sized to its container before resetting and writing snapshot
    try {
      const propose = splitFitAddon?.proposeDimensions?.();
      const splitHost = document.getElementById('terminal-split-host');
      if (propose && propose.cols >= MIN_TERMINAL_COLS && propose.rows >= MIN_TERMINAL_ROWS && splitHost && splitHost.clientWidth > 100) {
        if (splitTerm.cols !== propose.cols || splitTerm.rows !== propose.rows) {
          splitTerm.resize(propose.cols, propose.rows);
          api?.resizeTerminalTo(splitSessionId, propose.cols, propose.rows);
        }
      }
    } catch {}

    splitTerm.reset();
    if (snapshot && snapshot.length > 0) {
      await writeTermAsync(splitTerm, snapshot);
    }
    splitSessionState.lastRenderedSeq = snapshotSeq || 0;

    while (splitSessionState.liveQueue.length > 0) {
      if (splitSessionState.hydrationEpoch !== currentEpoch) return;
      const batch = splitSessionState.liveQueue.splice(0, splitSessionState.liveQueue.length);
      const pending = batch
        .filter((entry) => entry.epoch === currentEpoch && chunkEndSeq(entry) > splitSessionState.lastRenderedSeq)
        .sort((a, b) => chunkStartSeq(a) - chunkStartSeq(b));

      // Same contiguous-run collapse as the main pane replay.
      let runData = '';
      let runEnd = 0;
      const flushRun = async () => {
        if (!runData) return;
        await writeTermAsync(splitTerm, runData);
        splitSessionState.lastRenderedSeq = runEnd;
        runData = '';
      };
      for (const entry of pending) {
        const start = chunkStartSeq(entry);
        const end = chunkEndSeq(entry);
        if (runData && start > runEnd + 1) {
          await flushRun();
        }
        runData += entry.data;
        runEnd = end;
      }
      await flushRun();
    }

    if (!splitTerm || splitSessionState.hydrationEpoch !== currentEpoch) return;
    if (!isSplitUserScrolledUp && viewportAtBottom(splitTerm)) {
      splitTerm.scrollToBottom();
    }
  } finally {
    if (splitSessionState.hydrationEpoch === currentEpoch) {
      splitSessionState.activeHydratingEpoch = null;
    }
  }
}
function attachWebglAddon(_term) {
  // Use standard high-performance DOM/Canvas renderer to avoid WebGL context loss and texture corruption across multiple tabs
  return null;
}

/**
 * Open a URL clicked inside a terminal pane, in the project window that owns the session.
 *
 * A terminal's URL belongs to the session's owning project, not to whichever window happens to be
 * focused when the click lands — that ownership is what Main's owner-keyed `openTerminalLink` route
 * exists to enforce, and every session has an owner key (an unassigned shell included), so Main
 * always has an answer. There is therefore no fallback: a refusal, a malformed answer, a bridge
 * failure or a preload that lacks the route are all reported instead of being resolved locally,
 * because opening the tab here is the focused-window behaviour the route removes.
 */
function openTerminalLinkFromPane(currentSessionId, uri) {
  if (!uri) return;
  // Reported exactly like the sibling handover route does when its preload method is missing: a
  // drifted preload is a build fault, and the user reads why nothing happened.
  if (typeof api?.openTerminalLink !== 'function') {
    showTerminalNotice('Không mở được liên kết: preload thiếu openTerminalLink');
    return;
  }
  const sessionId = typeof currentSessionId === 'function' ? currentSessionId() : currentSessionId;
  if (!sessionId) {
    showTerminalNotice('Không mở được liên kết: chưa xác định được phiên terminal');
    return;
  }
  Promise.resolve()
    .then(() => api.openTerminalLink(sessionId, uri))
    .then((result) => {
      // Main answers a typed outcome; anything that is not an explicit success has to be said
      // out loud here, because nothing else in the flow will.
      if (!result || result.ok !== true) {
        showTerminalNotice(
          (result && typeof result.message === 'string' && result.message)
            || 'Không mở được liên kết của terminal này'
        );
      }
    })
    .catch((err) => {
      showTerminalNotice(`Không mở được liên kết: ${bridgeErrorText(err)}`);
    });
}

function attachWebLinksAddon(term, currentSessionId) {
  try {
    const Ctor = window.WebLinksAddon?.WebLinksAddon || globalThis.WebLinksAddon?.WebLinksAddon;
    if (typeof Ctor === 'function') {
      const linkHandler = (_event, uri) => openTerminalLinkFromPane(currentSessionId, uri);
      const addon = new Ctor(linkHandler);
      term.loadAddon(addon);
      return addon;
    }
  } catch (e) {
    console.warn('[Terminal] WebLinks addon fallback:', e);
  }
  return null;
}

function writeToTerminalPane(item, chunk) {
  if (!item || !chunk) return;
  const target = getWriteTargetFor(item);
  if (target) {
    try {
      __terminalBench?.record('T2', { sessionId: item.id });
      window.globalTerminalWriteDispatcher.queueWrite(target, chunk);
      return;
    } catch {}
  }
  try {
    item.term.write(chunk, () => {
      benchRecordPaint(item.id);
      if (!item.isUserScrolledUp && item.paneEl && item.paneEl.classList.contains('active') && viewportAtBottom(item.term)) {
        item.term.scrollToBottom();
      }
      if (item.pendingWriteAckSeq > 0) {
        scheduleCoalescedAck(item.id, item.sessionGeneration || 0, item.pendingWriteAckSeq);
        item.lastAckedSeq = item.pendingWriteAckSeq;
      }
    });
  } catch {
    try {
      item.term.write(chunk);
      if (item.pendingWriteAckSeq > 0) {
        scheduleCoalescedAck(item.id, item.sessionGeneration || 0, item.pendingWriteAckSeq);
        item.lastAckedSeq = item.pendingWriteAckSeq;
      }
    } catch {}
  }
}

function getWriteTargetFor(item) {
  if (item.writeTarget) return item.writeTarget;
  const dispatcher = window.globalTerminalWriteDispatcher;
  if (!dispatcher) return null;
  item.writeTarget = dispatcher.createTarget(item.term, () => {
    benchRecordPaint(item.id);
    if (!item.isUserScrolledUp && item.paneEl && item.paneEl.classList.contains('active') && viewportAtBottom(item.term)) {
      item.term.scrollToBottom();
    }
    if (item.pendingWriteAckSeq > 0) {
      scheduleCoalescedAck(item.id, item.sessionGeneration || 0, item.pendingWriteAckSeq);
      item.lastAckedSeq = item.pendingWriteAckSeq;
    }
  });
  return item.writeTarget;
}

function writeToSplitPane(chunk) {
  if (!splitTerm || !chunk) return;
  const dispatcher = window.globalTerminalWriteDispatcher;
  if (dispatcher) {
    if (!splitWriteTarget || splitWriteTarget.term !== splitTerm) {
      splitWriteTarget = dispatcher.createTarget(splitTerm, () => {
        benchRecordPaint(splitId);
        if (!isSplitUserScrolledUp && viewportAtBottom(splitTerm)) {
          splitTerm.scrollToBottom();
        }
        if (splitSessionState.pendingWriteAckSeq > 0) {
          scheduleCoalescedAck(splitId, splitSessionState.sessionGeneration || 0, splitSessionState.pendingWriteAckSeq);
          splitSessionState.lastAckedSeq = splitSessionState.pendingWriteAckSeq;
        }
      });
    }
    try {
      __terminalBench?.record('T2', { sessionId: splitId });
      dispatcher.queueWrite(splitWriteTarget, chunk);
      return;
    } catch {}
  }
  try {
    splitTerm.write(chunk, () => {
      benchRecordPaint(splitId);
      if (!isSplitUserScrolledUp && viewportAtBottom(splitTerm)) {
        splitTerm.scrollToBottom();
      }
      if (splitSessionState.pendingWriteAckSeq > 0) {
        scheduleCoalescedAck(splitId, splitSessionState.sessionGeneration || 0, splitSessionState.pendingWriteAckSeq);
        splitSessionState.lastAckedSeq = splitSessionState.pendingWriteAckSeq;
      }
    });
  } catch {
    try {
      splitTerm.write(chunk);
      if (splitSessionState.pendingWriteAckSeq > 0) {
        scheduleCoalescedAck(splitId, splitSessionState.sessionGeneration || 0, splitSessionState.pendingWriteAckSeq);
        splitSessionState.lastAckedSeq = splitSessionState.pendingWriteAckSeq;
      }
    } catch {}
  }
}

/**
 * True while the viewport is parked on the live edge. A TUI that redraws in the
 * alternate buffer leaves `baseY` at 0, where a zero viewport is the bottom.
 */
function viewportAtBottom(term) {
  const activeBuf = term?.buffer?.active;
  if (!activeBuf) return true;
  return activeBuf.viewportY >= activeBuf.baseY;
}

/**
 * Record where the user is reading from, so a later refit can restore the position
 * instead of dragging them to the live edge. "Scrolled up" means only "not at the
 * bottom": the auto-scroll pin is released there and re-armed on return, which is
 * what keeps a TUI redraw from yanking a reader back to the newest frame.
 */
function recordViewportReadPosition(item, term) {
  if (item.released) return;
  const activeBuf = term?.buffer?.active;
  if (!activeBuf) return;
  // Hydration resets the buffer and replays the snapshot, so every scroll event inside that
  // window reports the live edge; classifying one would clear the recorded line before the
  // hydrate restore can put it back.
  if (item.activeHydratingEpoch != null) return;
  // An empty buffer cannot say where the reader is: hydration resets it to 0/0 for a frame,
  // and reading that as "at the live edge" would discard the recorded line mid-restore.
  if (activeBuf.baseY === 0 && activeBuf.length === 0) return;
  if (activeBuf.viewportY >= activeBuf.baseY) {
    item.isUserScrolledUp = false;
    item.savedViewportY = null;
  } else {
    item.isUserScrolledUp = true;
    item.savedViewportY = activeBuf.viewportY;
  }
}

// Restoring the recorded line is the whole point of keeping it: a refit or a rehydration that
// leaves the viewport on the live edge makes the next check read the pane as bottom-anchored and
// discard the reader's place for good.
function restoreSavedViewport(item) {
  if (item.released) return;
  const activeBuf = item.term?.buffer?.active;
  if (!activeBuf || typeof item.savedViewportY !== 'number') return;
  item.term.scrollToLine(Math.max(0, Math.min(item.savedViewportY, activeBuf.baseY)));
}

function getOrCreateTerminalPane(sessionId, snapshot, snapshotSeq = 0, isAuthoritative = false) {
  let item = rawTerminalPool.get(sessionId);
  if (item) {
    return item;
  }

  const s = Array.isArray(sessions) ? sessions.find((x) => x.id === sessionId) : null;
  if (!snapshot && s && typeof s.buffer === 'string') {
    snapshot = s.buffer;
    snapshotSeq = s.snapshotThroughSeq || 0;
  }

  const paneEl = document.createElement('div');
  paneEl.className = 'terminal-session-pane';
  paneEl.setAttribute('data-session-id', sessionId);
  const isActive = sessionId === activeId;
  if (isActive) {
    paneEl.classList.add('active');
  }

  const initialCols = (s && typeof s.cols === 'number' && s.cols >= MIN_TERMINAL_COLS) ? s.cols : 120;
  const initialRows = (s && typeof s.rows === 'number' && s.rows >= MIN_TERMINAL_ROWS) ? s.rows : 30;

  const sTerm = new Terminal({
    cols: initialCols,
    rows: initialRows,
    cursorBlink: true,
    convertEol: false,
    fontFamily: 'Cascadia Mono, Consolas, monospace',
    fontSize: 12,
    scrollback: 10000,
    scrollOnUserInput: true,
    smoothScrollDuration: 0,
    theme: { background: '#070b11', foreground: '#dbe7f5', cursor: '#63b3ff' },
  });
  const sFit = new FitAddon.FitAddon();
  sTerm.loadAddon(sFit);
  sTerm.open(paneEl);
  const webglAddon = attachWebglAddon(sTerm);
  const webLinksAddon = attachWebLinksAddon(sTerm, () => sessionId);
  setupTerminalClipboard(sTerm, () => sessionId);

  mainPane.appendChild(paneEl);
  if (globalResizeObserver) {
    try { globalResizeObserver.observe(paneEl); } catch {}
  }
  // Propose and apply initial sizing if DOM container has valid layout
  try {
    const propose = sFit.proposeDimensions();
    if (propose && propose.cols >= MIN_TERMINAL_COLS && propose.rows >= MIN_TERMINAL_ROWS && paneEl.clientWidth > 100) {
      sTerm.resize(propose.cols, propose.rows);
      api?.resizeTerminalTo(sessionId, propose.cols, propose.rows);
    }
  } catch {}

  // No pre-hydrate write here: atomicHydratePane below resets the terminal and
  // writes the authoritative snapshot, so an early tail write is pure cost.

  sTerm.onData((data) => {
    sendTerminalInputFor(sessionId, data);
  });
  item = {
    id: sessionId,
    term: sTerm,
    fit: sFit,
    paneEl,
    webglAddon,
    webLinksAddon,
    lastRenderedSeq: 0,
    sessionGeneration: (s && typeof s.sessionGeneration === 'number') ? s.sessionGeneration : 0,
    hydrationEpoch: 0,
    activeHydratingEpoch: null,
    liveQueue: [],
    syncState: 'READY',
    isFetchingDelta: false,
    pendingWriteAckSeq: 0,
    lastAckedSeq: 0,
    gapCount: 0,
    resyncCount: 0,
    degradedCount: 0,
    hasAuthoritativeState: isAuthoritative,
    writeTarget: null,
    savedViewportY: null,
    isUserScrolledUp: false,
    isProgrammaticScroll: false,
    needsRehydrate: false,
  };
  paneEl.addEventListener('focusin', () => {
    focusMainPane();
  });
  // Click on pane focuses the terminal
  paneEl.addEventListener('click', () => {
    focusMainPane();
  });

  paneEl.addEventListener('wheel', () => {
    if (!item || !item.paneEl || !item.paneEl.classList.contains('active')) return;
    recordViewportReadPosition(item, sTerm);
  }, { passive: true });

  sTerm.onScroll(() => {
    if (item && item.isProgrammaticScroll) return;
    if (!item || !item.paneEl || !item.paneEl.classList.contains('active')) {
      return;
    }
    recordViewportReadPosition(item, sTerm);
  });

  rawTerminalPool.set(sessionId, item);
  atomicHydratePane(item, sessionId, snapshot, snapshotSeq);
  syncPaneWithBackend(item, sessionId);
  return item;
}

function syncTerminalPool(allSessions, currentActiveId, snapshot, snapshotThroughSeq = 0) {
  const sessionList = Array.isArray(allSessions) ? allSessions : [];
  const activeSessionIds = new Set(sessionList.map((s) => s.id));
  // A sleeping session stays in `sessions` (it is not closed) but must not own a
  // live xterm: its PTY is gone, so a pooled pane would be pure cost — and every
  // later touch would rebuild it, defeating the whole feature.
  const sleepingSessionIds = new Set(sessionList.filter((s) => s.state === 'sleeping').map((s) => s.id));
  for (const [id, item] of terminalPool.entries()) {
    if (!activeSessionIds.has(id) || sleepingSessionIds.has(id)) {
      releaseTerminalPane(id, item);
    }
  }
  const activeSession = sessionList.find((s) => s.id === currentActiveId);
  const splitSiblingId = activeSession?.splitSessionId;

  for (const s of sessionList) {
    if (sleepingSessionIds.has(s.id)) {
      // Sleeping panes are released above and never rebuilt here, even when the
      // session is the active tab or the split sibling.
      continue;
    }
    const sessionSnapshot = s.id === currentActiveId
      ? (typeof snapshot === 'string' ? snapshot : (typeof s.buffer === 'string' ? s.buffer : ''))
      : (typeof s.buffer === 'string' ? s.buffer : '');
    const seq = s.id === currentActiveId ? (snapshotThroughSeq || s.snapshotThroughSeq || 0) : (s.snapshotThroughSeq || 0);
    // A session with no transcript has nothing to parse, so materializing it cannot
    // cost startup time; only content-bearing background panes are deferred.
    const exists = rawTerminalPool.has(s.id);
    const isEager = s.id === currentActiveId || s.id === splitSiblingId || !sessionSnapshot;
    if (!exists && !isEager) {
      // Lazy background session: defer pane creation and transcript parsing until first activation
      continue;
    }

    const item = rawTerminalPool.get(s.id);
    if (!item) {
      getOrCreateTerminalPane(s.id, sessionSnapshot, seq, true);
    } else if (!item.hasAuthoritativeState) {
      item.hasAuthoritativeState = true;
      atomicHydratePane(item, s.id, sessionSnapshot, seq);
    }
  }
  for (const [id, item] of terminalPool.entries()) {
    const isNowActive = id === currentActiveId;
    const wasActive = item.paneEl.classList.contains('active');

    if (wasActive && !isNowActive) {
      recordViewportReadPosition(item, item.term);
      item.paneEl.classList.remove('active');
    } else if (isNowActive) {
      const justBecameActive = !wasActive;
      item.paneEl.classList.add('active');
      if (globalResizeObserver) {
        try { globalResizeObserver.observe(item.paneEl); } catch {}
      }
      item.isProgrammaticScroll = true;
      if (item.needsRehydrate) {
        // Writes were gated while hidden and lastRenderedSeq already advanced
        // past them, so delta resync would silently drop data — snapshot
        // re-hydrate is the only correct recovery.
        item.needsRehydrate = false;
        item.syncState = 'READY';
        hideDegradedBanner(item);
        atomicHydratePane(item, id);
      }
      const doRefit = () => {
        try {
          if (item.released) return;
          const propose = item.fit.proposeDimensions();
          if (propose && propose.cols >= MIN_TERMINAL_COLS && propose.rows >= MIN_TERMINAL_ROWS && item.paneEl.clientWidth > 50) {
            if (item.term.cols !== propose.cols || item.term.rows !== propose.rows) {
              item.term.resize(propose.cols, propose.rows);
              api?.resizeTerminalTo(id, propose.cols, propose.rows);
            }
          }
          item.term.refresh(0, item.term.rows - 1);
          const activeBuf = item.term.buffer?.active;
          if (activeBuf) {
            // Hydration resets the buffer, so a buffer that cannot even reach the recorded line
            // (no scrollback yet) says nothing about where the reader is. Classifying it as "at
            // the live edge" cleared the recorded line during activation and left the pane
            // pinned to the newest frame; leave the memory alone and let the hydrate restore
            // (or the settle pass below) put the line back.
            const bufferInFlight = item.activeHydratingEpoch != null
              || (activeBuf.baseY === 0 && typeof item.savedViewportY === 'number');
            if (!bufferInFlight) {
              // A refit or a rehydration can land the pane on the live edge before the fit
              // settles, so a bottom reading here is not evidence the reader returned there:
              // the recorded line is theirs. Only the reader clears it, by scrolling back to
              // the bottom (recordViewportReadPosition runs on that scroll and on switch-away).
              if (typeof item.savedViewportY === 'number' && activeBuf.viewportY >= activeBuf.baseY) {
                restoreSavedViewport(item);
              }
              if (!viewportAtBottom(item.term)) {
                // The viewport is not at the bottom: the user is reading scrollback (or a
                // TUI redraw left them above the live edge), so a refit restores the line
                // they were reading instead of pinning them to the newest frame.
                restoreSavedViewport(item);
                item.isUserScrolledUp = true;
              } else {
                item.isUserScrolledUp = false;
                item.savedViewportY = null;
                item.term.scrollToBottom();
              }
            }
          }
        } catch {}
      };
      doRefit();
      scheduleFitTerminal(60);
      requestAnimationFrame(() => {
        doRefit();
      });
      // The activate-time fit fires again on its own schedule, and xterm re-anchors the
      // viewport while it reflows. That reflow is not the reader returning to the live edge,
      // so suppression has to outlive it, and the recorded line has to be put back once the
      // layout settles — otherwise the reflow's scroll event reads the pane as bottom-anchored
      // and discards the reader's place for good.
      setTimeout(() => {
        if (item.released) return;
        item.isProgrammaticScroll = false;
        if (!item.paneEl.classList.contains('active')) return;
        if (typeof item.savedViewportY !== 'number') return;
        const settledBuf = item.term?.buffer?.active;
        if (settledBuf && settledBuf.viewportY >= settledBuf.baseY) {
          restoreSavedViewport(item);
          item.isUserScrolledUp = true;
        }
      }, 120);
      if (justBecameActive) {
        focusMainPane();
      }
    } else {
      item.paneEl.classList.remove('active');
    }
  }
  // Viewing a sleeping tab, or asking a live one for its transcript, is a read-only
  // replay: mount the plain-text view instead of an xterm, and drop it the moment the
  // session is awake or the request stops applying to the active tab.
  const previewSession = currentActiveId ? (activeSession || findSession(currentActiveId)) : null;
  const previewMode = resolveReadOnlyTranscriptMode(previewSession);
  const previewTarget = previewMode === 'lossy'
    ? (findSession(transcriptPreviewSessionId) || previewSession)
    : previewSession;
  // A transcript request belongs to the tab it was made on: leaving that tab drops it,
  // so returning to a live TUI never lands in a stale text view.
  if (transcriptPreviewSessionId && previewMode !== 'lossy') transcriptPreviewSessionId = '';
  if (previewTarget && previewMode) renderSleepPreview(previewTarget, previewMode);
  else teardownSleepPreview();
  updateEmptyStateDisplay(sessionList.length > 0);
}

function updateEmptyStateDisplay(hasSessions) {
  let emptyEl = document.getElementById('terminalEmptyState');
  if (hasSessions) {
    if (emptyEl) emptyEl.remove();
    return;
  }
  if (!emptyEl && mainPane) {
    emptyEl = document.createElement('div');
    emptyEl.id = 'terminalEmptyState';
    emptyEl.className = 'terminal-empty-state';
    emptyEl.innerHTML = `
      <div class="empty-state-card">
        <div class="empty-state-icon">
          <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="#38bdf8" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="4 17 10 11 4 5"/>
            <line x1="12" y1="19" x2="20" y2="19"/>
          </svg>
        </div>
        <h3 class="empty-state-title">Chưa có Terminal nào</h3>
        <p class="empty-state-desc">Tất cả phiên dòng lệnh đã đóng. Bạn có thể tạo phiên mới bất kỳ lúc nào.</p>
        <button id="btnEmptyCreateTerminal" class="empty-state-action-btn" type="button">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
            <line x1="8" y1="2" x2="8" y2="14"/>
            <line x1="2" y1="8" x2="14" y2="8"/>
          </svg>
          Tạo Terminal mới
        </button>
      </div>
    `;
    mainPane.appendChild(emptyEl);
    emptyEl.querySelector('#btnEmptyCreateTerminal')?.addEventListener('click', () => {
      void createTerminal();
    });
  }
}

const btnNewTerminal = document.getElementById('btnNewTerminal');
const splitButton = document.getElementById('btnSplitTerminal') || document.getElementById('btnSplitVertical');

// Fix: ONLY ONE listener on btnNewTerminal (prevent duplicate terminals)
if (btnNewTerminal) {
  btnNewTerminal.onclick = (e) => {
    e.stopPropagation();
    void createTerminal();
  };
}

/**
 * A vector icon as an inline SVG string. Icons are deliberately NOT built with
 * `document.createElementNS`: the renderer test harness stubs `createElement` only, so
 * an unstubbed `createElementNS` would throw at load and take every renderer test with
 * it. `innerHTML` parses this into real SVG in Electron, and the markup inherits
 * `currentColor`, so an icon themes with whatever button owns it.
 */
function iconSvg(paths, sizePx) {
  const size = sizePx || 14;
  return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${paths}</svg>`;
}

const ICON_PLUS = '<path d="M12 5v14"/><path d="M5 12h14"/>';
const ICON_LAYERS = '<path d="M12 3 3 8l9 5 9-5-9-5Z"/><path d="M3 14l9 5 9-5"/>';
const ICON_SEARCH = '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>';
const ICON_CLOSE = '<path d="M6 6l12 12"/><path d="M18 6 6 18"/>';
const ICON_MOON = '<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/>';

// The strip's header row: the search field takes the free width, and the two create
// actions sit on its right, so the affordances read as one deliberate row instead of
// two stacked full-width blocks.
const tabToolbar = document.createElement('div');
tabToolbar.className = 'terminal-tab-toolbar';

const tabSearchInput = document.createElement('input');
tabSearchInput.type = 'search';
tabSearchInput.className = 'terminal-tab-search-input';
tabSearchInput.placeholder = 'Tìm tab…';
tabSearchInput.setAttribute('aria-label', 'Tìm terminal theo tên, thư mục hoặc nhóm');
tabSearchInput.spellcheck = false;
tabSearchInput.autocomplete = 'off';

const btnClearTabSearch = document.createElement('button');
btnClearTabSearch.type = 'button';
btnClearTabSearch.className = 'terminal-tab-search-clear';
btnClearTabSearch.innerHTML = iconSvg(ICON_CLOSE, 12);
btnClearTabSearch.title = 'Xoá tìm kiếm (Esc)';
btnClearTabSearch.setAttribute('aria-label', 'Xoá tìm kiếm');
btnClearTabSearch.onclick = (e) => {
  e.stopPropagation();
  setTabSearchQuery('');
  try { tabSearchInput.focus(); } catch {}
};

const tabSearchField = document.createElement('div');
tabSearchField.className = 'terminal-tab-search';
const tabSearchIcon = document.createElement('span');
tabSearchIcon.className = 'terminal-tab-search-icon';
tabSearchIcon.innerHTML = iconSvg(ICON_SEARCH, 13);
tabSearchField.append(tabSearchIcon, tabSearchInput, btnClearTabSearch);

// Group management is a first-class action, not a right-click on a tab: an empty group
// has no tab to right-click, which is exactly the case this control exists for.
const btnNewCategory = document.createElement('button');
btnNewCategory.type = 'button';
btnNewCategory.id = 'btnNewCategory';
btnNewCategory.className = 'terminal-tab-new-category';
btnNewCategory.innerHTML = iconSvg(ICON_LAYERS, 14);
btnNewCategory.title = 'Tạo nhóm mới (nhóm rỗng vẫn được giữ lại)';
btnNewCategory.setAttribute('aria-label', 'Tạo nhóm mới');
btnNewCategory.onclick = (e) => {
  e.stopPropagation();
  startNewCategory(btnNewCategory);
};

// `#btnNewTerminal` is declared in standalone.html as the strip's first child; it moves
// into this row so the search field can take the remaining width.
tabToolbar.append(tabSearchField, btnNewTerminal, btnNewCategory);
if (tabsEl) tabsEl.insertBefore(tabToolbar, tabsEl.firstChild);

tabSearchInput.addEventListener('input', () => {
  tabSearchQuery = tabSearchInput.value;
  renderTabs();
  updateTabSearchUi();
});
tabSearchInput.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    e.preventDefault();
    setTabSearchQuery('');
    tabSearchInput.blur();
  } else if (e.key === 'Enter' && tabSearchActive) {
    e.preventDefault();
    // A search is also a switcher: Enter opens the first tab that survived the filter.
    const first = tabsEl.querySelector('.terminal-tab-wrap');
    const sid = first ? first.getAttribute('data-session-id') : '';
    if (sid) {
      api?.switchTerminal(sid);
      tabSearchInput.blur();
    }
  }
});

function getSplitGeometry() {
  const divider = document.getElementById('terminal-divider');
  const dividerHeight = divider?.offsetHeight || 7;
  const dividerStyle = (divider && typeof window.getComputedStyle === 'function') ? window.getComputedStyle(divider) : null;
  const dividerMarginTop = dividerStyle ? (parseFloat(dividerStyle.marginTop) || 0) : 2;
  const dividerMarginBottom = dividerStyle ? (parseFloat(dividerStyle.marginBottom) || 0) : 2;
  const dividerTotal = dividerHeight + dividerMarginTop + dividerMarginBottom;
  const containerStyle = (container && typeof window.getComputedStyle === 'function') ? window.getComputedStyle(container) : null;
  const containerPadTop = containerStyle ? (parseFloat(containerStyle.paddingTop) || 0) : 4;
  const containerPadBottom = containerStyle ? (parseFloat(containerStyle.paddingBottom) || 0) : 4;
  const containerBorderTop = container?.clientTop || (containerStyle ? (parseFloat(containerStyle.borderTopWidth) || 0) : 0);
  const totalHeight = Math.max(0, (container?.clientHeight || 400) - (containerPadTop + containerPadBottom));
  const usable = Math.max(0, totalHeight - dividerTotal);
  const paneMin = Math.min(60, Math.floor(usable * 0.15));
  const contentTopOffset = containerBorderTop + containerPadTop;
  return {
    usable,
    paneMin,
    dividerTotal,
    dividerHeight,
    dividerMarginTop,
    dividerMarginBottom,
    contentTopOffset,
  };
}

function applySplitRatio(ratio, resizePty = true) {
  const lower = document.getElementById('terminal-split');
  if (lower && splitEnabled) {
    const geo = getSplitGeometry();
    if (geo.usable <= 0) return;
    const usable = geo.usable;
    const paneMin = geo.paneMin;
    const rawRatio = (typeof ratio === 'number' && isFinite(ratio) && ratio > 0 && ratio < 1) ? ratio : DEFAULT_MAIN_SPLIT_RATIO;
    const rawMain = Math.round(usable * rawRatio);
    const clampedMain = Math.max(paneMin, Math.min(usable - paneMin, rawMain));
    const clampedLower = Math.max(0, usable - clampedMain);
    mainPane.style.flex = `0 0 ${clampedMain}px`;
    mainPane.style.height = `${clampedMain}px`;
    mainPane.style.minHeight = '0px';
    mainPane.style.maxHeight = `${clampedMain}px`;

    lower.style.flex = `0 0 ${clampedLower}px`;
    lower.style.height = `${clampedLower}px`;
    lower.style.minHeight = '0px';
    lower.style.maxHeight = `${clampedLower}px`;
  } else {
    mainPane.style.flex = '1 1 100%';
    mainPane.style.minHeight = '0';
    mainPane.style.maxHeight = '';
    mainPane.style.height = '';
  }
  requestAnimationFrame(() => {
    const item = isSessionSleeping(activeId) ? null : terminalPool.get(activeId);
    if (item) {
      try {
        const propose = item.fit.proposeDimensions();
        if (propose && propose.cols >= MIN_TERMINAL_COLS && propose.rows >= MIN_TERMINAL_ROWS) {
          if (item.term.cols !== propose.cols || item.term.rows !== propose.rows) {
            item.term.resize(propose.cols, propose.rows);
            if (resizePty) {
              api?.resizeTerminalTo(activeId, propose.cols, propose.rows);
            }
          }
        }
        item.term.refresh(0, item.term.rows - 1);
      } catch {}
    }
    if (splitFitAddon && splitTerm) {
      try {
        const splitPropose = splitFitAddon.proposeDimensions();
        if (splitPropose && splitPropose.cols >= MIN_TERMINAL_COLS && splitPropose.rows >= MIN_SPLIT_TERMINAL_ROWS) {
          if (splitTerm.cols !== splitPropose.cols || splitTerm.rows !== splitPropose.rows) {
            splitTerm.resize(splitPropose.cols, splitPropose.rows);
            if (resizePty && splitId) {
              api?.resizeTerminalTo(splitId, splitPropose.cols, splitPropose.rows);
            }
          }
        }
        splitTerm.refresh(0, splitTerm.rows - 1);
      } catch {}
    }
  });
}

function unmountSplit() {
  if (splitting) {
    splitting = false;
    const dividerEl = document.getElementById('terminal-divider');
    dividerEl?.classList.remove('dragging');
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    mainPane.style.pointerEvents = '';
    const lowerEl = document.getElementById('terminal-split');
    if (lowerEl) lowerEl.style.pointerEvents = '';
    if (splitRafId) {
      cancelAnimationFrame(splitRafId);
      splitRafId = null;
    }
  }
  try { if (splitWriteTarget && window.globalTerminalWriteDispatcher) window.globalTerminalWriteDispatcher.cancel(splitWriteTarget); } catch {}
  splitWriteTarget = null;
  isSplitUserScrolledUp = false;
  isSplitProgrammaticScroll = false;
  splitSessionState.id = '';
  // Same contract as releaseTerminalPane: an in-flight hydration re-reads this epoch after every
  // await, so bumping it here is what stops a closed split's continuation from touching splitTerm.
  splitSessionState.hydrationEpoch += 1;
  splitSessionState.activeHydratingEpoch = null;
  splitSessionState.liveQueue = [];
  splitSessionState.lastRenderedSeq = 0;
  splitSessionState.syncState = 'READY';
  splitSessionState.isFetchingDelta = false;
  splitSessionState.pendingWriteAckSeq = 0;
  splitSessionState.lastAckedSeq = 0;
  try { splitWebLinksAddon?.dispose(); } catch {}
  splitWebLinksAddon = null;
  try { splitWebglAddon?.dispose(); } catch {}
  splitWebglAddon = null;
  try { splitFitAddon?.dispose?.(); } catch {}
  splitFitAddon = null;
  try { splitTerm?.dispose(); } catch {}
  splitTerm = null;
  splitId = '';
  splitEnabled = false;
  const lower = document.getElementById('terminal-split');
  const divider = document.getElementById('terminal-divider');
  lower?.remove();
  divider?.remove();
  container.classList.remove('split');
  mainPane.style.flex = '1 1 100%';
  mainPane.style.height = '';
  mainPane.style.minHeight = '0';
  mainPane.style.maxHeight = '';
  if (splitButton) {
    splitButton.classList.remove('active');
    splitButton.title = 'Chia đôi màn hình terminal (Split Right)';
  }
  scheduleFitTerminal(60);
}
function mountSplit(sessionId, snapshot = undefined, snapshotSeq = undefined) {
  if (!sessionId) return;
  if (splitId === sessionId && splitTerm) {
    if (typeof snapshotSeq === 'number' && snapshotSeq > splitSessionState.lastRenderedSeq) {
      atomicHydrateSplitPane(sessionId, snapshot, snapshotSeq);
    }
    return;
  }
  unmountSplit();
  splitId = sessionId;
  splitEnabled = true;
  isSplitUserScrolledUp = false;
  isSplitProgrammaticScroll = false;
  container.classList.add('split');
  const lower = document.createElement('div');
  lower.id = 'terminal-split';

  // Header with close split button
  const splitHeader = document.createElement('div');
  splitHeader.className = 'split-pane-header';
  splitHeader.innerHTML = `
    <div class="split-pane-title">
      <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8"><polyline points="4 5 8 8 4 11"/><line x1="9" y1="11" x2="13" y2="11"/></svg>
      <span>Terminal (Split)</span>
    </div>
    <button class="split-pane-close-btn" id="btnCloseSplitPane" title="Đóng Terminal chia đôi (Unsplit / Close)">✕</button>
  `;

  const splitHost = document.createElement('div');
  splitHost.id = 'terminal-split-host';

  lower.append(splitHeader, splitHost);

  const divider = document.createElement('div');
  divider.id = 'terminal-divider';
  container.append(mainPane, divider, lower);

  // The main pane may itself be a sleeping session (its split sibling outlives
  // the parent's sleep). Never materialize a pane for it here.
  const mainItem = isSessionSleeping(activeId) ? null : terminalPool.get(activeId);
  const targetCols = (mainItem && mainItem.term && mainItem.term.cols) || 120;
  const targetRows = getInitialSplitRows(mainItem?.term);

  splitTerm = new Terminal({
    cols: targetCols,
    rows: targetRows,
    cursorBlink: true,
    convertEol: false,
    fontFamily: 'Cascadia Mono, Consolas, monospace',
    fontSize: 12,
    scrollback: 10000,
    scrollOnUserInput: true,
    smoothScrollDuration: 0,
    theme: { background: '#070b11', foreground: '#dbe7f5', cursor: '#63b3ff' },
  });
  splitFitAddon = new FitAddon.FitAddon();
  splitTerm.loadAddon(splitFitAddon);
  splitTerm.open(splitHost);
  splitWebglAddon = attachWebglAddon(splitTerm);
  splitWebLinksAddon = attachWebLinksAddon(splitTerm, () => splitId);
  setupTerminalClipboard(splitTerm, () => splitId);

  splitTerm.onData((data) => {
    if (!splitId) return;
    const act = sessionActivity.get(splitId);
    if (act && act.isWaiting) {
      act.isWaiting = false;
      updateTabActivityUi(splitId);
    }
    // A session can fall asleep while still mounted in the split pane; a keystroke
    // is then a wake request rather than input to a released PTY. The awake path
    // keeps its direct forward.
    if (isSessionSleeping(splitId)) {
      wakeSleepingSession(splitId, data);
      return;
    }
    api?.sendTerminalInputTo(splitId, data);
  });

  splitTerm.onScroll(() => {
    if (isSplitProgrammaticScroll) return;
    if (splitTerm?.buffer?.active) {
      isSplitUserScrolledUp = !viewportAtBottom(splitTerm);
    }
  });

  lower.addEventListener('focusin', () => {
    focusSplitPane();
  });
  splitHost.addEventListener('click', () => {
    focusSplitPane();
  });
  applySplitRatio(sessionSplitRatios.get(activeId) ?? DEFAULT_MAIN_SPLIT_RATIO);
  atomicHydrateSplitPane(sessionId, snapshot, snapshotSeq);
  if (splitButton) {
    splitButton.classList.add('active');
    splitButton.title = 'Tắt chia đôi terminal (Unsplit)';
  }

  requestAnimationFrame(() => {
    try {
      fitCurrentTerminal();
      focusSplitPane();
    } catch {}
  });

  // Hook close split button
  splitHeader.querySelector('#btnCloseSplitPane')?.addEventListener('click', async (e) => {
    e.stopPropagation();
    if (api) {
      // Close the split this lower pane is mounting, not the parent's first one.
      await api.unsplitTerminal?.(sessionId);
    }
    unmountSplit();
  });
}

function mountSplitClean(newSplitId) {
  if (!newSplitId) return;
  const phantom = terminalPool.get(newSplitId);
  if (phantom) {
    try { if (phantom.writeTarget && window.globalTerminalWriteDispatcher) window.globalTerminalWriteDispatcher.cancel(phantom.writeTarget); } catch {}
    try { phantom.webLinksAddon?.dispose(); } catch {}
    try { phantom.webglAddon?.dispose(); } catch {}
    try { phantom.term?.dispose(); } catch {}
    try { phantom.paneEl?.remove(); } catch {}
    terminalPool.delete(newSplitId);
  }
  mountSplit(newSplitId);
}

// Split Toggle Button
if (splitButton) {
  splitButton.onclick = async () => {
    if (!activeId || !api || splitButton.disabled) return;
    if (isSessionSleeping(activeId)) {
      // Splitting needs two live PTYs. Wake the session instead of building a
      // pane behind the user's back; the split can be re-requested once awake.
      wakeSleepingSession(activeId, '');
      return;
    }
    splitButton.disabled = true;
    try {
      if (splitEnabled) {
        // Toggle off split
        await api.unsplitTerminal?.(activeId);
        unmountSplit();
        return;
      }
      const mainItem = terminalPool.get(activeId);
      const targetCols = (mainItem && mainItem.term && mainItem.term.cols) || 120;
      const targetRows = getInitialSplitRows(mainItem?.term);
      const newSplitId = await api.splitTerminal(activeId, { cols: targetCols, rows: targetRows });
      if (newSplitId) mountSplitClean(newSplitId);
    } catch (err) {
      console.error('[Terminal] Split toggle failed:', err);
    } finally {
      splitButton.disabled = false;
    }
  };
}
async function updateAffinityBadges(deliveredTabs, deliveredAffinities) {
  if (!api?.getTerminalAffinities || !api?.getTabs) return;
  const setBadgeState = (badge, cls, text, tip) => {
    if (badge.className !== cls) badge.className = cls;
    if (badge.textContent !== text) badge.textContent = text;
    if (badge.title !== tip) badge.title = tip;
  };
  try {
    // One round-trip for every badge: the per-id loop was N+1 IPC calls on every
    // tab render, and each generation-less lookup cost an O(E) prefix scan.
    // A caller that holds the broadcast hands in both halves of it: the tab list is
    // `getTabList()` verbatim and the affinity map is the host's own projection, so
    // re-fetching either bought nothing and cost an `invoke` per broadcast — ~106,800
    // and ~72,000 over one 4 h soak — each allocating a correlation entry, a promise
    // and a deserialized payload on the main thread that every switch, bridge RPC and
    // terminal fanout also runs on. Callers that hold neither still pull both.
    const [tabs, affinities] = await Promise.all([
      Array.isArray(deliveredTabs) ? Promise.resolve(deliveredTabs) : api.getTabs(),
      (deliveredAffinities && typeof deliveredAffinities === 'object')
        ? Promise.resolve(deliveredAffinities)
        : api.getTerminalAffinities(),
    ]);
    const tabsMap = new Map((tabs || []).map((t) => [t.id, t]));
    const affinityMap = (affinities && typeof affinities === 'object') ? affinities : {};
    const badges = document.querySelectorAll('.terminal-tab-affinity-badge');
    for (const badge of badges) {
      const sid = badge.getAttribute('data-session-id');
      if (!sid) continue;
      if (isSessionSleeping(sid)) {
        setBadgeState(badge, 'terminal-tab-affinity-badge sleeping', '💤 Ngủ', 'Terminal đang ngủ — click để đánh thức');
        continue;
      }
      const affinity = affinityMap[sid];
      if (!affinity || !affinity.tabId) {
        setBadgeState(badge, 'terminal-tab-affinity-badge unbound', '🎯 Chưa gán', 'Terminal này chưa gán tab nào (Click để chọn tab)');
      } else if (affinity.status === 'closed') {
        setBadgeState(badge, 'terminal-tab-affinity-badge closed', '🎯 Tab đã đóng', `Tab trước đó (${affinity.lastUrl || affinity.tabId}) đã bị đóng (Click để gán lại)`);
      } else {
        const validManaged = (affinity.managedTabIds || []).filter((id) => {
          return tabsMap.has(id) || affinity.isOffscreen || affinity.isEphemeral;
        });
        const managedCount = validManaged.length;
        if (managedCount > 1) {
          const tabNames = validManaged.map((id) => {
            const t = tabsMap.get(id);
            if (t) return t.title || t.url || 'Tab mới';
            return '🤖 Tab ngầm Agent (Headless / Sandbox)';
          }).join('\n• ');
          setBadgeState(badge, 'terminal-tab-affinity-badge multi', `🎯 ${managedCount} tabs`, `Terminal đang quản lý ${managedCount} tabs:\n• ${tabNames}\n(Click để quản lý nhóm tab)`);
        } else {
          const boundTab = tabsMap.get(affinity.tabId);
          if (boundTab) {
            const name = boundTab.title || boundTab.url || 'Tab mới';
            setBadgeState(badge, 'terminal-tab-affinity-badge', `🎯 ${name.slice(0, 14)}`, `Đang gắn với Tab: ${name} (${boundTab.url || ''}) (Click để đổi/thêm)`);
          } else if (affinity.isOffscreen || affinity.isEphemeral || affinity.status === 'alive') {
            const agentName = affinity.isOffscreen ? '🤖 Headless' : '🤖 Sandbox';
            setBadgeState(badge, 'terminal-tab-affinity-badge agent', agentName, `Terminal đang gắn với Tab ngầm Agent (Headless Sandbox: ${affinity.tabId}) (Click để gán tab hiển thị)`);
          } else {
            setBadgeState(badge, 'terminal-tab-affinity-badge closed', '🎯 Tab đã đóng', `Tab trước đó (${affinity.lastUrl || affinity.tabId}) đã bị đóng (Click để gán lại)`);
          }
        }
      }
    }
  } catch {}
}

async function showAffinityPicker(sessionId, anchorEl) {
  const popover = document.getElementById('affinityPickerPopover');
  if (!popover || !api?.getTabs) return;
  // A sleeping session has no PTY, so a browser tab bound to it has nowhere to send
  // input. Instead of refusing silently, the click becomes the wake gesture: the
  // session broadcast repaints the badge, and the user re-opens the picker once
  // the terminal is awake.
  if (isSessionSleeping(sessionId)) {
    wakeSleepingSession(sessionId, '');
    return;
  }

  const tabs = await api.getTabs();
  const currentAffinity = api.getTerminalAffinity ? await api.getTerminalAffinity(sessionId) : undefined;
  popover.innerHTML = '';
  popover.setAttribute('data-active-session-id', sessionId);
  const managedSet = new Set(Array.isArray(currentAffinity?.managedTabIds) ? currentAffinity.managedTabIds : (currentAffinity?.tabId ? [currentAffinity.tabId] : []));
  const primaryId = currentAffinity?.primaryTabId || currentAffinity?.tabId;
  // Rebuild signature: onTabsUpdated re-invokes this picker only when the set of
  // managed tabs, the primary, or the visible tab count actually changed — title
  // churn alone must not tear the DOM out from under a click.
  popover.setAttribute('data-managed-sig', `${Array.from(managedSet).sort().join(',')}|${primaryId || ''}|${(tabs || []).length}`);
  let renderedManagedCount = 0;

  // Section 1: Tab thuộc Terminal này
  if (managedSet.size > 0) {
    const secHeader = document.createElement('div');
    secHeader.className = 'terminal-affinity-picker-header';
    popover.appendChild(secHeader);
    (tabs || []).filter((t) => managedSet.has(t.id)).forEach((t) => {
      const item = document.createElement('div');
      const isPrimary = t.id === primaryId;
      item.className = `terminal-affinity-picker-item managed${isPrimary ? ' active' : ''}`;
      const tabIdx = (tabs || []).findIndex((x) => x.id === t.id);
      const indexStr = tabIdx >= 0 ? `#${tabIdx + 1} ` : '';
      const title = `${indexStr}${t.title || t.url || t.id}`;

      const leftWrap = document.createElement('div');
      leftWrap.style.display = 'flex';
      leftWrap.style.alignItems = 'center';
      leftWrap.style.gap = '6px';
      leftWrap.style.overflow = 'hidden';

      const targetIcon = document.createElement('span');
      targetIcon.textContent = isPrimary ? '⭐' : '🎯';
      targetIcon.title = isPrimary ? 'Tab chính (Primary)' : 'Tab phụ (Child)';

      const textSpan = document.createElement('span');
      textSpan.style.overflow = 'hidden';
      textSpan.style.textOverflow = 'ellipsis';
      textSpan.textContent = title;
      leftWrap.append(targetIcon, textSpan);

      const actionWrap = document.createElement('div');
      actionWrap.style.display = 'flex';
      actionWrap.style.alignItems = 'center';
      actionWrap.style.gap = '4px';

      const copyBtn = document.createElement('span');
      copyBtn.className = 'affinity-item-copy-btn';
      copyBtn.textContent = '📋';
      copyBtn.title = `Sao chép Tab ID cho Agent (${t.id})`;
      copyBtn.onclick = (ev) => {
        ev.stopPropagation();
        if (api?.copyToClipboard) {
          api.copyToClipboard(t.id);
        } else {
          navigator.clipboard?.writeText(t.id);
        }
        copyBtn.textContent = '✅';
        setTimeout(() => { copyBtn.textContent = '📋'; }, 1200);
      };

      const removeBtn = document.createElement('span');
      removeBtn.className = 'affinity-item-remove-btn';
      removeBtn.textContent = '✕';
      removeBtn.title = 'Gỡ tab này khỏi Terminal';
      removeBtn.onclick = async (ev) => {
        ev.stopPropagation();
        if (api?.removeTabAffinity) {
          await api.removeTabAffinity(t.id, sessionId);
          updateAffinityBadges();
          showAffinityPicker(sessionId, anchorEl);
        }
      };

      actionWrap.append(copyBtn, removeBtn);
      item.append(leftWrap, actionWrap);
      item.title = `${title} (${t.url}) - Click để chọn làm tab chính`;
      item.onclick = async (ev) => {
        ev.stopPropagation();
        popover.style.display = 'none';
        if (api?.rebindTerminalAffinity) {
          await api.rebindTerminalAffinity(t.id, sessionId);
          updateAffinityBadges();
        }
        // Rebind alone is invisible: bring the chosen tab to the front so the
        // user sees the tab they just made primary.
        api?.focusTab?.(t.id);
      };
      popover.appendChild(item);
      renderedManagedCount++;
    });

    // Headless/offscreen agent tabs are filtered out of getTabs(), so they can never match the
    // visible-tab loop above. Render them explicitly: Section 1 stays informative and the user
    // still gets a copy + unbind action instead of a dangling raw UUID.
    const visibleManagedIds = new Set((tabs || []).filter((t) => managedSet.has(t.id)).map((t) => t.id));
    Array.from(managedSet).filter((id) => !visibleManagedIds.has(id)).forEach((hiddenId) => {
      const item = document.createElement('div');
      const isPrimary = hiddenId === primaryId;
      item.className = `terminal-affinity-picker-item managed agent${isPrimary ? ' active' : ''}`;

      const leftWrap = document.createElement('div');
      leftWrap.style.display = 'flex';
      leftWrap.style.alignItems = 'center';
      leftWrap.style.gap = '6px';
      leftWrap.style.overflow = 'hidden';

      const agentIcon = document.createElement('span');
      agentIcon.textContent = '🤖';
      agentIcon.title = isPrimary ? 'Tab ngầm Agent (Primary)' : 'Tab ngầm Agent (Child)';

      const textSpan = document.createElement('span');
      textSpan.style.overflow = 'hidden';
      textSpan.style.textOverflow = 'ellipsis';
      textSpan.textContent = 'Tab ngầm Agent (Headless / Sandbox)';
      leftWrap.append(agentIcon, textSpan);

      const actionWrap = document.createElement('div');
      actionWrap.style.display = 'flex';
      actionWrap.style.alignItems = 'center';
      actionWrap.style.gap = '4px';

      const copyBtn = document.createElement('span');
      copyBtn.className = 'affinity-item-copy-btn';
      copyBtn.textContent = '📋';
      copyBtn.title = `Sao chép Tab ID cho Agent (${hiddenId})`;
      copyBtn.onclick = (ev) => {
        ev.stopPropagation();
        if (api?.copyToClipboard) {
          api.copyToClipboard(hiddenId);
        } else {
          navigator.clipboard?.writeText(hiddenId);
        }
        copyBtn.textContent = '✅';
        setTimeout(() => { copyBtn.textContent = '📋'; }, 1200);
      };

      const removeBtn = document.createElement('span');
      removeBtn.className = 'affinity-item-remove-btn';
      removeBtn.textContent = '✕';
      removeBtn.title = 'Gỡ tab ngầm Agent khỏi Terminal';
      removeBtn.onclick = async (ev) => {
        ev.stopPropagation();
        if (api?.removeTabAffinity) {
          await api.removeTabAffinity(hiddenId, sessionId);
          updateAffinityBadges();
          showAffinityPicker(sessionId, anchorEl);
        }
      };

      actionWrap.append(copyBtn, removeBtn);
      item.append(leftWrap, actionWrap);
      item.title = `Tab ngầm Agent (Headless / Sandbox) - ${hiddenId}`;
      popover.appendChild(item);
      renderedManagedCount++;
    });

    if (renderedManagedCount > 0) {
      secHeader.textContent = `Tab thuộc Terminal này (${renderedManagedCount})`;
    } else {
      secHeader.remove();
    }
  }

  // Section 2: Gán thêm Tab khác
  const otherTabs = (tabs || []).filter((t) => !managedSet.has(t.id));
  const addHeader = document.createElement('div');
  addHeader.className = 'terminal-affinity-picker-header';
  const hasManaged = renderedManagedCount > 0;
  addHeader.style.marginTop = hasManaged ? '6px' : '0';
  addHeader.textContent = hasManaged ? 'Gán thêm Tab khác vào Terminal' : 'Gán Tab Trình Duyệt cho Terminal';
  popover.appendChild(addHeader);
  if (otherTabs.length === 0) {
    const empty = document.createElement('div');
    empty.style.padding = '8px 12px';
    empty.style.color = '#94a3b8';
    empty.style.fontSize = '11px';
    empty.textContent = managedSet.size > 0 ? 'Tất cả tab đang mở đều đã được gán' : 'Không có tab trình duyệt nào đang mở';
    popover.appendChild(empty);
  } else {
    otherTabs.forEach((t) => {
      const item = document.createElement('div');
      item.className = 'terminal-affinity-picker-item';
      const tabIdx = (tabs || []).findIndex((x) => x.id === t.id);
      const indexStr = tabIdx >= 0 ? `#${tabIdx + 1} ` : '';
      const title = `${indexStr}${t.title || t.url || t.id}`;
      const addIcon = document.createElement('span');
      addIcon.textContent = managedSet.size > 0 ? '➕' : '🎯';
      const textSpan = document.createElement('span');
      textSpan.style.overflow = 'hidden';
      textSpan.style.textOverflow = 'ellipsis';
      textSpan.textContent = title;
      item.append(addIcon, textSpan);
      item.title = `Gán tab này: ${title} (${t.url})`;
      item.onclick = async (ev) => {
        ev.stopPropagation();
        popover.style.display = 'none';
        if (managedSet.size > 0 && api?.adoptTabAffinity) {
          await api.adoptTabAffinity(t.id, sessionId);
        } else if (api?.rebindTerminalAffinity) {
          await api.rebindTerminalAffinity(t.id, sessionId);
        }
        updateAffinityBadges();
        // Same as the managed rows: the newly bound tab should come to the front
        // so the assignment is visible, not just recorded.
        api?.focusTab?.(t.id);
      };
      popover.appendChild(item);
    });
  }

  const rect = anchorEl.getBoundingClientRect();
  popover.style.display = 'block';
  popover.style.left = `${Math.max(10, Math.min(window.innerWidth - 280, rect.left))}px`;
  popover.style.top = `${rect.bottom + 4}px`;

  const closeHandler = (e) => {
    if (!popover.contains(e.target) && e.target !== anchorEl) {
      popover.style.display = 'none';
      document.removeEventListener('click', closeHandler);
    }
  };
  setTimeout(() => document.addEventListener('click', closeHandler), 10);
}

/**
 * Category picker, following the `showAffinityPicker` conventions: a detached
 * popover re-parented to the anchor's rect, click-outside dismissal on the next
 * tick, and the authoritative value coming from main's `session` broadcast.
 */
function showCategoryPicker(sessionId, anchorEl) {
  const popover = document.getElementById('categoryPickerPopover');
  if (!popover) return;

  const session = findSession(sessionId);
  const current = (session && typeof session.category === 'string') ? session.category.trim() : '';

  popover.innerHTML = '';
  popover.setAttribute('data-active-session-id', sessionId);

  const header = document.createElement('div');
  header.className = 'terminal-category-picker-header';
  header.textContent = 'Đặt nhóm cho Terminal này';
  popover.appendChild(header);

  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'terminal-category-picker-input';
  input.placeholder = 'Tên nhóm… (Enter để lưu)';
  input.value = current;
  input.spellcheck = false;
  popover.appendChild(input);

  // Reuse categories already in use so grouping stays consistent and typo-free.
  // Explicitly created groups are offered too, even when empty: otherwise a group
  // that exists only in the registry could never be assigned from here.
  const known = terminalCategories.slice();
  for (const s of (Array.isArray(sessions) ? sessions : [])) {
    const c = (s && typeof s.category === 'string') ? s.category.trim() : '';
    if (c && !known.includes(c)) known.push(c);
  }
  if (known.length > 0) {
    known.forEach((name) => {
      const item = document.createElement('div');
      item.className = `terminal-category-picker-item${name === current ? ' active' : ''}`;
      item.setAttribute('data-category', name);
      const dot = document.createElement('span');
      dot.className = 'terminal-category-picker-dot';
      dot.style.background = categoryColorOf(name);
      const label = document.createElement('span');
      label.className = 'terminal-category-picker-name';
      label.textContent = name;
      item.append(dot, label);
      item.title = `Gán tab này vào nhóm "${name}"`;
      item.onclick = (ev) => {
        ev.stopPropagation();
        applyCategoryToSession(sessionId, name, popover);
      };
      popover.appendChild(item);
    });
  }

  const clearItem = document.createElement('div');
  clearItem.className = 'terminal-category-picker-item clear';
  clearItem.setAttribute('data-category-clear', '1');
  clearItem.textContent = '✕ Bỏ nhóm (Uncategorised)';
  clearItem.title = 'Đưa tab về nhóm "Chưa phân nhóm"';
  clearItem.onclick = (ev) => {
    ev.stopPropagation();
    applyCategoryToSession(sessionId, '', popover);
  };
  popover.appendChild(clearItem);

  input.addEventListener('click', (e) => e.stopPropagation());
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') {
      e.preventDefault();
      applyCategoryToSession(sessionId, input.value, popover);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      popover.style.display = 'none';
    }
  });

  const rect = anchorEl.getBoundingClientRect();
  popover.style.display = 'block';
  popover.style.left = `${Math.max(10, Math.min(window.innerWidth - 240, rect.left))}px`;
  popover.style.top = `${rect.bottom + 4}px`;

  const closeHandler = (e) => {
    if (!popover.contains(e.target) && e.target !== anchorEl) {
      popover.style.display = 'none';
      document.removeEventListener('click', closeHandler);
    }
  };
  setTimeout(() => document.addEventListener('click', closeHandler), 10);

  try { input.focus(); } catch {}
}

/**
 * Optimistically move a session into a category and hand it to main. The local
 * mutation only repaints immediately; the `session` broadcast that follows is
 * what the grouping is really derived from.
 */
function applyCategoryToSession(sessionId, rawCategory, popover) {
  // A pane has no group of its own: the group chosen for a pane is the group of the tab
  // that owns it, so the whole family moves and the sidebar can never show a pane filed
  // somewhere its parent is not.
  const baseId = findSession(sessionId)?.splitOf || sessionId;
  const category = typeof rawCategory === 'string' ? rawCategory.trim() : '';
  if (popover) popover.style.display = 'none';
  // A name typed here becomes a durable group, not just a value on one tab, so it is
  // registered in the group list as well and survives that tab being closed.
  const isNewName = Boolean(category)
    && !terminalCategories.some((name) => name.toLowerCase() === category.toLowerCase());
  if (isNewName) terminalCategories.push(category);
  const session = findSession(baseId);
  if (session) session.category = category || undefined;
  if (Array.isArray(sessions)) {
    for (const s of sessions) {
      if (s && s.splitOf === baseId) s.category = category || undefined;
    }
  }
  if (typeof renderTabs === 'function') renderTabs();
  if (isNewName) persistTerminalTabPrefs();
  try {
    api?.setCategory?.(baseId, category || undefined);
  } catch {}
}

// ---------------------------------------------------------------------------
// Moving a terminal to a project (capsule).
//
// A terminal is owned by the window it runs in, and only Main moves it. The assignment is two
// calls on purpose: the route that performs the move never opens a window, so the target
// project has to be opened first — otherwise the move is refused as "no live window owns that
// project" however many times it is retried. Nothing here reports success that Main did not
// answer.
// ---------------------------------------------------------------------------

/** How many rows the picker paints at once. The store holds hundreds of capsules, and a
 *  filtered list is what the field is for; the remainder is named in the hint instead of
 *  being silently dropped. */
const CAPSULE_PICKER_MAX_ROWS = 80;

/** Sessions with an assignment round-trip in flight, so a second pick cannot fire a
 *  second move for the same terminal while the first is still being answered. */
const capsuleAssignmentsInFlight = new Set();

/** Closes the picker view that is open, if any. Every open replaces the shared popover element,
 *  so the previous view's document listeners are released here instead of being left attached to
 *  a surface whose nodes no longer exist. */
let activeCapsulePickerClose = null;

/** Main's refusal codes, in the user's language. Anything unnamed is shown verbatim
 *  rather than replaced by a guess. */
const ASSIGN_REFUSAL_TEXT = {
  INVALID_PAYLOAD: 'Yêu cầu chuyển Terminal không hợp lệ',
  PROJECT_UNAVAILABLE: 'Dự án không còn tồn tại hoặc hồ sơ workspace đang bị trùng, chưa xác định được đích',
  TARGET_WINDOW_ABSENT: 'Cửa sổ của dự án đích chưa mở',
  UNKNOWN_SESSION: 'Terminal này đã đóng hoặc không còn tồn tại',
  TRANSFER_UNAVAILABLE: 'Tiến trình hiện tại không chuyển được Terminal',
  MANAGER_AGENT_SESSION_READ_ONLY: 'Terminal do agent sở hữu chỉ được xem, không chuyển được',
  RUNTIME_DRAINING: 'Ứng dụng đang thoát nên không nhận thêm yêu cầu',
  TARGET_STALE: 'Cửa sổ đích vừa đóng',
};

function assignRefusalText(reason, message) {
  if (typeof reason === 'string' && ASSIGN_REFUSAL_TEXT[reason]) return ASSIGN_REFUSAL_TEXT[reason];
  if (typeof message === 'string' && message) return message;
  if (typeof reason === 'string' && reason) return reason;
  return 'không rõ nguyên nhân';
}

/** The message of whatever a rejected bridge call threw, as text. The `message` property is
 *  read rather than trusted to `instanceof`: an error raised on the other side of the isolated
 *  world is not an instance of this realm's `Error`, and `String(err)` would prefix it with
 *  "Error:" — text meant for the user, not for a log. */
function bridgeErrorText(err) {
  if (typeof err === 'string') return err;
  if (err && typeof err === 'object' && typeof err.message === 'string' && err.message) return err.message;
  return String(err);
}

/** The project whose window has to exist before a capsule can receive a terminal. */
function capsuleProjectIdOf(entry) {
  return entry && typeof entry.projectId === 'string' ? entry.projectId.trim() : '';
}

/**
 * True when an agent, not a window, owns the session. Those rows are readable from any shell —
 * the manager included — but are never moved to another project.
 */
function isAgentOwnedSession(session) {
  return Boolean(session && typeof session.ownerKey === 'string' && session.ownerKey.startsWith('agent:'));
}

/** Capsule names in the order a Vietnamese reader expects, with a plain fallback for a
 *  process whose collation data is unavailable. */
function compareCapsuleNames(a, b) {
  try {
    return a.name.localeCompare(b.name, 'vi', { sensitivity: 'base', numeric: true });
  } catch {
    return a.name < b.name ? -1 : (a.name > b.name ? 1 : 0);
  }
}


/**
 * The searchable project picker.
 *
 * Uses the same Main-owned project inventory as Open Project, never the historical
 * capsule store. Main reports whether each project's ownership can be resolved safely.
 */
function showCapsulePicker(sessionId, anchorEl) {
  const popover = document.getElementById('capsulePickerPopover');
  if (!popover) return;

  const session = findSession(sessionId);
  const currentCapsuleId = capsuleIdOf(session);
  const currentOwner = typeof session?.ownerKey === 'string' ? session.ownerKey : '';
  const currentProjectId = currentOwner.startsWith('project:') ? currentOwner.slice('project:'.length) : '';

  if (activeCapsulePickerClose) activeCapsulePickerClose();
  popover.innerHTML = '';
  // `innerHTML = ''` is the browser's own clear; detaching the children as well is what keeps a
  // DOM that does not implement the parse step (the test harness's stub) from accumulating the
  // previous view's nodes behind the new one, where a query would find the stale input.
  while (popover.firstChild) popover.removeChild(popover.firstChild);
  popover.setAttribute('data-active-session-id', sessionId);

  const header = document.createElement('div');
  header.className = 'terminal-capsule-picker-header';
  header.textContent = 'Chuyển Terminal sang Dự án';
  popover.appendChild(header);

  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'terminal-capsule-picker-input';
  input.placeholder = 'Tìm dự án… (tên hoặc đường dẫn)';
  input.spellcheck = false;
  input.setAttribute('aria-label', 'Tìm dự án để chuyển Terminal');
  popover.appendChild(input);

  const hint = document.createElement('div');
  hint.className = 'terminal-capsule-picker-hint';
  popover.appendChild(hint);

  const list = document.createElement('div');
  list.className = 'terminal-capsule-picker-list';
  list.setAttribute('role', 'listbox');
  list.setAttribute('aria-label', 'Danh sách dự án');
  popover.appendChild(list);

  let entries = [];
  /** Rows that can actually be picked this paint, in paint order. */
  let pickable = [];
  let highlighted = -1;
  let closed = false;

  const setHint = (text) => {
    if (hint.textContent !== text) hint.textContent = text;
  };

  /** Empty the row list. Same reasoning as the popover's own clear: repainting on every
   *  keystroke must not leave the previous rows behind in a DOM without `innerHTML`'s
   *  parse step, where they would still be queryable. */
  const clearList = () => {
    list.innerHTML = '';
    while (list.firstChild) list.removeChild(list.firstChild);
  };

  const isCurrentEntry = (entry) => currentProjectId
    ? entry.projectId === currentProjectId
    : Boolean(currentCapsuleId && entry.id === currentCapsuleId);
  const isPickableEntry = (entry) => !isCurrentEntry(entry) && Boolean(entry.projectId) && entry.canAssignTerminal !== false;

  const clearHighlight = () => {
    highlighted = -1;
    for (const row of pickable) {
      row.item.classList.remove('is-highlighted');
      row.item.setAttribute('aria-selected', 'false');
    }
  };

  const paintError = (text) => {
    clearList();
    pickable = [];
    highlighted = -1;
    const item = document.createElement('div');
    item.className = 'terminal-capsule-picker-item is-error';
    item.textContent = text;
    list.appendChild(item);
    setHint('Không đọc được danh sách dự án');
  };

  const paint = () => {
    const tokens = parseSearchTokens(input.value);
    const query = input.value.trim();
    const matched = entries.filter((entry) => tokens.every((token) => tokenMatchesHaystack(
      token,
      `${foldForSearch(entry.name)} ${foldForSearch(entry.workspacePath)}`,
    )));
    const shown = matched.slice(0, CAPSULE_PICKER_MAX_ROWS);

    clearList();
    pickable = [];
    highlighted = -1;
    for (const entry of shown) {
      const item = document.createElement('div');
      item.className = 'terminal-capsule-picker-item';
      item.setAttribute('data-project-id', entry.projectId);
      if (entry.id) item.setAttribute('data-capsule-id', entry.id);
      item.setAttribute('role', 'option');
      item.setAttribute('aria-selected', 'false');

      const dot = document.createElement('span');
      dot.className = 'terminal-capsule-picker-dot';
      dot.style.background = derivedCategoryColorOf(entry.projectId);
      const name = document.createElement('span');
      name.className = 'terminal-capsule-picker-name';
      name.textContent = entry.name;
      item.append(dot, name);
      if (entry.workspacePath) {
        const pathEl = document.createElement('span');
        pathEl.className = 'terminal-capsule-picker-path';
        pathEl.textContent = entry.workspacePath;
        item.appendChild(pathEl);
      }

      if (isCurrentEntry(entry)) {
        item.classList.add('active', 'is-disabled');
        item.setAttribute('aria-disabled', 'true');
        const current = document.createElement('span');
        current.className = 'terminal-capsule-picker-current';
        current.textContent = '✓ Hiện tại';
        item.appendChild(current);
        item.title = 'Terminal này đang thuộc dự án này';
      } else if (!isPickableEntry(entry)) {
        item.classList.add('is-disabled');
        item.setAttribute('aria-disabled', 'true');
        const blocked = document.createElement('span');
        blocked.className = 'terminal-capsule-picker-blocked';
        blocked.textContent = 'hồ sơ dự án không rõ ràng';
        item.appendChild(blocked);
        item.title = 'Hồ sơ workspace của dự án cần được xác định rõ trước khi nhận Terminal';
      } else {
        item.setAttribute('aria-disabled', 'false');
        item.title = `Mở cửa sổ dự án “${entry.name}” rồi chuyển Terminal này sang đó`;
        item.onclick = (ev) => {
          ev.stopPropagation();
          pick(entry);
        };
        pickable.push({ entry, item });
      }
      list.appendChild(item);
    }

    if (shown.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'terminal-capsule-picker-item is-empty';
      empty.textContent = query
        ? `Không có dự án nào khớp “${query}”`
        : 'Chưa có dự án nào trong máy này';
      list.appendChild(empty);
      setHint(query ? `0/${entries.length} dự án khớp` : '0 dự án');
      return;
    }

    const currentLabel = entries.find(isCurrentEntry)?.name || '';
    const shownNote = matched.length > shown.length ? ` — hiển thị ${shown.length}/${matched.length}` : '';
    const hintParts = query
      ? [`${matched.length}/${entries.length} dự án khớp “${query}”${shownNote}`]
      : [`${entries.length} dự án${currentLabel ? ` — hiện tại: ${currentLabel}` : ''}${shownNote}`];
    setHint(hintParts.join(' — '));
  };

  const moveHighlight = (delta) => {
    if (pickable.length === 0) return;
    clearHighlight();
    highlighted = (highlighted + delta + pickable.length) % pickable.length;
    const row = pickable[highlighted];
    if (!row) return;
    row.item.classList.add('is-highlighted');
    row.item.setAttribute('aria-selected', 'true');
    // `scrollIntoView` keeps the keyboard cursor visible inside the scrolling list. Guarded
    // because a non-browser context (the test harness) has no layout to scroll.
    if (typeof row.item.scrollIntoView === 'function') {
      try { row.item.scrollIntoView({ block: 'nearest' }); } catch {}
    }
  };

  const close = () => {
    if (closed) return;
    closed = true;
    popover.style.display = 'none';
    document.removeEventListener('keydown', onDocumentKeydown);
    document.removeEventListener('click', onDocumentClick);
    if (activeCapsulePickerClose === close) activeCapsulePickerClose = null;
  };

  const onDocumentClick = (e) => {
    if (!popover.contains(e.target) && e.target !== anchorEl) close();
  };
  const onDocumentKeydown = (e) => {
    if (e.key === 'Escape') close();
  };

  const pick = (entry) => {
    close();
    void assignSessionToCapsule(sessionId, entry);
  };

  input.addEventListener('click', (e) => e.stopPropagation());
  input.addEventListener('input', () => {
    highlighted = -1;
    paint();
  });
  input.addEventListener('keydown', (e) => {
    // The strip's own shortcuts must not act on a keystroke typed into this field.
    e.stopPropagation();
    if (e.key === 'Enter') {
      e.preventDefault();
      // Enter picks the keyboard cursor, or the first pickable row when the user is typing
      // and has not moved it: "type three letters, press Enter" is the fast path.
      const row = pickable[highlighted] || pickable[0];
      if (row) pick(row.entry);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      close();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      moveHighlight(1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      moveHighlight(-1);
    }
  });

  const rect = anchorEl && typeof anchorEl.getBoundingClientRect === 'function'
    ? anchorEl.getBoundingClientRect()
    : null;
  popover.style.display = 'block';
  const popoverWidth = popover.offsetWidth || 300;
  const popoverHeight = popover.offsetHeight || 320;
  const left = Math.max(10, Math.min(window.innerWidth - popoverWidth - 10, rect ? rect.left : 10));
  // This popover is taller than the other two, so "below the row" alone parks its list off the
  // bottom edge: it flips above the anchor when it does not fit and is clamped when neither
  // side has room.
  const below = rect ? rect.bottom + 4 : 10;
  const above = rect ? rect.top - popoverHeight - 4 : 10;
  const top = (below + popoverHeight > window.innerHeight - 10 && above > 10) ? above : below;
  popover.style.left = `${Math.round(left)}px`;
  popover.style.top = `${Math.round(Math.max(10, Math.min(top, window.innerHeight - popoverHeight - 10)))}px`;

  setTimeout(() => {
    if (closed) return;
    document.addEventListener('click', onDocumentClick);
    document.addEventListener('keydown', onDocumentKeydown);
  }, 10);
  activeCapsulePickerClose = close;

  setHint('Đang tải danh sách dự án…');
  if (isSharedManagerShell()) {
    void ensureCapsuleIndex(true).then((changed) => {
      if (changed) renderTabs();
    });
  }
  void (async () => {
    try {
      if (!api?.listProjects) throw new Error('preload thiếu listProjects');
      const reply = await api.listProjects();
      if (closed) return;
      if (!Array.isArray(reply?.candidates)) throw new Error('Danh sách dự án trả về không hợp lệ');
      entries = reply.candidates.map((project) => ({
        id: project.capsuleId || '',
        projectId: project.projectId,
        canAssignTerminal: project.canAssignTerminal,
        name: project.name,
        workspacePath: project.workspacePath || '',
      })).sort(compareCapsuleNames);
      paint();
    } catch (err) {
      if (!closed) paintError(bridgeErrorText(err));
    }
  })();

  try { input.focus(); } catch {}
}

// ---------------------------------------------------------------------------
// The in-window "Mở dự án" picker.
//
// Main pushes `PROJECT_OPEN_PICKER` with a requestId when something in this window asks to
// open a project without naming one; this modal is what answers it. One click on a row is
// the answer — the id, the folder chooser, or a dismissal goes back over
// `PROJECT_OPEN_PICKER_ANSWER` and Main maps it through the same choice the native dialog
// would have produced. The requestId is echoed verbatim: it is the only thing that ties
// this answer to the request Main is waiting on.
// ---------------------------------------------------------------------------

const projectOpenOverlay = document.getElementById('projectOpenOverlay');
const projectOpenInput = document.getElementById('projectOpenInput');
const projectOpenResults = document.getElementById('projectOpenResults');
const projectOpenFolderBtn = document.getElementById('projectOpenFolder');
const projectOpenCancelBtn = document.getElementById('projectOpenCancel');
const projectOpenSubtitle = document.getElementById('projectOpenSubtitle');

/** The request this modal is answering right now, or '' when closed. */
let projectOpenRequestId = '';
/** Candidate rows in paint order (the same entries the row elements point at). */
let projectOpenCandidates = [];
let projectOpenRowElements = [];
/**
 * The candidates in the SAME order as `projectOpenRowElements`. A filter repaints both,
 * so the keyboard cursor indexes the list the user can see: reading the raw inventory here
 * would answer Enter with whatever project the filter pushed off screen.
 */
let projectOpenRowCandidates = [];
let projectOpenActiveIndex = -1;
/** The element that held focus before the modal took it, restored on close. */
let projectOpenReturnFocus = null;
/** Row-level CRUD states: at most one row is renaming or confirming removal at a time. */
let projectOpenRenamingId = '';
let projectOpenRemovingId = '';
/** The live-session count a CONFIRM_REQUIRED answer quoted, for the confirm strip's text. */
let projectOpenRemoveLive = 0;
/** Row-level error text after a refused rename/remove: `{ projectId, text }`. */
let projectOpenRowError = null;

/** The interactive elements Tab cycles through while the modal is up. */
function projectOpenFocusables() {
  const rowControls = projectOpenResults
    ? Array.from(projectOpenResults.querySelectorAll('.project-open-row-action, .project-open-row-rename-input, .project-open-row-confirm-btn'))
    : [];
  return [projectOpenInput, projectOpenFolderBtn, projectOpenCancelBtn, ...rowControls].filter(Boolean);
}
/** One answer per request: the payload leaves exactly once, then the modal closes. */
function answerProjectOpen(choice) {
  if (!projectOpenRequestId) return;
  const payload = { requestId: projectOpenRequestId, choice };
  projectOpenRequestId = '';
  hideProjectOpenPicker();
  // The invoke's result is deliberately unread: Main ignores late and duplicate answers,
  // and the modal has already told the user the picker is done.
  Promise.resolve(api?.answerProjectOpenPicker?.(payload)).catch(() => {});
}

function hideProjectOpenPicker() {
  if (projectOpenOverlay) projectOpenOverlay.style.display = 'none';
  projectOpenRequestId = '';
  projectOpenCandidates = [];
  projectOpenRowElements = [];
  projectOpenRowCandidates = [];
  projectOpenActiveIndex = -1;
  projectOpenRenamingId = '';
  projectOpenRemovingId = '';
  projectOpenRemoveLive = 0;
  projectOpenRowError = null;
  if (projectOpenSubtitle) {
    projectOpenSubtitle.style.display = 'none';
    projectOpenSubtitle.textContent = '';
  }
  const returnTo = projectOpenReturnFocus;
  projectOpenReturnFocus = null;
  // Focus goes back to whatever had it: the modal took it once, it gives it back once.
  if (returnTo && typeof returnTo.focus === 'function' && document.contains && document.contains(returnTo)) {
    try { returnTo.focus(); } catch {}
  }
}

/** Highlighted row state: the keyboard cursor, painted as the row the user can see. */
function setProjectOpenActive(index) {
  projectOpenActiveIndex = index;
  for (let i = 0; i < projectOpenRowElements.length; i += 1) {
    const el = projectOpenRowElements[i];
    if (!el) continue;
    const selected = i === index;
    el.classList.toggle('is-highlighted', selected);
    el.setAttribute('aria-selected', selected ? 'true' : 'false');
  }
  if (projectOpenInput) {
    if (index >= 0) projectOpenInput.setAttribute('aria-activedescendant', `projectOpenOption${index}`);
    else projectOpenInput.removeAttribute('aria-activedescendant');
  }
  const active = index >= 0 ? projectOpenRowElements[index] : null;
  if (active && typeof active.scrollIntoView === 'function') {
    try { active.scrollIntoView({ block: 'nearest' }); } catch {}
  }
}

function moveProjectOpenActive(delta) {
  if (projectOpenRowElements.length === 0) return;
  const next = projectOpenActiveIndex < 0
    ? (delta > 0 ? 0 : projectOpenRowElements.length - 1)
    : (projectOpenActiveIndex + delta + projectOpenRowElements.length) % projectOpenRowElements.length;
  setProjectOpenActive(next);
}

/** The single state row when the list cannot offer rows: loading, empty, filtered-empty, error. */
function paintProjectOpenMessage(state, text) {
  if (!projectOpenResults) return;
  projectOpenResults.textContent = '';
  while (projectOpenResults.firstChild) projectOpenResults.removeChild(projectOpenResults.firstChild);
  projectOpenRowElements = [];
  projectOpenRowCandidates = [];
  projectOpenActiveIndex = -1;
  projectOpenResults.dataset.state = state;
  const el = document.createElement('div');
  el.className = 'project-open-message';
  el.textContent = text;
  projectOpenResults.appendChild(el);
}

/**
 * Row markup is built with createElement/textContent, never an HTML string: names and
 * paths are project data, and a picker surface is exactly where untrusted text would
 * otherwise be re-parsed as markup.
 */
function paintProjectOpenRows() {
  if (!projectOpenResults) return;
  const query = projectOpenInput ? projectOpenInput.value : '';
  const tokens = parseSearchTokens(query);
  const matched = projectOpenCandidates.filter((candidate) => tokens.every((token) => tokenMatchesHaystack(
    token,
    `${foldForSearch(candidate.name)} ${foldForSearch(candidate.workspacePath)} ${foldForSearch(candidate.projectId)}`,
  )));
  if (matched.length === 0) {
    paintProjectOpenMessage(query ? 'no-results' : 'empty', query
      ? `Không có dự án nào khớp “${query}”`
      : 'Chưa có dự án nào — chọn một thư mục để mở nó thành dự án mới');
    return;
  }
  projectOpenResults.textContent = '';
  while (projectOpenResults.firstChild) projectOpenResults.removeChild(projectOpenResults.firstChild);
  projectOpenRowElements = [];
  projectOpenRowCandidates = matched;
  matched.forEach((candidate, index) => {
    const row = document.createElement('div');
    row.className = `project-open-row${candidate.isCurrent ? ' is-current' : ''}`;
    row.id = `projectOpenOption${index}`;
    row.setAttribute('role', 'option');
    row.setAttribute('aria-selected', 'false');
    row.setAttribute('data-project-id', candidate.projectId);

    const mainEl = document.createElement('div');
    mainEl.className = 'project-open-row-main';
    row.appendChild(mainEl);

    const isRenaming = projectOpenRenamingId === candidate.projectId;
    const isRemoving = projectOpenRemovingId === candidate.projectId;
    const rowError = projectOpenRowError && projectOpenRowError.projectId === candidate.projectId
      ? projectOpenRowError.text
      : '';

    if (isRenaming) {
      // Inline rename: the input replaces the row's name line; Enter commits through
      // the bridge, Esc/click-out abandons the edit. A refused commit keeps the input
      // up with the reason on its title so the user corrects rather than restarts.
      const renameInput = document.createElement('input');
      renameInput.type = 'text';
      renameInput.className = `project-open-row-rename-input${rowError ? ' is-error' : ''}`;
      renameInput.value = candidate.name || '';
      renameInput.setAttribute('aria-label', `Đổi tên ${candidate.name || candidate.projectId}`);
      if (rowError) renameInput.setAttribute('title', rowError);
      renameInput.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          void commitProjectRename(candidate, renameInput.value);
        }
      });
      mainEl.appendChild(renameInput);
      if (rowError) {
        const errorEl = document.createElement('div');
        errorEl.className = 'project-open-row-error';
        errorEl.textContent = rowError;
        mainEl.appendChild(errorEl);
      }
      try { renameInput.focus(); } catch {}
    } else if (isRemoving) {
      // Inline confirm strip: removal always asks once inside the row — with live
      // terminals it quotes the count Main reported, without it the prompt is the
      // one destructive-action confirmation the row owes the user.
      const confirmWrap = document.createElement('div');
      confirmWrap.className = 'project-open-row-confirm';
      const confirmText = document.createElement('span');
      confirmText.className = 'project-open-row-confirm-text';
      confirmText.textContent = projectOpenRemoveLive > 0
        ? `Đóng ${projectOpenRemoveLive} Terminal đang chạy và bỏ “${candidate.name}” khỏi danh sách?`
        : `Bỏ “${candidate.name}” khỏi danh sách? (Không xoá thư mục)`;
      confirmWrap.appendChild(confirmText);
      const confirmBtn = document.createElement('button');
      confirmBtn.type = 'button';
      confirmBtn.className = 'project-open-row-confirm-btn is-danger';
      confirmBtn.textContent = 'Bỏ khỏi danh sách';
      confirmBtn.addEventListener('click', (event) => {
        event.stopPropagation();
        void confirmProjectRemove(candidate);
      });
      confirmWrap.appendChild(confirmBtn);
      const cancelBtn = document.createElement('button');
      cancelBtn.type = 'button';
      cancelBtn.className = 'project-open-row-confirm-btn';
      cancelBtn.textContent = 'Huỷ';
      cancelBtn.addEventListener('click', (event) => {
        event.stopPropagation();
        projectOpenRemovingId = '';
        projectOpenRowError = null;
        paintProjectOpenRows();
      });
      confirmWrap.appendChild(cancelBtn);
      mainEl.appendChild(confirmWrap);
      if (rowError) {
        const errorEl = document.createElement('div');
        errorEl.className = 'project-open-row-error';
        errorEl.textContent = rowError;
        mainEl.appendChild(errorEl);
      }
    } else {
      const nameEl = document.createElement('div');
      nameEl.className = 'project-open-row-name';
      nameEl.textContent = candidate.name || candidate.projectId;
      mainEl.appendChild(nameEl);
      if (candidate.isCurrent) {
        const currentEl = document.createElement('span');
        currentEl.className = 'project-open-row-current';
        currentEl.textContent = '✓ Hiện tại';
        nameEl.appendChild(document.createTextNode(' '));
        nameEl.appendChild(currentEl);
      }
      if (rowError) {
        const errorEl = document.createElement('div');
        errorEl.className = 'project-open-row-error';
        errorEl.textContent = rowError;
        mainEl.appendChild(errorEl);
      }
    }

    const pathEl = document.createElement('div');
    pathEl.className = 'project-open-row-path';
    pathEl.textContent = candidate.workspacePath || '';
    mainEl.appendChild(pathEl);

    // Row actions ride the same row: rename edits inline, remove asks in place.
    // They are buttons so the actions are reachable by Tab and by focus-visible,
    // and their clicks stop before the row's own pick handler.
    if (!isRemoving && !isRenaming) {
      const actions = document.createElement('div');
      actions.className = 'project-open-row-actions';
      const renameBtn = document.createElement('button');
      renameBtn.type = 'button';
      renameBtn.className = 'project-open-row-action';
      renameBtn.setAttribute('aria-label', `Đổi tên ${candidate.name || candidate.projectId}`);
      renameBtn.setAttribute('title', 'Đổi tên dự án');
      renameBtn.textContent = '✎';
      renameBtn.addEventListener('click', (event) => {
        event.stopPropagation();
        beginProjectRename(candidate);
      });
      actions.appendChild(renameBtn);
      const removeBtn = document.createElement('button');
      removeBtn.type = 'button';
      removeBtn.className = 'project-open-row-action is-danger';
      removeBtn.setAttribute('aria-label', `Bỏ ${candidate.name || candidate.projectId} khỏi danh sách`);
      removeBtn.setAttribute('title', 'Bỏ dự án khỏi danh sách (không xoá thư mục)');
      removeBtn.textContent = '✕';
      removeBtn.addEventListener('click', (event) => {
        event.stopPropagation();
        void beginProjectRemove(candidate);
      });
      actions.appendChild(removeBtn);
      row.appendChild(actions);
    }

    row.addEventListener('mouseenter', () => setProjectOpenActive(index));
    // One click is the whole interaction: the answer leaves on the click, there is no
    // selection-then-confirm step for a second click to complete. A row mid-edit —
    // renaming or mid-confirm — never answers a pick.
    if (!isRenaming && !isRemoving) {
      row.addEventListener('click', () => {
        answerProjectOpen({ kind: 'project', projectId: candidate.projectId });
      });
    }
    projectOpenResults.appendChild(row);
    projectOpenRowElements.push(row);
  });
  projectOpenResults.dataset.state = 'results';
  // The first row is highlighted, never picked: Enter opens what the user can see is
  // selected, and a click is what opens without the keyboard.
  setProjectOpenActive(0);
}

/** Two projects sharing a name are told apart by their paths — the subtitle says so. */
function paintProjectOpenSubtitle() {
  if (!projectOpenSubtitle) return;
  const seen = new Set();
  const collides = projectOpenCandidates.some((candidate) => {
    const name = candidate.name || candidate.projectId;
    if (seen.has(name)) return true;
    seen.add(name);
    return false;
  });
  projectOpenSubtitle.style.display = collides ? 'block' : 'none';
  projectOpenSubtitle.textContent = collides ? 'Các dự án trùng tên — hãy nhìn đường dẫn để chọn đúng dự án' : '';
}

/**
 * Put one row into its inline rename state. Another open edit or confirm is dropped
 * first: one row answers at a time keeps the state and the keyboard model simple.
 */
function beginProjectRename(candidate) {
  projectOpenRemovingId = '';
  projectOpenRowError = null;
  projectOpenRenamingId = candidate.projectId;
  paintProjectOpenRows();
}

/**
 * Commit the inline rename through Main's rename route. Success keeps the new name
 * in place and returns the row to normal; a refusal pins the reason to the input so
 * the user can fix it instead of losing the typed name.
 */
async function commitProjectRename(candidate, rawName) {
  const projectId = candidate.projectId;
  const next = typeof rawName === 'string' ? rawName.trim() : '';
  if (!next) {
    projectOpenRowError = { projectId, text: 'Tên dự án không được để trống' };
    paintProjectOpenRows();
    return;
  }
  if (next === candidate.name) {
    projectOpenRenamingId = '';
    projectOpenRowError = null;
    paintProjectOpenRows();
    return;
  }
  try {
    const result = await api?.renameProject?.({ projectId, name: next });
    if (projectOpenRenamingId !== projectId) return; // the modal moved on while the invoke was in flight
    const status = result && typeof result === 'object' ? result.status : '';
    if (status === 'RENAMED') {
      candidate.name = next;
      projectOpenRenamingId = '';
      projectOpenRowError = null;
      paintProjectOpenRows();
      paintProjectOpenSubtitle();
      return;
    }
    const reason = result && typeof result === 'object' && typeof result.reason === 'string' ? result.reason : '';
    projectOpenRowError = {
      projectId,
      text: status === 'UNKNOWN_PROJECT' ? 'Dự án này không còn tồn tại' : `Không đổi tên được${reason ? `: ${reason}` : ''}`,
    };
    paintProjectOpenRows();
  } catch (err) {
    if (projectOpenRenamingId !== projectId) return;
    projectOpenRowError = { projectId, text: `Không đổi tên được: ${err instanceof Error ? err.message : String(err)}` };
    paintProjectOpenRows();
  }
}

/**
 * The first remove ask. Main counts the live terminals it would interrupt: a project
 * with none moves straight to the row's inline confirm strip; one with live
 * terminals gets the same strip quoting that count. The strip — never the row click —
 * is what confirms.
 */
async function beginProjectRemove(candidate) {
  const projectId = candidate.projectId;
  projectOpenRenamingId = '';
  projectOpenRowError = null;
  projectOpenRemovingId = projectId;
  projectOpenRemoveLive = 0;
  paintProjectOpenRows();
  try {
    const result = await api?.removeProject?.({ projectId });
    if (projectOpenRemovingId !== projectId) return;
    const status = result && typeof result === 'object' ? result.status : '';
    if (status === 'REMOVED') {
      finishProjectRemove(candidate);
      return;
    }
    if (status === 'CONFIRM_REQUIRED') {
      projectOpenRemoveLive = typeof result.liveSessions === 'number' ? result.liveSessions : 0;
      paintProjectOpenRows();
      return;
    }
    projectOpenRemovingId = '';
    projectOpenRowError = {
      projectId,
      text: status === 'UNKNOWN_PROJECT'
        ? 'Dự án này không còn tồn tại'
        : `Không bỏ được${typeof result?.reason === 'string' && result.reason ? `: ${result.reason}` : ''}`,
    };
    paintProjectOpenRows();
  } catch (err) {
    if (projectOpenRemovingId !== projectId) return;
    projectOpenRemovingId = '';
    projectOpenRowError = { projectId, text: `Không bỏ được: ${err instanceof Error ? err.message : String(err)}` };
    paintProjectOpenRows();
  }
}

/**
 * The confirm strip's yes: the explicit `REMOVE_ANSWER` consent, carrying the id the
 * row names — `confirmed:true` on that channel is the only consent Main accepts.
 */
async function confirmProjectRemove(candidate) {
  const projectId = candidate.projectId;
  try {
    const result = await api?.answerProjectRemove?.({ projectId, confirmed: true });
    const status = result && typeof result === 'object' ? result.status : '';
    if (status === 'REMOVED') {
      finishProjectRemove(candidate);
      return;
    }
    projectOpenRemovingId = '';
    projectOpenRowError = {
      projectId,
      text: status === 'UNKNOWN_PROJECT'
        ? 'Dự án này không còn tồn tại'
        : `Không bỏ được${typeof result?.reason === 'string' && result.reason ? `: ${result.reason}` : ''}`,
    };
    paintProjectOpenRows();
  } catch (err) {
    projectOpenRemovingId = '';
    projectOpenRowError = { projectId, text: `Không bỏ được: ${err instanceof Error ? err.message : String(err)}` };
    paintProjectOpenRows();
  }
}

/** A reported removal drops the row from the inventory the modal paints. */
function finishProjectRemove(candidate) {
  projectOpenRemovingId = '';
  projectOpenRemoveLive = 0;
  projectOpenRowError = null;
  projectOpenCandidates = projectOpenCandidates.filter((entry) => entry.projectId !== candidate.projectId);
  paintProjectOpenRows();
  paintProjectOpenSubtitle();
}

/**
 * Open the modal for one pushed request. A push that arrives while another request is
 * still open supersedes it: the older request is answered as dismissed first, so Main is
 * never left waiting on a modal this surface already replaced.
 */
async function openProjectOpenPicker(payload) {
  if (!projectOpenOverlay || !api?.answerProjectOpenPicker) return;
  const requestId = payload && typeof payload === 'object' && typeof payload.requestId === 'string'
    ? payload.requestId
    : '';
  if (!requestId) return;
  if (projectOpenRequestId) answerProjectOpen({ kind: 'cancelled' });
  projectOpenRequestId = requestId;
  projectOpenRenamingId = '';
  projectOpenRemovingId = '';
  projectOpenRemoveLive = 0;
  projectOpenRowError = null;
  projectOpenReturnFocus = document.activeElement || null;
  projectOpenOverlay.style.display = 'flex';
  if (projectOpenInput) {
    projectOpenInput.value = '';
    projectOpenInput.removeAttribute('aria-activedescendant');
  }
  paintProjectOpenMessage('loading', 'Đang tải danh sách dự án…');
  document.addEventListener('keydown', onProjectOpenKeydown, true);
  try { projectOpenInput?.focus(); } catch {}

  projectOpenCandidates = [];
  try {
    const result = await api?.listProjects?.();
    // A newer request may have replaced this one while the inventory was in flight:
    // only the request still on screen may repaint.
    if (projectOpenRequestId !== requestId) return;
    const raw = result && typeof result === 'object' && Array.isArray(result.candidates) ? result.candidates : [];
    projectOpenCandidates = raw
      .filter((candidate) => candidate && typeof candidate === 'object' && typeof candidate.projectId === 'string' && candidate.projectId)
      .map((candidate) => ({
        projectId: candidate.projectId,
        name: typeof candidate.name === 'string' && candidate.name ? candidate.name : candidate.projectId,
        workspacePath: typeof candidate.workspacePath === 'string' ? candidate.workspacePath : '',
        isCurrent: candidate.isCurrent === true,
      }));
    paintProjectOpenRows();
    paintProjectOpenSubtitle();
  } catch {
    if (projectOpenRequestId !== requestId) return;
    paintProjectOpenMessage('error', 'Không đọc được danh sách dự án — chọn thư mục hoặc huỷ');
  }
}

/**
 * Keyboard for the open modal: Esc dismisses, Enter picks the highlighted row, the arrows
 * move the highlight, and Tab cycles inside the modal rather than escaping to the chrome
 * behind it. Bound at document level in the capture phase so a focused xterm or strip
 * control cannot swallow the dismissal first.
 */
function onProjectOpenKeydown(e) {
  if (!projectOpenRequestId) return;
  if (e.key === 'Escape') {
    e.preventDefault();
    e.stopPropagation();
    if (projectOpenRenamingId || projectOpenRemovingId) {
      // Esc while editing backs out of the row state only — dismissing the whole
      // modal underneath an open edit would answer a pick request the user is still
      // in the middle of.
      projectOpenRenamingId = '';
      projectOpenRemovingId = '';
      projectOpenRowError = null;
      paintProjectOpenRows();
      return;
    }
    answerProjectOpen({ kind: 'cancelled' });
    return;
  }
  if (e.key === 'Enter') {
    // A focused footer button keeps its native click: Enter on "Chọn thư mục…" means the
    // folder chooser, not the highlighted row. Row controls (rename input, confirm
    // buttons, action buttons) keep their own Enter handling too.
    const focused = typeof document !== 'undefined' ? document.activeElement : null;
    if (focused === projectOpenFolderBtn || focused === projectOpenCancelBtn) return;
    if (focused && typeof focused.closest === 'function' && focused.closest('.project-open-row-action, .project-open-row-rename-input, .project-open-row-confirm-btn')) return;
    if (projectOpenRenamingId || projectOpenRemovingId) return;
    e.preventDefault();
    e.stopPropagation();
    const candidate = projectOpenRowCandidates[projectOpenActiveIndex];
    if (candidate) answerProjectOpen({ kind: 'project', projectId: candidate.projectId });
    return;
  }
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    e.stopPropagation();
    moveProjectOpenActive(e.key === 'ArrowDown' ? 1 : -1);
    return;
  }
  if (e.key === 'Tab') {
    const focusables = projectOpenFocusables();
    if (focusables.length === 0) return;
    const focused = typeof document !== 'undefined' ? document.activeElement : null;
    const index = focusables.indexOf(focused);
    e.preventDefault();
    e.stopPropagation();
    if (e.shiftKey) {
      const next = index <= 0 ? focusables[focusables.length - 1] : focusables[index - 1];
      try { next?.focus(); } catch {}
    } else {
      const next = index < 0 || index === focusables.length - 1 ? focusables[0] : focusables[index + 1];
      try { next?.focus(); } catch {}
    }
  }
}

projectOpenInput?.addEventListener('input', () => {
  if (!projectOpenRequestId) return;
  paintProjectOpenRows();
});
projectOpenFolderBtn?.addEventListener('click', () => answerProjectOpen({ kind: 'folder' }));
projectOpenCancelBtn?.addEventListener('click', () => answerProjectOpen({ kind: 'cancelled' }));
projectOpenOverlay?.addEventListener('click', (e) => {
  if (e.target === projectOpenOverlay) answerProjectOpen({ kind: 'cancelled' });
});
api?.onProjectOpenPicker?.((payload) => { void openProjectOpenPicker(payload); });


/**
 * Move one terminal into a capsule's window, as the user asked for it.
 *
 * Step one opens (or focuses) the project's window because the move route never opens one;
 * step two hands the session over. Only a reported OPENED/FOCUSED reaches step two, and only
 * Main's own answer is reported as success — a cancelled open and every refusal leave the row
 * where it is and say why.
 */
async function assignSessionToCapsule(sessionId, entry) {
  // A pane has no window of its own: the move is the tab's, so the whole family travels with it.
  const baseId = findSession(sessionId)?.splitOf || sessionId;
  const projectId = capsuleProjectIdOf(entry);
  const capsuleLabel = (entry && entry.name) || projectId;
  if (!api?.assignTerminalProject) {
    showTerminalNotice('Không chuyển được Terminal: preload thiếu assignTerminalProject');
    return false;
  }
  if (!api?.openProject) {
    showTerminalNotice('Không chuyển được Terminal: preload thiếu openProject');
    return false;
  }
  if (!projectId) {
    showTerminalNotice(`Không chuyển được sang “${capsuleLabel}”: dự án này chưa gắn hồ sơ dự án nên không mở được cửa sổ`);
    return false;
  }
  if (capsuleAssignmentsInFlight.has(baseId)) {
    showTerminalNotice('Đang chuyển Terminal này…', 'info');
    return false;
  }
  capsuleAssignmentsInFlight.add(baseId);
  showTerminalNotice(`Đang mở dự án “${capsuleLabel}”…`, 'info');
  try {
    let opened;
    try {
      opened = await api.openProject(projectId);
    } catch (err) {
      showTerminalNotice(`Không mở được dự án “${capsuleLabel}”: ${bridgeErrorText(err)}`);
      return false;
    }
    const status = opened && typeof opened === 'object' ? opened.status : '';
    if (status === 'CANCELLED') {
      showTerminalNotice(`Đã huỷ mở dự án “${capsuleLabel}” — Terminal vẫn ở lại đây`, 'info');
      return false;
    }
    if (status !== 'OPENED' && status !== 'FOCUSED') {
      const reason = opened && typeof opened === 'object' ? opened.reason : '';
      showTerminalNotice(`Không mở được dự án “${capsuleLabel}”: ${projectOpenFailureText(reason)}`);
      return false;
    }

    let reply;
    try {
      reply = await api.assignTerminalProject(baseId, projectId);
    } catch (err) {
      showTerminalNotice(`Không chuyển được Terminal sang “${capsuleLabel}”: ${bridgeErrorText(err)}`);
      return false;
    }
    if (reply && typeof reply === 'object' && reply.ok === true) {
      moveSessionToCapsuleLocally(baseId, reply.capsuleId, reply.ownerKey);
      showTerminalNotice(`Đã chuyển Terminal sang dự án “${capsuleLabel}”`, 'success');
      return true;
    }
    const reason = reply && typeof reply === 'object' ? reply.reason : '';
    const message = reply && typeof reply === 'object' ? reply.message : '';
    showTerminalNotice(`Không chuyển được Terminal sang “${capsuleLabel}”: ${assignRefusalText(reason, message)}`);
    return false;
  } finally {
    capsuleAssignmentsInFlight.delete(baseId);
  }
}

/**
 * File the row under its new capsule and repaint. A display update only: the `session`
 * broadcast that follows is what the grouping is really derived from, so a row Main still
 * reports in the old place goes back there on the next push.
 */
function moveSessionToCapsuleLocally(sessionId, capsuleId, ownerKey) {
  for (const session of sessions) {
    if (session.id !== sessionId && session.splitOf !== sessionId) continue;
    session.capsuleId = capsuleId;
    session.ownerKey = ownerKey;
  }
  if (typeof renderTabs === 'function') renderTabs();
}

function showContextMenu(e, sessionId) {
  e.preventDefault();
  e.stopPropagation();
  contextTargetSessionId = sessionId;
  if (!contextMenu) return;

  const targetSession = sessions.find((item) => item.id === sessionId);
  const isTargetSplit = Boolean(targetSession?.splitSessionId);
  const isTargetItselfSplit = Boolean(targetSession?.splitOf);
  const splitItem = contextMenu.querySelector('.context-item[data-action="split"]');
  if (splitItem) {
    const textSpan = splitItem.querySelector('span:last-child') || splitItem;
    if (isTargetItselfSplit) {
      textSpan.textContent = 'Pane chia đôi (Split)';
      splitItem.title = 'Tab này là một pane chia đôi; đóng nó bằng ✕ hoặc "Đóng tab này"';
    } else if (isTargetSplit) {
      textSpan.textContent = 'Đóng chia đôi (Unsplit)';
      splitItem.title = 'Tắt chia đôi màn hình terminal của tab này';
    } else {
      textSpan.textContent = 'Chia đôi tab (Split)';
      splitItem.title = 'Chia đôi màn hình terminal của tab này';
    }
    splitItem.classList.toggle('is-disabled', isTargetItselfSplit);
    splitItem.setAttribute('aria-disabled', isTargetItselfSplit ? 'true' : 'false');
  }

  // Only one of sleep/wake applies to a given tab; the inapplicable one is
  // visually disabled and refuses to fire rather than round-tripping to main.
  const isSleeping = Boolean(targetSession && targetSession.state === 'sleeping');
  const sleepItem = contextMenu.querySelector('.context-item[data-action="sleep"]');
  if (sleepItem) {
    sleepItem.classList.toggle('is-disabled', isSleeping);
    sleepItem.setAttribute('aria-disabled', isSleeping ? 'true' : 'false');
    sleepItem.title = isSleeping
      ? 'Phiên này đang ngủ (PTY đã giải phóng)'
      : 'Giải phóng PTY, hủy pane và giữ lại transcript của tab này';
  }
  const wakeItem = contextMenu.querySelector('.context-item[data-action="wake"]');
  if (wakeItem) {
    wakeItem.classList.toggle('is-disabled', !isSleeping);
    wakeItem.setAttribute('aria-disabled', isSleeping ? 'false' : 'true');
    wakeItem.title = isSleeping
      ? 'Khởi động lại shell trong cùng thư mục làm việc'
      : 'Chỉ áp dụng cho tab đang ngủ';
  }
  const categoryItem = contextMenu.querySelector('.context-item[data-action="category"]');
  if (categoryItem) {
    const currentCategory = (targetSession && typeof targetSession.category === 'string') ? targetSession.category.trim() : '';
    const label = categoryItem.querySelector('span:last-child');
    if (label) {
      label.textContent = currentCategory
        ? `Đặt nhóm: ${currentCategory}...`
        : 'Đặt nhóm (Set category)...';
    }
  }
  // Project windows may move their own sessions; Main enforces the sender's scope.
  // Agent-held sessions remain read-only even when the shared manager lists them.
  const assignItem = contextMenu.querySelector('.context-item[data-action="assign-capsule"]');
  if (assignItem) {
    const assignLabel = assignItem.querySelector('span:last-child');
    const currentCapsuleId = capsuleIdOf(targetSession);
    // Only a capsule Main has named is worth putting in the label: the raw id of one the index
    // has not seen would read as noise.
    const currentCapsuleLabel = currentCapsuleId && capsuleIndex.has(currentCapsuleId)
      ? capsuleLabelOf(currentCapsuleId)
      : '';
    const agentHeld = isAgentOwnedSession(targetSession);
    const canAssign = !agentHeld;
    assignItem.classList.toggle('is-disabled', !canAssign);
    assignItem.setAttribute('aria-disabled', canAssign ? 'false' : 'true');
    if (assignLabel) {
      assignLabel.textContent = currentCapsuleLabel
        ? `Chuyển sang dự án khác… (đang ở ${currentCapsuleLabel})`
        : 'Chuyển Terminal sang Dự án… (Move to Project)';
    }
    assignItem.title = agentHeld
      ? 'Terminal do agent sở hữu chỉ được xem, không chuyển được sang dự án khác'
      : 'Mở cửa sổ của dự án đích rồi chuyển Terminal này sang đó';
  }
  // A TUI keeps no scrollback to offer (its alternate buffer is not history), so the
  // honest affordance is the retained capture read as text: labelled lossy because the
  // control codes are stripped rather than emulated.
  const transcriptItem = contextMenu.querySelector('.context-item[data-action="transcript"]');
  if (transcriptItem) {
    const label = transcriptItem.querySelector('span:last-child');
    const isLossyOpen = Boolean(transcriptPreviewSessionId) && transcriptPreviewSessionId === sessionId;
    // A sleeping tab already shows its retained transcript, and there is no live pane
    // to return to until the session is awake.
    const sleepViewShown = isSleeping && sessionId === activeId;
    transcriptItem.classList.toggle('is-disabled', sleepViewShown);
    transcriptItem.setAttribute('aria-disabled', sleepViewShown ? 'true' : 'false');
    if (label) {
      label.textContent = isLossyOpen ? 'Quay lại terminal (Live)' : 'Xem bản ghi (Lossy)...';
    }
    transcriptItem.title = isLossyOpen
      ? 'Đóng bản ghi văn bản và quay lại terminal đang chạy'
      : (sleepViewShown
        ? 'Phiên đang ngủ đã hiển thị bản ghi của nó'
        : 'Đọc transcript dạng văn bản (đã lược bỏ mã điều khiển)');
  }

  contextMenu.style.display = 'flex';
  const menuWidth = 185;
  // Measure instead of hard-coding: the strip gained sleep/wake/category rows, and
  // a stale constant would park the menu off-screen at the bottom edge.
  const menuHeight = contextMenu.offsetHeight || 175;
  const x = Math.min(e.clientX, window.innerWidth - menuWidth - 10);
  const y = Math.min(e.clientY, window.innerHeight - menuHeight - 10);

  contextMenu.style.left = `${Math.max(10, x)}px`;
  contextMenu.style.top = `${Math.max(10, y)}px`;
}

function hideContextMenu() {
  if (contextMenu) contextMenu.style.display = 'none';
  contextTargetSessionId = '';
}

document.addEventListener('click', (e) => {
  if (contextMenu && !contextMenu.contains(e.target)) {
    hideContextMenu();
  }
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') hideContextMenu();
});

contextMenu?.querySelectorAll('.context-item').forEach((item) => {
  item.addEventListener('click', async (e) => {
    e.stopPropagation();
    const action = item.getAttribute('data-action');
    const targetId = contextTargetSessionId || activeId;
    hideContextMenu();

    if (!targetId && action !== 'new') return;

    if (action === 'open-folder') {
      api?.openWorkspace(targetId);
    } else if (action === 'rebind-tab') {
      // Affinity belongs to the tab that owns the pane: a right-click on a split row
      // rebinds the parent, whose session id is the one the pane's shell reports.
      const affinityTargetId = findSession(targetId)?.splitOf || targetId;
      const wrap = tabsEl.querySelector(`.terminal-tab-wrap[data-session-id="${affinityTargetId}"]`);
      const anchor = wrap?.querySelector('.terminal-tab-affinity-badge') || wrap || item;
      showAffinityPicker(affinityTargetId, anchor);
    } else if (action === 'rename') {
      const wrap = tabsEl.querySelector(`[data-session-id="${targetId}"]`);
      const titleSpan = wrap?.querySelector('.terminal-tab-title');
      if (wrap && titleSpan) {
        startInlineRename(targetId, wrap, titleSpan);
      }
    } else if (action === 'split') {
      if (!targetId || !api) return;
      const targetSession = sessions.find((x) => x.id === targetId);
      // A split is closed the way a tab is closed (✕ / "Đóng tab này"): splitting a
      // split is not an operation this menu can mean.
      if (targetSession?.splitOf) return;
      const isTargetSplit = Boolean(targetSession?.splitSessionId);
      activateTabLocally(targetId);
      if (!isTargetSplit) {
        const mainItem = terminalPool.get(targetId);
        const targetCols = (mainItem && mainItem.term && mainItem.term.cols) || 120;
        const targetRows = getInitialSplitRows(mainItem?.term);
        const newSplitId = await api.splitTerminal(targetId, { cols: targetCols, rows: targetRows });
        if (newSplitId && activeId === targetId) mountSplitClean(newSplitId);
      } else {
        await api.unsplitTerminal?.(targetId);
        if (activeId === targetId) unmountSplit();
      }
    } else if (action === 'new') {
      void createTerminal();
    } else if (action === 'sleep') {
      // Sleeping an already-sleeping tab is a no-op: main would have nothing to
      // release, and the round-trip only risks a redundant broadcast.
      if (targetId && !isSessionSleeping(targetId)) {
        await api?.sleepTerminal?.(targetId);
      }
    } else if (action === 'wake') {
      if (targetId && isSessionSleeping(targetId)) {
        wakeSleepingSession(targetId, '');
      }
    } else if (action === 'category') {
      const wrap = tabsEl.querySelector(`.terminal-tab-wrap[data-session-id="${targetId}"]`);
      const anchor = wrap?.querySelector('.terminal-tab-affinity-badge') || wrap || item;
      // The picker speaks for the tab that owns the pane: that owner's group is the value
      // shown, and picking one moves the parent — with its panes — rather than filing a
      // pane into a group its parent is not in.
      showCategoryPicker(findSession(targetId)?.splitOf || targetId, anchor);
    } else if (action === 'assign-capsule') {
      // Repeat the agent guard for programmatic clicks; Main owns session-scope checks.
      if (isAgentOwnedSession(findSession(targetId))) {
        showTerminalNotice('Terminal do agent sở hữu chỉ được xem, không chuyển được sang dự án khác');
        return;
      }
      const wrap = tabsEl.querySelector(`.terminal-tab-wrap[data-session-id="${targetId}"]`);
      const anchor = wrap?.querySelector('.terminal-tab-affinity-badge') || wrap || item;
      // The move belongs to the tab that owns the pane: its session id is the one Main owns,
      // and a pane moved on its own would be a window split across two projects.
      showCapsulePicker(findSession(targetId)?.splitOf || targetId, anchor);
    } else if (action === 'transcript') {
      if (transcriptPreviewSessionId === targetId) {
        closeTranscriptPreview();
      } else if (!(isSessionSleeping(targetId) && targetId === activeId)) {
        // The view replaces the active pane, so a background tab's transcript is asked
        // for by selecting that tab first.
        transcriptPreviewSessionId = targetId;
        if (targetId === activeId) syncTerminalPool(sessions, activeId);
        else activateTabLocally(targetId);
      }
    } else if (action === 'close') {
      // `closeSession` owns base sessions; a split is released through the split API,
      // which accepts the split id as its target.
      if (sessions.find((x) => x.id === targetId)?.splitOf) api?.unsplitTerminal?.(targetId);
      else api?.closeTerminal(targetId);
    } else if (action === 'close-others') {
      const parentId = sessions.find((x) => x.id === targetId)?.splitOf || '';
      for (const s of sessions) {
        // A split cannot outlive its parent, so the parent (and the siblings sharing
        // its pane) stay while a split target is the one being kept.
        if (s.id === targetId || (parentId && (s.id === parentId || s.splitOf === parentId))) continue;
        if (s.splitOf) api?.unsplitTerminal?.(s.id);
        else api?.closeTerminal(s.id);
      }
    }
  });
});

/**
 * Select a tab in the renderer and in main. Panes are deliberately left to whatever
 * follows: the main process keeps the active session base-scoped, so a split resolves to
 * the parent that owns it, and the pushed session state owns which split is mounted.
 */
function activateTabLocally(targetId) {
  if (!targetId) return;
  const resolvedId = findSession(targetId)?.splitOf || targetId;
  if (resolvedId === activeId) return;
  activeId = resolvedId;
  tabsEl.querySelectorAll('.terminal-tab-wrap').forEach((el) => {
    el.classList.toggle('active', el.getAttribute('data-session-id') === activeId);
  });
  syncTerminalPool(sessions, activeId);
  // A popout is a second surface on the same window, not a shell of its own: selecting a tab here
  // is this window's selection, and main holds the one active session every surface follows. The
  // report is also what keeps a popout's own binding current, so a route that resolves "this
  // window's session" resolves to what the user is looking at. Only a selection reports: traffic
  // stays out of this path (a gap recovered by an ack never repoints anything).
  api?.switchTerminal(targetId);
}

function startInlineRename(sessionId, tabWrapEl, titleSpanEl) {
  if (tabWrapEl.classList.contains('renaming')) return;
  tabWrapEl.classList.add('renaming');

  const currentName = titleSpanEl.textContent || '';
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'terminal-tab-rename-input';
  input.value = currentName;
  input.spellcheck = false;

  titleSpanEl.style.display = 'none';
  titleSpanEl.after(input);
  input.focus();
  input.select();

  // Prevent event bubbling to button container
  input.addEventListener('click', (e) => e.stopPropagation());
  input.addEventListener('mousedown', (e) => e.stopPropagation());
  input.addEventListener('mouseup', (e) => e.stopPropagation());
  input.addEventListener('dblclick', (e) => e.stopPropagation());
  input.addEventListener('contextmenu', (e) => e.stopPropagation());
  let finished = false;
  const finishRename = async (save) => {
    if (finished) return;
    finished = true;
    const newName = input.value.trim();
    try {
      input.remove();
    } catch {}
    titleSpanEl.style.display = '';
    tabWrapEl.classList.remove('renaming');

    if (save && newName && newName !== currentName) {
      titleSpanEl.textContent = newName;
      const targetSession = sessions.find((s) => s.id === sessionId);
      if (targetSession) targetSession.name = newName;
      try {
        await api?.renameTerminal(sessionId, newName);
      } catch (err) {
        console.error('Failed to rename terminal:', err);
      }
    }
  };

  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    e.stopImmediatePropagation();
    if (e.key === 'Enter') {
      e.preventDefault();
      finishRename(true);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      finishRename(false);
    }
  });

  input.addEventListener('keyup', (e) => {
    e.stopPropagation();
    e.stopImmediatePropagation();
    // Space key release on button descendants triggers synthetic click in Blink/Chromium
    if (e.key === ' ' || e.code === 'Space') {
      e.preventDefault();
    }
  });

  input.addEventListener('blur', () => {
    finishRename(true);
  });
}

const sessionActivity = new Map();

// Trailing-edge throttle: at most one classification pass per 100ms per session
// while streaming; the pending timer always re-runs with the latest data so the
// final chunk of a burst is still classified.
const sessionActivityThrottle = new Map();

function notifySessionActivity(sessionId, data) {
  if (!sessionId || !data || typeof data !== 'string') return;

  // State control sequences bypass the stream throttle immediately
  const actPreview = sessionActivity.get(sessionId);
  const tailPreview = actPreview?.tail || '';
  if (data.includes('\x1b]777;antifan;') || data.includes('\x1b]1337;antifan_wait=') || (tailPreview + data).includes('\x1b]777;antifan;')) {
    classifySessionActivity(sessionId, data);
    return;
  }

  const now = Date.now();
  let th = sessionActivityThrottle.get(sessionId);
  if (!th) {
    th = { lastRun: 0, timer: null, pendingData: '' };
    sessionActivityThrottle.set(sessionId, th);
  }
  if (th.timer) {
    th.pendingData = data;
    return;
  }
  const elapsed = now - th.lastRun;
  if (elapsed < 100) {
    th.pendingData = data;
    th.timer = setTimeout(() => {
      th.timer = null;
      const d = th.pendingData;
      th.pendingData = '';
      th.lastRun = Date.now();
      classifySessionActivity(sessionId, d);
    }, 100 - elapsed);
    return;
  }
  th.lastRun = now;
  classifySessionActivity(sessionId, data);
}

function classifySessionActivity(sessionId, data) {
  if (!sessionId || !data || typeof data !== 'string') return;

  let act = sessionActivity.get(sessionId);
  if (!act) {
    act = { isStreaming: false, isAi: false, isWaiting: false, isCompleted: false, idleTimer: null, doneTimer: null, tail: '' };
    sessionActivity.set(sessionId, act);
  }

  const combined = (act.tail || '') + data;
  act.tail = data.length > 64 ? data.slice(-64) : combined.slice(-64);

  // Fast-path: Explicit OSC sequence from wait-alert or AntiFan agents
  const wait1Idx = Math.max(combined.lastIndexOf('\x1b]777;antifan;wait=1'), combined.lastIndexOf('\x1b]1337;antifan_wait=1'));
  const wait0Idx = Math.max(combined.lastIndexOf('\x1b]777;antifan;wait=0'), combined.lastIndexOf('\x1b]1337;antifan_wait=0'));
  if (wait0Idx !== -1 && wait0Idx > wait1Idx) {
    act.tail = '';
    act.isWaiting = false;
    updateTabActivityUi(sessionId);
    return;
  }
  if (wait1Idx !== -1 && wait1Idx > wait0Idx) {
    act.tail = '';
    clearTimeout(act.idleTimer);
    clearTimeout(act.doneTimer);
    act.isWaiting = true;
    act.isStreaming = false;
    act.isCompleted = false;
    updateTabActivityUi(sessionId);
    return;
  }
  // Filter out ANSI sequences
  const clean = data.replace(/\u001b\[[0-9;?]*[a-zA-Z]/g, '').trim();
  if (!clean) return; // Pure cursor movements, clear lines, redraws

  // Filter out standard idle shell prompts and copyright headers
  if (/^PS\s+[^>]*>\s*$/i.test(clean)) return;
  if (/^[a-zA-Z]:\\[^>]*>\s*$/i.test(clean)) return;
  if (/^[\w.-]+@[\w.-]+:[^$#]*[$#]\s*$/i.test(clean)) return;
  if (/^Windows\s+PowerShell/i.test(clean)) return;
  if (/^Copyright\s+\(C\)\s+Microsoft/i.test(clean)) return;
  if (/^Install the latest PowerShell/i.test(clean)) return;
  // Detect AI patterns, progress bars, or active execution
  const isAiIndicator = (
    /Claude|Codex|OpenCode|DeepSeek|Gemini|Qwen|Kimi|ChatGPT|Thinking\.\.\.|Streaming\.\.\.|⠋|⠙|⠹|⠸|⠼|⠴|⠦|⠧|⠇|⠏|\[in_progress\]|\[task\]|Agent|Evaluating|Generating/i.test(data)
  );

  if (isAiIndicator) {
    act.isAi = true;
  }

  // Detect if output stopped at an interactive prompt waiting for user answer
  const isWaitPrompt = (
    /(?:\(y\/n\)|\(Y\/n\)|\(y\/N\)|\(Y\/N\)|\[y\/n\]|\[Y\/n\]|\[y\/N\]|\[Y\/N\])\s*$/i.test(clean) ||
    (act.isAi && (
      /(?:Do you want to proceed|Waiting for user input|waiting for approval|Press any key|Enter your choice|chờ bạn trả lời|câu trả lời|\bAllow once\b|\bAllow always\b|\bDeny\b)/i.test(clean) ||
      (/\?\s*$/.test(clean) && clean.length < 240)
    ))
  );
  if (isWaitPrompt) {
    clearTimeout(act.idleTimer);
    clearTimeout(act.doneTimer);
    act.isWaiting = true;
    act.isStreaming = false;
    act.isCompleted = false;
    updateTabActivityUi(sessionId);
    return;
  }

  // If streaming output resumed, clear waiting
  if (act.isWaiting) {
    act.isWaiting = false;
  }

  clearTimeout(act.idleTimer);
  clearTimeout(act.doneTimer);

  const wasStreaming = act.isStreaming;
  act.isStreaming = true;
  act.isCompleted = false;

  if (!wasStreaming) {
    updateTabActivityUi(sessionId);
  }

  // Set debounce timer: when terminal output stops for 1.0s, mark as completed then idle
  act.idleTimer = setTimeout(() => {
    act.isStreaming = false;
    act.isCompleted = true;
    updateTabActivityUi(sessionId);

    act.doneTimer = setTimeout(() => {
      act.isCompleted = false;
      act.isAi = false;
      updateTabActivityUi(sessionId);
    }, 2000);
  }, 1000);
}

function updateTabActivityUi(sessionId) {
  const wrap = tabsEl?.querySelector(`.terminal-tab-wrap[data-session-id="${sessionId}"]`);
  if (!wrap) return;

  const act = sessionActivity.get(sessionId);
  const iconEl = wrap.querySelector('.terminal-tab-icon');
  const beaconEl = wrap.querySelector('.terminal-tab-status-beacon');

  // Sleep is the terminal presentation state: a sleeping tab shows 💤 and must
  // not be repainted as streaming by a stale activity timer.
  if (isSessionSleeping(sessionId)) {
    wrap.classList.remove('is-streaming', 'is-completed', 'is-waiting');
    if (iconEl) {
      iconEl.innerHTML = `<span class="terminal-tab-sleep-icon" title="Phiên đang ngủ. Gõ phím để đánh thức" aria-label="Đang ngủ">${iconSvg(ICON_MOON, 11)}</span>`;
    }
    if (beaconEl) {
      beaconEl.className = 'terminal-tab-status-beacon sleeping';
      beaconEl.title = '💤 Đang ngủ (PTY đã giải phóng)';
      beaconEl.innerHTML = '';
    }
    return;
  }

  if (act?.isWaiting) {
    wrap.classList.remove('is-streaming', 'is-completed');
    wrap.classList.add('is-waiting');
    if (iconEl) {
      iconEl.innerHTML = `<span class="terminal-tab-waiting-pulse" title="❓ Đang chờ câu trả lời / phê duyệt của bạn...">?</span>`;
    }
    if (beaconEl) {
      beaconEl.className = 'terminal-tab-status-beacon waiting';
      beaconEl.title = '❓ Đang chờ câu trả lời';
      beaconEl.innerHTML = '';
    }
  } else if (act?.isStreaming) {
    wrap.classList.remove('is-waiting', 'is-completed');
    wrap.classList.add('is-streaming');
    if (iconEl) {
      if (act.isAi) {
        iconEl.innerHTML = `<span class="terminal-tab-ai-pulse" title="⚡ AI Agent đang thực thi / phản hồi...">⚡</span>`;
      } else {
        iconEl.innerHTML = `<span class="terminal-tab-spinner" title="Đang thực thi lệnh..."></span>`;
      }
    }
    if (beaconEl) {
      beaconEl.className = 'terminal-tab-status-beacon streaming';
      beaconEl.title = act.isAi ? '⚡ AI đang phản hồi...' : 'Đang xử lý...';
      beaconEl.innerHTML = '';
    }
  } else if (act?.isCompleted) {
    wrap.classList.remove('is-waiting', 'is-streaming');
    wrap.classList.add('is-completed');
    if (iconEl) {
      iconEl.innerHTML = `<span style="color:#10b981;font-weight:bold;font-size:11px;" title="Thực thi hoàn tất">✓</span>`;
    }
    if (beaconEl) {
      beaconEl.className = 'terminal-tab-status-beacon completed';
      beaconEl.title = '✓ Hoàn tất';
      beaconEl.innerHTML = '';
    }
  } else {
    wrap.classList.remove('is-waiting', 'is-streaming', 'is-completed');
    if (iconEl) {
      iconEl.innerHTML = `<svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 5 8 8 4 11"/><line x1="9" y1="11" x2="13" y2="11"/></svg>`;
    }
    if (beaconEl) {
      beaconEl.className = 'terminal-tab-status-beacon';
      beaconEl.title = '';
      beaconEl.innerHTML = '';
    }
  }
}

// ---------------------------------------------------------------------------
// Run cards: one card per terminal session that has a run, maintained from the
// per-window `onRunCardState` projection Main pushes. A card only ever observes
// and steers the run bound to ITS terminal row — clicking it never retargets a
// browser tab, and its capsule label is attribution, not navigation.
// ---------------------------------------------------------------------------

/** Live run cards for this window, keyed by terminalSessionId. */
const runCards = new Map();
let runCardsUnsubscribe = null;
let runCardElapsedTimer = null;

/** Refusal every agent-owned row answers, verbatim from the context-menu gate. */
const AGENT_ROW_VIEW_TITLE = 'Terminal do agent sở hữu chỉ được xem, không chuyển được';

/** The lifecycle states the card and the strip dot can show. */
const RUN_CARD_STATE_LABELS = {
  running: 'đang chạy',
  waiting_user: 'chờ bạn',
  idle: 'nghỉ',
  ended: 'kết thúc',
};

/** Mode badge text; `unset` means "no scoped mode" and shows no badge. */
const RUN_CARD_MODE_LABELS = {
  core: 'Core',
  direct: 'Direct',
  fast: 'Fast',
};

/** `mm:ss` while under an hour, `h:mm:ss` past it — the timer never climbs a unit. */
function runCardElapsedText(startedAt) {
  if (typeof startedAt !== 'number' || !Number.isFinite(startedAt)) return '';
  const seconds = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
  const mm = Math.floor(seconds / 60);
  const ss = seconds % 60;
  if (mm >= 60) {
    const hh = Math.floor(mm / 60);
    return `${hh}:${String(mm % 60).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
  }
  return `${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
}

/** `lastEventAt` rendered as a wall-clock time, like "14:03:22". */
function runCardLastEventText(lastEventAt) {
  if (typeof lastEventAt !== 'number' || !Number.isFinite(lastEventAt) || lastEventAt <= 0) return '';
  const d = new Date(lastEventAt);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/**
 * Accept the pushed projection in its wire shape `{ runs: RunCardState[] }` and the
 * bare array the preload types it as; anything else replaces nothing.
 */
function runCardListFromPayload(payload) {
  if (Array.isArray(payload)) return payload;
  if (payload && typeof payload === 'object' && Array.isArray(payload.runs)) return payload.runs;
  return null;
}

/**
 * Rebuild the map from a pushed projection and repaint every wrap that has one.
 * Wraps for sessions not yet rendered paint their card on the next renderTabs.
 */
function applyRunCardStates(payload) {
  const list = runCardListFromPayload(payload);
  if (!list) return;
  runCards.clear();
  for (const card of list) {
    if (card && typeof card === 'object' && typeof card.terminalSessionId === 'string' && card.terminalSessionId) {
      runCards.set(card.terminalSessionId, card);
    }
  }
  if (!tabsEl) return;
  for (const wrap of tabsEl.querySelectorAll('.terminal-tab-wrap')) {
    const sid = wrap.getAttribute('data-session-id');
    if (sid) applyRunCardToWrap(wrap, sid);
  }
}

/** Create or repaint the run card of one tab wrap from `runCards`. */
function applyRunCardToWrap(wrap, sessionId) {
  const card = runCards.get(sessionId);
  let cardEl = wrap.querySelector('.terminal-run-card');
  let stripDot = wrap.querySelector('.terminal-run-strip-dot');

  if (!card) {
    if (cardEl) cardEl.remove();
    if (stripDot) stripDot.remove();
    wrap.classList.remove('has-run-card');
    return;
  }

  // The horizontal strip has no room for a card: the run's state folds into one
  // small dot inside the tab button and the card element stays out of the DOM.
  if (terminalTabLayout !== 'sidebar') {
    if (cardEl) cardEl.remove();
    wrap.classList.remove('has-run-card');
    const btn = wrap.querySelector('.terminal-tab');
    if (!stripDot && btn) {
      stripDot = document.createElement('span');
      stripDot.className = 'terminal-run-strip-dot';
      btn.appendChild(stripDot);
    }
    if (stripDot) {
      stripDot.className = `terminal-run-strip-dot run-${card.state}${card.stale ? ' is-stale' : ''}`;
    }
    return;
  }
  if (stripDot) stripDot.remove();

  // Structural fields rebuild the card subtree; the elapsed counter repaints alone
  // so a 1s tick never re-creates the buttons under the user's pointer.
  const sig = [
    card.state, card.stale ? 'stale' : 'fresh', card.mode || 'unset',
    card.lastTool || '', card.promptHead || '', card.capsuleId || '',
    card.viewOnly ? 'view' : 'operate',
    card.changes ? `${card.changes.fileCount}/${card.changes.blockedCount}/${card.changes.files.join('|')}` : '',
    card.lastEventAt || 0,
  ].join('~');
  if (!cardEl || cardEl.getAttribute('data-run-sig') !== sig) {
    if (cardEl) cardEl.remove();
    cardEl = buildRunCard(card, sessionId, wrap);
    wrap.appendChild(cardEl);
  }

  const elapsedEl = cardEl.querySelector('.terminal-run-elapsed');
  if (elapsedEl) {
    const text = runCardElapsedText(card.runStartedAt);
    if (elapsedEl.textContent !== text) elapsedEl.textContent = text;
  }
  wrap.classList.add('has-run-card');
}

/** The whole card subtree for one run. Every agent-supplied string is textContent. */
function buildRunCard(card, sessionId, wrap) {
  const el = document.createElement('div');
  const stateClass = `run-${typeof card.state === 'string' ? card.state : 'idle'}`;
  el.className = `terminal-run-card ${stateClass}${card.stale ? ' is-stale' : ''}`;
  el.setAttribute('data-session-id', sessionId);
  // The structural signature `applyRunCardToWrap` compares before rebuilding.
  el.setAttribute('data-run-sig', [
    card.state, card.stale ? 'stale' : 'fresh', card.mode || 'unset',
    card.lastTool || '', card.promptHead || '', card.capsuleId || '',
    card.viewOnly ? 'view' : 'operate',
    card.changes ? `${card.changes.fileCount}/${card.changes.blockedCount}/${card.changes.files.join('|')}` : '',
    card.lastEventAt || 0,
  ].join('~'));
  if (typeof card.promptHead === 'string' && card.promptHead) {
    el.title = card.promptHead;
    el.setAttribute('title', card.promptHead);
  }

  const head = document.createElement('div');
  head.className = 'terminal-run-head';

  const dot = document.createElement('span');
  dot.className = `terminal-run-dot ${stateClass}`;
  head.appendChild(dot);

  const stateEl = document.createElement('span');
  stateEl.className = 'terminal-run-state';
  stateEl.textContent = RUN_CARD_STATE_LABELS[card.state] || card.state || '';
  head.appendChild(stateEl);

  const elapsed = document.createElement('span');
  elapsed.className = 'terminal-run-elapsed';
  elapsed.textContent = runCardElapsedText(card.runStartedAt);
  head.appendChild(elapsed);

  const lastEvent = runCardLastEventText(card.lastEventAt);
  if (lastEvent) {
    const lastEl = document.createElement('span');
    lastEl.className = 'terminal-run-lastevent';
    lastEl.textContent = lastEvent;
    lastEl.title = 'Sự kiện cuối của run';
    head.appendChild(lastEl);
  }

  const modeLabel = RUN_CARD_MODE_LABELS[card.mode] || '';
  if (modeLabel) {
    const badge = document.createElement('span');
    badge.className = `terminal-run-mode mode-${card.mode}`;
    badge.textContent = modeLabel;
    head.appendChild(badge);
  }
  el.appendChild(head);

  const meta = document.createElement('div');
  meta.className = 'terminal-run-meta';
  if (typeof card.lastTool === 'string' && card.lastTool) {
    const tool = document.createElement('span');
    tool.className = 'terminal-run-tool';
    tool.textContent = card.lastTool;
    meta.appendChild(tool);
  }
  if (typeof card.capsuleId === 'string' && card.capsuleId) {
    const capsule = document.createElement('span');
    capsule.className = 'terminal-run-capsule';
    capsule.textContent = capsuleLabelOf(card.capsuleId);
    const path = capsulePathOf(card.capsuleId);
    capsule.title = path ? `${card.capsuleId} — ${path}` : card.capsuleId;
    meta.appendChild(capsule);
  }
  if (meta.firstChild) el.appendChild(meta);

  // An ended run is evidence, not a control surface: it shows what it last did and
  // offers nothing to press, exactly like a view-only row — except view-only rows
  // belong to a live run somebody else owns, so they name that instead.
  const isEnded = card.state === 'ended';
  if (isEnded) {
    const chip = document.createElement('span');
    chip.className = 'terminal-run-ended-chip';
    chip.textContent = card.stale ? 'kết thúc · mất dấu' : 'kết thúc';
    if (card.stale) chip.title = 'Tiến trình agent đã mất — run bị đánh dấu cũ, không còn điều khiển được';
    el.appendChild(chip);
  } else if (card.viewOnly) {
    // A run somebody else's agent owns stays visible with its controls rendered
    // and disabled — the refusal title is the same string the context-menu gate
    // shows, and sendRunControl re-guards by session owner before any IPC.
    const tag = document.createElement('span');
    tag.className = 'terminal-run-viewonly';
    tag.textContent = 'Chỉ xem';
    el.appendChild(tag);
    const actions = document.createElement('div');
    actions.className = 'terminal-run-actions';
    for (const [label, cls] of [['Hủy', 'is-cancel'], ['Chỉ đạo', 'is-steer']]) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `terminal-run-btn ${cls}`;
      btn.textContent = label;
      btn.disabled = true;
      btn.title = AGENT_ROW_VIEW_TITLE;
      btn.setAttribute('title', AGENT_ROW_VIEW_TITLE);
      actions.appendChild(btn);
    }
    el.appendChild(actions);
  } else {
    const actions = document.createElement('div');
    actions.className = 'terminal-run-actions';
    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'terminal-run-btn is-cancel';
    cancelBtn.textContent = 'Hủy';
    cancelBtn.title = 'Huỷ run đang chạy trên terminal này';
    cancelBtn.onclick = (e) => {
      e.stopPropagation();
      sendRunControl(sessionId, 'cancel');
    };
    const steerBtn = document.createElement('button');
    steerBtn.type = 'button';
    steerBtn.className = 'terminal-run-btn is-steer';
    steerBtn.textContent = 'Chỉ đạo';
    steerBtn.title = 'Gửi chỉ đạo tới run đang chạy trên terminal này';
    steerBtn.onclick = (e) => {
      e.stopPropagation();
      openRunSteerRow(wrap, sessionId, el);
    };
    actions.append(cancelBtn, steerBtn);
    el.appendChild(actions);
  }

  const changes = card.changes && typeof card.changes === 'object' ? card.changes : null;
  if (changes && (changes.fileCount > 0 || changes.blockedCount > 0)) {
    const footer = document.createElement('div');
    footer.className = 'terminal-run-changes';
    const summary = document.createElement('button');
    summary.type = 'button';
    summary.className = 'terminal-run-changes-summary';
    const parts = [];
    if (changes.fileCount > 0) parts.push(`${changes.fileCount} file đã sửa`);
    if (changes.blockedCount > 0) parts.push(`${changes.blockedCount} bị chặn`);
    summary.textContent = parts.join(' · ');
    const list = document.createElement('div');
    list.className = 'terminal-run-changes-list';
    list.style.display = 'none';
    for (const file of Array.isArray(changes.files) ? changes.files : []) {
      const row = document.createElement('div');
      row.className = 'terminal-run-file';
      row.textContent = file;
      row.title = `${file} — mở trong VS Code`;
      row.onclick = (e) => {
        e.stopPropagation();
        if (typeof api?.openInVSCode === 'function') void api.openInVSCode(file);
      };
      list.appendChild(row);
    }
    summary.onclick = (e) => {
      e.stopPropagation();
      list.style.display = list.style.display === 'none' ? 'block' : 'none';
    };
    footer.append(summary, list);
    el.appendChild(footer);
  }
  return el;
}

/** The inline steer field inside the wrap: Enter posts, Esc closes. */
function openRunSteerRow(wrap, sessionId, cardEl) {
  const card = cardEl || wrap.querySelector('.terminal-run-card');
  if (!card) return;
  let row = card.querySelector('.terminal-run-steer-row');
  if (row) {
    row.remove();
    return;
  }
  row = document.createElement('div');
  row.className = 'terminal-run-steer-row';
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'terminal-run-steer-input';
  input.placeholder = 'Chỉ đạo run này… (Enter gửi, Esc đóng)';
  input.setAttribute('aria-label', 'Chỉ đạo run');
  const send = document.createElement('button');
  send.type = 'button';
  send.className = 'terminal-run-btn is-steer-send';
  send.textContent = 'Gửi';
  const submit = () => {
    const text = input.value.trim();
    if (!text) {
      row.remove();
      return;
    }
    row.remove();
    sendRunControl(sessionId, 'steer', text);
  };
  send.onclick = (e) => { e.stopPropagation(); submit(); };
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') { e.preventDefault(); submit(); }
    else if (e.key === 'Escape') { e.preventDefault(); row.remove(); }
  });
  input.addEventListener('click', (e) => e.stopPropagation());
  row.append(input, send);
  card.appendChild(row);
  try { input.focus(); } catch {}
}

/**
 * One control request against Main. The refusal is rendered verbatim — the reason
 * token is the class of failure the user is looking at, and the message is Main's.
 */
function sendRunControl(sessionId, op, text) {
  if (isAgentOwnedSession(findSession(sessionId))) {
    showTerminalNotice(AGENT_ROW_VIEW_TITLE);
    return;
  }
  if (typeof api?.runControl !== 'function') {
    showTerminalNotice(`Không ${op === 'cancel' ? 'hủy' : 'chỉ đạo'} được run: preload thiếu runControl`);
    return;
  }
  Promise.resolve(api.runControl(sessionId, op, text))
    .then((result) => {
      if (!result || result.ok !== true) {
        const reason = result && typeof result.reason === 'string' ? result.reason : 'RUN_CONTROL_FAILED';
        const message = result && typeof result.message === 'string' && result.message ? ` — ${result.message}` : '';
        showTerminalNotice(`Không ${op === 'cancel' ? 'hủy' : 'chỉ đạo'} được run: ${reason}${message}`);
      }
    })
    .catch((err) => {
      showTerminalNotice(`Không ${op === 'cancel' ? 'hủy' : 'chỉ đạo'} được run: ${bridgeErrorText(err)}`);
    });
}

if (typeof api?.onRunCardState === 'function') {
  try {
    runCardsUnsubscribe = api.onRunCardState((payload) => {
      applyRunCardStates(payload);
    });
  } catch (err) {
    console.error('[run-cards] onRunCardState subscription error:', err);
  }
}
// The elapsed counter ticks locally from runStartedAt — a paint of what the run
// file already said, never an IPC round-trip.
runCardElapsedTimer = setInterval(() => {
  let hasLive = false;
  for (const card of runCards.values()) {
    if (card.state === 'running' || card.state === 'waiting_user') { hasLive = true; break; }
  }
  if (!hasLive || !tabsEl) return;
  for (const wrap of tabsEl.querySelectorAll('.terminal-tab-wrap')) {
    const sid = wrap.getAttribute('data-session-id');
    if (sid && runCards.has(sid)) applyRunCardToWrap(wrap, sid);
  }
}, 1000);
if (runCardElapsedTimer && typeof runCardElapsedTimer.unref === 'function') {
  runCardElapsedTimer.unref();
}

// ---------------------------------------------------------------------------
// Capsule pinned brief: the storefront context every agent run on this project's
// terminals receives. Edited from the capsule group header in the manager; a
// refused write surfaces its reason instead of silently keeping the old text.
// ---------------------------------------------------------------------------
let activeCapsuleBriefClose = null;

/** Close the brief dialog if one is open (called from the teardown path too). */
function closeCapsuleBriefDialog() {
  if (typeof activeCapsuleBriefClose === 'function') activeCapsuleBriefClose();
}

/**
 * Open the pinned-brief dialog for one capsule. The dialog edits capsule metadata,
 * never the run or the browser: saving changes what context the next prompt carries,
 * not where anything is displayed.
 */
function openCapsuleBriefDialog(capsuleId) {
  if (typeof api?.capsuleGetBrief !== 'function' || typeof api?.capsuleSetBrief !== 'function') {
    showTerminalNotice('Không mở được ghi chú dự án: preload thiếu capsule brief');
    return;
  }
  const dialog = document.getElementById('capsuleBriefDialog');
  if (!dialog) return;
  if (activeCapsuleBriefClose) activeCapsuleBriefClose();

  const titleEl = document.getElementById('capsuleBriefTitle');
  const urlEl = document.getElementById('capsuleBriefUrl');
  const siteEl = document.getElementById('capsuleBriefSite');
  const themeEl = document.getElementById('capsuleBriefTheme');
  const rulesEl = document.getElementById('capsuleBriefRules');
  const errorEl = document.getElementById('capsuleBriefError');
  const saveBtn = document.getElementById('capsuleBriefSave');
  const clearBtn = document.getElementById('capsuleBriefClear');
  const cancelBtn = document.getElementById('capsuleBriefCancel');

  const label = capsuleLabelOf(capsuleId);
  if (titleEl) titleEl.textContent = `Ghi chú dự án — ${label}`;
  if (urlEl) urlEl.value = '';
  if (siteEl) siteEl.value = '';
  if (themeEl) themeEl.value = '';
  if (rulesEl) rulesEl.value = '';
  const setError = (text) => {
    if (errorEl) errorEl.textContent = text || '';
  };
  setError('');
  dialog.setAttribute('data-capsule-id', capsuleId);
  dialog.style.display = 'flex';

  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    dialog.style.display = 'none';
    document.removeEventListener('keydown', onDocumentKeydown);
    document.removeEventListener('click', onDocumentClick);
    if (activeCapsuleBriefClose === close) activeCapsuleBriefClose = null;
  };
  const onDocumentClick = (e) => {
    if (!dialog.contains(e.target)) close();
  };
  const onDocumentKeydown = (e) => {
    if (e.key === 'Escape') close();
  };

  const writeBrief = async (brief) => {
    try {
      const reply = await api.capsuleSetBrief(capsuleId, brief);
      if (reply && reply.ok === true) {
        close();
        showTerminalNotice(brief ? 'Đã lưu ghi chú dự án' : 'Đã xoá ghi chú dự án', 'success');
      } else {
        const reason = reply && typeof reply.reason === 'string' ? reply.reason : 'INVALID_PAYLOAD';
        const message = reply && typeof reply.message === 'string' && reply.message ? ` — ${reply.message}` : '';
        setError(`Không lưu được ghi chú: ${reason}${message}`);
      }
    } catch (err) {
      setError(`Không lưu được ghi chú: ${bridgeErrorText(err)}`);
    }
  };

  if (saveBtn) {
    saveBtn.onclick = (e) => {
      e.stopPropagation();
      const brief = {
        storefrontUrl: urlEl && urlEl.value.trim() ? urlEl.value.trim() : undefined,
        siteName: siteEl && siteEl.value.trim() ? siteEl.value.trim() : undefined,
        themeId: themeEl && themeEl.value.trim() ? themeEl.value.trim() : undefined,
        rules: rulesEl
          ? rulesEl.value.split('\n').map((line) => line.trim()).filter(Boolean)
          : undefined,
      };
      if (brief.rules && brief.rules.length === 0) brief.rules = undefined;
      const hasAnyField = Object.values(brief).some((value) => value !== undefined);
      void writeBrief(hasAnyField ? brief : null);
    };
  }
  if (clearBtn) {
    clearBtn.onclick = (e) => {
      e.stopPropagation();
      void writeBrief(null);
    };
  }
  if (cancelBtn) {
    cancelBtn.onclick = (e) => {
      e.stopPropagation();
      close();
    };
  }
  for (const field of [urlEl, siteEl, themeEl, rulesEl]) {
    if (!field) continue;
    field.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Escape') { e.preventDefault(); close(); }
    });
    field.addEventListener('click', (e) => e.stopPropagation());
  }
  setTimeout(() => {
    if (closed) return;
    document.addEventListener('click', onDocumentClick);
    document.addEventListener('keydown', onDocumentKeydown);
  }, 10);
  activeCapsuleBriefClose = close;
  try { if (urlEl) urlEl.focus(); } catch {}

  void (async () => {
    try {
      const reply = await api.capsuleGetBrief(capsuleId);
      if (closed) return;
      if (reply && reply.ok === true) {
        const brief = reply.brief && typeof reply.brief === 'object' ? reply.brief : null;
        if (urlEl) urlEl.value = brief?.storefrontUrl || '';
        if (siteEl) siteEl.value = brief?.siteName || '';
        if (themeEl) themeEl.value = brief?.themeId || '';
        if (rulesEl) rulesEl.value = Array.isArray(brief?.rules) ? brief.rules.join('\n') : '';
      } else {
        const reason = reply && typeof reply.reason === 'string' ? reply.reason : 'INVALID_PAYLOAD';
        const message = reply && typeof reply.message === 'string' && reply.message ? ` — ${reply.message}` : '';
        setError(`Không đọc được ghi chú: ${reason}${message}`);
      }
    } catch (err) {
      if (!closed) setError(`Không đọc được ghi chú: ${bridgeErrorText(err)}`);
    }
  })();
}

/**
 * A split row's tooltip names the tab it splits. The parent's name is live, so the
 * lookup happens per render rather than being baked in when the row is created: a
 * renamed parent has to show its new name in the child's tooltip.
 */
function splitGlyphTitle(session) {
  const parent = session && session.splitOf ? findSession(session.splitOf) : null;
  return (parent && parent.name)
    ? `Pane chia đôi của "${parent.name}"`
    : 'Pane chia đôi';
}

/** The tab-strip badge that opens the browser-tab affinity picker for one tab. */
function createAffinityBadge(s) {
  const badge = document.createElement('span');
  badge.className = 'terminal-tab-affinity-badge unbound';
  badge.setAttribute('data-session-id', s.id);
  badge.textContent = '🎯 Gán Tab';
  badge.title = 'Tab trình duyệt gắn với terminal này (Click để đổi)';
  if (isSessionSleeping(s.id)) {
    badge.className = 'terminal-tab-affinity-badge sleeping';
    badge.textContent = '💤 Ngủ';
    badge.title = 'Terminal đang ngủ — click để đánh thức';
  }
  badge.onclick = (e) => {
    e.stopPropagation();
    showAffinityPicker(s.id, badge);
  };
  return badge;
}

/**
 * Create-or-update the tab wrap for one session. Extracted from `renderTabs` so
 * the grouping pass can order wraps after every one of them exists.
 */
function ensureTerminalTabWrap(s, currentWraps) {
  let wrap = currentWraps.get(s.id);
  const isActive = s.id === activeId;

  if (!wrap) {
    wrap = document.createElement('div');
    wrap.className = `terminal-tab-wrap${isActive ? ' active' : ''}`;
    wrap.setAttribute('data-session-id', s.id);
    wrap.draggable = false;

    // Pointer drag, not HTML5 drag. Windows routes HTML5 drag through OLE / DirectUI
    // (DUI70.dll); that path null-deref'd the process while a tab was dragged onto a
    // group. No setPointerCapture: capturing then removing the row (a session
    // broadcast mid-drag) swallows every later click in this page.
    wrap.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || s.splitOf) return;
      if (e.target && e.target.closest && e.target.closest('.terminal-tab-close, .terminal-tab-affinity-badge, .terminal-run-card, .terminal-run-steer-row')) return;
      pointerTabDrag = { sessionId: s.id, pointerId: e.pointerId, startX: e.clientX, startY: e.clientY, active: false, wrap };
    });

    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'terminal-tab';

    const icon = document.createElement('span');
    icon.className = 'terminal-tab-icon';
    icon.innerHTML = `<svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 5 8 8 4 11"/><line x1="9" y1="11" x2="13" y2="11"/></svg>`;

    const titleSpan = document.createElement('span');
    titleSpan.className = 'terminal-tab-title';
    titleSpan.textContent = s.name;

    // A split row is drawn one level in (CSS) and carries this glyph, so "Terminal
    // split-1" reads as a pane of the tab above it instead of a tab of its own.
    const splitGlyph = document.createElement('span');
    splitGlyph.className = 'terminal-tab-split-glyph';
    splitGlyph.textContent = '⤷';
    splitGlyph.title = splitGlyphTitle(s);

    const beacon = document.createElement('span');
    beacon.className = 'terminal-tab-status-beacon';
    if (isSessionSleeping(s.id)) beacon.classList.add('sleeping');

    // Affinity is inherited, never owned by a pane: a split's shell reports its parent's
    // session id, so a badge on a pane row could only ever read "chưa gán" and its picker
    // would write a key no process advertises. The tab that owns the pane carries it.
    const affinityBadge = s.splitOf ? null : createAffinityBadge(s);

    b.append(icon, splitGlyph, titleSpan);
    if (affinityBadge) b.append(affinityBadge);
    b.append(beacon);
    b.title = `${s.name} (Nhấp đúp hoặc chuột phải để đổi tên, kéo thả để sắp xếp)`;

    b.onclick = () => {
      if (wrap.classList.contains('renaming')) return;
      if (s.id !== activeId) {
        activateTabLocally(s.id);
        // A split is shown where a split lives: in the lower pane of the parent it
        // belongs to, because the main process keeps the active session base-scoped and
        // resolves a split to its parent.
        const targetSession = sessions.find((item) => item.id === s.id) || s;
        if (targetSession.splitOf) {
          mountSplit(targetSession.id, targetSession.buffer, targetSession.snapshotThroughSeq || 0);
        } else if (targetSession.splitSessionId) {
          mountSplit(targetSession.splitSessionId, targetSession.splitBuffer, targetSession.splitSnapshotThroughSeq || 0);
        } else {
          unmountSplit();
        }
        fitCurrentTerminal();
      }
      focusMainPane();
    };
    // Double click to rename
    b.ondblclick = (e) => {
      e.stopPropagation();
      if (wrap.classList.contains('renaming')) return;
      startInlineRename(s.id, wrap, titleSpan);
    };

    // Right click for context menu
    wrap.oncontextmenu = (e) => {
      showContextMenu(e, s.id);
    };

    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'terminal-tab-close';
    close.innerHTML = `<svg width="8" height="8" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="2" y1="2" x2="10" y2="10"/><line x1="10" y1="2" x2="2" y2="10"/></svg>`;
    close.title = s.splitOf ? 'Đóng pane chia đôi' : 'Đóng terminal';
    close.onclick = (e) => {
      e.stopPropagation();
      // A split is not a base session: closing it goes through the split API, which
      // takes the split id directly.
      if (s.splitOf) api.unsplitTerminal?.(s.id);
      else api.closeTerminal(s.id);
    };

    wrap.append(b, close);
    currentWraps.set(s.id, wrap);
    // Attach immediately: in-loop consumers (activity UI, category chip) resolve
    // the wrap through a selector, and `reorderTabChildren` fixes the final group
    // order once every header/wrap exists.
    if (wrap.parentNode !== tabsEl) {
      tabsEl.appendChild(wrap);
    }
  } else {
    wrap.classList.toggle('active', isActive);
    const titleSpan = wrap.querySelector('.terminal-tab-title');
    if (titleSpan && !wrap.classList.contains('renaming') && titleSpan.textContent !== s.name) {
      titleSpan.textContent = s.name;
    }
    let affinityBadge = wrap.querySelector('.terminal-tab-affinity-badge');
    if (s.splitOf) {
      // A wrap that became a pane row keeps no badge: the tab it splits owns the binding,
      // and `updateAffinityBadges` reads the key off whatever badge is in the DOM.
      affinityBadge?.remove();
    } else if (!affinityBadge) {
      affinityBadge = createAffinityBadge(s);
      const btn = wrap.querySelector('.terminal-tab');
      const beacon = wrap.querySelector('.terminal-tab-status-beacon');
      if (btn && beacon) {
        btn.insertBefore(affinityBadge, beacon);
      }
    }
    wrap.querySelector('.terminal-tab')?.setAttribute('title', `${s.name} (Nhấp đúp hoặc chuột phải để đổi tên, kéo thả để sắp xếp)`);
    // The glyph is created with the wrap, but the parent's name is live: a renamed
    // parent has to show up in the child's tooltip, not the name it had at creation.
    const splitGlyph = wrap.querySelector('.terminal-tab-split-glyph');
    if (splitGlyph) {
      const glyphTitle = splitGlyphTitle(s);
      if (splitGlyph.title !== glyphTitle) splitGlyph.title = glyphTitle;
    }
  }
  return wrap;
}

/** Create-or-refresh the collapsible group header for one category. */
function ensureCategoryHeader(group) {
  let header = categoryHeaders.get(group.key);
  if (!header) {
    header = document.createElement('div');
    header.className = 'terminal-tab-category-header';
    header.setAttribute('data-category', group.key);
    header.setAttribute('role', 'button');
    // A header is a group label, so it is never a drag SOURCE. It *is* a drop
    // target: dropping a tab on it re-assigns that tab's category. The drop never
    // splices the session list, so a header still cannot corrupt the tab order —
    // only group membership changes.
    header.draggable = false;
    // A `role="button"` a keyboard cannot reach is a lie, so the header takes focus and
    // answers Enter/Space exactly the way it answers a click.
    header.tabIndex = 0;

    const toggle = document.createElement('span');
    toggle.className = 'terminal-tab-category-toggle';
    toggle.textContent = '▾';

    const label = document.createElement('span');
    label.className = 'terminal-tab-category-label';

    // The `*` marker lives beside the name rather than inside it: the label must stay
    // exactly the group name the user typed, and a marker folded into that text would
    // leak into rename, search and the session's stored category.
    const star = document.createElement('span');
    star.className = 'terminal-tab-category-star';
    star.textContent = '*';
    star.title = 'Nhóm đã được đánh dấu *';

    // Marking, colouring and reordering are the same right as renaming, so they share
    // one guard: neither derived bucket can be renamed — the catch-all has no name to
    // change, and the sleep bucket's name is a state, not a category — and neither can
    // be marked, coloured or moved for the same reason. A capsule section is out for the
    // same reason again: it is named by the project store, not by the user, and letting the
    // group menu write one into `terminalCategories` would file a project as a group.
    // Dropping is the opposite — releasing a tab onto the catch-all is precisely how a tab
    // leaves its group — so the sleep bucket and capsule sections refuse drops, because
    // "file this terminal under a state" and "file this terminal under a storefront" are not
    // operations a drag can mean.
    const isCapsuleGroup = group.kind === 'capsule';
    const canManage = !isCapsuleGroup && group.key !== UNCATEGORIZED_CATEGORY && group.key !== SLEEPING_CATEGORY;
    const canAcceptDrop = !isCapsuleGroup && group.key !== SLEEPING_CATEGORY;

    // A rename affordance owned by the header itself: renaming a group is its own
    // operation and must not require right-clicking a tab.
    const rename = document.createElement('button');
    rename.type = 'button';
    rename.className = 'terminal-tab-category-rename';
    rename.textContent = '✎';
    rename.title = 'Đổi tên nhóm';
    rename.setAttribute('aria-label', 'Đổi tên nhóm');
    // `stopPropagation` so renaming never also toggles the collapse underneath it.
    rename.onclick = (e) => {
      e.stopPropagation();
      const key = header.getAttribute('data-category');
      if (key && key !== UNCATEGORIZED_CATEGORY) beginRenameCategory(key);
    };

    // The occasional group operations (mark, colour, order) sit behind one menu instead
    // of three more icon buttons: the sidebar column is 220px wide by default, and the
    // header already carries a toggle, a label, a pencil and a count-free right edge.
    const menu = document.createElement('button');
    menu.type = 'button';
    menu.className = 'terminal-tab-category-menu';
    menu.textContent = '⋮';
    menu.title = 'Sắp xếp, đổi màu, đánh dấu * cho nhóm';
    menu.setAttribute('aria-label', 'Sắp xếp, đổi màu, đánh dấu * cho nhóm');
    menu.onclick = (e) => {
      e.stopPropagation();
      const key = header.getAttribute('data-category');
      if (key) showCategoryMenu(key, menu);
    };

    header.append(toggle, star, label);
    if (isCapsuleGroup && typeof api?.capsuleGetBrief === 'function') {
      // The pinned brief is capsule metadata; its editor opens from the header that
      // names the capsule. The key is read back live, like the rename beside it.
      const briefBtn = document.createElement('button');
      briefBtn.type = 'button';
      briefBtn.className = 'terminal-tab-category-brief';
      briefBtn.textContent = '📌';
      briefBtn.title = 'Ghi chú dự án (storefront, site, theme, quy tắc cho agent)';
      briefBtn.setAttribute('aria-label', 'Ghi chú dự án');
      briefBtn.onclick = (e) => {
        e.stopPropagation();
        const key = header.getAttribute('data-category');
        if (isCapsuleGroupKey(key)) {
          openCapsuleBriefDialog(key.slice(CAPSULE_GROUP_PREFIX.length));
        }
      };
      header.appendChild(briefBtn);
    }
    if (canManage) header.append(rename, menu);
    header.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleCategoryCollapsed(group.key);
    });
    // Only when the header itself holds focus: the rename control lives inside it, and a
    // bubbled Enter there must open the rename, not also collapse the group underneath.
    header.addEventListener('keydown', (e) => {
      if (e.target !== header) return;
      if (e.key !== 'Enter' && e.key !== ' ') return;
      e.preventDefault();
      toggleCategoryCollapsed(group.key);
    });
    header.addEventListener('dragstart', (e) => e.preventDefault());

    // Drop target for a dragged tab. The key is read back from the live attribute
    // rather than the captured `group` object: the header element is reused across
    // renders per key, so a captured object could be stale. The sleep bucket gets no
    // drop handlers at all, so no drag can ever write a state as a category.
    if (canAcceptDrop) {
      header.addEventListener('dragover', (e) => {
        if (!dragSourceSessionId) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        header.classList.add('drag-over');
      });
      header.addEventListener('dragleave', () => {
        header.classList.remove('drag-over');
      });
      header.addEventListener('drop', (e) => {
        e.preventDefault();
        header.classList.remove('drag-over');
        const sourceId = e.dataTransfer.getData('text/plain');
        commitCategoryDrop(sourceId, header);
      });
    }

    categoryHeaders.set(group.key, header);
  }

  const label = header.querySelector('.terminal-tab-category-label');
  if (label && label.textContent !== group.label) label.textContent = group.label;
  // The group colour has to be visible in the layout the user actually works in. The
  // horizontal chip cannot carry it in the sidebar, so the header name does: an
  // uncoloured group falls back to the muted header CSS, and the derived palette gives
  // every real group a stable colour before the user picks one.
  if (label) {
    const labelColor = group.color || '';
    if (label.style.color !== labelColor) label.style.color = labelColor;
  }
  // The marker is a header class, so the `*` element is created once and the render
  // path only flips its visibility. It is a plain marker, not an ordering: the group
  // list stays wherever the user put it.
  header.classList.toggle('is-starred', starredCategories.has(group.key));
  // Which axis the section names is refreshed here rather than only at creation: a key is
  // reused across renders, and the marker is what tells a project section from a user group.
  header.classList.toggle('is-capsule-group', group.kind === 'capsule');
  header.setAttribute('data-group-kind', group.kind === 'capsule' ? 'capsule' : 'category');

  // While a filter is applied every surviving group is shown open: a collapsed group
  // hiding the very match the user just searched for would look like a failed search.
  const isCollapsed = collapsedCategories.has(group.key) && !tabSearchActive;
  header.setAttribute('aria-expanded', isCollapsed ? 'false' : 'true');
  const collapseTitle = isCollapsed ? `Mở nhóm ${group.label}` : `Thu gọn nhóm ${group.label}`;
  // A capsule section names a project, and the name alone is not enough to tell two
  // storefronts with the same title apart — the workspace behind it does that.
  header.title = group.hint ? `${collapseTitle} — ${group.hint}` : collapseTitle;
  return header;
}

function toggleCategoryCollapsed(key) {
  if (collapsedCategories.has(key)) collapsedCategories.delete(key);
  else collapsedCategories.add(key);
  persistTerminalTabPrefs();
  renderTabs();
}

/** Real, user-manageable category keys, in the order the sidebar paints them. */
function displayCategoryOrder() {
  const out = [];
  const seen = new Set();
  const add = (key) => {
    if (!key || key === UNCATEGORIZED_CATEGORY || key === SLEEPING_CATEGORY) return;
    // A capsule section is drawn in the same sidebar but is not a user group: this list is
    // what the group menu reorders and writes back into `terminalCategories`, which is the
    // list Main persists, so a project key must never be able to enter it.
    if (isCapsuleGroupKey(key)) return;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(key);
  };
  // `categoryOrder` is the sticky display order the grouping sorts by; the two loops
  // after it are defensive, so a key that somehow has no slot yet still counts and can
  // still be moved instead of silently dropping out of the menu.
  for (const key of categoryOrder) add(key);
  for (const key of terminalCategories) add(key);
  for (const s of (Array.isArray(sessions) ? sessions : [])) add(categoryKeyOf(s));
  return out;
}

/** Flip the `*` marker on one category. A marker only — never a re-order. */
function toggleCategoryStar(key) {
  if (!key || key === UNCATEGORIZED_CATEGORY || key === SLEEPING_CATEGORY) return;
  if (starredCategories.has(key)) starredCategories.delete(key);
  else starredCategories.add(key);
  renderTabs();
  persistTerminalTabPrefs();
}

/** Set (or, with `null`, reset) the chip colour of one category. */
function setCategoryColor(key, color) {
  if (!key || key === UNCATEGORIZED_CATEGORY || key === SLEEPING_CATEGORY) return;
  if (typeof color === 'string' && /^#[0-9a-f]{6}$/i.test(color)) categoryColors[key] = color;
  else delete categoryColors[key];
  renderTabs();
  persistTerminalTabPrefs();
}

/**
 * Move one category by `delta` slots and persist the result.
 *
 * The moved order is written back into `terminalCategories`, which is the list main
 * stores — the sticky `categoryOrder` is a render-time convenience that dies with the
 * process, so an order that only lived there would not survive a restart. A group that
 * existed only as a value on some tab is materialised into that list by the same write:
 * a group the user just rearranged is a group the user is managing.
 */
function moveCategory(key, delta) {
  const order = displayCategoryOrder();
  const from = order.indexOf(key);
  const to = from + delta;
  if (from < 0 || to < 0 || to >= order.length) return;
  order.splice(to, 0, order.splice(from, 1)[0]);
  terminalCategories = order.slice();
  categoryOrder.length = 0;
  for (const name of order) categoryOrder.push(name);
  // The catch-all keeps a trailing slot, so a group created later still lands with the
  // real groups rather than below the "no group" bucket.
  categoryOrder.push(UNCATEGORIZED_CATEGORY);
  renderTabs();
  persistTerminalTabPrefs();
}

/**
 * The group-level menu: mark with `*`, pick a colour, move the group. Follows the
 * `showCategoryPicker` conventions — same popover element, same anchor positioning,
 * same click-outside dismissal — so only one such surface can ever be open.
 */
function showCategoryMenu(key, anchorEl) {
  const popover = document.getElementById('categoryPickerPopover');
  if (!popover) return;
  if (!key || key === UNCATEGORIZED_CATEGORY || key === SLEEPING_CATEGORY) return;

  popover.innerHTML = '';
  // A group-level surface, so a leftover per-session binding must not linger.
  popover.removeAttribute('data-active-session-id');

  const header = document.createElement('div');
  header.className = 'terminal-category-picker-header';
  header.textContent = `Nhóm "${categoryLabelOf(key)}"`;
  popover.appendChild(header);

  const isStarred = starredCategories.has(key);
  const starItem = document.createElement('div');
  starItem.className = `terminal-category-picker-item${isStarred ? ' active' : ''}`;
  starItem.textContent = isStarred ? '✕ Bỏ đánh dấu *' : '* Đánh dấu nhóm';
  starItem.title = isStarred
    ? 'Bỏ dấu * khỏi nhóm này'
    : 'Đánh dấu * nhóm này (chỉ là dấu, không đổi thứ tự)';
  starItem.onclick = (ev) => {
    ev.stopPropagation();
    popover.style.display = 'none';
    toggleCategoryStar(key);
  };
  popover.appendChild(starItem);

  const swatchLabel = document.createElement('div');
  swatchLabel.className = 'terminal-category-picker-hint';
  swatchLabel.textContent = 'Màu nhóm';
  popover.appendChild(swatchLabel);

  const swatches = document.createElement('div');
  swatches.className = 'terminal-category-swatches';
  const currentColor = categoryColors[key];
  const auto = document.createElement('button');
  auto.type = 'button';
  // "Tự động" paints the colour the name derives on its own, so resetting is a visible
  // choice rather than a blind one.
  auto.className = `terminal-category-swatch auto${currentColor ? '' : ' active'}`;
  auto.style.background = derivedCategoryColorOf(key);
  auto.textContent = 'Tự động';
  auto.title = 'Màu suy ra từ tên nhóm';
  auto.onclick = (ev) => {
    ev.stopPropagation();
    popover.style.display = 'none';
    setCategoryColor(key, null);
  };
  swatches.appendChild(auto);
  CATEGORY_CHIP_COLORS.forEach((color) => {
    const swatch = document.createElement('button');
    swatch.type = 'button';
    swatch.className = `terminal-category-swatch${currentColor === color ? ' active' : ''}`;
    swatch.style.background = color;
    swatch.title = color;
    swatch.setAttribute('aria-label', `Đặt màu nhóm ${color}`);
    swatch.onclick = (ev) => {
      ev.stopPropagation();
      popover.style.display = 'none';
      setCategoryColor(key, color);
    };
    swatches.appendChild(swatch);
  });
  popover.appendChild(swatches);

  const order = displayCategoryOrder();
  const at = order.indexOf(key);
  const addMove = (label, delta, enabled) => {
    const item = document.createElement('div');
    item.className = `terminal-category-picker-item${enabled ? '' : ' is-disabled'}`;
    item.setAttribute('aria-disabled', enabled ? 'false' : 'true');
    item.textContent = label;
    if (enabled) {
      item.onclick = (ev) => {
        ev.stopPropagation();
        popover.style.display = 'none';
        moveCategory(key, delta);
      };
    }
    popover.appendChild(item);
  };
  addMove('↑ Chuyển lên', -1, at > 0);
  addMove('↓ Chuyển xuống', 1, at !== -1 && at < order.length - 1);

  const rect = anchorEl.getBoundingClientRect();
  popover.style.display = 'block';
  popover.style.left = `${Math.max(10, Math.min(window.innerWidth - 240, rect.left))}px`;
  popover.style.top = `${rect.bottom + 4}px`;

  const closeHandler = (e) => {
    if (!popover.contains(e.target) && e.target !== anchorEl) {
      popover.style.display = 'none';
      document.removeEventListener('click', closeHandler);
    }
  };
  setTimeout(() => document.addEventListener('click', closeHandler), 10);
}

/**
 * The shared name popover for a group-level operation, anchored to the control the
 * user clicked. Reuses the category-picker element so only one name surface can ever
 * be open, and drops any stale per-session binding it carried.
 */
function promptCategoryName(anchorEl, options) {
  const popover = document.getElementById('categoryPickerPopover');
  if (!popover) return;
  const opts = options || {};
  popover.innerHTML = '';
  // Not a per-session action, so a leftover session binding must not linger.
  popover.removeAttribute('data-active-session-id');

  const header = document.createElement('div');
  header.className = 'terminal-category-picker-header';
  header.textContent = opts.title || 'Tên nhóm';
  popover.appendChild(header);

  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'terminal-category-picker-input';
  input.placeholder = opts.placeholder || 'Tên nhóm… (Enter để lưu)';
  input.value = typeof opts.initial === 'string' ? opts.initial : '';
  input.spellcheck = false;
  popover.appendChild(input);

  if (opts.hint) {
    const hint = document.createElement('div');
    hint.className = 'terminal-category-picker-hint';
    hint.textContent = opts.hint;
    popover.appendChild(hint);
  }

  const submit = () => {
    const value = input.value.trim();
    popover.style.display = 'none';
    if (typeof opts.onSubmit === 'function') opts.onSubmit(value);
  };

  const confirm = document.createElement('div');
  confirm.className = 'terminal-category-picker-item confirm';
  confirm.textContent = '✓ Lưu (Enter)';
  confirm.onclick = (ev) => {
    ev.stopPropagation();
    submit();
  };
  popover.appendChild(confirm);

  input.addEventListener('click', (e) => e.stopPropagation());
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') {
      e.preventDefault();
      submit();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      popover.style.display = 'none';
    }
  });

  const rect = (anchorEl && typeof anchorEl.getBoundingClientRect === 'function')
    ? anchorEl.getBoundingClientRect()
    : { left: 10, bottom: 10 };
  popover.style.display = 'block';
  popover.style.left = `${Math.max(10, Math.min(window.innerWidth - 240, rect.left))}px`;
  popover.style.top = `${rect.bottom + 4}px`;

  const closeHandler = (e) => {
    if (!popover.contains(e.target) && e.target !== anchorEl) {
      popover.style.display = 'none';
      document.removeEventListener('click', closeHandler);
    }
  };
  setTimeout(() => document.addEventListener('click', closeHandler), 10);
  try { input.focus(); } catch {}
}

/**
 * Create an empty group. The name is registered before any tab joins it, which is the
 * whole point: the persisted group list is the only thing that can hold a group with
 * no tabs in it.
 */
function startNewCategory(anchorEl) {
  promptCategoryName(anchorEl, {
    title: 'Tạo nhóm mới',
    placeholder: 'Tên nhóm mới… (Enter để tạo)',
    hint: 'Nhóm rỗng vẫn được giữ lại. Kéo tab vào header để xếp vào nhóm.',
    onSubmit: (value) => {
      if (!value) return;
      const folded = value.toLowerCase();
      // Idempotent rather than a silent duplicate header.
      if (terminalCategories.some((name) => name.toLowerCase() === folded)) return;
      terminalCategories.push(value);
      persistTerminalTabPrefs();
      renderTabs();
    },
  });
}

/**
 * Rename a group, or delete it when the new name is empty.
 *
 * Every tab filed under the old name follows the rename, so renaming can never
 * silently empty a group or strand its tabs under a name that no longer exists.
 */
function beginRenameCategory(key) {
  const anchorEl = categoryHeaders.get(key) || null;
  promptCategoryName(anchorEl, {
    title: 'Đổi tên nhóm',
    placeholder: 'Tên nhóm mới… (Enter để lưu)',
    initial: key,
    hint: 'Để trống rồi Enter = xoá nhóm (tab trở về "Chưa phân nhóm").',
    onSubmit: (value) => {
      if (value === key) return;
      const affected = (Array.isArray(sessions) ? sessions : []).filter(
        (s) => s && typeof s.category === 'string' && s.category.trim() === key,
      );
      if (!value) {
        // Delete: the group disappears and its tabs fall back to uncategorised.
        terminalCategories = terminalCategories.filter((name) => name !== key);
        collapsedCategories.delete(key);
        // A colour and a marker belong to the group, so they leave with it. A stale
        // entry would repaint a group that later reuses the same name.
        delete categoryColors[key];
        starredCategories.delete(key);
        for (const s of affected) applyCategoryToSession(s.id, '', null);
      } else {
        // A rename can collide with an existing group; de-dupe keeps a single header.
        const seen = new Set();
        terminalCategories = terminalCategories
          .map((name) => (name === key ? value : name))
          .filter((name) => {
            const folded = name.toLowerCase();
            if (seen.has(folded)) return false;
            seen.add(folded);
            return true;
          });
        // Carry the collapsed state across so a collapsed group stays collapsed.
        if (collapsedCategories.has(key)) {
          collapsedCategories.delete(key);
          collapsedCategories.add(value);
        }
        // The colour and the marker belong to the group, so they follow the name. A
        // rename that merges into an existing group keeps the survivor's own colour
        // rather than overwriting a choice the user already made for it.
        if (categoryColors[key]) {
          if (!categoryColors[value]) categoryColors[value] = categoryColors[key];
          delete categoryColors[key];
        }
        if (starredCategories.has(key)) {
          starredCategories.delete(key);
          starredCategories.add(value);
        }
        for (const s of affected) applyCategoryToSession(s.id, value, null);
      }
      persistTerminalTabPrefs();
      renderTabs();
    },
  });
}

/**
 * Horizontal mode conveys grouping with a colour chip on the pill instead.
 *
 * In the manager shell the chip names the capsule, because that is the grouping the row is
 * filed under and the only layout where the capsule is not already written above the row: a
 * project section header names it in the sidebar, so a row inside one carries no chip, while
 * a sleeping row — parked in the state bucket, outside every section — keeps its capsule.
 */
function applyCategoryChip(wrap, group, isSidebarLayout, session) {
  const btn = wrap.querySelector('.terminal-tab');
  if (!btn) return;
  const existing = wrap.querySelector('.terminal-tab-category-chip');
  const capsuleId = isSharedManagerShell() ? capsuleIdOf(session) : '';
  const headerNamesTheCapsule = isSidebarLayout && group.kind === 'capsule';
  if (capsuleId && !headerNamesTheCapsule) {
    const chip = existing || createCategoryChip(wrap, btn);
    const label = capsuleLabelOf(capsuleId);
    const path = capsulePathOf(capsuleId);
    const className = 'terminal-tab-category-chip terminal-tab-capsule-chip';
    if (chip.className !== className) chip.className = className;
    chip.setAttribute('data-capsule-id', capsuleId);
    chip.removeAttribute('data-category');
    const tip = path ? `Dự án: ${label} — ${path}` : `Dự án: ${label}`;
    if (chip.title !== tip) chip.title = tip;
    chip.style.background = derivedCategoryColorOf(capsuleId);
    if (chip.textContent !== label) chip.textContent = label;
    return;
  }
  if (isSidebarLayout || group.key === UNCATEGORIZED_CATEGORY || group.key === SLEEPING_CATEGORY) {
    if (existing) existing.remove();
    return;
  }
  const chip = existing || createCategoryChip(wrap, btn);
  if (chip.className !== 'terminal-tab-category-chip') chip.className = 'terminal-tab-category-chip';
  chip.removeAttribute('data-capsule-id');
  chip.setAttribute('data-category', group.key);
  chip.title = `Nhóm: ${group.label}`;
  chip.style.background = group.color;
  if (chip.textContent !== group.label) chip.textContent = group.label;
}

/** The chip element every grouping label shares, placed before the affinity badge. */
function createCategoryChip(wrap, btn) {
  const chip = document.createElement('span');
  chip.className = 'terminal-tab-category-chip';
  const badge = btn.querySelector('.terminal-tab-affinity-badge');
  if (badge) btn.insertBefore(chip, badge);
  else btn.appendChild(chip);
  return chip;
}

/**
 * Put every header/wrap child of the strip into the computed group order. The
 * "+" button stays pinned first so the sticky affordance never moves.
 */
/** Live tab-search query. Empty means "no filter" and is a strict no-op. */
let tabSearchQuery = '';
/** True while a filter is applied: groups render expanded and emptied ones drop out. */
let tabSearchActive = false;
/** The "no matches" notice, created once and then reused. */
let tabSearchEmptyEl = null;

/**
 * Fold text for matching: case-, accent- and `đ`-insensitive. This list is full of
 * Vietnamese names and paths, so "cau hinh" has to find "Cấu hình" and "don hang" has to
 * find "Đơn hàng" — a search box that cannot do that is useless in this workspace.
 */
function foldForSearch(value) {
  return String(value === null || value === undefined ? '' : value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[đĐ]/g, 'd')
    .toLowerCase();
}

function parseSearchTokens(query) {
  return foldForSearch(query).split(/\s+/).filter(Boolean);
}

/** True when `needle` occurs in `haystack` in order, gaps allowed. */
function isSubsequence(needle, haystack) {
  let i = 0;
  for (let j = 0; j < haystack.length && i < needle.length; j += 1) {
    if (haystack[j] === needle[i]) i += 1;
  }
  return i === needle.length;
}

/**
 * Smart match for one token: a literal substring always counts, while a fuzzy
 * subsequence counts only from three characters up, so "sh2" finds "Seahorse2" but a
 * stray "a" cannot match half the strip.
 */
function tokenMatchesHaystack(token, haystack) {
  if (haystack.includes(token)) return true;
  // A path fragment is matched literally: fuzzy-matching across a separator would let
  // "work\apps" match "work\don-hang apps", which is not the folder the user named.
  if (token.includes('\\') || token.includes('/')) return false;
  if (token.length < 3) return false;
  return isSubsequence(token, haystack);
}

/**
 * Every token must match somewhere in the session's searchable text (AND), which is what
 * makes a second word narrow the result instead of widening it.
 */
function sessionMatchesQuery(session, tokens) {
  if (tokens.length === 0) return true;
  if (!session) return false;
  const capsuleId = capsuleIdOf(session);
  const haystack = [
    foldForSearch(session.name),
    foldForSearch(session.cwd),
    foldForSearch(session.category),
    // In the manager the capsule is the row's grouping, so a query that names a storefront
    // has to narrow to its terminals: searching "Comnieusiba" across a mixed strip is how a
    // user reaches that project's rows without scrolling past every other one.
    foldForSearch(capsuleId && isSharedManagerShell() ? `${capsuleLabelOf(capsuleId)} ${capsulePathOf(capsuleId)}` : ''),
  ].join(' ');
  return tokens.every((token) => tokenMatchesHaystack(token, haystack));
}

/** The single write path for the query, so field, filter and chrome never diverge. */
function setTabSearchQuery(value) {
  const next = typeof value === 'string' ? value : '';
  tabSearchQuery = next;
  if (tabSearchInput && tabSearchInput.value !== next) tabSearchInput.value = next;
  renderTabs();
  updateTabSearchUi();
}

/** Reflect query state on the field: the clear button only exists when it can act. */
function updateTabSearchUi() {
  const hasQuery = tabSearchQuery.length > 0;
  if (tabSearchField) tabSearchField.classList.toggle('has-query', hasQuery);
  if (btnClearTabSearch) btnClearTabSearch.style.display = hasQuery ? 'flex' : 'none';
}

function ensureSearchEmptyState() {
  if (!tabSearchEmptyEl) {
    tabSearchEmptyEl = document.createElement('div');
    tabSearchEmptyEl.className = 'terminal-tab-search-empty';
    tabSearchEmptyEl.setAttribute('role', 'status');
  }
  const text = `Không có tab nào khớp “${tabSearchQuery.trim()}”`;
  if (tabSearchEmptyEl.textContent !== text) tabSearchEmptyEl.textContent = text;
  return tabSearchEmptyEl;
}

/**
 * Order one group's sessions so a split pane renders directly under the tab it belongs
 * to. A split is a separate session with its own row, so leaving it wherever main's list
 * happens to put it is what makes a split read as a second tab the user never opened. A
 * split whose parent is in another group (or already closed) keeps its own slot rather
 * than being hidden: that row is the only way to reach and close the pane.
 */
function orderGroupItems(items) {
  const byId = new Map();
  for (const s of items) byId.set(s.id, s);
  const childrenByParent = new Map();
  const roots = [];
  for (const s of items) {
    const parentId = (s && typeof s.splitOf === 'string') ? s.splitOf : '';
    if (parentId && parentId !== s.id && byId.has(parentId)) {
      const list = childrenByParent.get(parentId);
      if (list) list.push(s);
      else childrenByParent.set(parentId, [s]);
    } else {
      roots.push(s);
    }
  }
  if (roots.length === items.length) return items;
  const out = [];
  for (const s of roots) {
    out.push(s);
    const children = childrenByParent.get(s.id);
    if (children) {
      for (const child of children) out.push(child);
    }
  }
  // Defensive: a session that somehow is neither a root nor a known parent's child
  // still has a row. A pane the sidebar drops is a pane that cannot be closed.
  if (out.length !== items.length) {
    const emitted = new Set(out.map((s) => s.id));
    for (const s of items) {
      if (!emitted.has(s.id)) out.push(s);
    }
  }
  return out;
}

function reorderTabChildren(ordered) {
  if (!tabsEl) return;
  // One pinned row instead of two loose buttons: the search field and both create
  // actions travel together, and no tab drag can reorder them apart.
  const pinned = (tabToolbar && tabToolbar.parentNode === tabsEl) ? tabToolbar : null;
  let ref = null;
  for (let i = ordered.length - 1; i >= 0; i -= 1) {
    const el = ordered[i];
    if (ref && ref.parentNode === tabsEl) {
      tabsEl.insertBefore(el, ref);
    } else {
      tabsEl.appendChild(el);
    }
    ref = el;
  }
  if (pinned && tabsEl.firstChild !== pinned) {
    tabsEl.insertBefore(pinned, tabsEl.firstChild);
  }
}

function renderTabs() {
  const currentWraps = new Map();
  tabsEl.querySelectorAll('.terminal-tab-wrap').forEach((el) => {
    const sid = el.getAttribute('data-session-id');
    if (sid) currentWraps.set(sid, el);
  });

  const isSidebarLayout = terminalTabLayout === 'sidebar';

  // Smart search narrows INSIDE each group instead of pre-filtering the sessions that get
  // grouped. Grouping only the matching subset lets a filter rewrite the sticky group
  // order: a group with no match is pruned out of `categoryOrder` and comes back at the
  // end once the query is cleared. An empty query is a strict no-op.
  const searchTokens = parseSearchTokens(tabSearchQuery);
  tabSearchActive = searchTokens.length > 0;
  const allSessions = Array.isArray(sessions) ? sessions : [];
  const narrow = (items) => (tabSearchActive
    ? items.filter((s) => sessionMatchesQuery(s, searchTokens))
    : items);

  // Sleeping sessions are a state, not a category, so they are partitioned out before
  // grouping: an asleep tab must never sit inside a group of live ones. This is purely a
  // display split — `session.category` is never touched — which is exactly why waking a
  // tab puts it back in its own group without anything having to remember where it was.
  // The bucket is appended last so it reads as "parked", after everything still running.
  const awakeSessions = [];
  const sleepingSessions = [];
  // A pane's row belongs to the tab it splits, so a parked tab parks its rows. Main
  // parks a parent's panes in the same transition; this set covers the broadcast that
  // already shows the parent asleep before the pane's own state lands, which is the
  // window where the pane is filed by its own category — the parent it inherits its
  // group from is missing from the awake set — and leaks into another group.
  const sleepingParentIds = new Set(
    allSessions.filter((s) => s && s.state === 'sleeping' && !s.splitOf).map((s) => s.id),
  );
  for (const s of allSessions) {
    if (!s) continue;
    if (s.state === 'sleeping') {
      // Sleeping split panes are implementation rows, not independent tabs.
      // The split toggle wakes the existing session when the row is hidden.
      if (!s.splitOf) sleepingSessions.push(s);
      continue;
    }
    if (s.splitOf && sleepingParentIds.has(s.splitOf)) continue;
    awakeSessions.push(s);
  }
  const groups = groupSessionsByCategory(awakeSessions);
  if (sleepingSessions.length > 0) {
    groups.push({
      key: SLEEPING_CATEGORY,
      kind: 'sleep',
      label: SLEEPING_CATEGORY_LABEL,
      color: '',
      items: sleepingSessions,
    });
  }
  // A registered group that is genuinely empty keeps its header; one emptied by the
  // active filter drops out, because a header over nothing is noise while filtering.
  const visibleGroups = tabSearchActive
    ? groups
      .map((g) => Object.assign({}, g, { items: narrow(g.items) }))
      .filter((g) => g.items.length > 0)
    : groups;
  const visibleCount = visibleGroups.reduce((total, g) => total + g.items.length, 0);

  // Drop the wrap of every session that is gone, plus every tab the filter excludes. A
  // filtered-out wrap left in the DOM is invisible to `ordered`, so it could never be
  // positioned and would strand itself in the middle of the strip.
  const visibleSessionIds = new Set();
  for (const g of visibleGroups) {
    for (const s of g.items) visibleSessionIds.add(s.id);
  }
  for (const [sid, el] of currentWraps.entries()) {
    if (!visibleSessionIds.has(sid)) {
      el.remove();
      currentWraps.delete(sid);
    }
  }

  // Headers are a sidebar-only affordance: drop anything that is not live in the
  // current layout so a layout flip cannot strand an orphan header in the strip. This
  // reads `visibleGroups`: a group emptied by the active filter is not rendered, so its
  // header must be dropped too or it would be stranded outside the ordered run.
  const liveKeys = new Set(visibleGroups.map((g) => g.key));
  for (const [key, header] of Array.from(categoryHeaders.entries())) {
    if (!isSidebarLayout || !liveKeys.has(key)) {
      header.remove();
      categoryHeaders.delete(key);
    }
  }

  const ordered = [];
  for (const group of visibleGroups) {
    if (isSidebarLayout) {
      const header = ensureCategoryHeader(group);
      if (header) ordered.push(header);
    }
    const isCollapsed = isSidebarLayout && collapsedCategories.has(group.key) && !tabSearchActive;
    for (const s of orderGroupItems(group.items)) {
      const wrap = ensureTerminalTabWrap(s, currentWraps);
      wrap.classList.toggle('is-sleeping', s.state === 'sleeping');
      // A split pane keeps its row — it is how the pane is focused and closed — but it
      // is drawn as a child of the tab it splits, not as a peer the user has to tell
      // apart from a real tab.
      wrap.classList.toggle('is-split-pane', Boolean(s.splitOf));
      // A pane is moved by the tab that owns it, never on its own: a split cannot be
      // reordered away from its parent, and its group follows the parent's, so dragging a
      // pane row could only produce a drop the next render would undo.
      wrap.draggable = false;
      wrap.classList.toggle('is-category-collapsed', isCollapsed);
      applyCategoryChip(wrap, group, isSidebarLayout, s);
      updateTabActivityUi(s.id);
      applyRunCardToWrap(wrap, s.id);
      ordered.push(wrap);
    }
  }
  // A filtered-out strip says so rather than just looking empty. The notice joins the
  // ordered run so its position stays deterministic across renders.
  if (tabSearchActive && visibleCount === 0) {
    ordered.push(ensureSearchEmptyState());
  } else if (tabSearchEmptyEl && tabSearchEmptyEl.parentNode === tabsEl) {
    tabSearchEmptyEl.remove();
  }
  reorderTabChildren(ordered);

  // Directly scroll tabs bar if active tab is clipped (no window-level scrolling).
  // The axis follows the tab-strip layout: the horizontal strip scrolls on X, the
  // sidebar scrolls on Y. Mutating `scrollLeft` while the sidebar is active is a
  // silent no-op, which would leave the active tab clipped out of view. Computed
  // from rects rather than `scrollIntoView` so a tab activation can never scroll
  // an ancestor outside the strip.
  if (activeId) {
    const activeWrap = tabsEl.querySelector(`.terminal-tab-wrap[data-session-id="${activeId}"]`);
    if (activeWrap && tabsEl) {
      const tabRect = activeWrap.getBoundingClientRect();
      const containerRect = tabsEl.getBoundingClientRect();
      if (terminalTabLayout === 'sidebar') {
        if (tabRect.top < containerRect.top) {
          tabsEl.scrollTop += (tabRect.top - containerRect.top) - 10;
        } else if (tabRect.bottom > containerRect.bottom) {
          tabsEl.scrollTop += (tabRect.bottom - containerRect.bottom) + 10;
        }
      } else if (tabRect.left < containerRect.left) {
        tabsEl.scrollLeft += (tabRect.left - containerRect.left) - 10;
      } else if (tabRect.right > containerRect.right) {
        tabsEl.scrollLeft += (tabRect.right - containerRect.right) + 10;
      }
    }
  }
  updateAffinityBadges(deliveredTabs, deliveredAffinities);
}

let initialPushReceived = false;
api?.onTerminalSession((state) => {
  initialPushReceived = true;
  const prevActiveId = activeId;
  sessions = state.sessions || [];
  if (!isPopoutMode) {
    activeId = state.activeSessionId || activeId;
  } else {
    if (!activeId || !sessions.some((s) => s.id === activeId)) {
      const initialSessionId = urlParams.get('sessionId');
      if (initialSessionId && sessions.some((s) => s.id === initialSessionId)) {
        activeId = initialSessionId;
      } else {
        activeId = state.activeSessionId || sessions[0]?.id || '';
      }
    }
  }
  const activeSession = sessions.find((s) => s.id === activeId);
  const switchedTabs = prevActiveId !== activeId;
  // `splitSessionId` names only the first split a parent owns, so a split the user
  // opened by its own tab stays mounted under its parent; its entry carries that
  // split's tail, where the parent's `splitBuffer` only describes the first.
  const mountedSplitSurvives = Boolean(activeSession) && Boolean(splitId) && Boolean(splitTerm)
    && sessions.some((s) => s.id === splitId && s.splitOf === activeSession.id);
  const splitToMount = activeSession?.splitSessionId
    ? (mountedSplitSurvives ? splitId : activeSession.splitSessionId)
    : '';
  if (splitToMount) {
    const splitEntry = sessions.find((s) => s.id === splitToMount);
    const isFirstSplit = splitToMount === activeSession.splitSessionId;
    if (switchedTabs && splitId === splitToMount && splitTerm) {
      // Same split survives a tab switch: re-hydrate from the authoritative
      // transcript (getFullBuffer) rather than trusting the cached splitBuffer.
      atomicHydrateSplitPane(splitId);
    } else {
      mountSplit(
        splitToMount,
        splitEntry ? splitEntry.buffer : (isFirstSplit ? activeSession.splitBuffer : undefined),
        splitEntry?.snapshotThroughSeq || (isFirstSplit ? (activeSession.splitSnapshotThroughSeq || 0) : 0),
      );
    }
  } else {
    unmountSplit();
  }
  renderTabs();
  syncTerminalPool(sessions, activeId, state.snapshot, state.snapshotThroughSeq || 0);
  // The pane for a woken session exists only after the pool sync above, so the
  // keystroke that caused the wake is delivered here.
  flushDeferredWakeInput();
});
api?.onTabsUpdated?.(async (payload) => {
  const tabs = payload?.tabs;
  const affinities = payload?.terminalAffinities;
  if (Array.isArray(tabs)) deliveredTabs = tabs;
  if (affinities && typeof affinities === 'object') deliveredAffinities = affinities;
  updateAffinityBadges(tabs, affinities);
  const popover = document.getElementById('affinityPickerPopover');
  if (popover && popover.style.display === 'block') {
    const currentSid = popover.getAttribute('data-active-session-id') || activeId;
    // Rebuild only when the picker's content actually changed. Tabs broadcasts
    // fire on every title/loading update, and rebuilding mid-click eats the
    // click by replacing the element under the cursor.
    const currentAffinity = api.getTerminalAffinity ? await api.getTerminalAffinity(currentSid) : undefined;
    const managed = Array.isArray(currentAffinity?.managedTabIds) ? currentAffinity.managedTabIds : (currentAffinity?.tabId ? [currentAffinity.tabId] : []);
    const primaryId = currentAffinity?.primaryTabId || currentAffinity?.tabId;
    const sig = `${managed.slice().sort().join(',')}|${primaryId || ''}|${(Array.isArray(tabs) ? tabs : []).length}`;
    if (sig === popover.getAttribute('data-managed-sig')) return;
    // The IPC round-trip above gave the user time to click-outside-dismiss;
    // re-check before rebuilding so a dismissed popover never re-opens.
    if (popover.style.display !== 'block') return;
    const anchor = document.querySelector(`.terminal-tab-affinity-badge[data-session-id="${currentSid}"]`);
    if (anchor) {
      showAffinityPicker(currentSid, anchor);
    }
  }
});
// One handler for both channels. 'antifan:terminal:data' reaches this surface
// only for sessions it displays; 'antifan:terminal:activity' is the lightweight
// envelope main sends for every other admitted session. They share the whole
// path: the tab strip keeps its streaming indicator and the subscriber ack for
// either channel, and a chunk NEVER materializes an xterm — a session with no
// pane is acked and left to hydrate from the authoritative transcript the next
// time it is activated. An active pane on an activity chunk still applies it:
// main suppresses by surface visibility, which can lag a local activation by a
// projection push, and the live write is always the cheaper recovery.
function handleIncomingTerminalChunk({ sessionId, data, seq, generation, fromSeq, throughSeq }) {
  __terminalBench?.record('T1', { sessionId, seq, len: data ? data.length : 0 });
  const chunkSeq = typeof seq === 'number' ? seq : 0;
  const chunkGen = typeof generation === 'number' ? generation : 0;
  const chunk = { seq: chunkSeq, generation: chunkGen, data, fromSeq, throughSeq };

  // Tab activity is tab-strip state, independent of which pane is mounted;
  // a background tab running an AI turn is exactly the tab the user cannot see;
  // updateTabActivityUi keeps the 💤 presentation for sleeping sessions.
  notifySessionActivity(sessionId, data);

  if (sessionId === splitId && splitTerm) {
    // The split pane mounts outside the tab pool and carries no .active class —
    // it is always visible while mounted, so it must keep receiving writes.
    processIncomingChunk(splitSessionState, chunk, true);
    // Its pooled pane (if any) is hidden while the split is mounted: keep its
    // rendered cursor in step so a later activation rehydrates instead of
    // walking a delta chain from a stale seq.
    const pooled = rawTerminalPool.get(sessionId);
    if (pooled) {
      pooled.needsRehydrate = true;
      const end = (typeof throughSeq === 'number' && throughSeq > 0) ? throughSeq : chunkSeq;
      if (end > pooled.lastRenderedSeq) pooled.lastRenderedSeq = end;
      if (chunkGen > 0) pooled.sessionGeneration = chunkGen;
    }
    return;
  }

  // A sleeping session must never be materialized here either. Its cursor is
  // still advanced and ACKed when a pane is somehow present, so a wake resumes
  // from the right sequence instead of walking a delta chain from stale state.
  if (isSessionSleeping(sessionId)) {
    const pooled = rawTerminalPool.get(sessionId);
    const end = (typeof throughSeq === 'number' && throughSeq > 0) ? throughSeq : chunkSeq;
    if (pooled) {
      pooled.needsRehydrate = true;
      if (chunkGen > 0) pooled.sessionGeneration = chunkGen;
      if (end > pooled.lastRenderedSeq) pooled.lastRenderedSeq = end;
      scheduleCoalescedAck(sessionId, pooled.sessionGeneration || 0, pooled.lastRenderedSeq);
    } else if (end > 0) {
      scheduleCoalescedAck(sessionId, chunkGen, end);
    }
    return;
  }

  // Peek, never get: terminalPool.get would build the pane on first data. A
  // session this surface does not display keeps no xterm at all — the burst
  // only moves the activity indicator and the ack cursor, and the transcript
  // lands in one hydrate on activation (tail + seq deltas via
  // atomicHydratePane/syncPaneWithBackend, full buffer if the seq chain broke).
  const item = rawTerminalPool.get(sessionId);
  if (!item) {
    const end = (typeof throughSeq === 'number' && throughSeq > 0) ? throughSeq : chunkSeq;
    if (end > 0) scheduleCoalescedAck(sessionId, chunkGen, end);
    return;
  }

  if (!item.paneEl.classList.contains('active')) {
    // Hidden pane: skip the xterm parse/paint entirely. Still advance the
    // rendered cursor and ACK so the main-process subscriber is not pruned;
    // the next activation rehydrates from a snapshot via needsRehydrate.
    item.needsRehydrate = true;
    if (chunkGen > 0) {
      if (item.sessionGeneration > 0 && chunkGen !== item.sessionGeneration) {
        item.lastRenderedSeq = 0;
        item.liveQueue = [];
      }
      item.sessionGeneration = chunkGen;
    }
    const end = (typeof throughSeq === 'number' && throughSeq > 0) ? throughSeq : chunkSeq;
    if (end > item.lastRenderedSeq) item.lastRenderedSeq = end;
    scheduleCoalescedAck(sessionId, item.sessionGeneration || 0, item.lastRenderedSeq);
    return;
  }

  processIncomingChunk(item, chunk, false);
}
api?.onTerminalData(handleIncomingTerminalChunk);
api?.onTerminalActivity?.(handleIncomingTerminalChunk);
async function bootstrapTerminalState() {
  let initialCwd = undefined;
  try {
    const s = await api?.getInitialState?.();
    // The shell's own project/workspace arrives here; every terminal this surface
    // creates is scoped by it rather than by whatever the main process considers
    // globally active.
    applyShellScope(s);
    initialCwd = shellScope.workspacePath || undefined;
    // Paint the persisted tab-strip layout before the first terminal mounts, so
    // the initial grid geometry is the user's rather than a horizontal-then-reflow
    // flash. The main process already validated and clamped these values.
    applyCollapsedCategories(s?.terminalTabPrefs?.collapsedCategories);
    applyCategories(s?.terminalTabPrefs?.categories);
    applyCategoryColors(s?.terminalTabPrefs?.categoryColors);
    applyStarredCategories(s?.terminalTabPrefs?.starredCategories);
    applyTerminalTabLayout(s?.terminalTabPrefs?.layout, s?.terminalTabPrefs?.sidebarWidth);
    // The boot projection paints the same cards the push channel maintains, so a
    // freshly mounted surface shows live runs before the first sweep lands.
    if (Array.isArray(s?.runCards)) applyRunCardStates(s.runCards);
  } catch {}
  try {
    await api?.startTerminal?.(initialCwd);
  } catch {}

  try {
    const listFn = api?.listTerminals || api?.listSessions;
    // The daemon proxy warms its session cache asynchronously after connect; a
    // list call that lands inside that window returns [] even though the host
    // owns dozens of live sessions. Treating that as "no terminals" both hides
    // every tab and mints a stray empty shell (the pile of "Terminal N" rows a
    // restart used to leave behind). Retry briefly before believing the empty
    // answer; only a still-empty list after the window means "really none".
    let sessionList = await listFn?.();
    for (let attempt = 0; (!Array.isArray(sessionList) || sessionList.length === 0) && attempt < 10; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 300));
      sessionList = await listFn?.();
    }
    if (Array.isArray(sessionList) && sessionList.length > 0) {
      sessions = sessionList;
      if (!activeId || !sessions.some((item) => item.id === activeId)) {
        const initialSessionId = urlParams.get('sessionId');
        if (initialSessionId && sessions.some((item) => item.id === initialSessionId)) {
          activeId = initialSessionId;
        } else {
          activeId = sessions[0]?.id || '';
        }
      }
      // A push that lands while the host cache is still cold renders an empty strip.
      // That must not suppress this corrective paint, or the sidebar stays blank until
      // the next host broadcast. When a push did render the list, the wraps are already
      // in the DOM and this is a no-op.
      if (!initialPushReceived || tabsEl.querySelectorAll('.terminal-tab-wrap').length === 0) {
        renderTabs();
        syncTerminalPool(sessions, activeId);
      }
    } else if (api?.newTerminal) {
      await createTerminal();
    }
  } catch {}
  void refreshBridgeStatus();
  if (!bridgePollInterval) {
    bridgePollInterval = setInterval(() => { void refreshBridgeStatus(); }, 10000);
    if (bridgePollInterval && typeof bridgePollInterval.unref === 'function') {
      bridgePollInterval.unref();
    }
  }
}
bootstrapTerminalState();

// Coalesced to at most one fit/refresh pass per animation frame: resize storms
// (window resize, split drags, observer bursts) collapse into a single pass.
let fitScheduledThisFrame = false;

function fitCurrentTerminal() {
  if (fitScheduledThisFrame) return;
  fitScheduledThisFrame = true;
  requestAnimationFrame(() => {
    fitScheduledThisFrame = false;
  });
  if (activeId && !isSessionSleeping(activeId)) {
    const item = terminalPool.get(activeId);
    if (item && item.paneEl.classList.contains('active')) {
      item.isProgrammaticScroll = true;
      try {
        let didResize = false;
        const propose = item.fit.proposeDimensions();
        if (propose && propose.cols >= MIN_TERMINAL_COLS && propose.rows >= MIN_TERMINAL_ROWS && (container?.clientWidth || 0) > 50) {
          if (item.term.cols !== propose.cols || item.term.rows !== propose.rows) {
            item.term.resize(propose.cols, propose.rows);
            api?.resizeTerminalTo(activeId, propose.cols, propose.rows);
            didResize = true;
          }
        }
        // Full-line refresh is only needed when the grid actually resized.
        if (didResize) {
          item.term.refresh(0, item.term.rows - 1);
        }
        if (!item.isUserScrolledUp && viewportAtBottom(item.term)) {
          item.term.scrollToBottom();
        }
      } catch {} finally {
        setTimeout(() => {
          if (item) item.isProgrammaticScroll = false;
        }, 80);
      }
    }
  }
  if (splitEnabled && splitFitAddon && splitTerm && splitId) {
    try {
      let splitDidResize = false;
      const splitPropose = splitFitAddon.proposeDimensions();
      if (splitPropose && splitPropose.cols >= MIN_TERMINAL_COLS && splitPropose.rows >= MIN_SPLIT_TERMINAL_ROWS) {
        if (splitTerm.cols !== splitPropose.cols || splitTerm.rows !== splitPropose.rows) {
          splitTerm.resize(splitPropose.cols, splitPropose.rows);
          api?.resizeTerminalTo(splitId, splitPropose.cols, splitPropose.rows);
          splitDidResize = true;
        }
      }
      if (splitDidResize) {
        splitTerm.refresh(0, splitTerm.rows - 1);
      }
    } catch {}
  }
}
if (window.ResizeObserver) {
  globalResizeObserver = new ResizeObserver(() => {
    clearTimeout(resizeDebounceTimer);
    resizeDebounceTimer = setTimeout(() => {
      fitCurrentTerminal();
    }, 20);
  });
  if (container) globalResizeObserver.observe(container);
  if (mainPane) globalResizeObserver.observe(mainPane);
}

window.addEventListener('beforeunload', () => {
  if (bridgePollInterval) {
    clearInterval(bridgePollInterval);
    bridgePollInterval = null;
  }
  if (typeof bridgeStatusUnsubscribe === 'function') {
    try { bridgeStatusUnsubscribe(); } catch {}
    bridgeStatusUnsubscribe = null;
  }
  if (runCardElapsedTimer) {
    clearInterval(runCardElapsedTimer);
    runCardElapsedTimer = null;
  }
  if (typeof runCardsUnsubscribe === 'function') {
    try { runCardsUnsubscribe(); } catch {}
    runCardsUnsubscribe = null;
  }
  closeCapsuleBriefDialog();
  if (globalResizeObserver) {
    try { globalResizeObserver.disconnect(); } catch {}
  }
});
window.addEventListener('unload', () => {
  if (bridgePollInterval) {
    clearInterval(bridgePollInterval);
    bridgePollInterval = null;
  }
  if (typeof bridgeStatusUnsubscribe === 'function') {
    try { bridgeStatusUnsubscribe(); } catch {}
    bridgeStatusUnsubscribe = null;
  }
  if (runCardElapsedTimer) {
    clearInterval(runCardElapsedTimer);
    runCardElapsedTimer = null;
  }
  if (typeof runCardsUnsubscribe === 'function') {
    try { runCardsUnsubscribe(); } catch {}
    runCardsUnsubscribe = null;
  }
  closeCapsuleBriefDialog();
});

window.addEventListener('resize', () => {
  fitCurrentTerminal();
  requestAnimationFrame(() => fitCurrentTerminal());
});
document.fonts?.ready?.then?.(() => {
  requestAnimationFrame(() => {
    fitCurrentTerminal();
    setTimeout(() => fitCurrentTerminal(), 120);
  });
});

window.addEventListener('scroll', () => {
  if (window.scrollX !== 0 || window.scrollY !== 0) {
    window.scrollTo(0, 0);
  }
}, { passive: true });

const btnPopoutWindow = document.getElementById('btnPopoutWindow');
const btnNewTerminalWindow = document.getElementById('btnNewTerminalWindow');
const btnFullscreenHeader = document.getElementById('btnFullscreenHeader');

if (isPopoutMode) {
  if (btnPopoutWindow) {
    btnPopoutWindow.title = 'Gắn lại vào cửa sổ chính (Re-dock)';
    btnPopoutWindow.innerHTML = `
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
        <path d="M6 2H2v4M2 2l6 6M10 4h3a1 1 0 011 1v8a1 1 0 01-1 1H5a1 1 0 01-1-1v-3"/>
      </svg>`;
  }
}
document.getElementById('btnOpenFolder')?.addEventListener('click', async () => {
  await api?.pickWorkspaceFolder?.(activeId);
});
const openNewWin = () => {
  api?.openNewTerminalWindow?.(activeId);
};

btnNewTerminalWindow?.addEventListener('click', openNewWin);

btnPopoutWindow?.addEventListener('click', () => {
  if (isPopoutMode) {
    api?.redockTerminal?.();
  } else {
    api?.popoutTerminal?.();
  }
});

const toggleFs = () => api?.toggleFullScreen?.();
btnFullscreenHeader?.addEventListener('click', toggleFs);

window.addEventListener('keydown', (e) => {
  if (e.key === 'F11') {
    e.preventDefault();
    toggleFs();
  }
  const isCtrlOrCmd = e.ctrlKey || e.metaKey;
  if (isCtrlOrCmd && e.shiftKey && e.key.toLowerCase() === 'n') {
    e.preventDefault();
    openNewWin();
  }
  // Alt+Up / Ctrl+Alt+Up: Focus Main Pane
  if ((e.altKey && (e.key === 'ArrowUp' || e.key === 'Up')) ||
      ((e.ctrlKey || e.metaKey) && e.altKey && (e.key === 'ArrowUp' || e.key === 'Up'))) {
    e.preventDefault();
    focusMainPane();
  }
  // Alt+Down / Ctrl+Alt+Down: Focus Split Pane
  if ((e.altKey && (e.key === 'ArrowDown' || e.key === 'Down')) ||
      ((e.ctrlKey || e.metaKey) && e.altKey && (e.key === 'ArrowDown' || e.key === 'Down'))) {
    if (splitEnabled) {
      e.preventDefault();
      focusSplitPane();
    }
  }
}, true);

window.addEventListener('focus', () => {
  fitCurrentTerminal();
});

if (activeId) {
  focusMainPane();
}

// Smooth 60fps Right Sidebar Resizing with Pointer Capture
const resizeHandle = document.getElementById('resizeHandle');
if (resizeHandle) {
  let isResizing = false;
  let rafId = null;
  let pendingWidth = 0;

  resizeHandle.addEventListener('pointerdown', (e) => {
    isResizing = true;
    resizeHandle.setPointerCapture(e.pointerId);
    document.body.style.cursor = 'col-resize';
  });

  resizeHandle.addEventListener('pointermove', (e) => {
    if (!isResizing) return;
    pendingWidth = Math.max(280, Math.min(1000, window.innerWidth - e.clientX));
    if (!rafId) {
      rafId = requestAnimationFrame(() => {
        api?.setPanelWidth(pendingWidth);
        rafId = null;
      });
    }
  });

  const stopResize = (e) => {
    if (isResizing) {
      isResizing = false;
      try {
        resizeHandle.releasePointerCapture(e.pointerId);
      } catch {}
      document.body.style.cursor = '';
      if (rafId) {
        cancelAnimationFrame(rafId);
        rafId = null;
      }
      if (pendingWidth) {
        api?.setPanelWidth(pendingWidth);
      }
    }
  };

  resizeHandle.addEventListener('pointerup', stopResize);
  resizeHandle.addEventListener('pointercancel', stopResize);
}

// Smooth Terminal Vertical Split Divider Resizing
let splitting = false;
let splitRafId = null;
let pendingRatio = DEFAULT_MAIN_SPLIT_RATIO;

window.addEventListener('pointerdown', (e) => {
  if (e.target instanceof HTMLElement && e.target.id === 'terminal-divider') {
    splitting = true;
    pendingRatio = sessionSplitRatios.get(activeId) ?? DEFAULT_MAIN_SPLIT_RATIO;
    const divider = e.target;
    divider.classList.add('dragging');
    try {
      divider.setPointerCapture(e.pointerId);
    } catch {}
    document.body.style.cursor = 'row-resize';
    document.body.style.userSelect = 'none';
    mainPane.style.pointerEvents = 'none';
    const lower = document.getElementById('terminal-split');
    if (lower) lower.style.pointerEvents = 'none';
  }
});

window.addEventListener('pointermove', (e) => {
  if (!splitting || !splitEnabled) return;
  const geo = getSplitGeometry();
  if (geo.usable <= 0) return;

  const rect = container.getBoundingClientRect();
  // Compute pointer Y relative to content box, targeting divider centerline
  const relativeY = (e.clientY - rect.top) - geo.contentTopOffset - geo.dividerMarginTop - (geo.dividerHeight / 2);
  const clampedMain = Math.max(geo.paneMin, Math.min(geo.usable - geo.paneMin, Math.round(relativeY)));
  pendingRatio = clampedMain / geo.usable;
  sessionSplitRatios.set(activeId, pendingRatio);

  if (!splitRafId) {
    splitRafId = requestAnimationFrame(() => {
      applySplitRatio(pendingRatio, false);
      splitRafId = null;
    });
  }
});

const stopSplitting = (e) => {
  if (splitting) {
    splitting = false;
    const divider = document.getElementById('terminal-divider');
    divider?.classList.remove('dragging');
    try {
      if (divider && e.pointerId !== undefined) {
        divider.releasePointerCapture(e.pointerId);
      }
    } catch {}
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    mainPane.style.pointerEvents = '';
    const lower = document.getElementById('terminal-split');
    if (lower) lower.style.pointerEvents = '';
    if (splitRafId) {
      cancelAnimationFrame(splitRafId);
      splitRafId = null;
    }
    applySplitRatio(pendingRatio, true);
  }
};

window.addEventListener('pointerup', stopSplitting);
window.addEventListener('pointercancel', stopSplitting);
