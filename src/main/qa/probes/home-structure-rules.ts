import type { ProbeFinding } from './probe-deps';

export type SectionRole =
  | 'hero'
  | 'category-rail'
  | 'product-rail'
  | 'banner'
  | 'usp'
  | 'testimonial'
  | 'blog'
  | 'newsletter'
  | 'brands'
  | 'footer'
  | 'other';

export interface HomeStructureRules {
  /** Section count excludes the footer. */
  minSections: number;
  maxSections: number;
  heroFirst: boolean;
  maxConsecutiveBanners: number;
  /** Applies to every role except banner (banner runs are governed by maxConsecutiveBanners) and other. */
  noConsecutiveSameRole: boolean;
  firstProductRailWithinViewports: number;
  footerLast: boolean;
  /** Document height at the measured viewport, in viewport heights. Only meaningful when probed at a phone width. */
  maxPageHeightViewports: number;
  /** Roles that must not appear before the first product rail. */
  lateRoles: SectionRole[];
}

export const HOME_STRUCTURE_RULES: HomeStructureRules = {
  minSections: 6,
  maxSections: 10,
  heroFirst: true,
  maxConsecutiveBanners: 2,
  noConsecutiveSameRole: true,
  firstProductRailWithinViewports: 2,
  footerLast: true,
  maxPageHeightViewports: 12,
  lateRoles: ['newsletter', 'brands'],
};

/** Raw signals collected by the page-side script; classification happens here so it is unit-testable. */
export interface RawHomeSection {
  tag: string;
  id: string;
  cls: string;
  type: string;
  heading: string;
  productLinks: number;
  collectionLinks: number;
  blogLinks: number;
  hasEmailInput: boolean;
  imgCount: number;
  top: number;
  height: number;
  selector: string;
}

export interface ClassifiedHomeSection extends RawHomeSection {
  role: SectionRole;
}

export function foldDiacritics(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/gi, 'd')
    .toLowerCase();
}

const HERO = /(^| )(hero|slideshow|masthead|main banner|banner main|home banner)( |$)/;
const HERO_SLIDER = /(^| )(slider|carousel)( |$)/;

export function classifyHomeSection(raw: RawHomeSection): SectionRole {
  const identity = foldDiacritics(`${raw.type} ${raw.id} ${raw.cls}`).replace(/[-_]+/g, ' ');
  const blob = `${identity} ${foldDiacritics(raw.heading)}`;

  if (raw.tag.toLowerCase() === 'footer' || /footer/.test(identity)) return 'footer';
  if (raw.hasEmailInput || /newsletter|subscribe|dang ky|nhan tin/.test(blob)) return 'newsletter';
  if (HERO.test(identity) || (HERO_SLIDER.test(identity) && raw.productLinks < 3)) return 'hero';
  if (/brand|thuong hieu|doi tac|partner|logo/.test(blob)) return 'brands';
  if (/testimonial|review|feedback|danh gia|cam nhan|khach hang noi/.test(blob)) return 'testimonial';
  if (raw.blogLinks >= 2 || /blog|article|tin tuc|bai viet|journal|(^| )news( |$)/.test(blob)) return 'blog';
  if (/(^| )usp( |$)|polic|chinh sach|cam ket|why choose|vi sao|benefit|service|dich vu|icon ?(box|list)|trust|marquee/.test(blob)) return 'usp';
  if (/categor|danh muc|collection list|shop by|list collections/.test(blob) || (raw.collectionLinks >= 3 && raw.productLinks < 3)) {
    return 'category-rail';
  }
  if (raw.productLinks >= 3 || /product|featured|best ?sell|ban chay|new ?arrival|hang moi|san pham|flash ?sale|deal/.test(blob)) return 'product-rail';
  if (/banner|promo|spotlight|image ?with ?text|khuyen mai|lookbook|(^| )cta( |$)|split/.test(blob)) return 'banner';
  if (raw.imgCount >= 1 && raw.productLinks === 0 && raw.collectionLinks < 3) return 'banner';
  return 'other';
}

export function evaluateHomeStructure(
  sections: ClassifiedHomeSection[],
  ctx: { viewportHeight: number; pageHeight: number },
  rules: HomeStructureRules
): ProbeFinding[] {
  const findings: ProbeFinding[] = [];
  const body = sections.filter((s) => s.role !== 'footer');

  if (body.length < rules.minSections || body.length > rules.maxSections) {
    findings.push({
      ruleId: 'home-section-count',
      severity: 'critical',
      message: `Home has ${body.length} sections (footer excluded); the budget is ${rules.minSections}-${rules.maxSections}.`,
      measured: { count: body.length, min: rules.minSections, max: rules.maxSections },
    });
  }

  if (rules.heroFirst) {
    const first = sections[0];
    if (!first || first.role !== 'hero') {
      const heroAt = sections.findIndex((s) => s.role === 'hero');
      findings.push({
        ruleId: 'home-hero-first',
        severity: 'critical',
        selector: first?.selector,
        message:
          heroAt < 0
            ? 'No hero section found; the first section is ' + (first ? first.role : 'missing') + '.'
            : `The hero is section ${heroAt + 1}; it must be first (found ${first ? first.role : 'nothing'} first).`,
        measured: { firstRole: first?.role ?? null, heroIndex: heroAt },
      });
    }
  }

  const firstRail = sections.findIndex((s) => s.role === 'product-rail');
  for (const role of rules.lateRoles) {
    const at = sections.findIndex((s) => s.role === role);
    if (at >= 0 && (firstRail < 0 || at < firstRail)) {
      findings.push({
        ruleId: 'home-late-role',
        severity: 'critical',
        selector: sections[at]?.selector,
        message: `${role} section appears before the first product rail (position ${at + 1}).`,
        measured: { role, index: at, firstProductRailIndex: firstRail },
      });
    }
  }

  let run = 0;
  let runStart = 0;
  for (let i = 0; i <= sections.length; i += 1) {
    if (i < sections.length && sections[i]?.role === 'banner') {
      if (run === 0) runStart = i;
      run += 1;
      continue;
    }
    if (run > rules.maxConsecutiveBanners) {
      findings.push({
        ruleId: 'home-banner-run',
        severity: 'warning',
        selector: sections[runStart]?.selector,
        message: `${run} banners in a row starting at section ${runStart + 1}; at most ${rules.maxConsecutiveBanners} allowed.`,
        measured: { run, start: runStart },
      });
    }
    run = 0;
  }

  if (rules.noConsecutiveSameRole) {
    for (const role of consecutiveDuplicateRoles(sections.map((s) => s.role))) {
      const at = sections.findIndex((s, i) => s.role === role && sections[i + 1]?.role === role);
      findings.push({
        ruleId: 'home-consecutive-role',
        severity: 'warning',
        selector: sections[at]?.selector,
        message: `Two ${role} sections in a row (from position ${at + 1}); interleave a different section type.`,
        measured: { role, index: at },
      });
    }
  }

  if (firstRail < 0) {
    findings.push({
      ruleId: 'home-first-product-rail',
      severity: 'warning',
      message: 'No product rail found on the home page.',
    });
  } else {
    const top = sections[firstRail]?.top ?? 0;
    const limit = rules.firstProductRailWithinViewports * ctx.viewportHeight;
    if (ctx.viewportHeight > 0 && top > limit) {
      findings.push({
        ruleId: 'home-first-product-rail',
        severity: 'warning',
        selector: sections[firstRail]?.selector,
        message: `First product rail starts at ${Math.round(top)}px, beyond ${rules.firstProductRailWithinViewports} viewports (${Math.round(limit)}px).`,
        measured: { top, limit },
      });
    }
  }

  if (rules.footerLast) {
    const last = sections[sections.length - 1];
    const footerAt = sections.findIndex((s) => s.role === 'footer');
    if (footerAt < 0 || last?.role !== 'footer') {
      findings.push({
        ruleId: 'home-footer-last',
        severity: 'critical',
        message: footerAt < 0 ? 'No footer section found.' : `The footer is section ${footerAt + 1} of ${sections.length}; it must be last.`,
        measured: { footerIndex: footerAt, count: sections.length },
      });
    }
  }

  if (ctx.viewportHeight > 0) {
    const ratio = ctx.pageHeight / ctx.viewportHeight;
    if (ratio > rules.maxPageHeightViewports) {
      findings.push({
        ruleId: 'home-page-height',
        severity: 'warning',
        message: `Page is ${ratio.toFixed(1)} viewports tall; keep it within ${rules.maxPageHeightViewports} at this width.`,
        measured: { pageHeight: ctx.pageHeight, viewportHeight: ctx.viewportHeight, ratio },
      });
    }
  }

  return findings;
}

/** Roles (banner and other excluded) that appear in two adjacent sections. */
export function consecutiveDuplicateRoles(order: SectionRole[]): string[] {
  const out: string[] = [];
  for (let i = 1; i < order.length; i += 1) {
    const role = order[i];
    if (role && role === order[i - 1] && role !== 'banner' && role !== 'other' && !out.includes(role)) out.push(role);
  }
  return out;
}
