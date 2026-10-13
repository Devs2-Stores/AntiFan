import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  buildTerminalEnv,
  PTY_SCRUBBED_ENV_VARS,
} from '../../src/main/browser/terminal-manager';

describe('TerminalManager PTY Environment Sanitization', () => {
  it('terminalEnv excludes ANTIFAN_TERMINAL_HOST_TOKEN, ELECTRON_RUN_AS_NODE, CI and CLAUDECODE while retaining ANTIFAN_DATA_ROOT', () => {
    const mockBaseEnv: NodeJS.ProcessEnv = {
      PATH: 'C:\\Windows\\system32',
      ANTIFAN_TERMINAL_HOST_TOKEN: 'secret-token-12345',
      ANTIFAN_TERMINAL_HOST_VERSION: '1.3.6',
      ELECTRON_RUN_AS_NODE: '1',
      CI: 'true',
      CLAUDECODE: '1',
      ANTIFAN_DATA_ROOT: 'E:\\Work\\.antifan-data',
      ANTIFAN_CONFIG_DIR: 'E:\\Work\\.antifan-data\\config',
      USER: 'Admin',
      CUSTOM_VAR: 'retained-value',
    };

    const env = buildTerminalEnv({
      baseEnv: mockBaseEnv,
      envPath: 'E:\\Work\\apps\\AntiFan\\scripts;C:\\Windows\\system32',
      id: 'term-session-1',
      generation: 1,
      affinitySessionId: 'term-session-1',
      affinityGeneration: '1',
    });

    // 1. Assert all sensitive and launcher/runtime leak variables are scrubbed
    for (const scrubKey of PTY_SCRUBBED_ENV_VARS) {
      assert.equal(
        env[scrubKey],
        undefined,
        `Expected ${scrubKey} to be removed from terminal environment`
      );
    }
    assert.equal(env.ANTIFAN_TERMINAL_HOST_TOKEN, undefined);
    assert.equal(env.ANTIFAN_TERMINAL_HOST_VERSION, undefined);
    assert.equal(env.ELECTRON_RUN_AS_NODE, undefined);
    assert.equal(env.CI, undefined);
    assert.equal(env.CLAUDECODE, undefined);

    // 2. Assert ANTIFAN_DATA_ROOT and ANTIFAN_CONFIG_DIR are preserved per Constraint C2
    assert.equal(env.ANTIFAN_DATA_ROOT, 'E:\\Work\\.antifan-data');
    assert.equal(env.ANTIFAN_CONFIG_DIR, 'E:\\Work\\.antifan-data\\config');

    // 3. Assert standard terminal vars are set
    assert.equal(env.PATH, 'E:\\Work\\apps\\AntiFan\\scripts;C:\\Windows\\system32');
    assert.equal(env.TERM, 'xterm-256color');
    assert.equal(env.FORCE_COLOR, '1');
    assert.equal(env.ANTIFAN_TERMINAL_SESSION_ID, 'term-session-1');
    assert.equal(env.ANTIFAN_TERMINAL_GENERATION, '1');
    assert.equal(env.ANTIFAN_TERMINAL_AFFINITY_SESSION_ID, 'term-session-1');
    assert.equal(env.ANTIFAN_TERMINAL_AFFINITY_GENERATION, '1');

    // 4. Assert non-sensitive env variables are preserved
    assert.equal(env.USER, 'Admin');
    assert.equal(env.CUSTOM_VAR, 'retained-value');
  });

  it('buildTerminalEnv incorporates bridge endpoint metadata without tokens', () => {
    const mockBaseEnv: NodeJS.ProcessEnv = {
      PATH: 'C:\\Windows\\system32',
      ANTIFAN_TERMINAL_HOST_TOKEN: 'secret-token-to-scrub',
    };

    const env = buildTerminalEnv({
      baseEnv: mockBaseEnv,
      envPath: 'C:\\Windows\\system32',
      configDir: 'E:\\tmp\\config',
      dataRoot: 'E:\\tmp\\data',
      bridgeEndpoint: { port: 20130, host: '127.0.0.1', pid: 1234 },
      id: 'term-sub-2',
      generation: 2,
      affinitySessionId: 'term-parent-1',
      affinityGeneration: '1',
      parentSessionId: 'term-parent-1',
    });

    assert.equal(env.ANTIFAN_TERMINAL_HOST_TOKEN, undefined);
    assert.equal(env.ANTIFAN_BRIDGE_PORT, '20130');
    assert.equal(env.ANTIFAN_BRIDGE_HOST, '127.0.0.1');
    assert.equal(env.ANTIFAN_BRIDGE_PID, '1234');
    assert.equal(env.ANTIFAN_TERMINAL_PARENT_SESSION_ID, 'term-parent-1');
    assert.equal(env.ANTIFAN_CONFIG_DIR, 'E:\\tmp\\config');
    assert.equal(env.ANTIFAN_DATA_ROOT, 'E:\\tmp\\data');
  });
});
