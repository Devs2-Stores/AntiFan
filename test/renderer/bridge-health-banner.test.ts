/**
 * Bridge health surface (Renderer) — Component 5 / S3.
 *
 * Verifies:
 * - `#bridgeHealthChip` exists once across repeated renders and carries port + client count
 * - Tooltip shows lastFailure.code when degraded/down
 * - Clicking chip re-invokes getBridgeStatus
 * - Exactly one `#bridgeHealthBanner` is maintained as the first child of `main.standalone`
 * - Banner is absent while listening with no client failures
 * - All three message branches render verbatim
 * - Dismissed signature stays dismissed across repeated pushes of the same condition
 * - Banner reappears when dismissal signature changes
 * - Recovery to listening removes banner and clears stored localStorage signature
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { loadStandalone, type FakeElement, type StandaloneHarness } from './standalone-harness';

function getChip(harness: StandaloneHarness): FakeElement | null {
  return harness.standaloneRoot.querySelector('#bridgeHealthChip');
}

function getBanner(harness: StandaloneHarness): FakeElement | null {
  return harness.standaloneRoot.querySelector('#bridgeHealthBanner');
}

describe('bridge health surface (renderer)', () => {
  it('chip exists exactly once across repeated renders and carries port + client count', async () => {
    const harness = loadStandalone();

    const report1 = {
      state: 'listening' as const,
      port: 20129,
      clientCount: 3,
      clientFailures: { count: 0 },
    };

    // Render repeatedly
    for (let i = 0; i < 5; i++) {
      harness.renderBridgeChip(report1);
    }

    const chips = harness.standaloneRoot.querySelectorAll('#bridgeHealthChip');
    assert.strictEqual(chips.length, 1, 'chip exists exactly once across repeated renders');

    const chip = getChip(harness);
    assert.ok(chip, 'chip element exists');
    assert.strictEqual(chip.textContent.trim(), '● Bridge');

    const title = chip.title || chip.getAttribute('title') || '';
    assert.match(title, /Port: 20129/);
    assert.match(title, /Clients: 3/);

    // Degraded report adds lastFailure.code to tooltip
    const report2 = {
      state: 'degraded' as const,
      port: 20129,
      clientCount: 2,
      lastFailure: { code: 'PAIRING_REFUSED', message: 'refused', at: Date.now() },
      clientFailures: { count: 0 },
    };
    harness.renderBridgeChip(report2);

    const degradedTitle = chip.title || chip.getAttribute('title') || '';
    assert.match(degradedTitle, /PAIRING_REFUSED/);

    // Clicking re-invokes getBridgeStatus
    let getStatusCalled = false;
    harness.api.getBridgeStatus = async () => {
      getStatusCalled = true;
      return report1;
    };
    chip.click();
    assert.strictEqual(getStatusCalled, true, 'clicking chip re-invokes getBridgeStatus');
  });

  it('banner is created once and never duplicated across pushes and renderTabs passes', async () => {
    const harness = loadStandalone();

    const downReport = {
      state: 'down' as const,
      reasonCode: 'HEALTH_RECORD_ABSENT' as const,
      port: 20129,
      clientCount: 0,
      clientFailures: { count: 0 },
    };

    // Deliver multiple pushes and renderTabs passes
    for (let i = 0; i < 4; i++) {
      harness.emitBridgeStatus(downReport);
      harness.renderTabs();
    }

    const banners = harness.standaloneRoot.querySelectorAll('#bridgeHealthBanner');
    assert.strictEqual(banners.length, 1, 'banner is created once and never duplicated across pushes');

    const banner = getBanner(harness);
    assert.ok(banner, 'banner exists');
    assert.strictEqual(banner.getAttribute('role'), 'alert');
    assert.strictEqual(
      harness.standaloneRoot.firstChild,
      banner,
      'banner is the first child of main.standalone'
    );
  });

  it('banner is absent while listening with no client failures', async () => {
    const harness = loadStandalone();

    const healthyReport = {
      state: 'listening' as const,
      port: 20129,
      clientCount: 1,
      clientFailures: { count: 0 },
    };

    harness.emitBridgeStatus(healthyReport);
    assert.strictEqual(getBanner(harness), null, 'banner is absent while listening with no client failures');
  });

  it('renders all three message branches verbatim', async () => {
    const harness = loadStandalone();

    // Branch 1: down
    harness.emitBridgeStatus({
      state: 'down',
      reasonCode: 'HEALTH_RECORD_ABSENT',
      port: 20129,
      clientCount: 0,
      clientFailures: { count: 0 },
    });
    let banner = getBanner(harness);
    assert.ok(banner);
    assert.strictEqual(
      banner.querySelector('.bridge-health-banner-text')?.textContent,
      'Bridge MCP không hoạt động — agent không thể điều khiển trình duyệt (HEALTH_RECORD_ABSENT)'
    );

    // Branch 2: degraded
    harness.emitBridgeStatus({
      state: 'degraded',
      port: 20129,
      clientCount: 2,
      lastFailure: { code: 'PAIRING_REFUSED', message: '', at: Date.now() },
      clientFailures: { count: 0 },
    });
    banner = getBanner(harness);
    assert.ok(banner);
    assert.strictEqual(
      banner.querySelector('.bridge-health-banner-text')?.textContent,
      'Bridge MCP đang suy giảm — PAIRING_REFUSED'
    );

    // Branch 3: listening but clientFailures.count > 0 with terminalSessionId
    harness.emitBridgeStatus({
      state: 'listening',
      port: 20129,
      clientCount: 1,
      clientFailures: {
        count: 5,
        latest: { at: Date.now(), code: 'MCP_BRIDGE_OFFLINE', message: '', terminalSessionId: 'term-sess-99' },
      },
    });
    banner = getBanner(harness);
    assert.ok(banner);
    assert.strictEqual(
      banner.querySelector('.bridge-health-banner-text')?.textContent,
      '5 MCP client kết nối thất bại trong 2 phút qua — server vẫn đang lắng nghe (term-sess-99)'
    );

    // Branch 3: listening but clientFailures.count > 0 without terminalSessionId
    harness.emitBridgeStatus({
      state: 'listening',
      port: 20129,
      clientCount: 1,
      clientFailures: {
        count: 2,
      },
    });
    banner = getBanner(harness);
    assert.ok(banner);
    assert.strictEqual(
      banner.querySelector('.bridge-health-banner-text')?.textContent,
      '2 MCP client kết nối thất bại trong 2 phút qua — server vẫn đang lắng nghe'
    );
  });

  it('dismissed signature stays dismissed across pushes of the same condition and reappears when signature changes', async () => {
    const harness = loadStandalone();

    const reportA = {
      state: 'down' as const,
      reasonCode: 'HEALTH_RECORD_ABSENT' as const,
      port: 20129,
      clientCount: 0,
      clientFailures: { count: 0 },
    };

    harness.emitBridgeStatus(reportA);
    let banner = getBanner(harness);
    assert.ok(banner, 'banner appears');

    // Click close
    const closeBtn = banner.querySelector('.bridge-health-banner-close');
    assert.ok(closeBtn, 'close button exists');
    closeBtn.click();

    assert.strictEqual(getBanner(harness), null, 'banner removed after dismissal');
    assert.strictEqual(
      harness.localStorage.getItem('antifan.bridgeHealth.dismissed'),
      'down|HEALTH_RECORD_ABSENT|false',
      'signature stored in localStorage'
    );

    // Push identical report
    harness.emitBridgeStatus(reportA);
    assert.strictEqual(getBanner(harness), null, 'banner stays dismissed across identical condition pushes');

    // Push changed report (different failure code)
    const reportB = {
      state: 'down' as const,
      lastFailure: { code: 'LISTEN_FAILED', message: '', at: Date.now() },
      port: 20129,
      clientCount: 0,
      clientFailures: { count: 0 },
    };
    harness.emitBridgeStatus(reportB);

    banner = getBanner(harness);
    assert.ok(banner, 'banner reappears when failure code changes');
    assert.strictEqual(
      banner.querySelector('.bridge-health-banner-text')?.textContent,
      'Bridge MCP không hoạt động — agent không thể điều khiển trình duyệt (LISTEN_FAILED)'
    );

    // Dismiss again
    banner.querySelector('.bridge-health-banner-close')?.click();
    assert.strictEqual(getBanner(harness), null);
    assert.strictEqual(
      harness.localStorage.getItem('antifan.bridgeHealth.dismissed'),
      'down|LISTEN_FAILED|false'
    );

    // Push with clientFailures arriving: signature changes hasClientFailures from false to true
    harness.emitBridgeStatus({
      state: 'down',
      lastFailure: { code: 'LISTEN_FAILED', message: '', at: Date.now() },
      port: 20129,
      clientCount: 0,
      clientFailures: { count: 1, latest: { at: Date.now(), code: 'CONNECT_FAILED', message: '' } },
    });
    banner = getBanner(harness);
    assert.ok(banner, 'banner reappears when clientFailures arrive');
  });

  it('recovery removes the banner and the stored signature', async () => {
    const harness = loadStandalone();

    // Cause degraded banner and dismiss it
    harness.emitBridgeStatus({
      state: 'degraded',
      port: 20129,
      clientCount: 1,
      lastFailure: { code: 'WS_AUTH_REFUSED', message: '', at: Date.now() },
      clientFailures: { count: 0 },
    });
    let banner = getBanner(harness);
    assert.ok(banner, 'degraded banner exists');
    banner.querySelector('.bridge-health-banner-close')?.click();
    assert.strictEqual(getBanner(harness), null);
    assert.strictEqual(
      harness.localStorage.getItem('antifan.bridgeHealth.dismissed'),
      'degraded|WS_AUTH_REFUSED|false'
    );

    // Now recover to listening with zero client failures
    harness.emitBridgeStatus({
      state: 'listening',
      port: 20129,
      clientCount: 2,
      clientFailures: { count: 0 },
    });

    assert.strictEqual(getBanner(harness), null, 'banner is absent on recovery');
    assert.strictEqual(
      harness.localStorage.getItem('antifan.bridgeHealth.dismissed'),
      null,
      'stored signature is cleared on recovery to listening'
    );

    // Next time an outage occurs with the same prior signature, it appears freshly (not suppressed)
    harness.emitBridgeStatus({
      state: 'degraded',
      port: 20129,
      clientCount: 1,
      lastFailure: { code: 'WS_AUTH_REFUSED', message: '', at: Date.now() },
      clientFailures: { count: 0 },
    });
    assert.ok(getBanner(harness), 'banner appears freshly because stored signature was cleared on recovery');
  });
});
