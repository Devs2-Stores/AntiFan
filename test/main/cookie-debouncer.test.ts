import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CookieDebouncer,
  DeltaSyncBatch,
  ExtensionCookie,
} from '../../src/extension/cookie-debouncer';

test('CookieDebouncer: coalesces multiple rapid updates into a single atomic flush', async () => {
  const batches: DeltaSyncBatch[] = [];
  const debouncer = new CookieDebouncer((batch) => {
    batches.push(batch);
  }, 100, 500);

  // Add 10 rapid events for 2 distinct cookies
  for (let i = 0; i < 5; i++) {
    debouncer.addChange({
      cookie: {
        name: 'session_id',
        value: `val_${i}`,
        domain: '.haravan.com',
        path: '/',
        secure: true,
        httpOnly: true,
      },
      removed: false,
    });

    debouncer.addChange({
      cookie: {
        name: 'user_cart',
        value: `cart_${i}`,
        domain: '.haravan.com',
        path: '/',
        secure: false,
        httpOnly: false,
      },
      removed: false,
    });
  }

  assert.equal(debouncer.pendingCount, 2);

  // Wait for debounced flush (150ms > 100ms delay)
  await new Promise((resolve) => setTimeout(resolve, 150));

  assert.equal(batches.length, 1);
  const batch = batches[0];
  assert.ok(batch);
  assert.equal(batch.upserted.length, 2);
  assert.equal(batch.removed.length, 0);
  // Verifies that only latest value is retained
  const sessionCookie = batch.upserted.find((c) => c.name === 'session_id');
  assert.equal(sessionCookie?.value, 'val_4');
  const cartCookie = batch.upserted.find((c) => c.name === 'user_cart');
  assert.equal(cartCookie?.value, 'cart_4');
});

test('CookieDebouncer: correctly tracks cookie removals', async () => {
  const batches: DeltaSyncBatch[] = [];
  const debouncer = new CookieDebouncer((batch) => {
    batches.push(batch);
  }, 100, 500);

  debouncer.addChange({
    cookie: {
      name: 'auth_token',
      value: 'secret',
      domain: '.google.com',
      path: '/',
      secure: true,
      httpOnly: true,
    },
    removed: true,
  });

  await new Promise((resolve) => setTimeout(resolve, 150));

  assert.equal(batches.length, 1);
  const batch = batches[0];
  assert.ok(batch);
  assert.equal(batch.upserted.length, 0);
  assert.equal(batch.removed.length, 1);
  assert.ok(batch.removed[0]);
  assert.equal(batch.removed[0].name, 'auth_token');
  assert.equal(batch.removed[0].domain, '.google.com');
});
test('CookieDebouncer: drops expired cookies on arrival', async () => {
  const batches: DeltaSyncBatch[] = [];
  const debouncer = new CookieDebouncer((batch) => {
    batches.push(batch);
  }, 100, 500);

  const pastTimestampSec = Math.floor(Date.now() / 1000) - 3600; // 1 hour ago

  debouncer.addChange({
    cookie: {
      name: 'expired_cookie',
      value: 'old_value',
      domain: '.google.com',
      path: '/',
      secure: true,
      httpOnly: true,
      expirationDate: pastTimestampSec,
    },
    removed: false,
  });

  assert.equal(debouncer.pendingCount, 0);
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(batches.length, 0);
});

test('CookieDebouncer: flushes automatically when continuous stream exceeds maxWaitMs', async () => {
  const batches: DeltaSyncBatch[] = [];

  // delayMs: 80ms, maxWaitMs: 200ms
  const debouncer = new CookieDebouncer((batch) => {
    batches.push(batch);
  }, 80, 200);

  let iteration = 0;
  let interval: NodeJS.Timeout | null = null;

  try {
    // Stream events every 40ms (< 80ms delayMs) to prevent inactivity timeout
    interval = setInterval(() => {
      debouncer.addChange({
        cookie: {
          name: 'streaming_cookie',
          value: `val_${iteration++}`,
          domain: '.example.com',
          path: '/',
          secure: true,
          httpOnly: false,
        },
        removed: false,
      });
    }, 40);

    // Wait 320ms (> 200ms maxWaitMs) while events keep streaming
    await new Promise((resolve) => setTimeout(resolve, 320));
    const flushedBeforeCleanup = batches.length > 0;
    assert.strictEqual(flushedBeforeCleanup, true, 'Debouncer must flush autonomously on maxWaitMs ceiling during streaming');
  } finally {
    clearInterval(interval!);
    debouncer.flush();
  }

  assert.ok(batches.length >= 1, 'Debouncer must have flushed at least one batch');
  assert.ok(batches[0]?.upserted.some((c) => c.name === 'streaming_cookie'));
});
