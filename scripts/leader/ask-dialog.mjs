// ask-dialog.mjs - what an OMP worker is asking when its run state is `waiting_user`, and the keys that answer it.
//
// The worker's `ask` tool call sits in its session transcript as an assistant `toolCall` (name "ask", arguments.questions)
// and is answered by a later `toolResult` with the same toolCallId. A call without that result is the open dialog.
// Read-only: nothing here writes to a terminal.

import * as fs from "node:fs";
import { findSessionFile } from "./worker-liveness.mjs";

const TAIL_BYTES = 2_000_000;
const TEXT_MAX = 600;

function clip(value) {
  const text = typeof value === "string" ? value : "";
  return text.length > TEXT_MAX ? `${text.slice(0, TEXT_MAX)}...` : text;
}

function readTail(file, bytes) {
  const size = fs.statSync(file).size;
  const start = Math.max(0, size - bytes);
  const buf = Buffer.alloc(size - start);
  const fd = fs.openSync(file, "r");
  try {
    fs.readSync(fd, buf, 0, buf.length, start);
  } finally {
    fs.closeSync(fd);
  }
  return buf.toString("utf8");
}

/**
 * Keys that choose option `optionIndex` (0-based) of one single-choice question in the OMP ask dialog and confirm it.
 * The dialog opens with the cursor on `recommended` (0 when none) and Enter selects the row under the cursor, which
 * also finishes a lone question or moves on to the next one.
 */
export function keysForOption(question, optionIndex) {
  const count = question.options.length;
  if (!Number.isInteger(optionIndex) || optionIndex < 0 || optionIndex >= count) {
    throw new Error(`option must be 0..${count - 1}`);
  }
  const start = Number.isInteger(question.recommended) ? Math.min(Math.max(question.recommended, 0), count - 1) : 0;
  const delta = optionIndex - start;
  return [...Array(Math.abs(delta)).fill(delta > 0 ? "down" : "up"), "enter"];
}

/** The newest `ask` call of `text` (a transcript tail) that has no toolResult yet, or null. */
export function pendingAsk(text) {
  const open = new Map();
  for (const line of text.split("\n")) {
    const hasCall = line.includes('"name":"ask"');
    const hasResult = line.includes('"toolName":"ask"');
    if (!hasCall && !hasResult) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const message = entry?.message;
    if (!message) continue;
    if (message.role === "assistant" && Array.isArray(message.content)) {
      for (const part of message.content) {
        if (part?.type === "toolCall" && part.name === "ask" && part.id) open.set(part.id, { at: entry.timestamp ?? null, args: part.arguments ?? {} });
      }
    } else if (message.role === "toolResult" && message.toolName === "ask") {
      open.delete(message.toolCallId);
    }
  }
  const last = [...open.entries()].at(-1);
  if (!last) return null;
  const [toolCallId, { at, args }] = last;
  const rawQuestions = Array.isArray(args.questions) ? args.questions : [];
  const questions = rawQuestions.map((q) => {
    const options = Array.isArray(q.options) ? q.options.map((o) => ({ label: clip(o?.label), ...(o?.description ? { description: clip(o.description) } : {}) })) : [];
    const multi = q.multi === true;
    const recommended = Number.isInteger(q.recommended) ? q.recommended : null;
    const entry = { id: q.id ?? null, question: clip(q.question), options, recommended, multi };
    if (!multi && options.length > 0) {
      // Keys per option, so the Leader copies one list instead of counting rows.
      entry.answerKeys = options.map((_, i) => keysForOption({ options, recommended }, i));
    }
    return entry;
  });
  return {
    toolCallId,
    askedAt: at,
    questions,
    // Several questions end on a Submit tab: Enter on the last question only moves there, so the dialog stays open until
    // `finishKeys` is sent after the LAST question's keys (one question submits by itself: no finishKeys).
    finishKeys: questions.length > 1 ? ["enter"] : [],
    answerable: questions.length > 0 && questions.every((q) => q.answerKeys),
  };
}

/** The open ask dialog of the OMP session behind `run`, or null (no transcript, no open ask, unreadable). */
export function pendingAskOf(sessionsDir, run) {
  if (!run || run.state !== "waiting_user") return null;
  try {
    const file = findSessionFile(sessionsDir, run);
    return file ? pendingAsk(readTail(file, TAIL_BYTES)) : null;
  } catch {
    return null;
  }
}
