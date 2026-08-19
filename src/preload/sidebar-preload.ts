/**
 * AntiFan Browser Desktop — Sidebar Preload Script
 * Sandboxed bridge exposing Chat APIs and events to the Sidebar WebContentsView.
 */
import { contextBridge, ipcRenderer } from 'electron';

const SIDEBAR_CHANNELS = {
  GET_INITIAL_STATE: 'antifan:sidebar:get-initial-state',
  SEND_PROMPT: 'antifan:sidebar:send-prompt',
  STREAM_UPDATE: 'antifan:sidebar:stream-update',
  CLEAR_HISTORY: 'antifan:sidebar:clear-history',
  ATTACH_ELEMENT: 'antifan:sidebar:attach-element',
  CLOSE_SIDEBAR: 'antifan:sidebar:close-sidebar',
  SET_WIDTH: 'antifan:sidebar:set-width',
  GET_SESSIONS: 'antifan:sidebar:get-sessions',
  SWITCH_SESSION: 'antifan:sidebar:switch-session',
  RENAME_SESSION: 'antifan:sidebar:rename-session',
  DELETE_SESSION: 'antifan:sidebar:delete-session',
  SESSION_CHANGED: 'antifan:sidebar:session-changed',
};

const sidebarApi = {
  getInitialState: () => ipcRenderer.invoke(SIDEBAR_CHANNELS.GET_INITIAL_STATE),
  sendPrompt: (text: string, attachedElement?: any, attachedImages?: any, deliveryMode?: 'auto' | 'draft') =>
    ipcRenderer.invoke(SIDEBAR_CHANNELS.SEND_PROMPT, { text, attachedElement, attachedImages, deliveryMode }),
  clearHistory: () => ipcRenderer.invoke(SIDEBAR_CHANNELS.CLEAR_HISTORY),
  closeSidebar: () => ipcRenderer.invoke(SIDEBAR_CHANNELS.CLOSE_SIDEBAR),
  setWidth: (width: number) => ipcRenderer.invoke(SIDEBAR_CHANNELS.SET_WIDTH, width),
  getSessions: () => ipcRenderer.invoke(SIDEBAR_CHANNELS.GET_SESSIONS),
  switchSession: (sessionId: string) => ipcRenderer.invoke(SIDEBAR_CHANNELS.SWITCH_SESSION, sessionId),
  renameSession: (sessionId: string, newTitle: string) => ipcRenderer.invoke(SIDEBAR_CHANNELS.RENAME_SESSION, { sessionId, newTitle }),
  deleteSession: (sessionId: string) => ipcRenderer.invoke(SIDEBAR_CHANNELS.DELETE_SESSION, sessionId),

  onStreamUpdate: (callback: (data: any) => void) => {
    const handler = (_event: unknown, data: any) => callback(data);
    ipcRenderer.on(SIDEBAR_CHANNELS.STREAM_UPDATE, handler);
    return () => {
      ipcRenderer.removeListener(SIDEBAR_CHANNELS.STREAM_UPDATE, handler);
    };
  },

  onSessionChanged: (callback: (data: any) => void) => {
    const handler = (_event: unknown, data: any) => callback(data);
    ipcRenderer.on(SIDEBAR_CHANNELS.SESSION_CHANGED, handler);
    return () => {
      ipcRenderer.removeListener(SIDEBAR_CHANNELS.SESSION_CHANGED, handler);
    };
  },

  onAttachElement: (callback: (element: any) => void) => {
    const handler = (_event: unknown, element: any) => callback(element);
    ipcRenderer.on(SIDEBAR_CHANNELS.ATTACH_ELEMENT, handler);
    return () => {
      ipcRenderer.removeListener(SIDEBAR_CHANNELS.ATTACH_ELEMENT, handler);
    };
  },
};

try {
  contextBridge.exposeInMainWorld('antifanSidebar', sidebarApi);
} catch (err) {
  console.error('[antifan sidebar preload] Failed to expose antifanSidebar:', err);
}

export type AntiFanSidebarApi = typeof sidebarApi;
