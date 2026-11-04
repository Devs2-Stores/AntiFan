// anti.browser.evaluate on a busy renderer: a slow render-surface probe must not turn a plain DOM read into a
// refusal, and a tab is not probed again for every evaluation of a burst.
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { CapabilityError } from '../../src/shared/control-plane-contracts';
import { evaluateCapability, makeEvalHost, SURFACE } from './evaluate-test-host';

const PROBE_TIMEOUT = Object.assign(new Error('CDP command Runtime.evaluate timed out after 3000ms'), { code: 'CDP_TIMEOUT' });

describe('anti.browser.evaluate when the render-surface probe is slow', () => {
  it('still evaluates and reports the unmeasured surface instead of refusing with NO_RENDER_SURFACE', async () => {
    const { host, counters } = makeEvalHost({ probe: async () => { throw PROBE_TIMEOUT; } });
    const result = await evaluateCapability(host)({ expression: 'document.title' });

    assert.equal(counters.evals, 1, 'the expression must reach the page');
    assert.deepEqual(result, { value: 'page title', surface: { probeTimedOut: true } });
  });

  it('probes once: a timed out probe is not retried with a longer bound before the script runs', async () => {
    const { host, counters } = makeEvalHost({ probe: async () => { throw PROBE_TIMEOUT; } });
    await evaluateCapability(host)({ expression: 'document.title' });
    assert.equal(counters.probes, 1);
  });

  it('keeps refusing a tab whose probe answered with no layout surface', async () => {
    const { host, counters } = makeEvalHost({ probe: async () => ({ ...SURFACE, vw: 0, vh: 0 }) });
    await assert.rejects(
      evaluateCapability(host)({ expression: 'document.body.getBoundingClientRect().width' }),
      (err: unknown) => err instanceof CapabilityError && err.code === 'NO_RENDER_SURFACE'
    );
    assert.equal(counters.evals, 0);
  });

  it('keeps refusing a tab whose surface could not be measured for a reason other than a timeout', async () => {
    const { host, counters } = makeEvalHost({ probe: async () => { throw new Error('renderer gone'); } });
    await assert.rejects(
      evaluateCapability(host)({ expression: 'document.title' }),
      (err: unknown) => err instanceof CapabilityError && err.code === 'NO_RENDER_SURFACE'
    );
    assert.equal(counters.evals, 0);
  });

  it('returns a plain value, without a surface note, when the probe answered', async () => {
    const { host } = makeEvalHost({});
    assert.equal(await evaluateCapability(host)({ expression: 'document.title' }), 'page title');
  });
});

describe('anti.browser.evaluate surface probe cache', () => {
  it('measures a tab once for back-to-back evaluations', async () => {
    const { host, counters } = makeEvalHost({});
    const run = evaluateCapability(host);
    await run({ expression: '1' });
    await run({ expression: '2' });
    await run({ expression: '3' });
    assert.equal(counters.probes, 1);
    assert.equal(counters.evals, 3);
  });

  it('never caches a tab that measured no surface, so a recovered tab is probed again', async () => {
    let surface = { ...SURFACE, vw: 0, vh: 0 };
    const { host, counters } = makeEvalHost({ probe: async () => surface });
    const run = evaluateCapability(host);
    await assert.rejects(run({ expression: '1' }), (err: unknown) => err instanceof CapabilityError && err.code === 'NO_RENDER_SURFACE');
    surface = { ...SURFACE };
    assert.equal(await run({ expression: '2' }), 'page title');
    assert.equal(counters.probes, 2);
  });

  it('does not cache a timed out probe', async () => {
    let timeout = true;
    const { host, counters } = makeEvalHost({ probe: async () => { if (timeout) throw PROBE_TIMEOUT; return SURFACE; } });
    const run = evaluateCapability(host);
    await run({ expression: '1' });
    timeout = false;
    assert.equal(await run({ expression: '2' }), 'page title');
    assert.equal(counters.probes, 2);
  });
});
