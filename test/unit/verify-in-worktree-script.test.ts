/**
 * scripts/verify-in-worktree.ps1 links the real node_modules into a throwaway worktree with a
 * junction. A recursive delete (or `git worktree remove --force`) of a worktree that still holds
 * that junction follows it and empties the real node_modules, so the cleanup order is the
 * contract: remove the link itself first, prove it is gone, and refuse to remove the worktree
 * while any link is left.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const root = fs.existsSync(path.join(process.cwd(), 'src')) ? process.cwd() : path.resolve(__dirname, '..', '..');
const scriptPath = path.join(root, 'scripts', 'verify-in-worktree.ps1');
const scriptSource = fs.readFileSync(scriptPath, 'utf8');
// Comments name the same commands the code runs; the order assertions must read code only.
const script = scriptSource.replace(/<#[\s\S]*?#>/, '').replace(/^\s*#.*$/gm, '');

describe('verify-in-worktree.ps1 source contract', () => {
  it('removes the junction before it ever reaches git worktree remove', () => {
    const removeLink = script.indexOf('rmdir "$link"');
    const confirm = script.indexOf('dir /AL');
    const refuse = script.indexOf('JUNCTION_REMAINS');
    const remove = script.indexOf('worktree remove --force');
    assert.ok(removeLink > 0, 'the link is removed with cmd rmdir, which deletes the link only');
    assert.ok(confirm > 0, 'the removal is confirmed with dir /AL');
    assert.ok(refuse > 0, 'a remaining junction is refused by name');
    assert.ok(remove > 0, 'the worktree is still removed once no link is left');
    assert.ok(removeLink < remove && confirm < remove && refuse < remove, 'link removal, check and refusal all precede the worktree removal');
    assert.equal(script.match(/worktree remove/g)?.length, 1, 'there is exactly one place that removes a worktree');
  });

  it('runs only the three verification commands and never the full compile', () => {
    assert.match(script, /node_modules\\typescript\\bin\\tsc/);
    assert.match(script, /scripts\\copy-static\.mjs/);
    assert.match(script, /scripts\\check-renderer-assets\.mjs/);
    assert.doesNotMatch(script, /&\s*npm\b/, 'npm run compile also stages the live daemon host');
    assert.doesNotMatch(script, /stage-daemon-host/);
  });

  it('copies the gitignored site-clone dist as real files before tsc, never as a junction', () => {
    const copy = script.indexOf('Copy-Item -LiteralPath $realDist');
    const junction = script.indexOf('New-Item -ItemType Junction');
    const tsc = script.indexOf("'node_modules\\typescript\\bin\\tsc'");
    assert.match(script, /packages\\site-clone\\dist/);
    assert.match(script, /Copy-Item[^\n]*-Recurse/);
    assert.ok(copy > 0 && junction > 0 && tsc > 0, 'copy, node_modules junction and tsc step all exist');
    assert.ok(copy < tsc, 'the dist is in place before tsc runs');
    assert.equal(script.match(/New-Item -ItemType Junction/g)?.length, 1, 'node_modules is the only junction the script creates');
    assert.match(script, /-not \(Test-Path -LiteralPath \$wtDist\)/, 'a dist the ref already carries is not overwritten');
  });

  it('refuses a worktree path inside the repository', () => {
    assert.match(script, /WORKTREE_INSIDE_REPO/);
  });
});

function runScript(args: string[]): { status: number | null; output: string; unavailable: boolean } {
  const result = spawnSync(
    'powershell',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath, ...args],
    { encoding: 'utf8', windowsHide: true, timeout: 120_000 }
  );
  return {
    status: result.status,
    output: `${result.stdout ?? ''}${result.stderr ?? ''}`,
    unavailable: result.error !== undefined && (result.error as NodeJS.ErrnoException).code === 'ENOENT',
  };
}

function git(cwd: string, ...args: string[]): void {
  const result = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, `git ${args.join(' ')} failed: ${result.stderr}`);
}

describe('verify-in-worktree.ps1 cleanup on a real worktree', { skip: process.platform !== 'win32' }, () => {
  function fixture() {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-wt-'));
    const repo = path.join(tmp, 'repo');
    fs.mkdirSync(repo);
    git(repo, 'init', '-q');
    git(repo, 'commit', '-q', '--allow-empty', '-m', 'seed');
    const worktree = path.join(tmp, 'wt');
    git(repo, 'worktree', 'add', '-q', '--detach', worktree, 'HEAD');
    const realModules = path.join(tmp, 'real-modules');
    fs.mkdirSync(realModules);
    const sentinel = path.join(realModules, 'sentinel.txt');
    fs.writeFileSync(sentinel, 'keep me');
    fs.symlinkSync(realModules, path.join(worktree, 'node_modules'), 'junction');
    return { tmp, repo, worktree, realModules, sentinel };
  }

  it('removes the link, leaves the real folder intact, then removes the worktree', (t) => {
    const f = fixture();
    t.after(() => fs.rmSync(f.tmp, { recursive: true, force: true }));
    const run = runScript(['-Repo', f.repo, '-Path', f.worktree, '-Cleanup']);
    if (run.unavailable) return t.skip('powershell is not available');
    assert.equal(run.status, 0, run.output);
    assert.equal(fs.existsSync(f.worktree), false, 'the worktree is gone');
    assert.equal(fs.readFileSync(f.sentinel, 'utf8'), 'keep me', 'the junction target was not followed and emptied');
  });

  it('refuses to remove the worktree while another junction is left in it', (t) => {
    const f = fixture();
    t.after(() => fs.rmSync(f.tmp, { recursive: true, force: true }));
    const otherTarget = path.join(f.tmp, 'other-target');
    fs.mkdirSync(otherTarget);
    fs.writeFileSync(path.join(otherTarget, 'other.txt'), 'keep me too');
    fs.mkdirSync(path.join(f.worktree, 'packages'));
    const nested = path.join(f.worktree, 'packages', 'linked');
    fs.symlinkSync(otherTarget, nested, 'junction');

    const refused = runScript(['-Repo', f.repo, '-Path', f.worktree, '-Cleanup']);
    if (refused.unavailable) return t.skip('powershell is not available');
    assert.equal(refused.status, 2, refused.output);
    assert.match(refused.output, /JUNCTION_REMAINS/);
    assert.equal(fs.existsSync(f.worktree), true, 'the worktree stays while a link is in it');
    assert.equal(fs.existsSync(path.join(otherTarget, 'other.txt')), true);
    assert.equal(fs.readFileSync(f.sentinel, 'utf8'), 'keep me', 'the first junction was already removed as a link');

    fs.rmdirSync(nested);
    const cleaned = runScript(['-Repo', f.repo, '-Path', f.worktree, '-Cleanup']);
    assert.equal(cleaned.status, 0, cleaned.output);
    assert.equal(fs.existsSync(f.worktree), false);
    assert.equal(fs.existsSync(path.join(otherTarget, 'other.txt')), true);
  });
});
