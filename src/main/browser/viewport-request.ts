import { DEVICE_PRESETS } from './device-presets';

const DEFAULT_SPLIT_DESKTOP_PRESET_ID = 'laptop-macbook13';

/** Width disagreement (CSS px) between the stored request and the live layout that counts as a mismatch. */
export const VIEWPORT_MISMATCH_TOLERANCE_PX = 2;

export interface ViewportRequestSource {
  devicePresetId?: string;
  customViewport?: { width: number; height: number } | null;
  splitMode?: boolean;
  splitDesktopPresetId?: string;
}

/**
 * CSS width the host asked the tab's desktop pane to lay out at, or null when no emulation is requested
 * (fluid responsive tab). Mirrors the preset-before-custom-size order `applyTabDeviceEmulation` uses, so
 * the answer is the width the override actually carries.
 */
export function requestedViewportWidth(tab: ViewportRequestSource | null | undefined): number | null {
  if (!tab) return null;
  if (tab.splitMode === true) {
    const id = tab.splitDesktopPresetId || DEFAULT_SPLIT_DESKTOP_PRESET_ID;
    const preset = DEVICE_PRESETS.find((p) => p.id === id);
    return preset?.width && preset.width > 0 ? Math.round(preset.width) : null;
  }
  const presetId = tab.devicePresetId;
  const preset = presetId ? DEVICE_PRESETS.find((p) => p.id === presetId) : undefined;
  if (preset?.width && preset.width > 0) return Math.round(preset.width);
  const custom = tab.customViewport;
  if (custom && custom.width > 0 && custom.height > 0) return Math.round(custom.width);
  if (presetId && /^(?:custom-)?\d+x\d+$/.test(presetId)) {
    const [w, h] = presetId.replace(/^custom-/, '').split('x').map(Number);
    if (w && h && w > 0 && h > 0) return w;
  }
  return null;
}

export function viewportWidthMismatch(requestedWidth: number | null, observedWidth: number): boolean {
  return requestedWidth !== null && observedWidth > 0 && Math.abs(requestedWidth - observedWidth) > VIEWPORT_MISMATCH_TOLERANCE_PX;
}
