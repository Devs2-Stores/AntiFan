const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('antifanTestHelper', {
  emitData: (sessionId, data, seq) => ipcRenderer.invoke('antifan:test:emit-data', { sessionId, data, seq }),
  addAuthoritativeSession: (session) => ipcRenderer.invoke('antifan:test:add-authoritative-session', session),
  finish: (payload) => ipcRenderer.invoke('antifan:test:finish', payload),
});
