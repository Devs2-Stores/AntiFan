import { describe, it } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  loadCachedReadinessFloors,
  validateProbedFloor,
  computeSha256,
} from '../../.canary/tools/canary-floors.mjs';

describe('canary-floors production helper contracts', () => {
  const VIEWPORTS = [
    { width: 1440, height: 900, label: 'run3-1440' },
    { width: 1024, height: 900, label: 'run3-1024' },
    { width: 390, height: 844, label: 'run3-390' },
  ];

  it('fails closed when floors file is missing', () => {
    const nonExistentFile = path.join(os.tmpdir(), 'missing-reference-floors.json');
    if (fs.existsSync(nonExistentFile)) fs.unlinkSync(nonExistentFile);

    assert.throws(
      () => loadCachedReadinessFloors(nonExistentFile, 'any_sha', VIEWPORTS),
      /is missing/
    );
  });

  it('fails closed when floors file is invalid JSON', () => {
    const tempFile = path.join(os.tmpdir(), `bad-json-${Date.now()}.json`);
    fs.writeFileSync(tempFile, 'invalid-json-content{');
    try {
      assert.throws(
        () => loadCachedReadinessFloors(tempFile, 'any_sha', VIEWPORTS),
        /not valid JSON/
      );
    } finally {
      if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile);
    }
  });

  it('fails closed when refSha256 does not match expected reference hash', () => {
    const tempFile = path.join(os.tmpdir(), `mismatched-sha-${Date.now()}.json`);
    fs.writeFileSync(
      tempFile,
      JSON.stringify({
        refSha256: 'stale_hash_from_older_capture',
        floors: {
          'run3-1440': { width: 1440, height: 900, minSections: 12, minCards: 25 },
          'run3-1024': { width: 1024, height: 900, minSections: 12, minCards: 25 },
          'run3-390': { width: 390, height: 844, minSections: 11, minCards: 25 },
        },
      })
    );
    try {
      assert.throws(
        () => loadCachedReadinessFloors(tempFile, 'fresh_live_reference_hash', VIEWPORTS),
        /does not match expected reference hash/
      );
    } finally {
      if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile);
    }
  });

  it('fails closed when a required viewport floor is missing or invalid', () => {
    const tempFile = path.join(os.tmpdir(), `missing-vp-${Date.now()}.json`);
    fs.writeFileSync(
      tempFile,
      JSON.stringify({
        refSha256: 'matched_sha',
        floors: {
          'run3-1440': { width: 1440, height: 900, minSections: 12, minCards: 25 },
          // run3-1024 is missing
          'run3-390': { width: 390, height: 844, minSections: 0, minCards: -1 },
        },
      })
    );
    try {
      assert.throws(
        () => loadCachedReadinessFloors(tempFile, 'matched_sha', VIEWPORTS),
        /has invalid floor for viewport/
      );
    } finally {
      if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile);
    }
  });

  it('fails closed when a viewport floor has mismatched geometry dimensions', () => {
    const tempFile = path.join(os.tmpdir(), `dim-mismatch-${Date.now()}.json`);
    fs.writeFileSync(
      tempFile,
      JSON.stringify({
        refSha256: 'matched_sha',
        floors: {
          'run3-1440': { width: 1440, height: 900, minSections: 12, minCards: 25 },
          'run3-1024': { width: 1024, height: 900, minSections: 12, minCards: 25 },
          // run3-390 has wrong width 412 instead of 390
          'run3-390': { width: 412, height: 844, minSections: 11, minCards: 25 },
        },
      })
    );
    try {
      assert.throws(
        () => loadCachedReadinessFloors(tempFile, 'matched_sha', VIEWPORTS),
        /has invalid floor for viewport run3-390/
      );
    } finally {
      if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile);
    }
  });

  it('fails closed when a viewport floor has non-integer section or card count', () => {
    const tempFile = path.join(os.tmpdir(), `fractional-count-${Date.now()}.json`);
    fs.writeFileSync(
      tempFile,
      JSON.stringify({
        refSha256: 'matched_sha',
        floors: {
          'run3-1440': { width: 1440, height: 900, minSections: 12.5, minCards: 25 },
          'run3-1024': { width: 1024, height: 900, minSections: 12, minCards: 25 },
          'run3-390': { width: 390, height: 844, minSections: 11, minCards: 25 },
        },
      })
    );
    try {
      assert.throws(
        () => loadCachedReadinessFloors(tempFile, 'matched_sha', VIEWPORTS),
        /has invalid floor for viewport run3-1440/
      );
    } finally {
      if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile);
    }
  });

  it('loads valid per-viewport floors (12 sections desktop, 11 sections mobile) matching refSha256', () => {
    const tempFile = path.join(os.tmpdir(), `valid-floors-${Date.now()}.json`);
    const expectedRefSha = computeSha256(Buffer.from('<html>test</html>'));
    const expectedFloors = {
      'run3-1440': { width: 1440, height: 900, minSections: 12, minCards: 25 },
      'run3-1024': { width: 1024, height: 900, minSections: 12, minCards: 25 },
      'run3-390': { width: 390, height: 844, minSections: 11, minCards: 25 },
    };
    fs.writeFileSync(
      tempFile,
      JSON.stringify({
        refSha256: expectedRefSha,
        floors: expectedFloors,
      })
    );
    try {
      const loaded = loadCachedReadinessFloors(tempFile, expectedRefSha, VIEWPORTS);
      assert.deepStrictEqual(loaded, expectedFloors);
      assert.strictEqual(loaded['run3-1440'].minSections, 12, 'Desktop floor is 12 sections');
      assert.strictEqual(loaded['run3-390'].minSections, 11, 'Mobile floor is 11 sections');
    } finally {
      if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile);
    }
  });

  describe('validateProbedFloor', () => {
    const vp = { width: 390, height: 844, label: 'run3-390' };

    it('rejects invalid probe objects', () => {
      assert.throws(() => validateProbedFloor(null, vp), /non-object/);
      assert.throws(() => validateProbedFloor(undefined, vp), /non-object/);
    });

    it('rejects invalid sectionCount (non-number, non-integer, or < 1)', () => {
      assert.throws(() => validateProbedFloor({ sectionCount: 0, productCardCount: 10 }, vp), /invalid sectionCount/);
      assert.throws(() => validateProbedFloor({ sectionCount: -5, productCardCount: 10 }, vp), /invalid sectionCount/);
      assert.throws(() => validateProbedFloor({ sectionCount: 2.5, productCardCount: 10 }, vp), /invalid sectionCount/);
      assert.throws(() => validateProbedFloor({ sectionCount: '12', productCardCount: 10 }, vp), /invalid sectionCount/);
    });

    it('rejects invalid productCardCount (non-number, non-integer, or < 0)', () => {
      assert.throws(() => validateProbedFloor({ sectionCount: 10, productCardCount: -1 }, vp), /invalid productCardCount/);
      assert.throws(() => validateProbedFloor({ sectionCount: 10, productCardCount: 3.14 }, vp), /invalid productCardCount/);
      assert.throws(() => validateProbedFloor({ sectionCount: 10, productCardCount: NaN }, vp), /invalid productCardCount/);
    });

    it('normalizes and returns valid probed floor', () => {
      const result = validateProbedFloor({ sectionCount: 11, productCardCount: 25, docHeight: 4481 }, vp);
      assert.deepStrictEqual(result, {
        width: 390,
        height: 844,
        minSections: 11,
        minCards: 25,
        docHeight: 4481,
      });
    });
  });
});
