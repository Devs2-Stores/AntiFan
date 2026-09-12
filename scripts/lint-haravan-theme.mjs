#!/usr/bin/env node
/**
 * Dedicated offline, zero-network static linter for Haravan base theme verification.
 *
 * Verifies Haravan platform contracts:
 * - Zero {% schema %} blocks
 * - Zero {% render %} tags (use {% include %})
 * - Zero Shopify-only filters (reject, where, concat, at_most, at_least, image_url)
 * - Zero sections/ directory files
 * - Cart loops iterate cart.items with any variable name except the documented
 *   prohibited aliases (cart_item, item_cart, cart_line_item)
 * - Article count uses blog.articles_count
 * - product.media reads carry a product.images fallback in the same file; media_tag is refused
 * - Include-target resolution: every snippet referenced via {% include %} exists
 * - Settings resolution: every settings.<id> or settings['<id>'] read resolves in
 *   settings_data.json, the schema, or the settings.html control names
 * - Conditional settings mode validation (legacy vs f1genz)
 *
 * Usage:
 *   node scripts/lint-haravan-theme.mjs [--theme <dir>] [--platform haravan] [--settings-mode auto|legacy|f1genz]
 *
 * Exit code:
 *   0 when clean (0 violations)
 *   1 when any violation is found
 *   2 when themeDir is missing or unreadable
 */

import fs from 'node:fs';
import path from 'node:path';
import {
  checkHaravanLiquidContracts,
  validateThemeSchemas,
} from './lib/theme-checks.mjs';

function parseArgv(argv) {
  const options = {
    themeDir: 'themes/universal-haravan-base',
    platform: 'haravan',
    settingsMode: 'auto',
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--theme') {
      options.themeDir = argv[++i] ?? options.themeDir;
      continue;
    }
    if (arg === '--platform') {
      options.platform = argv[++i] ?? options.platform;
      continue;
    }
    if (arg === '--settings-mode') {
      const mode = argv[++i];
      if (mode !== 'auto' && mode !== 'legacy' && mode !== 'f1genz') {
        console.error(
          `[lint-haravan-theme] --settings-mode must be one of auto|legacy|f1genz (got: ${mode ?? 'missing'})`
        );
        process.exit(2);
      }
      options.settingsMode = mode;
      continue;
    }
    console.error(`[lint-haravan-theme] Unknown argument: ${arg}`);
    process.exit(2);
  }

  return options;
}

const options = parseArgv(process.argv.slice(2));
const resolvedThemeDir = path.resolve(options.themeDir);

if (!fs.existsSync(resolvedThemeDir) || !fs.statSync(resolvedThemeDir).isDirectory()) {
  console.error(`[lint-haravan-theme] Directory unreadable or not found: ${options.themeDir}`);
  process.exit(2);
}

const allViolations = [];

// A settings declaration is mode-specific: legacy HTML mode has no
// config/settings_schema.json, so requiring one there is a false refusal.
const hasSettingsHtml = fs.existsSync(path.join(resolvedThemeDir, 'config', 'settings.html'));
const hasSettingsSchema = fs.existsSync(path.join(resolvedThemeDir, 'config', 'settings_schema.json'));
const legacyOnlyMode =
  options.settingsMode === 'legacy' ||
  (options.settingsMode === 'auto' && hasSettingsHtml && !hasSettingsSchema);

// 1. Validate schemas with platform haravan
const schemaResult = validateThemeSchemas(resolvedThemeDir, {
  platform: options.platform,
  schemaRequired: !legacyOnlyMode,
});
for (const failure of schemaResult.failures) {
  allViolations.push({
    file: failure.path,
    line: failure.line ?? 1,
    rule: failure.rule,
    message: failure.detail,
  });
}

// 2. Check Haravan Liquid contracts and settings resolution
const contractsResult = checkHaravanLiquidContracts(resolvedThemeDir, {
  platform: options.platform,
  settingsMode: options.settingsMode,
});

for (const failure of contractsResult.failures) {
  // Avoid duplicate HARAVAN_FORBIDDEN_SECTION from both schema check and contract check
  const isDuplicate = allViolations.some(
    (v) => v.file === failure.file && v.line === failure.line && v.rule === failure.rule
  );
  if (!isDuplicate) {
    allViolations.push({
      file: failure.file,
      line: failure.line,
      rule: failure.rule,
      message: failure.message,
    });
  }
}

if (allViolations.length === 0) {
  console.log(`[lint-haravan-theme] clean: 0 violations in ${options.themeDir}`);
  process.exit(0);
} else {
  for (const v of allViolations) {
    console.error(`${v.file}:${v.line} ${v.rule} ${v.message}`);
  }
  console.error(`\n[lint-haravan-theme] FAILED with ${allViolations.length} violation(s)`);
  process.exit(1);
}
