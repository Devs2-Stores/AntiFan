/**
 * Auxiliary window close: every request ends in a terminal outcome.
 *
 * The application quit waits on this before it touches shared services, and it commits only
 * on `closed`. A wait with no outcome is therefore not slow, it is a lockout: the attempt
 * never settles, every later request coalesces into it, and application admission stays
 * closed with the window still standing. These rows drive the gate's own state machine with
 * the window surface faked, including the ordering this platform really produces (a close
 * issued while a previous refusal is still being processed is answered with nothing at all).
 */
import { describe, it, mock } from 'node:test';
import * as assert from 'node:assert/strict';
import { setImmediate as yieldToLoop } from 'node:timers/promises';
import type { BrowserWindow } from 'electron';
import { AUXILIARY_CLOSE_OUTCOME_DEADLINE_MS, closeAuxiliaryWindow } from '../../src/main/browser/auxiliary-close';

type Listener = (...args: never[]) => void;

/** The window surface `closeAuxiliaryWindow` uses, so a script reads as the platform's answer. */
interface FakeWindow {
  isDestroyed(): boolean;
  close(): void;
  once(event: string, listener: Listener): void;
  removeListener(event: string, listener: Listener): void;
  emit(event: string, ...args: never[]): number;
  webContents: {
    isDestroyed(): boolean;
    once(event: string, listener: Listener): void;
    removeListener(event: string, listener: Listener): void;
    emit(event: string, ...args: never[]): number;
  };
  state: { destroyed: boolean; closes: number };
}

/**
 * The window surface `closeAuxiliaryWindow` uses, with the platform's answers scripted:
 * `onClose` is what the window does when the gate asks it to close.
 */
function fakeWindow(onClose: (window: FakeWindow) => void): FakeWindow {
  const listeners = new Map<string, Listener[]>();
  const state = { destroyed: false, closes: 0 };
  const window: FakeWindow = {
    isDestroyed: () => state.destroyed,
    close: () => {
      state.closes += 1;
      onClose(window);
    },
    once: (event: string, listener: Listener) => {
      listeners.set(event, [...(listeners.get(event) ?? []), listener]);
    },
    removeListener: (event: string, listener: Listener) => {
      listeners.set(event, (listeners.get(event) ?? []).filter((entry) => entry !== listener));
    },
    emit: (event: string, ...args: never[]) => {
      const dispatched = listeners.get(event) ?? [];
      listeners.delete(event);
      for (const listener of dispatched) listener(...args);
      return dispatched.length;
    },
    webContents: {
      isDestroyed: () => state.destroyed,
      once: (event: string, listener: Listener) => {
        listeners.set(`contents:${event}`, [...(listeners.get(`contents:${event}`) ?? []), listener]);
      },
      removeListener: (event: string, listener: Listener) => {
        listeners.set(`contents:${event}`, (listeners.get(`contents:${event}`) ?? []).filter((entry) => entry !== listener));
      },
      emit: (event: string, ...args: never[]) => {
        const dispatched = listeners.get(`contents:${event}`) ?? [];
        listeners.delete(`contents:${event}`);
        for (const listener of dispatched) listener(...args);
        return dispatched.length;
      },
    },
    state,
  };
  return window;
}


/** The platform's real answer to a close issued while a previous refusal is in flight: nothing. */
describe('auxiliary window close outcome', () => {
  it('reports unknown, not a wait, when the platform answers a close with nothing', async () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    try {
      const window = fakeWindow(() => {});
      const pending = closeAuxiliaryWindow(window as unknown as BrowserWindow, 40);
      await yieldToLoop();
      assert.equal(window.state.closes, 1, 'the window was asked to close');

      mock.timers.tick(40);
      assert.equal(await pending, 'unknown', 'no terminal outcome is an outcome: unknown refuses the commit');
      assert.equal(window.state.destroyed, false, 'and the window is left standing for the next request');
    } finally {
      mock.timers.reset();
    }
  });

  it('reports closed when the window reports it closed', async () => {
    const window = fakeWindow((self) => {
      self.emit('close', { defaultPrevented: false } as never);
      self.state.destroyed = true;
      self.emit('closed');
    });
    assert.equal(await closeAuxiliaryWindow(window as unknown as BrowserWindow, 40), 'closed');
  });

  it('reports vetoed when the renderer refuses before unloading', async () => {
    const window = fakeWindow((self) => {
      self.emit('close', { defaultPrevented: false } as never);
      self.webContents.emit('will-prevent-unload');
    });
    assert.equal(await closeAuxiliaryWindow(window as unknown as BrowserWindow, 40), 'vetoed');
  });

  it('reports vetoed when the platform already cancelled the close it dispatched', async () => {
    const window = fakeWindow((self) => {
      self.emit('close', { defaultPrevented: true } as never);
    });
    assert.equal(await closeAuxiliaryWindow(window as unknown as BrowserWindow, 40), 'vetoed');
  });

  it('answers a destroyed window as closed without asking it to close', async () => {
    const window = fakeWindow(() => {});
    window.state.destroyed = true;
    assert.equal(await closeAuxiliaryWindow(window as unknown as BrowserWindow, 40), 'closed');
    assert.equal(window.state.closes, 0);
  });

  it('answers a swallowed close as unknown at the production bound, leaving the window standing', async () => {
    // `index.ts` builds every auxiliary surface's `closeSelf` as `closeAuxiliaryWindow(window)`,
    // so the bound an unanswered close lands on is the default one, not an injected test value.
    mock.timers.enable({ apis: ['setTimeout'] });
    try {
      const window = fakeWindow(() => {});
      const pending = closeAuxiliaryWindow(window as unknown as BrowserWindow);
      await yieldToLoop();
      assert.equal(window.state.closes, 1, 'the window was asked to close');

      mock.timers.tick(AUXILIARY_CLOSE_OUTCOME_DEADLINE_MS);
      assert.equal(await pending, 'unknown', 'silence at the default bound is unknown, never a healthy answer');
      assert.equal(window.state.destroyed, false, 'the bound never destroys the window: a later request can ask again');
    } finally {
      mock.timers.reset();
    }
  });
});
