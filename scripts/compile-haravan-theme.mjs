/**
 * Runner: Compile Haravan Theme from Spec HTML / Clone IR
 * Complies with Haravan Canonical Base Contract (Audit Phase 05)
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

function parseArgs(args) {
  const parsed = {
    input: path.join(rootDir, 'specs', 'roahtrip-html-spec', 'index.html'),
    settingsMode: 'legacy-html',
    output: path.join(rootDir, 'build', 'haravan-theme'),
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--input' || arg === '-i') {
      parsed.input = path.resolve(rootDir, args[++i]);
    } else if (arg.startsWith('--input=')) {
      parsed.input = path.resolve(rootDir, arg.slice('--input='.length));
    } else if (arg === '--settings-mode' || arg === '-m') {
      parsed.settingsMode = args[++i];
    } else if (arg.startsWith('--settings-mode=')) {
      parsed.settingsMode = arg.slice('--settings-mode='.length);
    } else if (arg === '--output' || arg === '-o') {
      parsed.output = path.resolve(rootDir, args[++i]);
    } else if (arg.startsWith('--output=')) {
      parsed.output = path.resolve(rootDir, arg.slice('--output='.length));
    }
  }

  return parsed;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  console.log('[Haravan Compiler] Starting compilation with configuration:');
  console.log(`  - Input File:    ${args.input}`);
  console.log(`  - Settings Mode: ${args.settingsMode}`);
  console.log(`  - Output Dir:    ${args.output}`);

  // (a) Verify input file exists before compiling; fail with clear message if absent
  if (!fs.existsSync(args.input)) {
    console.error(`[Haravan Compiler Error] Input file does not exist: "${args.input}"`);
    console.error('Please specify a valid HTML or IR file using --input <path>');
    process.exit(1);
  }

  // Validate settingsMode early
  if (args.settingsMode !== 'legacy-html' && args.settingsMode !== 'f1genz-schema') {
    console.error(`[Haravan Compiler Error] Unsupported settings mode: "${args.settingsMode}".`);
    console.error('Haravan supports only "legacy-html" or "f1genz-schema". Dual mode is strictly unsupported.');
    process.exit(1);
  }

  const rawHtml = fs.readFileSync(args.input, 'utf-8');

  // Load ThemeCompiler
  let ThemeCompiler;
  try {
    const mod = await import('../packages/site-clone/dist/index.js');
    ThemeCompiler = mod.ThemeCompiler;
  } catch {
    try {
      const mod = await import('../packages/site-clone/dist/generators/theme-compiler.js');
      ThemeCompiler = mod.ThemeCompiler;
    } catch {
      try {
        // Direct source execution fallback (needs a TypeScript loader present)
        const mod = await import('../packages/site-clone/src/generators/theme-compiler.ts');
        ThemeCompiler = mod.ThemeCompiler;
      } catch {
        ThemeCompiler = undefined;
      }
    }
  }

  if (!ThemeCompiler) {
    console.error('[Haravan Compiler Error] Unable to resolve ThemeCompiler module.');
    process.exit(1);
  }

  const compiler = new ThemeCompiler();
  const result = compiler.compileTheme(args.output, rawHtml, {
    settingsMode: args.settingsMode,
  });

  console.log('[Haravan Compiler] Theme compilation completed successfully!');
  console.log(`  - Target Platform:  haravan`);
  console.log(`  - Settings Mode:    ${result.targetContract.settingsMode}`);
  console.log(`  - Sections Count:   ${result.sectionCount}`);
  console.log(`  - Total Files:      ${result.filesWritten.length}`);
  console.log('\n[Emitted Files List]:');
  for (const file of result.filesWritten) {
    const rel = path.relative(args.output, file);
    console.log(`  + ${rel}`);
  }
}

main().catch(err => {
  console.error('[Haravan Compiler Fatal Error]:', err.message || err);
  process.exit(1);
});
