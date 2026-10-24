/**
 * Choosing the child frame a frame-targeted evaluation runs in.
 *
 * A caller can name a frame four ways: by a URL substring, by the frame's tree-node id
 * (the `child@<id>` figures of a miss census), by its position among the tab's child
 * frames, or by the CSS selector of the `<iframe>` element in the top document. The
 * tab's own top frame is never a candidate: running a caller's script in the top frame
 * when it asked for a child frame would execute it in the wrong context.
 *
 * Everything here is pure; the host supplies the frames and, for a selector, the facts
 * it read from the iframe element.
 */
import { CapabilityError } from '../../shared/control-plane-contracts';

/** The part of `Electron.WebFrameMain` that frame selection reads. */
export interface FrameLike {
  readonly frameTreeNodeId: number;
  readonly url: string;
  readonly name?: string;
}

/** A frame reference: a URL substring, or an object naming exactly the frame wanted. */
export type FrameRef = string | FrameRefObject;

export interface FrameRefObject {
  /** Case-insensitive substring of the frame's committed URL. */
  frameUrl?: string;
  /** `frameTreeNodeId` of the frame, as printed in the miss census. */
  frameId?: number;
  /** Zero-based position among the child frames of the tab (the top frame is not counted). */
  index?: number;
  /** CSS selector of the `<iframe>` element in the top document. */
  selector?: string;
}

/** What the page says about the iframe element a selector matched. */
export interface IframeElementFacts {
  /** Resolved `src` attribute (absolute), or '' for srcdoc / src-less frames. */
  src: string;
  name: string;
  /** Position of the element among every `iframe, frame` element of the top document. */
  domIndex: number;
  /** Position of the element among the iframes sharing the same resolved `src`. */
  sameSrcOrdinal: number;
}

export type NormalizedFrameRef =
  | { kind: 'frameId'; frameId: number }
  | { kind: 'index'; index: number }
  | { kind: 'selector'; selector: string }
  | { kind: 'url'; frameUrl: string };

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Reduce a caller reference to the single way it names a frame. When several are given
 * the most specific identity wins: frameId, then index, then selector, then URL.
 */
export function normalizeFrameRef(ref: unknown): NormalizedFrameRef {
  if (typeof ref === 'string') {
    if (!ref.trim()) throw new CapabilityError('INVALID_ARGUMENT', 'frameUrl substring must not be empty');
    return { kind: 'url', frameUrl: ref };
  }
  if (!isPlainObject(ref)) {
    throw new CapabilityError('INVALID_ARGUMENT', 'A frame reference is required: frameUrl, frameId, frameIndex or frameSelector');
  }
  const { frameId, index, selector, frameUrl } = ref;
  if (frameId !== undefined && frameId !== null && frameId !== '') {
    const id = typeof frameId === 'number' ? frameId : Number(frameId);
    if (!Number.isInteger(id) || id < 0) throw new CapabilityError('INVALID_ARGUMENT', `frameId must be a non-negative integer, got ${JSON.stringify(frameId)}`);
    return { kind: 'frameId', frameId: id };
  }
  if (index !== undefined && index !== null) {
    const position = typeof index === 'number' ? index : Number(index);
    if (!Number.isInteger(position) || position < 0) throw new CapabilityError('INVALID_ARGUMENT', `frame index must be a non-negative integer, got ${JSON.stringify(index)}`);
    return { kind: 'index', index: position };
  }
  if (typeof selector === 'string' && selector.trim()) return { kind: 'selector', selector: selector.trim() };
  if (typeof frameUrl === 'string' && frameUrl.trim()) return { kind: 'url', frameUrl };
  throw new CapabilityError('INVALID_ARGUMENT', 'A frame reference is required: frameUrl, frameId, frameIndex or frameSelector');
}

/** Every frame of the tab in one line, so a miss tells the caller what to name. */
export function describeFrameCensus(root: FrameLike | null | undefined, frames: readonly FrameLike[]): string {
  let childPosition = 0;
  const census = frames
    .map((frame) => {
      const name = frame.name ? ` name=${JSON.stringify(frame.name.slice(0, 60))}` : '';
      const label = frame === root ? 'top' : `child#${childPosition++}`;
      return `${label}@${frame.frameTreeNodeId}${name}=${String(frame.url || '').slice(0, 160) || '(no url)'}`;
    })
    .join(' | ');
  return census || '(none)';
}

/**
 * Page-side expression that reads the facts of the `<iframe>` element `selector` matches in
 * the top document. Resolves to `{ error }` for a selector that is invalid or matches nothing
 * (or a non-frame element) so the failure is typed in the main process, never an opaque throw.
 */
export function buildIframeProbeExpression(selector: string): string {
  return `(() => {
  const selector = ${JSON.stringify(selector)};
  let el;
  try { el = document.querySelector(selector); }
  catch (err) { return { error: 'invalid', message: String(err && err.message || err) }; }
  if (!el) return { error: 'missing' };
  const tag = String(el.tagName || '').toLowerCase();
  if (tag !== 'iframe' && tag !== 'frame') return { error: 'not-frame', tag };
  const all = Array.from(document.querySelectorAll('iframe, frame'));
  const src = el.src || '';
  return {
    src,
    name: el.getAttribute('name') || el.name || '',
    domIndex: all.indexOf(el),
    sameSrcOrdinal: all.filter((other) => (other.src || '') === src).indexOf(el),
  };
})()`;
}

export type IframeProbeResult =
  | IframeElementFacts
  | { error: 'invalid'; message?: string }
  | { error: 'missing' }
  | { error: 'not-frame'; tag?: string };

/** Validate the page's answer to {@link buildIframeProbeExpression}. */
export function readIframeProbe(selector: string, tabId: string, raw: unknown): IframeElementFacts {
  if (!isPlainObject(raw)) {
    throw new CapabilityError('SELECTOR_NOT_FOUND', `Frame selector "${selector}" could not be read in tab ${tabId}`);
  }
  if (raw.error === 'invalid') {
    throw new CapabilityError('INVALID_SELECTOR', `"${selector}" is not a valid CSS selector${typeof raw.message === 'string' && raw.message ? `: ${raw.message}` : ''}`, { selector });
  }
  if (raw.error === 'missing') {
    throw new CapabilityError('SELECTOR_NOT_FOUND', `No element in the top document of tab ${tabId} matches frame selector "${selector}"`, { selector });
  }
  if (raw.error === 'not-frame') {
    throw new CapabilityError('SELECTOR_NOT_FOUND', `Frame selector "${selector}" matches a <${String(raw.tag || 'element')}>, not an <iframe>`, { selector });
  }
  return {
    src: typeof raw.src === 'string' ? raw.src : '',
    name: typeof raw.name === 'string' ? raw.name : '',
    domIndex: Number.isInteger(raw.domIndex) ? Number(raw.domIndex) : -1,
    sameSrcOrdinal: Number.isInteger(raw.sameSrcOrdinal) ? Number(raw.sameSrcOrdinal) : 0,
  };
}

const stripHash = (url: string): string => {
  const at = url.indexOf('#');
  return (at === -1 ? url : url.slice(0, at)).toLowerCase();
};

/**
 * Pick the child frame a normalized reference names. `facts` is required for a selector
 * reference (read from the iframe element by the caller).
 *
 * Selector resolution prefers the frame's `name`, then its committed URL (the occurrence
 * among iframes of the same `src` disambiguates repeats), then the element's position
 * among the top document's frames.
 */
export function selectChildFrame<F extends FrameLike>(
  root: F | null | undefined,
  frames: readonly F[],
  ref: NormalizedFrameRef,
  tabId: string,
  facts?: IframeElementFacts
): F {
  const children = frames.filter((frame) => frame !== root);
  const miss = (what: string): CapabilityError =>
    new CapabilityError('SELECTOR_NOT_FOUND', `No child frame in tab ${tabId} matches ${what}. Frames: ${describeFrameCensus(root, [...(root ? [root] : []), ...children])}`);

  switch (ref.kind) {
    case 'url': {
      const needle = ref.frameUrl.toLowerCase();
      const match = children.find((frame) => String(frame.url || '').toLowerCase().includes(needle));
      if (match) return match;
      throw miss(`"${ref.frameUrl}"`);
    }
    case 'frameId': {
      const match = children.find((frame) => frame.frameTreeNodeId === ref.frameId);
      if (match) return match;
      throw miss(`frameId ${ref.frameId}`);
    }
    case 'index': {
      const match = children[ref.index];
      if (match) return match;
      throw miss(`frame index ${ref.index} (the tab has ${children.length} child frame${children.length === 1 ? '' : 's'})`);
    }
    case 'selector': {
      if (!facts) throw new CapabilityError('INVALID_ARGUMENT', `Frame selector "${ref.selector}" needs the iframe element facts`);
      if (facts.name) {
        const byName = children.find((frame) => frame.name === facts.name);
        if (byName) return byName;
      }
      if (facts.src) {
        const wanted = stripHash(facts.src);
        const sameUrl = children.filter((frame) => stripHash(String(frame.url || '')) === wanted);
        const candidates = sameUrl.length > 0 ? sameUrl : children.filter((frame) => stripHash(String(frame.url || '')).startsWith(wanted));
        if (candidates.length > 0) {
          const ordinal = candidates.length === 1 ? 0 : Math.min(Math.max(0, facts.sameSrcOrdinal), candidates.length - 1);
          const chosen = candidates[ordinal];
          if (chosen) return chosen;
        }
      }
      // A src-less, srcdoc or redirected frame is only identifiable by its place in the document.
      const byPosition = facts.domIndex >= 0 ? children[facts.domIndex] : undefined;
      if (byPosition) return byPosition;
      throw miss(`frame selector "${ref.selector}"`);
    }
  }
}
