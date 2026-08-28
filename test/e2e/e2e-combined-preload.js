const { contextBridge, ipcRenderer, clipboard } = require('electron');

const api = {
  copyToClipboard: (text) => clipboard.writeText(text),
  readFromClipboard: () => clipboard.readText(),
  pasteImageFromClipboard: () => ipcRenderer.invoke('antifan:terminal:paste-image'),
  savePastedImageBuffer: (dataUrlOrBase64) => ipcRenderer.invoke('antifan:terminal:save-pasted-image', dataUrlOrBase64),
  openWorkspace: (sessionId) => ipcRenderer.invoke('antifan:standalone:open-workspace', { sessionId }),
  getInitialState: () => ipcRenderer.invoke('antifan:sidebar:get-initial-state'),
  startTerminal: (cwd) => ipcRenderer.invoke('antifan:terminal:start', cwd),
  sendTerminalInput: (input) => ipcRenderer.invoke('antifan:terminal:input', input),
  sendTerminalInputTo: (id, input) => ipcRenderer.invoke('antifan:terminal:input-session', { id, input }),
  restartTerminal: (cwd) => ipcRenderer.invoke('antifan:terminal:restart', cwd),
  killTerminal: () => ipcRenderer.invoke('antifan:terminal:kill'),
  resizeTerminal: (cols, rows) => ipcRenderer.invoke('antifan:terminal:resize', { cols, rows }),
  resizeTerminalSession: (id, cols, rows) => ipcRenderer.invoke('antifan:terminal:resize-session', { id, cols, rows }),
  resizeTerminalTo: (id, cols, rows) => ipcRenderer.invoke('antifan:terminal:resize-session', { id, cols, rows }),
  listSessions: () => ipcRenderer.invoke('antifan:terminal:list-sessions'),
  switchTerminal: (id) => ipcRenderer.invoke('antifan:terminal:switch-session', id),
  setActiveSession: (sessionId) => ipcRenderer.invoke('antifan:terminal:set-active-session', { sessionId }),
  newTerminal: () => ipcRenderer.invoke('antifan:terminal:new-session'),
  renameTerminal: (id, name) => typeof id === 'string' && name === undefined ? ipcRenderer.invoke('antifan:terminal:rename-session', id) : ipcRenderer.invoke('antifan:terminal:rename-session', { id, name }),
  renameTerminalSession: (id, name) => ipcRenderer.invoke('antifan:terminal:rename-session', { id, name }),
  closeTerminal: (id) => ipcRenderer.invoke('antifan:terminal:close-session', id),
  deleteTerminal: (id) => ipcRenderer.invoke('antifan:terminal:delete-session', id),
  splitTerminal: (parentId, options) => {
    const payload = typeof options === 'string' ? { parentId, cwd: options } : { parentId, ...(options || {}) };
    return ipcRenderer.invoke('antifan:terminal:split-session', payload);
  },
  unsplitTerminal: (parentId) => ipcRenderer.invoke('antifan:terminal:unsplit-session', parentId),
  setSplitRatio: (id, ratio) => ipcRenderer.invoke('antifan:terminal:set-split-ratio', { id, ratio }),
  closeSplit: (id) => ipcRenderer.invoke('antifan:terminal:close-split', { id }),
  togglePopout: () => ipcRenderer.invoke('antifan:terminal:popout'),
  isPopout: () => {
    try {
      const sp = new URLSearchParams(window.location.search);
      return sp.get('mode') === 'popout';
    } catch {
      return false;
    }
  },
  onPopoutStateChanged: (cb) => {
    const h = (_e, v) => cb(v);
    ipcRenderer.on('antifan:terminal:popout-state-changed', h);
    return () => ipcRenderer.removeListener('antifan:terminal:popout-state-changed', h);
  },
  onTerminalData: (cb) => {
    const h = (_e, d) => cb(d);
    ipcRenderer.on('antifan:terminal:data', h);
    return () => ipcRenderer.removeListener('antifan:terminal:data', h);
  },
  onTerminalSession: (cb) => {
    const h = (_e, d) => cb(d);
    ipcRenderer.on('antifan:terminal:session', h);
    return () => ipcRenderer.removeListener('antifan:terminal:session', h);
  },
};

contextBridge.exposeInMainWorld('antifanStandalone', api);
contextBridge.exposeInMainWorld('antifanTestHelper', {
  emitData: (sessionId, data) => ipcRenderer.invoke('antifan:test:emit-data', { sessionId, data }),
  addAuthoritativeSession: (session) => ipcRenderer.invoke('antifan:test:add-authoritative-session', session),
  getSplitData: () => ipcRenderer.invoke('antifan:test:get-split-data'),
  finish: (payload) => ipcRenderer.invoke('antifan:test:finish', payload),
});
