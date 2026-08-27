import * as fs from 'fs';
import * as path from 'path';

export type EcommercePlatform = 'haravan' | 'sapo' | 'shopify' | 'unknown';

export interface PlatformDetectionResult {
  platform: EcommercePlatform;
  confidence: number;
  indicators: string[];
  source: 'workspace' | 'runtime' | 'hybrid';
}

export class PlatformDetector {
  /**
   * Detect platform by inspecting workspace root files and directories
   */
  public static detectFromWorkspace(workspaceRoot: string): PlatformDetectionResult {
    const indicators: string[] = [];
    let haravanScore = 0;
    let sapoScore = 0;
    let shopifyScore = 0;

    try {
      if (!fs.existsSync(workspaceRoot)) {
        return { platform: 'unknown', confidence: 0, indicators: ['workspace_not_found'], source: 'workspace' };
      }

      // Check Sapo / Bizweb specific files (.bwt templates)
      const snippetsDir = path.join(workspaceRoot, 'snippets');
      const templatesDir = path.join(workspaceRoot, 'templates');
      const sectionsDir = path.join(workspaceRoot, 'sections');
      const configDir = path.join(workspaceRoot, 'config');

      if (fs.existsSync(snippetsDir)) {
        const snippetFiles = fs.readdirSync(snippetsDir);
        if (snippetFiles.some((f) => f.endsWith('.bwt'))) {
          sapoScore += 50;
          indicators.push('snippets/*.bwt templates found (Sapo)');
        }
      }

      if (fs.existsSync(templatesDir)) {
        const templateFiles = fs.readdirSync(templatesDir);
        if (templateFiles.some((f) => f.endsWith('.bwt'))) {
          sapoScore += 50;
          indicators.push('templates/*.bwt templates found (Sapo)');
        }
      }

      // Check settings.html (Haravan classic legacy)
      const settingsHtml = path.join(configDir, 'settings.html');
      if (fs.existsSync(settingsHtml)) {
        haravanScore += 60;
        indicators.push('config/settings.html found (Haravan)');
      }

      // Check settings_schema.json contents
      const settingsSchema = path.join(configDir, 'settings_schema.json');
      if (fs.existsSync(settingsSchema)) {
        try {
          const raw = fs.readFileSync(settingsSchema, 'utf-8');
          if (raw.includes('hstatic.net') || raw.includes('haravan')) {
            haravanScore += 40;
            indicators.push('config/settings_schema.json contains Haravan markers');
          } else if (raw.includes('bizweb') || raw.includes('sapo.vn') || raw.includes('dktcdn.net')) {
            sapoScore += 40;
            indicators.push('config/settings_schema.json contains Sapo/Bizweb markers');
          } else if (raw.includes('shopify') || raw.includes('cdn.shopify.com')) {
            shopifyScore += 40;
            indicators.push('config/settings_schema.json contains Shopify markers');
          }
        } catch {
          // Ignore parse errors
        }
      }

      // Check sections/*.liquid vs sections/*.bwt
      if (fs.existsSync(sectionsDir)) {
        const sectionFiles = fs.readdirSync(sectionsDir);
        if (sectionFiles.some((f) => f.endsWith('.bwt'))) {
          sapoScore += 40;
          indicators.push('sections/*.bwt templates found (Sapo)');
        } else if (sectionFiles.some((f) => f.endsWith('.liquid'))) {
          // Both Shopify and Haravan use .liquid sections
          shopifyScore += 10;
          haravanScore += 10;
          indicators.push('sections/*.liquid templates found');
        }
      }

      // Check package.json for CLI configs
      const packageJsonPath = path.join(workspaceRoot, 'package.json');
      if (fs.existsSync(packageJsonPath)) {
        try {
          const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));
          const scriptsStr = JSON.stringify(pkg.scripts || {});
          if (scriptsStr.includes('haravan') || scriptsStr.includes('hrv')) {
            haravanScore += 40;
            indicators.push('package.json scripts contain Haravan CLI commands');
          } else if (scriptsStr.includes('sapo') || scriptsStr.includes('bizweb')) {
            sapoScore += 40;
            indicators.push('package.json scripts contain Sapo CLI commands');
          } else if (scriptsStr.includes('shopify theme')) {
            shopifyScore += 40;
            indicators.push('package.json scripts contain Shopify CLI commands');
          }
        } catch {
          // Ignore
        }
      }
    } catch (err) {
      indicators.push(`scan_error: ${String(err)}`);
    }

    if (sapoScore > haravanScore && sapoScore > shopifyScore) {
      return { platform: 'sapo', confidence: Math.min(sapoScore / 100, 1.0), indicators, source: 'workspace' };
    }
    if (haravanScore > sapoScore && haravanScore > shopifyScore) {
      return { platform: 'haravan', confidence: Math.min(haravanScore / 100, 1.0), indicators, source: 'workspace' };
    }
    if (shopifyScore > sapoScore && shopifyScore > haravanScore) {
      return { platform: 'shopify', confidence: Math.min(shopifyScore / 100, 1.0), indicators, source: 'workspace' };
    }

    return { platform: 'unknown', confidence: 0, indicators, source: 'workspace' };
  }

  /**
   * Detect platform from live storefront runtime URL, DOM HTML, and CDN links
   */
  public static detectFromRuntime(url: string, domHtml?: string): PlatformDetectionResult {
    const indicators: string[] = [];
    let haravanScore = 0;
    let sapoScore = 0;
    let shopifyScore = 0;

    const lowerUrl = (url || '').toLowerCase();
    const lowerDom = (domHtml || '').toLowerCase();

    // URL Indicators
    if (lowerUrl.includes('haravan.com') || lowerUrl.includes('myharavan.com') || lowerUrl.includes('hstatic.net')) {
      haravanScore += 60;
      indicators.push(`URL matches Haravan domain pattern: ${url}`);
    } else if (lowerUrl.includes('mysapo.net') || lowerUrl.includes('sapo.vn') || lowerUrl.includes('bizwebvietnam.net') || lowerUrl.includes('dktcdn.net')) {
      sapoScore += 60;
      indicators.push(`URL matches Sapo/Bizweb domain pattern: ${url}`);
    } else if (lowerUrl.includes('myshopify.com') || lowerUrl.includes('shopify.com')) {
      shopifyScore += 60;
      indicators.push(`URL matches Shopify domain pattern: ${url}`);
    }

    // DOM & CDN Indicators
    if (lowerDom) {
      if (lowerDom.includes('hstatic.net') || lowerDom.includes('haravan.theme') || lowerDom.includes('window.haravan')) {
        haravanScore += 50;
        indicators.push('DOM contains hstatic.net CDN or Haravan JS objects');
      }
      if (lowerDom.includes('bizweb.dktcdn.net') || lowerDom.includes('bizweb.theme') || lowerDom.includes('window.bizweb') || lowerDom.includes('window.sapo')) {
        sapoScore += 50;
        indicators.push('DOM contains bizweb.dktcdn.net CDN or Sapo/Bizweb JS objects');
      }
      if (lowerDom.includes('cdn.shopify.com') || lowerDom.includes('shopify.theme') || lowerDom.includes('window.shopify') || lowerDom.includes('shopify-features')) {
        shopifyScore += 50;
        indicators.push('DOM contains cdn.shopify.com CDN or Shopify JS objects');
      }
    }

    if (sapoScore > haravanScore && sapoScore > shopifyScore) {
      return { platform: 'sapo', confidence: Math.min(sapoScore / 100, 1.0), indicators, source: 'runtime' };
    }
    if (haravanScore > sapoScore && haravanScore > shopifyScore) {
      return { platform: 'haravan', confidence: Math.min(haravanScore / 100, 1.0), indicators, source: 'runtime' };
    }
    if (shopifyScore > sapoScore && shopifyScore > haravanScore) {
      return { platform: 'shopify', confidence: Math.min(shopifyScore / 100, 1.0), indicators, source: 'runtime' };
    }

    return { platform: 'unknown', confidence: 0, indicators, source: 'runtime' };
  }

  /**
   * Unified detection combining workspace and runtime evidence
   */
  public static detect(workspaceRoot?: string, runtimeUrl?: string, domHtml?: string): PlatformDetectionResult {
    const wsResult = workspaceRoot ? this.detectFromWorkspace(workspaceRoot) : undefined;
    const rtResult = (runtimeUrl || domHtml) ? this.detectFromRuntime(runtimeUrl || '', domHtml) : undefined;
    if (wsResult && wsResult.platform !== 'unknown' && (!rtResult || rtResult.platform === 'unknown')) {
      return wsResult;
    }
    if (rtResult && rtResult.platform !== 'unknown' && (!wsResult || wsResult.platform === 'unknown')) {
      return rtResult;
    }
    if (wsResult && rtResult) {
      if (wsResult.platform === rtResult.platform) {
        return {
          platform: wsResult.platform,
          confidence: Math.max(wsResult.confidence, rtResult.confidence),
          indicators: [...wsResult.indicators, ...rtResult.indicators],
          source: 'hybrid',
        };
      }
      // In case of conflict, runtime takes precedence for live store inspection
      return rtResult.confidence >= wsResult.confidence ? rtResult : wsResult;
    }

    return { platform: 'unknown', confidence: 0, indicators: ['no_clear_indicators'], source: 'hybrid' };
  }
}
