import { contextBridge, ipcRenderer, clipboard } from 'electron';
const api = {
  copyToClipboard: (text: string) => clipboard.writeText(text),
  readFromClipboard: () => clipboard.readText(),
  pasteImageFromClipboard: () => ipcRenderer.invoke('antifan:terminal:paste-image'),
  savePastedImageBuffer: (dataUrlOrBase64: string) => ipcRenderer.invoke('antifan:terminal:save-pasted-image', dataUrlOrBase64),
  openWorkspace: (sessionId?: string) => ipcRenderer.invoke('antifan:standalone:open-workspace', { sessionId }),
  getInitialState: () => ipcRenderer.invoke('antifan:sidebar:get-initial-state'),
  startTerminal: (cwd?: string) => ipcRenderer.invoke('antifan:terminal:start', cwd),
  sendTerminalInput: (input: string) => ipcRenderer.invoke('antifan:terminal:input', input),
  sendTerminalInputTo: (id: string, input: string) => ipcRenderer.invoke('antifan:terminal:input-session', { id, input }),
  restartTerminal: (cwd?: string) => ipcRenderer.invoke('antifan:terminal:restart', cwd),
  killTerminal: () => ipcRenderer.invoke('antifan:terminal:kill'),
  resizeTerminal: (cols: number, rows: number) => ipcRenderer.invoke('antifan:terminal:resize', { cols, rows }),
  resizeTerminalTo: (id: string, cols: number, rows: number) => ipcRenderer.invoke('antifan:terminal:resize-session', { id, cols, rows }),
  newTerminal: (cwd?: string) => ipcRenderer.invoke('antifan:terminal:new-session', cwd),
  splitTerminal: (parentId: string, options?: string | { cwd?: string; cols?: number; rows?: number }) => {
    const payload = typeof options === 'string' ? { parentId, cwd: options } : { parentId, ...(options || {}) };
    return ipcRenderer.invoke('antifan:terminal:split-session', payload);
  },
  unsplitTerminal: (parentId: string) => ipcRenderer.invoke('antifan:terminal:unsplit-session', parentId),
  listTerminals: () => ipcRenderer.invoke('antifan:terminal:list-sessions'),
  switchTerminal: (id: string) => ipcRenderer.invoke('antifan:terminal:switch-session', id),
  renameTerminal: (id: string, name: string) => ipcRenderer.invoke('antifan:terminal:rename-session', { id, name }),
  reorderTerminals: (orderIds: string[]) => ipcRenderer.invoke('antifan:terminal:reorder-sessions', orderIds),
  closeTerminal: (id: string) => ipcRenderer.invoke('antifan:terminal:close-session', id),
  listCapsules: () => ipcRenderer.invoke('antifan:capsule:list'),
  pickWorkspaceFolder: (sessionId?: string) => ipcRenderer.invoke('antifan:capsule:pick-folder', { sessionId }),
  createCapsule: (name: string, workspacePath: string) => ipcRenderer.invoke('antifan:capsule:create', { name, workspacePath }),
  switchCapsule: (id: string, sessionId?: string) => ipcRenderer.invoke('antifan:capsule:switch', { capsuleId: id, sessionId }),
  togglePanel: () => ipcRenderer.invoke('antifan:toolbar:toggle-sidebar'),
  setPanelWidth: (width: number) => ipcRenderer.invoke('antifan:sidebar:set-width', width),
  setTerminalHeight: (height: number, finish: boolean = false) => ipcRenderer.invoke('antifan:terminal:set-height', { height, finish }),
  popoutTerminal: () => ipcRenderer.invoke('antifan:terminal:popout'),
  openNewTerminalWindow: (sessionId?: string) => ipcRenderer.invoke('antifan:terminal:new-window', { sessionId }),
  closeTerminalWindow: () => ipcRenderer.invoke('antifan:terminal:close-window'),
  setActiveTerminalSession: (sessionId: string, splitSessionId?: string) => ipcRenderer.invoke('antifan:terminal:set-active-session', { sessionId, splitSessionId }),
  redockTerminal: () => ipcRenderer.invoke('antifan:terminal:redock'),
  isTerminalPopout: () => ipcRenderer.invoke('antifan:terminal:get-popout-state'),
  toggleFullScreen: () => ipcRenderer.invoke('antifan:window:toggle-fullscreen'),
  createTab: (url?: string) => ipcRenderer.invoke('antifan:toolbar:create-tab', url),
  openExternal: (url?: string) => ipcRenderer.invoke('antifan:toolbar:open-external', url),
  onTerminalPopoutChanged: (cb: (isPopout: boolean) => void) => {
    const h = (_e: unknown, v: boolean) => cb(v);
    ipcRenderer.on('antifan:terminal:popout-state-changed', h);
    return () => ipcRenderer.removeListener('antifan:terminal:popout-state-changed', h);
  },
  getFullBuffer: (sessionId?: string) => ipcRenderer.invoke('antifan:terminal:get-full-buffer', sessionId),
  onTerminalData: (cb: (data: { sessionId: string; data: string; seq: number }) => void) => { const h = (_e: unknown, d: { sessionId: string; data: string; seq: number }) => cb(d); ipcRenderer.on('antifan:terminal:data', h); return () => ipcRenderer.removeListener('antifan:terminal:data', h); },
  onTerminalSession: (cb: (state: unknown) => void) => { const h = (_e: unknown, d: unknown) => cb(d); ipcRenderer.on('antifan:terminal:session', h); return () => ipcRenderer.removeListener('antifan:terminal:session', h); },
};
contextBridge.exposeInMainWorld('antifanStandalone', api);
