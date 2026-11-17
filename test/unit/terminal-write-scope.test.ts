/**
 * AT-2 scope proof: `terminal.write` is not a blanket shell grant. The handler calls
 * assertTerminalOwnership, which limits a bound (non-leader) caller to the live split panes
 * under its own home terminal, and refuses its home shell and any foreign terminal. A Leader
 * may reach other live terminals but never its own home shell.
 *
 * This pins the handler-level rule directly (the tab-host test pins a different layer).
 */
import { test } from 'node:test';
import assert from 'node:assert';
import { assertTerminalOwnership } from '../../src/main/tools/terminal-capabilities';
import type { TerminalCallerScope } from '../../src/main/tools/terminal-capabilities';

const OWN = 'terminal-home-1';
const OTHER = 'terminal-foreign-9';

type BoundScope = Extract<TerminalCallerScope, { bound: true }>;

const BASE: BoundScope = {
  bound: true,
  attachmentId: 'attachment-a',
  tabId: 'tab-a',
  homeId: OWN,
  leader: false,
  ownership: {
    ownerTabId: (attachmentId: string) => (attachmentId === 'attachment-a' ? 'tab-a' : undefined),
    homeTerminalId: (attachmentId: string) => (attachmentId === 'attachment-a' ? OWN : undefined),
    isHomeSplit: (home: string, other: string) => home === OWN && other === 'terminal-split-2',
    tabAffiliation: (tabId: string) => ({ live: tabId === 'tab-a' }),
    isLiveTerminal: (id: string) => id !== 'terminal-dead',
  },
};

function scope(over: Partial<BoundScope> = {}): TerminalCallerScope {
  return { ...BASE, ...over };
}

const codeOf = (fn: () => void): string | undefined => {
  try {
    fn();
    return undefined;
  } catch (err) {
    return (err as { code?: string }).code;
  }
};

test('a write-grant caller reaches its own split pane and is refused everywhere else', () => {
  assert.equal(codeOf(() => assertTerminalOwnership(scope(), 'terminal-split-2')), undefined, 'own split pane is allowed');
  assert.equal(codeOf(() => assertTerminalOwnership(scope(), OWN)), 'TERMINAL_FORBIDDEN', 'its own home shell is refused');
  assert.equal(codeOf(() => assertTerminalOwnership(scope(), OTHER)), 'TERMINAL_FORBIDDEN', 'a foreign terminal is refused');
  assert.equal(codeOf(() => assertTerminalOwnership(scope(), 'terminal-dead')), 'TERMINAL_FORBIDDEN', 'a dead terminal is refused');
});

test('a Leader reaches another live terminal but never its own home shell', () => {
  const leader = scope({ leader: true });
  assert.equal(codeOf(() => assertTerminalOwnership(leader, OTHER)), undefined, 'a live foreign terminal is reachable for a Leader');
  assert.equal(codeOf(() => assertTerminalOwnership(leader, OWN)), 'TERMINAL_FORBIDDEN', 'the Leader home shell stays off limits');
  assert.equal(codeOf(() => assertTerminalOwnership(leader, 'terminal-dead')), 'TERMINAL_FORBIDDEN', 'a dead terminal is refused');
});

test('an unbound caller (no attachment) is not scope-checked here', () => {
  assert.equal(codeOf(() => assertTerminalOwnership({ bound: false }, OTHER)), undefined);
});
