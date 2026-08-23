import { contextBridge, ipcRenderer } from 'electron';
const api = {
  openWorkspace: () => ipcRenderer.invoke('antifan:standalone:open-workspace'),
  getInitialState: () => ipcRenderer.invoke('antifan:sidebar:get-initial-state'),
  startTerminal: (cwd?: string) => ipcRenderer.invoke('antifan:terminal:start', cwd),
  sendTerminalInput: (input: string) => ipcRenderer.invoke('antifan:terminal:input', input),
  sendTerminalInputTo: (id: string, input: string) => ipcRenderer.invoke('antifan:terminal:input-session', { id, input }),
  restartTerminal: (cwd?: string) => ipcRenderer.invoke('antifan:terminal:restart', cwd),
  killTerminal: () => ipcRenderer.invoke('antifan:terminal:kill'),
  resizeTerminal: (cols: number, rows: number) => ipcRenderer.invoke('antifan:terminal:resize', { cols, rows }),
  resizeTerminalTo: (id: string, cols: number, rows: number) => ipcRenderer.invoke('antifan:terminal:resize-session', { id, cols, rows }),
  newTerminal: (cwd?: string) => ipcRenderer.invoke('antifan:terminal:new-session', cwd),
  splitTerminal: (parentId: string, cwd?: string) => ipcRenderer.invoke('antifan:terminal:split-session', { parentId, cwd }),
  listTerminals: () => ipcRenderer.invoke('antifan:terminal:list-sessions'),
  switchTerminal: (id: string) => ipcRenderer.invoke('antifan:terminal:switch-session', id),
  renameTerminal: (id: string, name: string) => ipcRenderer.invoke('antifan:terminal:rename-session', { id, name }),
  closeTerminal: (id: string) => ipcRenderer.invoke('antifan:terminal:close-session', id),
  switchChatMode: (mode: 'legacy' | 'standalone') => ipcRenderer.invoke('antifan:toolbar:switch-chat-mode', mode),
  togglePanel: () => ipcRenderer.invoke('antifan:toolbar:toggle-sidebar'),
  setPanelWidth: (width: number) => ipcRenderer.invoke('antifan:sidebar:set-width', width),
  onTerminalData: (cb: (data: { sessionId: string; data: string }) => void) => { const h = (_e: unknown, d: { sessionId: string; data: string }) => cb(d); ipcRenderer.on('antifan:terminal:data', h); return () => ipcRenderer.removeListener('antifan:terminal:data', h); },
  onTerminalSession: (cb: (state: unknown) => void) => { const h = (_e: unknown, d: unknown) => cb(d); ipcRenderer.on('antifan:terminal:session', h); return () => ipcRenderer.removeListener('antifan:terminal:session', h); },
};
contextBridge.exposeInMainWorld('antifanStandalone', api);
