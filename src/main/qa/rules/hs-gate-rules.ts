import { EcommercePlatform } from '../scanners/platform-detector';

export type HsRuleSeverity = 'error' | 'warning' | 'info';

export interface HsRuleViolation {
  ruleId: string;
  ruleTitle: string;
  severity: HsRuleSeverity;
  platform: EcommercePlatform;
  message: string;
  selector?: string;
  snippet?: string;
  recommendation: string;
}

export interface HsEvaluationResult {
  passed: boolean;
  totalViolations: number;
  errorsCount: number;
  warningsCount: number;
  violations: HsRuleViolation[];
}

export class HsGateRules {
  /**
   * Browser injection script to evaluate HS rules on active storefront DOM
   * Wrapped in self-executing IIFE for isolated evaluation (RT-01 mitigation)
   */
  public static getBrowserEvaluationScript(platform: EcommercePlatform): string {
    return `(() => {
      const platform = '${platform}';
      const violations = [];

      // 1. HS-01: AJAX Cart Form Field Name (Sapo vs Haravan/Shopify)
      const cartForms = Array.from(document.querySelectorAll('form[action*="/cart/add"], form[action="/cart/add"]'));
      for (const form of cartForms) {
        const idInput = form.querySelector('input[name="id"], select[name="id"]');
        const variantIdInput = form.querySelector('input[name="variantId"], select[name="variantId"]');

        if (platform === 'sapo') {
          if (idInput && !variantIdInput) {
            violations.push({
              ruleId: 'HS-01',
              ruleTitle: 'Sapo Cart Variant ID Contract',
              severity: 'error',
              platform: 'sapo',
              message: 'Sapo add-to-cart form uses name="id" instead of name="variantId"',
              selector: 'form[action*="/cart/add"] input[name="id"]',
              recommendation: 'Change input/select name="id" to name="variantId" for Sapo platform themes'
            });
          }
        } else if (platform === 'haravan' || platform === 'shopify') {
          if (variantIdInput && !idInput) {
            violations.push({
              ruleId: 'HS-01',
              ruleTitle: 'Haravan/Shopify Cart Variant ID Contract',
              severity: 'error',
              platform,
              message: platform.toUpperCase() + ' add-to-cart form uses name="variantId" instead of name="id"',
              selector: 'form[action*="/cart/add"] input[name="variantId"]',
              recommendation: 'Change input/select name="variantId" to name="id" for ' + platform + ' themes'
            });
          }
        }
      }

      // 2. HS-02: Contact Form Action (/postcontact vs /contact)
      const contactForms = Array.from(document.querySelectorAll('form[action*="contact"]'));
      for (const form of contactForms) {
        const action = (form.getAttribute('action') || '').toLowerCase();
        if (platform === 'sapo') {
          if (action.includes('/contact') && !action.includes('/postcontact')) {
            violations.push({
              ruleId: 'HS-02',
              ruleTitle: 'Sapo Contact Form Endpoint',
              severity: 'error',
              platform: 'sapo',
              message: 'Contact form posts to /contact instead of Sapo /postcontact',
              selector: 'form[action*="contact"]',
              recommendation: 'Change form action to /postcontact for Sapo themes'
            });
          }
        } else if (platform === 'haravan' || platform === 'shopify') {
          if (action.includes('/postcontact')) {
            violations.push({
              ruleId: 'HS-02',
              ruleTitle: 'Haravan/Shopify Contact Form Endpoint',
              severity: 'error',
              platform,
              message: 'Contact form posts to /postcontact instead of ' + platform + ' /contact',
              selector: 'form[action*="postcontact"]',
              recommendation: 'Change form action to /contact for ' + platform + ' themes'
            });
          }
        }
      }

      // 3. HS-03: Blog Comment Fields Casing (Author/Email/Body vs author/email/body)
      if (platform === 'sapo') {
        const commentForms = Array.from(document.querySelectorAll('form[action*="/comments"], form[action*="/comment"]'));
        for (const form of commentForms) {
          const lowerAuthor = form.querySelector('input[name="author"], input[name="comment[author]"]');
          const lowerEmail = form.querySelector('input[name="email"], input[name="comment[email]"]');
          const lowerBody = form.querySelector('textarea[name="body"], textarea[name="comment[body]"]');

          if (lowerAuthor || lowerEmail || lowerBody) {
            violations.push({
              ruleId: 'HS-03',
              ruleTitle: 'Sapo Comment Field Casing',
              severity: 'warning',
              platform: 'sapo',
              message: 'Sapo blog comment form uses lowercase field names instead of Author, Email, Body',
              selector: 'form[action*="comment"]',
              recommendation: 'Use capitalized Author, Email, Body input names for Sapo blog comment forms'
            });
          }
        }
      }

      // 4. HS-06: noPS / StartOptimize attribute compliance
      const scripts = Array.from(document.querySelectorAll('script[data-nops], script[src*="pagespeed"], script[data-pagespeed]'));
      // Recorded as telemetry info
      if (scripts.length > 0) {
        violations.push({
          ruleId: 'HS-06',
          ruleTitle: 'PageSpeed Optimization Scripts Detected',
          severity: 'info',
          platform,
          message: 'Found ' + scripts.length + ' scripts configured with PageSpeed/noPS attributes',
          recommendation: 'Verify noPS scripts do not block core storefront interactions'
        });
      }

      const errorsCount = violations.filter(v => v.severity === 'error').length;
      const warningsCount = violations.filter(v => v.severity === 'warning').length;

      return {
        passed: errorsCount === 0,
        totalViolations: violations.length,
        errorsCount,
        warningsCount,
        violations
      };
    })()`;
  }

  /**
   * Static rule evaluation on raw HTML string
   */
  public static evaluateHtml(html: string, platform: EcommercePlatform): HsEvaluationResult {
    const violations: HsRuleViolation[] = [];
    if (!html || platform === 'unknown') {
      return { passed: true, totalViolations: 0, errorsCount: 0, warningsCount: 0, violations: [] };
    }

    // HS-01: Cart Form Check
    if (platform === 'sapo') {
      if (html.includes('action="/cart/add"') && html.includes('name="id"') && !html.includes('name="variantId"')) {
        violations.push({
          ruleId: 'HS-01',
          ruleTitle: 'Sapo Cart Variant ID Contract',
          severity: 'error',
          platform: 'sapo',
          message: 'Sapo add-to-cart form uses name="id" instead of name="variantId"',
          recommendation: 'Change input/select name="id" to name="variantId" for Sapo platform themes',
        });
      }
    } else if (platform === 'haravan' || platform === 'shopify') {
      if (html.includes('action="/cart/add"') && html.includes('name="variantId"') && !html.includes('name="id"')) {
        violations.push({
          ruleId: 'HS-01',
          ruleTitle: 'Haravan/Shopify Cart Variant ID Contract',
          severity: 'error',
          platform,
          message: `${platform.toUpperCase()} add-to-cart form uses name="variantId" instead of name="id"`,
          recommendation: `Change input/select name="variantId" to name="id" for ${platform} themes`,
        });
      }
    }

    // HS-02: Contact Form Check
    if (platform === 'sapo') {
      if (html.includes('action="/contact"') && !html.includes('action="/postcontact"')) {
        violations.push({
          ruleId: 'HS-02',
          ruleTitle: 'Sapo Contact Form Endpoint',
          severity: 'error',
          platform: 'sapo',
          message: 'Contact form posts to /contact instead of Sapo /postcontact',
          recommendation: 'Change form action to /postcontact for Sapo themes',
        });
      }
    } else if (platform === 'haravan' || platform === 'shopify') {
      if (html.includes('action="/postcontact"')) {
        violations.push({
          ruleId: 'HS-02',
          ruleTitle: 'Haravan/Shopify Contact Form Endpoint',
          severity: 'error',
          platform,
          message: `Contact form posts to /postcontact instead of ${platform} /contact`,
          recommendation: `Change form action to /contact for ${platform} themes`,
        });
      }
    }

    const errorsCount = violations.filter((v) => v.severity === 'error').length;
    const warningsCount = violations.filter((v) => v.severity === 'warning').length;

    return {
      passed: errorsCount === 0,
      totalViolations: violations.length,
      errorsCount,
      warningsCount,
      violations,
    };
  }
}
