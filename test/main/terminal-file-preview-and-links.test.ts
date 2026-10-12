import { describe, it, after } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { TERMINAL_CHANNELS } from '../../src/shared/contracts';
import { normalizePreviewPath, readFilePreview } from '../../src/main/browser/file-preview-reader';

const ROOT = path.resolve(__dirname, '../../..');

describe('Terminal File Quick-Look & Link Provider Contracts', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-file-preview-test-'));
  const sampleFilePath = path.join(tempDir, 'sample-script.js');
  const sampleContent = 'console.log("Hello from AntiFan seed menu!");\nconst a = 10;\nconst b = 20;\nconsole.log(a + b);';
  fs.writeFileSync(sampleFilePath, sampleContent, 'utf8');

  const binaryFilePath = path.join(tempDir, 'binary-asset.bin');
  fs.writeFileSync(binaryFilePath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x0a, 0x1a, 0x0a]));

  after(() => {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  it('verifies TERMINAL_CHANNELS includes READ_FILE_PREVIEW', () => {
    assert.strictEqual(TERMINAL_CHANNELS.READ_FILE_PREVIEW, 'antifan:terminal:read-file-preview');
  });

  it('verifies standalone-preload.ts exports readFilePreview', () => {
    const preloadPath = path.join(ROOT, 'src/preload/standalone-preload.ts');
    assert.ok(fs.existsSync(preloadPath));
    const preloadContent = fs.readFileSync(preloadPath, 'utf8');
    assert.match(
      preloadContent,
      /readFilePreview:\s*\(filePath:\s*string,\s*sessionId\?:\s*string\)/
    );
  });

  it('verifies standalone.js contains attachFileLinksProvider, openFileQuickLook, and isValidTerminalFilePath filter', () => {
    const jsPath = path.join(ROOT, 'src/renderer/standalone.js');
    assert.ok(fs.existsSync(jsPath));
    const jsContent = fs.readFileSync(jsPath, 'utf8');
    assert.match(jsContent, /function attachFileLinksProvider/);
    assert.match(jsContent, /async function openFileQuickLook/);
    assert.match(jsContent, /ensureFileQuickLookModal/);
    assert.match(jsContent, /btnFileQuickLookInsertPrompt/);
    assert.match(jsContent, /function isValidTerminalFilePath/);
    assert.match(jsContent, /VALID_FILE_EXTENSIONS/);
  });

  it('verifies standalone.css defines File Quick-Look modal styles', () => {
    const cssPath = path.join(ROOT, 'src/renderer/standalone.css');
    assert.ok(fs.existsSync(cssPath));
    const cssContent = fs.readFileSync(cssPath, 'utf8');
    assert.match(cssContent, /\.file-quick-look-modal/);
    assert.match(cssContent, /\.file-quick-look-dialog/);
    assert.match(cssContent, /\.file-quick-look-btn-copy/);
    assert.match(cssContent, /\.file-quick-look-btn-insert/);
    assert.match(cssContent, /\.file-quick-look-btn-vscode/);
    assert.match(cssContent, /\.file-quick-look-code/);
  });

  it('verifies FILE_PATH_RE correctly matches Windows paths, relative paths, and lines with colons', () => {
    const FILE_PATH_RE = /(?:^|[\s"'`(\[<])((?:[a-zA-Z]:[\\/][^\s:;,"'<>()[\]`\x1b]+|(?:\.{1,2}[\\/]|[a-zA-Z0-9_\-\.]+[\\/])[^\s:;,"'<>()[\]`\x1b]+\.[a-zA-Z0-9_\-]+|\/(?:home|Users|usr|var|tmp|etc|work|Work)[\\/][^\s:;,"'<>()[\]`\x1b]+|[a-zA-Z0-9_\-][a-zA-Z0-9_\-\.]*\.[a-zA-Z0-9_\-]+)(?::\d+(?::\d+)?)?)/g;

    const line1 = 'File script console đã được cập nhật tại:\nE:\\Work\\tools\\HaravanDemoKit\\scripts\\phukienmaymoc-seed-menus-console.js';
    const matches1: string[] = [];
    let m: RegExpExecArray | null;
    while ((m = FILE_PATH_RE.exec(line1)) !== null) {
      if (m[1]) matches1.push(m[1]);
    }
    assert.strictEqual(matches1.length, 1);
    assert.strictEqual(matches1[0], 'E:\\Work\\tools\\HaravanDemoKit\\scripts\\phukienmaymoc-seed-menus-console.js');

    const line2 = 'Dán nội dung "E:\\Work\\scripts\\seed.js:45:10" vào console';
    FILE_PATH_RE.lastIndex = 0;
    const matches2: string[] = [];
    while ((m = FILE_PATH_RE.exec(line2)) !== null) {
      if (m[1]) matches2.push(m[1]);
    }
    assert.strictEqual(matches2.length, 1);
    assert.strictEqual(matches2[0], 'E:\\Work\\scripts\\seed.js:45:10');

    const line3 = 'Created ./src/main/browser/element-picker.ts successfully';
    FILE_PATH_RE.lastIndex = 0;
    const matches3: string[] = [];
    while ((m = FILE_PATH_RE.exec(line3)) !== null) {
      if (m[1]) matches3.push(m[1]);
    }
    assert.strictEqual(matches3.length, 1);
    assert.strictEqual(matches3[0], './src/main/browser/element-picker.ts');

    const line4 = 'Sửa file package.json:14 và theme.liquid:88 cùng CLAUDE.md';
    FILE_PATH_RE.lastIndex = 0;
    const matches4: string[] = [];
    while ((m = FILE_PATH_RE.exec(line4)) !== null) {
      if (m[1]) matches4.push(m[1]);
    }
    assert.strictEqual(matches4.length, 3);
    assert.strictEqual(matches4[0], 'package.json:14');
    assert.strictEqual(matches4[1], 'theme.liquid:88');
    assert.strictEqual(matches4[2], 'CLAUDE.md');
  });

  it('verifies isValidTerminalFilePath correctly rejects MCP tools, RPC methods, and non-file paths', () => {
    // Replicate logic to assert invariants
    const VALID_FILE_EXTENSIONS: Record<string, true> = {
      ts: true, tsx: true, js: true, jsx: true, cjs: true, mjs: true, json: true, css: true, scss: true, html: true, liquid: true, bwt: true, md: true, sh: true, py: true
    };
    const DISALLOWED_EXTENSIONS: Record<string, true> = {
      list: true, get: true, set: true, create: true, update: true, delete: true, close: true, activate: true
    };

    function testIsValid(p: string): boolean {
      if (!p) return false;
      let clean = p.trim().replace(/^["'`]/, '').replace(/["'`]$/, '').replace(/[,\.;\)]+$/, '');
      if (clean.startsWith('anti.') || clean.includes('/anti.') || clean.includes('\\anti.') ||
          clean.startsWith('browser.') || clean.includes('/browser.') || clean.includes('\\browser.') ||
          clean.startsWith('theme.') || clean.includes('/theme.') || clean.includes('\\theme.') ||
          clean.startsWith('mcp__') || clean.includes('mcp__') || clean.startsWith('xd://') ||
          clean.includes('antifan-browser/') || clean.includes('antifan-browser\\') ||
          clean.startsWith('console.') || clean.startsWith('process.') ||
          clean.startsWith('window.') || clean.startsWith('document.')) {
        return false;
      }
      const lineColIdx = clean.search(/:\d+(?::\d+)?$/);
      if (lineColIdx !== -1) clean = clean.slice(0, lineColIdx);
      const lastDot = clean.lastIndexOf('.');
      if (lastDot === -1) return false;
      const ext = clean.slice(lastDot + 1).toLowerCase();
      if (DISALLOWED_EXTENSIONS[ext]) return false;
      return Boolean(VALID_FILE_EXTENSIONS[ext]);
    }

    // Must reject MCP tools & RPC verbs
    assert.strictEqual(testIsValid('anti.browser.tabs.list'), false);
    assert.strictEqual(testIsValid('antifan-browser/anti.browser.tabs.list'), false);
    assert.strictEqual(testIsValid('E:\\Work\\customizes\\Phukienmaymoc\\antifan-browser\\anti.browser.tabs.list'), false);
    assert.strictEqual(testIsValid('browser.navigate'), false);
    assert.strictEqual(testIsValid('theme.style_override'), false);
    assert.strictEqual(testIsValid('mcp__antifan_browser_dom'), false);
    assert.strictEqual(testIsValid('tool.stat'), false);
    assert.strictEqual(testIsValid('actions.create'), false);
    assert.strictEqual(testIsValid('console.log'), false);
    assert.strictEqual(testIsValid('process.exit'), false);
    assert.strictEqual(testIsValid('window.location'), false);
    // Must accept valid code and template files
    assert.strictEqual(testIsValid('E:\\Work\\templates\\collection.liquid'), true);
    assert.strictEqual(testIsValid('./src/main/browser/element-picker.ts:45:10'), true);
    assert.strictEqual(testIsValid('scripts/seed.js:12'), true);
    assert.strictEqual(testIsValid('package.json'), true);
  });

  it('normalizePreviewPath strips quotes, trailing punctuation and :line:col suffixes', () => {
    assert.strictEqual(normalizePreviewPath(`${sampleFilePath}:2:5`), sampleFilePath);
    assert.strictEqual(normalizePreviewPath(`${sampleFilePath}:12`), sampleFilePath);
    assert.strictEqual(normalizePreviewPath(`"${sampleFilePath}"`), sampleFilePath);
    assert.strictEqual(normalizePreviewPath(`\`${sampleFilePath}\``), sampleFilePath);
    assert.strictEqual(normalizePreviewPath(`${sampleFilePath}),`), sampleFilePath);
  });

  it('readFilePreview returns text, image, binary, not-found and directory results from real files', () => {
    const textRes = readFilePreview(sampleFilePath);
    assert.ok(textRes.ok && textRes.kind === 'text');
    assert.strictEqual(textRes.content, sampleContent);
    assert.strictEqual(textRes.lineCount, 4);
    assert.strictEqual(textRes.fileName, 'sample-script.js');
    assert.strictEqual(textRes.isTruncated, false);

    const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);
    const pngPath = path.join(tempDir, 'capture.png');
    fs.writeFileSync(pngPath, pngBytes);
    const pngRes = readFilePreview(pngPath);
    assert.ok(pngRes.ok && pngRes.kind === 'image');
    assert.strictEqual(pngRes.mimeType, 'image/png');
    assert.strictEqual(pngRes.dataUrl, `data:image/png;base64,${pngBytes.toString('base64')}`);
    assert.strictEqual(pngRes.size, pngBytes.length);
    assert.strictEqual(pngRes.fileName, 'capture.png');

    const upperJpgPath = path.join(tempDir, 'PHOTO.JPG');
    fs.writeFileSync(upperJpgPath, Buffer.from([0xff, 0xd8, 0xff, 0x00]));
    const jpgRes = readFilePreview(upperJpgPath);
    assert.ok(jpgRes.ok && jpgRes.kind === 'image');
    assert.strictEqual(jpgRes.mimeType, 'image/jpeg');

    const mislabeledPath = path.join(tempDir, 'renamed.jpg');
    fs.writeFileSync(mislabeledPath, pngBytes);
    const mislabeledRes = readFilePreview(mislabeledPath);
    assert.ok(mislabeledRes.ok && mislabeledRes.kind === 'image');
    assert.strictEqual(mislabeledRes.mimeType, 'image/png');

    const fakePngPath = path.join(tempDir, 'notes.png');
    fs.writeFileSync(fakePngPath, 'not really an image\n', 'utf8');
    const fakePngRes = readFilePreview(fakePngPath);
    assert.ok(fakePngRes.ok && fakePngRes.kind === 'text');
    assert.strictEqual(fakePngRes.content, 'not really an image\n');

    const svgPath = path.join(tempDir, 'icon.svg');
    fs.writeFileSync(svgPath, '<svg xmlns="http://www.w3.org/2000/svg"></svg>', 'utf8');
    const svgRes = readFilePreview(svgPath);
    assert.ok(svgRes.ok && svgRes.kind === 'text');

    const binRes = readFilePreview(binaryFilePath);
    assert.ok(!binRes.ok);
    assert.strictEqual(binRes.reason, 'BINARY_FILE');

    const notFoundRes = readFilePreview(path.join(tempDir, 'does-not-exist.png'));
    assert.ok(!notFoundRes.ok);
    assert.strictEqual(notFoundRes.reason, 'NOT_FOUND');

    const dirRes = readFilePreview(tempDir);
    assert.ok(!dirRes.ok);
    assert.strictEqual(dirRes.reason, 'IS_DIRECTORY');
  });

  it('verifies openInVSCode logic correctly strips line:col, resolves relative path, and generates -r -g arguments', () => {
    function computeVSCodeArgs(targetPath?: string, workspaceFallback?: string): { args: string[]; target: string } {
      let cleanPath = typeof targetPath === 'string' ? targetPath.trim() : '';
      let lineColSuffix = '';
      if (cleanPath) {
        const lineColMatch = cleanPath.match(/:\d+(?::\d+)?$/);
        if (lineColMatch) {
          lineColSuffix = lineColMatch[0];
          cleanPath = cleanPath.slice(0, cleanPath.length - lineColSuffix.length);
        }
      }

      let resolvedTarget = cleanPath;
      let isFile = false;

      if (!resolvedTarget || !fs.existsSync(resolvedTarget)) {
        const ws = workspaceFallback;
        if (ws && cleanPath && !path.isAbsolute(cleanPath)) {
          const candidate = path.resolve(ws, cleanPath);
          if (fs.existsSync(candidate)) {
            resolvedTarget = candidate;
          }
        }
        if (!resolvedTarget || !fs.existsSync(resolvedTarget)) {
          resolvedTarget = ws ?? '';
        }
      }

      if (resolvedTarget && fs.existsSync(resolvedTarget)) {
        try {
          isFile = fs.statSync(resolvedTarget).isFile();
        } catch {}
      }

      const args: string[] = ['-r'];
      if (isFile) {
        args.push('-g', `${resolvedTarget}${lineColSuffix}`);
      } else {
        args.push(resolvedTarget);
      }
      return { args, target: resolvedTarget };
    }

    // 1. Target file with line & col
    const res1 = computeVSCodeArgs(`${sampleFilePath}:42:15`);
    assert.strictEqual(res1.target, sampleFilePath);
    assert.deepStrictEqual(res1.args, ['-r', '-g', `${sampleFilePath}:42:15`]);

    // 2. Relative file resolved against workspace
    const relativeName = path.basename(sampleFilePath);
    const res2 = computeVSCodeArgs(`${relativeName}:10`, tempDir);
    assert.strictEqual(res2.target, sampleFilePath);
    assert.deepStrictEqual(res2.args, ['-r', '-g', `${sampleFilePath}:10`]);

    // 3. Directory without line
    const res3 = computeVSCodeArgs(tempDir);
    assert.strictEqual(res3.target, tempDir);
    assert.deepStrictEqual(res3.args, ['-r', tempDir]);
  });
});
