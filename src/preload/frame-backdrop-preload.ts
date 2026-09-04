/**
 * AntiFan Browser Desktop — Frame Backdrop Preload Script
 * Secure context-isolated IPC bridge for the device mockup backdrop view.
 */
import { contextBridge, ipcRenderer } from 'electron';
import { FRAME_BACKDROP_CHANNELS, SplitPaneId } from '../shared/contracts';

export interface FrameBackdropUpdatePayload {
  splitMode: boolean;
  focusedPane: SplitPaneId;
  desktopFrame?: {
    frameX: number;
    frameY: number;
    frameWidth: number;
    frameHeight: number;
    screenX: number;
    screenY: number;
    screenWidth: number;
    screenHeight: number;
    bezelTop: number;
    bezelSide: number;
    bezelBottom: number;
    baseHeight?: number;
    baseSide?: number;
    deviceType: string;
    deviceName: string;
    presetId: string;
    scale: number;
    badgeX: number;
    badgeY: number;
  };
  mobileFrame?: {
    frameX: number;
    frameY: number;
    frameWidth: number;
    frameHeight: number;
    screenX: number;
    screenY: number;
    screenWidth: number;
    screenHeight: number;
    bezelTop: number;
    bezelSide: number;
    bezelBottom: number;
    deviceType: string;
    deviceName: string;
    presetId: string;
    scale: number;
    badgeX: number;
    badgeY: number;
  };
  containerWidth: number;
  containerHeight: number;
}

export interface AntiFanFrameBackdropApi {
  onUpdateLayout: (callback: (payload: FrameBackdropUpdatePayload) => void) => () => void;
  focusPane: (paneId: SplitPaneId) => void;
  notifyReady: () => void;
  reloadPane: (paneId: SplitPaneId) => void;
}

const api: AntiFanFrameBackdropApi = {
  onUpdateLayout: (callback) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: FrameBackdropUpdatePayload) => {
      try {
        callback(payload);
      } catch (err) {
        console.error('[frame-backdrop-preload] onUpdateLayout error:', err);
      }
    };
    ipcRenderer.on(FRAME_BACKDROP_CHANNELS.UPDATE_LAYOUT, handler);
    return () => {
      ipcRenderer.removeListener(FRAME_BACKDROP_CHANNELS.UPDATE_LAYOUT, handler);
    };
  },
  focusPane: (paneId: SplitPaneId) => {
    ipcRenderer.send(FRAME_BACKDROP_CHANNELS.FOCUS_PANE, paneId);
  },
  notifyReady: () => {
    ipcRenderer.send(FRAME_BACKDROP_CHANNELS.READY);
  },
  reloadPane: (paneId: SplitPaneId) => {
    ipcRenderer.send(FRAME_BACKDROP_CHANNELS.RELOAD_PANE, paneId);
  },
};

declare global {
  interface Window {
    antifanFrameBackdropApi?: AntiFanFrameBackdropApi;
  }
}

try {
  contextBridge.exposeInMainWorld('antifanFrameBackdropApi', api);
} catch {
  window.antifanFrameBackdropApi = api;
}
