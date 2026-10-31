import { describe, it, after } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { TERMINAL_CHANNELS } from '../../src/shared/contracts';
import { buildVSCodeFileUrl, buildVSCodeLaunchArgs, isSystemAppDocument, normalizePreviewPath, readFilePreview } from '../../src/main/browser/file-preview-reader';
import { findTerminalFileLinks, isValidTerminalFilePath } from '../../src/shared/terminal-file-links';

const linkTexts = (line: string): string[] => findTerminalFileLinks(line).map((link) => link.text);

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

  it('every file-link channel the preload invokes has exactly one main-side handler', () => {
    const preload = fs.readFileSync(path.join(ROOT, 'src/preload/standalone-preload.ts'), 'utf8');
    const host = fs.readFileSync(path.join(ROOT, 'src/main/browser/native-tab-host.ts'), 'utf8');
    for (const key of ['READ_FILE_PREVIEW', 'OPEN_DOCUMENT', 'OPEN_IN_VSCODE'] as const) {
      assert.ok(preload.includes(`ipcRenderer.invoke(TERMINAL_CHANNELS.${key},`), `preload invokes ${key}`);
      assert.strictEqual(host.split(`channel: TERMINAL_CHANNELS.${key},`).length - 1, 1, `one handler for ${key}`);
    }
  });

  it('verifies standalone.js links terminal paths through the shared findTerminalFileLinkRanges global', () => {
    const jsPath = path.join(ROOT, 'src/renderer/standalone.js');
    assert.ok(fs.existsSync(jsPath));
    const jsContent = fs.readFileSync(jsPath, 'utf8');
    assert.match(jsContent, /function attachFileLinksProvider/);
    assert.match(jsContent, /async function openFileQuickLook/);
    assert.match(jsContent, /ensureFileQuickLookModal/);
    assert.match(jsContent, /btnFileQuickLookInsertPrompt/);
    // Cell ranges, not string offsets (behaviour: test/renderer/terminal-file-link-provider.test.ts).
    assert.match(jsContent, /findTerminalFileLinkRanges\(term\.buffer\.active, y\)/);

    const htmlContent = fs.readFileSync(path.join(ROOT, 'src/renderer/standalone.html'), 'utf8');
    const sharedIdx = htmlContent.indexOf("'terminal-file-links.js'");
    assert.ok(sharedIdx !== -1, 'standalone.html must load terminal-file-links.js');
    assert.ok(sharedIdx < htmlContent.indexOf("'standalone.js'"), 'terminal-file-links.js must load before standalone.js');
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

  it('findTerminalFileLinks matches Windows paths, relative paths, and lines with colons', () => {
    assert.deepStrictEqual(
      linkTexts('E:\\Work\\tools\\HaravanDemoKit\\scripts\\phukienmaymoc-seed-menus-console.js'),
      ['E:\\Work\\tools\\HaravanDemoKit\\scripts\\phukienmaymoc-seed-menus-console.js'],
    );
    assert.deepStrictEqual(linkTexts('Dán nội dung "E:\\Work\\scripts\\seed.js:45:10" vào console'), ['E:\\Work\\scripts\\seed.js:45:10']);
    assert.deepStrictEqual(linkTexts('Created ./src/main/browser/element-picker.ts successfully'), ['./src/main/browser/element-picker.ts']);
    assert.deepStrictEqual(linkTexts('Sửa file package.json:14 và theme.liquid:88 cùng CLAUDE.md'), ['package.json:14', 'theme.liquid:88', 'CLAUDE.md']);
  });

  it('findTerminalFileLinks keeps directory names with spaces inside one absolute-path link', () => {
    const line = ' Write: \u25a1 E:/Work/themes/devs2/Haravan/S2 Sky Fashion/deliverables/REUSABLE_THEME_PROMPT.md \u00b7 56 lines';
    const links = findTerminalFileLinks(line);
    const expected = 'E:/Work/themes/devs2/Haravan/S2 Sky Fashion/deliverables/REUSABLE_THEME_PROMPT.md';
    assert.deepStrictEqual(links.map((link) => link.text), [expected]);
    const [link] = links;
    assert.ok(link);
    assert.strictEqual(line.slice(link.start, link.end), expected);

    assert.deepStrictEqual(linkTexts('"E:\\Work\\My Theme\\snippets\\a b\\card.liquid:12"'), ['E:\\Work\\My Theme\\snippets\\a b\\card.liquid:12']);
    assert.deepStrictEqual(linkTexts('/Users/me/S2 Sky Fashion/notes.md'), ['/Users/me/S2 Sky Fashion/notes.md']);
  });

  it('findTerminalFileLinks does not let a spaced segment swallow prose or command chains', () => {
    assert.deepStrictEqual(linkTexts('E:/Work/a.ts was saved in src/b.ts'), ['E:/Work/a.ts', 'src/b.ts']);
    assert.deepStrictEqual(linkTexts('cd E:/Work/apps && node scripts/run.js'), ['scripts/run.js']);
    assert.deepStrictEqual(linkTexts('E:/Work/a.ts, E:/Work/S2 Sky/b.md'), ['E:/Work/a.ts', 'E:/Work/S2 Sky/b.md']);
  });

  it('isValidTerminalFilePath rejects MCP tools, RPC methods, and non-file paths', () => {
    assert.strictEqual(isValidTerminalFilePath('anti.browser.tabs.list'), false);
    assert.strictEqual(isValidTerminalFilePath('antifan-browser/anti.browser.tabs.list'), false);
    assert.strictEqual(isValidTerminalFilePath('E:\\Work\\customizes\\Phukienmaymoc\\antifan-browser\\anti.browser.tabs.list'), false);
    assert.strictEqual(isValidTerminalFilePath('browser.navigate'), false);
    assert.strictEqual(isValidTerminalFilePath('theme.style_override'), false);
    assert.strictEqual(isValidTerminalFilePath('mcp__antifan_browser_dom'), false);
    assert.strictEqual(isValidTerminalFilePath('tool.stat'), false);
    assert.strictEqual(isValidTerminalFilePath('actions.create'), false);
    assert.strictEqual(isValidTerminalFilePath('console.log'), false);
    assert.strictEqual(isValidTerminalFilePath('process.exit'), false);
    assert.strictEqual(isValidTerminalFilePath('window.location'), false);
    assert.strictEqual(isValidTerminalFilePath('E:\\Work\\templates\\collection.liquid'), true);
    assert.strictEqual(isValidTerminalFilePath('./src/main/browser/element-picker.ts:45:10'), true);
    assert.strictEqual(isValidTerminalFilePath('layout/theme.liquid'), true);
    assert.strictEqual(isValidTerminalFilePath('theme.qa_validate'), false);
    assert.strictEqual(isValidTerminalFilePath('scripts/seed.js:12'), true);
    assert.strictEqual(isValidTerminalFilePath('package.json'), true);
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

  it('readFilePreview serves a real video container by file URL and refuses a renamed text file', () => {
    const mp4Bytes = Buffer.concat([Buffer.from([0x00, 0x00, 0x00, 0x18]), Buffer.from('ftypisom', 'latin1'), Buffer.alloc(16)]);
    const mp4Path = path.join(tempDir, 'reel final.mp4');
    fs.writeFileSync(mp4Path, mp4Bytes);
    const mp4Res = readFilePreview(mp4Path);
    assert.ok(mp4Res.ok && mp4Res.kind === 'video');
    assert.strictEqual(mp4Res.mimeType, 'video/mp4');
    assert.strictEqual(mp4Res.size, mp4Bytes.length);
    assert.strictEqual(new URL(mp4Res.fileUrl).protocol, 'file:');
    assert.ok(mp4Res.fileUrl.endsWith('/reel%20final.mp4'), mp4Res.fileUrl);

    const hashedPath = path.join(tempDir, 'a #1 Gác 100%.mp4');
    fs.writeFileSync(hashedPath, mp4Bytes);
    const hashedRes = readFilePreview(hashedPath);
    assert.ok(hashedRes.ok && hashedRes.kind === 'video');
    const hashedUrl = new URL(hashedRes.fileUrl);
    assert.strictEqual(hashedUrl.hash, '', 'a # in the name must not start a fragment');
    assert.strictEqual(decodeURIComponent(hashedUrl.pathname).endsWith('/a #1 Gác 100%.mp4'), true, hashedRes.fileUrl);

    const webmPath = path.join(tempDir, 'CLIP.WEBM');
    fs.writeFileSync(webmPath, Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x01, 0x00]));
    const webmRes = readFilePreview(webmPath);
    assert.ok(webmRes.ok && webmRes.kind === 'video');
    assert.strictEqual(webmRes.mimeType, 'video/webm');

    const fakeMp4Path = path.join(tempDir, 'notes.mp4');
    fs.writeFileSync(fakeMp4Path, 'plain text, not a video\n', 'utf8');
    const fakeRes = readFilePreview(fakeMp4Path);
    assert.ok(fakeRes.ok && fakeRes.kind === 'text');

    const emptyMp4Path = path.join(tempDir, 'empty.mp4');
    fs.writeFileSync(emptyMp4Path, '');
    const emptyRes = readFilePreview(emptyMp4Path);
    assert.ok(!(emptyRes.ok && emptyRes.kind === 'video'));
  });

  it('turns a video path in terminal output into a link', () => {
    assert.deepStrictEqual(linkTexts('Đã xuất E:/Work/Gác/channels/ttb/videos/reel-01/out/r1.mp4 xong'), ['E:/Work/Gác/channels/ttb/videos/reel-01/out/r1.mp4']);
  });

  it('turns an Office or PDF path into a link and routes only those to the system app', () => {
    const report = 'E:\\Work\\apps\\F1GENZ MultiSync\\reports\\doi-soat-2026-10-30.xlsx';
    assert.deepStrictEqual(linkTexts(`File Excel: ${report}`), [report]);
    assert.strictEqual(isSystemAppDocument(report), true);
    assert.strictEqual(isSystemAppDocument('C:/Docs/Spec.PDF'), true);
    assert.strictEqual(isSystemAppDocument('E:/Work/a.md'), false);
    assert.strictEqual(isSystemAppDocument('E:/Work/setup.exe'), false);
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

      return { args: buildVSCodeLaunchArgs(resolvedTarget, isFile, lineColSuffix), target: resolvedTarget };
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

    // 4. Windows opens through the vscode:// URL handler: no shell, so nothing in the path is
    // expanded or re-quoted, and a spaced, %-bearing or #-bearing path stays one target.
    const spaced = 'E:\\Work\\S2 Sky Fashion\\deliverables\\REUSABLE_THEME_PROMPT.md';
    assert.strictEqual(buildVSCodeFileUrl(spaced, true, ':3'), 'vscode://file/E:/Work/S2%20Sky%20Fashion/deliverables/REUSABLE_THEME_PROMPT.md:3');
    assert.strictEqual(buildVSCodeFileUrl('E:\\Work\\a%PATH%b\\#1.md', true, ''), 'vscode://file/E:/Work/a%25PATH%25b/%231.md');
    assert.strictEqual(buildVSCodeFileUrl('E:\\Work\\S2 Sky Fashion\\', false, ':9'), 'vscode://file/E:/Work/S2%20Sky%20Fashion', 'a folder takes no line suffix');
    assert.strictEqual(buildVSCodeFileUrl('/home/dev/shop/a.liquid', true, ':4:2'), 'vscode://file/home/dev/shop/a.liquid:4:2');
    assert.deepStrictEqual(buildVSCodeLaunchArgs('/home/dev/My Shop/a.md', true, ':3'), ['-r', '-g', '/home/dev/My Shop/a.md:3']);
  });
});
