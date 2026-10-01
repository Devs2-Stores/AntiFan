/**
 * What the terminal panel says when Main refuses to create a session.
 *
 * Session creation is main-side, so a rejection is the only explanation the renderer ever gets;
 * before this funnel an ignored rejection left the button inert with nothing said anywhere. The
 * surface has to be the panel's own, because Main hides the shell chip for a shell it has not
 * described — a refusal painted there lands in an element the user cannot see.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { loadStandalone, type FakeElement, type StandaloneHarness } from './standalone-harness';

async function flush(rounds = 6): Promise<void> {
  for (let round = 0; round < rounds; round += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

type NoticeLike = { textContent: string; style: Record<string, string> } | null;

function notice(harness: StandaloneHarness): NoticeLike {
  return harness.read<NoticeLike>('terminalNoticeEl');
}

function newTerminalButton(harness: StandaloneHarness): FakeElement | null {
  return harness.elements.get('btnNewTerminal') ?? null;
}

function chip(harness: StandaloneHarness): FakeElement | null {
  return harness.standaloneRoot.querySelector('#shellScopeChip');
}

describe('terminal creation refusal', () => {
  it('names the refusal in the panel, even when Main has not described the shell', async () => {
    // No `projectWindow` in the initial state: the chip is hidden, so the notice is the only
    // surface the user has.
    const harness = loadStandalone({ initialState: {} });
    await flush();
    harness.api.newTerminal = async () => {
      throw new Error('TARGET_REQUIRED: no window owns this shell');
    };

    assert.strictEqual(chip(harness)?.style.display, 'none', 'the hidden chip is why the notice exists');

    newTerminalButton(harness)?.dispatch('click');
    await flush();

    const reported = notice(harness);
    assert.ok(reported, 'the failure created a readable notice');
    assert.strictEqual(reported?.style.display, 'block');
    assert.match(reported?.textContent ?? '', /Không tạo được Terminal/);
    assert.match(reported?.textContent ?? '', /TARGET_REQUIRED/, 'the machine reason reaches the user verbatim');
  });

  it('names no cwd, even when the boot scope had one, and stays quiet when Main accepts', async () => {
    const harness = loadStandalone({
      initialState: {
        projectWindow: {
          owner: { kind: 'project', projectId: 'project-alpha' },
          title: 'Alpha',
          pathLabel: 'E:\\Work\\alpha',
          workspacePath: 'E:\\Work\\alpha',
        },
      },
    });
    await flush();
    const calls: Array<unknown[]> = [];
    harness.api.newTerminal = async (...args: unknown[]) => {
      calls.push(args);
      return undefined;
    };

    newTerminalButton(harness)?.dispatch('click');
    await flush();

    // The boot scope is a snapshot: after the hub switches project it still names the old
    // folder, so Main must resolve the folder from the window's current project itself.
    assert.deepStrictEqual(calls, [[]], 'creation sends no stale boot-time folder');
    assert.notStrictEqual(notice(harness)?.style.display, 'block', 'a creation that worked says nothing');
  });

  it('reports a preload that cannot create a session instead of doing nothing', async () => {
    const harness = loadStandalone({ initialState: {} });
    await flush();
    // A preload with no such member: assigning `undefined` leaves the property present-but-empty,
    // which is what `api?.newTerminal` sees on an older bridge.
    (harness.api as unknown as Record<string, unknown>).newTerminal = undefined;

    newTerminalButton(harness)?.dispatch('click');
    await flush();

    const reported = notice(harness);
    assert.strictEqual(reported?.style.display, 'block');
    assert.match(reported?.textContent ?? '', /preload thiếu newTerminal/);
  });
});
