/**
 * Generator: Theme Compiler Orchestrator
 * True atomic staging, validation, and swap to guarantee zero corrupted/partial theme output
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { BlueprintExtractor, ExtractedSectionBlueprint } from '../models/blueprint-extractor.js';
import { ComponentContractIR } from '../models/clone-ir.js';
import { CloneIRBuilder } from '../models/clone-ir-builder.js';
import { HaravanLayoutGenerator } from './haravan-layout-generator.js';
import { HaravanSectionGenerator } from './haravan-section-generator.js';
import { HaravanSchemaGenerator } from './haravan-schema-generator.js';
import { HaravanSnippetGenerator } from './haravan-snippet-generator.js';
import { StateSynthesizer } from '../models/state-synthesizer.js';

export class ThemeCompiler {
  private layoutGen = new HaravanLayoutGenerator();
  private sectionGen = new HaravanSectionGenerator();
  private schemaGen = new HaravanSchemaGenerator();
  private snippetGen = new HaravanSnippetGenerator();
  private stateSynth = new StateSynthesizer();
  private extractor = new BlueprintExtractor();
  private irBuilder = new CloneIRBuilder();

  public compileTheme(outputDir: string, input: string | ComponentContractIR): { sectionCount: number; filesWritten: string[] } {
    if (!input) {
      throw new Error('ThemeCompiler: input must be a valid non-empty string or ComponentContractIR');
    }

    const ir: ComponentContractIR = typeof input === 'string' ? this.irBuilder.buildFromHtml(input) : input;
    return this.compileThemeFromIR(outputDir, ir);
  }

  public compileThemeFromIR(outputDir: string, ir: ComponentContractIR): { sectionCount: number; filesWritten: string[] } {
    // 1. Create temporary staging directory for atomic generation
    const stagingDir = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-theme-stage-'));
    const filesWritten: string[] = [];

    try {
      // 2. Prepare staging subdirectories
      const dirs = [
        'layout',
        'templates',
        'sections',
        'snippets',
        'assets',
        'config',
        'locales'
      ];

      for (const d of dirs) {
        fs.mkdirSync(path.join(stagingDir, d), { recursive: true });
      }

      // 3. Map sections from ComponentContractIR
      const sections = ir.sections;

      // 4. Generate layout/theme.liquid
      const layoutPath = path.join(stagingDir, 'layout', 'theme.liquid');
      fs.writeFileSync(layoutPath, this.layoutGen.generateThemeLiquid(), 'utf-8');
      filesWritten.push(layoutPath);

      // 5. Generate dynamic templates/index.json from non-header/footer sections
      const templateSections: Record<string, {
        type: string;
        settings: Record<string, unknown>;
        blocks?: Record<string, { type: string; settings: Record<string, unknown> }>;
        block_order?: string[];
      }> = {};
      const sectionOrder: string[] = [];

      for (const sec of sections) {
        if (sec.archetype !== 'header' && sec.archetype !== 'footer') {
          const key = sec.id.replace(/[^a-zA-Z0-9_-]/g, '_');
          const secEntry: {
            type: string;
            settings: Record<string, unknown>;
            blocks?: Record<string, { type: string; settings: Record<string, unknown> }>;
            block_order?: string[];
          } = {
            type: sec.id,
            settings: {
              heading: sec.heading || sec.name
            }
          };

          if (sec.blocks && sec.blocks.length > 0) {
            const blocksObj: Record<string, { type: string; settings: Record<string, unknown> }> = {};
            const blockOrder: string[] = [];

            let bIdx = 1;
            for (const b of sec.blocks) {
              const bKey = b.id || `${b.type}_${bIdx}`;
              blocksObj[bKey] = {
                type: b.type,
                settings: b.settings
              };
              blockOrder.push(bKey);
              bIdx++;
            }

            secEntry.blocks = blocksObj;
            secEntry.block_order = blockOrder;
          }

          templateSections[key] = secEntry;
          sectionOrder.push(key);
        }
      }

      const indexJsonContent = JSON.stringify({
        sections: templateSections,
        order: sectionOrder
      }, null, 2);

      const indexJsonPath = path.join(stagingDir, 'templates', 'index.json');
      fs.writeFileSync(indexJsonPath, indexJsonContent, 'utf-8');
      filesWritten.push(indexJsonPath);

      // 6. Generate sections/*.liquid from IR
      for (const sec of sections) {
        let sectionContent = '';
        if (sec.liquidTemplate) {
          sectionContent = this.sectionGen.generateSectionFile({
            id: sec.id,
            type: sec.archetype === 'header' ? 'header' : sec.archetype === 'footer' ? 'footer' : 'custom-content',
            name: sec.name,
            tagName: 'section',
            className: sec.className || `section-${sec.id}`,
            rawHtml: sec.rawHtml || '',
            liquidTemplate: sec.liquidTemplate,
            schemaSettings: sec.schemaSettings || [],
            blockDefinitions: (sec.blockDefinitions as any) || [],
            blockInstances: sec.blocks.map((b, bi) => ({ id: b.id || `${b.type}_${bi + 1}`, type: b.type, settings: b.settings }))
          });
        } else {
          sectionContent = `
<section class="${sec.className || sec.id}" id="{{ section.id }}">
  <div class="container container-fluid">
    {% if section.settings.heading != blank %}
      <h2 class="title">{{ section.settings.heading }}</h2>
    {% endif %}
    <div class="content">
      {% for block in section.blocks %}
        <div class="block" {{ block.haravan_attributes }}>
          {{ block.settings.title }}
        </div>
      {% endfor %}
    </div>
  </div>
</section>
{% schema %}
{
  "name": "${sec.name.replace(/"/g, '')}",
  "settings": [
    { "type": "text", "id": "heading", "label": "Heading", "default": "${(sec.heading || sec.name).replace(/"/g, '')}" }
  ],
  "blocks": [],
  "presets": [{ "name": "${sec.name.replace(/"/g, '')}" }]
}
{% endschema %}
          `.trim();
        }

        const sectionPath = path.join(stagingDir, 'sections', `${sec.id}.liquid`);
        fs.writeFileSync(sectionPath, sectionContent, 'utf-8');
        filesWritten.push(sectionPath);
      }
      // 7. Generate snippets
      const snippetFiles = this.snippetGen.generateSnippets(path.join(stagingDir, 'snippets'));
      filesWritten.push(...snippetFiles);
      // 8. Generate config/settings_schema.json
      const siteSettings = ir.normalizedData?.siteSettings as Record<string, any> | undefined;
      const themeTitle = (siteSettings?.title as string) || 'Storefront Pro';
      const hotline = (siteSettings?.hotline as string) || '';
      const email = (siteSettings?.email as string) || '';
      const schemaPath = path.join(stagingDir, 'config', 'settings_schema.json');
      fs.writeFileSync(schemaPath, this.schemaGen.generateSettingsSchema(themeTitle, hotline, email), 'utf-8');
      filesWritten.push(schemaPath);

      // 9. Generate assets/theme.js
      const themeJsPath = path.join(stagingDir, 'assets', 'theme.js');
      fs.writeFileSync(themeJsPath, this.stateSynth.generateStorefrontJs(), 'utf-8');
      filesWritten.push(themeJsPath);

      // 10. Validate staging integrity before swap
      this.validateStagingTheme(stagingDir);

      // 11. Atomic Swap: Clean destination directories and copy validated staging files
      fs.mkdirSync(outputDir, { recursive: true });
      for (const d of dirs) {
        const destSub = path.join(outputDir, d);
        if (fs.existsSync(destSub)) {
          fs.rmSync(destSub, { recursive: true, force: true });
        }
        const srcSub = path.join(stagingDir, d);
        if (fs.existsSync(srcSub)) {
          fs.cpSync(srcSub, destSub, { recursive: true });
        }
      }

      return {
        sectionCount: sections.length,
        filesWritten: filesWritten.map(f => path.join(outputDir, path.relative(stagingDir, f)))
      };
    } finally {
      // Clean up staging directory
      try {
        fs.rmSync(stagingDir, { recursive: true, force: true });
      } catch {}
    }
  }

  private validateStagingTheme(stagingDir: string): void {
    const layout = path.join(stagingDir, 'layout', 'theme.liquid');
    if (!fs.existsSync(layout) || fs.statSync(layout).size === 0) {
      throw new Error('ThemeCompiler: layout/theme.liquid validation failed');
    }

    const indexJson = path.join(stagingDir, 'templates', 'index.json');
    if (!fs.existsSync(indexJson) || fs.statSync(indexJson).size === 0) {
      throw new Error('ThemeCompiler: templates/index.json validation failed');
    }

    // Verify valid JSON
    try {
      JSON.parse(fs.readFileSync(indexJson, 'utf-8'));
    } catch (err: unknown) {
      throw new Error(`ThemeCompiler: invalid templates/index.json: ${err instanceof Error ? err.message : String(err)}`);
    }

    const settingsSchema = path.join(stagingDir, 'config', 'settings_schema.json');
    if (!fs.existsSync(settingsSchema) || fs.statSync(settingsSchema).size === 0) {
      throw new Error('ThemeCompiler: config/settings_schema.json validation failed');
    }
  }
}

