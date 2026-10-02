import { contextBridge, ipcRenderer } from 'electron';
import { PET_CHANNELS, type PetAction, type PetStatePush } from '../shared/contracts';

/**
 * Session pet surface. The window is chromeless, so every gesture travels as a
 * named action and every repaint arrives as a pushed state snapshot; nothing
 * here reaches the page, the filesystem, or another window.
 */
const api = {
  onState(callback: (state: PetStatePush) => void): void {
    ipcRenderer.on(PET_CHANNELS.STATE, (_event, state: PetStatePush) => callback(state));
  },
  action(action: PetAction, payload?: { pinned?: boolean }): void {
    ipcRenderer.send(PET_CHANNELS.ACTION, { action, ...(payload ?? {}) });
  },
};

contextBridge.exposeInMainWorld('antifanPet', api);
