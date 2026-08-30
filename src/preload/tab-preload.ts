/**
 * AntiFan Browser Desktop — Tab Preload Script
 * Lightweight preload for JSON Viewer, tab utilities, and anti-detection consistency.
 */
import { ipcRenderer } from 'electron';

// 1. Browser Identity & Anti-Detection Consistency
(() => {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') return;

  const loc = window.location;
  const hostname = (loc.hostname || '').toLowerCase();
  const pathname = (loc.pathname || '').toLowerCase();
  const search = (loc.search || '').toLowerCase();

  const isGoogleAuth = navigator.userAgent.includes('Firefox/') ||
    hostname === 'accounts.google.com' ||
    hostname === 'accounts.youtube.com' ||
    pathname.includes('/signin') ||
    pathname.includes('/servicelogin') ||
    pathname.includes('/accountchooser') ||
    pathname.includes('/identifier') ||
    pathname.includes('/v3/signin') ||
    search.includes('flowname=glifwebsignin') ||
    search.includes('flowname=weblitesignin') ||
    search.includes('flowentry=') ||
    search.includes('service=mail');

  if (isGoogleAuth) {
    try {
      Object.defineProperty(navigator, 'webdriver', { get: () => false, configurable: true });
    } catch {}

    try {
      const platform = navigator.platform || 'Win32';
      const platformStr = platform.includes('Mac')
        ? 'Macintosh; Intel Mac OS X 10.15'
        : platform.includes('Win')
          ? 'Windows NT 10.0; Win64; x64'
          : 'X11; Linux x86_64';
      const firefoxUa = `Mozilla/5.0 (${platformStr}; rv:140.0) Gecko/20100101 Firefox/140.0`;
      Object.defineProperty(navigator, 'userAgent', { get: () => firefoxUa, configurable: true });
      Object.defineProperty(navigator, 'appVersion', { get: () => `5.0 (${platformStr})`, configurable: true });
    } catch {}

    try {
      delete (window as unknown as Record<string, unknown>).chrome;
      if (window.constructor && window.constructor.prototype) {
        delete (window.constructor.prototype as unknown as Record<string, unknown>).chrome;
      }
      const proto = Object.getPrototypeOf(window) as Record<string, unknown> | null;
      if (proto) delete proto.chrome;
    } catch {}

    try {
      delete (navigator as unknown as Record<string, unknown>).userAgentData;
      if (typeof Navigator !== 'undefined' && Navigator.prototype) {
        delete (Navigator.prototype as unknown as Record<string, unknown>).userAgentData;
      }
      const navProto = Object.getPrototypeOf(navigator) as Record<string, unknown> | null;
      if (navProto) delete navProto.userAgentData;
    } catch {}

    try {
      if (!(window as unknown as Record<string, unknown>).InstallTrigger) {
        (window as unknown as Record<string, unknown>).InstallTrigger = {};
      }
    } catch {}

    try {
      Object.defineProperty(navigator, 'oscpu', { get: () => 'Windows NT 10.0; Win64; x64', configurable: true });
      Object.defineProperty(navigator, 'buildID', { get: () => '20181001000000', configurable: true });
      Object.defineProperty(navigator, 'pdfViewerEnabled', { get: () => true, configurable: true });
    } catch {}
  } else {
    try {
      Object.defineProperty(navigator, 'webdriver', { get: () => false, configurable: true });
    } catch {}

    if (navigator.plugins.length === 0) {
      try {
        Object.defineProperty(navigator, 'plugins', {
          get: () => [
            { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer' },
            { name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai' },
            { name: 'Native Client', filename: 'internal-nacl-plugin' },
          ],
          configurable: true,
        });
      } catch {}
    }

    const w = window as any;
    if (!w.chrome) {
      w.chrome = {};
    }
    if (!w.chrome.csi) {
      w.chrome.csi = function () {
        return { startE: Date.now(), onloadT: Date.now(), pageT: performance.now(), tran: 15 };
      };
    }
    if (!w.chrome.loadTimes) {
      w.chrome.loadTimes = function () {
        return {
          commitLoadTime: Date.now() / 1000,
          connectionInfo: 'h2',
          finishDocumentLoadTime: Date.now() / 1000,
          finishLoadTime: Date.now() / 1000,
          firstPaintAfterLoadTime: 0,
          firstPaintTime: Date.now() / 1000,
          navigationType: 'Other',
          npnNegotiatedProtocol: 'h2',
          requestTime: Date.now() / 1000 - 0.16,
          startLoadTime: Date.now() / 1000 - 0.3,
          wasAlternateProtocolAvailable: false,
          wasFetchedViaSpdy: true,
          wasNpnNegotiated: true,
        };
      };
    }
  }
})();

const isGoogleProperty = typeof window !== 'undefined' && (
  /(^|\.)(google\.(com?(\.[a-z]{2})?|[a-z]{2})|youtube\.com|googleapis\.com|gstatic\.com|1e100\.net|gvt1\.com)$/i.test(window.location.hostname || '')
);

if (!isGoogleProperty) {
// 2. Haravan Auto JSON Viewer (Tree View & Unicode Decoded - JSON endpoints only)
window.addEventListener('DOMContentLoaded', () => {
  try {
    // Only run on explicit JSON document endpoints or single <pre> raw responses
    const isJsonDoc =
      document.contentType === 'application/json' ||
      document.contentType === 'text/json' ||
      (document.body && document.body.children.length === 1 && document.body.children[0]?.tagName === 'PRE');
    if (!isJsonDoc) return;

    const rawEl = document.querySelector('pre') || document.body;
    const raw = rawEl ? (rawEl.textContent || '') : '';
    const trimmed = raw.trim();
    if (!trimmed || trimmed.length < 2) return;

    let parsed: any = null;
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try { parsed = JSON.parse(trimmed); } catch {}
    }
    if (!parsed) return;
    if ((window as any).__masterJsonInjected) return;
    (window as any).__masterJsonInjected = true;
    const esc = (s: any) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

    const renderValue = (v: any): string => {
      if (v === null) return '<span class="jv-null">null</span>';
      if (typeof v === 'string') return '<span class="jv-str">"' + esc(v) + '"</span>';
      if (typeof v === 'number') return '<span class="jv-num">' + v + '</span>';
      if (typeof v === 'boolean') return '<span class="jv-bool">' + v + '</span>';
      return '';
    };

    const renderNode = (key: string | null, v: any, depth: number): string => {
      const keyHtml = key === null ? '' : '<span class="jv-key">"' + esc(key) + '"</span><span class="jv-br">: </span>';
      if (Array.isArray(v)) {
        if (v.length === 0) return '<div class="jv-node">' + keyHtml + '<span class="jv-br">[</span><span class="jv-br">]</span></div>';
        const children = v.map((item) => renderNode(null, item, depth + 1)).join('');
        return '<div class="jv-node"><span class="jv-toggle">▾</span>' + keyHtml + '<span class="jv-br">[</span> <span class="jv-badge">' + v.length + ' items</span></div><div class="jv-children">' + children + '</div><div class="jv-close"><span class="jv-br">]</span></div>';
      }
      if (v && typeof v === 'object') {
        const entries = Object.entries(v);
        if (entries.length === 0) return '<div class="jv-node">' + keyHtml + '<span class="jv-br">{</span><span class="jv-br">}</span></div>';
        const children = entries.map(([k, item]) => renderNode(k, item, depth + 1)).join('');
        return '<div class="jv-node"><span class="jv-toggle">▾</span>' + keyHtml + '<span class="jv-br">{</span> <span class="jv-badge">' + entries.length + ' keys</span></div><div class="jv-children">' + children + '</div><div class="jv-close"><span class="jv-br">}</span></div>';
      }
      return '<div class="jv-node">' + keyHtml + renderValue(v) + '</div>';
    };

    const style = document.createElement('style');
    style.textContent = `
      :root { --jv-bg:#121216; --jv-panel:#1a1a22; --jv-border:#2a2a36; --jv-muted:#94a3b8; --jv-text:#f1f5f9; --jv-str:#86efac; --jv-num:#fdba74; --jv-bool:#93c5fd; --jv-null:#94a3b8; --jv-key:#c084fc; --jv-br:#64748b; }
      * { box-sizing: border-box; }
      body { margin: 0; padding: 0; background: var(--jv-bg) !important; color: var(--jv-text) !important; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
      .jv-header { position: sticky; top: 0; z-index: 1000; display: flex; align-items: center; justify-content: space-between; padding: 8px 16px; background: var(--jv-panel); border-bottom: 1px solid var(--jv-border); font-size: 12px; }
      .jv-header-left { display: flex; align-items: center; gap: 10px; }
      .jv-header-title { font-weight: 600; color: #38bdf8; display: flex; align-items: center; gap: 6px; }
      .jv-header-actions { display: flex; align-items: center; gap: 6px; }
      .jv-btn { background: #272732; color: #cbd5e1; border: 1px solid var(--jv-border); border-radius: 4px; padding: 4px 10px; font-size: 11px; cursor: pointer; transition: all 0.12s ease; }
      .jv-btn:hover { background: #0284c7; color: #ffffff; border-color: #0284c7; }
      .jv-tree { padding: 16px 20px; font-family: ui-monospace, "Cascadia Code", Consolas, monospace; font-size: 12.5px; line-height: 1.6; white-space: normal; overflow-wrap: break-word; }
      .jv-node { padding: 1px 6px; border-radius: 4px; transition: background 0.1s ease; }
      .jv-node:hover { background: rgba(255, 255, 255, 0.05); }
      .jv-toggle { cursor: pointer; color: var(--jv-muted); user-select: none; display: inline-block; width: 16px; font-size: 11px; }
      .jv-toggle:hover { color: #ffffff; }
      .jv-key { color: var(--jv-key); font-weight: 500; }
      .jv-str { color: var(--jv-str); overflow-wrap: anywhere; }
      .jv-num { color: var(--jv-num); }
      .jv-bool { color: var(--jv-bool); font-weight: 600; }
      .jv-null { color: var(--jv-null); font-style: italic; opacity: 0.8; }
      .jv-br { color: var(--jv-br); }
      .jv-badge { font-size: 10px; color: #64748b; font-style: italic; margin-left: 6px; }
      .jv-children { padding-left: 20px; border-left: 1px solid rgba(100, 116, 139, 0.25); margin-left: 6px; }
      .jv-close { color: var(--jv-br); padding-left: 6px; }
      .jv-hidden { display: none; }
      .jv-raw-view { padding: 16px 20px; font-family: ui-monospace, Consolas, monospace; font-size: 12px; color: #cbd5e1; white-space: pre-wrap; word-break: break-word; display: none; }
    `;
    document.head.appendChild(style);

    const rawJsonFormatted = JSON.stringify(parsed, null, 2);
    document.body.innerHTML = `
      <div class="jv-header">
        <div class="jv-header-left">
          <span class="jv-header-title">⚡ Haravan JSON View</span>
          <span style="color:#64748b;font-size:11px;">(Auto Unicode Decoded)</span>
        </div>
        <div class="jv-header-actions">
          <button class="jv-btn" id="jvBtnCopy">📋 Copy JSON</button>
          <button class="jv-btn" id="jvBtnExpand">⇲ Expand All</button>
          <button class="jv-btn" id="jvBtnCollapse">⇱ Collapse All</button>
          <button class="jv-btn" id="jvBtnToggleRaw">{} Raw View</button>
        </div>
      </div>
      <div class="jv-tree" id="jvTree">${renderNode(null, parsed, 0)}</div>
      <div class="jv-raw-view" id="jvRaw">${esc(rawJsonFormatted)}</div>
    `;

    const tree = document.getElementById('jvTree');
    const rawView = document.getElementById('jvRaw');

    tree?.addEventListener('click', (e) => {
      const t = (e.target as HTMLElement).closest('.jv-toggle');
      if (!t) return;
      const n = t.closest('.jv-node');
      if (!n) return;
      const c = n.nextElementSibling;
      if (!c || !c.classList.contains('jv-children')) return;
      const hidden = c.classList.toggle('jv-hidden');
      t.textContent = hidden ? '▸' : '▾';
    });

    document.getElementById('jvBtnCopy')?.addEventListener('click', () => {
      navigator.clipboard.writeText(rawJsonFormatted);
      const btn = document.getElementById('jvBtnCopy');
      if (btn) {
        btn.textContent = '✓ Copied!';
        setTimeout(() => { btn.textContent = '📋 Copy JSON'; }, 1500);
      }
    });

    document.getElementById('jvBtnExpand')?.addEventListener('click', () => {
      tree?.querySelectorAll('.jv-children').forEach((el) => el.classList.remove('jv-hidden'));
      tree?.querySelectorAll('.jv-toggle').forEach((el) => { (el as HTMLElement).textContent = '▾'; });
    });

    document.getElementById('jvBtnCollapse')?.addEventListener('click', () => {
      tree?.querySelectorAll('.jv-children').forEach((el) => el.classList.add('jv-hidden'));
      tree?.querySelectorAll('.jv-toggle').forEach((el) => { (el as HTMLElement).textContent = '▸'; });
    });

    document.getElementById('jvBtnToggleRaw')?.addEventListener('click', () => {
      if (!rawView || !tree) return;
      const isRaw = rawView.style.display === 'block';
      rawView.style.display = isRaw ? 'none' : 'block';
      tree.style.display = isRaw ? 'block' : 'none';
      const toggleBtn = document.getElementById('jvBtnToggleRaw');
      if (toggleBtn) {
        toggleBtn.textContent = isRaw ? '{} Raw View' : '🌲 Tree View';
      }
    });
  } catch {}
});

// 3. Google Chrome Parity: Ctrl + Mouse Wheel Zoom
window.addEventListener(
  'wheel',
  (e: WheelEvent) => {
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      const isZoomIn = e.deltaY < 0;
      try {
        ipcRenderer.send('antifan:tab-wheel-zoom', { isZoomIn });
      } catch {}
    }
  },
  { passive: false }
);
// 4. Web AI Real-time Streaming & Response State Detector (Scoped strictly to AI chat services)
(() => {
  if (typeof window === 'undefined') return;

  const AI_CHAT_HOSTS = /chatgpt\.com|chat\.openai\.com|claude\.ai|gemini\.google\.com|deepseek\.com|perplexity\.ai|poe\.com|grok\.com|x\.ai|qwen\.ai|tongyi\.aliyun\.com|openwebui|localhost:20128/i;
  const host = (window.location.hostname || '') + ':' + (window.location.port || '');
  if (!AI_CHAT_HOSTS.test(host)) return;

  let currentAiState: 'idle' | 'streaming' | 'completed' = 'idle';
  let idleResetTimer: any = null;
  let checkThrottleTimer: any = null;

  const STREAMING_SELECTORS = [
    'button[data-testid="stop-button"]',
    'button[aria-label="Stop streaming"]',
    'button[aria-label="Stop generating"]',
    '.result-streaming',
    '[data-testid="fruitjuice-send-button"] [data-state="streaming"]',
    // Claude.ai
    'button[aria-label="Stop Response"]',
    'button[aria-label="Stop response"]',
    'button[aria-label="Stop Output"]',
    'button[data-testid="stop-button"]',
    '.font-claude-message [data-is-streaming="true"]',
    // Google Gemini
    'button[aria-label*="Stop" i]',
    'button[aria-label*="Dừng" i]',
    'mat-icon[fonticon="stop"]',
    '.spark-streaming',
    // DeepSeek
    'div.ds-button--primary[aria-label*="Stop" i]',
    'button.stop-btn',
    '.ds-markdown--streaming',
    '.ds-icon-button--stop',
    // Perplexity, Poe, Grok, Qwen, 9Router, generic
    'button[aria-label*="Stop generating" i]',
    'button[title*="Stop generating" i]',
    'button[aria-label*="Stop generation" i]',
    '.ai-streaming',
    '.is-generating',
  ];

  const checkAiStreaming = () => {
    if (typeof document === 'undefined' || !document.body) return;
    
    let isStreaming = false;
    for (const sel of STREAMING_SELECTORS) {
      try {
        const el = document.querySelector(sel);
        if (el && (el.clientWidth > 0 || el.clientHeight > 0 || (el as HTMLElement).offsetParent !== null || el.classList.contains('result-streaming') || el.classList.contains('ds-markdown--streaming'))) {
          isStreaming = true;
          break;
        }
      } catch {}
    }

    if (isStreaming) {
      if (idleResetTimer) {
        clearTimeout(idleResetTimer);
        idleResetTimer = null;
      }
      if (currentAiState !== 'streaming') {
        currentAiState = 'streaming';
        try {
          ipcRenderer.send('antifan:tab-ai-state', { aiState: 'streaming' });
        } catch {}
      }
    } else {
      if (currentAiState === 'streaming') {
        currentAiState = 'completed';
        try {
          ipcRenderer.send('antifan:tab-ai-state', { aiState: 'completed' });
        } catch {}

        // Reset to idle after 6 seconds of completion
        if (idleResetTimer) clearTimeout(idleResetTimer);
        idleResetTimer = setTimeout(() => {
          if (currentAiState === 'completed') {
            currentAiState = 'idle';
            try {
              ipcRenderer.send('antifan:tab-ai-state', { aiState: 'idle' });
            } catch {}
          }
        }, 6000);
      }
    }
  };

  const scheduleCheck = () => {
    if (checkThrottleTimer) return;
    checkThrottleTimer = setTimeout(() => {
      checkThrottleTimer = null;
      checkAiStreaming();
    }, 200);
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      scheduleCheck();
      try {
        const observer = new MutationObserver(() => scheduleCheck());
        observer.observe(document.body || document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'data-state', 'aria-label', 'disabled'] });
      } catch {}
    });
  } else {
    scheduleCheck();
    try {
      const observer = new MutationObserver(() => scheduleCheck());
      observer.observe(document.body || document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'data-state', 'aria-label', 'disabled'] });
    } catch {}
  }
})();
// 5. Theme Error Sentinel (Haravan, Shopify, Sapo Liquid & Server Errors)
(() => {
  if (typeof window !== 'undefined') {
    const host = (window.location.hostname || '').toLowerCase();
    const isExcludedDomain = /facebook\.com|fbcdn\.net|messenger\.com|instagram\.com|threads\.net|google\.com|youtube\.com|gstatic\.com|github\.com|twitter\.com|x\.com|apple\.com|microsoft\.com|chatgpt\.com|claude\.ai/i.test(host);
    if (isExcludedDomain) return;
  }

  let reportedError: string | null = null;

  const ERROR_SIGNATURES = [
    { pattern: /\bThemeSyntaxError\b/i, name: 'ThemeSyntaxError (Lỗi cú pháp Liquid)' },
    { pattern: /\bLiquid error:\b/i, name: 'Liquid Error (Lỗi render Liquid)' },
    { pattern: /\bLiquid syntax error\b/i, name: 'Liquid Syntax Error' },
    { pattern: /\bTemplate missing:\b/i, name: 'Template Missing (Thiếu file template)' },
    { pattern: /\bLayout\s+["'].*?["']\s+is missing\b/i, name: 'Layout Missing (Thiếu layout)' },
    { pattern: /\bSection\s+["'].*?["']\s+does not exist\b/i, name: 'Section Missing' },
    { pattern: /\b500 Internal Server Error\b/i, name: '500 Internal Server Error' },
    { pattern: /\bHaravan::TemplateError\b/i, name: 'Haravan Template Error' },
  ];

  const checkThemeError = () => {
    if (typeof document === 'undefined' || !document.documentElement) return;
    const pageTitle = document.title || '';
    const bodyText = (document.body ? document.body.innerText || document.body.textContent || '' : '').slice(0, 15000);
    const combined = `${pageTitle}\n${bodyText}`;

    let detected: string | null = null;
    for (const sig of ERROR_SIGNATURES) {
      if (sig.pattern.test(combined)) {
        detected = sig.name;
        break;
      }
    }

    if (detected !== reportedError) {
      reportedError = detected;
      try {
        ipcRenderer.send('antifan:tab-theme-error', { themeError: reportedError });
      } catch {}
    }
  };

  const scheduleErrorCheck = () => {
    setTimeout(checkThemeError, 250);
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', scheduleErrorCheck);
    window.addEventListener('load', scheduleErrorCheck);
  } else {
    scheduleErrorCheck();
  }

  try {
    const errorObserver = new MutationObserver(() => scheduleErrorCheck());
    errorObserver.observe(document.documentElement, { childList: true, subtree: true });
  } catch {}
})();

// 6. Passive Scroll Position Tracker for State & Restart Restoration
(() => {
  let scrollThrottle: number | NodeJS.Timeout | null = null;
  window.addEventListener(
    'scroll',
    () => {
      if (scrollThrottle) return;
      scrollThrottle = setTimeout(() => {
        scrollThrottle = null;
        try {
          ipcRenderer.send('antifan:tab:scroll-changed', {
            scrollX: Math.round(window.scrollX || window.pageXOffset || 0),
            scrollY: Math.round(window.scrollY || window.pageYOffset || 0),
          });
        } catch {}
      }, 200);
    },
    { passive: true }
  );
})();
}
