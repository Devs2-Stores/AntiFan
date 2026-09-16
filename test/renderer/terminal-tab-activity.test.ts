/**
 * Terminal tab activity: streaming indicators and AI pulse across background tabs.
 *
 * Drives the real shipped `src/renderer/standalone.js` inside the shared vm harness.
 * Exercises tab-strip activity updates when data arrives for active, background,
 * and sleeping sessions.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { loadStandalone, type FakeElement, type StandaloneHarness } from './standalone-harness';

const flush = async (): Promise<void> => {
  const { promise, resolve } = Promise.withResolvers<void>();
  setImmediate(resolve);
  return promise;
};

/**
 * Session ids as a plain host-realm array.
 *
 * `sessions` lives inside the vm context, so anything derived from it carries the
 * vm's Array.prototype and `assert.deepStrictEqual` would reject it as
 * "same structure but not reference-equal". `Array.from` normalizes the realm.
 */
const sessionIds = (harness: StandaloneHarness): string[] =>
  Array.from(harness.getSessions(), (session) => String(session.id));

const wrapFor = (harness: StandaloneHarness, sessionId: string): FakeElement => {
  const wrap = harness.tabsRoot.querySelector('.terminal-tab-wrap[data-session-id="' + sessionId + '"]');
  assert.ok(wrap, 'expected a tab wrap for ' + sessionId);
  return wrap;
};

const hasAiPulse = (wrap: FakeElement): boolean => {
  const icon = wrap.querySelector('.terminal-tab-icon');
  return Boolean(icon && /terminal-tab-ai-pulse/.test(icon.innerHTML));
};

const hasSleepIcon = (wrap: FakeElement): boolean => {
  const icon = wrap.querySelector('.terminal-tab-icon');
  return Boolean(icon && /terminal-tab-sleep-icon/.test(icon.innerHTML));
};

/** Replace the renderer's live session list the way a `session` broadcast does. */
function seed(harness: StandaloneHarness, list: unknown[], active: string): void {
  harness.setSessions(list);
  harness.setActiveId(active);
}

describe('Renderer terminal tab activity', () => {
  it('updates streaming indicator and AI pulse on background tab when terminal data arrives', async () => {
    const harness = loadStandalone();
    await flush();

    const list = [
      { id: 's1', name: 'Active', state: 'running' },
      { id: 's2', name: 'Background', state: 'running' },
    ];
    seed(harness, list, 's1');
    harness.renderTabs();

    const wrapS2Before = wrapFor(harness, 's2');
    assert.strictEqual(wrapS2Before.classList.contains('is-streaming'), false);
    assert.strictEqual(hasAiPulse(wrapS2Before), false);

    harness.emitData({
      sessionId: 's2',
      data: 'Claude: Analyzing the code and streaming token response...\n',
      seq: 1,
      generation: 1,
    });
    await flush();

    const wrapS2After = wrapFor(harness, 's2');
    assert.strictEqual(
      wrapS2After.classList.contains('is-streaming'),
      true,
      'background tab wrap must have is-streaming class',
    );
    assert.strictEqual(
      hasAiPulse(wrapS2After),
      true,
      'background tab wrap must contain a .terminal-tab-ai-pulse element',
    );
  });

  it('updates streaming indicator and AI pulse on active tab when terminal data arrives', async () => {
    const harness = loadStandalone();
    await flush();

    const list = [
      { id: 's1', name: 'Active', state: 'running' },
      { id: 's2', name: 'Background', state: 'running' },
    ];
    seed(harness, list, 's1');
    harness.renderTabs();

    const wrapS1Before = wrapFor(harness, 's1');
    assert.strictEqual(wrapS1Before.classList.contains('is-streaming'), false);
    assert.strictEqual(hasAiPulse(wrapS1Before), false);

    harness.emitData({
      sessionId: 's1',
      data: 'Claude: Thinking through the implementation...\n',
      seq: 1,
      generation: 1,
    });
    await flush();

    const wrapS1After = wrapFor(harness, 's1');
    assert.strictEqual(
      wrapS1After.classList.contains('is-streaming'),
      true,
      'active tab wrap must have is-streaming class',
    );
    assert.strictEqual(
      hasAiPulse(wrapS1After),
      true,
      'active tab wrap must contain a .terminal-tab-ai-pulse element',
    );
  });

  it('preserves sleeping presentation and does not mark streaming when data arrives for a sleeping session', async () => {
    const harness = loadStandalone();
    await flush();

    const list = [
      { id: 's1', name: 'Active', state: 'running' },
      { id: 's3', name: 'Sleeping Session', state: 'sleeping' },
    ];
    seed(harness, list, 's1');
    harness.renderTabs();

    const wrapS3Before = wrapFor(harness, 's3');
    assert.strictEqual(wrapS3Before.classList.contains('is-streaming'), false);
    assert.strictEqual(hasSleepIcon(wrapS3Before), true, 'sleeping tab must show sleep icon');

    harness.emitData({
      sessionId: 's3',
      data: 'Claude: Output sent while asleep...\n',
      seq: 1,
      generation: 1,
    });
    await flush();

    const wrapS3After = wrapFor(harness, 's3');
    assert.strictEqual(
      wrapS3After.classList.contains('is-streaming'),
      false,
      'sleeping tab must not have is-streaming class',
    );
    assert.strictEqual(
      hasAiPulse(wrapS3After),
      false,
      'sleeping tab must not contain an ai pulse element',
    );
    assert.strictEqual(
      hasSleepIcon(wrapS3After),
      true,
      'sleeping tab must retain sleep icon',
    );
  });
});
