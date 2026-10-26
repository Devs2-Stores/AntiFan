import type { StateMatrixDeps, StateMatrixKind } from '../../src/main/qa/state-matrix';

export interface Step {
  kind: 'eval' | 'click' | 'clickAt' | 'hover' | 'hoverAt' | 'key';
  detail: string;
}

export const openDialog = {
  opened: true,
  rect: { x: 900, y: 0, w: 380, h: 800 },
  effectiveOpacity: 1,
  visibility: 'visible',
  pointerEvents: 'auto',
  withinViewport: true,
  clippedByAncestor: false,
  occluded: false,
  overflowingChildren: [],
  scrollLocked: true,
  focusInside: true,
  closeControl: 'button.close',
  backdropPoint: { x: 450, y: 400 },
  tooSmall: false,
};

export interface DialogScript {
  kind?: StateMatrixKind;
  /** Replaces the open measurement (for example a panel without a close control). */
  measureOpen?: Record<string, unknown>;
  /** Whether the Escape key closes the panel. */
  escapeCloses?: boolean;
  /** Escape closes the panel from this (1-based) press on; `escapeCloses: true` is the same as 1. */
  escapeClosesOnPress?: number;
  /** After a close input the panel still reads open for this many closed-state measurements (a close that finishes after the settle). */
  closeAfterTurns?: number;
  /** The one-shot keydown listener cannot be read back (the page threw while it was read). */
  escapeReadThrows?: boolean;
  /** What the one-shot keydown listener reports after Escape was sent. */
  escapeRead?: Record<string, unknown> | null;
  /** What the unstyled probe returns; a function may throw. */
  unstyled?: unknown | (() => unknown);
}

/**
 * Deps for one overlay whose open state the fake tracks: a trusted click on the trigger opens it,
 * a click on the tagged close control or on the backdrop closes it, Escape closes it only when told to.
 */
export function dialogDeps(script: DialogScript = {}): { deps: StateMatrixDeps; steps: Step[]; state: { open: boolean; closing: number; escapePresses: number; closedReads: number } } {
  const steps: Step[] = [];
  const state = { open: false, closing: 0, escapePresses: 0, closedReads: 0 };
  const kind = script.kind ?? 'modal';
  // Every close input goes through here, so `closeAfterTurns` delays all of them alike.
  const closeInput = (): void => {
    if ((script.closeAfterTurns ?? 0) > 0) state.closing = script.closeAfterTurns!;
    else state.open = false;
  };
  const isDiscover = (s: string) => s.includes('__antifanStateMatrixGuard') && s.includes('UNSAFE');
  const isCleanup = (s: string) => s.includes('delete window.__antifanStateMatrixGuard');
  const isMeasureOpen = (s: string) => s.includes('backdropPoint') && s.includes('overflowingChildren');
  const isMeasureClosed = (s: string) => s.includes('focusReturned') && !s.includes('backdropPoint');
  const isPointSafety = (s: string) => s.includes("reason: 'INSIDE_PANEL'");
  const isEscapeArm = (s: string) => s.includes('__antifanSmKey') && s.includes('addEventListener');
  const isEscapeRead = (s: string) => s.includes('__antifanSmKey') && !s.includes('addEventListener');
  const isUnstyled = (s: string) => s.includes('unstyled: cues');
  const ok = async () => ({ ok: true });

  const deps: StateMatrixDeps = {
    evalJs: async (s: string) => {
      steps.push({ kind: 'eval', detail: s.slice(0, 80) });
      if (isDiscover(s)) {
        return { ok: true, viewport: { width: 1280, height: 800 }, skipped: [], triggers: [{ index: 0, trigger: 'button.open', panel: '#panel', kind, label: 'Open', closeSelector: null }] };
      }
      if (isCleanup(s)) return { ok: true };
      if (isMeasureOpen(s)) return script.measureOpen ?? openDialog;
      if (isMeasureClosed(s)) {
        state.closedReads++;
        if (state.closing > 0) {
          state.closing--;
          if (state.closing === 0) state.open = false;
          return { closed: false, bodyRestored: true, focusReturned: true };
        }
        return { closed: !state.open, bodyRestored: true, focusReturned: true };
      }
      if (isPointSafety(s)) return { safe: true, reason: 'OVERLAY', target: 'div.backdrop' };
      if (isEscapeArm(s)) return { armed: true, hasFocus: true };
      if (isEscapeRead(s)) {
        if (script.escapeReadThrows === true) throw new Error('probe lost');
        return script.escapeRead === undefined ? { seen: true, key: 'Escape', hasFocus: true } : script.escapeRead;
      }
      if (isUnstyled(s)) {
        const value = typeof script.unstyled === 'function' ? (script.unstyled as () => unknown)() : script.unstyled;
        return value === undefined ? { unstyled: [] } : value;
      }
      return { ok: true };
    },
    click: async (selector: string) => {
      steps.push({ kind: 'click', detail: selector });
      if (selector.includes('sm-close')) closeInput();
      else if (selector.includes('sm-trigger')) { state.open = true; state.closing = 0; }
      return ok();
    },
    clickAt: async (x: number, y: number) => {
      steps.push({ kind: 'clickAt', detail: `${x},${y}` });
      closeInput();
      return ok();
    },
    hover: async (selector: string) => {
      steps.push({ kind: 'hover', detail: selector });
      if (selector.includes('sm-trigger')) { state.open = true; state.closing = 0; }
      return ok();
    },
    hoverAt: async (x: number, y: number) => {
      steps.push({ kind: 'hoverAt', detail: `${x},${y}` });
      return ok();
    },
    pressKey: async (key: string) => {
      steps.push({ kind: 'key', detail: key });
      if (key === 'Escape') {
        state.escapePresses++;
        const closesFrom = script.escapeClosesOnPress ?? (script.escapeCloses === true ? 1 : Infinity);
        if (state.escapePresses >= closesFrom) closeInput();
      }
      return ok();
    },
    wait: async () => undefined,
    now: (() => {
      let t = 0;
      return () => (t += 10);
    })(),
  };
  return { deps, steps, state };
}
