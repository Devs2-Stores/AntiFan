/**
 * AntiFan Core - Sparse Interaction Delta Computer
 *
 * Pure domain function: compares before and after RawBehaviorScope snapshots.
 * Adheres to:
 * 1. Immutability: never mutates input snapshots.
 * 2. Tri-state field status: 'changed' | 'unchanged' | 'unavailable'.
 * 3. Bounded scope: compares only verified captured fields (classes, rect, style, aria, overlays, document).
 * 4. Tolerance-aware: geometric delta uses configurable pixel threshold to reject rendering noise.
 */

import {
  DeltaFieldStatus,
  OverlayCandidateDelta,
  RawBehaviorScope,
  RawOverlayCandidate,
  SparseInteractionDelta,
} from './interaction-contract.js';

function shallowArraysEqual(a?: string[], b?: string[]): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  if (a.length !== b.length) return false;
  const sortedA = [...a].sort();
  const sortedB = [...b].sort();
  for (let i = 0; i < sortedA.length; i++) {
    if (sortedA[i] !== sortedB[i]) return false;
  }
  return true;
}

function getOverlayKey(candidate: RawOverlayCandidate): string {
  if (candidate.id && candidate.id.trim().length > 0) {
    return `#${candidate.id.trim()}`;
  }
  return `${candidate.tagName}.${candidate.className || ''}`;
}

export function isGeometryChanged(
  before: { width: number; height: number; x?: number; y?: number },
  after: { width: number; height: number; x?: number; y?: number },
  tolerancePx = 1.0
): boolean {
  const dw = Math.abs(after.width - before.width);
  const dh = Math.abs(after.height - before.height);
  const dx = Math.abs((after.x ?? 0) - (before.x ?? 0));
  const dy = Math.abs((after.y ?? 0) - (before.y ?? 0));
  return dw > tolerancePx || dh > tolerancePx || dx > tolerancePx || dy > tolerancePx;
}

export function computeSparseInteractionDelta(
  before: RawBehaviorScope | null | undefined,
  after: RawBehaviorScope | null | undefined,
  options?: { geometryTolerancePx?: number }
): SparseInteractionDelta {
  const tolerance = options?.geometryTolerancePx ?? 1.0;
  const result: SparseInteractionDelta = {
    target: {},
    overlayCandidateDelta: {
      added: [],
      removed: [],
      retained: [],
    },
    document: {},
  };

  // 1. Target Comparison
  const beforeTarget = before?.target;
  const afterTarget = after?.target;

  if (!beforeTarget?.found && !afterTarget?.found) {
    result.target.classes = { status: 'unavailable', reason: 'Target element was not found in either snapshot' };
    result.target.rect = { status: 'unavailable', reason: 'Target element was not found in either snapshot' };
    result.target.style = { status: 'unavailable', reason: 'Target element was not found in either snapshot' };
    result.target.aria = { status: 'unavailable', reason: 'Target element was not found in either snapshot' };
  } else if (!beforeTarget?.found && afterTarget?.found) {
    result.target.classes = { status: 'changed', before: [], after: afterTarget.classes || [] };
    result.target.rect = { status: 'changed', before: { x: 0, y: 0, width: 0, height: 0 }, after: afterTarget.rect || { x: 0, y: 0, width: 0, height: 0 } };
    result.target.style = {
      status: 'changed',
      before: { display: 'none', visibility: 'hidden', opacity: '0', transform: 'none' },
      after: {
        display: afterTarget.display || 'none',
        visibility: afterTarget.visibility || 'hidden',
        opacity: afterTarget.opacity || '1',
        transform: afterTarget.transform || 'none',
      },
    };
    result.target.aria = {
      status: 'changed',
      before: { ariaExpanded: null, ariaHidden: null, ariaSelected: null, ariaModal: null },
      after: {
        ariaExpanded: afterTarget.ariaExpanded ?? null,
        ariaHidden: afterTarget.ariaHidden ?? null,
        ariaSelected: afterTarget.ariaSelected ?? null,
        ariaModal: afterTarget.ariaModal ?? null,
      },
    };
  } else if (beforeTarget?.found && !afterTarget?.found) {
    result.target.classes = { status: 'changed', before: beforeTarget.classes || [], after: [] };
    result.target.rect = { status: 'changed', before: beforeTarget.rect || { x: 0, y: 0, width: 0, height: 0 }, after: { x: 0, y: 0, width: 0, height: 0 } };
    result.target.style = {
      status: 'changed',
      before: {
        display: beforeTarget.display || 'none',
        visibility: beforeTarget.visibility || 'hidden',
        opacity: beforeTarget.opacity || '1',
        transform: beforeTarget.transform || 'none',
      },
      after: { display: 'none', visibility: 'hidden', opacity: '0', transform: 'none' },
    };
    result.target.aria = {
      status: 'changed',
      before: {
        ariaExpanded: beforeTarget.ariaExpanded ?? null,
        ariaHidden: beforeTarget.ariaHidden ?? null,
        ariaSelected: beforeTarget.ariaSelected ?? null,
        ariaModal: beforeTarget.ariaModal ?? null,
      },
      after: { ariaExpanded: null, ariaHidden: null, ariaSelected: null, ariaModal: null },
    };
  } else if (beforeTarget && afterTarget) {
    // Classes
    const bClasses = beforeTarget.classes || [];
    const aClasses = afterTarget.classes || [];
    if (!shallowArraysEqual(bClasses, aClasses)) {
      result.target.classes = { status: 'changed', before: bClasses, after: aClasses };
    } else {
      result.target.classes = { status: 'unchanged', value: bClasses };
    }

    // Rect (with tolerance check)
    const bRect = beforeTarget.rect || { x: 0, y: 0, width: 0, height: 0 };
    const aRect = afterTarget.rect || { x: 0, y: 0, width: 0, height: 0 };
    const dx = aRect.x - bRect.x;
    const dy = aRect.y - bRect.y;
    const dw = aRect.width - bRect.width;
    const dh = aRect.height - bRect.height;
    if (isGeometryChanged(bRect, aRect, tolerance)) {
      result.target.rect = { status: 'changed', before: bRect, after: aRect, delta: { dx, dy, dw, dh } };
    } else {
      result.target.rect = { status: 'unchanged', value: bRect };
    }

    // Style
    const bStyle = {
      display: beforeTarget.display || '',
      visibility: beforeTarget.visibility || '',
      opacity: beforeTarget.opacity || '',
      transform: beforeTarget.transform || '',
    };
    const aStyle = {
      display: afterTarget.display || '',
      visibility: afterTarget.visibility || '',
      opacity: afterTarget.opacity || '',
      transform: afterTarget.transform || '',
    };
    if (
      bStyle.display !== aStyle.display ||
      bStyle.visibility !== aStyle.visibility ||
      bStyle.opacity !== aStyle.opacity ||
      bStyle.transform !== aStyle.transform
    ) {
      result.target.style = { status: 'changed', before: bStyle, after: aStyle };
    } else {
      result.target.style = { status: 'unchanged', value: bStyle };
    }

    // Aria
    const bAria = {
      ariaExpanded: beforeTarget.ariaExpanded ?? null,
      ariaHidden: beforeTarget.ariaHidden ?? null,
      ariaSelected: beforeTarget.ariaSelected ?? null,
      ariaModal: beforeTarget.ariaModal ?? null,
    };
    const aAria = {
      ariaExpanded: afterTarget.ariaExpanded ?? null,
      ariaHidden: afterTarget.ariaHidden ?? null,
      ariaSelected: afterTarget.ariaSelected ?? null,
      ariaModal: afterTarget.ariaModal ?? null,
    };
    if (
      bAria.ariaExpanded !== aAria.ariaExpanded ||
      bAria.ariaHidden !== aAria.ariaHidden ||
      bAria.ariaSelected !== aAria.ariaSelected ||
      bAria.ariaModal !== aAria.ariaModal
    ) {
      result.target.aria = { status: 'changed', before: bAria, after: aAria };
    } else {
      result.target.aria = { status: 'unchanged', value: bAria };
    }
  }

  // 2. Overlay Candidates Comparison
  const beforeOverlays = before?.activeOverlays || [];
  const afterOverlays = after?.activeOverlays || [];

  const beforeMap = new Map<string, RawOverlayCandidate>();
  for (const o of beforeOverlays) {
    beforeMap.set(getOverlayKey(o), o);
  }

  const afterMap = new Map<string, RawOverlayCandidate>();
  for (const o of afterOverlays) {
    afterMap.set(getOverlayKey(o), o);
  }

  for (const [key, afterO] of afterMap.entries()) {
    const beforeO = beforeMap.get(key);
    if (!beforeO) {
      result.overlayCandidateDelta.added.push(afterO);
    } else {
      const rectChanged = isGeometryChanged(beforeO.rect, afterO.rect, tolerance);
      result.overlayCandidateDelta.retained.push({
        before: beforeO,
        after: afterO,
        rectChanged,
      });
    }
  }

  for (const [key, beforeO] of beforeMap.entries()) {
    if (!afterMap.has(key)) {
      result.overlayCandidateDelta.removed.push(beforeO);
    }
  }

  // 3. Document Comparison
  if (!before || !after) {
    result.document.url = { status: 'unavailable', reason: 'One or both document snapshots missing' };
    result.document.bodyClasses = { status: 'unavailable', reason: 'One or both document snapshots missing' };
    result.document.bodyOverflowLocked = { status: 'unavailable', reason: 'One or both document snapshots missing' };
    result.document.hasHorizontalOverflow = { status: 'unavailable', reason: 'One or both document snapshots missing' };
  } else {
    // URL
    if (before.url !== after.url) {
      result.document.url = { status: 'changed', before: before.url, after: after.url };
    } else {
      result.document.url = { status: 'unchanged', value: before.url };
    }

    // Body classes
    const bBodyClasses = before.bodyClasses || [];
    const aBodyClasses = after.bodyClasses || [];
    if (!shallowArraysEqual(bBodyClasses, aBodyClasses)) {
      result.document.bodyClasses = { status: 'changed', before: bBodyClasses, after: aBodyClasses };
    } else {
      result.document.bodyClasses = { status: 'unchanged', value: bBodyClasses };
    }

    // Body overflow locked
    if (before.bodyOverflowLocked !== after.bodyOverflowLocked) {
      result.document.bodyOverflowLocked = { status: 'changed', before: before.bodyOverflowLocked, after: after.bodyOverflowLocked };
    } else {
      result.document.bodyOverflowLocked = { status: 'unchanged', value: before.bodyOverflowLocked };
    }

    // Horizontal overflow
    if (before.hasHorizontalOverflow !== after.hasHorizontalOverflow) {
      result.document.hasHorizontalOverflow = { status: 'changed', before: before.hasHorizontalOverflow, after: after.hasHorizontalOverflow };
    } else {
      result.document.hasHorizontalOverflow = { status: 'unchanged', value: before.hasHorizontalOverflow };
    }
  }

  return result;
}

export function hasAnyObservableChange(delta: SparseInteractionDelta): boolean {
  const targetChanged =
    delta.target.classes?.status === 'changed' ||
    delta.target.rect?.status === 'changed' ||
    delta.target.style?.status === 'changed' ||
    delta.target.aria?.status === 'changed';

  const overlayChanged =
    delta.overlayCandidateDelta.added.length > 0 ||
    delta.overlayCandidateDelta.removed.length > 0 ||
    delta.overlayCandidateDelta.retained.some(r => r.rectChanged);

  const documentChanged =
    delta.document.url?.status === 'changed' ||
    delta.document.bodyClasses?.status === 'changed' ||
    delta.document.bodyOverflowLocked?.status === 'changed' ||
    delta.document.hasHorizontalOverflow?.status === 'changed';

  return Boolean(targetChanged || overlayChanged || documentChanged);
}
