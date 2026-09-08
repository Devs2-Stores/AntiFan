import { describe, it, before, after } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { ThemeCompiler } from './theme-compiler.js';
import type { ComponentContractIR } from '../models/clone-ir.js';

describe('ThemeCompiler - Asset Pipeline Integration & Fail-Closed Localization Gate', () => {
  let tempDir: string;

  before(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-asset-integration-test-'));
  });

  after(() => {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  it('compileThemeWithLocalizationAsync executes localizePipeline, rewrites URLs and returns valid localization result', async () => {
    const compiler = new ThemeCompiler();
    const assetsDir = path.join(tempDir, 'assets_source');
    fs.mkdirSync(assetsDir, { recursive: true });

    // Create a local source asset to simulate downloaded/cached asset
    const sampleLogoPath = path.join(assetsDir, 'logo.png');
    fs.writeFileSync(sampleLogoPath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x00]));

    const mockIR: ComponentContractIR = {
      version: '1.2.0',
      metadata: {
        sourceUrl: 'https://example.com',
        extractedAt: new Date().toISOString(),
        engineVersion: '1.0.0-recon'
      },
      layout: {
        containerMaxWidth: 1200,
        containerPaddingPx: 15,
        gridGapPx: 20,
        breakpoints: { mobileMax: 767, tabletMin: 768, tabletMax: 1024, desktopMin: 1025 }
      },
      storefrontRuntime: { controllers: [] },
      themeSettings: [],
      sections: [
        {
          id: 'hero_section',
          name: 'Hero Section',
          archetype: 'custom_section',
          layoutType: 'flow',
          settings: {},
          blocks: [],
          liquidTemplate: '<div class="hero"><img src="https://example.com/logo.png"></div>'
        }
      ],
      components: [],
      assets: {
        stylesheets: [],
        javascripts: [],
        images: [
          {
            type: 'image',
            sourceUrl: 'https://example.com/logo.png',
            filename: 'logo.png',
            localPath: sampleLogoPath,
            byteCount: 6
          }
        ],
        fonts: [],
        totalBytes: 6
      }
    };

    const outDir = path.join(tempDir, 'output_theme');
    const res = await compiler.compileThemeWithLocalizationAsync(outDir, mockIR, {
      skipDownload: true // Offline mode: uses pre-cached localPath
    });

    assert.strictEqual(res.success, true);
    assert.ok(res.localization, 'Must return localization result');
    assert.strictEqual(res.localization.a3_audit.passed, true, 'Audit must pass');

    // Verify file rewrite in sections/hero_section.liquid: must reference liquid asset_url, not remote
    const sectionFile = path.join(outDir, 'sections', 'hero_section.liquid');
    assert.ok(fs.existsSync(sectionFile), 'Section file must exist');
    const content = fs.readFileSync(sectionFile, 'utf-8');
    assert.ok(content.includes("{{ 'logo.png' | asset_url }}"), 'Must rewrite to asset_url filter');
    assert.ok(!content.includes('https://example.com/logo.png'), 'Must eliminate remote URL');
  });

  it('compileThemeWithLocalizationAsync fails closed when asset audit detects missing unlocalized files', async () => {
    const compiler = new ThemeCompiler();
    const mockIR: ComponentContractIR = {
      version: '1.2.0',
      metadata: {
        sourceUrl: 'https://example.com',
        extractedAt: new Date().toISOString()
      },
      layout: {
        containerMaxWidth: 1200,
        containerPaddingPx: 15,
        gridGapPx: 20,
        breakpoints: { mobileMax: 767, tabletMin: 768, tabletMax: 1024, desktopMin: 1025 }
      },
      storefrontRuntime: { controllers: [] },
      themeSettings: [],
      sections: [
        {
          id: 'banner_section',
          name: 'Banner Section',
          archetype: 'custom_section',
          layoutType: 'flow',
          settings: {},
          blocks: [],
          liquidTemplate: '<div class="banner"><img src="https://example.com/missing.png"></div>'
        }
      ],
      components: [],
      assets: {
        stylesheets: [],
        javascripts: [],
        images: [
          {
            type: 'image',
            sourceUrl: 'https://example.com/missing.png',
            filename: 'missing.png',
            localPath: path.join(tempDir, 'non_existent_missing.png')
          }
        ],
        fonts: [],
        totalBytes: 0
      }
    };

    const outDir = path.join(tempDir, 'output_theme_fail');
    await assert.rejects(
      async () => {
        await compiler.compileThemeWithLocalizationAsync(outDir, mockIR, {
          skipDownload: true
        });
      },
      (err: Error) => {
        assert.ok(err.message.includes('ThemeCompiler Asset Audit Failed (Fail-Closed)'));
        assert.ok(err.message.includes('MISSING_LOCAL_FILE'));
        return true;
      }
    );
  });

  it('compileThemeWithLocalizationAsync preserves prior valid output when localization fails', async () => {
    const compiler = new ThemeCompiler();
    const outDir = path.join(tempDir, 'output_theme_atomic');
    fs.mkdirSync(outDir, { recursive: true });
    const canaryFile = path.join(outDir, 'canary.txt');
    fs.writeFileSync(canaryFile, 'prior-valid-state', 'utf-8');

    const failingIR: ComponentContractIR = {
      version: '1.2.0',
      metadata: {
        sourceUrl: 'https://example.com',
        extractedAt: new Date().toISOString()
      },
      layout: {
        containerMaxWidth: 1200,
        containerPaddingPx: 15,
        gridGapPx: 20,
        breakpoints: { mobileMax: 767, tabletMin: 768, tabletMax: 1024, desktopMin: 1025 }
      },
      storefrontRuntime: { controllers: [] },
      themeSettings: [],
      sections: [
        {
          id: 'test_sec',
          name: 'Test Section',
          archetype: 'custom_section',
          layoutType: 'flow',
          settings: {},
          blocks: [],
          liquidTemplate: '<div>Canary Test</div>'
        }
      ],
      components: [],
      assets: {
        stylesheets: [],
        javascripts: [],
        images: [
          {
            type: 'image',
            sourceUrl: 'https://example.com/unreachable.png',
            filename: 'unreachable.png',
            localPath: path.join(tempDir, 'non_existent_unreachable.png')
          }
        ],
        fonts: [],
        totalBytes: 0
      }
    };

    await assert.rejects(
      async () => {
        await compiler.compileThemeWithLocalizationAsync(outDir, failingIR, {
          skipDownload: true
        });
      },
      /ThemeCompiler Asset Audit Failed/
    );

    // Assert atomic guarantee: prior canary file must remain intact
    assert.ok(fs.existsSync(canaryFile), 'Canary file must remain completely intact');
    assert.strictEqual(fs.readFileSync(canaryFile, 'utf-8'), 'prior-valid-state');
  });
});
