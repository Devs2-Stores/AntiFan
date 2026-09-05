import { Transform, TransformCallback } from 'stream';

/** Maximum inbound payload size from Chrome (Chromium limit: 64 MiB) */
export const MAX_INBOUND_NATIVE_MESSAGE_SIZE = 64 * 1024 * 1024; // 64 MB
/** Maximum outbound payload size to Chrome (Chromium limit: 1 MiB) */
export const MAX_OUTBOUND_NATIVE_MESSAGE_SIZE = 1 * 1024 * 1024; // 1 MB

export class NativeMessageDecoder extends Transform {
  private buffer: Buffer = Buffer.alloc(0);

  constructor() {
    super({ readableObjectMode: true });
  }

  _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);

    while (this.buffer.length >= 4) {
      const messageLength = this.buffer.readUInt32LE(0);

      if (messageLength > MAX_INBOUND_NATIVE_MESSAGE_SIZE) {
        return callback(new Error(`Native inbound message exceeds 64MB limit: ${messageLength} bytes`));
      }

      if (this.buffer.length < 4 + messageLength) {
        // Incomplete message payload, wait for next stream chunk
        break;
      }

      const jsonSlice = this.buffer.subarray(4, 4 + messageLength);
      this.buffer = this.buffer.subarray(4 + messageLength);

      try {
        const parsed = JSON.parse(jsonSlice.toString('utf8'));
        this.push(parsed);
      } catch (err) {
        return callback(new Error(`Invalid JSON payload from native stream: ${(err as Error).message}`));
      }
    }

    callback();
  }
}

export function encodeNativeMessage(payload: unknown): Buffer {
  const jsonBuf = Buffer.from(JSON.stringify(payload), 'utf8');
  if (jsonBuf.length > MAX_OUTBOUND_NATIVE_MESSAGE_SIZE) {
    throw new Error(`Outbound message exceeds Chromium 1MB limit: ${jsonBuf.length} bytes`);
  }
  const headerBuf = Buffer.alloc(4);
  headerBuf.writeUInt32LE(jsonBuf.length, 0);
  return Buffer.concat([headerBuf, jsonBuf]);
}
