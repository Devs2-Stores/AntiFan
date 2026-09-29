import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { buildAnnotationTargetMenu } from '../../src/main/browser/element-picker';

const groupedSessions = [
  { id: 's-a1', name: 'Terminal 1', cwd: 'E:\\Work\\mn-bakery', folderKey: 'e:\\work\\mn-bakery', folderLabel: 'mn-bakery', displayLabel: 'mn-bakery · 1' },
  { id: 's-b1', name: 'Terminal 2', cwd: 'E:\\Work\\f1genz', folderKey: 'e:\\work\\f1genz', folderLabel: 'f1genz', displayLabel: 'f1genz · 1' },
  { id: 's-a2', name: 'Terminal 3', cwd: 'E:\\Work\\mn-bakery', folderKey: 'e:\\work\\mn-bakery', folderLabel: 'mn-bakery', displayLabel: 'mn-bakery · 2' },
];

describe('buildAnnotationTargetMenu', () => {
  it('puts the auto resolver option first and groups sessions by folderKey', () => {
    const menu = buildAnnotationTargetMenu(groupedSessions, undefined);
    assert.deepEqual(
      menu.options.map((o) => o.value),
      ['auto'],
    );
    assert.equal(menu.options[0]!.label, 'Tự động (theo site URL)');
    assert.equal(menu.groups.length, 2);
    assert.deepEqual(
      menu.groups.map((g) => g.label),
      ['mn-bakery', 'f1genz'],
      'optgroups appear in folder first-appearance order with folderLabel as the label',
    );
    assert.deepEqual(
      menu.groups[0]!.options.map((o) => o.label),
      ['mn-bakery · 1', 'mn-bakery · 2'],
      'options use the displayLabel the hub assigns',
    );
    assert.deepEqual(
      menu.groups[1]!.options.map((o) => o.value),
      ['s-b1'],
    );
  });

  it('resolves the tab annotationSessionId as the selected option', () => {
    const menu = buildAnnotationTargetMenu(groupedSessions, 's-b1');
    assert.equal(menu.selectedValue, 's-b1');
    assert.equal(menu.groups[1]!.options[0]!.selected, true);
    assert.ok(
      !menu.options.some((o) => o.selected) && menu.groups[0]!.options.every((o) => !o.selected),
      'exactly one option is selected',
    );
  });

  it('falls back to a single ungrouped name list when no session carries a folder projection', () => {
    const menu = buildAnnotationTargetMenu(
      [
        { id: 's-1', name: 'Terminal 1', cwd: 'E:\\Work\\a' },
        { id: 's-2', name: 'Terminal 2', cwd: 'E:\\Work\\b' },
      ],
      undefined,
    );
    assert.equal(menu.groups.length, 0, 'no optgroups when folder fields are absent');
    assert.deepEqual(
      menu.options.map((o) => o.value),
      ['auto', 's-1', 's-2'],
      'single ungrouped list after auto',
    );
    assert.deepEqual(
      menu.options.slice(1).map((o) => o.label),
      ['Terminal 1', 'Terminal 2'],
      'labels fall back to the persisted name',
    );
    assert.equal(menu.selectedValue, 'auto');
  });

  it('treats a stale or cross-tab choice as auto', () => {
    for (const requestedId of ['deleted-session', '', undefined, 42, null]) {
      const menu = buildAnnotationTargetMenu(groupedSessions, requestedId);
      assert.equal(menu.selectedValue, 'auto');
      assert.equal(menu.options[0]!.selected, true);
    }
    // 'auto' is itself a valid persisted choice and must round-trip.
    assert.equal(buildAnnotationTargetMenu(groupedSessions, 'auto').selectedValue, 'auto');
  });

  it('keeps folder-less sessions flat while grouped ones form optgroups', () => {
    const menu = buildAnnotationTargetMenu(
      [
        { id: 's-lone', name: 'Loose', cwd: 'E:\\tmp' },
        groupedSessions[0],
        groupedSessions[1],
      ],
      's-lone',
    );
    assert.equal(menu.groups.length, 2);
    assert.deepEqual(
      menu.options.map((o) => o.value),
      ['auto', 's-lone'],
    );
    assert.equal(menu.selectedValue, 's-lone');
    assert.equal(menu.options[1]!.selected, true);
  });
});
