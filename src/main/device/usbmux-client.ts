import * as net from 'node:net';
import { CapabilityError } from '../../shared/control-plane-contracts';
import { DEVICE_ERROR_REMEDIATION } from '../../shared/device-control-contracts';

/**
 * AntiFan usbmuxd client.
 *
 * Dependency-free implementation of the Apple usbmuxd protocol (Node.js built-ins only).
 * Handles Windows named pipe (\\.\pipe\usbmuxd) and TCP loopback (127.0.0.1:27015).
 * Supports Little-Endian framing, XML plist serialization/deserialization, device enumeration,
 * and port bridging with empirical branch discrimination ('reply-port' vs 'same-socket').
 */

// ---------------------------------------------------------------- Framing Constants

export const USBMUXD_HEADER_SIZE = 16;
export const USBMUXD_VERSION = 1;
export const USBMUXD_MESSAGE_PLIST = 8;

export interface UsbmuxDevice {
  deviceNumber: number;
  deviceId: string;
  name: string;
  model: string;
  osVersion: string;
  connection: 'usb';
}

// ---------------------------------------------------------------- Plist XML Parser & Generator

function escapeXml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function unescapeXml(str: string): string {
  return str
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCharCode(parseInt(dec, 10)))
    .replace(/&#x([0-9a-fA-F]+);/gi, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));
}

function serializePlistValue(val: unknown, indent = '  '): string {
  if (val === null || val === undefined) {
    return `${indent}<string></string>\n`;
  }
  if (typeof val === 'boolean') {
    return `${indent}<${val ? 'true' : 'false'}/>\n`;
  }
  if (typeof val === 'number') {
    if (Number.isInteger(val)) {
      return `${indent}<integer>${val}</integer>\n`;
    }
    return `${indent}<real>${val}</real>\n`;
  }
  if (typeof val === 'bigint') {
    return `${indent}<integer>${val.toString()}</integer>\n`;
  }
  if (typeof val === 'string') {
    return `${indent}<string>${escapeXml(val)}</string>\n`;
  }
  if (Buffer.isBuffer(val) || val instanceof Uint8Array) {
    return `${indent}<data>${Buffer.from(val).toString('base64')}</data>\n`;
  }
  if (val instanceof Date) {
    return `${indent}<date>${val.toISOString()}</date>\n`;
  }
  if (Array.isArray(val)) {
    if (val.length === 0) {
      return `${indent}<array/>\n`;
    }
    let res = `${indent}<array>\n`;
    for (const item of val) {
      res += serializePlistValue(item, `${indent}  `);
    }
    res += `${indent}</array>\n`;
    return res;
  }
  if (typeof val === 'object') {
    const keys = Object.keys(val as object);
    if (keys.length === 0) {
      return `${indent}<dict/>\n`;
    }
    let res = `${indent}<dict>\n`;
    for (const k of keys) {
      const v = (val as Record<string, unknown>)[k];
      if (v === undefined) continue;
      res += `${indent}  <key>${escapeXml(k)}</key>\n`;
      res += serializePlistValue(v, `${indent}  `);
    }
    res += `${indent}</dict>\n`;
    return res;
  }
  return `${indent}<string>${escapeXml(String(val))}</string>\n`;
}

export function toPlistXml(obj: unknown): string {
  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n` +
    `<plist version="1.0">\n` +
    serializePlistValue(obj, '') +
    `</plist>`
  );
}

interface XmlToken {
  type: 'open' | 'close' | 'self' | 'text';
  name?: string;
  value?: string;
}

export function parsePlistXml(xmlStr: string): any {
  if (!xmlStr || typeof xmlStr !== 'string') return null;

  let clean = xmlStr.replace(/<!--[\s\S]*?-->/g, '');
  clean = clean.replace(/<\?[\s\S]*?\?>/g, '');
  clean = clean.replace(/<!DOCTYPE[\s\S]*?>/gi, '');

  const tokens: XmlToken[] = [];
  const tagOrTextRegex = /<(\/)?([a-zA-Z0-9_-]+)([^>]*?)(\/)?>|([^<]+)/g;
  let match: RegExpExecArray | null;

  while ((match = tagOrTextRegex.exec(clean)) !== null) {
    const textVal = match[5];
    if (textVal !== undefined) {
      tokens.push({ type: 'text', value: textVal });
    } else {
      const isClose = Boolean(match[1]);
      const name = match[2] ?? '';
      const trailingSlash = match[4];
      const middleAttrs = match[3] ?? '';
      const isSelfClose = Boolean(trailingSlash) || middleAttrs.trim().endsWith('/');
      tokens.push({
        type: isClose ? 'close' : isSelfClose ? 'self' : 'open',
        name,
      });
    }
  }

  let idx = 0;
  const peek = (): XmlToken | undefined => tokens[idx];
  const next = (): XmlToken | undefined => tokens[idx++];

  function readTextUntilClose(tagName: string): string {
    let acc = '';
    while (idx < tokens.length) {
      const tok = peek();
      if (tok && tok.type === 'close' && tok.name === tagName) {
        idx++;
        break;
      }
      idx++;
      if (tok && tok.type === 'text' && tok.value) {
        acc += tok.value;
      }
    }
    return acc;
  }

  function parseNode(): any {
    while (idx < tokens.length) {
      const tok = next();
      if (!tok) return undefined;
      if (tok.type === 'text') continue;

      if (tok.type === 'open') {
        if (tok.name === 'plist') {
          const val = parseNode();
          readTextUntilClose('plist');
          return val;
        }
        if (tok.name === 'dict') {
          const dict: Record<string, any> = {};
          let currentKey: string | null = null;
          while (idx < tokens.length) {
            const p = peek();
            if (!p) break;
            if (p.type === 'close' && p.name === 'dict') {
              idx++;
              break;
            }
            if (p.type === 'text') {
              idx++;
              continue;
            }
            if (p.type === 'open' && p.name === 'key') {
              idx++;
              currentKey = unescapeXml(readTextUntilClose('key'));
            } else if (p.type === 'self' && p.name === 'key') {
              idx++;
              currentKey = '';
            } else {
              const val = parseNode();
              if (currentKey !== null) {
                dict[currentKey] = val;
                currentKey = null;
              }
            }
          }
          return dict;
        }
        if (tok.name === 'array') {
          const arr: any[] = [];
          while (idx < tokens.length) {
            const p = peek();
            if (!p) break;
            if (p.type === 'close' && p.name === 'array') {
              idx++;
              break;
            }
            if (p.type === 'text') {
              idx++;
              continue;
            }
            const val = parseNode();
            if (val !== undefined) {
              arr.push(val);
            }
          }
          return arr;
        }
        if (tok.name === 'string') {
          return unescapeXml(readTextUntilClose('string'));
        }
        if (tok.name === 'integer') {
          const t = readTextUntilClose('integer').trim();
          if (!t) return 0;
          const num = Number(t);
          if (!Number.isSafeInteger(num)) {
            try {
              return BigInt(t);
            } catch {
              return num;
            }
          }
          return num;
        }
        if (tok.name === 'real') {
          const t = readTextUntilClose('real').trim();
          return t ? parseFloat(t) : 0.0;
        }
        if (tok.name === 'data') {
          const t = readTextUntilClose('data').replace(/\s+/g, '');
          return Buffer.from(t, 'base64');
        }
        if (tok.name === 'date') {
          const t = readTextUntilClose('date').trim();
          return new Date(t);
        }
      } else if (tok.type === 'self') {
        if (tok.name === 'true') return true;
        if (tok.name === 'false') return false;
        if (tok.name === 'string') return '';
        if (tok.name === 'integer') return 0;
        if (tok.name === 'real') return 0.0;
        if (tok.name === 'dict') return {};
        if (tok.name === 'array') return [];
        if (tok.name === 'data') return Buffer.alloc(0);
      }
    }
    return undefined;
  }

  return parseNode();
}

// ---------------------------------------------------------------- Frame Encoding & Decoding

export function encodePlistFrame(obj: unknown, tag = 1): Buffer {
  const xml = toPlistXml(obj);
  const payload = Buffer.from(xml, 'utf8');
  const header = Buffer.alloc(USBMUXD_HEADER_SIZE);
  // Little-endian framing:
  // [0..3]: Total message length (headerSize + payloadSize)
  // [4..7]: Protocol version (1 for plist)
  // [8..11]: Message type (8 for plist message)
  // [12..15]: Correlation tag
  header.writeUInt32LE(USBMUXD_HEADER_SIZE + payload.length, 0);
  header.writeUInt32LE(USBMUXD_VERSION, 4);
  header.writeUInt32LE(USBMUXD_MESSAGE_PLIST, 8);
  header.writeUInt32LE(tag >>> 0, 12);
  return Buffer.concat([header, payload]);
}

function readPlistFrame(
  socket: net.Socket,
  timeoutMs = 10000
): Promise<{ tag: number; plist: any; unconsumed: Buffer }> {
  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0);
    let settled = false;

    const cleanup = () => {
      socket.removeListener('data', onData);
      socket.removeListener('error', onError);
      socket.removeListener('close', onClose);
      if (timer) clearTimeout(timer);
    };

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error(`Timeout waiting for usbmuxd frame response after ${timeoutMs}ms`));
    }, timeoutMs);

    const onData = (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length >= USBMUXD_HEADER_SIZE) {
        const totalLength = buffer.readUInt32LE(0);
        if (buffer.length >= totalLength) {
          if (settled) return;
          settled = true;
          cleanup();

          const tag = buffer.readUInt32LE(12);
          const payload = buffer.subarray(USBMUXD_HEADER_SIZE, totalLength);
          const unconsumed = buffer.subarray(totalLength);

          try {
            const xml = payload.toString('utf8');
            const plist = parsePlistXml(xml);
            resolve({ tag, plist, unconsumed });
          } catch (err) {
            reject(err);
          }
        }
      }
    };

    const onError = (err: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    };

    const onClose = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error('usbmuxd connection closed prematurely before frame arrived'));
    };

    socket.on('data', onData);
    socket.once('error', onError);
    socket.once('close', onClose);
  });
}

// ---------------------------------------------------------------- Sockets & Endpoints

function tryConnectSocket(target: net.NetConnectOpts, timeoutMs = 2000): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(target);
    let settled = false;
    const cleanup = () => {
      socket.removeAllListeners('connect');
      socket.removeAllListeners('error');
      socket.removeAllListeners('timeout');
    };
    socket.once('connect', () => {
      if (settled) return;
      settled = true;
      socket.setTimeout(0);
      cleanup();
      resolve(socket);
    });
    socket.once('error', (err) => {
      if (settled) return;
      settled = true;
      cleanup();
      socket.destroy();
      reject(err);
    });
    socket.setTimeout(timeoutMs, () => {
      if (settled) return;
      settled = true;
      cleanup();
      socket.destroy();
      const err = new Error(`Connection timeout after ${timeoutMs}ms`);
      (err as any).code = 'ETIMEDOUT';
      reject(err);
    });
  });
}

interface UsbmuxEndpointCandidate {
  kind: 'named-pipe' | 'tcp';
  detail: string;
  opts: net.NetConnectOpts;
}

function getCandidateEndpoints(): UsbmuxEndpointCandidate[] {
  return [
    {
      kind: 'named-pipe',
      detail: '\\\\.\\pipe\\usbmuxd',
      opts: { path: '\\\\.\\pipe\\usbmuxd' },
    },
    {
      kind: 'tcp',
      detail: '127.0.0.1:27015',
      opts: { host: '127.0.0.1', port: 27015 },
    },
  ];
}

/**
 * Connects to the first answering usbmuxd endpoint: Windows named pipe first, then TCP 127.0.0.1:27015.
 * Throws CapabilityError('DEVICE_NOT_CONNECTED', ...) with device remediation when neither answers.
 */
export async function connectToUsbmux(
  timeoutMs = 4000
): Promise<{ socket: net.Socket; kind: 'named-pipe' | 'tcp'; detail: string }> {
  const candidates = getCandidateEndpoints();
  const probeErrors: Array<{ endpoint: string; error: string }> = [];

  for (const cand of candidates) {
    try {
      const socket = await tryConnectSocket(cand.opts, timeoutMs);
      return {
        socket,
        kind: cand.kind,
        detail: cand.detail,
      };
    } catch (err: any) {
      probeErrors.push({
        endpoint: cand.detail,
        error: err?.code || err?.message || String(err),
      });
    }
  }

  throw new CapabilityError(
    'DEVICE_NOT_CONNECTED',
    DEVICE_ERROR_REMEDIATION.DEVICE_NOT_CONNECTED,
    {
      probes: probeErrors,
    }
  );
}

/**
 * Probes the usbmuxd endpoints (Windows named pipe first, then TCP 127.0.0.1:27015).
 * Resolves with the active endpoint descriptor, or throws CapabilityError('DEVICE_NOT_CONNECTED', ...).
 */
export async function openUsbmuxEndpoint(
  probeTimeoutMs = 4000
): Promise<{ kind: 'named-pipe' | 'tcp'; detail: string }> {
  const conn = await connectToUsbmux(probeTimeoutMs);
  conn.socket.destroy();
  return {
    kind: conn.kind,
    detail: conn.detail,
  };
}

// ---------------------------------------------------------------- High-Level Operations

/**
 * Lists devices currently enumerated by usbmuxd using the ListDevices message.
 * Maps DeviceList[].Properties to { deviceNumber, deviceId, name, model, osVersion, connection: 'usb' }.
 */
export async function listUsbmuxDevices(timeoutMs = 5000): Promise<UsbmuxDevice[]> {
  const { socket } = await connectToUsbmux(timeoutMs);
  try {
    const listMsg = {
      MessageType: 'ListDevices',
      ClientVersionString: 'antifan',
      ProgName: 'antifan',
      kLibUSBMuxVersion: 3,
    };
    socket.write(encodePlistFrame(listMsg, 1));
    const { plist } = await readPlistFrame(socket, timeoutMs);

    const rawList = Array.isArray(plist?.DeviceList) ? plist.DeviceList : [];
    return rawList.map((entry: any) => {
      const props = entry?.Properties ?? {};
      const devId = Number(props.DeviceID ?? entry?.DeviceID ?? 0);
      const udid = String(props.UDID ?? props.SerialNumber ?? entry?.SerialNumber ?? devId);
      const name = String(props.DeviceName ?? props.ProductType ?? 'iPhone');
      const model = String(props.ProductType ?? 'iPhone');
      const osVersion = String(props.ProductVersion ?? 'unknown');
      return {
        deviceNumber: devId,
        deviceId: udid,
        name,
        model,
        osVersion,
        connection: 'usb' as const,
      };
    });
  } finally {
    socket.destroy();
  }
}

/**
 * Connects to a target TCP port on a connected iOS device via usbmuxd.
 * Uses the `Connect` message with the port in network byte order (big-endian / htons).
 *
 * Empirical branch discrimination:
 * - If the reply plist carries `Port`, opens a fresh TCP connection to `127.0.0.1:<Port>` (`via: 'reply-port'`).
 * - Otherwise, the current socket transitions directly into the device-port stream (`via: 'same-socket'`).
 */
export async function connectDevicePort(
  deviceNumber: number,
  port: number,
  timeoutMs = 5000
): Promise<{ socket: net.Socket; via: 'reply-port' | 'same-socket'; localPort?: number }> {
  const { socket: controlSocket } = await connectToUsbmux(timeoutMs);

  // usbmuxd protocol expects PortNumber in network byte order (big-endian / htons)
  const numPort = Number(port);
  const htonsPort = ((numPort & 0xff) << 8) | ((numPort >> 8) & 0xff);

  const connectMsg = {
    MessageType: 'Connect',
    ClientVersionString: 'antifan',
    ProgName: 'antifan',
    kLibUSBMuxVersion: 3,
    DeviceID: Number(deviceNumber),
    PortNumber: htonsPort,
  };

  let plistReply: any;
  let unconsumed: Buffer = Buffer.alloc(0);

  try {
    controlSocket.write(encodePlistFrame(connectMsg, 1));
    const response = await readPlistFrame(controlSocket, timeoutMs * 2);
    plistReply = response.plist;
    unconsumed = response.unconsumed;
  } catch (err: any) {
    controlSocket.destroy();
    throw new CapabilityError(
      'DEVICE_TRANSPORT_UNREACHABLE',
      `${DEVICE_ERROR_REMEDIATION.DEVICE_TRANSPORT_UNREACHABLE} (usbmuxd Connect exchange failed: ${err?.message ?? String(err)})`,
      { deviceNumber, port, cause: err }
    );
  }

  if (plistReply?.Number !== 0) {
    controlSocket.destroy();
    const status = plistReply?.Number ?? 'unknown';
    if (status === 3) {
      throw new CapabilityError(
        'DEVICE_WDA_NOT_READY',
        DEVICE_ERROR_REMEDIATION.DEVICE_WDA_NOT_READY,
        { deviceNumber, port, usbmuxdStatus: status, reply: plistReply }
      );
    }
    throw new CapabilityError(
      'DEVICE_TRANSPORT_UNREACHABLE',
      `${DEVICE_ERROR_REMEDIATION.DEVICE_TRANSPORT_UNREACHABLE} (usbmuxd Connect returned status ${status})`,
      { deviceNumber, port, usbmuxdStatus: status, reply: plistReply }
    );
  }

  // Branch based on observed reply:
  if (plistReply.Port !== undefined && plistReply.Port !== null) {
    // Branch A: Apple Windows usbmuxd / AppleMobileDeviceService behavior -> port redirect
    const localPort = Number(plistReply.Port);
    console.log(`[antifan:device] usbmuxd Connect established via reply-port -> 127.0.0.1:${localPort}`);
    let freshSocket: net.Socket;
    try {
      freshSocket = await tryConnectSocket({ host: '127.0.0.1', port: localPort }, timeoutMs);
    } catch (err: any) {
      controlSocket.destroy();
      throw new CapabilityError(
        'DEVICE_TRANSPORT_UNREACHABLE',
        `${DEVICE_ERROR_REMEDIATION.DEVICE_TRANSPORT_UNREACHABLE} (Failed to connect to redirected port 127.0.0.1:${localPort})`,
        { deviceNumber, port, localPort, cause: err }
      );
    }

    // Keep control socket open for the lifetime of freshSocket
    freshSocket.once('close', () => controlSocket.destroy());
    freshSocket.once('error', () => controlSocket.destroy());

    return {
      socket: freshSocket,
      via: 'reply-port',
      localPort,
    };
  }

  // Branch B: macOS / Linux / libimobiledevice stream handover on the same socket
  console.log(`[antifan:device] usbmuxd Connect established via same-socket stream handover`);
  if (unconsumed.length > 0) {
    controlSocket.unshift(unconsumed);
  }

  return {
    socket: controlSocket,
    via: 'same-socket',
  };
}
