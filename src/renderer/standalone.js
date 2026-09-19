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
  return parentKey === undefined ? categoryKeyOf(session) : parentKey;
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

/**
 * Bucket sessions by category, preserving the first-appearance order of each
 * group. Iterating `sessions` (which main owns) is what makes the group order
 * stable across renders — a hash-map or alphabetical sort would reshuffle the
 * sidebar every time a tab's activity changed.
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
    const seeded = { key: name, label: name, color: categoryColorOf(name), items: [] };
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
  for (const s of (list || [])) keyBySessionId.set(s.id, categoryKeyOf(s));
  for (const s of (list || [])) {
    const key = groupKeyOf(s, keyBySessionId);
    let group = byKey.get(key);
    if (!group) {
      group = { key, label: categoryLabelOf(key), color: categoryColorOf(key), items: [] };
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
const MAX_HYDRATION_WRITE_CHARS = 1024 * 1024;
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

function attachWebLinksAddon(term) {
  try {
    const Ctor = window.WebLinksAddon?.WebLinksAddon || globalThis.WebLinksAddon?.WebLinksAddon;
    if (typeof Ctor === 'function') {
      const linkHandler = (_event, uri) => {
        if (!uri) return;
        if (api?.createTab) {
          api.createTab(uri).catch(() => {
            api?.openExternal?.(uri);
          });
        } else if (api?.openExternal) {
          api.openExternal(uri);
        }
      };
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
  const webLinksAddon = attachWebLinksAddon(sTerm);
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
      api?.newTerminal();
    });
  }
}

const btnNewTerminal = document.getElementById('btnNewTerminal');
const splitButton = document.getElementById('btnSplitTerminal') || document.getElementById('btnSplitVertical');

// Fix: ONLY ONE listener on btnNewTerminal (prevent duplicate terminals)
if (btnNewTerminal) {
  btnNewTerminal.onclick = (e) => {
    e.stopPropagation();
    api?.newTerminal();
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
  splitWebLinksAddon = attachWebLinksAddon(splitTerm);
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
async function updateAffinityBadges(deliveredTabs) {
  if (!api?.getTerminalAffinities || !api?.getTabs) return;
  const setBadgeState = (badge, cls, text, tip) => {
    if (badge.className !== cls) badge.className = cls;
    if (badge.textContent !== text) badge.textContent = text;
    if (badge.title !== tip) badge.title = tip;
  };
  try {
    // One round-trip for every badge: the per-id loop was N+1 IPC calls on every
    // tab render, and each generation-less lookup cost an O(E) prefix scan.
    // A caller that already holds the broadcast's list hands it in: that list is
    // `getTabList()` verbatim and the RPC payload is a projection of the same
    // source, so re-fetching bought nothing and cost a second `invoke` per
    // broadcast — ~106,800 over one 4 h soak, each allocating a correlation
    // entry, a promise and a deserialized array on the main thread that every
    // switch, bridge RPC and terminal fanout also runs on.
    const [tabs, affinities] = await Promise.all([
      Array.isArray(deliveredTabs) ? Promise.resolve(deliveredTabs) : api.getTabs(),
      api.getTerminalAffinities(),
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
  if (typeof renderTabs === 'function') renderTabs();
  if (isNewName) persistTerminalTabPrefs();
  try {
    api?.setCategory?.(baseId, category || undefined);
  } catch {}
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
      api?.newTerminal();
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
  if (!isPopoutMode) {
    api?.switchTerminal(targetId);
  }
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
    wrap.draggable = true;

    // Drag & Drop Reordering
    wrap.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData('text/plain', s.id);
      e.dataTransfer.effectAllowed = 'move';
      dragSourceSessionId = s.id;
      wrap.classList.add('dragging');
    });

    wrap.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      wrap.classList.add('drag-over');
    });

    wrap.addEventListener('dragleave', () => {
      wrap.classList.remove('drag-over');
    });

    wrap.addEventListener('dragend', () => {
      dragSourceSessionId = null;
      wrap.classList.remove('dragging');
      tabsEl.querySelectorAll('.drag-over').forEach((el) => el.classList.remove('drag-over'));
    });

    wrap.addEventListener('drop', (e) => {
      e.preventDefault();
      wrap.classList.remove('drag-over');
      const sourceId = e.dataTransfer.getData('text/plain');
      // Both ends resolve by SESSION ID. A raw DOM index would be shifted by the
      // category headers interleaved between the wraps, corrupting the order.
      const targetId = wrap.getAttribute('data-session-id');
      if (sourceId && sourceId !== targetId) {
        const fromIdx = sessions.findIndex((x) => x.id === sourceId);
        const toIdx = sessions.findIndex((x) => x.id === targetId);
        if (fromIdx !== -1 && toIdx !== -1) {
          const [moved] = sessions.splice(fromIdx, 1);
          sessions.splice(toIdx, 0, moved);
          renderTabs();
          if (api?.reorderTerminals) {
            void api.reorderTerminals(sessions.map((x) => x.id));
          }
        }
      }
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
    // be marked, coloured or moved for the same reason. Dropping is the opposite —
    // releasing a tab onto the catch-all is precisely how a tab leaves its group — so
    // only the sleep bucket refuses drops, because "file this tab under a state" is not
    // an operation that exists.
    const canManage = group.key !== UNCATEGORIZED_CATEGORY && group.key !== SLEEPING_CATEGORY;
    const canAcceptDrop = group.key !== SLEEPING_CATEGORY;

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
        // `findSession` rejects a foreign payload (a file path, a URL), so only a
        // drag of a real tab can ever change a category.
        const sourceId = e.dataTransfer.getData('text/plain');
        const session = sourceId ? findSession(sourceId) : null;
        if (!session) return;
        const key = header.getAttribute('data-category') || UNCATEGORIZED_CATEGORY;
        const target = key === UNCATEGORIZED_CATEGORY ? '' : key;
        // Already in this group: no IPC round-trip and no disk write.
        if ((session.category || '') === target) return;
        applyCategoryToSession(sourceId, target, null);
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

  // While a filter is applied every surviving group is shown open: a collapsed group
  // hiding the very match the user just searched for would look like a failed search.
  const isCollapsed = collapsedCategories.has(group.key) && !tabSearchActive;
  header.setAttribute('aria-expanded', isCollapsed ? 'false' : 'true');
  header.title = isCollapsed ? `Mở nhóm ${group.label}` : `Thu gọn nhóm ${group.label}`;
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

/** Horizontal mode conveys grouping with a colour chip on the pill instead. */
function applyCategoryChip(wrap, group, isSidebarLayout) {
  const btn = wrap.querySelector('.terminal-tab');
  if (!btn) return;
  const existing = wrap.querySelector('.terminal-tab-category-chip');
  if (isSidebarLayout || group.key === UNCATEGORIZED_CATEGORY || group.key === SLEEPING_CATEGORY) {
    if (existing) existing.remove();
    return;
  }
  let chip = existing;
  if (!chip) {
    chip = document.createElement('span');
    chip.className = 'terminal-tab-category-chip';
    const badge = btn.querySelector('.terminal-tab-affinity-badge');
    if (badge) btn.insertBefore(chip, badge);
    else btn.appendChild(chip);
  }
  chip.setAttribute('data-category', group.key);
  chip.title = `Nhóm: ${group.label}`;
  chip.style.background = group.color;
  if (chip.textContent !== group.label) chip.textContent = group.label;
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
  const haystack = [
    foldForSearch(session.name),
    foldForSearch(session.cwd),
    foldForSearch(session.category),
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
      wrap.draggable = !s.splitOf;
      wrap.classList.toggle('is-category-collapsed', isCollapsed);
      applyCategoryChip(wrap, group, isSidebarLayout);
      updateTabActivityUi(s.id);
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
  updateAffinityBadges();
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
api?.onTabsUpdated?.(async (tabs) => {
  updateAffinityBadges(tabs);
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
api?.onTerminalData(({ sessionId, data, seq, generation, fromSeq, throughSeq }) => {
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

  let item = terminalPool.get(sessionId);
  if (!item) {
    const s = sessions.find((x) => x.id === sessionId);
    if (s) {
      item = getOrCreateTerminalPane(sessionId, s.buffer ?? '', 0, true);
    } else {
      item = getOrCreateTerminalPane(sessionId, '', 0, false);
    }
  }
  if (!item) return;

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
});
async function bootstrapTerminalState() {
  let initialCwd = undefined;
  try {
    const s = await api?.getInitialState?.();
    initialCwd = s?.workspacePath || s?.activeWorkspace;
    // Paint the persisted tab-strip layout before the first terminal mounts, so
    // the initial grid geometry is the user's rather than a horizontal-then-reflow
    // flash. The main process already validated and clamped these values.
    applyCollapsedCategories(s?.terminalTabPrefs?.collapsedCategories);
    applyCategories(s?.terminalTabPrefs?.categories);
    applyCategoryColors(s?.terminalTabPrefs?.categoryColors);
    applyStarredCategories(s?.terminalTabPrefs?.starredCategories);
    applyTerminalTabLayout(s?.terminalTabPrefs?.layout, s?.terminalTabPrefs?.sidebarWidth);
  } catch {}
  try {
    await api?.startTerminal?.(initialCwd);
  } catch {}

  try {
    const listFn = api?.listTerminals || api?.listSessions;
    const sessionList = await listFn?.();
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
      if (!initialPushReceived) {
        renderTabs();
        syncTerminalPool(sessions, activeId);
      }
    } else if (api?.newTerminal) {
      await api.newTerminal();
    }
  } catch {}
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
  if (globalResizeObserver) {
    try { globalResizeObserver.disconnect(); } catch {}
  }
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
