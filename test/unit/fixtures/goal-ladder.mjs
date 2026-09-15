/**
 * Ladder fixture for the kill/resume test. Each unit sleeps `unitMs`, appends a
 * `start` line to `work.log` in the run dir, and returns PASS. The log is the
 * observable evidence: a unit that was checkpointed PASS must never start again.
 */
import fs from 'node:fs';
import path from 'node:path';

const UNITS = Number(process.env.GOAL_FIXTURE_UNITS || 6);
const UNIT_MS = Number(process.env.GOAL_FIXTURE_UNIT_MS || 400);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function makeItem(itemId) {
  return {
    itemId,
    async run({ dir }) {
      fs.appendFileSync(path.join(dir, 'work.log'), `start ${itemId}\n`);
      await sleep(UNIT_MS);
      return { verdict: 'PASS', itemId };
    },
  };
}

export const spec = {
  phases: [
    {
      phaseId: 'p1',
      items: Array.from({ length: UNITS }, (_, i) => makeItem(`u${i + 1}`)),
    },
  ],
};
