import fs from 'node:fs';
import crypto from 'node:crypto';

export function computeSha256(bufOrStr) {
  return crypto.createHash('sha256').update(bufOrStr).digest('hex');
}

/**
 * Validates and loads cached per-viewport readiness floors from reference-floors.json.
 * Fails closed if the file is missing, JSON invalid, refSha256 does not match, or any required viewport is missing.
 */
export function loadCachedReadinessFloors(floorsFile, expectedRefSha, viewports) {
  if (!fs.existsSync(floorsFile)) {
    throw new Error(`Cannot safely determine per-viewport readiness floors: ${floorsFile} is missing. Rerun without --skip-capture.`);
  }
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(floorsFile, 'utf8'));
  } catch (err) {
    throw new Error(`Cannot safely determine per-viewport readiness floors: ${floorsFile} is not valid JSON (${err.message}). Rerun without --skip-capture.`);
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new Error(`Cannot safely determine per-viewport readiness floors: ${floorsFile} did not contain an object. Rerun without --skip-capture.`);
  }
  if (parsed.refSha256 !== expectedRefSha) {
    throw new Error(
      `Cannot safely determine per-viewport readiness floors: ${floorsFile} refSha256 (${parsed.refSha256}) does not match expected reference hash (${expectedRefSha}). Rerun without --skip-capture.`
    );
  }
  if (!parsed.floors || typeof parsed.floors !== 'object') {
    throw new Error(`Cannot safely determine per-viewport readiness floors: ${floorsFile} missing 'floors' object. Rerun without --skip-capture.`);
  }
  for (const vp of viewports) {
    const f = parsed.floors[vp.label];
    if (
      !f ||
      f.width !== vp.width ||
      f.height !== vp.height ||
      typeof f.minSections !== 'number' ||
      !Number.isInteger(f.minSections) ||
      f.minSections < 1 ||
      typeof f.minCards !== 'number' ||
      !Number.isInteger(f.minCards) ||
      f.minCards < 0
    ) {
      throw new Error(
        `Cannot safely determine per-viewport readiness floors: ${floorsFile} has invalid floor for viewport ${vp.label}: ${JSON.stringify(f)}. Rerun without --skip-capture.`
      );
    }
  }
  return parsed.floors;
}

/**
 * Validates probed sectionCount and productCardCount from a reference tab at a viewport.
 * Fails closed if values are missing, non-finite, or violate structural floors.
 */
export function validateProbedFloor(probe, vp) {
  if (!probe || typeof probe !== 'object') {
    throw new Error(`Reference probe returned non-object for ${vp.label} (${vp.width}x${vp.height}): ${JSON.stringify(probe)}`);
  }
  if (typeof probe.sectionCount !== 'number' || !Number.isInteger(probe.sectionCount) || probe.sectionCount < 1) {
    throw new Error(`Reference probe returned invalid sectionCount for ${vp.label} (${vp.width}x${vp.height}): ${probe.sectionCount}`);
  }
  if (typeof probe.productCardCount !== 'number' || !Number.isInteger(probe.productCardCount) || probe.productCardCount < 0) {
    throw new Error(`Reference probe returned invalid productCardCount for ${vp.label} (${vp.width}x${vp.height}): ${probe.productCardCount}`);
  }
  return {
    width: vp.width,
    height: vp.height,
    minSections: probe.sectionCount,
    minCards: probe.productCardCount,
  };
}
