/**
 * AntiFan Browser Desktop — Tab Preload Script (Stealth & Google Chrome Parity)
 * Completely masks Electron automation properties and injects Haravan JSON Viewer.
 */
import { ipcRenderer } from 'electron';

// 1. Google Chrome Environment & Stealth Spoofing
try {
  // Remove navigator.webdriver
  Object.defineProperty(navigator, 'webdriver', {
    get: () => undefined,
    configurable: true,
  });

  // Emulate window.chrome properties expected by Google Accounts
  if (!(window as any).chrome) {
    (window as any).chrome = {
      app: {
        isInstalled: false,
        InstallState: { DISABLED: 'disabled', INSTALLED: 'installed', NOT_INSTALLED: 'not_installed' },
        RunningState: { CANNOT_RUN: 'cannot_run', READY_TO_RUN: 'ready_to_run', RUNNING: 'running' },
      },
      csi: () => {},
      loadTimes: () => ({
        requestTime: Date.now() / 1000,
        startLoadTime: Date.now() / 1000,
        commitLoadTime: Date.now() / 1000,
        finishDocumentLoadTime: Date.now() / 1000,
        finishLoadTime: Date.now() / 1000,
        firstPaintTime: Date.now() / 1000,
        firstPaintAfterLoadTime: 0,
        navigationType: 'Other',
        wasFetchedViaSpdy: false,
        wasNpnNegotiated: false,
        npnNegotiatedProtocol: 'unknown',
        wasAlternateProtocolAvailable: false,
        connectionInfo: 'unknown',
      }),
      runtime: {
        OnInstalledReason: {},
        OnRestartRequiredReason: {},
        PlatformArch: { ARM: 'arm', ARM64: 'arm64', MIPS: 'mips', MIPS64: 'mips64', X86_32: 'x86-32', X86_64: 'x86-64' },
        PlatformNaclArch: { ARM: 'arm', MIPS: 'mips', MIPS64: 'mips64', X86_32: 'x86-32', X86_64: 'x86-64' },
        PlatformOs: { ANDROID: 'android', CROS: 'cros', LINUX: 'linux', MAC: 'mac', OPENBSD: 'openbsd', WIN: 'win' },
        RequestUpdateCheckStatus: {},
      },
    };
  }

  // Spoof navigator.userAgentData with official Google Chrome brands
  const fakeBrands = [
    { brand: 'Google Chrome', version: '134' },
    { brand: 'Chromium', version: '134' },
    { brand: 'Not_A Brand', version: '24' },
  ];
  Object.defineProperty(navigator, 'userAgentData', {
    get: () => ({
      brands: fakeBrands,
      mobile: false,
      platform: 'Windows',
      getHighEntropyValues: async () => ({
        brands: fakeBrands,
        mobile: false,
        platform: 'Windows',
        platformVersion: '15.0.0',
        architecture: 'x86',
        model: '',
        uaFullVersion: '134.0.6998.45',
        fullVersionList: fakeBrands,
      }),
      toJSON: () => ({
        brands: fakeBrands,
        mobile: false,
        platform: 'Windows',
      }),
    }),
    configurable: true,
  });

  // Remove any electron identifier from global scope
  delete (window as any).electron;
  delete (window as any).process;
} catch {}

// 2. Haravan Auto JSON Viewer (Tree View & Unicode Decoded)
window.addEventListener('DOMContentLoaded', () => {
  try {
    const raw = (document.body && document.body.innerText) || (document.body && document.body.textContent) || '';
    const trimmed = String(raw).trim();
    if (!trimmed || trimmed.length < 2) return;

    let parsed: any = null;
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try { parsed = JSON.parse(trimmed); } catch {}
    }
    if (!parsed && /(?:=\s*)?([{\[][\s\S]*[}\]])\s*;?\s*$/.test(trimmed)) {
      const m = trimmed.match(/(?:=\s*)?([{\[][\s\S]*[}\]])\s*;?\s*$/);
      if (m && m[1]) { try { parsed = JSON.parse(m[1]); } catch {} }
    }
    if (parsed === null || typeof parsed !== 'object') return;
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
