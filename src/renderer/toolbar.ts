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
}

interface AntiFanToolbarApi {
  getInitialState: () => Promise<any>;
  createTab: (url?: string) => Promise<string>;
  switchTab: (tabId: string) => Promise<boolean>;
  closeTab: (tabId: string) => Promise<boolean>;
  moveTab: (tabId: string, toIndex: number) => Promise<boolean>;
  navigate: (url: string, tabId?: string) => Promise<boolean>;
  reload: (tabId?: string) => Promise<boolean>;
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
  captureFullPage: () => Promise<string>;
  captureViewport: () => Promise<string>;
  openExternal: (url?: string) => Promise<boolean>;
  findInPage: (text: string, forward?: boolean) => Promise<void>;
  stopFindInPage: () => Promise<void>;
  showMenu: () => Promise<void>;
  setOverlay: (active: boolean) => Promise<void>;
  clearStorage: () => Promise<void>;
  getChromeProfiles: () => Promise<any[]>;
  syncChromeProfile: (profileId: string) => Promise<any>;
  toggleBookmarkBar: () => Promise<boolean>;
  addBookmark: (title: string, url: string) => Promise<any>;
  removeBookmark: (url: string) => Promise<any>;
  getSuggestions: (query: string) => Promise<{ suggestions: Array<{ type: 'search' | 'url' | 'bookmark'; text: string; url?: string }> }>;
  toggleTerminal: () => Promise<boolean>;
  startTerminal: (cwd?: string) => Promise<boolean>;
  sendTerminalInput: (input: string) => Promise<boolean>;
  killTerminal: () => Promise<boolean>;
  restartTerminal: (cwd?: string) => Promise<boolean>;
  onTerminalData: (callback: (data: string) => void) => () => void;
  onStateUpdated: (callback: (state: any) => void) => () => void;
  onElementPicked: (callback: (element: any) => void) => () => void;
  onFocusFind: (callback: () => void) => () => void;
  onFocusOmnibox: (callback: () => void) => () => void;
  onShowShortcuts: (callback: () => void) => () => void;
  onFindResult: (callback: (result: any) => void) => () => void;
}

declare global {
  interface Window {
    antifanToolbar?: AntiFanToolbarApi;
  }
}

function getApi(): AntiFanToolbarApi | undefined {
  return window.antifanToolbar;
}

let currentTabs: AntiFanTab[] = [];
let currentBookmarks: Array<{ id: string; title: string; url: string }> = [];
let activeTabId: string = '';
let isInspecting = false;
let isFontFinderActive = false;
let isLensActive = false;
let isRulerActive = false;

// DOM Elements
const tabList = document.getElementById('tabList')!;
const btnNewTab = document.getElementById('btnNewTab')!;
const btnBack = document.getElementById('btnBack') as HTMLButtonElement;
const btnForward = document.getElementById('btnForward') as HTMLButtonElement;
const btnReload = document.getElementById('btnReload') as HTMLButtonElement;
const urlInput = document.getElementById('urlInput') as HTMLInputElement;
const btnClearOmnibox = document.getElementById('btnClearOmnibox') as HTMLButtonElement;
const deviceSelect = document.getElementById('deviceSelect') as HTMLSelectElement;

// Zoom Stepper Elements
const zoomLabel = document.getElementById('zoomLabel')!;
const btnZoomOutPop = document.getElementById('btnZoomOutPop') as HTMLButtonElement;
const btnZoomInPop = document.getElementById('btnZoomInPop') as HTMLButtonElement;

// Tool Buttons
const btnQuickInspect = document.getElementById('btnQuickInspect') as HTMLButtonElement;
const btnFontFinder = document.getElementById('btnFontFinder') as HTMLButtonElement;
const btnRuler = document.getElementById('btnRuler') as HTMLButtonElement;
const btnCaptureFullPage = document.getElementById('btnCaptureFullPage') as HTMLButtonElement;
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
const findPrev = document.getElementById('findPrev') as HTMLButtonElement;
const findNext = document.getElementById('findNext') as HTMLButtonElement;
const findClose = document.getElementById('findClose') as HTMLButtonElement;

// Shortcuts Overlay
const shortcutsOverlay = document.getElementById('shortcutsOverlay')!;
const shortcutsClose = document.getElementById('shortcutsClose') as HTMLButtonElement;

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
        <span class="tab-title"></span>
        <span class="tab-status-dot done" title="Ready"></span>
        <span class="tab-close" title="Close Tab"></span>
      `;

      tabEl.querySelector('.tab-close')?.addEventListener('click', (e) => {
        e.stopPropagation();
        getApi()?.closeTab(tab.id);
      });

      tabEl.addEventListener('click', () => {
        if (tab.id !== activeTabId) {
          getApi()?.switchTab(tab.id);
        }
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
    tabEl.className = `tab ${isActive ? 'active' : ''}`;
    tabEl.setAttribute('aria-selected', isActive ? 'true' : 'false');

    // Update Spinner & Icon
    const spinner = tabEl.querySelector('.tab-spinner') as HTMLElement;
    const icon = tabEl.querySelector('.tab-icon') as HTMLImageElement;
    const statusDot = tabEl.querySelector('.tab-status-dot') as HTMLElement;
    const titleSpan = tabEl.querySelector('.tab-title') as HTMLElement;

    if (tab.isLoading) {
      if (spinner) spinner.style.display = 'inline-block';
      if (icon) icon.style.display = 'none';
      if (statusDot) {
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
        statusDot.className = isActive ? 'tab-status-dot working' : 'tab-status-dot done';
        statusDot.title = isActive ? 'Đang kích hoạt' : 'Sẵn sàng';
      }
    }

    // Update Title
    const newTitle = tab.title || hostname(tab.url) || 'New Tab';
    if (titleSpan && titleSpan.textContent !== newTitle) {
      titleSpan.textContent = newTitle;
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

function renderBookmarks() {
  if (!bookmarkBar || !bookmarkItems) return;

  if (currentBookmarks.length === 0) {
    bookmarkBar.style.display = 'none';
  } else {
    bookmarkBar.style.display = 'flex';
  }

  bookmarkItems.innerHTML = '';

  const activeTab = currentTabs.find((t) => t.id === activeTabId);
  const isBookmarked = activeTab && currentBookmarks.some((b) => b.url === activeTab.url);
  if (btnStarBookmark) {
    btnStarBookmark.classList.toggle('active', !!isBookmarked);
  }

  currentBookmarks.forEach((bm) => {
    const item = document.createElement('div');
    item.className = 'bookmark-item';
    item.title = `${bm.title}\n${bm.url}\n(Right-click to remove)`;

    const icon = document.createElement('img');
    icon.className = 'bookmark-item-icon';
    let domain = '';
    try { domain = new URL(bm.url).hostname; } catch {}
    icon.src = `https://www.google.com/s2/favicons?domain=${domain}&sz=32`;

    const title = document.createElement('span');
    title.className = 'bookmark-item-title';
    title.textContent = bm.title || hostname(bm.url);

    item.appendChild(icon);
    item.appendChild(title);

    item.addEventListener('click', () => {
      getApi()?.navigate(bm.url, activeTabId);
    });

    item.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      getApi()?.removeBookmark(bm.url);
    });

    bookmarkItems.appendChild(item);
  });
}

// Navigation Listeners
if (btnNewTab) btnNewTab.addEventListener('click', () => getApi()?.createTab());
if (btnBack) btnBack.addEventListener('click', () => getApi()?.goBack());
if (btnForward) btnForward.addEventListener('click', () => getApi()?.goForward());
if (btnReload) btnReload.addEventListener('click', () => getApi()?.reload());

if (btnStarBookmark) {
  btnStarBookmark.addEventListener('click', () => {
    const activeTab = currentTabs.find((t) => t.id === activeTabId);
    if (!activeTab || !activeTab.url || activeTab.url === 'about:blank') return;
    const isBookmarked = currentBookmarks.some((b) => b.url === activeTab.url);
    if (isBookmarked) {
      getApi()?.removeBookmark(activeTab.url);
    } else {
      getApi()?.addBookmark(activeTab.title || activeTab.url, activeTab.url);
    }
  });
}

// Device Viewport
if (deviceSelect) {
  deviceSelect.addEventListener('change', () => {
    getApi()?.setDevicePreset(deviceSelect.value);
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
if (btnQuickInspect) btnQuickInspect.addEventListener('click', () => getApi()?.toggleInspect());
if (btnFontFinder) btnFontFinder.addEventListener('click', () => getApi()?.toggleFontFinder());
if (btnRuler) btnRuler.addEventListener('click', () => getApi()?.toggleRuler());
if (btnDevTools) btnDevTools.addEventListener('click', () => getApi()?.toggleDevTools());
if (btnToggleSidebar) btnToggleSidebar.addEventListener('click', () => getApi()?.toggleSidebar());

if (btnCaptureFullPage) {
  btnCaptureFullPage.addEventListener('click', async () => {
    await getApi()?.captureViewport();
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
      const res = await getApi()?.syncChromeProfile(p.id);
      if (res) {
        activeProfileInfo = p;
        renderChromeProfiles();
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
      const profiles = await getApi()?.getChromeProfiles();
      if (profiles && Array.isArray(profiles)) {
        availableChromeProfiles = profiles;
      }
      renderChromeProfiles();
      profileDropdownMenu.style.display = 'flex';
    } else {
      profileDropdownMenu.style.display = 'none';
    }
  });
}

document.addEventListener('click', (e) => {
  if (profileDropdownMenu && profileDropdownMenu.style.display !== 'none') {
    if (!profileDropdownMenu.contains(e.target as Node) && !btnChromeProfile.contains(e.target as Node)) {
      profileDropdownMenu.style.display = 'none';
    }
  }
});

// Three-dot Menu
if (btnMenu) {
  btnMenu.addEventListener('click', (e) => {
    e.stopPropagation();
    getApi()?.showMenu();
  });
}

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
document.addEventListener('click', (e) => {
  if (codexMainMenu && !codexMainMenu.contains(e.target as Node) && e.target !== btnMenu) {
    codexMainMenu.classList.remove('active');
  }
});

// Google Omnibox Suggest Dropdown
const omniboxSuggestDropdown = document.getElementById('omniboxSuggestDropdown') as HTMLDivElement | null;
const omniboxSuggestList = document.getElementById('omniboxSuggestList') as HTMLDivElement | null;

let suggestItems: Array<{ type: 'search' | 'url' | 'bookmark'; text: string; url?: string }> = [];
let selectedSuggestIndex = -1;
let suggestDebounceTimer: any = null;

function hideSuggestDropdown() {
  if (!omniboxSuggestDropdown) return;
  omniboxSuggestDropdown.style.display = 'none';
  selectedSuggestIndex = -1;
  suggestItems = [];
}

async function updateSuggestDropdown(query: string) {
  if (!omniboxSuggestDropdown || !omniboxSuggestList) return;
  const q = (query || '').trim();
  try {
    const res = await getApi()?.getSuggestions(q);
    if (res && Array.isArray(res.suggestions) && res.suggestions.length > 0) {
      suggestItems = res.suggestions;
      renderSuggestItems(q);
      omniboxSuggestDropdown.style.display = 'block';
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
    if (item.type === 'bookmark') {
      iconSvg = '<svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor"><path d="M3.612 15.443c-.386.198-.824-.149-.746-.592l.83-4.73L.173 6.765c-.329-.314-.158-.888.283-.95l4.898-.696L7.538.792c.197-.39.73-.39.927 0l2.184 4.327 4.898.696c.441.062.612.636.282.95l-3.522 3.356.83 4.73c.078.443-.36.79-.746.592L8 13.187l-4.389 2.256z"/></svg>';
    } else if (item.type === 'url') {
      iconSvg = '<svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor"><path d="M4.715 6.542 3.343 7.914a3 3 0 1 0 4.243 4.243l1.828-1.829A3 3 0 0 0 8.586 5.5L8 6.086a1.002 1.002 0 0 0-.154.199 2 2 0 0 1 .861 3.337L6.88 11.45a2 2 0 1 1-2.83-2.83l.793-.792a4.018 4.018 0 0 1-.128-1.287z"/><path d="M6.586 4.672A3 3 0 0 0 7.414 9.5l.775-.776a2 2 0 0 1-.896-3.346L9.12 3.55a2 2 0 1 1 2.83 2.83l-.793.792c.112.42.155.855.128 1.287l1.372-1.372a3 3 0 1 0-4.243-4.243L6.586 4.672z"/></svg>';
    } else {
      iconSvg = '<svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor"><path d="M11.742 10.344a6.5 6.5 0 1 0-1.397 1.398h-.001c.03.04.062.078.098.115l3.85 3.85a1 1 0 0 0 1.415-1.414l-3.85-3.85a1.007 1.007 0 0 0-.115-.1zM12 6.5a5.5 5.5 0 1 1-11 0 5.5 5.5 0 0 1 11 0z"/></svg>';
    }

    let matchHtml = escapeHtml(item.text);
    if (lowerQ && item.text.toLowerCase().includes(lowerQ)) {
      const startIdx = item.text.toLowerCase().indexOf(lowerQ);
      const before = item.text.slice(0, startIdx);
      const match = item.text.slice(startIdx, startIdx + lowerQ.length);
      const after = item.text.slice(startIdx + lowerQ.length);
      matchHtml = `${escapeHtml(before)}<b>${escapeHtml(match)}</b>${escapeHtml(after)}`;
    }

    const subText = item.type === 'search' ? 'Google Search' : (item.url ? hostname(item.url) : '');

    el.innerHTML = `
      <span class="suggest-icon">${iconSvg}</span>
      <div class="suggest-content">
        <span class="suggest-text">${matchHtml}</span>
        ${subText ? `<span class="suggest-subtext">${escapeHtml(subText)}</span>` : ''}
      </div>
    `;

    el.addEventListener('mousedown', (e) => {
      e.preventDefault();
      const targetNav = item.url || item.text;
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
    if (urlInput.value) {
      updateSuggestDropdown(urlInput.value);
    }
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
      if (val) {
        getApi()?.navigate(val);
        hideSuggestDropdown();
        urlInput.blur();
      }
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
  findInput.focus();
  findInput.select();
}

function hideFindBar() {
  if (!findBar) return;
  findBar.style.display = 'none';
  getApi()?.stopFindInPage();
}

if (findInput) {
  findInput.addEventListener('input', () => {
    const q = findInput.value.trim();
    if (q) getApi()?.findInPage(q, true);
    else getApi()?.stopFindInPage();
  });

  findInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      getApi()?.findInPage(findInput.value.trim(), !e.shiftKey);
    } else if (e.key === 'Escape') {
      hideFindBar();
    }
  });
}

if (findNext && findInput) findNext.addEventListener('click', () => getApi()?.findInPage(findInput.value.trim(), true));
if (findPrev && findInput) findPrev.addEventListener('click', () => getApi()?.findInPage(findInput.value.trim(), false));
if (findClose) findClose.addEventListener('click', hideFindBar);

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

// Embedded Terminal Controls
const btnToggleTerminal = document.getElementById('btnToggleTerminal') as HTMLButtonElement | null;
const menuTerminal = document.getElementById('menuTerminal') as HTMLDivElement | null;

if (btnToggleTerminal) {
  btnToggleTerminal.addEventListener('click', () => {
    getApi()?.toggleTerminal();
  });
}
if (menuTerminal) {
  menuTerminal.addEventListener('click', () => {
    getApi()?.toggleTerminal();
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
      if (btnToggleTerminal) {
        btnToggleTerminal.classList.toggle('mode-active', !!state.isTerminalOpen);
      }
      renderTabs();
      renderBookmarks();
      renderChromeProfiles();
      updateControls();
    }
  });

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
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initToolbar);
} else {
  initToolbar();
}
