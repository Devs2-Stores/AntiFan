/**
 * Congestion FIFO frame integrity.
 *
 * The defect this guards: a congested WebSocket client was drained by re-serializing
 * (`JSON.stringify`) and re-joining (`dataParts.join('')`) queued payloads on every pump
 * tick. Under a 20 MB/s terminal stream that produced tens of MB/s of transient V8 string
 * churn in the Electron main process, and any byte-level ring buffer attempt would have
 * sliced across frame boundaries and UTF-8 code points, corrupting downstream parsers.
 *
 * Every case below asserts the frame-granular contract that replaced it: a frame is
 * serialized exactly once at enqueue, queue entries are whole immutable Buffers, coalesced
 * terminal frames seal at a bounded size, and a queue over the hard cap drops whole oldest
 * frames while accounting for every dropped byte.
 */
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';

import {
  BRIDGE_COALESCE_MAX_BYTES,
  BRIDGE_COALESCE_MAX_PARTS,
  BRIDGE_QUEUE_HARD_CAP,
  BRIDGE_SOFT_HIGH_WATER,
  BridgeServer,
} from '../../.compiled/src/main/bridge/bridge-server.js';

// One ephemeral-port instance serves every case: congestion state is keyed per socket, so
// the shared instance never couples the cases, and the real TerminalManager singleton is
// subscribed exactly once instead of once per case.
const server = new BridgeServer({ on() {} }, 0, false);
after(() => server.dispose());

/** A fake client whose kernel backlog is already past the soft high-water mark. */
function makeClient(bufferedAmount = BRIDGE_SOFT_HIGH_WATER) {
  return {
    readyState: WebSocket.OPEN,
    bufferedAmount,
    sent: [],
    terminated: false,
    send(payload) {
      this.sent.push(payload);
    },
    terminate() {
      this.terminated = true;
    },
    close() {},
    ping() {},
  };
}

function queued(state) {
  return state.queue.slice(state.head);
}

function sendTerminal(client, sessionId, chunk, seq) {
  server.sendEventFrame(client, 'antifan:terminal:data', { sessionId, data: chunk, seq }, sessionId);
}

function parseFrame(buffer) {
  assert.ok(Buffer.isBuffer(buffer), 'every drained frame must be a pre-built Buffer');
  return JSON.parse(buffer.toString('utf8'));
}

test('a queued non-terminal frame drains as the exact bytes serialized at enqueue', () => {
  const client = makeClient();
  const payload = { url: 'https://example.test/a?q=1', hops: 3, nested: { ok: true } };
  const expected = JSON.stringify({ event: 'antifan:tab:updated', data: payload });

  server.sendEventFrame(client, 'antifan:tab:updated', payload);

  const state = server.getCongestionState(client);
  const pending = queued(state);
  assert.equal(pending.length, 1, 'a congested client queues instead of writing to the socket');
  assert.equal(client.sent.length, 0, 'nothing is written while the backlog is over the soft high-water mark');
  assert.ok(Buffer.isBuffer(pending[0].frame), 'the frame is serialized once, at enqueue');
  assert.equal(pending[0].frame.toString('utf8'), expected);
  assert.equal(pending[0].bytes, Buffer.byteLength(expected, 'utf8'));
  assert.equal(state.queuedBytes, pending[0].bytes);

  client.bufferedAmount = 0;
  server.flushCongestedClient(client);

  assert.equal(client.sent.length, 1);
  assert.ok(Buffer.isBuffer(client.sent[0]), 'drain writes the pre-built Buffer, never a re-serialized string');
  assert.equal(client.sent[0].toString('utf8'), expected);
  assert.equal(server.getCongestionState(client).queuedBytes, 0);
});

test('the drain pump holds frames while the socket backlog is over the soft high-water mark', () => {
  const client = makeClient();
  server.sendEventFrame(client, 'antifan:tab:updated', { n: 1 });
  server.sendEventFrame(client, 'antifan:tab:updated', { n: 2 });

  const state = server.getCongestionState(client);
  const queuedBytes = state.queuedBytes;
  assert.equal(queued(state).length, 2);

  server.flushCongestedClient(client);
  assert.equal(client.sent.length, 0, 'no drain while bufferedAmount is still over the gate');
  assert.equal(state.queuedBytes, queuedBytes);

  client.bufferedAmount = 0;
  server.flushCongestedClient(client);

  assert.equal(client.sent.length, 2);
  assert.deepEqual(parseFrame(client.sent[0]).data, { n: 1 });
  assert.deepEqual(parseFrame(client.sent[1]).data, { n: 2 });
  assert.equal(state.queuedBytes, 0);
});

test('consecutive terminal frames for one session coalesce into one ordered frame', () => {
  const client = makeClient();
  sendTerminal(client, 'coalesce-pty', 'chunk-1', 1);
  sendTerminal(client, 'coalesce-pty', 'chunk-2', 2);
  sendTerminal(client, 'coalesce-pty', 'chunk-3', 3);

  const state = server.getCongestionState(client);
  const pending = queued(state);
  assert.equal(pending.length, 1, 'the same session must coalesce into exactly one queued frame');
  assert.equal(client.sent.length, 0);

  client.bufferedAmount = 0;
  server.flushCongestedClient(client);

  assert.equal(client.sent.length, 1, 'coalescing must survive the drain, not expand back into three frames');
  const body = parseFrame(client.sent[0]);
  assert.equal(body.event, 'antifan:terminal:data');
  assert.equal(body.data.sessionId, 'coalesce-pty');
  assert.equal(body.data.data, 'chunk-1chunk-2chunk-3', 'concatenation order defines the merged payload');
  assert.equal(body.data.seq, 3, 'the merged frame reports the highest sequence number');
});

test('a coalesced frame seals at the part limit and later chunks start a new frame', () => {
  const client = makeClient();
  const chunks = [];
  for (let i = 0; i < BRIDGE_COALESCE_MAX_PARTS; i += 1) {
    const chunk = `part-${i}|`;
    chunks.push(chunk);
    sendTerminal(client, 'seal-pty', chunk, i);
  }

  const state = server.getCongestionState(client);
  let pending = queued(state);
  assert.equal(pending.length, 1, 'chunks up to the part limit stay in one frame');
  assert.equal(pending[0].sealed, true, 'the frame must seal once the part limit is reached');
  assert.equal(pending[0].frame.byteLength, pending[0].bytes);
  assert.equal(state.queuedBytes, pending[0].frame.byteLength, 'queued bytes stay exact after sealing');

  sendTerminal(client, 'seal-pty', 'overflow|', BRIDGE_COALESCE_MAX_PARTS + 1);
  pending = queued(state);
  assert.equal(pending.length, 2, 'a sealed frame is immutable: the next chunk starts a new frame');

  client.bufferedAmount = 0;
  server.flushCongestedClient(client);

  assert.equal(client.sent.length, 2);
  const first = parseFrame(client.sent[0]);
  const second = parseFrame(client.sent[1]);
  assert.equal(first.data.data, chunks.join(''), 'the sealed frame kept every chunk it sealed with');
  assert.equal(second.data.data, 'overflow|');
  assert.equal(
    first.data.data + second.data.data,
    `${chunks.join('')}overflow|`,
    'no byte may be lost or duplicated across the seal boundary'
  );
});

test('a chunk past the byte cap seals the frame instead of growing it unbounded', () => {
  const client = makeClient();
  const big = 'x'.repeat(BRIDGE_COALESCE_MAX_BYTES + 1);
  sendTerminal(client, 'bytes-pty', big, 1);

  const state = server.getCongestionState(client);
  let pending = queued(state);
  assert.equal(pending.length, 1);
  assert.equal(pending[0].sealed, true, 'a single chunk past the byte cap seals immediately');

  const sealedFrame = pending[0].frame;
  sendTerminal(client, 'bytes-pty', 'tail', 2);
  pending = queued(state);
  assert.equal(pending.length, 2, 'the sealed frame must not absorb the next chunk');
  assert.equal(pending[0].frame, sealedFrame, 'the sealed frame keeps the very same Buffer');

  client.bufferedAmount = 0;
  server.flushCongestedClient(client);

  assert.equal(client.sent.length, 2);
  const expectedFrameBytes = Buffer.byteLength(
    JSON.stringify({ event: 'antifan:terminal:data', data: { sessionId: 'bytes-pty', data: big, seq: 1 } }),
    'utf8'
  );
  assert.equal(client.sent[0].byteLength, expectedFrameBytes, 'the oversized frame carries the whole chunk, unclipped');
  assert.equal(parseFrame(client.sent[0]).data.data, big);
  assert.equal(parseFrame(client.sent[1]).data.data, 'tail');
});

test('a queue over the hard cap drops whole oldest frames and accounts for every dropped byte', () => {
  const client = makeClient();
  const blobSize = Math.ceil(BRIDGE_QUEUE_HARD_CAP / 3) + 4096; // three frames overflow the cap
  const blobs = [0, 1, 2].map((i) => `frame-${i}:${'y'.repeat(blobSize)}`);
  const frameBytes = blobs.map((blob) => Buffer.byteLength(JSON.stringify({ event: 'antifan:tab:updated', data: { blob } }), 'utf8'));

  for (const blob of blobs) server.sendEventFrame(client, 'antifan:tab:updated', { blob });

  const state = server.getCongestionState(client);
  const pending = queued(state);
  assert.equal(state.droppedFrames, 1, 'exactly the oldest frame is dropped to get back under the cap');
  assert.equal(state.droppedBytes, frameBytes[0], 'dropped bytes are the whole dropped frame');
  assert.equal(state.queuedBytes, frameBytes[1] + frameBytes[2]);
  assert.equal(client.terminated, false, 'a client that recovers under the cap is not terminated');

  assert.equal(pending.length, 2);
  pending.forEach((frame, index) => {
    assert.equal(frame.frame.byteLength, frameBytes[index + 1], 'a surviving frame keeps its original byte length');
    const parsed = parseFrame(frame.frame);
    assert.equal(parsed.data.blob, blobs[index + 1], 'surviving frames are complete and unmodified');
  });

  client.bufferedAmount = 0;
  server.flushCongestedClient(client);

  assert.equal(client.sent.length, 2);
  client.sent.forEach((buffer, index) => {
    assert.equal(buffer.byteLength, frameBytes[index + 1], 'no drained frame is sliced: sizes match the originals');
    assert.equal(parseFrame(buffer).data.blob, blobs[index + 1]);
  });
});
