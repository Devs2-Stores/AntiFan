// NativeTabHost.holdPageNavigation: while held, every navigation the page starts is refused and
// recorded (without its query); release detaches the listener.
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { NativeTabHost } from '../../src/main/browser/native-tab-host';

function hostWithTab() {
  const wc = Object.assign(new EventEmitter(), { isDestroyed: () => false });
  // Only the fields the method reads: the tab map and the active tab id.
  const raw = Object.create(NativeTabHost.prototype) as Record<string, unknown>;
  raw.tabs = new Map([['tab-1', { view: { webContents: wc } }]]);
  raw.activeTabId = 'tab-1';
  return { host: raw as unknown as NativeTabHost, wc };
}

describe('holdPageNavigation', () => {
  it('refuses page navigation while held and reports it without the query', () => {
    const { host, wc } = hostWithTab();
    const hold = host.holdPageNavigation('tab-1', 'desktop');
    let prevented = false;
    wc.emit('will-navigate', { preventDefault: () => { prevented = true; } }, 'https://shop.example.com/auth/1/sign-in?urlredirect=x&token=y');
    assert.strictEqual(prevented, true);
    assert.deepStrictEqual(hold.release(), ['https://shop.example.com/auth/1/sign-in']);
    assert.strictEqual(wc.listenerCount('will-navigate'), 0, 'release detaches the listener');
  });

  it('lets navigation through again once released', () => {
    const { host, wc } = hostWithTab();
    host.holdPageNavigation('tab-1', 'desktop').release();
    let prevented = false;
    wc.emit('will-navigate', { preventDefault: () => { prevented = true; } }, 'https://shop.example.com/cart');
    assert.strictEqual(prevented, false);
  });
});
