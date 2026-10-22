import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { releaseAgentHandles, settleConsoleListOnAgentExit } from '../../src/main/browser/pty-agent-teardown';

class FakeListAgent extends EventEmitter {
  public killed = false;
  public refed = true;
  public channelRefed = true;
  public readonly channel = { unref: () => { this.channelRefed = false; } };
  kill(): boolean { this.killed = true; return true; }
  unref(): void { this.refed = false; }
}

function conptyTerminal(innerPid = 4242) {
  const original = async () => [innerPid];
  return { _agent: { _useConpty: true, _useConptyDll: false, _innerPid: innerPid, _getConsoleProcessList: original }, original };
}

describe('settleConsoleListOnAgentExit', () => {
  it('settles with the shell pid as soon as the agent dies without replying', async () => {
    const terminal = conptyTerminal();
    const agent = new FakeListAgent();
    let forkedFor = 0;
    settleConsoleListOnAgentExit(terminal, (pid) => { forkedFor = pid; return agent as unknown as ChildProcess; });
    const pending = terminal._agent._getConsoleProcessList();
    assert.equal(forkedFor, 4242);
    // The kill closed the console the agent attached to: it exits with no reply.
    agent.emit('close', 1, null);
    const startedAt = Date.now();
    assert.deepEqual(await pending, [4242]);
    assert.ok(Date.now() - startedAt < 1_000, 'no wait for the 5 s fallback');
    assert.equal(agent.killed, false);
  });

  it('returns the reply when the agent answers, even if close follows', async () => {
    const terminal = conptyTerminal();
    const agent = new FakeListAgent();
    settleConsoleListOnAgentExit(terminal, () => agent as unknown as ChildProcess);
    const pending = terminal._agent._getConsoleProcessList();
    agent.emit('message', { consoleProcessList: [4242, 777, 'junk'] });
    agent.emit('close', 0, null);
    assert.deepEqual(await pending, [4242, 777]);
  });

  it('never holds the thread open: the agent, its IPC channel and the fallback timer are unref-d', () => {
    const terminal = conptyTerminal();
    const agent = new FakeListAgent();
    settleConsoleListOnAgentExit(terminal, () => agent as unknown as ChildProcess);
    void terminal._agent._getConsoleProcessList();
    assert.equal(agent.refed, false);
    assert.equal(agent.channelRefed, false);
    agent.emit('close', 1, null);
  });

  it('falls back to the shell pid when the agent cannot be forked', async () => {
    const terminal = conptyTerminal();
    settleConsoleListOnAgentExit(terminal, () => { throw new Error('spawn EPERM'); });
    assert.deepEqual(await terminal._agent._getConsoleProcessList(), [4242]);
  });

  it('leaves winpty and conpty.dll agents (no list agent) untouched', () => {
    const winpty = { _agent: { _useConpty: false, _getConsoleProcessList: async () => [1] } };
    const dll = { _agent: { _useConpty: true, _useConptyDll: true, _getConsoleProcessList: async () => [1] } };
    const winptyBefore = winpty._agent._getConsoleProcessList;
    const dllBefore = dll._agent._getConsoleProcessList;
    settleConsoleListOnAgentExit(winpty, () => { throw new Error('must not fork'); });
    settleConsoleListOnAgentExit(dll, () => { throw new Error('must not fork'); });
    settleConsoleListOnAgentExit(null);
    settleConsoleListOnAgentExit({});
    assert.equal(winpty._agent._getConsoleProcessList, winptyBefore);
    assert.equal(dll._agent._getConsoleProcessList, dllBefore);
  });
});

function agentWithHandles() {
  const calls: string[] = [];
  const drainTimeout = setTimeout(() => calls.push('drain-fired'), 50);
  const agent = {
    _conoutSocketWorker: {
      _isDisposed: false,
      _drainTimeout: drainTimeout as NodeJS.Timeout | undefined,
      _worker: { terminate: async () => { calls.push('relay-terminated'); return 1; } },
    },
    _inSocket: { destroy: () => { calls.push('in-destroyed'); } },
    _outSocket: { destroy: () => { calls.push('out-destroyed'); } },
    _flushDataAndCleanUp: () => { calls.push('flush-scheduled'); },
  };
  return { agent, calls };
}

describe('releaseAgentHandles', () => {
  it('stops the relay at once, closes both pipes and disarms the post-exit flush', async () => {
    const { agent, calls } = agentWithHandles();
    releaseAgentHandles({ _isReady: true, _agent: agent });
    assert.equal(agent._conoutSocketWorker._isDisposed, true, 'a later node-pty dispose is a no-op');
    agent._flushDataAndCleanUp();
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.deepEqual(calls, ['relay-terminated', 'in-destroyed', 'out-destroyed']);
  });

  it('is idempotent, so a kill followed by the exit it causes releases nothing twice that throws', () => {
    const { agent } = agentWithHandles();
    releaseAgentHandles({ _isReady: true, _agent: agent });
    assert.doesNotThrow(() => releaseAgentHandles({ _isReady: true, _agent: agent }));
  });

  it('keeps the handles of a terminal that never became ready, whose node-pty kill is still queued', async () => {
    const { agent, calls } = agentWithHandles();
    releaseAgentHandles({ _isReady: false, _agent: agent });
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.deepEqual(calls, ['drain-fired']);
    assert.equal(agent._conoutSocketWorker._isDisposed, false);
  });

  it('ignores objects without a node-pty agent (worker proxies, non-Windows ptys)', () => {
    assert.doesNotThrow(() => releaseAgentHandles(null));
    assert.doesNotThrow(() => releaseAgentHandles({ pid: 1 }));
  });
});
