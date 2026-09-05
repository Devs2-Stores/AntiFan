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

const terminalPool = new Map(); // id -> item
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
    banner.innerHTML = '<span>⚠️ Terminal Display Out of Sync — Process is Active</span><button style="background:#b45309;color:#fff;border:none;padding:2px 8px;border-radius:4px;cursor:pointer;font-size:11px;">Resync View</button>';
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
        const bufText = typeof fullBuffer === 'string' ? fullBuffer : (fullBuffer?.buffer || '');
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

  if (chunkGen > 0) {
    if (viewState.sessionGeneration > 0 && chunkGen !== viewState.sessionGeneration) {
      // Generational leap: session respawned
      viewState.sessionGeneration = chunkGen;
      viewState.lastRenderedSeq = 0;
      viewState.syncState = 'READY';
      viewState.liveQueue = [];
      hideDegradedBanner(viewState);
    } else {
      viewState.sessionGeneration = chunkGen;
    }
  }

  if (viewState.activeHydratingEpoch !== null) {
    viewState.liveQueue.push({
      seq: chunkSeq,
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
    return; // Dedup
  }

  if (chunkSeq === viewState.lastRenderedSeq + 1 || (viewState.lastRenderedSeq === 0 && chunkSeq === 1)) {
    viewState.lastRenderedSeq = chunkSeq;
    viewState.pendingWriteAckSeq = chunkSeq;
    writeChunk(viewState, chunkData, isSplit);
    return;
  }

  // Sequence gap detected: chunkSeq > viewState.lastRenderedSeq + 1
  await handleSequenceGap(viewState, chunk, isSplit);
}

async function handleSequenceGap(viewState, chunk, isSplit) {
  viewState.gapCount = (viewState.gapCount || 0) + 1;
  const chunkBytes = (chunk.data || '').length;
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
          viewState.lastRenderedSeq = item.seq;
          viewState.pendingWriteAckSeq = item.seq;
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
      viewState.liveQueue.sort((a, b) => a.seq - b.seq);
      while (viewState.liveQueue.length > 0) {
        const next = viewState.liveQueue[0];
        if (next.seq <= viewState.lastRenderedSeq) {
          viewState.liveQueue.shift();
        } else if (next.seq === viewState.lastRenderedSeq + 1) {
          viewState.liveQueue.shift();
          viewState.lastRenderedSeq = next.seq;
          viewState.pendingWriteAckSeq = next.seq;
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
      if (nextHead && nextHead.seq > viewState.lastRenderedSeq + 1) {
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

async function atomicHydratePane(item, sessionId, providedSnapshot, providedSeq) {
  if (!item || !item.term) return;
  item.hydrationEpoch += 1;
  const currentEpoch = item.hydrationEpoch;
  item.activeHydratingEpoch = currentEpoch;

  try {
    let snapshot = providedSnapshot;
    let snapshotSeq = providedSeq;

    if (snapshot === undefined || snapshotSeq === undefined) {
      if (api?.getFullBuffer) {
        try {
          const res = await api.getFullBuffer(sessionId);
          if (item.hydrationEpoch !== currentEpoch) return;
          snapshot = res?.buffer || '';
          snapshotSeq = res?.snapshotThroughSeq || 0;
        } catch {}
      }
    }

    if (item.hydrationEpoch !== currentEpoch) return;

    try {
      if (item.writeTarget && window.globalTerminalWriteDispatcher) {
        window.globalTerminalWriteDispatcher.cancel(item.writeTarget);
      }
    } catch {}

    item.term.reset();
    if (snapshot && snapshot.length > 0) {
      await writeTermAsync(item.term, snapshot);
    }
    item.lastRenderedSeq = snapshotSeq || 0;

    while (item.liveQueue.length > 0) {
      if (item.hydrationEpoch !== currentEpoch) return;
      const batch = item.liveQueue.splice(0, item.liveQueue.length);
      const pending = batch
        .filter((entry) => entry.epoch === currentEpoch && entry.seq > item.lastRenderedSeq)
        .sort((a, b) => a.seq - b.seq);

      for (const entry of pending) {
        await writeTermAsync(item.term, entry.data);
        item.lastRenderedSeq = entry.seq;
      }
    }

    if (!item.isUserScrolledUp && item.paneEl && item.paneEl.classList.contains('active')) {
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
    let snapshot = providedSnapshot;
    let snapshotSeq = providedSeq;

    if (snapshot === undefined || snapshotSeq === undefined) {
      if (api?.getFullBuffer) {
        try {
          const res = await api.getFullBuffer(splitSessionId);
          if (splitSessionState.hydrationEpoch !== currentEpoch) return;
          snapshot = res?.buffer || '';
          snapshotSeq = res?.snapshotThroughSeq || 0;
        } catch {}
      }
    }

    if (splitSessionState.hydrationEpoch !== currentEpoch) return;

    try {
      if (splitWriteTarget && window.globalTerminalWriteDispatcher) {
        window.globalTerminalWriteDispatcher.cancel(splitWriteTarget);
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
        .filter((entry) => entry.epoch === currentEpoch && entry.seq > splitSessionState.lastRenderedSeq)
        .sort((a, b) => a.seq - b.seq);

      for (const entry of pending) {
        await writeTermAsync(splitTerm, entry.data);
        splitSessionState.lastRenderedSeq = entry.seq;
      }
    }

    if (!isSplitUserScrolledUp && splitTerm) {
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
      window.globalTerminalWriteDispatcher.queueWrite(target, chunk);
      return;
    } catch {}
  }
  try {
    item.term.write(chunk, () => {
      if (!item.isUserScrolledUp && item.paneEl && item.paneEl.classList.contains('active')) {
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
    if (!item.isUserScrolledUp && item.paneEl && item.paneEl.classList.contains('active')) {
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
        if (!isSplitUserScrolledUp && splitTerm) {
          splitTerm.scrollToBottom();
        }
        if (splitSessionState.pendingWriteAckSeq > 0) {
          scheduleCoalescedAck(splitId, splitSessionState.sessionGeneration || 0, splitSessionState.pendingWriteAckSeq);
          splitSessionState.lastAckedSeq = splitSessionState.pendingWriteAckSeq;
        }
      });
    }
    try {
      dispatcher.queueWrite(splitWriteTarget, chunk);
      return;
    } catch {}
  }
  try {
    splitTerm.write(chunk, () => {
      if (!isSplitUserScrolledUp && splitTerm) {
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
function getOrCreateTerminalPane(sessionId, snapshot, snapshotSeq = 0, isAuthoritative = false) {
  let item = terminalPool.get(sessionId);
  if (item) {
    return item;
  }

  const paneEl = document.createElement('div');
  paneEl.className = 'terminal-session-pane';
  paneEl.setAttribute('data-session-id', sessionId);
  const isActive = sessionId === activeId;
  if (isActive) {
    paneEl.classList.add('active');
  }

  const sTerm = new Terminal({
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

  sTerm.onData((data) => {
    api?.sendTerminalInputTo(sessionId, data);
  });


  item = {
    id: sessionId,
    term: sTerm,
    fit: sFit,
    paneEl,
    webglAddon,
    webLinksAddon,
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
    hasAuthoritativeState: isAuthoritative,
    writeTarget: null,
    savedViewportY: null,
    isUserScrolledUp: false,
    savedDistanceToBottom: 0,
    isProgrammaticScroll: false,
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
    const activeBuf = sTerm.buffer?.active;
    if (activeBuf) {
      const isAtBottom = activeBuf.viewportY >= activeBuf.baseY;
      if (isAtBottom) {
        item.isUserScrolledUp = false;
        item.savedViewportY = null;
        item.savedDistanceToBottom = 0;
      } else {
        item.isUserScrolledUp = true;
        item.savedViewportY = activeBuf.viewportY;
        item.savedDistanceToBottom = Math.max(0, activeBuf.baseY - activeBuf.viewportY);
      }
    }
  }, { passive: true });

  sTerm.onScroll(() => {
    if (!item || !item.paneEl || !item.paneEl.classList.contains('active')) {
      return;
    }
    const activeBuf = sTerm.buffer?.active;
    if (activeBuf) {
      const isAtBottom = activeBuf.viewportY >= activeBuf.baseY;
      if (isAtBottom) {
        item.isUserScrolledUp = false;
        item.savedViewportY = null;
        item.savedDistanceToBottom = 0;
      } else {
        item.isUserScrolledUp = true;
        item.savedViewportY = activeBuf.viewportY;
        item.savedDistanceToBottom = Math.max(0, activeBuf.baseY - activeBuf.viewportY);
      }
    }
  });

  terminalPool.set(sessionId, item);
  atomicHydratePane(item, sessionId, snapshot, snapshotSeq);
  syncPaneWithBackend(item, sessionId);
  return item;
}

function syncTerminalPool(allSessions, currentActiveId, snapshot, snapshotThroughSeq = 0) {
  const activeSessionIds = new Set((allSessions || []).map((s) => s.id));
  // Dispose closed sessions
  for (const [id, item] of terminalPool.entries()) {
    if (!activeSessionIds.has(id)) {
      try { if (item.writeTarget && window.globalTerminalWriteDispatcher) window.globalTerminalWriteDispatcher.cancel(item.writeTarget); } catch {}
      item.writeTarget = null;
      try { item.webLinksAddon?.dispose(); } catch {}
      try { item.webglAddon?.dispose(); } catch {}
      try { item.term.dispose(); } catch {}
      if (globalResizeObserver) {
        try { globalResizeObserver.unobserve(item.paneEl); } catch {}
      }
      item.paneEl.remove();
      terminalPool.delete(id);
      sessionSplitRatios.delete(id);
    }
  }
  for (const s of allSessions) {
    const sessionSnapshot = s.id === currentActiveId
      ? (typeof snapshot === 'string' ? snapshot : (typeof s.buffer === 'string' ? s.buffer : ''))
      : (typeof s.buffer === 'string' ? s.buffer : '');
    const seq = s.id === currentActiveId ? (snapshotThroughSeq || s.snapshotThroughSeq || 0) : (s.snapshotThroughSeq || 0);

    const item = terminalPool.get(s.id);
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
      const activeBuf = item.term.buffer?.active;
      if (activeBuf) {
        const isAtBottom = activeBuf.viewportY >= activeBuf.baseY;
        if (isAtBottom) {
          item.isUserScrolledUp = false;
          item.savedViewportY = null;
          item.savedDistanceToBottom = 0;
        } else {
          item.isUserScrolledUp = true;
          item.savedViewportY = activeBuf.viewportY;
          item.savedDistanceToBottom = Math.max(0, activeBuf.baseY - activeBuf.viewportY);
        }
      }
      item.paneEl.classList.remove('active');
    } else if (isNowActive) {
      const justBecameActive = !wasActive;
      item.paneEl.classList.add('active');
      if (globalResizeObserver) {
        try { globalResizeObserver.observe(item.paneEl); } catch {}
      }
      item.isProgrammaticScroll = true;
      const doRefit = () => {
        try {
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
            if (item.isUserScrolledUp && item.savedDistanceToBottom > 0) {
              const targetLine = Math.max(0, activeBuf.baseY - item.savedDistanceToBottom);
              item.term.scrollToLine(targetLine);
            } else {
              item.isUserScrolledUp = false;
              item.savedViewportY = null;
              item.savedDistanceToBottom = 0;
              item.term.scrollToBottom();
            }
          }
        } catch {}
      };
      doRefit();
      scheduleFitTerminal(60);
      requestAnimationFrame(() => {
        doRefit();
        setTimeout(() => {
          item.isProgrammaticScroll = false;
        }, 50);
      });
      if (justBecameActive) {
        focusMainPane();
      }
    } else {
      item.paneEl.classList.remove('active');
    }
  }
  updateEmptyStateDisplay(allSessions && allSessions.length > 0);
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
    const item = terminalPool.get(activeId);
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
function mountSplit(sessionId, snapshot = '', snapshotSeq = 0) {
  if (!sessionId) return;
  if (splitId === sessionId && splitTerm) return;
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

  splitTerm = new Terminal({
    cursorBlink: true,
    convertEol: false,
    fontFamily: 'Cascadia Mono, Consolas, monospace',
    fontSize: 12,
    scrollback: 50000,
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
    if (splitId) {
      api?.sendTerminalInputTo(splitId, data);
    }
  });

  splitTerm.onScroll(() => {
    if (isSplitProgrammaticScroll) return;
    const buf = splitTerm?.buffer?.active;
    if (buf) {
      isSplitUserScrolledUp = buf.viewportY < buf.baseY;
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
    if (activeId && api) {
      await api.unsplitTerminal?.(activeId);
    }
    unmountSplit();
  });
}

// Split Toggle Button
if (splitButton) {
  splitButton.onclick = async () => {
    if (!activeId || !api || splitButton.disabled) return;
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
      if (newSplitId) mountSplit(newSplitId);
    } catch (err) {
      console.error('[Terminal] Split toggle failed:', err);
    } finally {
      splitButton.disabled = false;
    }
  };
}
async function updateAffinityBadges() {
  if (!api?.getTerminalAffinity || !api?.getTabs) return;
  try {
    const tabs = await api.getTabs();
    const tabsMap = new Map((tabs || []).map((t) => [t.id, t]));
    const badges = document.querySelectorAll('.terminal-tab-affinity-badge');
    for (const badge of badges) {
      const sid = badge.getAttribute('data-session-id');
      if (!sid) continue;
      const affinity = await api.getTerminalAffinity(sid);
      if (!affinity || !affinity.tabId) {
        badge.className = 'terminal-tab-affinity-badge unbound';
        badge.textContent = '🎯 Chưa gán';
        badge.title = 'Terminal này chưa gán tab nào (Click để chọn tab)';
      } else if (affinity.status === 'closed') {
        badge.className = 'terminal-tab-affinity-badge closed';
        badge.textContent = '🎯 Tab đã đóng';
        badge.title = `Tab trước đó (${affinity.lastUrl || affinity.tabId}) đã bị đóng (Click để gán lại)`;
      } else {
        const managedCount = Array.isArray(affinity.managedTabIds) ? affinity.managedTabIds.length : 1;
        if (managedCount > 1) {
          badge.className = 'terminal-tab-affinity-badge multi';
          badge.textContent = `🎯 ${managedCount} tabs`;
          const tabNames = (affinity.managedTabIds || []).map((id) => {
            const t = tabsMap.get(id);
            return t ? (t.title || t.url || id) : id;
          }).join('\n• ');
          badge.title = `Terminal đang quản lý ${managedCount} tabs:\n• ${tabNames}\n(Click để quản lý nhóm tab)`;
        } else {
          const boundTab = tabsMap.get(affinity.tabId);
          const name = boundTab ? (boundTab.title || boundTab.url || affinity.tabId) : affinity.tabId;
          badge.className = 'terminal-tab-affinity-badge';
          badge.textContent = `🎯 ${name.slice(0, 14)}`;
          badge.title = `Đang gắn với Tab: ${name} (${boundTab?.url || affinity.tabId}) (Click để đổi/thêm)`;
        }
      }
    }
  } catch {}
}

async function showAffinityPicker(sessionId, anchorEl) {
  const popover = document.getElementById('affinityPickerPopover');
  if (!popover || !api?.getTabs) return;

  const tabs = await api.getTabs();
  const currentAffinity = api.getTerminalAffinity ? await api.getTerminalAffinity(sessionId) : undefined;
  popover.innerHTML = '';
  popover.setAttribute('data-active-session-id', sessionId);
  const managedSet = new Set(Array.isArray(currentAffinity?.managedTabIds) ? currentAffinity.managedTabIds : (currentAffinity?.tabId ? [currentAffinity.tabId] : []));
  const primaryId = currentAffinity?.primaryTabId || currentAffinity?.tabId;

  // Section 1: Tab thuộc Terminal này
  if (managedSet.size > 0) {
    const secHeader = document.createElement('div');
    secHeader.className = 'terminal-affinity-picker-header';
    secHeader.textContent = `Tab thuộc Terminal này (${managedSet.size})`;
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
      };
      popover.appendChild(item);
    });
  }

  // Section 2: Gán thêm Tab khác
  const otherTabs = (tabs || []).filter((t) => !managedSet.has(t.id));
  const addHeader = document.createElement('div');
  addHeader.className = 'terminal-affinity-picker-header';
  addHeader.style.marginTop = managedSet.size > 0 ? '6px' : '0';
  addHeader.textContent = managedSet.size > 0 ? 'Gán thêm Tab khác vào Terminal' : 'Gán Tab Trình Duyệt cho Terminal';
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

function showContextMenu(e, sessionId) {
  e.preventDefault();
  e.stopPropagation();
  contextTargetSessionId = sessionId;
  if (!contextMenu) return;

  const targetSession = sessions.find((item) => item.id === sessionId);
  const isTargetSplit = Boolean(targetSession?.splitSessionId);
  const splitItem = contextMenu.querySelector('.context-item[data-action="split"]');
  if (splitItem) {
    const textSpan = splitItem.querySelector('span:last-child') || splitItem;
    if (isTargetSplit) {
      textSpan.textContent = 'Đóng chia đôi (Unsplit)';
      splitItem.title = 'Tắt chia đôi màn hình terminal của tab này';
    } else {
      textSpan.textContent = 'Chia đôi tab (Split)';
      splitItem.title = 'Chia đôi màn hình terminal của tab này';
    }
  }

  contextMenu.style.display = 'flex';
  const menuWidth = 185;
  const menuHeight = 175;
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
      const wrap = tabsEl.querySelector(`[data-session-id="${targetId}"]`);
      const anchor = wrap?.querySelector('.terminal-tab-affinity-badge') || wrap || item;
      showAffinityPicker(targetId, anchor);
    } else if (action === 'rename') {
      const wrap = tabsEl.querySelector(`[data-session-id="${targetId}"]`);
      const titleSpan = wrap?.querySelector('.terminal-tab-title');
      if (wrap && titleSpan) {
        startInlineRename(targetId, wrap, titleSpan);
      }
    } else if (action === 'split') {
      if (!targetId || !api) return;
      const targetSession = sessions.find((x) => x.id === targetId);
      const isTargetSplit = Boolean(targetSession?.splitSessionId);
      if (targetId !== activeId) {
        activeId = targetId;
        tabsEl.querySelectorAll('.terminal-tab-wrap').forEach((el) => {
          el.classList.toggle('active', el.getAttribute('data-session-id') === activeId);
        });
        syncTerminalPool(sessions, activeId);
        if (!isPopoutMode) {
          api?.switchTerminal(targetId);
        }
      }
      if (!isTargetSplit) {
        const mainItem = terminalPool.get(targetId);
        const targetCols = (mainItem && mainItem.term && mainItem.term.cols) || 120;
        const targetRows = getInitialSplitRows(mainItem?.term);
        const newSplitId = await api.splitTerminal(targetId, { cols: targetCols, rows: targetRows });
        if (newSplitId && activeId === targetId) mountSplit(newSplitId);
      } else {
        await api.unsplitTerminal?.(targetId);
        if (activeId === targetId) unmountSplit();
      }
    } else if (action === 'new') {
      api?.newTerminal();
    } else if (action === 'close') {
      api?.closeTerminal(targetId);
    } else if (action === 'close-others') {
      for (const s of sessions) {
        if (s.id !== targetId) {
          api?.closeTerminal(s.id);
        }
      }
    }
  });
});

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

  input.addEventListener('blur', () => {
    finishRename(true);
  });
}

const sessionActivity = new Map();

function notifySessionActivity(sessionId, data) {
  if (!sessionId || !data || typeof data !== 'string') return;

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

  let act = sessionActivity.get(sessionId);
  if (!act) {
    act = { isStreaming: false, isAi: false, isCompleted: false, idleTimer: null, doneTimer: null };
    sessionActivity.set(sessionId, act);
  }

  // Detect AI patterns, progress bars, or active execution
  const isAiIndicator = (
    /Claude|Codex|OpenCode|DeepSeek|Gemini|Qwen|Kimi|ChatGPT|Thinking\.\.\.|Streaming\.\.\.|⠋|⠙|⠹|⠸|⠼|⠴|⠦|⠧|⠇|⠏|\[in_progress\]|\[task\]|Agent|Evaluating|Generating/i.test(data)
  );

  if (isAiIndicator) {
    act.isAi = true;
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

  if (act?.isStreaming) {
    wrap.classList.add('is-streaming');
    wrap.classList.remove('is-completed');
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
    }
  } else if (act?.isCompleted) {
    wrap.classList.remove('is-streaming');
    wrap.classList.add('is-completed');
    if (iconEl) {
      iconEl.innerHTML = `<span style="color:#10b981;font-weight:bold;font-size:11px;" title="Thực thi hoàn tất">✓</span>`;
    }
    if (beaconEl) {
      beaconEl.className = 'terminal-tab-status-beacon completed';
      beaconEl.title = '✓ Hoàn tất';
    }
  } else {
    wrap.classList.remove('is-streaming');
    wrap.classList.remove('is-completed');
    if (iconEl) {
      iconEl.innerHTML = `<svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 5 8 8 4 11"/><line x1="9" y1="11" x2="13" y2="11"/></svg>`;
    }
    if (beaconEl) {
      beaconEl.className = 'terminal-tab-status-beacon';
      beaconEl.title = '';
    }
  }
}

function renderTabs() {
  const currentWraps = new Map();
  tabsEl.querySelectorAll('.terminal-tab-wrap').forEach((el) => {
    const sid = el.getAttribute('data-session-id');
    if (sid) currentWraps.set(sid, el);
  });

  // Remove wraps for sessions that no longer exist
  const currentSessionIds = new Set(sessions.map((s) => s.id));
  for (const [sid, el] of currentWraps.entries()) {
    if (!currentSessionIds.has(sid)) {
      el.remove();
      currentWraps.delete(sid);
    }
  }

  sessions.forEach((s) => {
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
        wrap.classList.remove('dragging');
        tabsEl.querySelectorAll('.drag-over').forEach((el) => el.classList.remove('drag-over'));
      });

      wrap.addEventListener('drop', (e) => {
        e.preventDefault();
        wrap.classList.remove('drag-over');
        const sourceId = e.dataTransfer.getData('text/plain');
        if (sourceId && sourceId !== s.id) {
          const fromIdx = sessions.findIndex((x) => x.id === sourceId);
          const toIdx = sessions.findIndex((x) => x.id === s.id);
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

      const beacon = document.createElement('span');
      beacon.className = 'terminal-tab-status-beacon';

      const affinityBadge = document.createElement('span');
      affinityBadge.className = 'terminal-tab-affinity-badge unbound';
      affinityBadge.setAttribute('data-session-id', s.id);
      affinityBadge.textContent = '🎯 Gán Tab';
      affinityBadge.title = 'Tab trình duyệt gắn với terminal này (Click để đổi)';
      affinityBadge.onclick = (e) => {
        e.stopPropagation();
        showAffinityPicker(s.id, affinityBadge);
      };

      b.append(icon, titleSpan, affinityBadge, beacon);
      b.title = `${s.name} (Nhấp đúp hoặc chuột phải để đổi tên, kéo thả để sắp xếp)`;

      b.onclick = () => {
        if (s.id !== activeId) {
          activeId = s.id;
          tabsEl.querySelectorAll('.terminal-tab-wrap').forEach((el) => {
            el.classList.toggle('active', el.getAttribute('data-session-id') === activeId);
          });
          const targetSession = sessions.find((item) => item.id === s.id) || s;
          if (targetSession.splitSessionId) {
            mountSplit(targetSession.splitSessionId, targetSession.splitBuffer, targetSession.splitSnapshotThroughSeq || 0);
          } else {
            unmountSplit();
          }
          syncTerminalPool(sessions, activeId);
          if (!isPopoutMode) {
            api?.switchTerminal(s.id);
          }
          fitCurrentTerminal();
        }
        focusMainPane();
      };
      // Double click to rename
      b.ondblclick = (e) => {
        e.stopPropagation();
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
      close.title = 'Đóng terminal';
      close.onclick = (e) => {
        e.stopPropagation();
        api.closeTerminal(s.id);
      };

      wrap.append(b, close);
      currentWraps.set(s.id, wrap);
    } else {
      wrap.classList.toggle('active', isActive);
      const titleSpan = wrap.querySelector('.terminal-tab-title');
      if (titleSpan && !wrap.classList.contains('renaming') && titleSpan.textContent !== s.name) {
        titleSpan.textContent = s.name;
      }
      let affinityBadge = wrap.querySelector('.terminal-tab-affinity-badge');
      if (!affinityBadge) {
        affinityBadge = document.createElement('span');
        affinityBadge.className = 'terminal-tab-affinity-badge unbound';
        affinityBadge.setAttribute('data-session-id', s.id);
        affinityBadge.textContent = '🎯 Gán Tab';
        affinityBadge.title = 'Tab trình duyệt gắn với terminal này (Click để đổi)';
        affinityBadge.onclick = (e) => {
          e.stopPropagation();
          showAffinityPicker(s.id, affinityBadge);
        };
        const btn = wrap.querySelector('.terminal-tab');
        const beacon = wrap.querySelector('.terminal-tab-status-beacon');
        if (btn && beacon) {
          btn.insertBefore(affinityBadge, beacon);
        }
      }
      wrap.querySelector('.terminal-tab')?.setAttribute('title', `${s.name} (Nhấp đúp hoặc chuột phải để đổi tên, kéo thả để sắp xếp)`);
    }
    // Ensure DOM order matches sessions array before action buttons
    if (btnNewTerminal && btnNewTerminal.parentNode === tabsEl) {
      tabsEl.insertBefore(wrap, btnNewTerminal);
    } else {
      tabsEl.appendChild(wrap);
    }
    updateTabActivityUi(s.id);
  });

  // Directly scroll tabs bar if active tab is clipped (no window-level scrolling)
  if (activeId) {
    const activeWrap = tabsEl.querySelector(`.terminal-tab-wrap[data-session-id="${activeId}"]`);
    if (activeWrap && tabsEl) {
      const tabRect = activeWrap.getBoundingClientRect();
      const containerRect = tabsEl.getBoundingClientRect();
      if (tabRect.left < containerRect.left) {
        tabsEl.scrollLeft += (tabRect.left - containerRect.left) - 10;
      } else if (tabRect.right > containerRect.right) {
        tabsEl.scrollLeft += (tabRect.right - containerRect.right) + 10;
      }
    }
  }
  updateAffinityBadges();
}

api?.onTerminalSession((state) => {
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
  if (activeSession?.splitSessionId) {
    mountSplit(activeSession.splitSessionId, activeSession.splitBuffer, activeSession.splitSnapshotThroughSeq || 0);
  } else if (!activeSession || !activeSession.splitSessionId) {
    unmountSplit();
  }
  renderTabs();
  syncTerminalPool(sessions, activeId, state.snapshot, state.snapshotThroughSeq || 0);
});
api?.onTabsUpdated?.(() => {
  updateAffinityBadges();
  const popover = document.getElementById('affinityPickerPopover');
  if (popover && popover.style.display === 'block') {
    const currentSid = popover.getAttribute('data-active-session-id') || activeId;
    const anchor = document.querySelector(`.terminal-tab-affinity-badge[data-session-id="${currentSid}"]`);
    if (anchor) {
      showAffinityPicker(currentSid, anchor);
    }
  }
});
api?.onTerminalData(({ sessionId, data, seq, generation }) => {
  notifySessionActivity(sessionId, data);
  const chunkSeq = typeof seq === 'number' ? seq : 0;
  const chunkGen = typeof generation === 'number' ? generation : 0;

  if (sessionId === splitId && splitTerm) {
    processIncomingChunk(splitSessionState, { seq: chunkSeq, generation: chunkGen, data }, true);
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
  if (item) {
    processIncomingChunk(item, { seq: chunkSeq, generation: chunkGen, data }, false);
  }
});
async function bootstrapTerminalState() {
  let initialCwd = undefined;
  try {
    const s = await api?.getInitialState?.();
    initialCwd = s?.workspacePath || s?.activeWorkspace;
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
      renderTabs();
      syncTerminalPool(sessions, activeId);
    } else if (api?.newTerminal) {
      await api.newTerminal();
    }
  } catch {}
}
bootstrapTerminalState();

function fitCurrentTerminal() {
  if (activeId) {
    const item = terminalPool.get(activeId);
    if (item && item.paneEl.classList.contains('active')) {
      item.isProgrammaticScroll = true;
      try {
        const propose = item.fit.proposeDimensions();
        if (propose && propose.cols >= MIN_TERMINAL_COLS && propose.rows >= MIN_TERMINAL_ROWS && (container?.clientWidth || 0) > 50) {
          if (item.term.cols !== propose.cols || item.term.rows !== propose.rows) {
            item.term.resize(propose.cols, propose.rows);
            api?.resizeTerminalTo(activeId, propose.cols, propose.rows);
          }
        }
        item.term.refresh(0, item.term.rows - 1);
        if (!item.isUserScrolledUp) {
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
      const splitPropose = splitFitAddon.proposeDimensions();
      if (splitPropose && splitPropose.cols >= MIN_TERMINAL_COLS && splitPropose.rows >= MIN_SPLIT_TERMINAL_ROWS) {
        if (splitTerm.cols !== splitPropose.cols || splitTerm.rows !== splitPropose.rows) {
          splitTerm.resize(splitPropose.cols, splitPropose.rows);
          api?.resizeTerminalTo(splitId, splitPropose.cols, splitPropose.rows);
        }
      }
      splitTerm.refresh(0, splitTerm.rows - 1);
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
