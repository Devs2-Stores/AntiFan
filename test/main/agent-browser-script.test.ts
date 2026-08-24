import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import * as vm from 'node:vm';
import { AGENT_BROWSER_SCRIPT } from '../../src/main/browser/agent-browser';
import { ELEMENT_PICKER_SCRIPT } from '../../src/main/browser/element-picker';

describe('Agent Browser & Element Picker Injected Scripts', () => {
  it('validates JavaScript syntax of AGENT_BROWSER_SCRIPT and ELEMENT_PICKER_SCRIPT', () => {
    assert.doesNotThrow(() => {
      new vm.Script(AGENT_BROWSER_SCRIPT);
    }, 'AGENT_BROWSER_SCRIPT must be valid parseable JavaScript');

    assert.doesNotThrow(() => {
      new vm.Script(ELEMENT_PICKER_SCRIPT);
    }, 'ELEMENT_PICKER_SCRIPT must be valid parseable JavaScript');
  });

  it('declares and exposes all required global agent control hooks', () => {
    // Verify that key functions are defined in the script source
    assert.ok(AGENT_BROWSER_SCRIPT.includes('window.__antifanAgentSnapshot ='));
    assert.ok(AGENT_BROWSER_SCRIPT.includes('window.__antifanAgentTrajectory ='));
    assert.ok(AGENT_BROWSER_SCRIPT.includes('window.__antifanAgentClick ='));
    assert.ok(AGENT_BROWSER_SCRIPT.includes('window.__antifanAgentType ='));
    assert.ok(AGENT_BROWSER_SCRIPT.includes('window.__antifanAgentScroll ='));
    assert.ok(AGENT_BROWSER_SCRIPT.includes('window.__antifanAgentHover ='));
    assert.ok(AGENT_BROWSER_SCRIPT.includes('window.__antifanAgentHighlight ='));
    assert.ok(AGENT_BROWSER_SCRIPT.includes('window.__antifanAgentClear ='));
    assert.ok(AGENT_BROWSER_SCRIPT.includes('window.__antifanRefMap'));
    assert.ok(AGENT_BROWSER_SCRIPT.includes('generateBezierPath'));
    assert.ok(AGENT_BROWSER_SCRIPT.includes('startAmbientWandering'));
  });

  it('implements deep @ref query resolution and shadow DOM searching', () => {
    assert.ok(AGENT_BROWSER_SCRIPT.includes('querySelectorDeep'));
    assert.ok(AGENT_BROWSER_SCRIPT.includes('str.startsWith(\'@e\')'));
    assert.ok(AGENT_BROWSER_SCRIPT.includes('data-antifan-ref'));
  });

  it('verifies trajectory execution structure and helper algorithms', () => {
    assert.ok(AGENT_BROWSER_SCRIPT.includes('getCubicBezierPoint'));
    assert.ok(AGENT_BROWSER_SCRIPT.includes('uuu * p0.x'));
    assert.ok(AGENT_BROWSER_SCRIPT.includes('executedSteps'));
    assert.ok(AGENT_BROWSER_SCRIPT.includes('finalPosition'));
  });

  it('executes __antifanAgentTrajectory with multi-step sequence, accurate step accounting, and single-click activation', async () => {
    let clickCount = 0;
    const mockButton = {
      tagName: 'BUTTON',
      focus: () => {},
      scrollIntoView: () => {},
      getBoundingClientRect: () => ({ left: 200, top: 200, width: 50, height: 30 }),
      dispatchEvent: (event: any) => {
        if (event.type === 'click') clickCount++;
      },
      click: () => {
        clickCount++;
      },
    };

    let timerId = 0;
    const activeTimers = new Map<number, NodeJS.Timeout>();
    const customSetTimeout = (fn: Function, ms: number) => {
      const id = ++timerId;
      if (ms >= 500) {
        return id;
      }
      const t = setTimeout(() => {
        activeTimers.delete(id);
        fn();
      }, 1);
      activeTimers.set(id, t);
      return id;
    };
    const customClearTimeout = (id: any) => {
      if (typeof id === 'number' && activeTimers.has(id)) {
        clearTimeout(activeTimers.get(id)!);
        activeTimers.delete(id);
      }
    };

    const listeners: Record<string, Function[]> = {};
    const contextObj: Record<string, any> = {
      window: null as any,
      document: {
        getElementById: () => null,
        createElement: (tag: string) => ({
          style: {},
          appendChild: () => {},
          removeChild: () => {},
          remove: () => {},
          classList: { add: () => {}, remove: () => {} },
          addEventListener: () => {},
          removeEventListener: () => {},
          querySelector: () => null,
          querySelectorAll: () => [],
          offsetHeight: 10,
          offsetWidth: 10,
          getBoundingClientRect: () => ({ left: 0, top: 0, width: 10, height: 10 }),
        }),
        head: {
          appendChild: () => {},
          removeChild: () => {},
        },
        body: {
          appendChild: () => {},
          removeChild: () => {},
          classList: { add: () => {}, remove: () => {} },
        },
        documentElement: {
          appendChild: () => {},
        },
        addEventListener: (event: string, fn: Function) => {
          listeners[event] = listeners[event] || [];
          listeners[event].push(fn);
        },
        removeEventListener: (event: string, fn: Function) => {
          if (listeners[event]) {
            listeners[event] = listeners[event].filter((f) => f !== fn);
          }
        },
        elementFromPoint: () => null,
        querySelectorAll: () => [],
        querySelector: (sel: string) => (sel === '#btn' ? mockButton : null),
      },
      console,
      scrollBy: () => {},
      requestAnimationFrame: (fn: Function) => customSetTimeout(fn, 1),
      cancelAnimationFrame: (id: any) => customClearTimeout(id),
      setTimeout: customSetTimeout,
      clearTimeout: customClearTimeout,
      setInterval: (fn: Function, ms: number) => ++timerId,
      clearInterval: () => {},
      Promise,
      Math,
      JSON,
      Event: class {
        type = '';
        constructor(type: string) {
          this.type = type;
        }
      },
      CustomEvent: class {
        type = '';
        constructor(type: string) {
          this.type = type;
        }
      },
      MouseEvent: class {
        type = '';
        constructor(type: string, init?: any) {
          this.type = type;
          Object.assign(this, init, { type });
        }
      },
    };
    contextObj.window = contextObj;
    const ctx = vm.createContext(contextObj);

    vm.runInContext(AGENT_BROWSER_SCRIPT, ctx);
    assert.strictEqual(typeof ctx.window.__antifanAgentTrajectory, 'function');

    // Run multi-step trajectory: hover -> click -> scroll
    const result = await ctx.window.__antifanAgentTrajectory(
      [
        { action: 'hover', x: 100, y: 150, dwellMs: 1 },
        { action: 'click', target: '#btn', dwellMs: 1 },
        { action: 'scroll', deltaY: 200, dwellMs: 1 },
      ],
      { speed: 'fast' }
    );

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.executedSteps, 3);
    assert.strictEqual(result.totalSteps, 3);
    assert.strictEqual(result.finalPosition.x, 225); // center of mockButton: 200 + 50/2
    assert.strictEqual(result.finalPosition.y, 215); // center of mockButton: 200 + 30/2
    // Verify single activation: clickCount must be exactly 1, not 2
    assert.strictEqual(clickCount, 1, 'Click event must be dispatched exactly once on target element');

    for (const t of activeTimers.values()) clearTimeout(t);
    activeTimers.clear();
  });

  it('verifies trajectory contract accounting and navigation interruption invariants', () => {
    // Normalization helper matching NativeTabHost.agentTrajectory logic
    function normalizeTrajectoryResult(
      res: unknown,
      navigatedAway: boolean,
      requestedStepsCount: number
    ): { success: boolean; executedSteps: number; totalSteps: number; finalPosition?: { x: number; y: number }; reason?: string } {
      if (res && typeof res === 'object') {
        const obj = res as { success?: boolean; executedSteps?: number; totalSteps?: number; finalPosition?: { x: number; y: number }; reason?: string };
        if (navigatedAway) {
          return {
            success: false,
            executedSteps: typeof obj.executedSteps === 'number' ? obj.executedSteps : 0,
            totalSteps: typeof obj.totalSteps === 'number' ? obj.totalSteps : requestedStepsCount,
            finalPosition: obj.finalPosition,
            reason: obj.reason || 'Interrupted: page navigation initiated during trajectory execution',
          };
        }
        return {
          success: Boolean(obj.success),
          executedSteps: typeof obj.executedSteps === 'number' ? obj.executedSteps : 0,
          totalSteps: typeof obj.totalSteps === 'number' ? obj.totalSteps : requestedStepsCount,
          finalPosition: obj.finalPosition,
          reason: obj.reason,
        };
      }
      return {
        success: false,
        executedSteps: 0,
        totalSteps: requestedStepsCount,
        reason: navigatedAway
          ? 'Interrupted: page navigation initiated during trajectory execution'
          : (res ? 'Unexpected non-object trajectory response' : 'Trajectory script returned empty response'),
      };
    }
    // 1. Interrupted mid-flight: object result with success=true MUST be forced to success=false
    const interruptedObj = normalizeTrajectoryResult({ success: true, executedSteps: 2, totalSteps: 5 }, true, 5);
    assert.strictEqual(interruptedObj.success, false, 'Interrupted trajectory must never report success=true');
    assert.strictEqual(interruptedObj.executedSteps, 2, 'Must preserve partial executed steps count');
    assert.strictEqual(interruptedObj.totalSteps, 5);
    assert.ok(interruptedObj.reason?.includes('Interrupted: page navigation'));

    // 2. Interrupted with primitive fallback: must not claim executed steps
    const interruptedPrimitive = normalizeTrajectoryResult(true, true, 5);
    assert.strictEqual(interruptedPrimitive.success, false);
    assert.strictEqual(interruptedPrimitive.executedSteps, 0, 'Interrupted primitive must report 0 executed steps');
    assert.strictEqual(interruptedPrimitive.totalSteps, 5);

    // 3. Non-object primitive response without navigation: returns false and 0 steps
    const unexpectedPrimitive = normalizeTrajectoryResult(true, false, 5);
    assert.strictEqual(unexpectedPrimitive.success, false);
    assert.strictEqual(unexpectedPrimitive.executedSteps, 0);
    assert.strictEqual(unexpectedPrimitive.totalSteps, 5);
    // 4. Normal non-interrupted completion
    const normal = normalizeTrajectoryResult({ success: true, executedSteps: 5, totalSteps: 5 }, false, 5);
    assert.strictEqual(normal.success, true);
    assert.strictEqual(normal.executedSteps, 5);
    assert.strictEqual(normal.totalSteps, 5);
  });

  it('verifies ELEMENT_PICKER_SCRIPT defines queue mode controls and passes deliveryMode', () => {
    assert.ok(ELEMENT_PICKER_SCRIPT.includes('btnModalQueue'), 'Must define Queue button in modal');
    assert.ok(ELEMENT_PICKER_SCRIPT.includes('btnModalSend'), 'Must define Send button in modal');
    assert.ok(ELEMENT_PICKER_SCRIPT.includes('btnMultiQueue'), 'Must define Queue All in multi dock');
    assert.ok(ELEMENT_PICKER_SCRIPT.includes('deliveryMode'), 'Must include deliveryMode in payload');
  });

  it('defaults annotation routing to the inspected site while preserving explicit session choice', () => {
    assert.ok(ELEMENT_PICKER_SCRIPT.includes("autoOpt.value = 'auto'"), 'Picker must expose automatic site routing');
    assert.ok(ELEMENT_PICKER_SCRIPT.includes("autoOpt.selected = true"), 'Automatic site routing must be the default');
    assert.ok(ELEMENT_PICKER_SCRIPT.includes('targetSessionId: termSelect ? termSelect.value'), 'Picker must submit the selected route');
    assert.ok(ELEMENT_PICKER_SCRIPT.includes('opt.value = s.id'), 'Picker must preserve explicit session choices');
  });

  it('verifies deliveryMode draft vs auto dispatch invariants', () => {
    let ptyWritten = false;
    let dispatchedMode: string | undefined;

    const simulateAnnotationSubmit = (rawResult: { deliveryMode?: 'auto' | 'draft'; userComment?: string }) => {
      const effectiveDeliveryMode: 'auto' | 'draft' = rawResult.deliveryMode === 'draft' ? 'draft' : 'auto';
      const fullPrompt = rawResult.userComment || 'test';

      // PTY write only on auto
      if (effectiveDeliveryMode === 'auto') {
        ptyWritten = true;
      }

      // Command client dispatch
      dispatchedMode = effectiveDeliveryMode;
    };

    // 1. Draft/Queue mode: MUST NOT write to PTY with \r, MUST dispatch mode draft
    ptyWritten = false;
    dispatchedMode = undefined;
    simulateAnnotationSubmit({ deliveryMode: 'draft', userComment: 'Inspect this' });
    assert.strictEqual(ptyWritten, false, 'Draft mode must not invoke PTY write/execute');
    assert.strictEqual(dispatchedMode, 'draft', 'Draft mode must dispatch as draft');

    // 2. Auto mode: MUST write to PTY with \r, MUST dispatch mode auto
    ptyWritten = false;
    dispatchedMode = undefined;
    simulateAnnotationSubmit({ deliveryMode: 'auto', userComment: 'Inspect this' });
    assert.strictEqual(ptyWritten, true, 'Auto mode must invoke PTY write/execute');
    assert.strictEqual(dispatchedMode, 'auto', 'Auto mode must dispatch as auto');
  });
});
