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
  closeTerminal: () => ipcRenderer.invoke(TOOLBAR_CHANNELS.TOGGLE_TERMINAL),
  onTerminalData: (callback: (data: string) => void) => {
    const handler = (_event: unknown, data: string) => callback(data);
    ipcRenderer.on(TERMINAL_CHANNELS.DATA, handler);
    return () => {
      ipcRenderer.removeListener(TERMINAL_CHANNELS.DATA, handler);
    };
  },
};

contextBridge.exposeInMainWorld('antifanTerminal', terminalApi);
