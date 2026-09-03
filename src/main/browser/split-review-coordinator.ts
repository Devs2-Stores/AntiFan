/**
 * AntiFan Browser Desktop — Split Review Coordinator & Geometry Engine
 * Pure helpers for dual Desktop + Mobile WebContentsView layout, loop-guarded navigation sync,
 * and persistence migration.
 */

import { AntiFanTab, SplitPaneId, SplitReviewConfig } from '../../shared/contracts';
import { DEVICE_PRESETS, DevicePreset, getPresetCornerRadius } from './device-presets';

export const DEFAULT_SPLIT_DESKTOP_PRESET = 'laptop-macbook13';
export const DEFAULT_SPLIT_MOBILE_PRESET = 'phone-iphone15pro';

export const SPLIT_FRAME_BEZELS = {
  laptop: {
    bezelTop: 16, // MacBook Top Display Bezel with Notch
    bezelSide: 8,
    bezelBottom: 14, // MacBook Bottom Chin with Logo
    baseHeight: 12, // MacBook Unibody Aluminum Base Deck
    baseSide: 12,
  },
  phone: {
    bezelTop: 56, // Realistic iOS Status Bar + Safari URL Header
    bezelSide: 0, // Full-width edge-to-edge smartphone screen flush with bezels
    bezelBottom: 46, // Realistic Safari Action Toolbar + Home Indicator
  },
} as const;

export interface DeviceFrameBounds {
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
  deviceType: 'laptop' | 'phone' | 'tablet' | 'desktop';
  deviceName: string;
  presetId: string;
  scale: number;
  badgeX: number;
  badgeY: number;
  cornerRadius?: number;
}

export interface SplitPaneBounds {
  x: number;
  y: number;
  width: number;
  height: number;
  scale: number;
  renderedWidth: number;
  renderedHeight: number;
  emulatedWidth: number;
  emulatedHeight: number;
  deviceScaleFactor: number;
  isMobile: boolean;
  frame?: DeviceFrameBounds;
}

export interface SplitLayoutResult {
  desktop: SplitPaneBounds;
  mobile: SplitPaneBounds;
  desktopFrame: DeviceFrameBounds;
  mobileFrame: DeviceFrameBounds;
  gap: number;
  containerWidth: number;
  containerHeight: number;
  totalGroupWidth: number;
  totalGroupHeight: number;
  startX: number;
}
export interface SplitContainerBounds {
  width: number;
  height: number;
  yOffset: number;
}

export interface SplitNavigationTransaction {
  id: string;
  tabId: string;
  authorityPane: SplitPaneId;
  targetUrl: string;
  startedAt: number;
  state: 'started' | 'authority-committed' | 'mirror-started' | 'settled' | 'failed';
  historyDirection?: 'back' | 'forward' | null;
  historyCommittedPanes?: SplitPaneId[];
  error?: string | null;
}

export interface NavigationEventDecision {
  shouldMirror: boolean;
  mirrorUrl?: string;
  targetPane?: SplitPaneId;
  isEcho: boolean;
  settled: boolean;
  historyDirection?: 'back' | 'forward' | null;
  error?: string | null;
}

/**
 * Normalizes and compares two URLs for equivalence (ignoring trivial trailing slashes, case on origin, etc.).
 */
export function areUrlsEquivalent(urlA: string | undefined | null, urlB: string | undefined | null): boolean {
  if (!urlA || !urlB) return urlA === urlB;
  const cleanA = urlA.trim();
  const cleanB = urlB.trim();
  if (cleanA === cleanB) return true;

  try {
    const parsedA = new URL(cleanA);
    const parsedB = new URL(cleanB);

    // Compare origin + pathname (ignoring trailing slash) + search + hash
    const pathA = parsedA.pathname.replace(/\/+$/, '') || '/';
    const pathB = parsedB.pathname.replace(/\/+$/, '') || '/';

    return (
      parsedA.protocol.toLowerCase() === parsedB.protocol.toLowerCase() &&
      parsedA.host.toLowerCase() === parsedB.host.toLowerCase() &&
      pathA === pathB &&
      parsedA.search === parsedB.search &&
      parsedA.hash === parsedB.hash
    );
  } catch {
    // Non-standard URLs (e.g. view-source:, about:blank)
    const normA = cleanA.replace(/\/+$/, '');
    const normB = cleanB.replace(/\/+$/, '');
    return normA.toLowerCase() === normB.toLowerCase();
  }
}

const PRESET_MAP = new Map<string, DevicePreset>(DEVICE_PRESETS.map((p) => [p.id, p]));

/**
 * Resolves a DevicePreset from its ID or falls back to standard defaults via O(1) Map lookup.
 */
export function resolvePreset(presetId: string | undefined, defaultId: string): DevicePreset {
  if (presetId) {
    const found = PRESET_MAP.get(presetId);
    if (found && found.width && found.height) {
      return found;
    }
  }
  const fallback = PRESET_MAP.get(defaultId);
  return fallback || { id: defaultId, name: 'Default', category: 'desktop', width: 1280, height: 800 };
}

/**
 * Calculates side-by-side fit-to-view geometry for Desktop and Mobile WebContentsViews.
 * Ensures:
 * 1. CSS emulated viewport width/height match the device presets exactly.
 * 2. Rendered views scale proportionally to fit inside their allocated half-container.
 * 3. Panes are centered within their respective slots.
 */
export function calculateSplitLayout(
  container: SplitContainerBounds,
  desktopPresetId: string = DEFAULT_SPLIT_DESKTOP_PRESET,
  mobilePresetId: string = DEFAULT_SPLIT_MOBILE_PRESET,
  userZoom: number = 1.0,
  gap: number = 32
): SplitLayoutResult {
  const containerW = Math.max(100, container.width);
  const containerH = Math.max(100, container.height);
  const yOffset = Math.max(0, container.yOffset);
  const clampedZoom = Math.max(0.25, Math.min(3.0, userZoom || 1.0));

  const desktopPreset = resolvePreset(desktopPresetId, DEFAULT_SPLIT_DESKTOP_PRESET);
  const mobilePreset = resolvePreset(mobilePresetId, DEFAULT_SPLIT_MOBILE_PRESET);

  const dWidth = desktopPreset.width || 1280;
  const dHeight = desktopPreset.height || 832;
  const mWidth = mobilePreset.width || 393;
  const mHeight = mobilePreset.height || 852;

  // Tight, sleek frame bezels from shared single source of truth
  const laptopBezelTop = SPLIT_FRAME_BEZELS.laptop.bezelTop;
  const laptopBezelSide = SPLIT_FRAME_BEZELS.laptop.bezelSide;
  const laptopBezelBottom = SPLIT_FRAME_BEZELS.laptop.bezelBottom;
  const laptopBaseHeight = SPLIT_FRAME_BEZELS.laptop.baseHeight;
  const laptopBaseSide = SPLIT_FRAME_BEZELS.laptop.baseSide;
  const laptopExtraW = 2 * laptopBezelSide + 2 * laptopBaseSide; // 36px total outer overhead
  const laptopExtraH = laptopBezelTop + laptopBezelBottom + laptopBaseHeight; // 32px total outer overhead

  const phoneBezelTop = SPLIT_FRAME_BEZELS.phone.bezelTop;
  const phoneBezelSide = SPLIT_FRAME_BEZELS.phone.bezelSide;
  const phoneBezelBottom = SPLIT_FRAME_BEZELS.phone.bezelBottom;
  const phoneExtraW = 2 * phoneBezelSide; // 16px total outer overhead
  const phoneExtraH = phoneBezelTop + phoneBezelBottom; // 24px total outer overhead
  const interDeviceGap = Math.max(8, Math.min(20, typeof gap === 'number' && gap > 0 ? gap : 14));
  const padX = Math.max(8, Math.min(20, Math.round(containerW * 0.015)));
  const padTop = Math.max(34, Math.min(48, Math.round(containerH * 0.035)));
  const padBottom = Math.max(10, Math.min(20, Math.round(containerH * 0.015)));
  const availW = Math.max(60, containerW - 2 * padX - interDeviceGap);
  const availH = Math.max(60, containerH - padTop - padBottom);

  // 1. Maximize Viewport Utilization: Compute height-constrained and width-constrained baseline scales
  const maxDesktopScreenH = Math.max(20, availH - laptopExtraH);
  const maxMobileScreenH = Math.max(20, availH - phoneExtraH);
  const rawScaleDH = Math.min(1.0, maxDesktopScreenH / dHeight);
  const rawScaleMH = Math.min(1.0, maxMobileScreenH / mHeight);

  const rawOuterWD = Math.round(dWidth * rawScaleDH) + laptopExtraW;
  const rawOuterWM = Math.round(mWidth * rawScaleMH) + phoneExtraW;
  const rawTotalW = rawOuterWD + rawOuterWM;

  let fitScaleD = rawScaleDH;
  let fitScaleM = rawScaleMH;

  if (rawTotalW > availW) {
    const widthScaleRatio = availW / rawTotalW;
    fitScaleD = Math.max(0.001, rawScaleDH * widthScaleRatio);
    fitScaleM = Math.max(0.001, rawScaleMH * widthScaleRatio);
  }

  // 2. Apply user zoom factor to effective scale
  let effectiveScaleM = Math.max(0.001, fitScaleM * clampedZoom);
  let effectiveScaleD = Math.max(0.001, fitScaleD * clampedZoom);

  let screenWM = Math.round(mWidth * effectiveScaleM);
  let screenHM = Math.round(mHeight * effectiveScaleM);
  let phoneOuterW = screenWM + phoneExtraW;
  let phoneOuterH = screenHM + phoneExtraH;

  let screenWD = Math.round(dWidth * effectiveScaleD);
  let screenHD = Math.round(dHeight * effectiveScaleD);
  let laptopOuterW = screenWD + laptopExtraW;
  let laptopOuterH = screenHD + laptopExtraH;

  let totalGroupW = laptopOuterW + interDeviceGap + phoneOuterW;
  let totalGroupH = Math.max(laptopOuterH, phoneOuterH);

  // 3. Post-zoom 2-axis containment protection (guarantees frames and panes never overflow container)
  const maxAllowedW = Math.max(40, containerW - 2 * padX);
  const maxAllowedH = Math.max(40, containerH - padTop - padBottom);
  if (totalGroupW > maxAllowedW || totalGroupH > maxAllowedH) {
    const shrinkRatio = Math.min(maxAllowedW / totalGroupW, maxAllowedH / totalGroupH);
    effectiveScaleM = Math.max(0.001, effectiveScaleM * shrinkRatio);
    effectiveScaleD = Math.max(0.001, effectiveScaleD * shrinkRatio);
    screenWM = Math.round(mWidth * effectiveScaleM);
    screenHM = Math.round(mHeight * effectiveScaleM);
    phoneOuterW = screenWM + phoneExtraW;
    phoneOuterH = screenHM + phoneExtraH;
    screenWD = Math.round(dWidth * effectiveScaleD);
    screenHD = Math.round(dHeight * effectiveScaleD);
    laptopOuterW = screenWD + laptopExtraW;
    laptopOuterH = screenHD + laptopExtraH;
    totalGroupW = laptopOuterW + interDeviceGap + phoneOuterW;
    totalGroupH = Math.max(laptopOuterH, phoneOuterH);
  }
  // 4. Guaranteed non-negative, centered positioning on both axes
  const groupStartX = Math.max(0, Math.floor((containerW - totalGroupW) / 2));
  const localLaptopFrameY = padTop + Math.max(0, Math.floor((availH - laptopOuterH) / 2));
  const localLaptopScreenY = localLaptopFrameY + laptopBezelTop;

  const laptopFrameX = groupStartX;
  const laptopScreenX = laptopFrameX + laptopBaseSide + laptopBezelSide;

  const phoneFrameX = laptopFrameX + laptopOuterW + interDeviceGap;
  const phoneScreenX = phoneFrameX + phoneBezelSide;
  const localPhoneFrameY = padTop + Math.max(0, Math.floor((availH - phoneOuterH) / 2));
  const localPhoneScreenY = localPhoneFrameY + phoneBezelTop;
  // Local frame bounds sent to frameBackdropView (which starts at window y=toolbarHeight)
  const desktopFrame: DeviceFrameBounds = {
    frameX: laptopFrameX,
    frameY: localLaptopFrameY,
    frameWidth: laptopOuterW,
    frameHeight: laptopOuterH,
    screenX: laptopScreenX,
    screenY: localLaptopScreenY,
    screenWidth: screenWD,
    screenHeight: screenHD,
    bezelTop: laptopBezelTop,
    bezelSide: laptopBezelSide,
    bezelBottom: laptopBezelBottom,
    baseHeight: laptopBaseHeight,
    baseSide: laptopBaseSide,
    deviceType: 'laptop',
    deviceName: desktopPreset.name,
    presetId: desktopPreset.id,
    scale: effectiveScaleD,
    badgeX: laptopScreenX + Math.floor(screenWD / 2),
    badgeY: Math.max(4, localLaptopFrameY - 28),
    cornerRadius: getPresetCornerRadius(desktopPreset),
  };

  const mobileFrame: DeviceFrameBounds = {
    frameX: phoneFrameX,
    frameY: localPhoneFrameY,
    frameWidth: phoneOuterW,
    frameHeight: phoneOuterH,
    screenX: phoneScreenX,
    screenY: localPhoneScreenY,
    screenWidth: screenWM,
    screenHeight: screenHM,
    bezelTop: phoneBezelTop,
    bezelSide: phoneBezelSide,
    bezelBottom: phoneBezelBottom,
    deviceType: 'phone',
    deviceName: mobilePreset.name,
    presetId: mobilePreset.id,
    scale: effectiveScaleM,
    badgeX: phoneScreenX + Math.floor(screenWM / 2),
    badgeY: Math.max(4, localPhoneFrameY - 28),
    cornerRadius: getPresetCornerRadius(mobilePreset),
  };

  // Window-relative bounds for WebContentsView.setBounds
  const desktopBounds: SplitPaneBounds = {
    x: laptopScreenX,
    y: yOffset + localLaptopScreenY,
    width: screenWD,
    height: screenHD,
    scale: effectiveScaleD,
    renderedWidth: screenWD,
    renderedHeight: screenHD,
    emulatedWidth: dWidth,
    emulatedHeight: dHeight,
    deviceScaleFactor: desktopPreset.deviceScaleFactor || 1,
    isMobile: false,
    frame: desktopFrame,
  };

  const mobileBounds: SplitPaneBounds = {
    x: phoneScreenX,
    y: yOffset + localPhoneScreenY,
    width: screenWM,
    height: screenHM,
    scale: effectiveScaleM,
    renderedWidth: screenWM,
    renderedHeight: screenHM,
    emulatedWidth: mWidth,
    emulatedHeight: mHeight,
    deviceScaleFactor: mobilePreset.deviceScaleFactor || 2,
    isMobile: true,
    frame: mobileFrame,
  };
  return {
    desktop: desktopBounds,
    mobile: mobileBounds,
    desktopFrame,
    mobileFrame,
    gap: interDeviceGap,
    containerWidth: containerW,
    containerHeight: containerH,
    totalGroupWidth: totalGroupW,
    totalGroupHeight: totalGroupH,
    startX: groupStartX,
  };
}

/**
 * Converts screen/window coordinates to the emulated coordinate space of a pane.
 */
export function convertToPaneCoordinates(
  windowX: number,
  windowY: number,
  paneBounds: SplitPaneBounds
): { inPane: boolean; emulatedX: number; emulatedY: number } {
  const localX = windowX - paneBounds.x;
  const localY = windowY - paneBounds.y;

  const inPane =
    localX >= 0 &&
    localX <= paneBounds.renderedWidth &&
    localY >= 0 &&
    localY <= paneBounds.renderedHeight;

  const emulatedX = Math.round(localX / (paneBounds.scale || 1));
  const emulatedY = Math.round(localY / (paneBounds.scale || 1));

  return {
    inPane,
    emulatedX: Math.max(0, Math.min(paneBounds.emulatedWidth, emulatedX)),
    emulatedY: Math.max(0, Math.min(paneBounds.emulatedHeight, emulatedY)),
  };
}

/**
 * SplitNavigationCoordinator manages in-flight navigation transactions between the paired views
 * to ensure that:
 * 1. An explicit navigation or link click in one pane mirrors to the sibling.
 * 2. When the mirror completes loading, it is recognized as an echo and does not re-navigate the authority.
 * 3. Stale or timed-out transactions expire cleanly.
 */
export class SplitNavigationCoordinator {
  private transactions: Map<string, SplitNavigationTransaction> = new Map();
  private staleHistoryDiscards: Map<string, { pane: SplitPaneId; expiry: number }> = new Map();
  private readonly transactionTtlMs: number;
  constructor(transactionTtlMs: number = 10000) {
    this.transactionTtlMs = transactionTtlMs;
  }
  /**
   * Starts a new navigation transaction with an explicit authority pane.
   */
  public startTransaction(
    tabId: string,
    authorityPane: SplitPaneId,
    targetUrl: string
  ): SplitNavigationTransaction {
    const tx: SplitNavigationTransaction = {
      id: `tx_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      tabId,
      authorityPane,
      targetUrl,
      startedAt: Date.now(),
      state: 'started',
      historyDirection: null,
      error: null,
    };
    this.transactions.set(tabId, tx);
    return tx;
  }

  /**
   * Starts a history traversal transaction (back or forward) with an explicit authority pane.
   */
  public startHistoryTransaction(
    tabId: string,
    authorityPane: SplitPaneId,
    direction: 'back' | 'forward'
  ): SplitNavigationTransaction {
    this.staleHistoryDiscards.delete(tabId);
    const tx: SplitNavigationTransaction = {
      id: `tx_hist_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      tabId,
      authorityPane,
      targetUrl: '',
      startedAt: Date.now(),
      state: 'started',
      historyDirection: direction,
      historyCommittedPanes: [],
      error: null,
    };
    this.transactions.set(tabId, tx);
    return tx;
  }
  /**
   * Returns the active transaction for a tab, clearing it if expired.
   */
  public getActiveTransaction(tabId: string): SplitNavigationTransaction | null {
    const tx = this.transactions.get(tabId);
    if (!tx) return null;
    if (Date.now() - tx.startedAt > this.transactionTtlMs) {
      this.transactions.delete(tabId);
      return null;
    }
    return tx;
  }

  /**
   * Evaluates a navigation event from a specific pane.
   */
  public handleNavigationEvent(
    tabId: string,
    sourcePane: SplitPaneId,
    committedUrl: string,
    _isInPage: boolean = false
  ): NavigationEventDecision {
    // Consume any delayed commit from an abandoned history traversal (stale-history barrier)
    const staleDiscard = this.staleHistoryDiscards.get(tabId);
    if (staleDiscard) {
      if (Date.now() > staleDiscard.expiry) {
        this.staleHistoryDiscards.delete(tabId);
      } else if (staleDiscard.pane === sourcePane) {
        const tx = this.getActiveTransaction(tabId);
        if (tx && tx.authorityPane !== sourcePane && tx.targetUrl && areUrlsEquivalent(committedUrl, tx.targetUrl)) {
          // Legitimate mirror commit of the replacement transaction — let normal transaction handling settle it while retaining barrier for delayed history traversal
        } else {
          // Non-matching commit from the abandoned history traversal — consume barrier and suppress
          this.staleHistoryDiscards.delete(tabId);
          return {
            shouldMirror: false,
            isEcho: true,
            settled: false,
            historyDirection: null,
          };
        }
      }
    }

    const tx = this.getActiveTransaction(tabId);
    const siblingPane: SplitPaneId = sourcePane === 'desktop' ? 'mobile' : 'desktop';

    // Case 1: No active transaction (organic user link click in sourcePane)
    if (!tx) {
      this.startTransaction(tabId, sourcePane, committedUrl);
      return {
        shouldMirror: true,
        mirrorUrl: committedUrl,
        targetPane: siblingPane,
        isEcho: false,
        settled: false,
      };
    }
    // Case 1b: Active history traversal transaction (back/forward)
    if (tx.historyDirection) {
      if (sourcePane === tx.authorityPane) {
        if (!tx.historyCommittedPanes) {
          tx.historyCommittedPanes = [];
        }
        if (tx.historyCommittedPanes.includes(sourcePane)) {
          // Duplicate commit from authority during history transaction — suppress re-mirroring
          return {
            shouldMirror: false,
            isEcho: true,
            settled: false,
            historyDirection: null,
          };
        }

        tx.historyCommittedPanes.push(sourcePane);
        tx.targetUrl = committedUrl;
        tx.state = 'authority-committed';
        return {
          shouldMirror: true,
          mirrorUrl: committedUrl,
          targetPane: siblingPane,
          historyDirection: tx.historyDirection,
          isEcho: false,
          settled: false,
        };
      } else {
        // Event from sibling pane
        if (tx.state === 'authority-committed' || tx.state === 'mirror-started') {
          // Authority has already committed — this is the expected sibling history commit!
          tx.state = 'settled';
          this.transactions.delete(tabId);
          return {
            shouldMirror: false,
            isEcho: true,
            settled: true,
            historyDirection: null,
          };
        } else {
          // Authority has not committed yet — independent user navigation on sibling supersedes history transaction
          const abandonedAuthorityPane = tx.authorityPane;
          tx.state = 'settled';
          this.transactions.delete(tabId);
          this.staleHistoryDiscards.set(tabId, {
            pane: abandonedAuthorityPane,
            expiry: Date.now() + 5000,
          });
          this.startTransaction(tabId, sourcePane, committedUrl);
          return {
            shouldMirror: true,
            mirrorUrl: committedUrl,
            targetPane: siblingPane,
            isEcho: false,
            settled: false,
          };
        }
      }
    }

    // Case 2: Event comes from the authority pane
    if (sourcePane === tx.authorityPane) {
      if ((tx.state === 'authority-committed' || tx.state === 'mirror-started') && tx.targetUrl && areUrlsEquivalent(committedUrl, tx.targetUrl)) {
        // Idempotent duplicate event from authority — suppress re-mirroring
        return {
          shouldMirror: false,
          isEcho: true,
          settled: false,
        };
      }
      tx.targetUrl = committedUrl;
      tx.state = 'authority-committed';
      return {
        shouldMirror: true,
        mirrorUrl: committedUrl,
        targetPane: siblingPane,
        isEcho: false,
        settled: false,
        historyDirection: null,
      };
    }
    // Case 3: Event comes from the mirror pane
    if (sourcePane !== tx.authorityPane) {
      if (tx.targetUrl && areUrlsEquivalent(committedUrl, tx.targetUrl)) {
        // Expected mirror commit — settle transaction!
        tx.state = 'settled';
        this.transactions.delete(tabId);
        return {
          shouldMirror: false,
          isEcho: true,
          settled: true,
        };
      } else if (tx.state === 'started') {
        // Authority transaction is in-flight and has not committed yet.
        // A non-matching commit from the mirror pane is a stale prior in-flight load (e.g. from tab init or previous page).
        // Suppress reverse-mirroring to prevent aborting the authority transaction and rolling back authority.
        return {
          shouldMirror: false,
          isEcho: true,
          settled: false,
        };
      } else {
        // Mirror navigated to a different URL (e.g. separate user click during load or redirect)
        // Settle old transaction and start new one from this pane to avoid deadlock.
        tx.state = 'settled';
        this.transactions.delete(tabId);
        this.startTransaction(tabId, sourcePane, committedUrl);
        return {
          shouldMirror: true,
          mirrorUrl: committedUrl,
          targetPane: siblingPane,
          isEcho: false,
          settled: false,
        };
      }
    }
    return {
      shouldMirror: false,
      isEcho: false,
      settled: false,
    };
  }
  /**
   * Marks that the mirror load has been initiated by the host.
   */
  public markMirrorStarted(tabId: string): boolean {
    const tx = this.getActiveTransaction(tabId);
    if (tx && tx.state === 'authority-committed') {
      tx.state = 'mirror-started';
      return true;
    }
    return false;
  }

  /**
   * Returns the current state of a transaction if active.
   */
  public getTransactionState(tabId: string): SplitNavigationTransaction['state'] | null {
    const tx = this.getActiveTransaction(tabId);
    return tx ? tx.state : null;
  }


  /**
   * Handles a navigation failure on either pane.
   */
  public handleNavigationFailure(
    tabId: string,
    failedPane: SplitPaneId,
    errorDescription: string
  ): { isAuthorityFailure: boolean; settled: boolean } {
    const tx = this.getActiveTransaction(tabId);
    if (!tx) {
      return { isAuthorityFailure: false, settled: false };
    }

    if (failedPane === tx.authorityPane) {
      tx.state = 'failed';
      tx.error = errorDescription;
      this.transactions.delete(tabId);
      return { isAuthorityFailure: true, settled: true };
    } else {
      // Mirror failed: retain authority URL and settle
      tx.state = 'settled';
      tx.error = errorDescription;
      this.transactions.delete(tabId);
      return { isAuthorityFailure: false, settled: true };
    }
  }

  public cancelTransaction(tabId: string): void {
    this.transactions.delete(tabId);
  }

  public cleanupTab(tabId: string): void {
    this.transactions.delete(tabId);
  }
}

/**
 * Strips transient runtime state from a tab for persistent storage.
 * Only durable configuration (splitMode, desktop/mobile presets) is preserved.
 */
export function sanitizeTabForPersistence(tab: AntiFanTab): Partial<AntiFanTab> {
  const clean: Partial<AntiFanTab> = {
    id: tab.id,
    url: tab.url,
    title: tab.title,
    devicePresetId: tab.devicePresetId,
    zoomFactor: tab.zoomFactor || 1.0,
  };

  if (tab.capsuleId) {
    clean.capsuleId = tab.capsuleId;
  }
  if (tab.userAgentMode) {
    clean.userAgentMode = tab.userAgentMode;
  }
  if (tab.alias) {
    clean.alias = tab.alias;
  }
  if (tab.role) {
    clean.role = tab.role;
  }
  if (tab.aliasColor) {
    clean.aliasColor = tab.aliasColor;
  }
  if (tab.splitMode) {
    clean.splitMode = true;
    clean.splitDesktopPresetId = tab.splitDesktopPresetId || DEFAULT_SPLIT_DESKTOP_PRESET;
    clean.splitMobilePresetId = tab.splitMobilePresetId || DEFAULT_SPLIT_MOBILE_PRESET;
  }

  return clean;
}

/**
 * Migrates and validates a restored tab record, establishing safe defaults.
 */
export function migratePersistedTab(raw: Partial<AntiFanTab> | null | undefined): Partial<AntiFanTab> {
  if (!raw || typeof raw !== 'object') {
    return {
      id: `tab-${Date.now()}`,
      url: 'about:blank',
      title: 'New Tab',
      zoomFactor: 1.0,
      splitMode: false,
    };
  }

  const result: Partial<AntiFanTab> = {
    id: typeof raw.id === 'string' && raw.id ? raw.id : `tab-${Date.now()}`,
    url: typeof raw.url === 'string' && raw.url ? raw.url : 'about:blank',
    title: typeof raw.title === 'string' && raw.title ? raw.title : 'New Tab',
    zoomFactor: typeof raw.zoomFactor === 'number' && !isNaN(raw.zoomFactor) ? raw.zoomFactor : 1.0,
    devicePresetId: typeof raw.devicePresetId === 'string' ? raw.devicePresetId : undefined,
    capsuleId: typeof raw.capsuleId === 'string' ? raw.capsuleId : undefined,
    userAgentMode: raw.userAgentMode === 'native' ? 'native' : (raw.userAgentMode === 'clean' ? 'clean' : undefined),
    alias: typeof raw.alias === 'string' ? raw.alias : undefined,
    role: typeof raw.role === 'string' ? raw.role : undefined,
    aliasColor: typeof raw.aliasColor === 'string' ? raw.aliasColor : undefined,
  };
  if (raw.splitMode === true) {
    result.splitMode = true;
    result.splitDesktopPresetId =
      typeof raw.splitDesktopPresetId === 'string' && raw.splitDesktopPresetId
        ? raw.splitDesktopPresetId
        : DEFAULT_SPLIT_DESKTOP_PRESET;
    result.splitMobilePresetId =
      typeof raw.splitMobilePresetId === 'string' && raw.splitMobilePresetId
        ? raw.splitMobilePresetId
        : DEFAULT_SPLIT_MOBILE_PRESET;
  } else {
    result.splitMode = false;
  }

  return result;
}
