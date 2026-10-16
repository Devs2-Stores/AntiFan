import { after, describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import { runPackageCheck } from '../../src/main/qa/probes/package-check';

interface ZipSource {
  name: string;
  data: Buffer | string;
  stored?: boolean;
}

const FIXTURES = path.resolve(process.cwd(), 'test/fixtures/probes');
const THEME = path.join(FIXTURES, 'package-theme');
const { buildZip, readTree } = createRequire(path.join(process.cwd(), 'package.json'))(
  './test/fixtures/probes/make-package-zip.cjs'
) as {
  buildZip(entries: ZipSource[]): Buffer;
  readTree(root: string): ZipSource[];
};

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'package-check-'));
after(() => fs.rmSync(scratch, { recursive: true, force: true }));

let counter = 0;
function writeZip(entries: ZipSource[]): string {
  counter += 1;
  const file = path.join(scratch, `case-${counter}.zip`);
  fs.writeFileSync(file, buildZip(entries));
  return file;
}

function themeEntries(mutate?: (entries: ZipSource[]) => ZipSource[]): ZipSource[] {
  const entries = readTree(THEME);
  return mutate ? mutate(entries) : entries;
}

function replaceEntry(entries: ZipSource[], name: string, data: string): ZipSource[] {
  return entries.map((e) => (e.name === name ? { ...e, data } : e));
}

const ids = (findings: Array<{ ruleId: string }>) => findings.map((f) => f.ruleId);

describe('package check: zip archives', () => {
  it('passes a clean theme archive and counts its file entries', async () => {
    const res = await runPackageCheck({ workspaceRoot: scratch, zipPath: writeZip(themeEntries()), expectedBrand: 'Sky Fashion' });
    assert.deepStrictEqual(res.findings, []);
    assert.equal(res.passed, true);
    assert.equal(res.zipEntries, 6);
  });

  it('reads the committed archive and one produced by a different zip writer', async () => {
    for (const name of ['package-theme.zip', 'package-theme-bsdtar.zip']) {
      const res = await runPackageCheck({ workspaceRoot: FIXTURES, zipPath: name, expectedBrand: 'Sky Fashion' });
      assert.deepStrictEqual(res.findings, [], name);
      assert.equal(res.passed, true, name);
      assert.equal(res.zipEntries, 6, name);
    }
  });

  it('fails an archive that carries a seeded access token and never echoes the token', async () => {
    const token = `ghp_${'A1b2C3d4E5'.repeat(4)}`;
    const zip = writeZip(themeEntries((e) => replaceEntry(e, 'assets/theme.js', `var accessToken = "${token}";\n`)));
    const res = await runPackageCheck({ workspaceRoot: scratch, zipPath: zip });
    assert.equal(res.passed, false);
    const secret = res.findings.find((f) => f.ruleId === 'package-secret');
    assert.ok(secret, JSON.stringify(res.findings));
    assert.equal(secret.severity, 'critical');
    assert.equal(secret.measured?.file, 'assets/theme.js');
    assert.ok(!JSON.stringify(res.findings).includes(token));
  });

  it('fails a credential assignment and a shipped .env file', async () => {
    const zip = writeZip(
      themeEntries((e) => [
        ...replaceEntry(e, 'assets/theme.js', 'window.cfg = { apiKey: "abcd1234efgh5678ijkl" };\n'),
        { name: '.env', data: 'X=1\n' },
      ])
    );
    const res = await runPackageCheck({ workspaceRoot: scratch, zipPath: zip });
    assert.equal(res.passed, false);
    assert.ok(ids(res.findings).includes('package-secret'));
    assert.ok(ids(res.findings).includes('package-secret-file'));
  });

  it('reports each missing required entry', async () => {
    const zip = writeZip(themeEntries((e) => e.filter((x) => x.name !== 'templates/index.liquid' && x.name !== 'layout/theme.liquid')));
    const res = await runPackageCheck({ workspaceRoot: scratch, zipPath: zip });
    assert.equal(res.passed, false);
    const entries = res.findings.filter((f) => f.ruleId === 'package-required-entry').map((f) => f.measured?.entry);
    assert.deepStrictEqual(entries.sort(), ['layout/theme.liquid', 'templates/']);
  });

  it('accepts config/settings.html in place of settings_schema.json', async () => {
    const zip = writeZip(
      themeEntries((e) => [...e.filter((x) => x.name !== 'config/settings_schema.json'), { name: 'config/settings.html', data: '<div></div>' }])
    );
    const res = await runPackageCheck({ workspaceRoot: scratch, zipPath: zip });
    assert.equal(res.passed, true, JSON.stringify(res.findings));
  });

  it('detects a theme nested under a folder and still checks its contents', async () => {
    const zip = writeZip(themeEntries((e) => e.map((x) => ({ ...x, name: `sky-fashion/${x.name}` }))));
    const res = await runPackageCheck({ workspaceRoot: scratch, zipPath: zip });
    assert.equal(res.passed, false);
    assert.deepStrictEqual(ids(res.findings), ['package-nested-root']);
    assert.equal(res.findings[0]?.measured?.prefix, 'sky-fashion/');
  });

  it('rejects entry paths that escape the archive root', async () => {
    const zip = writeZip(themeEntries((e) => [...e, { name: '../outside.txt', data: 'x' }]));
    const res = await runPackageCheck({ workspaceRoot: scratch, zipPath: zip });
    assert.equal(res.passed, false);
    assert.ok(ids(res.findings).includes('package-zip-unsafe-path'));
  });

  it('flags forbidden words case-insensitively and warns when the expected brand is absent', async () => {
    const forbidden = await runPackageCheck({ workspaceRoot: scratch, zipPath: writeZip(themeEntries()), forbiddenWords: ['SKY fashion'] });
    assert.equal(forbidden.passed, false);
    assert.match(forbidden.findings.find((f) => f.ruleId === 'package-forbidden-word')?.message ?? '', /layout\/theme\.liquid/);

    const brand = await runPackageCheck({ workspaceRoot: scratch, zipPath: writeZip(themeEntries()), expectedBrand: 'Ăn Vặt' });
    assert.equal(brand.passed, true, 'a missing brand is a warning, not a failure');
    assert.equal(brand.findings.find((f) => f.ruleId === 'package-brand-missing')?.severity, 'warning');
  });

  it('flags a missing asset but resolves compiled stylesheet names to their source', async () => {
    const zip = writeZip(themeEntries((e) => e.filter((x) => x.name !== 'assets/theme.js')));
    const res = await runPackageCheck({ workspaceRoot: scratch, zipPath: zip });
    assert.equal(res.passed, false);
    const missing = res.findings.filter((f) => f.ruleId === 'package-asset-missing');
    assert.deepStrictEqual(missing.map((f) => f.measured?.asset), ['theme.js']);
  });

  it('fails an unparsable settings_schema.json and warns about leftover markers', async () => {
    const broken = writeZip(themeEntries((e) => replaceEntry(e, 'config/settings_schema.json', '[ { "name": ')));
    const res = await runPackageCheck({ workspaceRoot: scratch, zipPath: broken });
    assert.equal(res.passed, false);
    assert.ok(ids(res.findings).includes('package-schema-invalid'));

    const residue = writeZip(themeEntries((e) => replaceEntry(e, 'snippets/header.liquid', '<header>TODO replace logo</header>\n')));
    const warned = await runPackageCheck({ workspaceRoot: scratch, zipPath: residue });
    assert.equal(warned.passed, true);
    assert.equal(warned.findings.find((f) => f.ruleId === 'package-residue')?.severity, 'warning');
  });

  it('reads stored (uncompressed) entries', async () => {
    const zip = writeZip(themeEntries((e) => e.map((x) => ({ ...x, stored: true }))));
    const res = await runPackageCheck({ workspaceRoot: scratch, zipPath: zip, expectedBrand: 'Sky Fashion' });
    assert.deepStrictEqual(res.findings, []);
  });

  it('reports a file that is not a zip as unreadable', async () => {
    const file = path.join(scratch, 'not-a-zip.zip');
    fs.writeFileSync(file, 'this is plain text, definitely longer than twenty-two bytes');
    const res = await runPackageCheck({ workspaceRoot: scratch, zipPath: file });
    assert.equal(res.passed, false);
    assert.deepStrictEqual(ids(res.findings), ['package-zip-unreadable']);
    assert.equal(res.zipEntries, undefined);
  });
});

describe('package check: theme directory', () => {
  it('checks a theme directory without a zip', async () => {
    const res = await runPackageCheck({ workspaceRoot: THEME, expectedBrand: 'Sky Fashion' });
    assert.deepStrictEqual(res.findings, []);
    assert.equal(res.passed, true);
    assert.equal(res.zipEntries, undefined);
  });

  it('flags secret files and missing roots in directory mode', async () => {
    const copy = path.join(scratch, 'theme-copy');
    fs.cpSync(THEME, copy, { recursive: true });
    fs.writeFileSync(path.join(copy, '.env'), 'TOKEN=1\n');
    const withEnv = await runPackageCheck({ workspaceRoot: copy });
    assert.ok(ids(withEnv.findings).includes('package-secret-file'));

    const missing = await runPackageCheck({ workspaceRoot: path.join(scratch, 'does-not-exist') });
    assert.equal(missing.passed, false);
    assert.deepStrictEqual(ids(missing.findings), ['package-root-missing']);
  });
});

describe('package check: submission form diff', () => {
  const base = { workspaceRoot: THEME };

  it('flags a price that moved from 0 to 2400000', async () => {
    const res = await runPackageCheck({ ...base, formBefore: { 'Giá bán': '0' }, formAfter: { 'Giá bán': '2400000' } });
    assert.equal(res.passed, false);
    const finding = res.findings.find((f) => f.ruleId === 'package-form-price-changed');
    assert.ok(finding, JSON.stringify(res.findings));
    assert.equal(finding.measured?.before, '0');
    assert.equal(finding.measured?.after, '2400000');
  });

  it('ignores a price that only changed formatting', async () => {
    const res = await runPackageCheck({ ...base, formBefore: { price: '2400000' }, formAfter: { price: '2.400.000 đ' } });
    assert.deepStrictEqual(res.findings, []);
  });

  it('warns about Vietnamese notes written without diacritics', async () => {
    const bare = await runPackageCheck({ ...base, formAfter: { Notes: 'Cap nhat giao dien va sua loi gio hang' } });
    assert.equal(bare.passed, true, 'notes are a warning');
    assert.equal(bare.findings.find((f) => f.ruleId === 'package-notes-no-diacritics')?.severity, 'warning');

    const accented = await runPackageCheck({ ...base, formAfter: { Notes: 'Cập nhật giao diện và sửa lỗi giỏ hàng' } });
    assert.deepStrictEqual(accented.findings, []);

    const english = await runPackageCheck({ ...base, formAfter: { Notes: 'Fixed the cart drawer and updated the header layout' } });
    assert.deepStrictEqual(english.findings, []);
  });
});
