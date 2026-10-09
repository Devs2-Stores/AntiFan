/**
 * Same-name project sections in the shared Terminal Manager must read apart.
 *
 * Drives the shipped `disambiguateProjectGroupLabels` from `src/renderer/standalone.js`
 * through the vm harness. The headers render upper-case, so a suffix that repeats the
 * label ("S2 SPA · S2 SPA") or two equal suffixes leave the user unable to pick a section.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { loadStandalone } from './standalone-harness';

type Group = { kind: string; label: string; folderPath?: string; projectId?: string; displayLabel?: string };

function headers(groups: Group[]): string[] {
  const harness = loadStandalone({});
  harness.read<(groups: Group[]) => void>('disambiguateProjectGroupLabels')(groups);
  return groups.map((g) => g.displayLabel || g.label);
}

const project = (label: string, folderPath: string, projectId: string): Group => ({ kind: 'project', label, folderPath, projectId });

describe('project section label disambiguation', () => {
  it('names each same-name storefront by the folder segment that tells it apart, at any depth', () => {
    assert.deepStrictEqual(
      headers([
        project('S2 Spa', 'E:\\Work\\themes\\devs2\\S2 Spa', 'capsule-b039'),
        project('S2 Spa', 'E:\\Work\\themes\\devs2\\Haravan\\S2 Spa', 'capsule-36c4'),
        project('S2 Spa', 'E:\\Work\\themes\\devs2\\Sapo\\S2 Spa', 'capsule-e0e0'),
        project('Lux Wine', 'E:\\Work\\themes\\devs2\\Lux Wine', 'capsule-1111'),
        project('Lux Wine', 'E:\\Work\\themes\\devs2\\Haravan\\Lux Wine', 'capsule-2222'),
        project('Mnbakery', 'E:\\Work\\themes\\Mnbakery', 'capsule-3333'),
      ]),
      ['S2 Spa · devs2', 'S2 Spa · Haravan', 'S2 Spa · Sapo', 'Lux Wine · devs2', 'Lux Wine · Haravan', 'Mnbakery'],
    );
  });

  it('climbs past a shared parent name instead of repeating it', () => {
    assert.deepStrictEqual(
      headers([
        project('S2 Spa', 'C:\\A\\Haravan\\S2 Spa', 'p-aaaa'),
        project('S2 Spa', 'D:\\B\\Haravan\\S2 Spa', 'p-bbbb'),
      ]),
      ['S2 Spa · A', 'S2 Spa · B'],
    );
  });

  it('keeps the folder name itself when it is not the label', () => {
    assert.deepStrictEqual(
      headers([
        project('S2 Spa', 'E:\\w\\s2-old', 'p-aaaa'),
        project('S2 Spa', 'E:\\w\\s2-new', 'p-bbbb'),
      ]),
      ['S2 Spa · s2-old', 'S2 Spa · s2-new'],
    );
  });

  it('falls back to the id tail when the folders are one folder or unknown', () => {
    assert.deepStrictEqual(
      headers([
        project('S2 Spa', 'E:\\x\\S2 Spa', 'p-aaaa'),
        project('S2 SPA', 'e:\\X\\s2 spa\\', 'p-bbbb'),
        project('S2 Spa', '', 'p-cccc'),
      ]),
      ['S2 Spa · …aaaa', 'S2 SPA · …bbbb', 'S2 Spa · …cccc'],
    );
  });

  it('never paints a suffix that two sections share, even from different depths', () => {
    const shown = headers([
      project('Shop', 'E:\\A\\Shop', 'p-aaaa'),
      project('Shop', 'E:\\Z\\A\\B\\Shop', 'p-bbbb'),
      project('Shop', 'E:\\Y\\Shop', 'p-cccc'),
    ]);
    assert.strictEqual(new Set(shown.map((s) => s.toLowerCase())).size, shown.length, `distinct headers: ${shown.join(' | ')}`);
    for (const s of shown) assert.notStrictEqual(s.toLowerCase(), 'shop · shop');
  });
});
