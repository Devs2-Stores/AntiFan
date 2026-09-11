import { describe, it } from 'node:test';
import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

describe('build-report embedded selfDrift handling', () => {
  it('does not crash when selfDrift is embedded without an external drift document and exceeds limit', () => {
    // The tracked fixture is a real 15-page canary run: run3-390.json has embedded selfDrift with
    // mismatchPercentage: 100 and no standalone drift document. It lives in test/fixtures so the
    // lane runs from a clean clone instead of depending on untracked .canary state.
    const tempOut = path.join(os.tmpdir(), `test-report-${Date.now()}.md`);

    try {
      const stdout = execFileSync(
        process.execPath,
        ['scripts/lib/build-report.mjs', 'test/fixtures/canary-run', '--out', tempOut, '--json'],
        {
          cwd: process.cwd(),
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
        }
      );

      const jsonStart = stdout.indexOf('{');
      assert.ok(jsonStart !== -1, 'Must emit JSON when --json is passed');
      const parsed = JSON.parse(stdout.slice(jsonStart));
      assert.strictEqual(parsed.verdict, 'INCONCLUSIVE');

      const vp390 = parsed.viewports.find((v) => v.viewport === '390x844' || v.label === 'run3-390');
      assert.ok(vp390, '390x844 viewport must be present in report output');
      assert.strictEqual(vp390.gate, 'INCONCLUSIVE');
      assert.ok(
        vp390.blockers.includes('EXCESSIVE_REFERENCE_DRIFT'),
        'Must record EXCESSIVE_REFERENCE_DRIFT blocker code'
      );

      // Verify the generated markdown contains the failure and the fallback evidence path
      const reportMd = fs.readFileSync(tempOut, 'utf8');
      assert.ok(
        reportMd.includes('EXCESSIVE_REFERENCE_DRIFT'),
        'Report must contain EXCESSIVE_REFERENCE_DRIFT'
      );
      assert.ok(
        reportMd.includes('evidence/run3-390.json'),
        'Report evidence path must fallback to viewport evidence document'
      );
    } finally {
      if (fs.existsSync(tempOut)) {
        fs.unlinkSync(tempOut);
      }
    }
  });
});
