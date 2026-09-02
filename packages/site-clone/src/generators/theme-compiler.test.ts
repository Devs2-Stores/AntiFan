import { describe, it } from 'node:test';
import assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { ThemeCompiler } from './theme-compiler.js';

describe('ThemeCompiler - End-to-End Haravan OS 2.0 Theme Compilation', () => {
  const compiler = new ThemeCompiler();

  it('1. Compiles complete Haravan OS 2.0 directory structure with valid JSON and Liquid files', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'haravan-test-theme-'));

    const sampleHtml = `
      <!DOCTYPE html>
      <html>
        <head><title>Test Store</title></head>
        <body>
          <header class="site-header" id="main_hdr">
            <div class="logo"><img src="logo.png"></div>
          </header>
          <section id="hero_sec" class="slide">
            <div class="s-content">
              <div class="s-content__item"><img src="slide1.jpg" alt="Slide 1"></div>
              <div class="s-content__item"><img src="slide2.jpg" alt="Slide 2"></div>
            </div>
          </section>
          <section id="prod_sec" class="block-category">
            <h2>Sản Phẩm Mới</h2>
          </section>
          <footer class="site-footer" id="main_ftr">
            <p>Copyright 2026</p>
          </footer>
        </body>
      </html>
    `;

    try {
      const result = compiler.compileTheme(tempDir, sampleHtml);
      assert.strictEqual(result.sectionCount, 4);

      // Verify layout/theme.liquid
      const layoutFile = path.join(tempDir, 'layout', 'theme.liquid');
      assert.ok(fs.existsSync(layoutFile), 'theme.liquid must exist');
      const layoutContent = fs.readFileSync(layoutFile, 'utf-8');
      assert.ok(layoutContent.includes('content_for_layout'));
      assert.ok(layoutContent.includes('content_for_header'));
      // Verify templates/index.json
      const indexFile = path.join(tempDir, 'templates', 'index.json');
      assert.ok(fs.existsSync(indexFile), 'index.json must exist');
      const indexJson = JSON.parse(fs.readFileSync(indexFile, 'utf-8'));
      assert.ok(Array.isArray(indexJson.order), 'index.json must have order array');
      assert.ok(typeof indexJson.sections === 'object', 'index.json must have sections map');

      // Verify section blocks in index.json
      const heroSec = indexJson.sections['hero_sec'];
      assert.ok(heroSec, 'hero_sec must exist in index.json');
      assert.ok(heroSec.blocks, 'hero_sec must contain blocks in index.json');
      assert.ok(Array.isArray(heroSec.block_order), 'hero_sec must have block_order in index.json');
      assert.strictEqual(heroSec.block_order.length, 2);
      assert.strictEqual(heroSec.blocks['slide_1'].settings.image_url, 'slide1.jpg');
      // Verify sections and schema definitions
      const sectionFiles = fs.readdirSync(path.join(tempDir, 'sections'));
      assert.ok(sectionFiles.length >= 4, 'Must create all section files');

      for (const sFile of sectionFiles) {
        const sContent = fs.readFileSync(path.join(tempDir, 'sections', sFile), 'utf-8');
        const schemaMatch = sContent.match(/\{%\s*schema\s*%\}([\s\S]*?)\{%\s*endschema\s*%\}/);
        assert.ok(schemaMatch, `${sFile} must contain {% schema %}`);
        
        const schemaObj = JSON.parse(schemaMatch[1]);
        assert.ok(schemaObj.name, 'Schema must have name');
        assert.ok(Array.isArray(schemaObj.settings), 'Schema settings must be an array');
        assert.ok(Array.isArray(schemaObj.blocks), 'Schema blocks must be an array');

        // Verify each block definition in schema has settings as an ARRAY of definitions
        for (const blockDef of schemaObj.blocks) {
          assert.ok(blockDef.type, 'Block definition must have type');
          assert.ok(blockDef.name, 'Block definition must have name');
          assert.ok(Array.isArray(blockDef.settings), 'Block schema settings must be an array of definitions, not an object');
          for (const settingDef of blockDef.settings) {
            assert.ok(settingDef.type, 'Setting definition must have type');
            assert.ok(settingDef.id, 'Setting definition must have id');
            assert.ok(settingDef.label, 'Setting definition must have label');
          }
        }
      }

      // Verify config/settings_schema.json
      const schemaFile = path.join(tempDir, 'config', 'settings_schema.json');
      assert.ok(fs.existsSync(schemaFile), 'settings_schema.json must exist');
      const schemaJson = JSON.parse(fs.readFileSync(schemaFile, 'utf-8'));
      assert.ok(Array.isArray(schemaJson), 'settings_schema.json must be an array');
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('2. Purges stale generated files when recompiling with different sections', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'haravan-purge-test-'));

    const htmlRun1 = `
      <section id="old_section_a" class="block-category"><h2>Old A</h2></section>
      <section id="old_section_b" class="block-category"><h2>Old B</h2></section>
    `;

    const htmlRun2 = `
      <section id="new_section_x" class="slide"><h2>New X</h2></section>
    `;

    try {
      compiler.compileTheme(tempDir, htmlRun1);
      const filesRun1 = fs.readdirSync(path.join(tempDir, 'sections'));
      assert.ok(filesRun1.includes('old_section_a.liquid'));
      assert.ok(filesRun1.includes('old_section_b.liquid'));

      compiler.compileTheme(tempDir, htmlRun2);
      const filesRun2 = fs.readdirSync(path.join(tempDir, 'sections'));

      assert.ok(!filesRun2.includes('old_section_a.liquid'), 'Must purge old_section_a');
      assert.ok(!filesRun2.includes('old_section_b.liquid'), 'Must purge old_section_b');
      assert.ok(filesRun2.includes('new_section_x.liquid'), 'Must contain new_section_x');
      assert.strictEqual(filesRun2.length, 1, 'Only newly compiled sections must exist');
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('3. Preserves prior valid output when compilation fails mid-run (Atomic Rollback)', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'haravan-atomic-test-'));

    const validHtml = `
      <section id="stable_section" class="block-category"><h2>Stable Section</h2></section>
    `;

    try {
      // Step 1: Successful initial compilation
      compiler.compileTheme(tempDir, validHtml);
      const initialSections = fs.readdirSync(path.join(tempDir, 'sections'));
      assert.ok(initialSections.includes('stable_section.liquid'));
      const initialIndexContent = fs.readFileSync(path.join(tempDir, 'templates', 'index.json'), 'utf-8');

      // Step 2: Second compilation with invalid input (null/empty string) throws
      assert.throws(() => {
        compiler.compileTheme(tempDir, null as unknown as string);
      }, /ThemeCompiler/);

      // Step 3: Assert prior destination files remain completely intact
      const afterSections = fs.readdirSync(path.join(tempDir, 'sections'));
      assert.ok(afterSections.includes('stable_section.liquid'), 'Prior stable section must be preserved');
      const afterIndexContent = fs.readFileSync(path.join(tempDir, 'templates', 'index.json'), 'utf-8');
      assert.strictEqual(afterIndexContent, initialIndexContent, 'templates/index.json must not be corrupted or wiped');
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
