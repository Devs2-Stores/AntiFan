import { describe, it } from 'node:test';
import * as assert from 'node:assert';

import { NOTE_PREFIX, deriveChecklistTicks, type ChecklistTick } from '../../src/main/qa/checklist-autotick';
import type { ProbeFinding, ProbeResult } from '../../src/main/qa/probes/probe-deps';

function probe<T>(data: T, findings: ProbeFinding[] = [], measured = true): ProbeResult<T> {
  return { measured, passed: measured ? !findings.some((f) => f.severity === 'critical') : null, findings, data };
}

function finding(ruleId: string, severity: ProbeFinding['severity'] = 'critical'): ProbeFinding {
  return { ruleId, severity, message: ruleId };
}

function byId(ticks: ChecklistTick[]): Record<string, ChecklistTick> {
  return Object.fromEntries(ticks.map((tick) => [tick.itemId, tick]));
}

const WIDTHS = ['320', '375', '768', '1024', '1440', '1920', '2560'];

function responsive(overflowing: string[], unmeasured: string[] = []): Record<string, unknown> {
  return Object.fromEntries(WIDTHS.map((w) => [w, unmeasured.includes(w) ? {} : { documentOverflow: overflowing.includes(w) }]));
}

describe('checklist autotick', () => {
  it('returns nothing when no measurement ran', () => {
    assert.deepStrictEqual(deriveChecklistTicks({}), []);
    assert.deepStrictEqual(deriveChecklistTicks({ qa: { findings: {} } }), []);
  });

  it('ticks qag-07 only when all seven widths were measured without overflow', () => {
    const ticks = byId(deriveChecklistTicks({ qa: { findings: { responsive: responsive([]) } } }));
    assert.strictEqual(ticks['qag-07']?.done, true);
    assert.ok(ticks['qag-07']?.note.startsWith(NOTE_PREFIX));

    const partial = byId(deriveChecklistTicks({ qa: { findings: { responsive: responsive([], ['2560']) } } }));
    assert.strictEqual(partial['qag-07'], undefined, 'an unmeasured width leaves the item untouched');
  });

  it('un-ticks qag-07 and names the overflowing widths', () => {
    const ticks = byId(deriveChecklistTicks({ qa: { findings: { responsive: responsive(['320', '375']) } } }));
    assert.strictEqual(ticks['qag-07']?.done, false);
    assert.match(ticks['qag-07']!.note, /320, 375px/);
  });

  it('grades qag-29 only from a measured mobile visual-quality scan that covered both registry rules', () => {
    const clean = byId(deriveChecklistTicks({
      qa: { measuredRules: ['font-below-min', 'control-height-band'], findings: { visualQuality: { measured: true, mobile: true, findings: [] } } },
    }));
    assert.strictEqual(clean['qag-29']?.done, true);

    const dirty = byId(deriveChecklistTicks({
      qa: {
        measuredRules: ['font-below-min', 'control-height-band'],
        findings: { visualQuality: { measured: true, mobile: true, findings: [{ ruleId: 'tap-target-tiny' }, { ruleId: 'contrast-low' }] } },
      },
    }));
    assert.strictEqual(dirty['qag-29']?.done, false);
    assert.match(dirty['qag-29']!.note, /^\[scan\] 1 vi phạm/);

    const desktopOnly = byId(deriveChecklistTicks({
      qa: { measuredRules: ['font-below-min', 'control-height-band'], findings: { visualQuality: { measured: true, mobile: false, findings: [] } } },
    }));
    assert.strictEqual(desktopOnly['qag-29'], undefined);

    const rulesMissing = byId(deriveChecklistTicks({
      qa: { measuredRules: ['font-below-min'], findings: { visualQuality: { measured: true, mobile: true, findings: [] } } },
    }));
    assert.strictEqual(rulesMissing['qag-29'], undefined);
  });

  it('maps page_structure roles to the home items and qag-20 to the critical findings', () => {
    const present = byId(deriveChecklistTicks({
      probes: { page_structure: probe({ count: 6, order: ['hero', 'category-rail', 'product-rail', 'banner', 'footer'], heightShare: [], duplicateRoles: [] }) },
    }));
    assert.strictEqual(present['hom-02']?.done, true);
    assert.strictEqual(present['hom-03']?.done, true);
    assert.strictEqual(present['hom-05']?.done, true);
    assert.strictEqual(present['hom-06']?.done, true);
    assert.strictEqual(present['hom-07']?.done, false, 'no blog section on the page');
    assert.strictEqual(present['hom-08']?.done, false, 'no newsletter section on the page');
    assert.strictEqual(present['qag-20']?.done, true);

    const failing = byId(deriveChecklistTicks({
      probes: { page_structure: probe({ count: 3, order: ['hero'], heightShare: [], duplicateRoles: [] }, [finding('home-section-count')]) },
    }));
    assert.strictEqual(failing['qag-20']?.done, false);
    assert.match(failing['qag-20']!.note, /home-section-count/);
  });

  it('leaves every item alone when a probe did not measure', () => {
    const ticks = deriveChecklistTicks({
      probes: {
        page_structure: probe({}, [], false),
        menu_depth: probe({}, [], false),
        variant_image_probe: probe({}, [], false),
        pdp_contract: probe({ hasSizeOption: true, missing: ['size-guide'] }, [], false),
      },
    });
    assert.deepStrictEqual(ticks, []);
  });

  it('ticks hom-01 from menu depth and hom-09 only when the mobile drawer was measured', () => {
    const desktopOnly = byId(deriveChecklistTicks({ probes: { menu_depth: probe({ maxDepth: 3, perLevelCounts: [5, 4, 2], level3Visible: true }) } }));
    assert.strictEqual(desktopOnly['hom-01']?.done, true);
    assert.strictEqual(desktopOnly['hom-09'], undefined);

    const withMobile = byId(deriveChecklistTicks({
      probes: { menu_depth: probe({ maxDepth: 2, perLevelCounts: [5, 4], level3Visible: false, mobileMaxDepth: 2 }, [finding('menu-level-not-rendered')]) },
    }));
    assert.strictEqual(withMobile['hom-01']?.done, false);
    assert.strictEqual(withMobile['hom-09']?.done, false);
    assert.match(withMobile['hom-01']!.note, /menu-level-not-rendered/);
  });

  it('un-ticks pdp-01 and qag-34 on a swatch that does not switch the image, and pdp-04 on any non-info finding', () => {
    const ticks = byId(deriveChecklistTicks({
      probes: { variant_image_probe: probe({ perValue: [], optionValuesCount: {} }, [finding('swatch-no-image-switch')]) },
    }));
    assert.strictEqual(ticks['pdp-01']?.done, false);
    assert.strictEqual(ticks['qag-34']?.done, false);
    assert.strictEqual(ticks['pdp-04']?.done, false);

    const infoOnly = byId(deriveChecklistTicks({
      probes: { variant_image_probe: probe({ perValue: [], optionValuesCount: {} }, [finding('option-values-excess', 'info')]) },
    }));
    assert.strictEqual(infoOnly['pdp-01']?.done, true);
    assert.strictEqual(infoOnly['pdp-04']?.done, true, 'an info finding does not block the selector item');
    assert.strictEqual(infoOnly['qag-34']?.done, true);
  });

  it('decides pdp-11 only for products that have a size option', () => {
    const noSize = deriveChecklistTicks({ probes: { pdp_contract: probe({ missing: [], present: [], hasSizeOption: false }) } });
    assert.deepStrictEqual(noSize, []);

    const missingGuide = byId(deriveChecklistTicks({ probes: { pdp_contract: probe({ missing: ['size-guide'], present: [], hasSizeOption: true }) } }));
    assert.strictEqual(missingGuide['pdp-11']?.done, false);

    const hasGuide = byId(deriveChecklistTicks({ probes: { pdp_contract: probe({ missing: ['sku'], present: ['size-guide'], hasSizeOption: true }) } }));
    assert.strictEqual(hasGuide['pdp-11']?.done, true);
  });

  it('ticks crt-04 from any measured cart run and crt-02 only when the controls were clicked', () => {
    const passive = byId(deriveChecklistTicks({ probes: { cart_contract: probe({ exercised: false, steps: [] }) } }));
    assert.strictEqual(passive['crt-04']?.done, true);
    assert.strictEqual(passive['crt-02'], undefined, 'a passive run does not decide the quantity controls');

    const exercised = byId(deriveChecklistTicks({ probes: { cart_contract: probe({ exercised: true, steps: [] }) } }));
    assert.strictEqual(exercised['crt-04']?.done, true);
    assert.strictEqual(exercised['crt-02']?.done, true);
  });

  it('un-ticks crt-04 on a broken checkout target and crt-02 on a control that sent no request', () => {
    const ticks = byId(deriveChecklistTicks({
      probes: { cart_contract: probe({ exercised: true, steps: [] }, [finding('checkout-target-invalid'), finding('cart-control-no-request'), finding('cart-control-no-request')]) },
    }));
    assert.strictEqual(ticks['crt-04']?.done, false);
    assert.match(ticks['crt-04']!.note, /checkout-target-invalid/);
    assert.strictEqual(ticks['crt-02']?.done, false);
    assert.match(ticks['crt-02']!.note, /2 nút/);
  });

  it('ticks nothing for a cart run that measured nothing, such as an empty cart', () => {
    assert.deepStrictEqual(deriveChecklistTicks({ probes: { cart_contract: probe({ exercised: false, steps: [] }, [finding('QA_EMPTY_CART_NOT_EXERCISED', 'info')], false) } }), []);
  });

  it('never names a manual-only item', () => {
    const ticks = deriveChecklistTicks({
      qa: { measuredRules: ['font-below-min', 'control-height-band'], findings: { responsive: responsive([]), visualQuality: { measured: true, mobile: true, findings: [] } } },
      probes: {
        page_structure: probe({ count: 8, order: ['hero', 'blog', 'newsletter'], heightShare: [], duplicateRoles: [] }),
        menu_depth: probe({ maxDepth: 3, perLevelCounts: [], level3Visible: true, mobileMaxDepth: 3 }),
        variant_image_probe: probe({ perValue: [], optionValuesCount: {} }),
        pdp_contract: probe({ missing: [], present: [], hasSizeOption: true }),
        cart_contract: probe({ exercised: true, steps: [] }),
      },
    });
    const allowed = new Set(['qag-07', 'qag-29', 'hom-01', 'hom-02', 'hom-03', 'hom-05', 'hom-06', 'hom-07', 'hom-08', 'hom-09', 'qag-20', 'pdp-01', 'pdp-04', 'qag-34', 'pdp-11', 'crt-02', 'crt-04']);
    for (const tick of ticks) assert.ok(allowed.has(tick.itemId), `${tick.itemId} is not a measured item`);
  });
});
