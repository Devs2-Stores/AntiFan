import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ProfileOwnership, ProfileOwnershipError } from '../../src/main/browser/profile-ownership';

describe('ProfileOwnership', () => {
  it('allows one owner and rejects a live second owner', () => {
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-profile-'));
    const first = new ProfileOwnership({ pid: process.pid, hostname: 'test-host', now: () => 100 }).acquire(profile);
    assert.throws(() => new ProfileOwnership({ pid: process.pid + 1, hostname: 'test-host', now: () => 110 }).acquire(profile), (error: unknown) => error instanceof ProfileOwnershipError && error.code === 'PROFILE_LOCKED');
    first.markCleanShutdown();
    first.release();
  });

  it('recovers a stale lease and detects an unclean prior shutdown', () => {
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-profile-'));
    fs.writeFileSync(path.join(profile, 'antifan-profile.lock'), JSON.stringify({ pid: 999999, host: 'test-host', startedAt: 1, profilePath: profile }));
    fs.writeFileSync(path.join(profile, 'antifan-recovery.json'), JSON.stringify({ cleanShutdown: false, startedAt: 1, safeStartRecommended: true }));
    const lease = new ProfileOwnership({ pid: 41003, hostname: 'test-host', now: () => 200 }).acquire(profile);
    assert.equal(lease.recovery.safeStartRecommended, true);
    assert.equal(JSON.parse(fs.readFileSync(path.join(profile, 'antifan-recovery.json'), 'utf8')).cleanShutdown, false);
    lease.markCleanShutdown();
    lease.release();
    assert.equal(JSON.parse(fs.readFileSync(path.join(profile, 'antifan-recovery.json'), 'utf8')).cleanShutdown, true);
  });
});
