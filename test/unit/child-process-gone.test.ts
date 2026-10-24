import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  MAX_AFFECTED_TABS,
  describeChildProcessGone,
} from '../../src/main/diagnostics/child-process-gone';

const tabs = [
  { id: 'tab-1', url: 'https://shopee.vn/product/1?token=SECRET#frag-SECRET' },
  { id: 'tab-2', url: 'about:blank' },
  { id: 'tab-3' },
];

describe('describeChildProcessGone', () => {
  it('records type, reason, exit code and names every live tab for a GPU exit', () => {
    const record = describeChildProcessGone({ type: 'GPU', reason: 'crashed', exitCode: -1073740791 }, tabs);
    assert.equal(record.type, 'GPU');
    assert.equal(record.reason, 'crashed');
    assert.equal(record.exitCode, -1073740791);
    assert.equal(record.affectedScope, 'all-tabs');
    assert.equal(record.affectedTabCount, 3);
    assert.deepEqual(record.affectedTabs, [
      { tabId: 'tab-1', host: 'shopee.vn', path: '/product/1' },
      { tabId: 'tab-2', host: '', path: '' },
      { tabId: 'tab-3', host: '', path: '' },
    ]);
    assert.ok(!JSON.stringify(record).includes('SECRET'), 'no query or fragment is journaled');
  });

  it('does not guess which tabs a non-GPU process served', () => {
    const record = describeChildProcessGone(
      { type: 'Utility', reason: 'abnormal-exit', exitCode: 3, name: 'network.mojom.NetworkService', serviceName: 'network' },
      tabs,
    );
    assert.equal(record.affectedScope, 'unknown');
    assert.equal(record.affectedTabCount, 0);
    assert.deepEqual(record.affectedTabs, []);
    assert.equal(record.name, 'network.mojom.NetworkService');
    assert.equal(record.serviceName, 'network');
  });

  it('omits name and serviceName when Electron supplies none', () => {
    const record = describeChildProcessGone({ type: 'GPU', reason: 'launch-failed', exitCode: 1 }, []);
    assert.ok(!('name' in record));
    assert.ok(!('serviceName' in record));
    assert.equal(record.affectedTabCount, 0);
  });

  it('bounds the listed tabs but still reports the real count', () => {
    const many = Array.from({ length: MAX_AFFECTED_TABS + 15 }, (_, i) => ({ id: `t${i}`, url: `https://a.test/${i}` }));
    const record = describeChildProcessGone({ type: 'GPU', reason: 'crashed', exitCode: 1 }, many);
    assert.equal(record.affectedTabs.length, MAX_AFFECTED_TABS);
    assert.equal(record.affectedTabCount, MAX_AFFECTED_TABS + 15);
  });
});
