import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { validateAuthorizedWorkspaceRoot } from '../../src/main/browser/workspace-resolver';
import { CapabilityError } from '../../src/shared/control-plane-contracts';

describe('validateAuthorizedWorkspaceRoot refusal details', () => {
  it('names the authorized roots, the failed check and a recovery when the root is outside them', () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-ws-resolver-'));
    try {
      const authorized = path.join(base, 'authorized');
      const outside = path.join(base, 'outside');
      fs.mkdirSync(authorized);
      fs.mkdirSync(outside);

      let thrown: unknown;
      try {
        validateAuthorizedWorkspaceRoot(outside, [authorized]);
      } catch (err) {
        thrown = err;
      }

      assert.ok(thrown instanceof CapabilityError);
      assert.strictEqual(thrown.code, 'OUTSIDE_WORKSPACE');
      assert.ok(thrown.message.includes(authorized), 'the message lists the authorized roots');
      assert.deepStrictEqual(thrown.details?.authorizedRoots, [authorized]);
      assert.strictEqual(thrown.details?.failedCheck, 'workspaceRoot');
      assert.strictEqual(thrown.details?.workspaceRoot, outside);
      assert.strictEqual(typeof thrown.details?.recovery, 'string');
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  it('names the file being acted on when the caller supplies one, and omits the field otherwise', () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-ws-resolver-'));
    try {
      const authorized = path.join(base, 'authorized');
      const outside = path.join(base, 'outside');
      fs.mkdirSync(authorized);
      fs.mkdirSync(outside);
      const refusal = (subject?: { filePath?: string }): CapabilityError => {
        try {
          validateAuthorizedWorkspaceRoot(outside, [authorized], subject);
        } catch (err) {
          assert.ok(err instanceof CapabilityError);
          return err;
        }
        throw new Error('expected an OUTSIDE_WORKSPACE refusal');
      };

      assert.strictEqual(refusal({ filePath: 'C:/uploads/theme.zip' }).details?.filePath, 'C:/uploads/theme.zip');
      assert.strictEqual(refusal().details?.filePath, undefined);
      assert.strictEqual('filePath' in (refusal({ filePath: '' }).details ?? {}), false, 'an empty file path is not a detail');
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  it('accepts a root inside an authorized root', () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-ws-resolver-'));
    try {
      const authorized = path.join(base, 'authorized');
      const project = path.join(authorized, 'shop');
      fs.mkdirSync(project, { recursive: true });

      const resolved = validateAuthorizedWorkspaceRoot(project, [authorized]);

      assert.strictEqual(path.normalize(resolved).toLowerCase(), path.normalize(fs.realpathSync(project)).toLowerCase());
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });
});
