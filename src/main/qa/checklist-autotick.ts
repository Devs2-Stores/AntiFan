/**
 * Maps measured QA evidence onto checklist items. Only items that a measurement
 * actually decides are returned: an item whose measurement did not run is left
 * out entirely (never ticked, never un-ticked), and manual-only items are never
 * named here.
 */
import type { ProbeResult } from './probes/probe-deps';
import { DEFAULT_SWEEP_BREAKPOINTS } from '../browser/sweep-viewports';

export interface ChecklistTick {
  itemId: string;
  done: boolean;
  note: string;
}

/** Page-probe results keyed by capability suffix. */
export type ChecklistProbeResults = Partial<Record<
  'variant_image_probe' | 'pdp_contract' | 'menu_depth' | 'page_structure' | 'cart_contract',
  ProbeResult<unknown>
>>;

export const NOTE_PREFIX = '[scan]';
const RESPONSIVE_WIDTHS = DEFAULT_SWEEP_BREAKPOINTS.map((bp) => String(bp.width));

type Rec = Record<string, unknown>;

function asRec(value: unknown): Rec | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Rec) : undefined;
}

function note(text: string): string {
  return `${NOTE_PREFIX} ${text}`;
}

function ruleHits(result: ProbeResult<unknown>, ...ruleIds: string[]): number {
  return result.findings.filter((f) => ruleIds.includes(f.ruleId)).length;
}

function deriveFromQa(qa: unknown, ticks: ChecklistTick[]): void {
  const report = asRec(qa);
  const findings = asRec(report?.findings);
  if (!findings) return;

  const responsive = asRec(findings.responsive);
  if (responsive) {
    const entries = RESPONSIVE_WIDTHS.map((w) => ({ w, entry: asRec(responsive[w]) }));
    const overflowing = entries.filter(({ entry }) => entry?.documentOverflow === true).map(({ w }) => w);
    const measured = entries.filter(({ entry }) => typeof entry?.documentOverflow === 'boolean');
    if (overflowing.length > 0) {
      ticks.push({ itemId: 'qag-07', done: false, note: note(`tràn ngang ở ${overflowing.join(', ')}px`) });
    } else if (measured.length === RESPONSIVE_WIDTHS.length) {
      ticks.push({ itemId: 'qag-07', done: true, note: note(`đo đủ ${RESPONSIVE_WIDTHS.join('/')}px, không tràn ngang`) });
    }
  }

  const visual = asRec(findings.visualQuality);
  const measuredRules = Array.isArray(report?.measuredRules) ? (report.measuredRules as unknown[]) : [];
  const gradedMobile = visual?.measured === true
    && visual.mobile === true
    && measuredRules.includes('font-below-min')
    && measuredRules.includes('control-height-band');
  if (gradedMobile) {
    const visualFindings = Array.isArray(visual.findings) ? (visual.findings as unknown[]) : [];
    const hits = visualFindings.filter((entry) => {
      const ruleId = asRec(entry)?.ruleId;
      return ruleId === 'font-below-min' || ruleId === 'control-height-band' || ruleId === 'tap-target-tiny';
    }).length;
    ticks.push(hits === 0
      ? { itemId: 'qag-29', done: true, note: note('chữ và control mobile đạt ngưỡng hợp đồng') }
      : { itemId: 'qag-29', done: false, note: note(`${hits} vi phạm chữ/control mobile (font-below-min, control-height-band, tap-target)`) });
  }
}

const HOME_ROLE_ITEMS: ReadonlyArray<{ itemId: string; role: string; label: string }> = [
  { itemId: 'hom-02', role: 'hero', label: 'hero' },
  { itemId: 'hom-03', role: 'category-rail', label: 'danh mục nổi bật' },
  { itemId: 'hom-05', role: 'product-rail', label: 'dải sản phẩm' },
  { itemId: 'hom-06', role: 'banner', label: 'banner' },
  { itemId: 'hom-07', role: 'blog', label: 'tin tức' },
  { itemId: 'hom-08', role: 'newsletter', label: 'newsletter' },
];

function deriveFromPageStructure(result: ProbeResult<unknown>, ticks: ChecklistTick[]): void {
  if (!result.measured) return;
  const data = asRec(result.data);
  const order = Array.isArray(data?.order) ? (data.order as unknown[]).map(String) : [];
  for (const { itemId, role, label } of HOME_ROLE_ITEMS) {
    const present = order.includes(role);
    ticks.push({
      itemId,
      done: present,
      note: note(present ? `tìm thấy section ${label}` : `không tìm thấy section ${label} trên trang`),
    });
  }
  const critical = result.findings.filter((f) => f.severity === 'critical');
  ticks.push(critical.length === 0
    ? { itemId: 'qag-20', done: true, note: note(`bố cục trang chủ đạt: ${data?.count ?? order.length} section`) }
    : { itemId: 'qag-20', done: false, note: note(critical.map((f) => f.ruleId).join(', ')) });
}

function deriveFromMenuDepth(result: ProbeResult<unknown>, ticks: ChecklistTick[]): void {
  if (!result.measured) return;
  const data = asRec(result.data);
  const critical = result.findings.filter((f) => f.severity === 'critical');
  const detail = `độ sâu ${String(data?.maxDepth ?? '?')}, cấp 3 ${data?.level3Visible === true ? 'hiển thị' : 'không hiển thị'}`;
  ticks.push(critical.length === 0
    ? { itemId: 'hom-01', done: true, note: note(detail) }
    : { itemId: 'hom-01', done: false, note: note(`${detail}; ${critical.map((f) => f.ruleId).join(', ')}`) });
  if (typeof data?.mobileMaxDepth === 'number') {
    ticks.push(critical.length === 0
      ? { itemId: 'hom-09', done: true, note: note(`drawer mobile sâu ${data.mobileMaxDepth} cấp`) }
      : { itemId: 'hom-09', done: false, note: note(`drawer mobile sâu ${data.mobileMaxDepth} cấp; ${critical.map((f) => f.ruleId).join(', ')}`) });
  }
}

function deriveFromVariantProbe(result: ProbeResult<unknown>, ticks: ChecklistTick[]): void {
  if (!result.measured) return;
  const noSwitch = ruleHits(result, 'swatch-no-image-switch');
  const noFeatured = ruleHits(result, 'variant-missing-featured-image');
  const blocking = result.findings.filter((f) => f.severity !== 'info').length;
  ticks.push(noSwitch === 0
    ? { itemId: 'pdp-01', done: true, note: note('đổi màu swatch thì ảnh gallery đổi đúng') }
    : { itemId: 'pdp-01', done: false, note: note(`${noSwitch} màu không đổi ảnh gallery (swatch-no-image-switch)`) });
  ticks.push(blocking === 0
    ? { itemId: 'pdp-04', done: true, note: note('bộ chọn biến thể đo được, không vi phạm') }
    : { itemId: 'pdp-04', done: false, note: note(`${blocking} vi phạm bộ chọn biến thể`) });
  ticks.push(noSwitch + noFeatured === 0
    ? { itemId: 'qag-34', done: true, note: note('mọi biến thể màu có ảnh riêng và gallery nhảy đúng') }
    : { itemId: 'qag-34', done: false, note: note(`${noSwitch} không đổi ảnh, ${noFeatured} thiếu featured_image`) });
}

function deriveFromPdpContract(result: ProbeResult<unknown>, ticks: ChecklistTick[]): void {
  if (!result.measured) return;
  const data = asRec(result.data);
  if (data?.hasSizeOption !== true) return;
  const missing = Array.isArray(data.missing) ? (data.missing as unknown[]).map(String) : [];
  const missingGuide = missing.includes('size-guide');
  ticks.push({
    itemId: 'pdp-11',
    done: !missingGuide,
    note: note(missingGuide ? 'có tùy chọn kích cỡ nhưng thiếu size guide' : 'size guide có mặt'),
  });
}

/**
 * The quantity controls (crt-02) are ticked only by a run that clicked them; the checkout control
 * (crt-04) by any measured run. An empty cart is never measured, so it ticks nothing.
 */
function deriveFromCartContract(result: ProbeResult<unknown>, ticks: ChecklistTick[]): void {
  if (!result.measured) return;
  const data = asRec(result.data);
  const checkoutBad = ruleHits(result, 'cart-checkout-missing', 'checkout-target-invalid');
  ticks.push(checkoutBad === 0
    ? { itemId: 'crt-04', done: true, note: note('nút thanh toán có đích hợp lệ') }
    : { itemId: 'crt-04', done: false, note: note(`nút thanh toán hỏng (${result.findings.filter((f) => f.ruleId === 'cart-checkout-missing' || f.ruleId === 'checkout-target-invalid').map((f) => f.ruleId).join(', ')})`) });
  if (data?.exercised !== true) return;
  const dead = ruleHits(result, 'cart-control-no-request');
  ticks.push(dead === 0
    ? { itemId: 'crt-02', done: true, note: note('nút +/− gửi request giỏ hàng và đổi số lượng') }
    : { itemId: 'crt-02', done: false, note: note(`${dead} nút số lượng không gửi request (cart-control-no-request)`) });
}

export function deriveChecklistTicks(results: { qa?: unknown; probes?: Record<string, ProbeResult<unknown>> }): ChecklistTick[] {
  const ticks: ChecklistTick[] = [];
  if (results.qa !== undefined) deriveFromQa(results.qa, ticks);
  const probes = results.probes ?? {};
  if (probes.page_structure) deriveFromPageStructure(probes.page_structure, ticks);
  if (probes.menu_depth) deriveFromMenuDepth(probes.menu_depth, ticks);
  if (probes.variant_image_probe) deriveFromVariantProbe(probes.variant_image_probe, ticks);
  if (probes.pdp_contract) deriveFromPdpContract(probes.pdp_contract, ticks);
  if (probes.cart_contract) deriveFromCartContract(probes.cart_contract, ticks);
  return ticks;
}
