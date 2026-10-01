/**
 * The WMI spawn hands Windows one command line for the host, and the host reads its handshake,
 * log and cwd paths back out of argv. A path the quoting mangles is a host that never publishes a
 * handshake, which silently costs every live terminal on the next GUI restart. So the contract is
 * checked against the real parser: a child process echoes the argv Windows gave it.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { quoteWindowsArg } from '../../src/main/terminal-daemon/daemon-spawner';

const SAMPLES = [
  'C:\\Program Files\\nodejs\\node.exe',
  'E:\\',
  'C:\\Temp\\antifan tree&kill (probe)\\daemon.log',
  'C:\\100%USERPROFILE%\\x',
  'say "hi"',
  'back\\"slash',
  'trailing space\\\\',
  '',
  'plain',
];

describe('daemon spawner: Windows argv quoting', { skip: process.platform !== 'win32' }, () => {
  it('round-trips every path shape through the real command-line parser', () => {
    const script = 'process.stdout.write(JSON.stringify(process.argv.slice(1)))';
    // Verbatim mode joins argv0 and the args unquoted: the exact line spawnViaWmi hands WMI.
    const run = spawnSync(process.execPath, ['-e', script, ...SAMPLES].map(quoteWindowsArg), {
      windowsVerbatimArguments: true,
      argv0: quoteWindowsArg(process.execPath),
      encoding: 'utf8',
    });
    assert.ifError(run.error);
    assert.equal(run.status, 0, run.stderr);
    assert.deepEqual(JSON.parse(run.stdout), SAMPLES);
  });
});
