import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';
import { PLATFORM_PREVIEW_CHROME, PLATFORM_PREVIEW_CHROME_SELECTORS } from '../../src/main/qa/platform-preview-chrome';
import { LayoutIntegrityEngine } from '../../src/main/qa/scanners/layout-integrity-engine';
import { ImageFrameScanner } from '../../src/main/qa/scanners/image-frame-scanner';
import { VisualQualityScanner } from '../../src/main/qa/scanners/visual-quality-scanner';
import { buildDiscoverScript, buildRestCheckScript } from '../../src/main/qa/state-matrix';

function findRoot(): string {
  for (let dir = __dirname; ; dir = path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, 'scripts', 'run-electron.cjs'))) return dir;
    if (path.dirname(dir) === dir) return process.cwd();
  }
}

const root = findRoot();
const qaDir = path.join(root, 'src', 'main', 'qa');
const SHARED_FILE = path.join(qaDir, 'platform-preview-chrome.ts');

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(full));
    else if (entry.isFile() && entry.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

test('no QA source keeps its own copy of the platform preview chrome list', () => {
  assert.ok(fs.existsSync(qaDir), `qa directory missing: ${qaDir}`);
  const files = sourceFiles(qaDir).filter((file) => file !== SHARED_FILE);
  assert.ok(files.length > 10, 'the scan must actually cover the QA sources');
  const offenders: string[] = [];
  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8');
    for (const needle of ['preview-bar', 'preview_bar', 'bizweb-theme-previewer', 'PBarNextFrameWrapper', 'preview-cta']) {
      if (text.includes(needle)) offenders.push(`${path.relative(root, file)} contains "${needle}"`);
    }
  }
  assert.deepEqual(offenders, [], 'selectors for the platform preview chrome belong in platform-preview-chrome.ts only');
});

test('every QA consumer of the preview chrome imports the shared constant', () => {
  for (const rel of [
    'state-matrix.ts',
    path.join('scanners', 'image-frame-scanner.ts'),
    path.join('scanners', 'layout-integrity-engine.ts'),
    path.join('scanners', 'visual-quality-scanner.ts'),
  ]) {
    const text = fs.readFileSync(path.join(qaDir, rel), 'utf8');
    assert.match(text, /import \{ PLATFORM_PREVIEW_CHROME \} from '\.\.?\/platform-preview-chrome'/, `${rel} must import the shared constant`);
  }
});

test('the shared list carries the union every private list used to carry', () => {
  for (const selector of [
    '#preview-bar-iframe',
    '[id*="preview-bar"]',
    '.preview-bar',
    'ul.preview-cta',
    '#haravan-notification',
    '.hrv-admin-bar',
    '#admin-bar-iframe',
    '#admin_bar_iframe',
    '#bizweb-theme-previewer',
    '#PBarNextFrameWrapper',
  ]) {
    assert.ok(PLATFORM_PREVIEW_CHROME_SELECTORS.includes(selector), `shared list lost ${selector}`);
  }
  assert.equal(PLATFORM_PREVIEW_CHROME, PLATFORM_PREVIEW_CHROME_SELECTORS.join(', '));
});

test('every page script embeds the full shared selector list and still parses', () => {
  const scripts: Record<string, string> = {
    'layout-integrity': LayoutIntegrityEngine.getBrowserScanScript('desktop'),
    'image-frame': ImageFrameScanner.getBrowserScanScript(),
    'visual-quality': VisualQualityScanner.getBrowserScanScript(),
    'state-matrix discover': buildDiscoverScript([], 4),
    'state-matrix rest check': buildRestCheckScript(),
  };
  for (const [name, script] of Object.entries(scripts)) {
    for (const selector of PLATFORM_PREVIEW_CHROME_SELECTORS) {
      // JSON.stringify escapes the double quotes inside attribute selectors exactly as the scripts embed them.
      assert.ok(script.includes(JSON.stringify(selector).slice(1, -1)), `${name} script is missing ${selector}`);
    }
    assert.ok(!script.includes('__PLATFORM_PREVIEW_CHROME__'), `${name} script kept an unsubstituted placeholder`);
    assert.doesNotThrow(() => new vm.Script(script), `${name} script must remain valid JavaScript`);
  }
});

test('scanners that skip the AntiFan override style keep skipping it next to the shared list', () => {
  for (const script of [ImageFrameScanner.getBrowserScanScript(), VisualQualityScanner.getBrowserScanScript()]) {
    assert.ok(script.includes('[data-antifan-override]'));
  }
});
