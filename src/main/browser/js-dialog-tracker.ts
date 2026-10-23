import { CapabilityError } from '../../shared/control-plane-contracts';

/**
 * The JavaScript dialog (alert / confirm / beforeunload) a page currently has open, per
 * WebContents, fed by the CDP `Page.javascriptDialogOpening` / `Page.javascriptDialogClosed`
 * events of the debugger session TabDevToolsHost keeps attached to every tab. Electron never
 * shows `prompt()`: the call throws in the page, so no prompt dialog is ever reported.
 *
 * While a dialog is open the page's main thread is parked inside it: every Runtime, Input and DOM
 * command waits until the dialog is answered, so a click that opens a `confirm()` never sees its
 * `mouseReleased` settle. The record lets callers refuse new work at once and lets the agent
 * answer the dialog instead of timing out against it.
 *
 * The events only arrive when the Page domain was enabled BEFORE the dialog appeared: enabling it
 * afterwards hangs, and `Page.handleJavaScriptDialog` then reports "No dialog is showing".
 */

export type JsDialogType = 'alert' | 'confirm' | 'prompt' | 'beforeunload';

export interface OpenJsDialog {
  type: JsDialogType;
  message: string;
  url: string;
  openedAt: number;
}

const DIALOG_TYPES: Record<string, JsDialogType> = {
  alert: 'alert',
  confirm: 'confirm',
  prompt: 'prompt',
  beforeunload: 'beforeunload',
};

const MESSAGE_PREVIEW_CHARS = 300;

function preview(message: string): string {
  const flat = message.replace(/\s+/g, ' ').trim();
  return flat.length > MESSAGE_PREVIEW_CHARS ? `${flat.slice(0, MESSAGE_PREVIEW_CHARS)}…` : flat;
}

/** Public shape of a dialog in refusals and results; the message is never truncated here. */
export interface JsDialogDescription {
  type: JsDialogType;
  message: string;
  url: string;
}

export function describeJsDialog(dialog: OpenJsDialog | JsDialogDescription): JsDialogDescription {
  return { type: dialog.type, message: dialog.message, url: dialog.url };
}

/** Result of answering a dialog: what was answered, and whether the native box left on screen was closed. */
export interface JsDialogAnswer {
  tabId: string;
  paneId: 'desktop' | 'mobile';
  action: 'accept' | 'dismiss';
  dialog: JsDialogDescription;
  /** The page reported `Page.javascriptDialogClosed` within 1s of the answer. */
  closedEventSeen: boolean;
  /**
   * The native box is closed only when it is provably this dialog's: it appeared after the dialog
   * opened and is the only such box, and no other dialog that could own it is open (of the tab's
   * window for an owned box; of any window for an unowned one, e.g. a background tab's). AMBIGUOUS:
   * another box or open dialog could be this dialog's; `candidates` counts them.
   */
  nativeBox:
    | { closed: true }
    | { closed: false; reason: 'UNSUPPORTED_PLATFORM' | 'CLOSE_EVENT_MISSING' | 'NONE_LEFT' | 'AMBIGUOUS' | 'CLOSE_FAILED'; candidates?: number };
}

export function dialogOpenError(dialog: OpenJsDialog | JsDialogDescription, tabId?: string): CapabilityError {
  return new CapabilityError(
    'DIALOG_OPEN',
    `DIALOG_OPEN: the page has an open ${dialog.type} dialog ("${preview(dialog.message)}"), so it cannot run any other operation until the dialog is answered.`,
    {
      ...(tabId ? { tabId } : {}),
      dialog: describeJsDialog(dialog),
      recovery: "Read it with anti.browser.dialog {action: 'get'}, then answer with anti.browser.dialog {action: 'accept'} or {action: 'dismiss'}.",
    }
  );
}

export function isDialogOpenError(err: unknown): err is CapabilityError {
  return err instanceof CapabilityError && err.code === 'DIALOG_OPEN';
}

/** The dialog a DIALOG_OPEN refusal carries, for callers that report it as the effect of their action. */
export function dialogOfError(err: unknown): JsDialogDescription | undefined {
  if (!isDialogOpenError(err)) return undefined;
  const dialog = err.details?.dialog;
  return dialog && typeof dialog === 'object' ? dialog as JsDialogDescription : undefined;
}

type Listener = (dialog: OpenJsDialog) => void;

export class JsDialogTracker {
  private readonly open = new Map<number, OpenJsDialog>();
  private readonly openListeners = new Map<number, Set<Listener>>();
  private readonly closeListeners = new Map<number, Set<() => void>>();

  /** Feed one CDP event of WebContents `wcId`; events of other domains are ignored. */
  handleCdpMessage(wcId: number, method: string, params: Record<string, unknown> | undefined): void {
    if (method === 'Page.javascriptDialogOpening') {
      const type = DIALOG_TYPES[typeof params?.type === 'string' ? params.type : ''] ?? 'alert';
      const dialog: OpenJsDialog = {
        type,
        message: typeof params?.message === 'string' ? params.message : '',
        url: typeof params?.url === 'string' ? params.url : '',
        openedAt: Date.now(),
      };
      this.open.set(wcId, dialog);
      for (const listener of [...(this.openListeners.get(wcId) ?? [])]) {
        try { listener(dialog); } catch {}
      }
      return;
    }
    if (method === 'Page.javascriptDialogClosed') this.markClosed(wcId);
  }

  get(wcId: number): OpenJsDialog | undefined {
    return this.open.get(wcId);
  }

  /** Every open dialog, keyed by WebContents id. */
  entries(): Array<[number, OpenJsDialog]> {
    return [...this.open];
  }

  /** Runs `listener` when WebContents `wcId` opens a dialog; returns the unsubscribe. */
  onOpened(wcId: number, listener: Listener): () => void {
    let set = this.openListeners.get(wcId);
    if (!set) {
      set = new Set();
      this.openListeners.set(wcId, set);
    }
    set.add(listener);
    return () => {
      const current = this.openListeners.get(wcId);
      if (!current) return;
      current.delete(listener);
      if (current.size === 0) this.openListeners.delete(wcId);
    };
  }

  /** Resolves true once WebContents `wcId` has no open dialog, false when `timeoutMs` passes first. */
  waitClosed(wcId: number, timeoutMs: number): Promise<boolean> {
    if (!this.open.has(wcId)) return Promise.resolve(true);
    const { promise, resolve } = Promise.withResolvers<boolean>();
    let set = this.closeListeners.get(wcId);
    if (!set) {
      set = new Set();
      this.closeListeners.set(wcId, set);
    }
    const done = (closed: boolean) => {
      clearTimeout(timer);
      this.closeListeners.get(wcId)?.delete(onClose);
      resolve(closed);
    };
    const onClose = () => done(true);
    const timer = setTimeout(() => done(false), Math.max(1, timeoutMs));
    timer.unref?.();
    set.add(onClose);
    return promise;
  }

  /**
   * The page no longer shows a dialog: it was answered, its document navigated away, or its
   * WebContents is gone.
   */
  markClosed(wcId: number): void {
    if (!this.open.delete(wcId)) return;
    const waiters = this.closeListeners.get(wcId);
    this.closeListeners.delete(wcId);
    for (const waiter of [...(waiters ?? [])]) {
      try { waiter(); } catch {}
    }
  }

  /** Drops every record of a destroyed WebContents. */
  forget(wcId: number): void {
    this.markClosed(wcId);
    this.openListeners.delete(wcId);
  }
}
