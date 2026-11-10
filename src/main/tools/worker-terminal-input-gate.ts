import * as path from 'node:path';
import { gateThemeLine } from '../../omp-hooks/theme-draft-probe';
import { startsDirChange, THEME_PUSH_CODES } from '../../omp-hooks/theme-push-policy';
import { releasePushApprovals, type PushApprovalContext, type PushApprovalUse } from '../../omp-hooks/theme-push-approval';

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
export const LINE_MAX_CHARS = 8 * 1024;
/** Targets tracked at once. Only targets with a half-typed line or an untrusted cwd are kept at all. */
const TARGET_CAP = 256;

const BRACKETED_PASTE_MARKERS = /\x1b\[20[01]~/g;
/**
 * What a Leader sends to move within or dismiss an OMP screen, which is agent-owned for every live run: the exact
 * left/right cursor sequences and a bare Esc (the last character of the input, or followed by a control character).
 * Every other ESC (SS3 `ESC O A`, modified arrows `ESC [1;5A`, `ESC [5~`, alt-keys) stays in the model and taints the line.
 */
const AGENT_NAVIGATION_KEYS = /\x1b\[[CD]|\x1b(?=[\x00-\x1f\x7f]|$)/g;
/** The same plus the exact up/down sequences, which are agent-owned only while an ask dialog is open. */
const AGENT_NAVIGATION_KEYS_ASK = /\x1b\[[ABCD]|\x1b(?=[\x00-\x1f\x7f]|$)/g;
/** Control characters a worker's input may carry besides printable text and DEL (0x7f). */
const MODELLED_CONTROL_CHARS = new Set(['\t', '\n', '\r', '\b', '\x03', '\x1b']);
/** Appended to the refusals a Leader's `input` can meet only because a chat line was typed as a shell line. */
const MESSAGE_HINT = ' To send a chat message to a worker\'s agent prompt, pass it as `message` instead of `input`.';
/**
 * A character `message` never carries: every C0/C1 control character (tab and line break included), the Unicode line
 * and paragraph separators, and the invisible format characters (zero-width, bidi marks, BOM) that could hide what a
 * line starts with.
 */
export const MESSAGE_CONTROL_CHARS = /[\x00-\x1f\x7f-\x9f\u00ad\u061c\u200b-\u200f\u2028-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/;
/** A message that starts with one of these (after whitespace) would be run by the agent CLI as a shell or code command, outside every hook. */
export const MESSAGE_PASSTHROUGH_SIGIL = /^\s*[!$&>/]/;
/** The first word of a line is a theme CLI (`hrv`, `C:\tools\hrv.cmd`, `"shopify"`, ...), not a word of prose that merely contains one. */
const STARTS_WITH_THEME_CLI = /^["'`]?(?:[^\s"'`]*[\\/])?(?:hrv|haravan-cli|haravan|shopify|sapo|bizweb)(?:\.(?:cmd|exe|ps1|bat|js|mjs|cjs))?["'`]?(?![a-z0-9_-])/i;

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
      /** Live-push approvals this input spent: the lines of it that a Leader's one-use approval let through. */
      approved: PushApprovalUse[];
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
    options: { deadlineAt?: number; approval?: PushApprovalContext; agentOwnsInput?: boolean; askDialogOpen?: boolean; leaderCaller?: boolean } = {}
  ): Promise<WorkerInputVerdict> {
    const previous = this.lines.get(target);
    const before = previous ?? emptyLine();
    const state: TargetLine = { ...before };
    const claimed: PushApprovalUse[] = [];
    // The hint never points a refused command at `message`: only a line that is neither a passthrough nor a theme command gets it.
    const hintFor = (line: string): string =>
      options.leaderCaller === true && !MESSAGE_PASSTHROUGH_SIGIL.test(line) && !STARTS_WITH_THEME_CLI.test(line.trimStart()) ? MESSAGE_HINT : '';
    const refuse = (code: string, reason: string, command: string): WorkerInputVerdict => {
      // Nothing of this input reaches the shell, so an approval an earlier line of it spent was never used.
      releasePushApprovals(claimed);
      this.store(target, { ...emptyLine(), cwdUntrusted: before.cwdUntrusted });
      return { decision: 'block', code, reason, command, interruptPending: holdsText(before) };
    };

    // Left/right arrows and bare Esc, sent to a pane with a live OMP, act on the agent's own screen and say nothing about a
    // shell line, so they do not taint the next line. Up/down are agent-owned only while an ask dialog is open
    // (`askDialogOpen`): anywhere else the agent recalls history or a draft into its input box, a line nobody judged,
    // so they taint the line exactly like history recall in a shell, until a Ctrl-C clears it.
    const navigation = options.askDialogOpen === true ? AGENT_NAVIGATION_KEYS_ASK : AGENT_NAVIGATION_KEYS;
    const typed = (options.agentOwnsInput === true ? input.replace(navigation, '') : input).replace(BRACKETED_PASTE_MARKERS, '');
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
              `${THEME_PUSH_CODES.COMPLEX}: this input cannot be checked: it completes a line that cannot be read back (it uses an escape sequence, Tab completion or history recall, or is longer than ${LINE_MAX_CHARS} characters). Type plain text: write the command out in full as one line. If you need this, report NEEDS_INPUT to your Leader.${hintFor(text)}`,
              text.slice(0, 200)
            );
          }
          if (lineContinues(text)) {
            return refuse(
              THEME_PUSH_CODES.COMPLEX,
              `${THEME_PUSH_CODES.COMPLEX}: this line ends in a continuation (a trailing backtick, backslash, caret, pipe, ampersand or comma, or an open quote or bracket), so the shell would join it with the next line and each line cannot be checked alone. Type one complete plain command per line, and write a multi-line script to a file. If you need this, report NEEDS_INPUT to your Leader.${hintFor(text)}`,
              text.slice(0, 200)
            );
          }
          const left = options.deadlineAt === undefined ? this.options.probeTimeoutMs : options.deadlineAt - Date.now();
          const outcome = await gateThemeLine({
            text,
            cwd: cwd ?? path.parse(process.cwd()).root,
            assumeDirChanged: state.cwdUntrusted || cwd === undefined,
            timeoutMs: Math.max(1, Math.min(this.options.probeTimeoutMs, left)),
            ...(options.approval ? { approval: options.approval } : {}),
          });
          if (outcome.decision === 'block') {
            const unreadableShape = outcome.code === THEME_PUSH_CODES.COMPLEX && outcome.reason.includes('names the theme CLI in a shape the push rules cannot read');
            return refuse(outcome.code, unreadableShape ? `${outcome.reason}${hintFor(text)}` : outcome.reason, outcome.command);
          }
          if (outcome.decision === 'allow' && outcome.approved) claimed.push(...outcome.approved);
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
      approved: claimed,
      revert: () => {
        releasePushApprovals(claimed);
        this.store(target, previous ?? emptyLine());
      },
      undelivered: () =>
        this.store(target, {
          ...emptyLine(),
          tainted: holdsText(before) || holdsText(state),
          cwdUntrusted: before.cwdUntrusted || state.cwdUntrusted,
        }),
    };
  }

  /**
   * Judge one chat message a Leader sends to the agent CLI running in `target`, where `inspect` would read the same
   * text as a shell line. The caller has already proven that a live agent run owns the pane and proves it again before Enter.
   *
   * Invariants:
   * - Text typed with `input`/`key`/`keys` goes through `inspect` and is judged as a shell line in every case; only an
   *   explicit `message` reaches this method.
   * - A message never reads or writes the pane's pending buffer: text still waiting there would be submitted glued to
   *   the message, so a pane holding any is refused, and nothing here leaves anything behind for a later line.
   * - A message that starts with a passthrough sigil (! $ & >) or a slash is refused outright: the agent CLI runs such a
   *   line as a shell command, code or slash command without any hook seeing it, and a message is chat, never a command.
   *   A message whose first word is a theme command is judged by the same function as a typed shell line and its refusal
   *   is returned unchanged; while the run is `running` (a forced write) the whole message is judged that way. A CLI word
   *   later in the line of an idle agent's message is prose.
   * A block never asks the caller for Ctrl-C: nothing was typed.
   * Call it only inside {@link run}.
   */
  public async inspectMessage(
    target: string,
    message: string,
    cwd: string | undefined,
    options: { deadlineAt?: number; approval?: PushApprovalContext; runState?: string } = {}
  ): Promise<WorkerInputVerdict> {
    const held = this.lines.get(target);
    const block = (code: string, reason: string, command: string): WorkerInputVerdict => ({ decision: 'block', code, reason, command, interruptPending: false });
    if (message.trim().length === 0 || message.length > LINE_MAX_CHARS || MESSAGE_CONTROL_CHARS.test(message)) {
      return block(
        THEME_PUSH_CODES.COMPLEX,
        `${THEME_PUSH_CODES.COMPLEX}: a message must be one non-empty line of plain text of at most ${LINE_MAX_CHARS} characters, with no control characters. Put long or multi-line instructions in a file and send a message that references it.`,
        showControls(message).slice(0, 200)
      );
    }
    if (held !== undefined && holdsText(held)) {
      return block(
        THEME_PUSH_CODES.COMPLEX,
        `${THEME_PUSH_CODES.COMPLEX}: this terminal holds text typed earlier that was never entered, and the message would be submitted glued to it. Clear the line first (key ctrl-c), then send the message again.`,
        message.slice(0, 200)
      );
    }
    if (MESSAGE_PASSTHROUGH_SIGIL.test(message)) {
      return block(
        THEME_PUSH_CODES.COMPLEX,
        `${THEME_PUSH_CODES.COMPLEX}: a message cannot start with a shell/code passthrough sigil (! $ & >) or a slash (/): the agent CLI would run it as a shell or code command, or as a slash command (/exit, /new, ...), outside every gate. To run a command in the worker's shell use input (judged as a shell line), or ask the worker in words.`,
        message.slice(0, 200)
      );
    }
    const line = message.trimStart();
    // While a turn runs (a forced write), the text lands in the running agent's input stream, where its own tools may read
    // it: judge the whole message, not only a leading CLI word. An idle agent reads it as chat, so only a leading CLI word counts.
    if (options.runState === 'running' || STARTS_WITH_THEME_CLI.test(line)) {
      const left = options.deadlineAt === undefined ? this.options.probeTimeoutMs : options.deadlineAt - Date.now();
      const outcome = await gateThemeLine({
        text: line,
        cwd: cwd ?? path.parse(process.cwd()).root,
        assumeDirChanged: held?.cwdUntrusted === true || cwd === undefined,
        timeoutMs: Math.max(1, Math.min(this.options.probeTimeoutMs, left)),
        ...(options.approval ? { approval: options.approval } : {}),
      });
      if (outcome.decision === 'block') return block(outcome.code, outcome.reason, outcome.command);
      const claimed: PushApprovalUse[] = outcome.decision === 'allow' && outcome.approved ? [...outcome.approved] : [];
      return { decision: 'allow', approved: claimed, revert: () => releasePushApprovals(claimed), undelivered: () => {} };
    }
    return { decision: 'allow', approved: [], revert: () => {}, undelivered: () => {} };
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
