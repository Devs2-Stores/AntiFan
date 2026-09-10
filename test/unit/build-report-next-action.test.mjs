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
        ['.canary/tools/build-report.mjs', '.canary/run3', '--out', tempOut],
        {
          cwd: process.cwd(),
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
        }
      );

      const content = fs.readFileSync(tempOut, 'utf8');
      assert.ok(content.includes('## 16. Next Action'), 'Must have Section 16');
      assert.ok(content.includes('For 1440×900 (run3-1440)'), 'Must interpolate 1440x900 action');
      assert.ok(content.includes('For 1024×900 (run3-1024)'), 'Must interpolate 1024x900 action');
      assert.ok(content.includes('For 390×844 (run3-390)'), 'Must interpolate 390x844 action');
      assert.ok(content.includes('390×844 vs clone: 660×1429'), 'Must assert exact CSS viewport mismatch string');
      assert.ok(content.includes('390×4481 vs 660×14489'), 'Must assert exact capture size mismatch string');
      assert.ok(!content.includes('undefined×undefined'), 'Must never output undefined dimensions');
      assert.ok(content.includes('10008 px height delta'), 'Must interpolate real 390 docHeight delta');
      assert.ok(content.includes('270 px horizontal root overflow'), 'Must interpolate real 390 overflow');
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
      // Copy run3 evidence files into tempDir
      const run3Evidence = path.join(process.cwd(), '.canary/run3/evidence');
      for (const file of fs.readdirSync(run3Evidence)) {
        fs.copyFileSync(path.join(run3Evidence, file), path.join(tempEvidence, file));
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
        ['.canary/tools/build-report.mjs', tempDir, '--out', tempOut],
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
