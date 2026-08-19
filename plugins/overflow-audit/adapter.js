/**
 * Overflow Audit — isolated site adapter. Runs in an isolated world; only
 * receives schema-limited messages and returns a plain evidence object.
 * No Node, IPC, filesystem, or Chat API access (SDK v1 rule).
 */
'use strict';

/**
 * Determine clipped / overflowing elements in the document.
 * Returns { ok, overflowCount, clipped } as a schema-limited message.
 */
function auditOverflow(root) {
  const doc = root && root.ownerDocument ? root : (root || document);
  const clipped = [];
  const bodies = doc.getElementsByTagName('body');
  const body = bodies[0];
  if (!body) return { ok: true, overflowCount: 0, clipped: [] };

  const limit = 50;
  const all = doc.querySelectorAll('*');
  for (let i = 0; i < all.length && clipped.length < limit; i++) {
    const el = all[i];
    if (!(el instanceof HTMLElement)) continue;
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) continue;
    const cs = getComputedStyle(el);
    // clipped horizontally or vertically by an ancestor scroll container
    if (cs.overflowX === 'hidden' || cs.overflowY === 'hidden' || cs.textOverflow === 'ellipsis') {
      if (r.right > 0 && r.bottom > 0) {
        clipped.push({
          tag: el.tagName.toLowerCase(),
          cls: (el.getAttribute('class') || '').split(/\s+/).slice(0, 3),
          w: Math.round(r.width),
          h: Math.round(r.height),
          text: (el.textContent || '').trim().slice(0, 40),
        });
      }
    }
  }
  return { ok: true, overflowCount: clipped.length, clipped };
}

// Isolated world message contract: { type, root?, url? } -> { ok, overflowCount, clipped }
const handler = (message) => {
  if (!message || message.type !== 'audit-overflow') {
    return { ok: false, error: 'unsupported-message' };
  }
  return auditOverflow(message.root || undefined);
};

// window-bound for the isolated page world
if (typeof window !== 'undefined') {
  window.__overflowAudit = handler;
}
module.exports = handler;