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
  SPLIT_FRAME_BEZELS,
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
    it('allocates side-by-side desktop and mobile bounds with balanced framing and gap', () => {
      const container = { width: 1600, height: 900, yOffset: 60 };
      const layout = calculateSplitLayout(container, 'laptop-macbook13', 'phone-iphone15pro', 1.0, 18);

      assert.strictEqual(layout.gap, 18);
      assert.strictEqual(layout.containerWidth, 1600);
      assert.strictEqual(layout.containerHeight, 900);

      // Desktop pane & frame origin equality and bezel source of truth
      assert.strictEqual(layout.desktop.isMobile, false);
      assert.strictEqual(layout.desktop.emulatedWidth, 1280);
      assert.strictEqual(layout.desktop.emulatedHeight, 832);
      assert.ok(layout.desktop.width > 0);
      assert.ok(layout.desktop.x >= 0);
      assert.ok(layout.desktop.y >= 60);
      assert.ok(layout.desktopFrame);
      assert.strictEqual(layout.desktopFrame.deviceType, 'laptop');
      assert.strictEqual(layout.desktopFrame.bezelTop, SPLIT_FRAME_BEZELS.laptop.bezelTop);
      assert.strictEqual(layout.desktopFrame.bezelSide, SPLIT_FRAME_BEZELS.laptop.bezelSide);
      assert.strictEqual(layout.desktopFrame.bezelBottom, SPLIT_FRAME_BEZELS.laptop.bezelBottom);
      assert.strictEqual(layout.desktopFrame.screenX, layout.desktop.x);
      assert.strictEqual(layout.desktopFrame.screenY, layout.desktop.y - 60);
      assert.strictEqual(layout.desktopFrame.screenX, layout.desktopFrame.frameX + (layout.desktopFrame.baseSide || 0) + layout.desktopFrame.bezelSide);
      assert.strictEqual(layout.desktopFrame.screenY, layout.desktopFrame.frameY + layout.desktopFrame.bezelTop);
      assert.strictEqual(layout.desktop.renderedWidth, layout.desktopFrame.screenWidth);
      assert.strictEqual(layout.desktop.renderedHeight, layout.desktopFrame.screenHeight);

      // Mobile pane & frame origin equality and bezel source of truth
      assert.strictEqual(layout.mobile.isMobile, true);
      assert.strictEqual(layout.mobile.emulatedWidth, 393);
      assert.strictEqual(layout.mobile.emulatedHeight, 852);
      assert.ok(layout.mobile.x > layout.desktop.x);
      assert.ok(layout.mobile.y >= 60);
      assert.ok(layout.mobileFrame);
      assert.strictEqual(layout.mobileFrame.deviceType, 'phone');
      assert.strictEqual(layout.mobileFrame.bezelTop, SPLIT_FRAME_BEZELS.phone.bezelTop);
      assert.strictEqual(layout.mobileFrame.bezelSide, SPLIT_FRAME_BEZELS.phone.bezelSide);
      assert.strictEqual(layout.mobileFrame.bezelBottom, SPLIT_FRAME_BEZELS.phone.bezelBottom);
      assert.strictEqual(layout.mobileFrame.screenX, layout.mobile.x);
      assert.strictEqual(layout.mobileFrame.screenY, layout.mobile.y - 60);
      assert.strictEqual(layout.mobileFrame.screenX, layout.mobileFrame.frameX + layout.mobileFrame.bezelSide);
      assert.strictEqual(layout.mobileFrame.screenY, layout.mobileFrame.frameY + layout.mobileFrame.bezelTop);
      assert.strictEqual(layout.mobile.renderedWidth, layout.mobileFrame.screenWidth);
      assert.strictEqual(layout.mobile.renderedHeight, layout.mobileFrame.screenHeight);
      assert.ok(layout.totalGroupWidth <= 1600);
      assert.ok(layout.startX >= 0);
    });

    it('applies user zoom factor to effective scales with container containment', () => {
      const container = { width: 1600, height: 900, yOffset: 60 };
      const standardLayout = calculateSplitLayout(container, 'laptop-macbook13', 'phone-iphone15pro', 1.0);
      const zoomedLayout = calculateSplitLayout(container, 'laptop-macbook13', 'phone-iphone15pro', 1.25);

      assert.ok(zoomedLayout.desktop.scale > standardLayout.desktop.scale);
      assert.ok(zoomedLayout.mobile.scale > standardLayout.mobile.scale);
      assert.ok(zoomedLayout.desktop.x >= 0);
      assert.ok(zoomedLayout.desktop.y >= 60);
      assert.ok(zoomedLayout.mobile.x >= 0);
      assert.ok(zoomedLayout.mobile.y >= 60);
      assert.ok(zoomedLayout.desktopFrame.frameX >= 0);
      assert.ok(zoomedLayout.desktopFrame.frameY >= 0);
      assert.ok(zoomedLayout.mobileFrame.frameX >= 0);
      assert.ok(zoomedLayout.mobileFrame.frameY >= 0);
      assert.ok(zoomedLayout.totalGroupWidth <= 1600);
    });

    it('centers layout symmetrically within container bounds at standard zoom', () => {
      const container = { width: 1600, height: 900, yOffset: 60 };
      const layout = calculateSplitLayout(container, 'laptop-macbook13', 'phone-iphone15pro', 1.0);
      assert.ok(layout.startX >= 0);
      assert.ok(layout.totalGroupWidth <= 1600);
      const remainingSpace = 1600 - layout.totalGroupWidth;
      const expectedStartX = Math.floor(remainingSpace / 2);
      assert.strictEqual(layout.startX, expectedStartX);
      assert.ok(layout.desktop.x >= 0);
      assert.ok(layout.desktop.y >= 60);
      assert.ok(layout.mobile.x >= 0);
      assert.ok(layout.mobile.y >= 60);
      assert.ok(layout.desktopFrame.frameX >= 0);
      assert.ok(layout.desktopFrame.frameY >= 0);
      assert.ok(layout.mobileFrame.frameX >= 0);
      assert.ok(layout.mobileFrame.frameY >= 0);
    });

    it('handles narrow or minimal container bounds safely with non-negative coordinates', () => {
      const container = { width: 200, height: 150, yOffset: 0 };
      const layout = calculateSplitLayout(container, 'desktop-fhd', 'phone-iphone16promax', 1.0);

      assert.ok(layout.desktop.width > 0);
      assert.ok(layout.mobile.width > 0);
      assert.ok(layout.desktop.scale > 0);
      assert.ok(layout.mobile.scale > 0);
      assert.ok(layout.desktop.x >= 0);
      assert.ok(layout.desktop.y >= 0);
      assert.ok(layout.mobile.x >= 0);
      assert.ok(layout.mobile.y >= 0);
      assert.ok(layout.desktopFrame.frameX >= 0);
      assert.ok(layout.desktopFrame.frameY >= 0);
      assert.ok(layout.mobileFrame.frameX >= 0);
      assert.ok(layout.mobileFrame.frameY >= 0);
      assert.ok(layout.totalGroupWidth <= 200);
    });

    it('guarantees floating badges never overlap with native screen views across large and tall mobile viewports (e.g. Pixel 8 Pro)', () => {
      const testViewports = [
        { width: 1920, height: 1080, yOffset: 60 },
        { width: 1600, height: 900, yOffset: 60 },
        { width: 1440, height: 900, yOffset: 60 },
        { width: 1280, height: 800, yOffset: 60 },
        { width: 2560, height: 1440, yOffset: 60 },
      ];

      const testPresets = [
        { d: 'laptop-macbook13', m: 'phone-pixel8pro' },
        { d: 'desktop-fhd', m: 'phone-iphone16promax' },
        { d: 'laptop-macbook16', m: 'phone-iphone15pro' },
      ];

      for (const vp of testViewports) {
        for (const { d, m } of testPresets) {
          const layout = calculateSplitLayout(vp, d, m, 1.0);
          const badgeHeight = 24;

          // Desktop badge clearance
          assert.ok(
            layout.desktopFrame.badgeY + badgeHeight <= layout.desktopFrame.frameY,
            `Desktop badge overlaps frame on ${vp.width}x${vp.height} with ${d}`
          );
          assert.ok(
            layout.desktopFrame.badgeY + badgeHeight < layout.desktopFrame.screenY,
            `Desktop badge overlaps screen WebContents on ${vp.width}x${vp.height} with ${d}`
          );

          // Mobile badge clearance (specifically protecting tall viewports like Pixel 8 Pro)
          assert.ok(
            layout.mobileFrame.badgeY + badgeHeight <= layout.mobileFrame.frameY,
            `Mobile badge overlaps frame on ${vp.width}x${vp.height} with ${m}`
          );
          assert.ok(
            layout.mobileFrame.badgeY + badgeHeight < layout.mobileFrame.screenY,
            `Mobile badge overlaps screen WebContents on ${vp.width}x${vp.height} with ${m}`
          );
        }
      }
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

    it('suppresses stale mirror navigation while authority transaction is in started state', () => {
      const coordinator = new SplitNavigationCoordinator();
      const tabId = 'test-tab-started-guard';

      // Desktop starts transaction to /page2 (state: 'started')
      coordinator.startTransaction(tabId, 'desktop', 'https://antifan.test/page2');
      assert.strictEqual(coordinator.getTransactionState(tabId), 'started');

      // Mobile emits delayed commit for old /home URL before desktop commits /page2
      const staleMirrorDecision = coordinator.handleNavigationEvent(tabId, 'mobile', 'https://antifan.test/home');
      assert.strictEqual(staleMirrorDecision.shouldMirror, false, 'Must not mirror stale prior URL back to authority');
      assert.strictEqual(staleMirrorDecision.isEcho, true);
      assert.strictEqual(staleMirrorDecision.settled, false);
      assert.strictEqual(coordinator.getTransactionState(tabId), 'started', 'Transaction must remain started for authority');

      // Now desktop commits /page2
      const authDecision = coordinator.handleNavigationEvent(tabId, 'desktop', 'https://antifan.test/page2');
      assert.strictEqual(authDecision.shouldMirror, true);
      assert.strictEqual(authDecision.mirrorUrl, 'https://antifan.test/page2');
      assert.strictEqual(authDecision.targetPane, 'mobile');
      assert.strictEqual(coordinator.getTransactionState(tabId), 'authority-committed');
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

    it('handles authority-first history traversal transactions in lockstep', () => {
      const coordinator = new SplitNavigationCoordinator();
      const tabId = 'tab-hist-auth-first';

      // Start back transaction from desktop
      coordinator.startHistoryTransaction(tabId, 'desktop', 'back');

      // Desktop (authority) commits first
      const authDecision = coordinator.handleNavigationEvent(tabId, 'desktop', 'https://antifan.test/home');
      assert.strictEqual(authDecision.shouldMirror, true);
      assert.strictEqual(authDecision.historyDirection, 'back');
      assert.strictEqual(authDecision.targetPane, 'mobile');
      assert.strictEqual(authDecision.settled, false);

      // Mobile (sibling) commits second
      const sibDecision = coordinator.handleNavigationEvent(tabId, 'mobile', 'https://antifan.test/home');
      assert.strictEqual(sibDecision.shouldMirror, false);
      assert.strictEqual(sibDecision.isEcho, true);
      assert.strictEqual(sibDecision.settled, true);
      assert.strictEqual(coordinator.getActiveTransaction(tabId), null);
    });

    it('cancels pending history transaction when sibling navigates independently and ignores delayed authority commit arriving first', () => {
      const coordinator = new SplitNavigationCoordinator();
      const tabId = 'tab-hist-sib-supersede-order1';

      // Start forward transaction from desktop (authority)
      coordinator.startHistoryTransaction(tabId, 'desktop', 'forward');

      // Sibling (mobile) navigates to an organic URL before desktop authority commits
      const sibDecision = coordinator.handleNavigationEvent(tabId, 'mobile', 'https://antifan.test/organic-page');
      assert.strictEqual(sibDecision.shouldMirror, true);
      assert.strictEqual(sibDecision.mirrorUrl, 'https://antifan.test/organic-page');
      assert.strictEqual(sibDecision.targetPane, 'desktop');
      assert.strictEqual(sibDecision.isEcho, false);
      assert.strictEqual(sibDecision.settled, false);

      // Active transaction is now a normal transaction owned by mobile
      const activeTx = coordinator.getActiveTransaction(tabId);
      assert.ok(activeTx);
      assert.strictEqual(activeTx.authorityPane, 'mobile');
      assert.strictEqual(activeTx.targetUrl, 'https://antifan.test/organic-page');
      assert.strictEqual(activeTx.historyDirection, null);

      // Delayed commit from the abandoned desktop forward history traversal arrives FIRST
      const delayedDesktopDecision = coordinator.handleNavigationEvent(tabId, 'desktop', 'https://antifan.test/delayed-old-forward-target');
      assert.strictEqual(delayedDesktopDecision.shouldMirror, false);
      assert.strictEqual(delayedDesktopDecision.isEcho, true);
      assert.strictEqual(delayedDesktopDecision.settled, false);

      // Active transaction remains untouched for mobile's organic URL
      const stillActiveTx = coordinator.getActiveTransaction(tabId);
      assert.ok(stillActiveTx);
      assert.strictEqual(stillActiveTx.authorityPane, 'mobile');
      assert.strictEqual(stillActiveTx.targetUrl, 'https://antifan.test/organic-page');

      // Desktop now commits the mirrored organic URL
      const mirrorCommitDecision = coordinator.handleNavigationEvent(tabId, 'desktop', 'https://antifan.test/organic-page');
      assert.strictEqual(mirrorCommitDecision.shouldMirror, false);
      assert.strictEqual(mirrorCommitDecision.isEcho, true);
      assert.strictEqual(mirrorCommitDecision.settled, true);
      assert.strictEqual(coordinator.getActiveTransaction(tabId), null);
    });

    it('cancels pending history transaction and ignores delayed authority commit arriving AFTER replacement mirror settles', () => {
      const coordinator = new SplitNavigationCoordinator();
      const tabId = 'tab-hist-sib-supersede-order2';

      // Start forward transaction from desktop (authority)
      coordinator.startHistoryTransaction(tabId, 'desktop', 'forward');

      // Sibling (mobile) navigates to an organic URL before desktop authority commits
      const sibDecision = coordinator.handleNavigationEvent(tabId, 'mobile', 'https://antifan.test/organic-page');
      assert.strictEqual(sibDecision.shouldMirror, true);
      assert.strictEqual(sibDecision.mirrorUrl, 'https://antifan.test/organic-page');
      assert.strictEqual(sibDecision.targetPane, 'desktop');
      assert.strictEqual(sibDecision.isEcho, false);
      assert.strictEqual(sibDecision.settled, false);

      // Desktop commits the replacement mirror URL FIRST (fast load)
      const mirrorCommitDecision = coordinator.handleNavigationEvent(tabId, 'desktop', 'https://antifan.test/organic-page');
      assert.strictEqual(mirrorCommitDecision.shouldMirror, false);
      assert.strictEqual(mirrorCommitDecision.isEcho, true);
      assert.strictEqual(mirrorCommitDecision.settled, true);
      assert.strictEqual(coordinator.getActiveTransaction(tabId), null);

      // Delayed commit from the abandoned desktop forward history traversal arrives SECOND
      const delayedDesktopDecision = coordinator.handleNavigationEvent(tabId, 'desktop', 'https://antifan.test/delayed-old-forward-target');
      // Stale history barrier swallows this delayed commit without starting a new transaction or re-mirroring to mobile
      assert.strictEqual(delayedDesktopDecision.shouldMirror, false);
      assert.strictEqual(delayedDesktopDecision.isEcho, true);
      assert.strictEqual(delayedDesktopDecision.settled, false);
      assert.strictEqual(coordinator.getActiveTransaction(tabId), null);
    });

    it('suppresses duplicate authority commits during active history transaction', () => {
      const coordinator = new SplitNavigationCoordinator();
      const tabId = 'tab-hist-dup-auth';

      // Start back transaction from desktop
      coordinator.startHistoryTransaction(tabId, 'desktop', 'back');

      // Desktop commits (did-navigate)
      const firstDecision = coordinator.handleNavigationEvent(tabId, 'desktop', 'https://antifan.test/home');
      assert.strictEqual(firstDecision.shouldMirror, true);
      assert.strictEqual(firstDecision.historyDirection, 'back');

      // Duplicate desktop commit (e.g. did-navigate-in-page or immediate redirect)
      const dupDecision = coordinator.handleNavigationEvent(tabId, 'desktop', 'https://antifan.test/home');
      assert.strictEqual(dupDecision.shouldMirror, false);
      assert.strictEqual(dupDecision.isEcho, true);
      assert.strictEqual(dupDecision.settled, false);

      // Mobile commits — completes transaction
      const sibDecision = coordinator.handleNavigationEvent(tabId, 'mobile', 'https://antifan.test/home');
      assert.strictEqual(sibDecision.shouldMirror, false);
      assert.strictEqual(sibDecision.settled, true);
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
