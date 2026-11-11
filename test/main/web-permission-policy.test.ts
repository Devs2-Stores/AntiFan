import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { installWebPermissionPolicy, shouldDenyPermission } from '../../src/main/browser/web-permission-policy';

const ALWAYS_ALLOWED = [
  'media', 'display-capture', 'clipboard-read', 'clipboard-sanitized-write', 'notifications', 'openExternal',
  'fullscreen', 'pointerLock', 'geolocation', 'storage-access', 'top-level-storage-access', 'mediaKeySystem',
  'keyboardLock', 'speaker-selection',
];

describe('web permission policy', () => {
  it('denies exactly the hardware and window-management permissions and allows media, clipboard, notifications, fullscreen, pointerLock, geolocation and storage-access', () => {
    for (const permission of ['serial', 'hid', 'usb', 'midi', 'midiSysex', 'idle-detection', 'fileSystem']) {
      assert.equal(shouldDenyPermission('check', permission), true, `check ${permission}`);
    }
    for (const permission of ['midi', 'midiSysex', 'idle-detection', 'fileSystem', 'window-management']) {
      assert.equal(shouldDenyPermission('request', permission), true, `request ${permission}`);
    }
    for (const handler of ['check', 'request'] as const) {
      for (const permission of ALWAYS_ALLOWED) {
        assert.equal(shouldDenyPermission(handler, permission), false, `${handler} ${permission}`);
      }
    }
    assert.equal(shouldDenyPermission('check', 'toString'), false, 'prototype names are not permissions');
  });

  it('a denial is journaled once per origin', () => {
    let request: ((wc: unknown, p: string, cb: (ok: boolean) => void, d: unknown) => void) | undefined;
    let check: ((wc: unknown, p: string, origin: string, d: unknown) => boolean) | undefined;
    const sess = {
      setPermissionRequestHandler: (h: typeof request) => { request = h; },
      setPermissionCheckHandler: (h: typeof check) => { check = h; },
    };
    const rows: unknown[] = [];
    installWebPermissionPolicy(sess as never, 'persist:x', (row) => rows.push(row));

    const answers: boolean[] = [];
    request!(null, 'midi', (ok) => answers.push(ok), { requestingUrl: 'https://a.example/path?token=1' });
    request!(null, 'midi', (ok) => answers.push(ok), { requestingUrl: 'https://a.example/other' });
    request!(null, 'midi', (ok) => answers.push(ok), { requestingUrl: 'https://b.example/' });
    request!(null, 'media', (ok) => answers.push(ok), { requestingUrl: 'https://a.example/' });
    assert.deepEqual(answers, [false, false, false, true]);
    assert.deepEqual(rows, [
      { partition: 'persist:x', handler: 'request', permission: 'midi', origin: 'https://a.example' },
      { partition: 'persist:x', handler: 'request', permission: 'midi', origin: 'https://b.example' },
    ]);

    assert.equal(check!(null, 'usb', 'https://a.example', {}), false);
    assert.equal(check!(null, 'usb', 'https://a.example', {}), false);
    assert.equal(check!(null, 'media', 'https://a.example', {}), true);
    assert.equal(rows.length, 3, 'the polled check handler journals a repeat once');
  });
});
