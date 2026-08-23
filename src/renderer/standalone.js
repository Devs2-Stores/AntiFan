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

async function handleTerminalPaste(sendInput) {
  // 1. Read text directly from clipboard
  const res = readClipboard();
  if (typeof res === 'string' && res) {
    sendInput(res);
    return true;
  } else if (res && typeof res.then === 'function') {
    try {
      const text = await res;
      if (text) {
        sendInput(text);
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
      handleTerminalPaste(sendInput);
      return false;
    }

    // Ctrl+A / Cmd+A: Select all text in terminal
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && (e.key === 'a' || e.key === 'A')) {
      e.preventDefault();
      e.stopPropagation();
      targetTerm.selectAll();
      return false;
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
    if (text) {
      sendInput(text);
      return;
    }

    handleTerminalPaste(sendInput);
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
      handleTerminalPaste(sendInput);
    }
  });
}

const terminalPool = new Map(); // id -> { term, fit, paneEl, isHydrated, pendingChunks, savedViewportY }
window.__antifanTerminalPool = terminalPool;
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
const MAX_FRAME_WRITE_BYTES = 65536;

function getUtf8ByteLength(str) {
  if (!str) return 0;
  let bytes = 0;
  for (const char of str) {
    const cp = char.codePointAt(0);
    if (cp <= 0x7f) bytes += 1;
    else if (cp <= 0x7ff) bytes += 2;
    else if (cp <= 0xffff) bytes += 3;
    else bytes += 4;
  }
  return bytes;
}

function sliceUtf8Bytes(str, maxBytes) {
  if (!str) return { head: '', tail: '', bytes: 0 };
  let accumulatedBytes = 0;
  let charCount = 0;
  for (const char of str) {
    const cp = char.codePointAt(0);
    let charBytes = 1;
    if (cp <= 0x7f) charBytes = 1;
    else if (cp <= 0x7ff) charBytes = 2;
    else if (cp <= 0xffff) charBytes = 3;
    else charBytes = 4;
    if (accumulatedBytes + charBytes > maxBytes) break;
    accumulatedBytes += charBytes;
    charCount += char.length;
  }
  return { head: str.slice(0, charCount), tail: str.slice(charCount), bytes: accumulatedBytes };
}

function writeToTerminalPane(item, chunk) {
  if (!item || !chunk) return;
  try {
    item.term.write(chunk, () => {
      if (!item.isUserScrolledUp && item.paneEl && item.paneEl.classList.contains('active')) {
        item.term.scrollToBottom();
      }
    });
  } catch {
    try { item.term.write(chunk); } catch {}
  }
}

function writeToSplitPane(chunk) {
  if (!splitTerm || !chunk) return;
  try {
    splitTerm.write(chunk, () => {
      if (!isSplitUserScrolledUp && splitTerm) {
        splitTerm.scrollToBottom();
      }
    });
  } catch {
    try { splitTerm.write(chunk); } catch {}
  }
}
function getOrCreateTerminalPane(sessionId, snapshot) {
  let item = terminalPool.get(sessionId);
  const hasSnapshot = typeof snapshot === 'string';

  if (item) {
    if (!item.isHydrated && hasSnapshot) {
      if (snapshot.length > 0) item.term.write(snapshot);
      item.isHydrated = true;
      if (Array.isArray(item.pendingChunks) && item.pendingChunks.length > 0) {
        for (const chunk of item.pendingChunks) {
          item.term.write(chunk);
        }
        item.pendingChunks = [];
      }
    }
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

  // Propose and apply initial sizing if DOM container has valid layout
  try {
    const propose = sFit.proposeDimensions();
    if (propose && propose.cols >= 40 && propose.rows >= 8 && paneEl.clientWidth > 100) {
      sTerm.resize(propose.cols, propose.rows);
      api?.resizeTerminalTo(sessionId, propose.cols, propose.rows);
    }
  } catch {}

  if (hasSnapshot) {
    sTerm.write(snapshot);
  }

  sTerm.onData((data) => {
    api?.sendTerminalInputTo(sessionId, data);
  });


  item = {
    term: sTerm,
    fit: sFit,
    paneEl,
    webglAddon,
    webLinksAddon,
    isHydrated: hasSnapshot,
    pendingChunks: [],
    writeTarget: null,
    savedViewportY: null,
    isUserScrolledUp: false,
    savedDistanceToBottom: 0,
    isProgrammaticScroll: false,
  };
  // Click on pane focuses the terminal
  paneEl.addEventListener('click', () => {
    sTerm.focus();
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
  return item;
}

function syncTerminalPool(allSessions, currentActiveId, snapshot) {
  const activeSessionIds = new Set((allSessions || []).map((s) => s.id));
  // Dispose closed sessions
  for (const [id, item] of terminalPool.entries()) {
    if (!activeSessionIds.has(id)) {
      item.writeTarget = null;
      try { item.webLinksAddon?.dispose(); } catch {}
      try { item.webglAddon?.dispose(); } catch {}
      try { item.term.dispose(); } catch {}
      item.paneEl.remove();
      terminalPool.delete(id);
    }
  }
  for (const s of allSessions) {
    const sessionSnapshot = s.id === currentActiveId
      ? (typeof snapshot === 'string' ? snapshot : (typeof s.buffer === 'string' ? s.buffer : ''))
      : (typeof s.buffer === 'string' ? s.buffer : '');

    const item = terminalPool.get(s.id);
    if (!item) {
      getOrCreateTerminalPane(s.id, sessionSnapshot);
    } else if (!item.isHydrated) {
      if (sessionSnapshot.length > 0) {
        item.term.write(sessionSnapshot);
        item.pendingChunks = [];
      } else if (Array.isArray(item.pendingChunks) && item.pendingChunks.length > 0) {
        for (const chunk of item.pendingChunks) {
          item.term.write(chunk);
        }
        item.pendingChunks = [];
      }
      item.isHydrated = true;
    }
  }
  // Switch visibility smoothly and instantly without destroying scroll context or layout
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
      item.isProgrammaticScroll = true;
      const doRefit = () => {
        try {
          const propose = item.fit.proposeDimensions();
          if (propose && propose.cols >= 20 && propose.rows >= 5 && item.paneEl.clientWidth > 50) {
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
      requestAnimationFrame(() => {
        doRefit();
        setTimeout(() => {
          item.isProgrammaticScroll = false;
        }, 50);
      });
      if (justBecameActive) {
        item.term.focus();
      }
    } else {
      item.paneEl.classList.remove('active');
    }
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

function applySplitRatio(ratio, resizePty = true) {
  const lower = document.getElementById('terminal-split');
  if (lower && splitEnabled) {
    const containerHeight = container?.clientHeight || 400;
    const minPx = 90; // At least ~5-6 terminal rows + header
    const minRatio = Math.min(0.25, minPx / Math.max(200, containerHeight));
    const maxRatio = 1 - minRatio;
    const rawRatio = (typeof ratio === 'number' && !isNaN(ratio) && ratio > 0) ? ratio : 0.5;
    const clampedRatio = Math.max(minRatio, Math.min(maxRatio, rawRatio));
    mainPane.style.flex = `${clampedRatio} 1 0px`;
    mainPane.style.minHeight = `${minPx}px`;
    lower.style.flex = `${1 - clampedRatio} 1 0px`;
    lower.style.minHeight = `${minPx}px`;
  } else {
    mainPane.style.flex = '1 1 100%';
    mainPane.style.minHeight = '0';
    mainPane.style.height = '';
  }
  const item = terminalPool.get(activeId);
  if (item) {
    try {
      const propose = item.fit.proposeDimensions();
      if (propose && propose.cols > 0 && propose.rows > 0) {
        item.term.resize(propose.cols, propose.rows);
        if (resizePty) {
          api?.resizeTerminalTo(activeId, propose.cols, propose.rows);
        }
      }
      item.term.refresh(0, item.term.rows - 1);
    } catch {}
  }
  if (splitFitAddon && splitTerm) {
    try {
      const splitPropose = splitFitAddon.proposeDimensions();
      if (splitPropose && splitPropose.cols >= 20 && splitPropose.rows >= 4) {
        splitTerm.resize(splitPropose.cols, splitPropose.rows);
        if (resizePty && splitId) {
          api?.resizeTerminalTo(splitId, splitPropose.cols, splitPropose.rows);
        }
      }
      splitTerm.refresh(0, splitTerm.rows - 1);
    } catch {}
  }
}

function unmountSplit() {
  splitWriteTarget = null;
  isSplitUserScrolledUp = false;
  isSplitProgrammaticScroll = false;
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
  const item = terminalPool.get(activeId);
  if (item) {
    try {
      const propose = item.fit.proposeDimensions();
      if (propose && propose.cols > 0 && propose.rows > 0) {
        item.term.resize(propose.cols, propose.rows);
        api?.resizeTerminalTo(activeId, propose.cols, propose.rows);
      }
      item.term.refresh(0, item.term.rows - 1);
    } catch {}
  }
  if (splitButton) {
    splitButton.classList.remove('active');
    splitButton.title = 'Chia đôi màn hình terminal (Split Right)';
  }
}
function mountSplit(sessionId, snapshot = '') {
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

  splitHost.addEventListener('click', () => {
    splitTerm?.focus();
  });
  applySplitRatio(sessionSplitRatios.get(activeId) || 0.5);
  if (snapshot) splitTerm.write(snapshot);
  if (splitButton) {
    splitButton.classList.add('active');
    splitButton.title = 'Tắt chia đôi terminal (Unsplit)';
  }

  requestAnimationFrame(() => {
    try {
      fitCurrentTerminal();
      splitTerm?.focus();
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
    if (!activeId || !api) return;
    if (splitEnabled) {
      // Toggle off split
      await api.unsplitTerminal?.(activeId);
      unmountSplit();
      return;
    }
    splitButton.disabled = true;
    try {
      const mainItem = terminalPool.get(activeId);
      const targetCols = (mainItem && mainItem.term && mainItem.term.cols) || 120;
      const targetRows = (mainItem && mainItem.term && mainItem.term.rows) ? Math.max(8, Math.floor(mainItem.term.rows / 2)) : 15;
      const newSplitId = await api.splitTerminal(activeId, { cols: targetCols, rows: targetRows });
      if (newSplitId) mountSplit(newSplitId);
    } finally {
      splitButton.disabled = false;
    }
  };
}

function showContextMenu(e, sessionId) {
  e.preventDefault();
  e.stopPropagation();
  contextTargetSessionId = sessionId;
  if (!contextMenu) return;

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
    } else if (action === 'rename') {
      const wrap = tabsEl.querySelector(`[data-session-id="${targetId}"]`);
      const titleSpan = wrap?.querySelector('.terminal-tab-title');
      if (wrap && titleSpan) {
        startInlineRename(targetId, wrap, titleSpan);
      }
    } else if (action === 'split') {
      if (!splitEnabled && api) {
        const mainItem = terminalPool.get(targetId);
        const targetCols = (mainItem && mainItem.term && mainItem.term.cols) || 120;
        const targetRows = (mainItem && mainItem.term && mainItem.term.rows) ? Math.max(8, Math.floor(mainItem.term.rows / 2)) : 15;
        const newSplitId = await api.splitTerminal(targetId, { cols: targetCols, rows: targetRows });
        if (newSplitId) mountSplit(newSplitId);
      } else if (splitEnabled && api) {
        await api.unsplitTerminal?.(targetId);
        unmountSplit();
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

  let finished = false;
  const finishRename = async (save) => {
    if (finished) return;
    finished = true;
    const newName = input.value.trim();
    input.remove();
    titleSpanEl.style.display = '';
    tabWrapEl.classList.remove('renaming');

    if (save && newName && newName !== currentName) {
      titleSpanEl.textContent = newName;
      await api?.renameTerminal(sessionId, newName);
    }
  };

  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
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

      b.append(icon, titleSpan, beacon);
      b.title = `${s.name} (Nhấp đúp hoặc chuột phải để đổi tên, kéo thả để sắp xếp)`;

      b.onclick = () => {
        if (s.id !== activeId) {
          activeId = s.id;
          tabsEl.querySelectorAll('.terminal-tab-wrap').forEach((el) => {
            el.classList.toggle('active', el.getAttribute('data-session-id') === activeId);
          });
          const targetSession = sessions.find((item) => item.id === s.id) || s;
          if (targetSession.splitSessionId) {
            mountSplit(targetSession.splitSessionId, targetSession.splitBuffer);
          } else {
            unmountSplit();
          }
          syncTerminalPool(sessions, activeId);
          if (!isPopoutMode) {
            api?.switchTerminal(s.id);
          }
          fitCurrentTerminal();
        }
        terminalPool.get(activeId)?.term?.focus();
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
  if (activeSession?.splitSessionId) mountSplit(activeSession.splitSessionId, activeSession.splitBuffer);
  else if (!activeSession || !activeSession.splitSessionId) unmountSplit();
  renderTabs();
  syncTerminalPool(sessions, activeId, state.snapshot);
});
api?.onTerminalData(({ sessionId, data }) => {
  notifySessionActivity(sessionId, data);
  if (sessionId === splitId && splitTerm) {
    writeToSplitPane(data);
  } else {
    let item = terminalPool.get(sessionId);
    if (!item) {
      const s = sessions.find((x) => x.id === sessionId);
      if (s) {
        item = getOrCreateTerminalPane(sessionId, s.buffer ?? '');
      } else {
        item = getOrCreateTerminalPane(sessionId);
      }
    }
    if (item) {
      if (item.isHydrated) {
        writeToTerminalPane(item, data);
      } else {
        if (!Array.isArray(item.pendingChunks)) item.pendingChunks = [];
        item.pendingChunks.push(data);
      }
    }
  }
});
api?.getInitialState().then((s) => {
  api.startTerminal(s?.workspacePath || s?.activeWorkspace);
});

function fitCurrentTerminal() {
  if (activeId) {
    const item = terminalPool.get(activeId);
    if (item && item.paneEl.classList.contains('active')) {
      item.isProgrammaticScroll = true;
      try {
        const propose = item.fit.proposeDimensions();
        if (propose && propose.cols >= 20 && propose.rows >= 5 && container.clientWidth > 50) {
          item.term.resize(propose.cols, propose.rows);
          api?.resizeTerminalTo(activeId, propose.cols, propose.rows);
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
      if (splitPropose && splitPropose.cols >= 20 && splitPropose.rows >= 5) {
        splitTerm.resize(splitPropose.cols, splitPropose.rows);
        api?.resizeTerminalTo(splitId, splitPropose.cols, splitPropose.rows);
      }
      splitTerm.refresh(0, splitTerm.rows - 1);
    } catch {}
  }
}
if (window.ResizeObserver) {
  const ro = new ResizeObserver(() => {
    clearTimeout(resizeDebounceTimer);
    resizeDebounceTimer = setTimeout(() => {
      fitCurrentTerminal();
    }, 20);
  });
  if (container) ro.observe(container);
  if (mainPane) ro.observe(mainPane);
}

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
  await api?.pickWorkspaceFolder?.();
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
});

window.addEventListener('focus', () => {
  fitCurrentTerminal();
});

if (activeId) {
  terminalPool.get(activeId)?.term?.focus();
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
let pendingRatio = 0.5;

window.addEventListener('pointerdown', (e) => {
  if (e.target instanceof HTMLElement && e.target.id === 'terminal-divider') {
    splitting = true;
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
  const rect = container.getBoundingClientRect();
  const dividerHeight = 7;
  const availableHeight = rect.height - dividerHeight;
  if (availableHeight <= 0) return;

  const currentY = e.clientY - rect.top;
  const minPx = Math.min(90, Math.floor(availableHeight * 0.25));
  const clampedY = Math.max(minPx, Math.min(availableHeight - minPx, currentY));
  pendingRatio = clampedY / availableHeight;
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
