/**
 * Catching the native file chooser a page opens, so a file can be handed to it over CDP.
 *
 * With `Page.setInterceptFileChooserDialog` on, the page's chooser never shows; the target
 * reports `Page.fileChooserOpened` instead, naming the `<input type=file>` that asked for it.
 * That works for inputs the page creates only when a button is clicked, which a selector can
 * never find beforehand. The interception is a per-target switch, so it is always switched off
 * again, including when the trigger or the wait fails.
 */
import { CapabilityError } from '../../shared/control-plane-contracts';

/** How long the page gets to open its chooser after the trigger. */
export const FILE_CHOOSER_WAIT_MS = 5000;

export interface FileChooserOpened {
  frameId?: string;
  mode?: 'selectSingle' | 'selectMultiple';
  backendNodeId?: number;
}

/** The two things interception needs from a CDP session. */
export interface FileChooserSession {
  send(method: string, params?: Record<string, unknown>): Promise<unknown>;
  /** Subscribe to protocol events; returns the unsubscribe function. */
  onEvent(handler: (method: string, params: Record<string, unknown>) => void): () => void;
}

/**
 * Switch interception on, run `trigger` (the click that makes the page open its chooser) and
 * resolve with the chooser it opened. Interception is switched off before returning or throwing.
 */
export async function interceptFileChooser(
  session: FileChooserSession,
  trigger: () => Promise<void>,
  waitMs: number = FILE_CHOOSER_WAIT_MS
): Promise<FileChooserOpened> {
  const { promise: opened, resolve: resolveOpened } = Promise.withResolvers<FileChooserOpened>();
  const unsubscribe = session.onEvent((method, params) => {
    if (method !== 'Page.fileChooserOpened') return;
    resolveOpened({
      ...(typeof params.frameId === 'string' ? { frameId: params.frameId } : {}),
      ...(params.mode === 'selectSingle' || params.mode === 'selectMultiple' ? { mode: params.mode } : {}),
      ...(typeof params.backendNodeId === 'number' ? { backendNodeId: params.backendNodeId } : {}),
    });
  });
  let interceptionOn = false;
  let timer: NodeJS.Timeout | undefined;
  try {
    await session.send('Page.enable', {});
    interceptionOn = true;
    await session.send('Page.setInterceptFileChooserDialog', { enabled: true });
    await trigger();
    const { promise: timeout, reject: rejectTimeout } = Promise.withResolvers<never>();
    timer = setTimeout(
      () => rejectTimeout(new CapabilityError(
        'EXECUTION_ERROR',
        `The page did not open a file chooser within ${waitMs} ms of the click; the clicked element does not start a file selection`,
        { cause: 'file-chooser-not-opened', waitMs }
      )),
      waitMs
    );
    return await Promise.race([opened, timeout]);
  } finally {
    clearTimeout(timer);
    unsubscribe();
    if (interceptionOn) {
      try {
        await session.send('Page.setInterceptFileChooserDialog', { enabled: false });
      } catch {
        // The target went away or its transport was reset: the switch lived in that session and is gone with it.
      }
    }
  }
}

/** The node the chooser belongs to, or a typed refusal when the chooser cannot take these files. */
export function fileChooserTarget(opened: FileChooserOpened, fileCount: number): number {
  if (typeof opened.backendNodeId !== 'number') {
    throw new CapabilityError('EXECUTION_ERROR', 'The file chooser opened without naming its <input type=file>, so files cannot be attached to it', { cause: 'file-chooser-no-node' });
  }
  if (opened.mode === 'selectSingle' && fileCount > 1) {
    throw new CapabilityError('INVALID_ARGUMENT', `The page's file chooser accepts one file, ${fileCount} were given`, { cause: 'file-chooser-single', fileCount });
  }
  return opened.backendNodeId;
}
