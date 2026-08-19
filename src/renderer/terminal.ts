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
const btnTabClose = document.getElementById('btnTabClose') as HTMLButtonElement | null;
const btnTabNew = document.getElementById('btnTabNew') as HTMLButtonElement | null;

let commandHistory: string[] = [];
let historyIndex = -1;

function formatAnsi(data: string): string {
  return data
    .replace(/\u001b\[31m/g, '<span style="color:#f87171">')
    .replace(/\u001b\[32m/g, '<span style="color:#4ade80">')
    .replace(/\u001b\[33m/g, '<span style="color:#facc15">')
    .replace(/\u001b\[34m/g, '<span style="color:#60a5fa">')
    .replace(/\u001b\[35m/g, '<span style="color:#c084fc">')
    .replace(/\u001b\[36m/g, '<span style="color:#38bdf8">')
    .replace(/\u001b\[90m/g, '<span style="color:#94a3b8">')
    .replace(/\u001b\[0m/g, '</span>')
    .replace(/\u001b\[[0-9;]*m/g, '')
    .replace(/\u001b\[\?25[hl]/g, '');
}

function appendTerminalData(data: string) {
  if (!terminalOutput) return;

  // Check if output contains standard PS prompt
  const psMatch = data.match(/PS\s+([A-Za-z]:\\[^>]*>)/);
  if (psMatch && promptPrefix) {
    promptPrefix.textContent = `PS ${psMatch[1]}`;
  }

  const formatted = formatAnsi(data);
  const span = document.createElement('span');
  span.innerHTML = formatted;
  terminalOutput.appendChild(span);

  if (terminalBody) {
    terminalBody.scrollTop = terminalBody.scrollHeight;
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
      if (terminalOutput) terminalOutput.innerHTML = '';
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
          commandHistory.push(val);
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
        if (historyIndex > 0) {
          historyIndex--;
          terminalCmdInput.value = commandHistory[historyIndex] || '';
        }
      } else if (e.key === 'ArrowDown') {
        if (historyIndex < commandHistory.length - 1) {
          historyIndex++;
          terminalCmdInput.value = commandHistory[historyIndex] || '';
        } else {
          historyIndex = commandHistory.length;
          terminalCmdInput.value = '';
        }
      }
    });
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initTerminal);
} else {
  initTerminal();
}
