import * as crypto from 'node:crypto';

import { canonicalJsonStringify } from '../../shared/control-plane-contracts';
import type { InvocationRecord } from './invocation-ledger';

export type { InvocationRecord };

/**
 * The persisted invocation-frame contract in one place: the frame hash, the byte ceiling,
 * and the one definition of a line boundary.
 *
 * ## Why this module exists
 *
 * The ledger writes one JSON line per dispatch into `invocations/*.jsonl` and admits a line
 * only when `sha256(canonicalJsonStringify(frameWithoutChecksum))` reproduces the `checksum`
 * the writer recorded (`invocation-ledger.ts:197-202`). That hash **is** the definition of
 * the persisted format. A second copy of it would be a second source of truth, and any drift
 * between the two copies would silently flip frames between admitted and rejected — the
 * exact failure a line-level accounting reader exists to remove. So the writer
 * (`invocation-ledger.ts`) and the read-only accounting reader share this module instead of
 * each deriving the format.
 *
 * ## Import contract (structural, not stylistic)
 *
 * This module must not import `electron`, `control-plane-runtime`, `capability-transport` or
 * `invocation-ledger`, and the reader that imports it must not either. Importing the ledger
 * would link the `InvocationLedger` class and make `initialize()` — which creates
 * directories, replays partitions, re-quarantines and renames files — reachable from a
 * read-only pass. `InvocationRecord` enters **only** as a type (`import type` + `export type`),
 * both erased at emit, so no runtime edge to the ledger exists in either direction: the
 * ledger depends on this module by value, this module depends on the ledger only for a type.
 *
 * The module is therefore loadable from a plain Node process and from a `node:worker_threads`
 * worker (the accounting CLI and its worker both do exactly that). Its runtime dependency set
 * is `node:crypto` plus `../../shared/control-plane-contracts`.
 */

/**
 * Largest serialized invocation frame the ledger will persist, **including** its single
 * `'\n'` terminator.
 *
 * MOVED here verbatim from `invocation-ledger.ts:13` (plan.md constraint B) so that both
 * halves of the format — the hash and the ceiling it bounds — live in the one module the
 * read-only reader may import. The ledger re-exports it from its previous path, because two
 * scripts destructure it from the **compiled ledger**:
 * `scripts/certify-core-freeze.cjs:60` (asserted against the freeze ceiling at `:62-64`) and
 * `scripts/smoke-real-soak.cjs:25` (asserted at `:199`).
 */
export const DEFAULT_MAX_INVOCATION_FRAME_BYTES = 64 * 1024 * 1024;

/**
 * The recorded checksum of a frame: `sha256` over `canonicalJsonStringify` of the frame with
 * its `checksum` field removed.
 *
 * Moved verbatim from `invocation-ledger.ts:90-93`; the caller strips `checksum` exactly as
 * the ledger does (`const { checksum, ...rest } = frame`). This is the **only** admission
 * authority: a line is admitted iff this value equals the `checksum` that was persisted.
 */
export function computeFrameChecksum(frame: Omit<InvocationRecord, 'checksum'>): string {
  const serialized = canonicalJsonStringify(frame);
  return crypto.createHash('sha256').update(serialized, 'utf8').digest('hex');
}

/**
 * Diagnostic variant of {@link computeFrameChecksum}: the same hash over the same
 * canonicalizer, with `null`s **inside arrays** mapped to `undefined` first.
 *
 * ## Why it exists — and why it must never gate an admission
 *
 * The writer hashes the **in-memory** record, then serializes it. Where an array slot holds
 * `undefined`, `canonicalJsonStringify` renders that slot as an empty string through
 * `Array.prototype.join` (`src/shared/control-plane-contracts.ts:510-511` via `:508`), while
 * `JSON.stringify` writes `null` into the persisted line (`invocation-ledger.ts:802`). A frame
 * that went through that path therefore cannot reproduce its own recorded checksum from the
 * bytes on disk — which is why the ledger has already quarantined the whole partition around
 * it (`:199-202` → `:260-271`), stranding every intact frame in that file.
 *
 * This variant is a **sub-reason for a line that has already failed the strict comparison**,
 * never a normalization applied before hashing. The counterexample is measured, not
 * hypothetical: 5 frames in the live store contain arrays of literal `null` — they **pass**
 * strict (the in-memory value really was `null`) while **failing** this variant. Normalizing
 * before hashing would flip those 5 valid frames to `CHECKSUM_MISMATCH`, so the strict result
 * is computed first and alone decides admission.
 *
 * Only array slots are converted. A `null` **object property** is rendered as `"null"` by the
 * canonicalizer and is therefore left untouched: mapping it to `undefined` would drop the key
 * at `control-plane-contracts.ts:514` and change the hash for a different reason.
 */
export function computeFrameChecksumNullArrayVariant(frame: Omit<InvocationRecord, 'checksum'>): string {
  const serialized = canonicalJsonStringify(mapArrayNullsToUndefined(frame));
  return crypto.createHash('sha256').update(serialized, 'utf8').digest('hex');
}

/** Maps `null` array slots to `undefined`, recursively, leaving object properties alone. */
function mapArrayNullsToUndefined(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => (item === null ? undefined : mapArrayNullsToUndefined(item)));
  }
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const mapped: Record<string, unknown> = {};
    for (const key of Object.keys(record)) {
      mapped[key] = mapArrayNullsToUndefined(record[key]);
    }
    return mapped;
  }
  return value;
}

/**
 * One line of a persisted partition, as byte offsets into the buffer it was read from.
 *
 * - `start` is the inclusive **byte** offset of the span's first byte.
 * - `end` is the exclusive **byte** offset of the span's text: a single `0x0D` immediately
 *   preceding the terminating `0x0A` is excluded, exactly as the `/\r?\n/` split the ledger
 *   used at `:177`/`:418` excluded it.
 * - `text` is `raw.toString('utf8', start, end)`.
 * - `terminated` is true iff the span ended at a `0x0A`.
 *
 * Offsets are byte offsets, never UTF-16 string indices, so a boundary that falls inside a
 * multi-byte UTF-8 sequence cannot shift the spans that follow it. A `0x0A` byte can never
 * occur inside a multi-byte UTF-8 sequence, so a span boundary can only fall between
 * characters — but a **census boundary** can cut one (Phase 2's `size + 1` probe), and the
 * offsets stay exact when it does: `end - start` is the span's byte width even when `text`
 * decodes a truncated sequence to U+FFFD and its `Buffer.byteLength` differs.
 *
 * ## The byte ceiling, stated rather than inherited
 *
 * Because `text` excludes the terminator in both the LF and the CRLF case,
 * `Buffer.byteLength(span.text, 'utf8') + 1` is literally the ledger's `:178`/`:836` spelling
 * (`Buffer.byteLength(payload, 'utf8') + 1 > maxFrameBytes`) and equals `:803`'s
 * `Buffer.byteLength(line, 'utf8')` for the only line the writer ever produces, which ends in
 * a bare `'\n'` (`:802`, and compaction at `:841`). That is the comparison the accounting
 * reader uses for its `oversizeLine` label. `span.end - span.start` is **not** that quantity
 * (one byte looser for LF, two for CRLF) and must never be substituted for it.
 */
export interface FrameLineSpan {
  start: number;
  end: number;
  text: string;
  terminated: boolean;
}

/**
 * Splits a buffer into line spans, deciding every boundary in this one function.
 *
 * A span ends at each `0x0A`; a single `0x0D` immediately before it is excluded from `text`.
 * A trailing span with no terminator is emitted verbatim, and no empty span is emitted after
 * a final terminator (so a file ending in `'\n'` yields no phantom span at its end offset).
 *
 * `splitFrameLines` and the accounting reader are both expressed over this function, so
 * "what a line is" has exactly one definition rather than three.
 */
export function frameLineSpans(raw: Buffer): FrameLineSpan[] {
  const spans: FrameLineSpan[] = [];
  let start = 0;
  while (start < raw.length) {
    const newlineIndex = raw.indexOf(0x0a, start);
    if (newlineIndex === -1) {
      spans.push({
        start,
        end: raw.length,
        text: raw.toString('utf8', start, raw.length),
        terminated: false,
      });
      break;
    }
    const textEnd = newlineIndex > start && raw[newlineIndex - 1] === 0x0d ? newlineIndex - 1 : newlineIndex;
    spans.push({
      start,
      end: textEnd,
      text: raw.toString('utf8', start, textEnd),
      terminated: true,
    });
    start = newlineIndex + 1;
  }
  return spans;
}

/**
 * {@link frameLineSpans} projected to non-blank texts — the identical predicate the ledger
 * applies at `:177` and `:418` (`line.trim().length > 0`), so both ledger call sites and the
 * accounting reader share one boundary decision.
 *
 * The string form is kept because the ledger reads partitions as text
 * (`fs.readFileSync(filePath, 'utf8')`, `:176`). `Buffer.from(raw, 'utf8')` cannot introduce
 * or move a `0x0A`: multi-byte sequences are all `>= 0x80`, and a lone surrogate re-encodes
 * to U+FFFD. A span boundary is a byte position, so decoding each span as UTF-8 reproduces
 * exactly the substrings `raw.split(/\r?\n/)` produced.
 */
export function splitFrameLines(raw: string): string[] {
  return frameLineSpans(Buffer.from(raw, 'utf8'))
    .filter((span) => span.text.trim().length > 0)
    .map((span) => span.text);
}
