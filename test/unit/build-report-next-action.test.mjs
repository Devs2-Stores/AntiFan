import { describe, it } from 'node:test';
import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

describe('build-report next action interpolation and gating', () => {
  it('interpolates real metrics for viewports with compare blockers and does not throw on m.viewport.width', () => {
    const tempOut = path.join(os.tmpdir(), `test-report-action-${Date.now()}.md`);
    try {
      execFileSync(
        process.execPath,
        ['scripts/lib/build-report.mjs', 'test/fixtures/canary-run', '--out', tempOut],
        {
          cwd: process.cwd(),
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
        }
      );

      const content = fs.readFileSync(tempOut, 'utf8');
      assert.ok(content.includes('## 16. Next Action'), 'Must have Section 16');
      assert.ok(!/undefined|\bNaN\b/.test(content.split('## 16. Next Action')[1] || ''), 'Section 16 must never interpolate undefined or NaN');

      // Every viewport the gate held without a compare result must get an
      // interpolated action line, and every action line must name a viewport
      // whose geometry matches its own evidence. Asserting the live numbers
      // themselves would pin this test to one evidence snapshot.
      const gateSection = content.split('## 14. Final Fidelity Gate')[1]?.split('## 15.')[0] || '';
      const blocked = [...gateSection.matchAll(/^\|\s*(\d+)×(\d+)\s*\|[^|]*\|[^|]*\|([^|]*)\|/gm)]
        .filter(([, , , blockers]) => blockers.includes('COMPARE_STATUS_NOT_RESULT'))
        .map(([, w, h]) => `${w}×${h}`);
      assert.ok(blocked.length > 0, 'fixture evidence must expose at least one viewport held without a compare result');

      const nextSection = content.split('## 16. Next Action')[1] || '';
      const emitted = [...nextSection.matchAll(/For (\d+)×(\d+) \(([^)]+)\)/g)].map(([, w, h, label]) => ({ w, h, label }));
      assert.ok(emitted.length > 0, 'Section 16 must contain interpolated actions');
      for (const viewport of blocked) {
        assert.ok(
          emitted.some((e) => `${e.w}×${e.h}` === viewport),
          `Section 16 must interpolate an action for ${viewport}, which the gate held without a compare result`,
        );
      }
      for (const action of emitted) {
        const doc = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'test', 'fixtures', 'canary-run', 'evidence', `${action.label}.json`), 'utf8'));
        assert.strictEqual(action.w, String(doc.viewport.width), 'action width must come from that viewport document');
        assert.strictEqual(action.h, String(doc.viewport.height), 'action height must come from that viewport document');
      }
    } finally {
      if (fs.existsSync(tempOut)) {
        fs.unlinkSync(tempOut);
      }
    }
  });

  it('emits no mobile defect claim in Section 16 when mobile model has no compare blockers', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-test-'));
    const tempEvidence = path.join(tempDir, 'evidence');
    fs.mkdirSync(tempEvidence, { recursive: true });

    try {
      // Copy the tracked fixture evidence into tempDir
      const fixtureEvidence = path.join(process.cwd(), 'test/fixtures/canary-run/evidence');
      for (const file of fs.readdirSync(fixtureEvidence)) {
        fs.copyFileSync(path.join(fixtureEvidence, file), path.join(tempEvidence, file));
      }

      // Mutate run3-390.json in tempEvidence so it is completely clean of compare blockers
      const file390 = path.join(tempEvidence, 'run3-390.json');
      const data390 = JSON.parse(fs.readFileSync(file390, 'utf8'));

      delete data390.selfDrift;
      delete data390.authoritativePair;
      delete data390.atomicPair;

      const cleanPair = {
        captureStateCompatible: true,
        reference: {
          captureMode: 'full-page',
          cssViewport: { width: 390, height: 844 },
          cssCaptureSize: { width: 390, height: 4481 },
          rasterSize: { width: 390, height: 4481 },
          backend: 'cdp',
          dpr: 1,
        },
        clone: {
          captureMode: 'full-page',
          cssViewport: { width: 390, height: 844 },
          cssCaptureSize: { width: 390, height: 4481 },
          rasterSize: { width: 390, height: 4481 },
          backend: 'cdp',
          dpr: 1,
        },
      };

      data390.stages.authoritativePair = cleanPair;
      data390.stages.compare = {
        status: 'COMPLETE',
        real: true,
        match: true,
        mismatchPercentage: 0.1,
        verdict: 'PASS',
        authoritativePair: cleanPair,
      };
      data390.visual = {
        verdict: 'PASS',
        match: true,
        mismatchPercentage: 0.1,
      };
      fs.writeFileSync(file390, JSON.stringify(data390, null, 2));

      const tempOut = path.join(tempDir, 'REPORT.md');
      execFileSync(
        process.execPath,
        ['scripts/lib/build-report.mjs', tempDir, '--out', tempOut],
        {
          cwd: process.cwd(),
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
        }
      );

      const content = fs.readFileSync(tempOut, 'utf8');

      // Verify premise directly from generated Section 14 rationale: 390 is free of compare blockers
      const sec14 = content.slice(content.indexOf('## 14. Final Fidelity Gate'), content.indexOf('## 15. What Is Actually Proven'));
      assert.ok(!sec14.includes('390×844: COMPARE_STATUS_NOT_RESULT'), '390 must not have COMPARE_STATUS_NOT_RESULT blocker');
      assert.ok(!sec14.includes('390×844: CAPTURE_STATE_INCOMPATIBLE'), '390 must not have CAPTURE_STATE_INCOMPATIBLE blocker');

      const nextActionSection = content.slice(content.indexOf('## 16. Next Action'));
      assert.ok(
        !nextActionSection.includes('For 390×844'),
        'Section 16 must NOT emit mobile defect claim when mobile has no compare blocker'
      );
      // Desktop still had compare blockers, so it must still appear
      assert.ok(nextActionSection.includes('For 1440×900'), 'Desktop 1440 action must still be emitted');
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
