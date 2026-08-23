/**
 * AntiFan Browser Desktop — Windows Terminal (PowerShell) Controller
 * Authentic Windows Terminal UI & Interactive PowerShell Console.
 */

interface AntiFanTerminalApi {
  startTerminal: (cwd?: string) => Promise<boolean>;
  sendTerminalInput: (input: string) => Promise<boolean>;
  killTerminal: () => Promise<boolean>;
  restartTerminal: (cwd?: string) => Promise<boolean>;
  closeTerminal: () => Promise<boolean>;
  popOut?: () => Promise<boolean>;
  reDock?: () => Promise<boolean>;
  isPopout?: () => boolean;
  setTerminalHeight?: (height: number, finish?: boolean) => Promise<number>;
  pasteImageFromClipboard?: () => Promise<{ ok: boolean; imagePath: string | null }>;
  savePastedImageBuffer?: (data: string) => Promise<{ ok: boolean; imagePath: string | null }>;
  onPopoutStateChanged?: (callback: (isPopout: boolean) => void) => () => void;
  onTerminalData: (callback: (data: string) => void) => () => void;
}

declare global {
  interface Window {
    antifanTerminal?: AntiFanTerminalApi;
  }
}

function getApi(): AntiFanTerminalApi | undefined {
  return window.antifanTerminal;
}

const terminalBody = document.getElementById('terminalBody') as HTMLDivElement | null;
const terminalOutput = document.getElementById('terminalOutput') as HTMLDivElement | null;
const promptPrefix = document.getElementById('promptPrefix') as HTMLSpanElement | null;
const terminalCmdInput = document.getElementById('terminalCmdInput') as HTMLInputElement | null;
const btnTerminalRestart = document.getElementById('btnTerminalRestart') as HTMLButtonElement | null;
const btnTerminalKill = document.getElementById('btnTerminalKill') as HTMLButtonElement | null;
const btnTerminalClear = document.getElementById('btnTerminalClear') as HTMLButtonElement | null;
const btnTerminalClose = document.getElementById('btnTerminalClose') as HTMLButtonElement | null;
const btnTerminalPopout = document.getElementById('btnTerminalPopout') as HTMLButtonElement | null;
const btnTabClose = document.getElementById('btnTabClose') as HTMLButtonElement | null;
const btnTabNew = document.getElementById('btnTabNew') as HTMLButtonElement | null;

let commandHistory: string[] = [];
let historyIndex = -1;

const COLOR_MAP: Record<string, string> = {
  '31': '#f87171',
  '32': '#4ade80',
  '33': '#facc15',
  '34': '#60a5fa',
  '35': '#c084fc',
  '36': '#38bdf8',
  '90': '#94a3b8',
};

function renderAnsiToNode(data: string): DocumentFragment {
  const fragment = document.createDocumentFragment();
  const ansiRegex = /\u001b\[([0-9;]*)m|\u001b\[\?25[hl]/g;
  let currentColor: string | null = null;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = ansiRegex.exec(data)) !== null) {
    if (match.index > lastIndex) {
      const textChunk = data.slice(lastIndex, match.index);
      if (currentColor) {
        const span = document.createElement('span');
        span.style.color = currentColor;
        span.textContent = textChunk;
        fragment.appendChild(span);
      } else {
        fragment.appendChild(document.createTextNode(textChunk));
      }
    }

    const code = match[1];
    if (code === '0' || code === '') {
      currentColor = null;
    } else if (code && COLOR_MAP[code]) {
      currentColor = COLOR_MAP[code];
    }
    lastIndex = ansiRegex.lastIndex;
  }

  if (lastIndex < data.length) {
    const textChunk = data.slice(lastIndex);
    if (currentColor) {
      const span = document.createElement('span');
      span.style.color = currentColor;
      span.textContent = textChunk;
      fragment.appendChild(span);
    } else {
      fragment.appendChild(document.createTextNode(textChunk));
    }
  }

  return fragment;
}
let wtActivityTimer: any = null;
const wtTabEl = document.querySelector('.wt-tab') as HTMLElement | null;
const wtTabIconEl = document.querySelector('.wt-tab-icon') as HTMLElement | null;
const origTabIconHtml = wtTabIconEl ? wtTabIconEl.innerHTML : '';

function notifyWtActivity(data: string) {
  if (!wtTabEl) return;
  const isAiIndicator = data && (
    /Claude|Codex|OpenCode|DeepSeek|Gemini|Qwen|Kimi|ChatGPT|Thinking\.\.\.|Streaming\.\.\.|⠋|⠙|⠹|⠸|⠼|⠴|⠦|⠧|⠇|⠏|\[in_progress\]|\[task\]|Agent|Evaluating|Generating/i.test(data)
  );

  wtTabEl.classList.add('is-streaming');
  if (wtTabIconEl) {
    if (isAiIndicator) {
      wtTabIconEl.innerHTML = `<span style="color:#c084fc;font-weight:bold;font-size:12px;filter:drop-shadow(0 0 4px #c084fc);" title="⚡ AI đang xử lý...">⚡</span>`;
    } else {
      wtTabIconEl.innerHTML = `<span class="wt-tab-spinner" title="Đang thực thi..."></span>`;
    }
  }

  clearTimeout(wtActivityTimer);
  wtActivityTimer = setTimeout(() => {
    wtTabEl.classList.remove('is-streaming');
    if (wtTabIconEl) {
      wtTabIconEl.innerHTML = origTabIconHtml;
    }
  }, 1200);
}
let wtPendingBuffer: string[] = [];
let wtRafId: number | null = null;

function flushWtBuffer() {
  if (!terminalOutput || wtPendingBuffer.length === 0) {
    wtRafId = null;
    return;
  }
  const combined = wtPendingBuffer.join('');
  wtPendingBuffer = [];
  wtRafId = null;

  notifyWtActivity(combined);

  const psMatch = combined.match(/PS\s+([A-Za-z]:\\[^>]*>)/);
  if (psMatch && promptPrefix) {
    promptPrefix.textContent = `PS ${psMatch[1]}`;
  }

  const nodes = renderAnsiToNode(combined);
  terminalOutput.appendChild(nodes);

  while (terminalOutput.childNodes.length > 2000) {
    terminalOutput.removeChild(terminalOutput.firstChild!);
  }

  if (terminalBody) {
    terminalBody.scrollTop = terminalBody.scrollHeight;
  }
}

function appendTerminalData(data: string) {
  if (!terminalOutput) return;
  wtPendingBuffer.push(data);
  if (!wtRafId) {
    wtRafId = requestAnimationFrame(flushWtBuffer);
  }
}

function initTerminal() {
  const api = getApi();
  if (!api) return;

  api.startTerminal();

  api.onTerminalData((data) => {
    appendTerminalData(data);
  });

  if (terminalBody) {
    terminalBody.addEventListener('click', () => {
      terminalCmdInput?.focus();
    });
  }

  if (btnTerminalRestart) {
    btnTerminalRestart.addEventListener('click', (e) => {
      e.stopPropagation();
      if (terminalOutput) terminalOutput.textContent = '';
      api.restartTerminal();
      setTimeout(() => terminalCmdInput?.focus(), 50);
    });
  }

  if (btnTerminalKill) {
    btnTerminalKill.addEventListener('click', (e) => {
      e.stopPropagation();
      api.sendTerminalInput('\x03');
      setTimeout(() => terminalCmdInput?.focus(), 50);
    });
  }

  if (btnTerminalClear) {
    btnTerminalClear.addEventListener('click', (e) => {
      e.stopPropagation();
      if (terminalOutput) terminalOutput.innerHTML = '';
      setTimeout(() => terminalCmdInput?.focus(), 50);
    });
  }

  if (btnTerminalClose) {
    btnTerminalClose.addEventListener('click', (e) => {
      e.stopPropagation();
      api.closeTerminal();
    });
  }
  if (btnTerminalPopout) {
    const isPopoutMode = api.isPopout ? api.isPopout() : false;
    if (isPopoutMode) {
      btnTerminalPopout.textContent = '📥';
      btnTerminalPopout.title = 'Re-dock into Main Window';
    } else {
      btnTerminalPopout.textContent = '⧉';
      btnTerminalPopout.title = 'Pop out into separate window';
    }

    btnTerminalPopout.addEventListener('click', (e) => {
      e.stopPropagation();
      const inPopout = api.isPopout ? api.isPopout() : false;
      if (inPopout) {
        api.reDock?.();
      } else {
        api.popOut?.();
      }
    });
  }

  if (btnTabClose) {
    btnTabClose.addEventListener('click', (e) => {
      e.stopPropagation();
      api.closeTerminal();
    });
  }

  const btnTabDropdown = document.getElementById('btnTabDropdown') as HTMLButtonElement | null;
  const shellDropdownMenu = document.getElementById('shellDropdownMenu') as HTMLDivElement | null;

  if (btnTabNew) {
    btnTabNew.addEventListener('click', (e) => {
      e.stopPropagation();
      if (terminalOutput) terminalOutput.innerHTML = '';
      api.restartTerminal();
      setTimeout(() => terminalCmdInput?.focus(), 50);
    });
  }

  if (btnTabDropdown && shellDropdownMenu) {
    btnTabDropdown.addEventListener('click', (e) => {
      e.stopPropagation();
      const isShown = shellDropdownMenu.style.display === 'block';
      shellDropdownMenu.style.display = isShown ? 'none' : 'block';
    });

    document.addEventListener('click', (e) => {
      if (!shellDropdownMenu.contains(e.target as Node) && e.target !== btnTabDropdown) {
        shellDropdownMenu.style.display = 'none';
      }
    });

    shellDropdownMenu.querySelectorAll('.wt-shell-item').forEach((item) => {
      item.addEventListener('click', (e) => {
        e.stopPropagation();
        shellDropdownMenu.style.display = 'none';
        const shell = (item as HTMLElement).getAttribute('data-shell');
        if (shell === 'clear') {
          if (terminalOutput) terminalOutput.innerHTML = '';
        } else if (shell === 'restart' || shell === 'powershell') {
          if (terminalOutput) terminalOutput.innerHTML = '';
          api.restartTerminal();
        } else if (shell === 'cmd') {
          api.sendTerminalInput('cmd.exe\r\n');
        } else if (shell === 'bash') {
          api.sendTerminalInput('bash\r\n');
        }
        setTimeout(() => terminalCmdInput?.focus(), 50);
      });
    });
  }

  document.querySelectorAll('.wt-chip-btn').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const cmd = (btn as HTMLElement).getAttribute('data-cmd');
      if (cmd) {
        if (cmd === 'cls') {
          if (terminalOutput) terminalOutput.innerHTML = '';
        } else {
          api.sendTerminalInput(cmd + '\r\n');
        }
        setTimeout(() => terminalCmdInput?.focus(), 30);
      }
    });
  });

  if (terminalCmdInput) {
    terminalCmdInput.focus();
    terminalCmdInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        const val = terminalCmdInput.value;
        if (val.trim()) {
          if (commandHistory.length === 0 || commandHistory[commandHistory.length - 1] !== val) {
            commandHistory.push(val);
          }
          historyIndex = commandHistory.length;
        }
        if (val.trim() === 'cls' || val.trim() === 'clear') {
          if (terminalOutput) terminalOutput.innerHTML = '';
        } else {
          api.sendTerminalInput(val + '\r\n');
        }
        terminalCmdInput.value = '';
      } else if (e.key === 'c' && e.ctrlKey) {
        api.sendTerminalInput('\x03');
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        if (commandHistory.length > 0) {
          if (historyIndex === -1 || historyIndex >= commandHistory.length) {
            historyIndex = commandHistory.length - 1;
          } else if (historyIndex > 0) {
            historyIndex--;
          }
          terminalCmdInput.value = commandHistory[historyIndex] || '';
          setTimeout(() => {
            terminalCmdInput.selectionStart = terminalCmdInput.selectionEnd = terminalCmdInput.value.length;
          }, 0);
        }
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        if (commandHistory.length > 0) {
          if (historyIndex >= 0 && historyIndex < commandHistory.length - 1) {
            historyIndex++;
            terminalCmdInput.value = commandHistory[historyIndex] || '';
          } else {
            historyIndex = commandHistory.length;
            terminalCmdInput.value = '';
          }
          setTimeout(() => {
            terminalCmdInput.selectionStart = terminalCmdInput.selectionEnd = terminalCmdInput.value.length;
          }, 0);
        }
      }
    });
    terminalCmdInput.addEventListener('paste', async (e) => {
      const items = e.clipboardData?.items;
      if (items) {
        for (let i = 0; i < items.length; i++) {
          const item = items[i];
          if (item && item.type && item.type.startsWith('image/')) {
            e.preventDefault();
            const res = await api.pasteImageFromClipboard?.();
            if (res && res.ok && res.imagePath) {
              const start = terminalCmdInput.selectionStart || 0;
              const end = terminalCmdInput.selectionEnd || 0;
              const val = terminalCmdInput.value;
              terminalCmdInput.value = val.slice(0, start) + res.imagePath + val.slice(end);
              terminalCmdInput.selectionStart = terminalCmdInput.selectionEnd = start + res.imagePath.length;
            }
            return;
          }
        }
      }
    });
  }
  const resizeHandle = document.getElementById('terminalTopResizeHandle');
  if (resizeHandle) {
    let isResizing = false;
    let startScreenY = 0;
    let startHeight = 0;
    let rafId: number | null = null;
    let pendingHeight = 0;

    resizeHandle.addEventListener('pointerdown', (e: PointerEvent) => {
      isResizing = true;
      startScreenY = e.screenY;
      startHeight = window.innerHeight;
      resizeHandle.classList.add('active');
      try {
        resizeHandle.setPointerCapture(e.pointerId);
      } catch {}
      document.body.style.cursor = 'row-resize';
    });

    resizeHandle.addEventListener('pointermove', (e: PointerEvent) => {
      if (!isResizing) return;
      const deltaY = e.screenY - startScreenY;
      pendingHeight = Math.max(100, Math.min(window.screen.height - 150, startHeight - deltaY));
      if (!rafId) {
        rafId = requestAnimationFrame(() => {
          if (api.setTerminalHeight) {
            api.setTerminalHeight(pendingHeight, false);
          }
          rafId = null;
        });
      }
    });

    const stopResize = (e: PointerEvent) => {
      if (isResizing) {
        isResizing = false;
        try {
          resizeHandle.releasePointerCapture(e.pointerId);
        } catch {}
        resizeHandle.classList.remove('active');
        document.body.style.cursor = '';
        if (rafId) {
          cancelAnimationFrame(rafId);
          rafId = null;
        }
        if (pendingHeight && api.setTerminalHeight) {
          api.setTerminalHeight(pendingHeight, true);
        }
      }
    };

    resizeHandle.addEventListener('pointerup', stopResize);
    resizeHandle.addEventListener('pointercancel', stopResize);
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initTerminal);
} else {
  initTerminal();
}
