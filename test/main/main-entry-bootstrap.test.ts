import assert from 'node:assert';
import { describe, it } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';

describe('AntiFan Electron Main Entry & Bootstrap Guard', () => {
  const rootDir = process.cwd();
  const packageJsonPath = path.resolve(rootDir, 'package.json');
  const mainCjsPath = path.resolve(rootDir, 'main.cjs');
  const runElectronPath = path.resolve(rootDir, 'scripts', 'run-electron.cjs');

  it('package.json specifies main pointing to ./main.cjs', () => {
    assert.ok(fs.existsSync(packageJsonPath), 'package.json must exist');
    const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
    assert.strictEqual(pkg.main, './main.cjs', 'package.json main must point to ./main.cjs');
  });

  it('main.cjs exists and contains fallback compilation logic', () => {
    assert.ok(fs.existsSync(mainCjsPath), 'main.cjs must exist in repository root');
    const content = fs.readFileSync(mainCjsPath, 'utf8');
    assert.ok(content.includes('compiledMain'), 'main.cjs must resolve compiledMain');
    assert.ok(content.includes('.compiled'), 'main.cjs must reference .compiled directory');
    assert.ok(content.includes('npm run compile'), 'main.cjs must invoke auto-compile if missing');
    assert.ok(content.includes('require(compiledMain)'), 'main.cjs must require compiledMain');
  });

  it('scripts/run-electron.cjs has auto-compilation guard for root launch', () => {
    assert.ok(fs.existsSync(runElectronPath), 'scripts/run-electron.cjs must exist');
    const content = fs.readFileSync(runElectronPath, 'utf8');
    assert.ok(content.includes('npm run compile'), 'run-electron.cjs must contain auto-compile guard');
    assert.ok(content.includes('compiledMain'), 'run-electron.cjs must verify compiledMain existence');
  });

  it('compiled main target .compiled/src/main/index.js is present', () => {
    const targetPath = path.resolve(rootDir, '.compiled', 'src', 'main', 'index.js');
    assert.ok(fs.existsSync(targetPath), '.compiled/src/main/index.js must exist after build');
  });
});
