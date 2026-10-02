var exports = exports || {};
var module = { exports: exports };
"use strict";
/**
 * Session activity classification: the one state machine behind both the
 * terminal tab strip indicators (standalone.js renderer) and the floating
 * session pet (main process). Kept environment-free — no DOM, no Electron — so
 * the same compiled module drives a classic-script global in the renderer and a
 * plain import in main; behavior stays identical on both surfaces.
 *
 * Per-session flags:
 *   isStreaming   output is arriving right now
 *   isAi          the stream looks like an agent turn (Claude/Codex/… markers)
 *   isThinking    an AI stream went quiet — the agent is reasoning, not done
 *   isWaiting     the tail ended on a prompt asking the user (y/n, "?", approval)
 *   isCompleted   output went quiet for IDLE_MS after streaming (non-AI), or an
 *                 AI session stayed quiet past THINK_CAP_MS — the turn is over
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.SessionActivityTracker = void 0;
exports.sessionActivityLevel = sessionActivityLevel;
function sessionActivityLevel(act) {
    if (!act)
        return 'idle';
    if (act.isWaiting)
        return 'waiting';
    if (act.isStreaming)
        return 'streaming';
    if (act.isThinking)
        return 'thinking';
    if (act.isCompleted)
        return 'completed';
    if (act.isSleeping)
        return 'sleeping';
    return 'idle';
}
/** AI quiet window before the session reads as finished — a long tool call or
 * reasoning stretch keeps 'thinking' instead of flashing 'done'. */
const THINK_CAP_MS = 45000;
/** Trailing-edge throttle: at most one classify pass per window per session. */
const CLASSIFY_THROTTLE_MS = 100;
/** Output quiet for this long after streaming => completed. */
const IDLE_MS = 5000;
/** The completed badge holds this long before the session drops to idle. */
const DONE_HOLD_MS = 2000;
/** Cross-chunk tail for patterns split across two data events. */
const TAIL_BYTES = 64;
/** Explicit agent signals: wait-alert OSC sequences beat every heuristic. */
const WAIT_ON_MARKERS = ['\x1b]777;antifan;wait=1', '\x1b]1337;antifan_wait=1'];
const WAIT_OFF_MARKERS = ['\x1b]777;antifan;wait=0', '\x1b]1337;antifan_wait=0'];
const CONTROL_PREVIEW = ['\x1b]777;antifan;', '\x1b]1337;antifan_wait='];
const ANSI_RE = /\u001b\[[0-9;?]*[a-zA-Z]/g;
const IDLE_PROMPT_RES = [
    /^PS\s+[^>]*>\s*$/i,
    /^[a-zA-Z]:\\[^>]*>\s*$/i,
    /^[\w.-]+@[\w.-]+:[^$#]*[$#]\s*$/i,
];
const SHELL_BANNER_RES = [
    /^Windows\s+PowerShell/i,
    /^Copyright\s+\(C\)\s+Microsoft/i,
    /^Install the latest PowerShell/i,
];
const AI_MARKER_RE = /Claude|Codex|OpenCode|DeepSeek|Gemini|Qwen|Kimi|ChatGPT|Thinking\.\.\.|Streaming\.\.\.|⠋|⠙|⠹|⠸|⠼|⠴|⠦|⠧|⠇|⠏|\[in_progress\]|\[task\]|Agent|Evaluating|Generating/i;
const YES_NO_TAIL_RE = /(?:\(y\/n\)|\(Y\/n\)|\(y\/N\)|\(Y\/N\)|\[y\/n\]|\[Y\/n\]|\[y\/N\]|\[Y\/N\])\s*$/i;
const WAIT_PROMPT_RE = /(?:Do you want to proceed|Waiting for user input|waiting for approval|Press any key|Enter your choice|chờ bạn trả lời|câu trả lời|\bAllow once\b|\bAllow always\b|\bDeny\b)/i;
const QUESTION_TAIL_RE = /\?\s*$/;
class SessionActivityTracker {
    onChange;
    /**
     * Public by design: the tab strip reads records directly to paint icons, and
     * input paths clear `isWaiting` in place on a keystroke.
     */
    sessions = new Map();
    throttle = new Map();
    constructor(onChange) {
        this.onChange = onChange;
    }
    /**
     * Feed one terminal output chunk. Control sequences (wait alerts) bypass the
     * stream throttle; everything else classifies at most once per 100ms with the
     * latest pending chunk, so a burst's tail is never skipped.
     */
    ingest(sessionId, data) {
        if (!sessionId || !data || typeof data !== 'string')
            return;
        const tailPreview = this.sessions.get(sessionId)?.tail || '';
        const waitPreview = CONTROL_PREVIEW[0] ?? '';
        if (CONTROL_PREVIEW.some((marker) => data.includes(marker)) ||
            (tailPreview + data).includes(waitPreview)) {
            this.classify(sessionId, data);
            return;
        }
        const now = Date.now();
        let slot = this.throttle.get(sessionId);
        if (!slot) {
            slot = { lastRun: 0, timer: null, pendingData: '' };
            this.throttle.set(sessionId, slot);
        }
        if (slot.timer) {
            slot.pendingData = data;
            return;
        }
        const elapsed = now - slot.lastRun;
        if (elapsed < CLASSIFY_THROTTLE_MS) {
            slot.pendingData = data;
            slot.timer = setTimeout(() => {
                slot.timer = null;
                const pending = slot.pendingData;
                slot.pendingData = '';
                slot.lastRun = Date.now();
                this.classify(sessionId, pending);
            }, CLASSIFY_THROTTLE_MS - elapsed);
            return;
        }
        slot.lastRun = now;
        this.classify(sessionId, data);
    }
    classify(sessionId, data) {
        if (!data || typeof data !== 'string')
            return;
        let act = this.sessions.get(sessionId);
        if (!act) {
            act = { isStreaming: false, isAi: false, isWaiting: false, isCompleted: false, isSleeping: false, isThinking: false, idleTimer: null, doneTimer: null, thinkTimer: null, tail: '' };
            this.sessions.set(sessionId, act);
        }
        const combined = act.tail + data;
        act.tail = data.length > TAIL_BYTES ? data.slice(-TAIL_BYTES) : combined.slice(-TAIL_BYTES);
        // Any real output revokes the presence flag the daemon's liveness set.
        act.isSleeping = false;
        const waitOnIdx = Math.max(...WAIT_ON_MARKERS.map((m) => combined.lastIndexOf(m)));
        const waitOffIdx = Math.max(...WAIT_OFF_MARKERS.map((m) => combined.lastIndexOf(m)));
        if (waitOffIdx !== -1 && waitOffIdx > waitOnIdx) {
            act.tail = '';
            act.isWaiting = false;
            this.changed(sessionId);
            return;
        }
        if (waitOnIdx !== -1 && waitOnIdx > waitOffIdx) {
            act.tail = '';
            this.settleTimers(act);
            act.isWaiting = true;
            act.isStreaming = false;
            act.isCompleted = false;
            this.changed(sessionId);
            return;
        }
        const clean = data.replace(ANSI_RE, '').trim();
        if (!clean)
            return; // pure cursor moves, clears, redraws
        if (IDLE_PROMPT_RES.some((re) => re.test(clean)))
            return;
        if (SHELL_BANNER_RES.some((re) => re.test(clean)))
            return;
        if (AI_MARKER_RE.test(data))
            act.isAi = true;
        const isWaitPrompt = YES_NO_TAIL_RE.test(clean) ||
            (act.isAi &&
                (WAIT_PROMPT_RE.test(clean) ||
                    (QUESTION_TAIL_RE.test(clean) && clean.length < 240)));
        if (isWaitPrompt) {
            this.settleTimers(act);
            act.isWaiting = true;
            act.isStreaming = false;
            act.isCompleted = false;
            this.changed(sessionId);
            return;
        }
        if (act.isWaiting)
            act.isWaiting = false;
        this.settleTimers(act);
        const wasStreaming = act.isStreaming;
        act.isStreaming = true;
        act.isThinking = false;
        act.isCompleted = false;
        if (!wasStreaming)
            this.changed(sessionId);
        act.idleTimer = setTimeout(() => {
            act.idleTimer = null;
            act.isStreaming = false;
            if (act.isAi) {
                // An agent turn that went quiet is thinking, not done: long tool calls
                // and reasoning stretches produce silence without producing an exit.
                act.isThinking = true;
                this.changed(sessionId);
                act.thinkTimer = setTimeout(() => {
                    act.thinkTimer = null;
                    act.isThinking = false;
                    act.isCompleted = true;
                    this.changed(sessionId);
                    act.doneTimer = setTimeout(() => {
                        act.doneTimer = null;
                        act.isCompleted = false;
                        act.isAi = false;
                        this.changed(sessionId);
                    }, DONE_HOLD_MS);
                }, THINK_CAP_MS);
            }
            else {
                act.isCompleted = true;
                this.changed(sessionId);
                act.doneTimer = setTimeout(() => {
                    act.doneTimer = null;
                    act.isCompleted = false;
                    act.isAi = false;
                    this.changed(sessionId);
                }, DONE_HOLD_MS);
            }
        }, IDLE_MS);
    }
    /** A settled record holds no live timer; the completed badge arms separately. */
    settleTimers(act) {
        clearTimeout(act.idleTimer ?? undefined);
        clearTimeout(act.doneTimer ?? undefined);
        clearTimeout(act.thinkTimer ?? undefined);
        act.idleTimer = null;
        act.doneTimer = null;
        act.thinkTimer = null;
    }
    changed(sessionId) {
        try {
            this.onChange(sessionId);
        }
        catch {
            // A UI listener must never break classification for later chunks.
        }
    }
    /** The shell died: settle as completed so a pet/chip lands on ✓, not spinning. */
    noteExited(sessionId) {
        const act = this.sessions.get(sessionId);
        if (!act)
            return;
        this.settleTimers(act);
        const th = this.throttle.get(sessionId);
        if (th) {
            clearTimeout(th.timer ?? undefined);
            th.timer = null;
            th.pendingData = '';
        }
        act.isStreaming = false;
        act.isWaiting = false;
        act.isSleeping = false;
        act.isThinking = false;
        act.isCompleted = true;
        this.changed(sessionId);
        act.doneTimer = setTimeout(() => {
            act.doneTimer = null;
            act.isCompleted = false;
            act.isAi = false;
            this.changed(sessionId);
        }, DONE_HOLD_MS);
    }
    /** Session row is gone: drop every timer and record so nothing leaks or repaints. */
    noteClosed(sessionId) {
        const act = this.sessions.get(sessionId);
        if (act)
            this.settleTimers(act);
        this.sessions.delete(sessionId);
        const th = this.throttle.get(sessionId);
        if (th)
            clearTimeout(th.timer ?? undefined);
        this.throttle.delete(sessionId);
    }
    /**
     * Session-state hydration: the daemon knows liveness without any output, so a
     * session that sleeps while its PTY stays quiet is authoritative. 'sleeping'
     * is a presence level, weaker than every classifier signal — data clears it.
     */
    noteSleeping(sessionId) {
        let act = this.sessions.get(sessionId);
        if (!act) {
            act = { isStreaming: false, isAi: false, isWaiting: false, isCompleted: false, isSleeping: true, isThinking: false, idleTimer: null, doneTimer: null, thinkTimer: null, tail: '' };
            this.sessions.set(sessionId, act);
            this.changed(sessionId);
            return;
        }
        if (act.isSleeping)
            return;
        act.isSleeping = true;
        this.changed(sessionId);
    }
    /**
     * Daemon says the session is live but quiet: ensure a presence row at 'idle'.
     * Also the wake path — revokes a sleeping flag that real output never cleared
     * (an idle shell stays silent, so hydration is the only signal some rows get).
     */
    noteRunning(sessionId) {
        let act = this.sessions.get(sessionId);
        if (!act) {
            act = { isStreaming: false, isAi: false, isWaiting: false, isCompleted: false, isSleeping: false, isThinking: false, idleTimer: null, doneTimer: null, thinkTimer: null, tail: '' };
            this.sessions.set(sessionId, act);
            this.changed(sessionId);
            return;
        }
        if (!act.isSleeping)
            return;
        act.isSleeping = false;
        this.changed(sessionId);
    }
    /**
     * Authoritative wait signal: the run-state file (`waiting_user`) saw an ask
     * tool call — output heuristics can miss TUI prompts whose last line is a
     * hint bar, so the card is the truth. Clearing only drops the flag; the
     * next output chunk re-derives streaming/thinking on its own.
     */
    noteWaiting(sessionId, waiting) {
        if (!sessionId)
            return;
        let act = this.sessions.get(sessionId);
        if (waiting) {
            if (!act) {
                act = { isStreaming: false, isAi: true, isWaiting: false, isCompleted: false, isSleeping: false, isThinking: false, idleTimer: null, doneTimer: null, thinkTimer: null, tail: '' };
                this.sessions.set(sessionId, act);
            }
            if (act.isWaiting)
                return;
            this.settleTimers(act);
            act.isWaiting = true;
            act.isStreaming = false;
            act.isThinking = false;
            act.isCompleted = false;
            this.changed(sessionId);
            return;
        }
        if (act && act.isWaiting) {
            act.isWaiting = false;
            this.changed(sessionId);
        }
    }
    dispose() {
        for (const id of [...this.sessions.keys()])
            this.noteClosed(id);
        for (const [, th] of this.throttle)
            clearTimeout(th.timer ?? undefined);
        this.throttle.clear();
    }
}
exports.SessionActivityTracker = SessionActivityTracker;
//# sourceMappingURL=session-activity.js.map
window.SessionActivityTracker = exports.SessionActivityTracker;
window.sessionActivityLevel = exports.sessionActivityLevel;
