import * as path from 'node:path';
import { gateThemeLine } from '../../omp-hooks/theme-draft-probe';
import { startsDirChange, THEME_PUSH_CODES } from '../../omp-hooks/theme-push-policy';

/**
 * The theme-push gate for what a Leader's worker types into a terminal through `terminal.write`.
 *
 * A worker's own bash tool is gated by the OMP hook, line by line. `terminal.write` carries the same
 * lines (a worker restarts `hrv theme dev` in the sync watcher pane this way), so a completed logical
 * line is classified here with the SAME decision the hook uses: `gateThemeLine`. Input arrives in
 * arbitrary chunks (a worker can type `hrv th` and then `eme publish 1`), so the gate keeps one line
 * buffer per target terminal and judges a line only when Enter completes it.
 *
 * The buffer models only keys whose effect on the shell's line is certain: printable text, Backspace and
 * Delete (one character), Enter and Ctrl-C (which abandons the line). Esc and Tab change the line in
 * ways that cannot be followed, so they taint it. Every other control key is refused at once, because
 * what it does depends on the shell's key bindings. A line that ends in a continuation (the shell would
 * join it with the next one) is refused, because each physical line is judged alone.
 */

/** Longest logical line the buffer follows; a longer one cannot be read and is refused when it completes. */
const LINE_MAX_CHARS = 8 * 1024;
/** Targets tracked at once. Only targets with a half-typed line or an untrusted cwd are kept at all. */
const TARGET_CAP = 256;

const BRACKETED_PASTE_MARKERS = /\x1b\[20[01]~/g;
/** Control characters a worker's input may carry besides printable text and DEL (0x7f). */
const MODELLED_CONTROL_CHARS = new Set(['\t', '\n', '\r', '\b', '\x03', '\x1b']);

interface TargetLine {
  /** Characters typed since the last Enter that no control key has erased. */
  pending: string;
  /** A key whose effect on the line cannot be followed (Esc sequences, Tab completion, history search). */
  tainted: boolean;
  /** The line outgrew {@link LINE_MAX_CHARS}. */
  overflow: boolean;
  /** An earlier line moved the shell with a directory-changing word, so its cwd is no longer the one the pane started in. */
  cwdUntrusted: boolean;
}

export type WorkerInputVerdict =
  | {
      decision: 'allow';
      /** The input was not handed to the shell: put the buffer back exactly as it was before this call. */
      revert: () => void;
      /**
       * The shell may or may not have received the input (a failed or timed-out write): keep what the
       * input could have left behind that makes the gate stricter, and taint the line so the next Enter is refused.
       */
      undelivered: () => void;
    }
  | {
      decision: 'block';
      code: string;
      reason: string;
      command: string;
      /** The target's shell holds half-typed text from an earlier call: the caller must clear it with Ctrl-C. */
      interruptPending: boolean;
    };

/**
 * Whether the shell would join this line with the next one instead of running it: a trailing
 * continuation character (backtick, backslash, caret), a trailing operator that needs a right-hand side
 * (pipe, ampersand, comma), or a quote, parenthesis, brace or bracket still open. Judging the physical
 * lines of a joined command one by one would miss a command split across them, so such a line is refused.
 * A comment containing an apostrophe reads as an open quote: that is the accepted false refusal.
 */
export function lineContinues(text: string): boolean {
  const line = text.trimEnd();
  if (line.length === 0) return false;
  if (/[`\\^|&,]$/.test(line)) return true;
  let quote: '"' | "'" | null = null;
  let depth = 0;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quote === "'") {
      if (ch === "'") quote = null;
      continue;
    }
    if (ch === '`' || ch === '\\') {
      i += 1;
      continue;
    }
    if (quote === '"') {
      if (ch === '"') quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '(' || ch === '{' || ch === '[') depth += 1;
    else if (ch === ')' || ch === '}' || ch === ']') depth = Math.max(0, depth - 1);
  }
  return quote !== null || depth > 0;
}

/** A control character as the shell user would name it (`^U`), so a refusal can show the input. */
function showControls(text: string): string {
  return text.replace(/[\x00-\x1f\x7f]/g, (c) => (c === '\x7f' ? '^?' : `^${String.fromCharCode(c.charCodeAt(0) + 64)}`));
}

function emptyLine(): TargetLine {
  return { pending: '', tainted: false, overflow: false, cwdUntrusted: false };
}

function holdsText(line: TargetLine): boolean {
  return line.pending.length > 0 || line.tainted || line.overflow;
}

export class WorkerTerminalInputGate {
  private readonly lines = new Map<string, TargetLine>();
  private readonly tails = new Map<string, Promise<void>>();

  constructor(private readonly options: { probeTimeoutMs: number }) {}

  /**
   * Run `work` once every earlier call for `target` has settled. Inspecting a chunk and delivering it
   * are one step, so the buffer's order is the shell's order.
   */
  public async run<T>(target: string, work: () => Promise<T>): Promise<T> {
    const prior = this.tails.get(target);
    const result = (prior ?? Promise.resolve()).then(work);
    const tail = result.then(() => undefined, () => undefined);
    this.tails.set(target, tail);
    try {
      return await result;
    } finally {
      if (this.tails.get(target) === tail) this.tails.delete(target);
    }
  }

  /** Drop everything remembered about a terminal that was closed. */
  public forget(target: string): void {
    this.lines.delete(target);
  }

  /**
   * The shell of `target` may still hold text the gate has already written off (a Ctrl-C that was not
   * delivered): the next Enter there is refused, and only a delivered Ctrl-C clears it.
   */
  public markTainted(target: string): void {
    this.store(target, { ...(this.lines.get(target) ?? emptyLine()), tainted: true });
  }

  /**
   * Judge one chunk typed into `target`, whose shell was started in `cwd` (undefined when unknown).
   * Allowed: the buffer now follows the chunk (the verdict can put it back when the chunk is not
   * delivered). Blocked: nothing of the chunk may be delivered, and the buffer is empty again (the caller
   * clears an in-flight line with Ctrl-C when `interruptPending`).
   * `deadlineAt` is the epoch ms by which every probe of this call must be over: each probe gets what is left
   * of it, and a probe with nothing left refuses the sync as unverifiable.
   * Call it only inside {@link run}.
   */
  public async inspect(
    target: string,
    input: string,
    cwd: string | undefined,
    options: { deadlineAt?: number } = {}
  ): Promise<WorkerInputVerdict> {
    const previous = this.lines.get(target);
    const before = previous ?? emptyLine();
    const state: TargetLine = { ...before };
    const refuse = (code: string, reason: string, command: string): WorkerInputVerdict => {
      this.store(target, { ...emptyLine(), cwdUntrusted: before.cwdUntrusted });
      return { decision: 'block', code, reason, command, interruptPending: holdsText(before) };
    };

    const typed = input.replace(BRACKETED_PASTE_MARKERS, '');
    for (const ch of typed) {
      if (ch.charCodeAt(0) < 0x20 && !MODELLED_CONTROL_CHARS.has(ch)) {
        return refuse(
          THEME_PUSH_CODES.COMPLEX,
          `${THEME_PUSH_CODES.COMPLEX}: this terminal input uses the control key ${showControls(ch)}, and what it does depends on the shell's key bindings, so the line it edits cannot be checked. Type plain text: Enter, Backspace, Tab, Esc and Ctrl-C are the only control keys accepted. If you need this, report NEEDS_INPUT to your Leader.`,
          showControls(typed).slice(0, 200)
        );
      }
    }

    for (const ch of typed) {
      switch (ch) {
        case '\x03':
          state.pending = '';
          state.tainted = false;
          state.overflow = false;
          break;
        case '\x7f':
        case '\b':
          state.pending = state.pending.slice(0, -1);
          break;
        case '\x1b':
        case '\t':
          state.tainted = true;
          break;
        case '\r':
        case '\n': {
          const text = state.pending;
          const unreadable = state.tainted || state.overflow;
          state.pending = '';
          state.tainted = false;
          state.overflow = false;
          if (text.length === 0 && !unreadable) break;
          if (unreadable) {
            return refuse(
              THEME_PUSH_CODES.COMPLEX,
              `${THEME_PUSH_CODES.COMPLEX}: this input cannot be checked: it completes a line that cannot be read back (it uses an escape sequence, Tab completion or history recall, or is longer than ${LINE_MAX_CHARS} characters). Type plain text: write the command out in full as one line. If you need this, report NEEDS_INPUT to your Leader.`,
              text.slice(0, 200)
            );
          }
          if (lineContinues(text)) {
            return refuse(
              THEME_PUSH_CODES.COMPLEX,
              `${THEME_PUSH_CODES.COMPLEX}: this line ends in a continuation (a trailing backtick, backslash, caret, pipe, ampersand or comma, or an open quote or bracket), so the shell would join it with the next line and each line cannot be checked alone. Type one complete plain command per line, and write a multi-line script to a file. If you need this, report NEEDS_INPUT to your Leader.`,
              text.slice(0, 200)
            );
          }
          const left = options.deadlineAt === undefined ? this.options.probeTimeoutMs : options.deadlineAt - Date.now();
          const outcome = await gateThemeLine({
            text,
            cwd: cwd ?? path.parse(process.cwd()).root,
            assumeDirChanged: state.cwdUntrusted || cwd === undefined,
            timeoutMs: Math.max(1, Math.min(this.options.probeTimeoutMs, left)),
          });
          if (outcome.decision === 'block') return refuse(outcome.code, outcome.reason, outcome.command);
          if (startsDirChange(text)) state.cwdUntrusted = true;
          break;
        }
        default:
          if (state.pending.length >= LINE_MAX_CHARS) state.overflow = true;
          else state.pending += ch;
      }
    }

    this.store(target, state);
    return {
      decision: 'allow',
      revert: () => this.store(target, previous ?? emptyLine()),
      undelivered: () =>
        this.store(target, {
          ...emptyLine(),
          tainted: holdsText(before) || holdsText(state),
          cwdUntrusted: before.cwdUntrusted || state.cwdUntrusted,
        }),
    };
  }

  private store(target: string, state: TargetLine): void {
    if (!holdsText(state) && !state.cwdUntrusted) {
      this.lines.delete(target);
      return;
    }
    // Only targets with something to remember are kept, so a full map evicts an entry rather than grow without
    // bound. A target whose cwd is untrusted is the last to go: forgetting it would let a later sync be
    // verified against a folder the shell has left.
    if (!this.lines.has(target) && this.lines.size >= TARGET_CAP) {
      let victim: string | undefined;
      for (const [id, entry] of this.lines) {
        if (!entry.cwdUntrusted) {
          victim = id;
          break;
        }
      }
      victim ??= this.lines.keys().next().value;
      if (victim !== undefined) this.lines.delete(victim);
    }
    this.lines.set(target, state);
  }
}
