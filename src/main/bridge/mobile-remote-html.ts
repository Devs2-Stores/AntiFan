/**
 * AntiFan Browser Desktop — Pure Mobile Remote Terminal Web App
 * 100% Focused on Live Terminal Sync & Mobile Shell Control:
 * - Real-time Multi-Tab Sync (switch, create, rename, close tabs)
 * - ANSI Color & Transcript Buffer Rendering (Dark Theme, Cascadia / JetBrains Mono)
 * - Bi-directional Live Stream (PC <-> Mobile sync without lag)
 * - Mobile Touch Keypad (Esc, Tab, Ctrl+C, Ctrl+D, Arrows, History)
 * - Interactive Command & AI Prompt Dispatch
 */

export function renderMobileRemoteHtml(token: string, port: number): string {
  return `<!DOCTYPE html>
<html lang="vi">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover">
  <meta name="apple-mobile-web-app-capable" content="yes">
  <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
  <meta name="theme-color" content="#030712">
  <title>AntiFan Mobile Terminal</title>
  <style>
    :root {
      --bg-primary: #030712;
      --bg-secondary: #0b1324;
      --bg-card: #111e38;
      --bg-input: #070d1a;
      --accent: #38bdf8;
      --accent-glow: rgba(56, 189, 248, 0.35);
      --accent-hover: #0ea5e9;
      --purple: #c084fc;
      --purple-bg: rgba(192, 132, 252, 0.15);
      --text-main: #f1f5f9;
      --text-muted: #94a3b8;
      --border: #1e293b;
      --border-accent: rgba(56, 189, 248, 0.4);
      --danger: #ef4444;
      --danger-bg: rgba(239, 68, 68, 0.18);
      --success: #10b981;
      --success-bg: rgba(16, 185, 129, 0.18);
      --safe-bottom: env(safe-area-inset-bottom, 12px);
      --safe-top: env(safe-area-inset-top, 8px);
    }
    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
      -webkit-tap-highlight-color: transparent;
    }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: var(--bg-primary);
      color: var(--text-main);
      height: 100dvh;
      max-height: 100dvh;
      display: flex;
      flex-direction: column;
      overflow: hidden;
      padding-top: var(--safe-top);
      user-select: none;
    }

    /* TOP HEADER */
    header {
      flex-shrink: 0;
      background: rgba(3, 7, 18, 0.95);
      backdrop-filter: blur(12px);
      -webkit-backdrop-filter: blur(12px);
      border-bottom: 1px solid var(--border);
      padding: 8px 12px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      z-index: 50;
    }
    .brand-box {
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .logo-badge {
      background: linear-gradient(135deg, #0284c7, #38bdf8);
      color: #fff;
      font-size: 11px;
      padding: 2px 7px;
      border-radius: 6px;
      font-weight: 800;
      letter-spacing: 0.5px;
      box-shadow: 0 0 10px var(--accent-glow);
    }
    .brand-title {
      font-size: 14px;
      font-weight: 700;
      color: #f8fafc;
      letter-spacing: 0.2px;
    }
    .header-actions {
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .status-pill {
      display: flex;
      align-items: center;
      gap: 5px;
      font-size: 11px;
      padding: 3px 8px;
      border-radius: 12px;
      background: var(--success-bg);
      color: #34d399;
      border: 1px solid rgba(16, 185, 129, 0.3);
      font-weight: 600;
    }
    .status-dot {
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: var(--success);
      box-shadow: 0 0 6px var(--success);
      animation: pulse 1.6s infinite;
    }
    .status-pill.disconnected {
      background: var(--danger-bg);
      color: #f87171;
      border-color: rgba(239, 68, 68, 0.3);
    }
    .status-pill.disconnected .status-dot {
      background: var(--danger);
      box-shadow: none;
      animation: none;
    }
    @keyframes pulse {
      0%, 100% { opacity: 1; transform: scale(1); }
      50% { opacity: 0.4; transform: scale(0.85); }
    }
    .icon-btn {
      background: var(--bg-card);
      border: 1px solid var(--border);
      color: var(--text-muted);
      border-radius: 7px;
      width: 32px;
      height: 32px;
      display: flex;
      align-items: center;
      justify-content: center;
      cursor: pointer;
      transition: all 0.15s;
    }
    .icon-btn:active {
      background: rgba(56, 189, 248, 0.15);
      border-color: var(--accent);
      color: var(--accent);
    }

    /* MULTI-TAB STRIP */
    .tab-strip-container {
      flex-shrink: 0;
      background: var(--bg-secondary);
      border-bottom: 1px solid var(--border);
      display: flex;
      align-items: center;
      padding: 6px 8px;
      gap: 6px;
      overflow-x: auto;
      overflow-y: hidden;
      scrollbar-width: none;
      -webkit-overflow-scrolling: touch;
      z-index: 40;
    }
    .tab-strip-container::-webkit-scrollbar {
      display: none;
    }
    .terminal-tab-pill {
      flex-shrink: 0;
      display: flex;
      align-items: center;
      gap: 6px;
      background: rgba(255, 255, 255, 0.04);
      border: 1px solid var(--border);
      border-radius: 7px;
      padding: 5px 10px;
      font-size: 12px;
      font-weight: 500;
      color: var(--text-muted);
      cursor: pointer;
      transition: all 0.15s;
      max-width: 170px;
    }
    .terminal-tab-pill.active {
      background: linear-gradient(180deg, #15253d 0%, #0c1729 100%);
      border-color: var(--border-accent);
      color: #fff;
      font-weight: 700;
      box-shadow: 0 0 12px rgba(56, 189, 248, 0.25);
    }
    .terminal-tab-pill .tab-title {
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      pointer-events: none;
    }
    .terminal-tab-pill .tab-beacon {
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: var(--accent);
      opacity: 0;
      transition: opacity 0.2s;
    }
    .terminal-tab-pill.active .tab-beacon {
      opacity: 1;
      box-shadow: 0 0 6px var(--accent);
    }
    .terminal-tab-pill .tab-close-btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 16px;
      height: 16px;
      border-radius: 50%;
      color: #94a3b8;
      font-size: 11px;
      line-height: 1;
      margin-left: 2px;
      opacity: 0.6;
    }
    .terminal-tab-pill .tab-close-btn:active {
      background: var(--danger-bg);
      color: #fca5a5;
      opacity: 1;
    }
    .btn-new-tab {
      flex-shrink: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 4px;
      background: rgba(56, 189, 248, 0.08);
      border: 1px dashed rgba(56, 189, 248, 0.4);
      color: var(--accent);
      border-radius: 7px;
      padding: 5px 9px;
      font-size: 12px;
      font-weight: 600;
      cursor: pointer;
      white-space: nowrap;
    }
    .btn-new-tab:active {
      background: rgba(56, 189, 248, 0.2);
    }

    /* TERMINAL CONSOLE VIEWPORT */
    .terminal-container {
      flex: 1;
      position: relative;
      background: #020610;
      overflow: hidden;
      display: flex;
      flex-direction: column;
    }
    .terminal-screen {
      flex: 1;
      overflow-y: auto;
      overflow-x: auto;
      padding: 10px 12px;
      font-family: 'Cascadia Mono', 'JetBrains Mono', 'Fira Code', Consolas, monospace;
      font-size: 12px;
      line-height: 1.45;
      color: #dbe7f5;
      white-space: pre-wrap;
      word-break: break-all;
      user-select: text;
      -webkit-user-select: text;
      -webkit-overflow-scrolling: touch;
    }
    .terminal-screen::-webkit-scrollbar {
      width: 4px;
      height: 4px;
    }
    .terminal-screen::-webkit-scrollbar-thumb {
      background: rgba(255, 255, 255, 0.15);
      border-radius: 2px;
    }

    /* SCROLL TO BOTTOM BUTTON */
    .btn-scroll-bottom {
      position: absolute;
      right: 14px;
      bottom: 12px;
      background: rgba(15, 23, 42, 0.9);
      border: 1px solid var(--accent);
      color: var(--accent);
      border-radius: 20px;
      padding: 6px 12px;
      font-size: 11px;
      font-weight: 600;
      display: none;
      align-items: center;
      gap: 5px;
      box-shadow: 0 4px 15px rgba(0, 0, 0, 0.5), 0 0 10px var(--accent-glow);
      z-index: 20;
      cursor: pointer;
    }
    .btn-scroll-bottom.visible {
      display: flex;
    }

    /* ACCESSORY KEYPAD BAR */
    .accessory-bar {
      flex-shrink: 0;
      background: #080f1d;
      border-top: 1px solid var(--border);
      display: flex;
      align-items: center;
      padding: 5px 8px;
      gap: 5px;
      overflow-x: auto;
      scrollbar-width: none;
      -webkit-overflow-scrolling: touch;
      z-index: 30;
    }
    .accessory-bar::-webkit-scrollbar {
      display: none;
    }
    .key-btn {
      flex-shrink: 0;
      background: #111a2e;
      border: 1px solid #1f2d47;
      color: #e2e8f0;
      border-radius: 6px;
      padding: 6px 10px;
      font-family: 'Cascadia Mono', Consolas, monospace;
      font-size: 12px;
      font-weight: 600;
      cursor: pointer;
      transition: all 0.1s;
    }
    .key-btn:active {
      background: var(--accent);
      color: #030712;
      transform: scale(0.95);
    }
    .key-btn.key-danger {
      color: #f87171;
      border-color: rgba(239, 68, 68, 0.35);
    }
    .key-btn.key-danger:active {
      background: #ef4444;
      color: #fff;
    }
    .key-btn.key-accent {
      color: var(--accent);
      border-color: rgba(56, 189, 248, 0.35);
    }
    .key-btn.key-accent:active {
      background: var(--accent);
      color: #000;
    }

    /* QUICK COMMAND CHIPS */
    .quick-chips-bar {
      flex-shrink: 0;
      background: #060b16;
      border-top: 1px solid rgba(255, 255, 255, 0.05);
      display: flex;
      align-items: center;
      padding: 4px 8px;
      gap: 5px;
      overflow-x: auto;
      scrollbar-width: none;
      -webkit-overflow-scrolling: touch;
    }
    .quick-chips-bar::-webkit-scrollbar {
      display: none;
    }
    .chip-btn {
      flex-shrink: 0;
      background: rgba(255, 255, 255, 0.04);
      border: 1px solid rgba(255, 255, 255, 0.08);
      color: #94a3b8;
      border-radius: 12px;
      padding: 3px 8px;
      font-size: 11px;
      font-family: monospace;
      cursor: pointer;
    }
    .chip-btn:active {
      background: rgba(56, 189, 248, 0.15);
      color: var(--accent);
      border-color: var(--accent);
    }

    /* BOTTOM INTERACTIVE INPUT BAR */
    .terminal-input-bar {
      flex-shrink: 0;
      background: rgba(8, 15, 29, 0.98);
      backdrop-filter: blur(12px);
      -webkit-backdrop-filter: blur(12px);
      border-top: 1px solid var(--border);
      padding: 8px 10px calc(8px + var(--safe-bottom));
      display: flex;
      flex-direction: column;
      gap: 6px;
      z-index: 60;
    }
    .input-row {
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .mode-toggle-btn {
      flex-shrink: 0;
      display: flex;
      align-items: center;
      gap: 4px;
      background: #111a2e;
      border: 1px solid var(--border);
      color: var(--text-muted);
      border-radius: 8px;
      padding: 6px 9px;
      font-size: 11px;
      font-weight: 700;
      cursor: pointer;
    }
    .mode-toggle-btn.ai-mode {
      background: var(--purple-bg);
      border-color: rgba(192, 132, 252, 0.5);
      color: var(--purple);
    }
    .input-box {
      flex: 1;
      background: var(--bg-input);
      border: 1.5px solid var(--border);
      border-radius: 8px;
      padding: 8px 12px;
      color: #fff;
      font-family: 'Cascadia Mono', Consolas, monospace;
      font-size: 13px;
      outline: none;
      transition: border-color 0.15s;
      user-select: text;
      -webkit-user-select: text;
    }
    .input-box:focus {
      border-color: var(--accent);
      box-shadow: 0 0 10px var(--accent-glow);
    }
    .input-box.ai-mode:focus {
      border-color: var(--purple);
      box-shadow: 0 0 10px rgba(192, 132, 252, 0.35);
    }
    .btn-send {
      flex-shrink: 0;
      background: linear-gradient(135deg, #0284c7, #38bdf8);
      border: none;
      color: #fff;
      border-radius: 8px;
      padding: 8px 14px;
      font-size: 13px;
      font-weight: 700;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      box-shadow: 0 2px 10px var(--accent-glow);
    }
    .btn-send:active {
      transform: scale(0.95);
      opacity: 0.9;
    }
    .btn-send.ai-mode {
      background: linear-gradient(135deg, #9333ea, #c084fc);
      box-shadow: 0 2px 10px rgba(192, 132, 252, 0.4);
    }

    /* MODAL DIALOG */
    .modal-overlay {
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      background: rgba(0, 0, 0, 0.7);
      backdrop-filter: blur(6px);
      display: none;
      align-items: center;
      justify-content: center;
      padding: 20px;
      z-index: 200;
    }
    .modal-overlay.open {
      display: flex;
    }
    .modal-card {
      background: var(--bg-card);
      border: 1px solid var(--border-accent);
      border-radius: 12px;
      width: 100%;
      max-width: 320px;
      padding: 16px;
      display: flex;
      flex-direction: column;
      gap: 12px;
      box-shadow: 0 20px 40px rgba(0, 0, 0, 0.6);
    }
    .modal-title {
      font-size: 14px;
      font-weight: 700;
      color: #fff;
    }
    .modal-input {
      background: var(--bg-input);
      border: 1px solid var(--border);
      border-radius: 7px;
      padding: 8px 10px;
      color: #fff;
      font-size: 13px;
      outline: none;
    }
    .modal-actions {
      display: flex;
      justify-content: flex-end;
      gap: 8px;
    }
    .modal-btn {
      padding: 6px 12px;
      border-radius: 6px;
      font-size: 12px;
      font-weight: 600;
      cursor: pointer;
      border: none;
    }
    .modal-btn-cancel {
      background: rgba(255, 255, 255, 0.1);
      color: #cbd5e1;
    }
    .modal-btn-primary {
      background: var(--accent);
      color: #000;
    }
  </style>
</head>
<body>

  <!-- HEADER -->
  <header>
    <div class="brand-box">
      <span class="logo-badge">ANTIFAN</span>
      <span class="brand-title">Terminal</span>
    </div>
    <div class="header-actions">
      <div id="statusPill" class="status-pill">
        <span class="status-dot"></span>
        <span id="statusText">Connected</span>
      </div>
      <button class="icon-btn" onclick="clearTerminalScreen()" title="Xóa màn hình">
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round">
          <path d="M2 4h12M5 4V2h6v2M6 7v5M10 7v5M3 4l1 10h8l1-10"/>
        </svg>
      </button>
      <button class="icon-btn" onclick="restartActiveShell()" title="Khởi động lại Shell">
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round">
          <path d="M1 8a7 7 0 1 1 2.05 4.95M1 12V8h4"/>
        </svg>
      </button>
    </div>
  </header>

  <!-- MULTI-SESSION TAB STRIP -->
  <div class="tab-strip-container" id="termSessionsStrip">
    <!-- Dynamic Terminal Tab Pills rendered here -->
    <button class="btn-new-tab" onclick="createNewTerminalTab()">+ New Tab</button>
  </div>

  <!-- TERMINAL CONSOLE VIEWPORT -->
  <main class="terminal-container" id="view-terminal">
    <div class="terminal-screen" id="terminalScreen"></div>
    <button class="btn-scroll-bottom" id="btnScrollBottom" onclick="scrollToTerminalBottom()">
      <span>⬇ Cuộn xuống đáy</span>
    </button>
  </main>

  <!-- ACCESSORY KEYPAD BAR -->
  <div class="accessory-bar" id="virtual-keypad">
    <button class="key-btn key-danger" onclick="sendKey('ctrl_c')">Ctrl+C</button>
    <button class="key-btn" onclick="sendKey('tab')">Tab</button>
    <button class="key-btn" onclick="sendKey('escape')">Esc</button>
    <button class="key-btn key-accent" onclick="sendKey('arrow_up')">↑</button>
    <button class="key-btn key-accent" onclick="sendKey('arrow_down')">↓</button>
    <button class="key-btn" onclick="insertSymbol('~')">~</button>
    <button class="key-btn" onclick="insertSymbol('/')">/</button>
    <button class="key-btn" onclick="insertSymbol('|')">|</button>
    <button class="key-btn" onclick="insertSymbol('-')">-</button>
    <button class="key-btn" onclick="insertSymbol('&')">&</button>
    <button class="key-btn" onclick="insertSymbol('\\\\')">\\</button>
    <button class="key-btn" onclick="sendKey('ctrl_d')">Ctrl+D</button>
    <button class="key-btn" onclick="sendKey('clear')">Clear</button>
  </div>

  <!-- QUICK COMMAND CHIPS -->
  <div class="quick-chips-bar">
    <button class="chip-btn" onclick="sendDirectCommand('/clear')">/clear</button>
    <button class="chip-btn" onclick="sendDirectCommand('git status')">git status</button>
    <button class="chip-btn" onclick="sendDirectCommand('git diff')">git diff</button>
    <button class="chip-btn" onclick="sendDirectCommand('npm run dev')">npm run dev</button>
    <button class="chip-btn" onclick="sendDirectCommand('cls')">cls</button>
    <button class="chip-btn" onclick="sendDirectCommand('tasklist')">tasklist</button>
  </div>

  <!-- BOTTOM INPUT BAR -->
  <footer class="terminal-input-bar">
    <form id="terminalForm" onsubmit="handleFormSubmit(event)" class="input-row">
      <button type="button" id="btnModeToggle" class="mode-toggle-btn" onclick="toggleInputMode()">
        <span id="modeIcon">⚡</span>
        <span id="modeLabel">Shell</span>
      </button>
      <input type="text" id="terminalInput" class="input-box" placeholder="Nhập lệnh shell hoặc prompt..." autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false">
      <button type="submit" id="btnSend" class="btn-send">
        <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M14 2L7 9M14 2L9 14l-2-5-5-2 12-5z"/>
        </svg>
      </button>
    </form>
  </footer>

  <!-- RENAME TAB MODAL -->
  <div class="modal-overlay" id="renameModal">
    <div class="modal-card">
      <div class="modal-title">Đổi tên Tab Terminal</div>
      <input type="text" id="renameInput" class="modal-input" placeholder="Tên terminal mới...">
      <div class="modal-actions">
        <button class="modal-btn modal-btn-cancel" onclick="closeRenameModal()">Hủy</button>
        <button class="modal-btn modal-btn-primary" onclick="submitRenameTab()">Lưu</button>
      </div>
    </div>
  </div>

  <script>
    const BRIDGE_TOKEN = ${JSON.stringify(token)};
    const BRIDGE_PORT = ${port};
    let ws = null;
    let reconnectTimer = null;
    let reqId = 1;
    const pendingRequests = new Map();

    // Terminal State
    let terminalSessions = [];
    let activeTerminalId = '';
    const sessionBuffers = new Map();
    let isAiMode = false;
    let userScrolledUp = false;
    let renamingSessionId = '';

    // ANSI Decoder Colors
    const ANSI_COLORS = {
      '30': '#1e293b', '31': '#f87171', '32': '#4ade80', '33': '#facc15',
      '34': '#60a5fa', '35': '#c084fc', '36': '#38bdf8', '37': '#f1f5f9',
      '90': '#64748b', '91': '#ef4444', '92': '#22c55e', '93': '#eab308',
      '94': '#3b82f6', '95': '#a855f7', '96': '#06b6d4', '97': '#ffffff'
    };

    function ansiToHtml(str) {
      if (!str) return '';
      // 1. Strip OSC sequences (window title, hyperlinks, iTerm extensions)
      let clean = str.replace(/\\x1b\\][^\\x07\\x1b]*(\\x07|\\x1b\\\\)/g, '');
      // 2. Strip VT100/ANSI non-SGR sequences: cursor control (\\x1b[K, \\x1b[2K, \\x1b[?25h, \\x1b[H, \\x1b[1A, etc.)
      clean = clean.replace(/\\x1b\\[[0-9;?]*[A-LN-Za-ln-z~]/g, '');
      // 3. Strip other isolated ESC sequences (\\x1b(B, \\x1b=, etc.)
      clean = clean.replace(/\\x1b[()#%*+\\-./][A-Za-z0-9]/g, '');
      clean = clean.replace(/\\x1b[=>cDENMOH]/g, '');
      // 4. Strip stray non-printable control characters except newline, carriage return, tab
      clean = clean.replace(/[\\x00-\\x08\\x0b\\x0c\\x0e-\\x1a\\x1c-\\x1f\\x7f]/g, '');

      // 5. Parse SGR color and formatting codes (\\x1b[...m)
      const parts = clean.split(/(\\x1b\\[[0-9;]*m)/g);
      let html = '';
      let curColor = '';
      let isBold = false;
      let isUnderline = false;
      let isDim = false;

      for (const part of parts) {
        if (part.startsWith('\\x1b[')) {
          const codes = part.slice(2, -1).split(';');
          for (let i = 0; i < codes.length; i++) {
            const code = codes[i] || '0';
            if (code === '0') {
              curColor = '';
              isBold = false;
              isUnderline = false;
              isDim = false;
            } else if (code === '1') {
              isBold = true;
            } else if (code === '2') {
              isDim = true;
            } else if (code === '4') {
              isUnderline = true;
            } else if (code === '22') {
              isBold = false;
              isDim = false;
            } else if (code === '24') {
              isUnderline = false;
            } else if (code === '39') {
              curColor = '';
            } else if (code === '38' && codes[i + 1] === '5' && codes[i + 2]) {
              const cIdx = parseInt(codes[i + 2], 10);
              if (ANSI_COLORS[String(cIdx)]) {
                curColor = ANSI_COLORS[String(cIdx)];
              }
              i += 2;
            } else if (code === '38' && codes[i + 1] === '2' && codes[i + 2] && codes[i + 3] && codes[i + 4]) {
              curColor = 'rgb(' + codes[i + 2] + ',' + codes[i + 3] + ',' + codes[i + 4] + ')';
              i += 4;
            } else if (ANSI_COLORS[code]) {
              curColor = ANSI_COLORS[code];
            }
          }
        } else {
          const escaped = part
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
          if (curColor || isBold || isUnderline || isDim) {
            let styles = '';
            if (curColor) styles += 'color:' + curColor + ';';
            if (isBold) styles += 'font-weight:bold;';
            if (isUnderline) styles += 'text-decoration:underline;';
            if (isDim) styles += 'opacity:0.75;';
            html += '<span style="' + styles + '">' + escaped + '</span>';
          } else {
            html += escaped;
          }
        }
      }
      return html;
    }
    function initWebSocket() {
      const host = window.location.hostname || '127.0.0.1';
      const wsUrl = 'ws://' + host + ':' + BRIDGE_PORT + '/?token=' + encodeURIComponent(BRIDGE_TOKEN);

      updateStatus(false, 'Connecting...');
      try {
        ws = new WebSocket(wsUrl);
      } catch (err) {
        scheduleReconnect();
        return;
      }

      ws.onopen = () => {
        updateStatus(true, 'Live');
        clearTimeout(reconnectTimer);
        // Refresh terminal sessions
        sendRpc('antifan.getTerminalSessions', {}).then(res => {
          if (res && Array.isArray(res.sessions)) {
            terminalSessions = res.sessions;
            activeTerminalId = res.activeSessionId || (terminalSessions[0] && terminalSessions[0].id) || '';
            terminalSessions.forEach(s => {
              if (s.buffer) sessionBuffers.set(s.id, s.buffer);
            });
            renderTabs();
            renderActiveTerminal();
          }
        }).catch(() => {});
      };

      ws.onmessage = (evt) => {
        try {
          const msg = JSON.parse(evt.data);
          if (msg.id && pendingRequests.has(msg.id)) {
            const { resolve, reject } = pendingRequests.get(msg.id);
            pendingRequests.delete(msg.id);
            if (msg.success) resolve(msg.data);
            else reject(new Error(msg.error || 'RPC Error'));
            return;
          }

          if (msg.type === 'antifan:init') {
            const data = msg.data || {};
            if (Array.isArray(data.terminalSessions)) {
              terminalSessions = data.terminalSessions;
              activeTerminalId = data.activeTerminalSessionId || (terminalSessions[0] && terminalSessions[0].id) || '';
              terminalSessions.forEach(s => {
                if (s.buffer) sessionBuffers.set(s.id, s.buffer);
              });
              renderTabs();
              renderActiveTerminal();
            }
          } else if (msg.type === 'antifan:terminal:session') {
            const data = msg.data || {};
            if (Array.isArray(data.sessions)) {
              terminalSessions = data.sessions;
              if (data.activeSessionId) activeTerminalId = data.activeSessionId;
              if (typeof data.snapshot === 'string' && activeTerminalId) {
                sessionBuffers.set(activeTerminalId, data.snapshot);
              }
              renderTabs();
              renderActiveTerminal();
            }
          } else if (msg.type === 'antifan:terminal:data') {
            const d = msg.data || {};
            const sid = d.sessionId || activeTerminalId;
            const text = d.data || '';
            const existing = sessionBuffers.get(sid) || '';
            sessionBuffers.set(sid, (existing + text).slice(-1000000));
            if (sid === activeTerminalId) {
              appendTerminalData(text);
            }
          }
        } catch (e) {}
      };

      ws.onclose = () => {
        updateStatus(false, 'Disconnected');
        scheduleReconnect();
      };

      ws.onerror = () => {
        updateStatus(false, 'Offline');
      };
    }

    function scheduleReconnect() {
      clearTimeout(reconnectTimer);
      reconnectTimer = setTimeout(initWebSocket, 2000);
    }

    function updateStatus(online, text) {
      const pill = document.getElementById('statusPill');
      const st = document.getElementById('statusText');
      if (pill) pill.className = 'status-pill' + (online ? '' : ' disconnected');
      if (st) st.textContent = text;
    }

    function sendRpc(method, params) {
      return new Promise((resolve, reject) => {
        if (!ws || ws.readyState !== WebSocket.OPEN) {
          return reject(new Error('WebSocket not connected'));
        }
        const id = 'req_' + (reqId++);
        pendingRequests.set(id, { resolve, reject });
        ws.send(JSON.stringify({ id, method, params }));
        setTimeout(() => {
          if (pendingRequests.has(id)) {
            pendingRequests.delete(id);
            reject(new Error('RPC Timeout'));
          }
        }, 8000);
      });
    }

    function renderTabs() {
      const strip = document.getElementById('termSessionsStrip');
      if (!strip) return;
      strip.innerHTML = '';

      terminalSessions.forEach((s) => {
        const pill = document.createElement('div');
        const isActive = s.id === activeTerminalId;
        pill.className = 'terminal-tab-pill' + (isActive ? ' active' : '');
        pill.title = s.name || s.id;

        const beacon = document.createElement('span');
        beacon.className = 'tab-beacon';

        const title = document.createElement('span');
        title.className = 'tab-title';
        title.textContent = s.name || s.id;

        const closeBtn = document.createElement('span');
        closeBtn.className = 'tab-close-btn';
        closeBtn.innerHTML = '✕';
        closeBtn.title = 'Đóng tab';
        closeBtn.onclick = (e) => {
          e.stopPropagation();
          closeTerminalTab(s.id);
        };

        pill.append(beacon, title, closeBtn);

        pill.onclick = () => {
          if (s.id !== activeTerminalId) {
            switchTerminalTab(s.id);
          }
        };

        // Long press to rename
        let pressTimer = null;
        pill.ontouchstart = () => {
          pressTimer = setTimeout(() => {
            openRenameModal(s.id, s.name || s.id);
          }, 600);
        };
        pill.ontouchend = () => clearTimeout(pressTimer);
        pill.ontouchcancel = () => clearTimeout(pressTimer);

        strip.appendChild(pill);
      });

      const newBtn = document.createElement('button');
      newBtn.className = 'btn-new-tab';
      newBtn.textContent = '+ New Tab';
      newBtn.onclick = createNewTerminalTab;
      strip.appendChild(newBtn);
    }

    function switchTerminalTab(id) {
      activeTerminalId = id;
      renderTabs();
      renderActiveTerminal();
      sendRpc('antifan.terminalSwitchSession', { sessionId: id }).catch(() => {});
    }

    function createNewTerminalTab() {
      sendRpc('antifan.terminalNewSession', {}).then(res => {
        if (res && res.sessionId) {
          activeTerminalId = res.sessionId;
          if (Array.isArray(res.sessions)) terminalSessions = res.sessions;
          renderTabs();
          renderActiveTerminal();
        }
      }).catch(err => alert('Không thể tạo tab: ' + err.message));
    }

    function closeTerminalTab(id) {
      if (terminalSessions.length <= 1) {
        if (!confirm('Đóng tab terminal này?')) return;
      }
      sendRpc('antifan.terminalCloseSession', { sessionId: id }).then(res => {
        if (res && Array.isArray(res.sessions)) {
          terminalSessions = res.sessions;
          activeTerminalId = res.activeSessionId || (terminalSessions[0] && terminalSessions[0].id) || '';
          renderTabs();
          renderActiveTerminal();
        }
      }).catch(() => {});
    }

    function openRenameModal(id, currentName) {
      renamingSessionId = id;
      const input = document.getElementById('renameInput');
      if (input) input.value = currentName || '';
      const modal = document.getElementById('renameModal');
      if (modal) modal.classList.add('open');
      setTimeout(() => input && input.focus(), 100);
    }

    function closeRenameModal() {
      const modal = document.getElementById('renameModal');
      if (modal) modal.classList.remove('open');
      renamingSessionId = '';
    }

    function submitRenameTab() {
      const input = document.getElementById('renameInput');
      const newName = (input?.value || '').trim();
      if (!newName || !renamingSessionId) return closeRenameModal();

      sendRpc('antifan.terminalRenameSession', { id: renamingSessionId, name: newName }).then(res => {
        if (res && Array.isArray(res.sessions)) {
          terminalSessions = res.sessions;
          renderTabs();
        }
        closeRenameModal();
      }).catch(() => closeRenameModal());
    }

    function renderActiveTerminal() {
      const screen = document.getElementById('terminalScreen');
      if (!screen) return;
      const buf = sessionBuffers.get(activeTerminalId) || '';
      screen.innerHTML = ansiToHtml(buf);
      if (!userScrolledUp) {
        scrollToTerminalBottom();
      }
    }

    function appendTerminalData(text) {
      const screen = document.getElementById('terminalScreen');
      if (!screen) return;
      screen.insertAdjacentHTML('beforeend', ansiToHtml(text));
      if (!userScrolledUp) {
        scrollToTerminalBottom();
      }
    }

    function scrollToTerminalBottom() {
      const screen = document.getElementById('terminalScreen');
      if (!screen) return;
      screen.scrollTop = screen.scrollHeight;
      userScrolledUp = false;
      document.getElementById('btnScrollBottom')?.classList.remove('visible');
    }

    const screenEl = document.getElementById('terminalScreen');
    if (screenEl) {
      screenEl.addEventListener('scroll', () => {
        const distFromBottom = screenEl.scrollHeight - screenEl.scrollTop - screenEl.clientHeight;
        userScrolledUp = distFromBottom > 40;
        const btn = document.getElementById('btnScrollBottom');
        if (btn) {
          if (userScrolledUp) btn.classList.add('visible');
          else btn.classList.remove('visible');
        }
      }, { passive: true });
    }

    function clearTerminalScreen() {
      sessionBuffers.set(activeTerminalId, '');
      const screen = document.getElementById('terminalScreen');
      if (screen) screen.innerHTML = '';
      sendRpc('antifan.terminalSendKey', { key: 'clear', sessionId: activeTerminalId }).catch(() => {});
    }

    function restartActiveShell() {
      if (!confirm('Khởi động lại Shell session này?')) return;
      sendRpc('antifan.terminalRestart', {}).then(() => {
        clearTerminalScreen();
      }).catch(() => {});
    }

    function sendKey(key) {
      sendRpc('antifan.terminalSendKey', { key, sessionId: activeTerminalId }).catch(() => {});
    }

    function insertSymbol(sym) {
      const input = document.getElementById('terminalInput');
      if (input) {
        input.value += sym;
        input.focus();
      }
    }

    function sendDirectCommand(cmd) {
      if (!cmd) return;
      sendRpc('antifan.terminalInput', { text: cmd + '\\r\\n', sessionId: activeTerminalId }).catch(() => {});
    }

    function toggleInputMode() {
      isAiMode = !isAiMode;
      const btn = document.getElementById('btnModeToggle');
      const icon = document.getElementById('modeIcon');
      const label = document.getElementById('modeLabel');
      const input = document.getElementById('terminalInput');
      const sendBtn = document.getElementById('btnSend');

      if (isAiMode) {
        btn?.classList.add('ai-mode');
        input?.classList.add('ai-mode');
        sendBtn?.classList.add('ai-mode');
        if (icon) icon.textContent = '💬';
        if (label) label.textContent = 'AI';
        if (input) input.placeholder = 'Gửi prompt cho AI Agent...';
      } else {
        btn?.classList.remove('ai-mode');
        input?.classList.remove('ai-mode');
        sendBtn?.classList.remove('ai-mode');
        if (icon) icon.textContent = '⚡';
        if (label) label.textContent = 'Shell';
        if (input) input.placeholder = 'Nhập lệnh shell...';
      }
    }

    function handleFormSubmit(e) {
      e.preventDefault();
      const input = document.getElementById('terminalInput');
      const text = (input?.value || '').trim();
      if (!text) return;

      if (isAiMode) {
        // Send as AI Prompt
        sendRpc('antifan.terminalInput', { text: text + '\\r\\n', sessionId: activeTerminalId }).catch(() => {});
      } else {
        // Send as direct shell command
        sendRpc('antifan.terminalInput', { text: text + '\\r\\n', sessionId: activeTerminalId }).catch(() => {});
      }

      if (input) input.value = '';
    }

    // Initialize on load
    window.addEventListener('DOMContentLoaded', initWebSocket);
  </script>
</body>
</html>`;
}
