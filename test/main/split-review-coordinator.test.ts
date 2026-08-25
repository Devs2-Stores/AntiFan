import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  areUrlsEquivalent,
  calculateSplitLayout,
  convertToPaneCoordinates,
  SplitNavigationCoordinator,
  sanitizeTabForPersistence,
  migratePersistedTab,
  DEFAULT_SPLIT_DESKTOP_PRESET,
  DEFAULT_SPLIT_MOBILE_PRESET,
} from '../../src/main/browser/split-review-coordinator';
import { AntiFanTab } from '../../src/shared/contracts';

describe('Split Review Coordinator & Pure Engine', () => {
  describe('areUrlsEquivalent', () => {
    it('returns true for exact matches', () => {
      assert.strictEqual(areUrlsEquivalent('https://example.com/page', 'https://example.com/page'), true);
    });

    it('ignores trailing slashes on path', () => {
      assert.strictEqual(areUrlsEquivalent('https://example.com/page/', 'https://example.com/page'), true);
      assert.strictEqual(areUrlsEquivalent('https://example.com/', 'https://example.com'), true);
    });

    it('distinguishes different search params or hashes', () => {
      assert.strictEqual(areUrlsEquivalent('https://example.com?a=1', 'https://example.com?a=2'), false);
      assert.strictEqual(areUrlsEquivalent('https://example.com#sec1', 'https://example.com#sec2'), false);
    });

    it('handles non-standard URLs like view-source and about:blank', () => {
      assert.strictEqual(areUrlsEquivalent('about:blank', 'about:blank'), true);
      assert.strictEqual(areUrlsEquivalent('view-source:https://a.com/', 'view-source:https://a.com'), true);
      assert.strictEqual(areUrlsEquivalent('about:blank', 'about:srcdoc'), false);
    });

    it('handles undefined or null gracefully', () => {
      assert.strictEqual(areUrlsEquivalent(undefined, undefined), true);
      assert.strictEqual(areUrlsEquivalent(null, null), true);
      assert.strictEqual(areUrlsEquivalent('https://a.com', null), false);
    });
  });

  describe('calculateSplitLayout', () => {
    it('allocates side-by-side desktop and mobile bounds with gap', () => {
      const container = { width: 1600, height: 900, yOffset: 60 };
      const layout = calculateSplitLayout(container, 'laptop-macbook13', 'phone-iphone15pro', 1.0, 10);

      assert.strictEqual(layout.gap, 10);
      assert.strictEqual(layout.containerWidth, 1600);
      assert.strictEqual(layout.containerHeight, 900);

      // Desktop pane
      assert.strictEqual(layout.desktop.isMobile, false);
      assert.strictEqual(layout.desktop.emulatedWidth, 1280);
      assert.strictEqual(layout.desktop.emulatedHeight, 832);
      assert.ok(layout.desktop.width <= (1600 - 10) / 2);
      assert.ok(layout.desktop.x >= 0);
      assert.ok(layout.desktop.y >= 60);

      // Mobile pane
      assert.strictEqual(layout.mobile.isMobile, true);
      assert.strictEqual(layout.mobile.emulatedWidth, 393);
      assert.strictEqual(layout.mobile.emulatedHeight, 852);
      assert.ok(layout.mobile.x > layout.desktop.x);
      assert.ok(layout.mobile.y >= 60);
    });

    it('applies user zoom factor to effective scales', () => {
      const container = { width: 1600, height: 900, yOffset: 0 };
      const standardLayout = calculateSplitLayout(container, 'laptop-macbook13', 'phone-iphone15pro', 1.0);
      const zoomedLayout = calculateSplitLayout(container, 'laptop-macbook13', 'phone-iphone15pro', 1.5);

      assert.ok(zoomedLayout.desktop.scale > standardLayout.desktop.scale);
      assert.ok(zoomedLayout.mobile.scale > standardLayout.mobile.scale);
    });

    it('handles narrow or minimal container bounds safely', () => {
      const container = { width: 200, height: 150, yOffset: 0 };
      const layout = calculateSplitLayout(container, 'desktop-fhd', 'phone-iphone16promax', 1.0);

      assert.ok(layout.desktop.width > 0);
      assert.ok(layout.mobile.width > 0);
      assert.ok(layout.desktop.scale > 0);
      assert.ok(layout.mobile.scale > 0);
    });
  });

  describe('convertToPaneCoordinates', () => {
    it('converts window coordinates to emulated pane coordinates', () => {
      const paneBounds = {
        x: 100,
        y: 50,
        width: 640,
        height: 416,
        scale: 0.5,
        renderedWidth: 640,
        renderedHeight: 416,
        emulatedWidth: 1280,
        emulatedHeight: 832,
        deviceScaleFactor: 1,
        isMobile: false,
      };

      const result = convertToPaneCoordinates(200, 100, paneBounds);
      assert.strictEqual(result.inPane, true);
      assert.strictEqual(result.emulatedX, 200); // (200 - 100) / 0.5
      assert.strictEqual(result.emulatedY, 100); // (100 - 50) / 0.5
    });

    it('flags coordinates outside the pane', () => {
      const paneBounds = {
        x: 100,
        y: 50,
        width: 300,
        height: 400,
        scale: 1,
        renderedWidth: 300,
        renderedHeight: 400,
        emulatedWidth: 300,
        emulatedHeight: 400,
        deviceScaleFactor: 2,
        isMobile: true,
      };

      const result = convertToPaneCoordinates(50, 50, paneBounds);
      assert.strictEqual(result.inPane, false);
    });
  });

  describe('SplitNavigationCoordinator', () => {
    it('coordinates a full navigation lifecycle: start -> authority-commit -> mirror-start -> settle', () => {
      const coordinator = new SplitNavigationCoordinator();
      const tabId = 'test-tab-1';
      const targetUrl = 'https://antifan.test/home';

      // 1. Explicit start
      const tx = coordinator.startTransaction(tabId, 'desktop', targetUrl);
      assert.strictEqual(tx.state, 'started');
      assert.strictEqual(coordinator.getTransactionState(tabId), 'started');

      // 2. Authority commits
      const decision1 = coordinator.handleNavigationEvent(tabId, 'desktop', targetUrl);
      assert.strictEqual(decision1.shouldMirror, true);
      assert.strictEqual(decision1.mirrorUrl, targetUrl);
      assert.strictEqual(decision1.targetPane, 'mobile');
      assert.strictEqual(decision1.isEcho, false);
      assert.strictEqual(coordinator.getTransactionState(tabId), 'authority-committed');

      // 3. Mark mirror started
      const marked = coordinator.markMirrorStarted(tabId);
      assert.strictEqual(marked, true);
      assert.strictEqual(coordinator.getTransactionState(tabId), 'mirror-started');

      // 4. Mirror commits (settles transaction)
      const decision2 = coordinator.handleNavigationEvent(tabId, 'mobile', targetUrl);
      assert.strictEqual(decision2.shouldMirror, false);
      assert.strictEqual(decision2.isEcho, true);
      assert.strictEqual(decision2.settled, true);
      assert.strictEqual(coordinator.getActiveTransaction(tabId), null);
    });

    it('handles organic navigation initiated by user clicking a link in mobile pane', () => {
      const coordinator = new SplitNavigationCoordinator();
      const tabId = 'test-tab-2';
      const clickedUrl = 'https://antifan.test/product/42';

      // Organic click (no prior transaction)
      const decision = coordinator.handleNavigationEvent(tabId, 'mobile', clickedUrl);
      assert.strictEqual(decision.shouldMirror, true);
      assert.strictEqual(decision.mirrorUrl, clickedUrl);
      assert.strictEqual(decision.targetPane, 'desktop');
      assert.strictEqual(coordinator.getTransactionState(tabId), 'started');
    });

    it('suppresses duplicate/idempotent authority events without re-mirroring', () => {
      const coordinator = new SplitNavigationCoordinator();
      const tabId = 'test-tab-3';
      const targetUrl = 'https://antifan.test/about';

      coordinator.startTransaction(tabId, 'desktop', targetUrl);
      coordinator.handleNavigationEvent(tabId, 'desktop', targetUrl);
      coordinator.markMirrorStarted(tabId);

      // Duplicate event from authority (e.g. did-navigate then in-page or DOMContentLoaded event)
      const duplicateDecision = coordinator.handleNavigationEvent(tabId, 'desktop', targetUrl);
      assert.strictEqual(duplicateDecision.shouldMirror, false);
      assert.strictEqual(duplicateDecision.isEcho, true);
      assert.strictEqual(duplicateDecision.settled, false);
    });

    it('handles independent mirror redirect/interaction cleanly without deadlocking', () => {
      const coordinator = new SplitNavigationCoordinator();
      const tabId = 'test-tab-4';

      coordinator.startTransaction(tabId, 'desktop', 'https://antifan.test/page1');
      coordinator.handleNavigationEvent(tabId, 'desktop', 'https://antifan.test/page1');

      // Mirror navigates to a completely different URL (e.g. user clicked something on mobile during load)
      const redirectDecision = coordinator.handleNavigationEvent(tabId, 'mobile', 'https://antifan.test/page2');
      assert.strictEqual(redirectDecision.shouldMirror, true);
      assert.strictEqual(redirectDecision.mirrorUrl, 'https://antifan.test/page2');
      assert.strictEqual(redirectDecision.targetPane, 'desktop');
      assert.strictEqual(coordinator.getActiveTransaction(tabId)?.authorityPane, 'mobile');
    });

    it('expires stale transactions based on TTL', () => {
      const coordinator = new SplitNavigationCoordinator(50); // 50ms TTL
      const tabId = 'test-tab-ttl';

      coordinator.startTransaction(tabId, 'desktop', 'https://antifan.test/stale');
      assert.ok(coordinator.getActiveTransaction(tabId) !== null);

      // Simulate passage of time
      const tx = coordinator.getActiveTransaction(tabId)!;
      tx.startedAt = Date.now() - 100;

      assert.strictEqual(coordinator.getActiveTransaction(tabId), null);
    });

    it('handles authority failure and mirror failure distinctly', () => {
      const coordinator = new SplitNavigationCoordinator();
      const tabId = 'test-tab-fail';

      // Case A: Authority fails
      coordinator.startTransaction(tabId, 'desktop', 'https://invalid-host.test');
      const failAuth = coordinator.handleNavigationFailure(tabId, 'desktop', 'ERR_NAME_NOT_RESOLVED');
      assert.strictEqual(failAuth.isAuthorityFailure, true);
      assert.strictEqual(failAuth.settled, true);
      assert.strictEqual(coordinator.getActiveTransaction(tabId), null);

      // Case B: Mirror fails
      coordinator.startTransaction(tabId, 'desktop', 'https://antifan.test/ok');
      const failMirror = coordinator.handleNavigationFailure(tabId, 'mobile', 'ERR_TIMED_OUT');
      assert.strictEqual(failMirror.isAuthorityFailure, false);
      assert.strictEqual(failMirror.settled, true);
      assert.strictEqual(coordinator.getActiveTransaction(tabId), null);
    });
  });

  describe('Persistence Sanitization & Migration', () => {
    it('sanitizes tab state for persistence, omitting transient fields', () => {
      const fullTab: AntiFanTab = {
        id: 'tab-123',
        url: 'https://antifan.test',
        title: 'Antifan Review',
        zoomFactor: 1.25,
        devicePresetId: 'responsive',
        splitMode: true,
        splitDesktopPresetId: 'laptop-macbook14',
        splitMobilePresetId: 'phone-iphone16promax',
        splitFocusedPane: 'mobile',
        splitError: 'Transient error',
        crashed: false,
        isLoading: true,
        canGoBack: true,
        canGoForward: false,
      };

      const sanitized = sanitizeTabForPersistence(fullTab);
      assert.strictEqual(sanitized.id, 'tab-123');
      assert.strictEqual(sanitized.url, 'https://antifan.test');
      assert.strictEqual(sanitized.title, 'Antifan Review');
      assert.strictEqual(sanitized.zoomFactor, 1.25);
      assert.strictEqual(sanitized.splitMode, true);
      assert.strictEqual(sanitized.splitDesktopPresetId, 'laptop-macbook14');
      assert.strictEqual(sanitized.splitMobilePresetId, 'phone-iphone16promax');

      // Assert transient fields are omitted
      const rawSanitized: Record<string, unknown> = sanitized;
      assert.strictEqual(rawSanitized.splitFocusedPane, undefined);
      assert.strictEqual(rawSanitized.splitError, undefined);
      assert.strictEqual(rawSanitized.isLoading, undefined);
      assert.strictEqual(rawSanitized.canGoBack, undefined);
      assert.strictEqual(rawSanitized.canGoForward, undefined);
      assert.strictEqual(rawSanitized.crashed, undefined);
      assert.strictEqual('splitFocusedPane' in sanitized, false);
      assert.strictEqual('splitError' in sanitized, false);
    });
    it('migrates legacy single-view records safely', () => {
      const legacyRaw = {
        id: 'tab-legacy',
        url: 'https://google.com',
        title: 'Google',
        devicePresetId: 'phone-iphone14pro',
        zoomFactor: 1.0,
      };

      const migrated = migratePersistedTab(legacyRaw);
      assert.strictEqual(migrated.id, 'tab-legacy');
      assert.strictEqual(migrated.url, 'https://google.com');
      assert.strictEqual(migrated.devicePresetId, 'phone-iphone14pro');
      assert.strictEqual(migrated.splitMode, false);
    });

    it('migrates split records with fallback defaults for missing presets', () => {
      const splitRaw = {
        id: 'tab-split',
        url: 'https://antifan.test',
        splitMode: true,
      };

      const migrated = migratePersistedTab(splitRaw);
      assert.strictEqual(migrated.splitMode, true);
      assert.strictEqual(migrated.splitDesktopPresetId, DEFAULT_SPLIT_DESKTOP_PRESET);
      assert.strictEqual(migrated.splitMobilePresetId, DEFAULT_SPLIT_MOBILE_PRESET);
    });

    it('handles malformed inputs with safe defaults', () => {
      const migrated = migratePersistedTab(null);
      assert.ok(migrated.id);
      assert.strictEqual(migrated.url, 'about:blank');
      assert.strictEqual(migrated.splitMode, false);
    });
  });
});
