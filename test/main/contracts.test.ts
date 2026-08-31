import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  TOOLBAR_CHANNELS,
  FRAME_BACKDROP_CHANNELS,
  SIDEBAR_CHANNELS,
  TERMINAL_CHANNELS,
} from '../../src/shared/contracts';

describe('AntiFan Shared Protocol Contracts & IPC Table Invariants', () => {
  it('enforces namespacing, non-emptiness, and zero cross-channel collisions across all IPC namespaces', () => {
    const namespaces = [
      { name: 'TOOLBAR_CHANNELS', map: TOOLBAR_CHANNELS },
      { name: 'FRAME_BACKDROP_CHANNELS', map: FRAME_BACKDROP_CHANNELS },
      { name: 'SIDEBAR_CHANNELS', map: SIDEBAR_CHANNELS },
      { name: 'TERMINAL_CHANNELS', map: TERMINAL_CHANNELS },
    ];

    const seenChannels = new Map<string, string>();

    for (const ns of namespaces) {
      const keys = Object.keys(ns.map);
      const values = Object.values(ns.map) as string[];

      assert.ok(keys.length > 0, `Namespace ${ns.name} must not be empty`);

      // 1. Invariant: Every channel identifier must be non-empty and start with 'antifan:'
      for (const val of values) {
        assert.strictEqual(typeof val, 'string');
        assert.ok(val.length > 0, `Channel value in ${ns.name} must be non-empty`);
        assert.ok(
          val.startsWith('antifan:'),
          `Channel '${val}' in ${ns.name} must start with 'antifan:' namespace prefix`
        );

        // 2. Invariant: Zero collisions across any namespace
        if (seenChannels.has(val)) {
          assert.fail(`IPC Channel collision detected: '${val}' is defined in both ${seenChannels.get(val)} and ${ns.name}`);
        }
        seenChannels.set(val, ns.name);
      }

      // 3. Invariant: Keys within the same namespace must map to unique channel strings
      const uniqueValues = new Set(values);
      assert.strictEqual(
        uniqueValues.size,
        values.length,
        `Namespace ${ns.name} contains internal duplicate channel strings`
      );
    }

    // Verify minimum contract footprint
    assert.ok(seenChannels.size >= 50, `Expected at least 50 IPC channel definitions, found ${seenChannels.size}`);
  });
});
