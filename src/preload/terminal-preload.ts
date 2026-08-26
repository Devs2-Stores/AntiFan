/**
 * AntiFan Browser Desktop — Terminal Preload Script
 */
import { contextBridge, ipcRenderer } from 'electron';
import { TERMINAL_CHANNELS, TOOLBAR_CHANNELS } from '../shared/contracts';

const terminalApi = {
  startTerminal: (cwd?: string) => ipcRenderer.invoke(TERMINAL_CHANNELS.START, cwd),
  sendTerminalInput: (input: string) => ipcRenderer.invoke(TERMINAL_CHANNELS.INPUT, input),
  killTerminal: () => ipcRenderer.invoke(TERMINAL_CHANNELS.KILL),
  restartTerminal: (cwd?: string) => ipcRenderer.invoke(TERMINAL_CHANNELS.RESTART, cwd),
  openInVSCode: (cwd?: string) => ipcRenderer.invoke(TERMINAL_CHANNELS.OPEN_IN_VSCODE, cwd),
  pasteImageFromClipboard: () => ipcRenderer.invoke('antifan:terminal:paste-image'),
  savePastedImageBuffer: (dataUrlOrBase64: string) => ipcRenderer.invoke('antifan:terminal:save-pasted-image', dataUrlOrBase64),
  closeTerminal: () => ipcRenderer.invoke(TOOLBAR_CHANNELS.TOGGLE_TERMINAL),
  popOut: () => ipcRenderer.invoke(TERMINAL_CHANNELS.POPOUT),
  reDock: () => ipcRenderer.invoke(TERMINAL_CHANNELS.REDOCK),
  setTerminalHeight: (height: number, finish: boolean = false) => ipcRenderer.invoke('antifan:terminal:set-height', { height, finish }),
  isPopout: () => new URLSearchParams(window.location.search).get('mode') === 'popout',
  onPopoutStateChanged: (callback: (isPopout: boolean) => void) => {
    const handler = (_event: unknown, isPopout: boolean) => callback(isPopout);
    ipcRenderer.on(TERMINAL_CHANNELS.POPOUT_STATE_CHANGED, handler);
    return () => {
      ipcRenderer.removeListener(TERMINAL_CHANNELS.POPOUT_STATE_CHANGED, handler);
    };
  },
  onTerminalData: (callback: (data: string) => void) => {
    const handler = (_event: unknown, data: string) => callback(data);
    ipcRenderer.on(TERMINAL_CHANNELS.DATA, handler);
    return () => {
      ipcRenderer.removeListener(TERMINAL_CHANNELS.DATA, handler);
    };
  },
};

contextBridge.exposeInMainWorld('antifanTerminal', terminalApi);
