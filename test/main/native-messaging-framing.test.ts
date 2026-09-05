import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { NativeMessageDecoder, encodeNativeMessage, MAX_INBOUND_NATIVE_MESSAGE_SIZE, MAX_OUTBOUND_NATIVE_MESSAGE_SIZE } from '../../src/main/native-messaging/framing';

test('NativeMessageDecoder: parses single complete frame with LE uint32 length prefix', async () => {
  const decoder = new NativeMessageDecoder();
  const messages: any[] = [];
  decoder.on('data', (msg) => messages.push(msg));

  const payload = { action: 'PING', timestamp: 123456789 };
  const encoded = encodeNativeMessage(payload);

  decoder.write(encoded);
  decoder.end();

  await once(decoder, 'end');
  assert.equal(messages.length, 1);
  assert.deepEqual(messages[0], payload);
});

test('NativeMessageDecoder: reassembles fragmented chunks across byte boundaries', async () => {
  const decoder = new NativeMessageDecoder();
  const messages: any[] = [];
  decoder.on('data', (msg) => messages.push(msg));

  const payload = { action: 'HANDSHAKE', clientVersion: '1.0.0', data: 'a'.repeat(500) };
  const encoded = encodeNativeMessage(payload);

  // Write in 7-byte chunks to simulate network/pipe stream fragmentation
  const chunkSize = 7;
  for (let i = 0; i < encoded.length; i += chunkSize) {
    decoder.write(encoded.subarray(i, Math.min(i + chunkSize, encoded.length)));
  }
  decoder.end();

  await once(decoder, 'end');
  assert.equal(messages.length, 1);
  assert.deepEqual(messages[0], payload);
});

test('NativeMessageDecoder: unpacks multiple concatenated messages in single incoming buffer', async () => {
  const decoder = new NativeMessageDecoder();
  const messages: any[] = [];
  decoder.on('data', (msg) => messages.push(msg));

  const payload1 = { id: 1, text: 'hello' };
  const payload2 = { id: 2, text: 'world' };
  const payload3 = { id: 3, text: 'antifan' };

  const combined = Buffer.concat([
    encodeNativeMessage(payload1),
    encodeNativeMessage(payload2),
    encodeNativeMessage(payload3),
  ]);

  decoder.write(combined);
  decoder.end();

  await once(decoder, 'end');
  assert.equal(messages.length, 3);
  assert.deepEqual(messages[0], payload1);
  assert.deepEqual(messages[1], payload2);
  assert.deepEqual(messages[2], payload3);
});

test('NativeMessageDecoder: rejects message exceeding 64MB inbound limit', async () => {
  const decoder = new NativeMessageDecoder();
  const errorPromise = once(decoder, 'error');

  const fakeHeader = Buffer.alloc(4);
  fakeHeader.writeUInt32LE(MAX_INBOUND_NATIVE_MESSAGE_SIZE + 1024, 0);
  decoder.write(fakeHeader);

  const [err] = await errorPromise;
  assert.match((err as Error).message, /64MB limit/i);
});

test('encodeNativeMessage: throws when outbound payload exceeds Chromium 1MB limit', () => {
  const hugePayload = { bigData: 'x'.repeat(MAX_OUTBOUND_NATIVE_MESSAGE_SIZE + 100) };
  assert.throws(
    () => encodeNativeMessage(hugePayload),
    /Chromium 1MB limit/i
  );
});

test('NativeMessageDecoder: rejects malformed JSON cleanly', async () => {
  const decoder = new NativeMessageDecoder();
  const errorPromise = once(decoder, 'error');

  const badJson = Buffer.from('{"unclosed_json', 'utf8');
  const header = Buffer.alloc(4);
  header.writeUInt32LE(badJson.length, 0);
  decoder.write(Buffer.concat([header, badJson]));

  const [err] = await errorPromise;
  assert.match((err as Error).message, /Invalid JSON payload/i);
});
