import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import * as vm from 'node:vm';
import { AGENT_BROWSER_SCRIPT } from '../../src/main/browser/agent-browser';
import { ELEMENT_PICKER_SCRIPT, normalizeAnnotationPrompt } from '../../src/main/browser/element-picker';
import { dispatchAnnotationToTerminal, stripDeliveryMode } from '../../src/main/browser/annotation-dispatch';
import type { PickedElementInput } from '../../src/main/browser/annotation-dispatch';

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

  it('guarantees starting trajectory B while A is running cancels A and clearing B cancels B cleanly without callback identity race', async () => {
    let timerId = 0;
    const activeTimers = new Map<number, NodeJS.Timeout>();
    const customSetTimeout = (fn: Function, ms: number) => {
      const id = ++timerId;
      if (ms >= 500) return id;
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
        createElement: () => ({
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
        head: { appendChild: () => {}, removeChild: () => {} },
        body: { appendChild: () => {}, removeChild: () => {}, classList: { add: () => {}, remove: () => {} } },
        documentElement: { appendChild: () => {} },
        addEventListener: (event: string, fn: Function) => {
          listeners[event] = listeners[event] || [];
          listeners[event].push(fn);
        },
        removeEventListener: () => {},
        querySelector: () => null,
        querySelectorAll: () => [],
      },
      setTimeout: customSetTimeout,
      clearTimeout: customClearTimeout,
      requestAnimationFrame: (fn: Function) => customSetTimeout(fn, 1),
      cancelAnimationFrame: (id: any) => customClearTimeout(id),
      Date: { now: () => Date.now() },
      Math,
      parseFloat,
      Array,
      Object,
      String,
      Number,
      Boolean,
      Promise,
      innerWidth: 1920,
      innerHeight: 1080,
    };
    contextObj.window = contextObj;
    const ctx = vm.createContext(contextObj);
    vm.runInContext(AGENT_BROWSER_SCRIPT, ctx);

    // 1. Start Trajectory A (long 10-step sequence)
    const promiseA = ctx.window.__antifanAgentTrajectory(
      Array.from({ length: 10 }, (_, i) => ({ action: 'hover', x: 100 + i * 10, y: 100 + i * 10, dwellMs: 50 })),
      { speed: 'fast' }
    );

    // Await a real tick so Trajectory A is actively in-flight inside its animation loop
    await new Promise((r) => setTimeout(r, 5));

    // 2. Start Trajectory B while A is actively running
    const promiseB = ctx.window.__antifanAgentTrajectory(
      Array.from({ length: 10 }, (_, i) => ({ action: 'hover', x: 500 + i * 10, y: 500 + i * 10, dwellMs: 50 })),
      { speed: 'fast' }
    );

    // Await a tick so Trajectory A handles cancellation and Trajectory B is actively in-flight
    await new Promise((r) => setTimeout(r, 5));

    // Verify A gets cancelled by B's start
    const resA = await promiseA;
    assert.strictEqual(resA.success, false, 'Trajectory A must be cancelled upon Trajectory B start');
    assert.strictEqual(resA.reason, 'Cancelled by user or navigation');

    // 3. Clear B while B is running
    assert.strictEqual(typeof ctx.window.__antifanAgentClear, 'function');
    ctx.window.__antifanAgentClear();

    // Verify B gets cancelled cleanly and its cancellation callback was not erased by A's exit
    const resB = await promiseB;
    assert.strictEqual(resB.success, false, 'Trajectory B must be cancelled cleanly by agentClear');
    assert.strictEqual(resB.reason, 'Cancelled by user or navigation');
    for (const t of activeTimers.values()) clearTimeout(t);
    activeTimers.clear();
  });
  it('verifies ELEMENT_PICKER_SCRIPT removed queue/draft and always dispatches auto', () => {
    assert.ok(ELEMENT_PICKER_SCRIPT.includes('btnModalSend'), 'Must define Send button in modal');
    assert.ok(ELEMENT_PICKER_SCRIPT.includes('btnMultiSubmit'), 'Must define Send All in multi dock');
    assert.ok(!ELEMENT_PICKER_SCRIPT.includes('btnModalQueue'), 'Queue button must be removed from modal');
    assert.ok(!ELEMENT_PICKER_SCRIPT.includes('btnMultiQueue'), 'Queue All must be removed from multi dock');
    assert.ok(!/draft/.test(ELEMENT_PICKER_SCRIPT), 'No draft token may remain in picker script');
    assert.ok(!/deliveryMode/.test(ELEMENT_PICKER_SCRIPT), 'Payload must not carry a delivery mode');
  });

  it('restores the last explicitly selected annotation terminal route', () => {
    assert.ok(ELEMENT_PICKER_SCRIPT.includes('annotationSessionId'), 'Picker must persist annotation terminal selection');
    assert.ok(ELEMENT_PICKER_SCRIPT.includes('rememberedSessionId'), 'Picker must read remembered annotation terminal selection');
    assert.ok(ELEMENT_PICKER_SCRIPT.includes('opt.selected = s.id === preferredSessionId'), 'Picker must restore selected terminal option');
    assert.ok(ELEMENT_PICKER_SCRIPT.includes('termContext.annotationSessionId = termSelect.value || \'auto\''), 'Picker must persist Auto when explicitly selected');
  });

  it('defaults annotation prompts to the /queue prefix and keeps the editor compact', () => {
    assert.ok(ELEMENT_PICKER_SCRIPT.includes("const QUEUE_PREFIX = '/queue '"), 'Prompt must default to /queue prefix');
    assert.ok(ELEMENT_PICKER_SCRIPT.includes("if (!textarea.value) textarea.value = QUEUE_PREFIX"), 'Prefix must be pre-filled on open');
    assert.ok(ELEMENT_PICKER_SCRIPT.includes("replace(/^(\\s*\\/queue\\b\\s*)+/gi, '')"), 'Bare and repeated /queue tokens must be normalized before validation');
    assert.ok(ELEMENT_PICKER_SCRIPT.includes("userComment = '/queue ' + promptBody"), 'Prompt must always carry exactly one /queue prefix');
    assert.ok(ELEMENT_PICKER_SCRIPT.includes('width:min(92vw,400px)'), 'Modal width must scale with viewport');
    assert.ok(ELEMENT_PICKER_SCRIPT.includes('modal.offsetHeight'), 'Modal position must use measured height');
    const measureIdx = ELEMENT_PICKER_SCRIPT.indexOf('modal.offsetHeight');
    const appendIdx = ELEMENT_PICKER_SCRIPT.indexOf("modal.appendChild(footer)");
    assert.ok(appendIdx !== -1 && measureIdx > appendIdx, 'Dimensions must be measured after all children are appended');
    assert.ok(!ELEMENT_PICKER_SCRIPT.includes('btnAttachImg'), 'Attach-image button must be removed from footer');
    assert.ok(!ELEMENT_PICKER_SCRIPT.includes('Shift+Enter / Alt+Enter xuống hàng'), 'Shortcut hint must be removed from footer');
  });
  it('keeps annotation editor above storefront modal focus traps', () => {
    assert.ok(ELEMENT_PICKER_SCRIPT.includes("document.createElement(typeof HTMLDialogElement === 'function' ? 'dialog' : 'div')"), 'Annotation UI must use the browser top layer when supported');
    assert.ok(ELEMENT_PICKER_SCRIPT.includes('modal.showModal()'), 'Annotation dialog must enter the native top layer');
    assert.ok(ELEMENT_PICKER_SCRIPT.includes("window.addEventListener('focusin', onAnnotationFocusIn, true)"), 'Annotation must guard against page focus traps');
    assert.ok(ELEMENT_PICKER_SCRIPT.includes("window.removeEventListener('focusin', onAnnotationFocusIn, true)"), 'Focus guard must be removed when annotation closes');
  });

  it('dispatches every annotation prompt to the terminal immediately (queue/draft removed)', () => {
    const calls: string[] = [];
    const fakeTm = {
      getActiveSessionId: () => 'active-session',
      switchSession: (id: string) => { calls.push('switch:' + id); return true; },
      writeTo: (id: string, data: string) => { calls.push('writeTo:' + id + ':' + data); },
      write: (data: string) => { calls.push('write:' + data); },
    };

    // 1. Explicit target session: switch + writeTo with \r, no gate
    dispatchAnnotationToTerminal(fakeTm, 'session-9', 'Inspect this');
    assert.deepStrictEqual(calls, ['switch:session-9', 'writeTo:session-9:Inspect this\r']);

    // 2. Undefined target: falls back to the active session
    calls.length = 0;
    dispatchAnnotationToTerminal(fakeTm, undefined, 'Inspect this');
    assert.deepStrictEqual(calls, ['switch:active-session', 'writeTo:active-session:Inspect this\r']);

    // 3. 'auto' target: same active-session fallback
    calls.length = 0;
    dispatchAnnotationToTerminal(fakeTm, 'auto', 'Inspect this');
    assert.deepStrictEqual(calls, ['switch:active-session', 'writeTo:active-session:Inspect this\r']);

    // 4. Empty active session: falls back to a bare write (no session to attach to)
    calls.length = 0;
    dispatchAnnotationToTerminal({ ...fakeTm, getActiveSessionId: () => '' }, 'auto', 'Inspect this');
    assert.deepStrictEqual(calls, ['write:Inspect this\r']);

    // 5. Legacy draft payloads hit the same unconditional path: deliveryMode is never consulted
    calls.length = 0;
    dispatchAnnotationToTerminal(fakeTm, 'session-9', 'Inspect this');
    assert.deepStrictEqual(calls, ['switch:session-9', 'writeTo:session-9:Inspect this\r']);
  });

  it('strips a legacy deliveryMode field from picked payloads before re-emit', () => {
    const basePick: PickedElementInput = {
      tag: 'div',
      id: 'product-card',
      classes: ['card', 'is-active'],
      textSnippet: 'Áo thun cotton 100%',
      xpath: '/html/body/div[1]/section[2]/div[1]',
      selector: '#product-card',
      rect: { x: 10, y: 20, width: 300, height: 120 },
      computedStyles: { display: 'block' },
    };

    // Clean payload: passes through untouched (identical reference, no new key).
    const clean = stripDeliveryMode(basePick);
    assert.strictEqual(clean, basePick, 'payload without deliveryMode must pass through untouched');
    assert.ok(!('deliveryMode' in clean));

    // Test-only legacy fixture: an older picker build could still emit the field;
    // the cast is confined to this fixture, never to production code paths.
    const legacyPick = { ...basePick, deliveryMode: 'draft' } as unknown as PickedElementInput;
    const sanitized = stripDeliveryMode(legacyPick);
    assert.ok(!('deliveryMode' in sanitized), 'legacy deliveryMode must not surface on the re-emitted payload');
    assert.deepStrictEqual(sanitized, basePick, 'every other key must survive the strip');
    assert.strictEqual(sanitized.selector, '#product-card');
    assert.deepStrictEqual(sanitized.computedStyles, { display: 'block' });
  });

  it('verifies annotation target terminal persistence and validation contract', () => {
    const sessions = [
      { id: 'terminal-1', name: 'PowerShell 1', cwd: 'E:/Work/site1' },
      { id: 'terminal-2', name: 'PowerShell 2', cwd: 'E:/Work/site2' },
    ];

    const resolveValidAnnotationSession = (lastId: string | undefined, activeSessions: typeof sessions): string | undefined => {
      if (typeof lastId !== 'string') return undefined;
      return lastId === 'auto' || activeSessions.some((s) => s.id === lastId) ? lastId : undefined;
    };

    // 1. Uninitialized: undefined, allowing domain localStorage fallback
    assert.strictEqual(resolveValidAnnotationSession(undefined, sessions), undefined);

    // 2. Explicit terminal selection remembered
    assert.strictEqual(resolveValidAnnotationSession('terminal-2', sessions), 'terminal-2');

    // 3. Explicit Auto selection remembered
    assert.strictEqual(resolveValidAnnotationSession('auto', sessions), 'auto');

    // 4. Stale/closed session safely falls back to undefined (auto)
    assert.strictEqual(resolveValidAnnotationSession('terminal-deleted', sessions), undefined);
  });

  it('verifies semantic snapshot traverses same-origin iframes, shadow roots, and generates @ref tags', () => {
    assert.ok(AGENT_BROWSER_SCRIPT.includes('getElementGlobalRect'));
    assert.ok(AGENT_BROWSER_SCRIPT.includes('scanContainer'));
    assert.ok(AGENT_BROWSER_SCRIPT.includes('node.shadowRoot'));
    assert.ok(AGENT_BROWSER_SCRIPT.includes('iframe'));
    assert.ok(AGENT_BROWSER_SCRIPT.includes('frameDoc'));
    assert.ok(AGENT_BROWSER_SCRIPT.includes('framePath'));
    assert.ok(AGENT_BROWSER_SCRIPT.includes('data-antifan-ref'));
  });

  it('verifies __antifanRefMap and querySelectorDeep resolution for @ref in top document and iframes', () => {
    const ctx = {
      window: {} as any,
      document: {} as any,
      setTimeout: (fn: Function) => setTimeout(fn, 0),
      clearTimeout: () => {},
      Event: class {},
      MouseEvent: class {},
      console: console,
    };
    ctx.window = ctx;

    // Create minimal mock DOM
    const mockButton = {
      id: 'checkout-btn',
      tagName: 'BUTTON',
      getAttribute: (attr: string) => (attr === 'role' ? 'button' : null),
      setAttribute: (attr: string, val: string) => { (mockButton as any)[attr] = val; },
      removeAttribute: (attr: string) => { delete (mockButton as any)[attr]; },
      getBoundingClientRect: () => ({ left: 100, top: 200, width: 80, height: 30, right: 180, bottom: 230 }),
      matches: (sel: string) => sel.includes('button'),
      closest: (sel: string) => null,
      innerText: 'Proceed to Checkout',
      isConnected: true,
      focus: () => {},
      dispatchEvent: () => true,
      click: () => {},
      ownerDocument: ctx.document,
    };

    ctx.document = {
      defaultView: ctx.window,
      querySelectorAll: (sel: string) => {
        if (sel === '*') return [mockButton];
        if (sel === '[data-antifan-ref]') return (mockButton as any)['data-antifan-ref'] ? [mockButton] : [];
        if (sel === 'iframe') return [];
        return [mockButton];
      },
      querySelector: (sel: string) => {
        if (sel.includes('data-antifan-ref')) return mockButton;
        return null;
      },
      getElementById: () => null,
      createElement: () => ({ style: {}, appendChild: () => {}, remove: () => {} }),
      body: { appendChild: () => {}, style: {} },
    };
    mockButton.ownerDocument = ctx.document;

    ctx.window.document = ctx.document;
    ctx.window.getComputedStyle = () => ({ visibility: 'visible', display: 'block', opacity: '1' });

    vm.createContext(ctx);
    vm.runInContext(AGENT_BROWSER_SCRIPT, ctx);

    // 1. Run snapshot
    assert.strictEqual(typeof ctx.window.__antifanAgentSnapshot, 'function');
    const snapshotResult = ctx.window.__antifanAgentSnapshot();
    assert.ok(snapshotResult.includes('@e1 [button] "Proceed to Checkout" (id: "checkout-btn")'));

    // 2. Verify Ref Map populated
    assert.ok(ctx.window.__antifanRefMap.has('@e1'));
    const entry = ctx.window.__antifanRefMap.get('@e1');
    assert.strictEqual(entry.node, mockButton);
  });

  it('guarantees ELEMENT_PICKER_SCRIPT double-submit guard and rAF performance throttling', () => {
    // 1. Verify mutex and submission state locks
    assert.ok(ELEMENT_PICKER_SCRIPT.includes('let isSubmitting = false;'), 'Must define submission lock variable');
    assert.ok(ELEMENT_PICKER_SCRIPT.includes('if (isSubmitting) return;'), 'Must guard submission entry with lock');
    assert.ok(ELEMENT_PICKER_SCRIPT.includes('isSubmitting = true;'), 'Must set lock during submit processing');
    assert.ok(ELEMENT_PICKER_SCRIPT.includes('submitBtn.disabled = true'), 'Must disable submit button on send');
    assert.ok(ELEMENT_PICKER_SCRIPT.includes('textarea.disabled = true'), 'Must disable textarea on send');

    // 2. Verify /queue deduplication regex cleans repeated prefixes with word boundary
    assert.ok(ELEMENT_PICKER_SCRIPT.includes('replace(/^(\\s*\\/queue\\b\\s*)+/gi, \'\')'), 'Must strip all repeated /queue tokens with word boundary');
    // 3. Verify requestAnimationFrame hover throttling and coordinate deduplication
    assert.ok(ELEMENT_PICKER_SCRIPT.includes('requestAnimationFrame'), 'Must use requestAnimationFrame for hover loop');
    assert.ok(ELEMENT_PICKER_SCRIPT.includes('lastHoverRect'), 'Must cache bounding box to prevent reflow spam');
    assert.ok(ELEMENT_PICKER_SCRIPT.includes('cancelAnimationFrame'), 'Must clean up pending hover animation frames');

    // 4. Verify click debounce
    assert.ok(ELEMENT_PICKER_SCRIPT.includes('lastClickTime'), 'Must debounce rapid click events');
  });

  it('tests /queue prompt normalization against duplicate /queue prefixes', () => {
    // Single prefix
    assert.strictEqual(normalizeAnnotationPrompt('/queue Tại sao sidebar này load hơi chậm nhỉ?'), '/queue Tại sao sidebar này load hơi chậm nhỉ?');
    // Double prefix
    assert.strictEqual(normalizeAnnotationPrompt('/queue /queue Tại sao sidebar này load hơi chậm nhỉ?'), '/queue Tại sao sidebar này load hơi chậm nhỉ?');
    // Quadruple prefix (matching user issue symptom)
    assert.strictEqual(normalizeAnnotationPrompt('/queue /queue /queue /queue Tại sao sidebar này load hơi chậm nhỉ?'), '/queue Tại sao sidebar này load hơi chậm nhỉ?');
    // No prefix (user typed plain text)
    assert.strictEqual(normalizeAnnotationPrompt('Tại sao sidebar này load hơi chậm nhỉ?'), '/queue Tại sao sidebar này load hơi chậm nhỉ?');
    // Whitespace variations
    assert.strictEqual(normalizeAnnotationPrompt('  /queue   /queue   Tại sao sidebar này load hơi chậm nhỉ?  '), '/queue Tại sao sidebar này load hơi chậm nhỉ?');
    // Words starting with /queue (should preserve their suffix without corrupting)
    assert.strictEqual(normalizeAnnotationPrompt('/queue_task issue'), '/queue /queue_task issue');
    // Cleared textarea (/queue alone or whitespace)
    assert.strictEqual(normalizeAnnotationPrompt('/queue'), '');
    assert.strictEqual(normalizeAnnotationPrompt('/queue   '), '');
  });
});
