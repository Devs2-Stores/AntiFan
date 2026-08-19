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
    assert.ok(SIDEBAR_CHANNELS.SEND_PROMPT);
    assert.ok(SIDEBAR_CHANNELS.ATTACH_ELEMENT);
    assert.ok(SIDEBAR_CHANNELS.GET_SESSIONS);
    assert.ok(SIDEBAR_CHANNELS.SWITCH_SESSION);
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
});
