import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  classifyProjectTerminals,
  createProjectInactivityCloser,
  type ProjectInactivityReason,
  type ProjectTerminalState,
} from '../../src/main/project/project-inactivity-closer';

function harness(initial: Record<string, ProjectTerminalState>, windows: string[], lastVisible: string[] = []) {
  const states = new Map<string, ProjectTerminalState>(Object.entries(initial));
  const closed: Array<[string, ProjectInactivityReason]> = [];
  const closer = createProjectInactivityCloser({
    windowProjectIds: () => windows,
    terminalStates: () => states,
    isLastVisibleWindow: (id) => lastVisible.includes(id),
    closeWindow: (id, reason) => closed.push([id, reason]),
  });
  return { states, closed, closer, windows };
}

describe('createProjectInactivityCloser', () => {
  it('closes the window when the last running terminal sleeps', () => {
    const h = harness({ a: 'running' }, ['a']);
    h.closer.evaluate();
    assert.deepEqual(h.closed, []);
    h.states.set('a', 'idle');
    h.closer.evaluate();
    assert.deepEqual(h.closed, [['a', 'terminals-stopped']]);
  });

  it('closes when the last terminal is closed outright', () => {
    const h = harness({ a: 'running' }, ['a']);
    h.closer.evaluate();
    h.states.delete('a');
    h.closer.evaluate();
    assert.deepEqual(h.closed, [['a', 'terminals-stopped']]);
  });

  it('leaves a window opened for a project that was never seen running', () => {
    const h = harness({ a: 'idle' }, ['a', 'b']);
    h.closer.evaluate();
    h.closer.evaluate();
    assert.deepEqual(h.closed, []);
  });

  it('tracks a terminal that started before its project had a window', () => {
    const windows: string[] = [];
    const h = harness({ a: 'running' }, windows);
    h.closer.evaluate();
    windows.push('a');
    h.states.set('a', 'idle');
    h.closer.evaluate();
    assert.deepEqual(h.closed, [['a', 'terminals-stopped']]);
  });

  it('fires once per stop, and again only after the project runs again', () => {
    const h = harness({ a: 'running' }, ['a']);
    h.closer.evaluate();
    h.states.set('a', 'idle');
    h.closer.evaluate();
    h.closer.evaluate();
    assert.equal(h.closed.length, 1);
    h.states.set('a', 'running');
    h.closer.evaluate();
    h.states.set('a', 'idle');
    h.closer.evaluate();
    assert.equal(h.closed.length, 2);
  });

  it('closes only the project that stopped', () => {
    const h = harness({ a: 'running', b: 'running' }, ['a', 'b']);
    h.closer.evaluate();
    h.states.set('b', 'idle');
    h.closer.evaluate();
    assert.deepEqual(h.closed, [['b', 'terminals-stopped']]);
  });

  it('keeps the window that is the last one on screen, so a sleep never ends the app', () => {
    const h = harness({ a: 'running' }, ['a'], ['a']);
    h.closer.evaluate();
    h.states.set('a', 'idle');
    h.closer.evaluate();
    assert.deepEqual(h.closed, []);
  });

  it('does not close a window the project no longer has, but remembers the stop', () => {
    const h = harness({ a: 'running' }, ['a']);
    h.closer.evaluate();
    h.windows.length = 0;
    h.states.set('a', 'idle');
    h.closer.evaluate();
    h.windows.push('a');
    h.closer.evaluate();
    assert.deepEqual(h.closed, []);
  });

  it('a window reopened before the next check does not inherit the old window\'s baseline', () => {
    const h = harness({ a: 'running' }, ['a']);
    h.closer.evaluate();
    h.states.delete('a');
    h.closer.windowOpened('a');
    h.closer.evaluate();
    assert.deepEqual(h.closed, []);
  });

  it('a window opened while a terminal runs still closes when it stops', () => {
    const windows: string[] = [];
    const h = harness({ a: 'running' }, windows);
    windows.push('a');
    h.closer.windowOpened('a');
    h.states.set('a', 'idle');
    h.closer.evaluate();
    assert.deepEqual(h.closed, [['a', 'terminals-stopped']]);
  });

  it('closeIdleWindows closes only projects that have terminals but none running', () => {
    const h = harness({ a: 'idle', c: 'running' }, ['a', 'b', 'c']);
    h.closer.closeIdleWindows();
    assert.deepEqual(h.closed, [['a', 'terminal-manager-closed']]);
  });
});

describe('classifyProjectTerminals', () => {
  it('a project with a running terminal is running, even when another sleeps', () => {
    const states = classifyProjectTerminals([
      { projectId: 'a', state: 'sleeping' },
      { projectId: 'a', state: 'running' },
      { projectId: 'a', state: 'exited' },
    ]);
    assert.equal(states.get('a'), 'running');
  });

  it('sleeping and exited terminals leave the project idle; closed ones do not count', () => {
    const states = classifyProjectTerminals([
      { projectId: 'a', state: 'sleeping' },
      { projectId: 'b', state: 'exited' },
      { projectId: 'c', state: 'closed' },
    ]);
    assert.equal(states.get('a'), 'idle');
    assert.equal(states.get('b'), 'idle');
    assert.equal(states.has('c'), false);
  });

  it('an autostarted sync watcher neither keeps the project running nor makes it idle', () => {
    const watcher = { projectId: 'a', state: 'running', role: 'sync', idlePolicy: 'never' };
    assert.equal(classifyProjectTerminals([watcher, { projectId: 'a', state: 'sleeping' }]).get('a'), 'idle');
    assert.equal(classifyProjectTerminals([watcher]).has('a'), false);
  });
});
