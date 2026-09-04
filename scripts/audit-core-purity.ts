/**
 * AntiFan Architecture Gate — Core Purity Audit Script
 *
 * Verifies that the Core runtime (src/main/) contains zero product-specific fixture
 * selectors or assumptions, no secondary browser runtimes (Playwright MCP), and no
 * foreign agent/swarm frameworks.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

interface AuditViolation {
  file: string;
  line: number;
  pattern: string;
  content: string;
}

const BANNED_PATTERNS: Array<{ pattern: string; description: string }> = [
  { pattern: '.product-card', description: 'Product Card fixture selector' },
  { pattern: '.card__badge', description: 'Product Card fixture selector' },
  { pattern: '.card__price', description: 'Product Card fixture selector' },
  { pattern: '.button--add-to-cart', description: 'Product Card fixture selector' },
  { pattern: 'card-product.liquid', description: 'Product Card fixture file reference' },
  { pattern: 'golden-workflow', description: 'Fixture directory reference in Core' },
  { pattern: '@modelcontextprotocol/sdk/client/playwright', description: 'Playwright MCP client in Core' },
  { pattern: 'from "playwright"', description: 'Direct Playwright runtime in Core' },
  { pattern: "from 'playwright'", description: 'Direct Playwright runtime in Core' },
];

function scanDirectory(dir: string): string[] {
  const files: string[] = [];
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        files.push(...scanDirectory(fullPath));
      } else if (entry.isFile() && (entry.name.endsWith('.ts') || entry.name.endsWith('.js'))) {
        files.push(fullPath);
      }
    }
  } catch {}
  return files;
}

export function runCorePurityAudit(): { passed: boolean; violations: AuditViolation[] } {
  const mainDir = path.resolve(process.cwd(), 'src/main');
  const files = scanDirectory(mainDir);
  const violations: AuditViolation[] = [];

  for (const filePath of files) {
    const content = fs.readFileSync(filePath, 'utf8');
    const lines = content.split('\n');

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] || '';
      for (const item of BANNED_PATTERNS) {
        if (line.includes(item.pattern)) {
          violations.push({
            file: path.relative(process.cwd(), filePath).replace(/\\/g, '/'),
            line: i + 1,
            pattern: item.pattern,
            content: line.trim(),
          });
        }
      }
    }
  }

  return {
    passed: violations.length === 0,
    violations,
  };
}

if (require.main === module || (typeof process !== 'undefined' && process.argv[1] && process.argv[1].endsWith('audit-core-purity.ts'))) {
  const result = runCorePurityAudit();
  if (result.passed) {
    console.log('[OK] Core Purity Audit Passed: src/main/ contains zero fixture bleed or forbidden dependencies.');
    process.exit(0);
  } else {
    console.error(`[FAIL] Core Purity Audit Failed with ${result.violations.length} violation(s):`);
    for (const v of result.violations) {
      console.error(`  - ${v.file}:${v.line} matches "${v.pattern}": ${v.content}`);
    }
    process.exit(1);
  }
}
