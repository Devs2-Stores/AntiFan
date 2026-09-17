import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

// The capture lane's host surface is what tells the port whether a tab can render at
// all: `assertRenderSurface` refuses bounded render work by reading the render
// surface, and it reads the session tab listing and the offscreen flag around it
// (`src/main/tools/browser-control-port.ts`). A harness that builds its own host
// adapter and omits these wires the gate as a silent no-op - the port skips the
// check whenever `readRenderSurface` is absent - so the harness can only ever prove
// a capture on a surface it never measured. That is a real divergence found in the
// live lanes, hence this structural check.
const CAPTURE_LANE_HOST_FIELDS = ['readRenderSurface', 'isTabOffscreen', 'getSessionTabList'];
// Session ownership: `anti.browser.tabs.create` adopts the tab it opens into the session
// pool, and closing a pooled tab is what records the anchor the failover path reads.
// Only the harness that drives tab creation and the close/failover case needs these.
const SESSION_OWNERSHIP_HOST_FIELDS = ['adoptChildTab', 'getManagedTabIds'];
// The transport decides whether the bound tab is still real by asking the catalogue to
// canonicalize it. With these delegates missing the catalogue answers "gone" for every
// live tab, so the harness reads a healthy session as stale: it warns on every dispatch
// and can never reach its heal path (`src/main/index.ts:327-330`).
const RUNTIME_DELEGATE_FIELDS = ['isTabAllowed', 'resolveTabId', 'resolveFailoverTabId', 'getDocumentGeneration'];

const ROOT = fs.existsSync(path.resolve(__dirname, '../../../src/main/index.ts'))
  ? path.resolve(__dirname, '../../..')
  : path.resolve(__dirname, '../..');

const HARNESSES = ['scripts/smoke-mcp-industrial-e2e.cjs', 'scripts/smoke-theme-golden-live.cjs'];
const SESSION_HARNESS = 'scripts/smoke-mcp-industrial-e2e.cjs';

describe('Capture-lane host adapters mirror the composition root', () => {
  it('keeps the composition root as the authority for the mirrored fields', () => {
    const root = fs.readFileSync(path.join(ROOT, 'src/main/index.ts'), 'utf8');
    for (const field of [...CAPTURE_LANE_HOST_FIELDS, ...SESSION_OWNERSHIP_HOST_FIELDS, ...RUNTIME_DELEGATE_FIELDS]) {
      assert.ok(
        root.includes(`${field}:`),
        `src/main/index.ts must still wire '${field}' into the browser port; until it does, this mirror list is stale and the harness check proves nothing`
      );
    }
  });

  it('wires the runtime delegates every harness needs to resolve a live bound tab', () => {
    for (const rel of HARNESSES) {
      const source = fs.readFileSync(path.join(ROOT, rel), 'utf8');
      for (const field of RUNTIME_DELEGATE_FIELDS) {
        assert.ok(
          source.includes(`${field}:`),
          `${rel} must mirror '${field}' from src/main/index.ts, or its transport reads a live session as stale`
        );
      }
    }
  });

  it('wires the same fields in every harness that asserts a capture', () => {
    for (const rel of HARNESSES) {
      const source = fs.readFileSync(path.join(ROOT, rel), 'utf8');
      for (const field of CAPTURE_LANE_HOST_FIELDS) {
        assert.ok(
          source.includes(`${field}:`),
          `${rel} must mirror '${field}' from src/main/index.ts, or its capture assertions ride an ungated path`
        );
      }
      if (rel !== SESSION_HARNESS) continue;
      for (const field of SESSION_OWNERSHIP_HOST_FIELDS) {
        assert.ok(
          source.includes(`${field}:`),
          `${rel} must mirror '${field}' from src/main/index.ts, or the failover it asserts cannot resolve`
        );
      }
    }
  });
});
