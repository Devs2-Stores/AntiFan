import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { TOOLBAR_CHANNELS, SIDEBAR_CHANNELS, AntiFanTab, AntiFanPickedElement } from '../../src/shared/contracts';

describe('AntiFan Contracts', () => {
  it('has consistent IPC channel definitions', () => {
    assert.ok(TOOLBAR_CHANNELS.CREATE_TAB);
    assert.ok(TOOLBAR_CHANNELS.SWITCH_TAB);
    assert.ok(TOOLBAR_CHANNELS.CLOSE_TAB);
    assert.ok(TOOLBAR_CHANNELS.NAVIGATE);
    assert.ok(TOOLBAR_CHANNELS.TOGGLE_INSPECT);
    assert.ok(TOOLBAR_CHANNELS.TOGGLE_SIDEBAR);
    assert.ok(TOOLBAR_CHANNELS.TOGGLE_MUTE);
    assert.ok(SIDEBAR_CHANNELS.GET_INITIAL_STATE);
    assert.ok(SIDEBAR_CHANNELS.CLOSE_SIDEBAR);
    assert.ok(SIDEBAR_CHANNELS.SET_WIDTH);
  });

  it('validates shape of picked element interface', () => {
    const el: AntiFanPickedElement = {
      tag: 'button',
      id: 'btn-submit',
      classes: ['btn', 'btn-primary'],
      textSnippet: 'Submit Order',
      xpath: '//*[@id="btn-submit"]',
      selector: 'button#btn-submit',
      rect: { x: 100, y: 200, width: 120, height: 40 },
      computedStyles: { color: 'rgb(255, 255, 255)' },
      timestamp: Date.now(),
    };

    assert.strictEqual(el.tag, 'button');
    assert.strictEqual(el.id, 'btn-submit');
    assert.strictEqual(el.classes.length, 2);
  });

  it('supports audio indicator and scroll restoration fields on AntiFanTab', () => {
    const tab: AntiFanTab = {
      id: 'tab-123',
      url: 'https://youtube.com',
      title: 'YouTube Music',
      isLoading: false,
      canGoBack: true,
      canGoForward: false,
      zoomFactor: 1.0,
      isAudible: true,
      isMuted: false,
      scrollX: 0,
      scrollY: 450,
    };

    assert.strictEqual(tab.isAudible, true);
    assert.strictEqual(tab.isMuted, false);
    assert.strictEqual(tab.scrollY, 450);
  });
});
