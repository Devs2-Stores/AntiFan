/**
 * Which capsule owns a newly created tab.
 *
 * The rule exists because the process has ONE active capsule but many windows, each with its own
 * verified workspace: defaulting a tab to the active capsule files a tab opened in window B under
 * window A's capsule whenever A happens to be the active one. Live proof of the old behaviour is in
 * `plans/260927-0315-project-windows/reports/project-windows-matrix.json` (a popup and a
 * toolbar-created tab owned by window B carried `capsule-matrix-alpha`, window A's capsule).
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { resolveNewTabCapsuleId } from '../../src/main/browser/native-tab-host';

describe('new-tab capsule resolution', () => {
  it('prefers a measured capsule over both the window and the process-wide selection', () => {
    assert.strictEqual(
      resolveNewTabCapsuleId({
        explicit: 'capsule-source-tab',
        windowWorkspaceCapsuleId: 'capsule-window',
        activeCapsuleId: 'capsule-active',
      }),
      'capsule-source-tab',
    );
  });

  it('falls back to the window verified workspace before the active capsule', () => {
    assert.strictEqual(
      resolveNewTabCapsuleId({
        windowWorkspaceCapsuleId: 'capsule-window',
        activeCapsuleId: 'capsule-active',
      }),
      'capsule-window',
    );
  });

  it('falls back to the active capsule only when the window has no verified workspace', () => {
    assert.strictEqual(resolveNewTabCapsuleId({ activeCapsuleId: 'capsule-active' }), 'capsule-active');
    assert.strictEqual(resolveNewTabCapsuleId({ windowWorkspaceCapsuleId: null, activeCapsuleId: 'capsule-active' }), 'capsule-active');
  });

  it('reports no capsule when nothing measured one', () => {
    assert.strictEqual(resolveNewTabCapsuleId({}), undefined);
    assert.strictEqual(resolveNewTabCapsuleId({ explicit: '', windowWorkspaceCapsuleId: '   ', activeCapsuleId: null }), undefined);
  });

  it('never lets a blank string shadow a real capsule later in the chain', () => {
    assert.strictEqual(
      resolveNewTabCapsuleId({ explicit: '  ', windowWorkspaceCapsuleId: '', activeCapsuleId: 'capsule-active' }),
      'capsule-active',
    );
  });
});
