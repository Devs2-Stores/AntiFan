/**
 * AntiFan Browser Desktop — Crash Dump Forensics
 *
 * Why this file exists
 * --------------------
 * `index.ts` arms Electron's crash reporter so that a native death leaves a dump inside
 * `<runtime>/crashDumps`, and its own comment states the intent: "For that class of death
 * the dump is the only surviving artifact, and this is what makes it findable on the next
 * launch." Nothing read those dumps, so the intent was only half kept: the artifact landed
 * on disk and stayed there. A native death writes no journal line (the fault leaves through
 * a callback no JS handler ever sees), so the Hub had nothing to show and the operator was
 * left with "the app closed by itself" — the exact report this module exists to answer.
 *
 * The reader is deliberately narrow. It extracts the facts that decide a next step —
 * which process died, why the OS killed it, which instruction and which module faulted,
 * and which native addons were loaded — from a minidump without symbols and without
 * loading the (tens of megabytes) file into memory.
 *
 * Format notes that are load-bearing
 * ----------------------------------
 *  - Crashpad writes the 64-bit shaped exception record (`MINIDUMP_EXCEPTION_STREAM`:
 *    u32 thread id, u32 alignment, u32 code / flags / record at +8, a full-width u64
 *    exception address at +24, u32 parameter count at +32, then up to 15 u64 parameters
 *    at +40 — 168 bytes total), verified against a real 68 MB Chromium dump.
 *  - The consequence matters: `ExceptionAddress` in that layout is the full-width
 *    instruction pointer of the faulting instruction, so it can be attributed to a
 *    loaded image directly. Reading the 32-bit shape instead silently truncates the
 *    address, which is how a fault inside an image comes to look like a fault inside
 *    no image at all.
 *  - Reads are bounded `read()` calls on an open descriptor. A dump is ~68 MB; parsing it
 *    must not allocate a second copy of it, let alone on the startup path.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

/** `MINIDUMP_SIGNATURE`, little-endian 'MDMP'. */
const MDMP_SIGNATURE = 0x504d444d;

const StreamType = {
  ThreadList: 3,
  ModuleList: 4,
  Exception: 6,
  /** Crashpad's own extension; carries the simple annotations (ptype/pid/ver). */
  CrashpadInfo: 0x43500001,
} as const;

const MINIDUMP_MODULE_SIZE = 108;

/** How an access violation was attempted, derived from the exception parameters. */
export type FaultingAccess = 'read' | 'write' | 'execute' | 'unknown';

export interface CrashModuleRef {
  name: string;
  /** Image base as recorded by the dump. */
  base: string;
  /** Offset of the faulting instruction inside the image, when it maps to one. */
  offset: string;
}

export interface CrashDumpSummary {
  /** Dump file name — the stable id an operator can match against the crashDumps folder. */
  filename: string;
  /** Absolute path of the dump. */
  path: string;
  /** Dump file mtime: the closest thing to a crash instant the format exposes. */
  dumpModifiedAt: string;
  /** Crashpad annotation `ptype`: 'browser' for the main process, else a child role. */
  processType: string | null;
  /** Crashpad annotation `pid`. */
  pid: number | null;
  /** Crashpad annotation `ver`: the Electron/Chromium version that died. */
  productVersion: string | null;
  /** NTSTATUS exception code, e.g. 0xC0000005. */
  exceptionCode: string;
  /** Human name for the code, e.g. STATUS_ACCESS_VIOLATION. */
  exceptionName: string;
  /** Full-width exception address from the 64-bit record — the faulting instruction. */
  exceptionAddress: string;
  /** Same faulting instruction pointer, kept under the name the crash surface displays. */
  instructionPointer: string | null;
  /** Attempted access kind and target address, for access violations. */
  faultingAccess: FaultingAccess;
  /** Address the instruction tried to reach, when the code carries one. */
  faultingAddress: string | null;
  /** Module owning the instruction pointer, when it maps to a loaded image. */
  faultingModule: CrashModuleRef | null;
  /** Thread count at the time of death (a proxy for how busy the process was). */
  threadCount: number;
  /** Loaded modules that are native addons rather than OS or Chromium images. */
  nativeAddons: string[];
  /** One-line operator-facing summary. */
  headline: string;
}

const EXCEPTION_NAMES: Record<number, string> = {
  0x80000003: 'STATUS_BREAKPOINT',
  0xc0000005: 'STATUS_ACCESS_VIOLATION',
  0xc000001d: 'STATUS_ILLEGAL_INSTRUCTION',
  0xc0000094: 'STATUS_INTEGER_DIVIDE_BY_ZERO',
  0xc00000fd: 'STATUS_STACK_OVERFLOW',
  0xc0000374: 'STATUS_HEAP_CORRUPTION',
  0xc0000409: 'STATUS_STACK_BUFFER_OVERRUN',
  0xc000041d: 'STATUS_FATAL_USER_CALLBACK_EXCEPTION',
  0xc0000602: 'STATUS_FAIL_FAST_EXCEPTION',
  0xe0434352: 'CLR_EXCEPTION',
  0xe06d7363: 'CPP_EXCEPTION',
};

/** Module names that indicate a native addon rather than an OS or Chromium image. */
const NATIVE_ADDON_PATTERN = /(^|\\)(pty\.node|[^\\]*\.node)$/i;

function hex(value: number, width = 16): string {
  return `0x${value.toString(16).padStart(width, '0')}`;
}

/** Same rendering for the 64-bit fields, which cannot round-trip through `number`. */
function hex64(value: bigint, width = 16): string {
  return `0x${value.toString(16).padStart(width, '0')}`;
}

/** Read exactly `length` bytes at `offset`, or fewer when the file ends first. */
async function readAt(handle: fs.promises.FileHandle, offset: number, length: number): Promise<Buffer> {
  const buffer = Buffer.allocUnsafe(length);
  const { bytesRead } = await handle.read(buffer, 0, length, offset);
  return bytesRead === length ? buffer : buffer.subarray(0, bytesRead);
}

interface StreamRef {
  type: number;
  size: number;
  rva: number;
}

async function readDirectory(handle: fs.promises.FileHandle): Promise<StreamRef[] | null> {
  const header = await readAt(handle, 0, 32);
  if (header.length < 32 || header.readUInt32LE(0) !== MDMP_SIGNATURE) return null;
  const streamCount = header.readUInt32LE(8);
  const directoryRva = header.readUInt32LE(12);
  if (streamCount === 0 || streamCount > 4096) return null;

  const directory = await readAt(handle, directoryRva, streamCount * 12);
  const streams: StreamRef[] = [];
  for (let index = 0; index + 12 <= directory.length; index += 12) {
    streams.push({
      type: directory.readUInt32LE(index),
      size: directory.readUInt32LE(index + 4),
      rva: directory.readUInt32LE(index + 8),
    });
  }
  return streams;
}

interface ExceptionFacts {
  threadId: number;
  code: number;
  address: bigint;
  parameters: bigint[];
}

/** `MINIDUMP_EXCEPTION_STREAM` in its 64-bit shape: 8 + 24 + 4 + 4 + 15*8 = 168 bytes. */
const MINIDUMP_EXCEPTION_STREAM_SIZE = 168;

/**
 * `MINIDUMP_EXCEPTION_STREAM`. The record is read in its 64-bit shape, verified against a
 * real Chromium dump: code at +8, a full-width address at +24, parameter count at +32 and
 * the parameters at +40. Reading the 32-bit shape instead silently truncates the address,
 * which is how a fault inside an image comes to look like a fault inside no image at all.
 * A stream too small for that layout is unreadable rather than partially misread.
 */
async function readException(handle: fs.promises.FileHandle, stream: StreamRef): Promise<ExceptionFacts | null> {
  if (stream.size < MINIDUMP_EXCEPTION_STREAM_SIZE) return null;
  const body = await readAt(handle, stream.rva, MINIDUMP_EXCEPTION_STREAM_SIZE);
  if (body.length < MINIDUMP_EXCEPTION_STREAM_SIZE) return null;

  const threadId = body.readUInt32LE(0);
  const code = body.readUInt32LE(8);
  const address = body.readBigUInt64LE(24);
  const parameterCount = Math.min(body.readUInt32LE(32), 15);
  const parameters: bigint[] = [];
  for (let index = 0; index < parameterCount; index += 1) {
    const at = 40 + index * 8;
    if (at + 8 > body.length) break;
    parameters.push(body.readBigUInt64LE(at));
  }
  return { threadId, code, address, parameters };
}

/** A `MINIDUMP_LOCATION_DESCRIPTOR` is a u32 size followed by a u32 file offset. */
function readLocationDescriptor(buffer: Buffer, offset: number): { size: number; rva: number } {
  return { size: buffer.readUInt32LE(offset), rva: buffer.readUInt32LE(offset + 4) };
}

/**
 * Keys the crash surface needs that Chromium writes outside Crashpad's own dictionary.
 *
 * Crashpad's `simple_annotations` carries the product identity (`_productName`, `_version`,
 * `plat`, `prod`, `ver`), but the per-process identity an operator asks for first — which
 * process died — is written by Chromium into a crash-key pool that no minidump stream
 * describes: the pool sits in an unclaimed gap between the CrashpadInfo stream and the next
 * stream. Measured on a real dump: `pid=30392`, `ptype=browser`, `platform=win32`,
 * `osarch=x86_64` at offsets 102196-102340, immediately after the CrashpadInfo stream at
 * 101464. The pool is therefore read as a bounded window and only these keys are taken, so
 * a layout change costs a missing field rather than a wrong one.
 */
const CRASH_KEY_ALLOWLIST = new Set([
  'pid',
  'ptype',
  'process_type',
  'platform',
  'osarch',
  'prod',
  'plat',
  'ver',
]);

async function readCrashKeyPool(
  handle: fs.promises.FileHandle,
  streams: StreamRef[],
  start: number
): Promise<Record<string, string>> {
  const following = streams
    .filter((stream) => stream.rva > start)
    .reduce((lowest, stream) => Math.min(lowest, stream.rva), start + 64 * 1024);
  const window = await readAt(handle, start, Math.min(Math.max(following - start, 0), 64 * 1024));

  const tokens: string[] = [];
  for (let index = 0; index + 4 <= window.length; ) {
    const length = window.readUInt32LE(index);
    if (length > 0 && length <= 256 && index + 4 + length <= window.length) {
      const value = window.subarray(index + 4, index + 4 + length);
      if (/^[\x09\x0a\x0d\x20-\x7e]*$/.test(value.toString('latin1'))) {
        tokens.push(value.toString('latin1'));
        index += 4 + length;
        continue;
      }
    }
    index += 1;
  }

  const keys: Record<string, string> = {};
  for (let index = 0; index < tokens.length - 1; index += 1) {
    const key = tokens[index]!;
    if (!CRASH_KEY_ALLOWLIST.has(key)) continue;
    const value = tokens[index + 1]!;
    // A value that is itself an allowlisted key means the real value was lost and two
    // keys landed adjacent; pairing them would report one key's name as another's value.
    if (value.length === 0 || CRASH_KEY_ALLOWLIST.has(value)) continue;
    keys[key] = value;
  }
  return keys;
}

/**
 * Crashpad's simple annotations: a `SimpleStringDictionary` (count, then that many
 * {key offset, value offset} pairs) whose entries point at length-prefixed strings stored
 * after the table. The dictionary is located by descriptor inside the CrashpadInfo stream,
 * so it is read from its own offset rather than scanned for in the stream's own bytes.
 */
async function readAnnotations(handle: fs.promises.FileHandle, stream: StreamRef): Promise<Record<string, string>> {
  const annotations: Record<string, string> = {};
  const info = await readAt(handle, stream.rva, Math.min(stream.size, 64));
  if (info.length < 44) return annotations;

  const dictionary = readLocationDescriptor(info, 36);
  if (dictionary.rva === 0 || dictionary.size < 4 || dictionary.size > 64 * 1024) return annotations;

  const table = await readAt(handle, dictionary.rva, dictionary.size);
  if (table.length < 4) return annotations;
  const entryCount = Math.min(table.readUInt32LE(0), 256);

  const readString = async (offset: number): Promise<string | null> => {
    if (offset === 0) return null;
    const header = await readAt(handle, offset, 4);
    if (header.length < 4) return null;
    const length = Math.min(header.readUInt32LE(0), 1024);
    if (length === 0) return null;
    const bytes = await readAt(handle, offset + 4, length);
    return bytes.toString('utf8').replace(/\0+$/, '');
  };

  for (let index = 0; index < entryCount; index += 1) {
    const at = 4 + index * 8;
    if (at + 8 > table.length) break;
    const key = await readString(table.readUInt32LE(at));
    if (!key) continue;
    const value = await readString(table.readUInt32LE(at + 4));
    if (value !== null) annotations[key] = value;
  }
  return annotations;
}

async function readModules(handle: fs.promises.FileHandle, stream: StreamRef): Promise<Array<{ base: bigint; size: number; name: string }>> {
  const countHeader = await readAt(handle, stream.rva, 4);
  if (countHeader.length < 4) return [];
  const count = countHeader.readUInt32LE(0);
  if (count === 0 || count > 4096) return [];

  const table = await readAt(handle, stream.rva + 4, count * MINIDUMP_MODULE_SIZE);
  const modules: Array<{ base: bigint; size: number; name: string }> = [];
  for (let index = 0; index + MINIDUMP_MODULE_SIZE <= table.length; index += MINIDUMP_MODULE_SIZE) {
    const base = table.readBigUInt64LE(index);
    const size = table.readUInt32LE(index + 8);
    const nameRva = table.readUInt32LE(index + 20);
    if (nameRva === 0) continue;
    const nameHeader = await readAt(handle, nameRva, 4);
    if (nameHeader.length < 4) continue;
    const nameLength = Math.min(nameHeader.readUInt32LE(0), 1024);
    const nameBytes = await readAt(handle, nameRva + 4, nameLength);
    // Module names flow into the headline and issue notes, so control and other
    // non-printable characters are stripped at the boundary rather than trusted.
    const name = nameBytes.toString('utf16le').replace(/\0+$/, '').replace(/[\p{Cc}\p{Cf}]/gu, '');
    modules.push({ base, size, name });
  }
  return modules;
}

/** Attribute an address to a loaded image; null when it lies outside every image. */
function locateModule(
  modules: Array<{ base: bigint; size: number; name: string }>,
  address: bigint
): CrashModuleRef | null {
  for (const module of modules) {
    if (module.size === 0) continue;
    if (address >= module.base && address < module.base + BigInt(module.size)) {
      return { name: module.name, base: hex64(module.base), offset: hex64(address - module.base) };
    }
  }
  return null;
}

function describeAccess(code: number, parameters: bigint[]): { access: FaultingAccess; address: string | null } {
  if (code !== 0xc0000005 || parameters.length === 0) return { access: 'unknown', address: null };
  const operation = parameters[0] ?? 0n;
  const access: FaultingAccess = operation === 0n ? 'read' : operation === 1n ? 'write' : operation === 8n ? 'execute' : 'unknown';
  // A target of 0x0 is reported, not suppressed: a read of address 0 is a null-pointer
  // dereference, which is the single most useful thing an access violation can say.
  const target = parameters[1];
  return { access, address: target === undefined ? null : hex64(target) };
}

/**
 * Parse one minidump into the facts a triage decision needs. Returns null when the file is
 * not a minidump or is unreadable: an unreadable dump is itself worth reporting by the
 * caller as "a crash happened", so this never throws for malformed input.
 */
export async function summarizeCrashDump(dumpPath: string): Promise<CrashDumpSummary | null> {
  let handle: fs.promises.FileHandle | null = null;
  try {
    handle = await fs.promises.open(dumpPath, 'r');
    const streams = await readDirectory(handle);
    if (!streams) return null;

    const findStream = (type: number): StreamRef | null => streams.find((stream) => stream.type === type) ?? null;
    const exceptionStream = findStream(StreamType.Exception);
    const exception = exceptionStream ? await readException(handle, exceptionStream) : null;
    if (!exception) return null;

    const threadStream = findStream(StreamType.ThreadList);
    const moduleStream = findStream(StreamType.ModuleList);
    const modules = moduleStream ? await readModules(handle, moduleStream) : [];
    const crashpadStream = findStream(StreamType.CrashpadInfo);
    const annotations = crashpadStream ? await readAnnotations(handle, crashpadStream) : {};
    const crashKeys = crashpadStream
      ? await readCrashKeyPool(handle, streams, crashpadStream.rva + crashpadStream.size)
      : {};
    const parsedPid = Number.parseInt(crashKeys.pid ?? '', 10);

    const threadCountBuffer = threadStream ? await readAt(handle, threadStream.rva, 4) : Buffer.alloc(0);
    const threadCount = threadCountBuffer.length === 4 ? threadCountBuffer.readUInt32LE(0) : 0;

    const exceptionName = EXCEPTION_NAMES[exception.code] ?? `EXCEPTION_${hex(exception.code, 8)}`;
    const { access, address: faultingAddress } = describeAccess(exception.code, exception.parameters);
    const instructionPointer = hex64(exception.address);
    const faultingModule = locateModule(modules, exception.address);
    const nativeAddons = modules.map((module) => module.name).filter((name) => NATIVE_ADDON_PATTERN.test(name));
    const processType = crashKeys.ptype ?? crashKeys.process_type ?? null;
    const stats = await fs.promises.stat(dumpPath);

    // The headline names the image by basename: the full path embeds the local profile
    // directory (and with it the machine's username), which has no place in a one-line
    // summary. The full path stays on `faultingModule.name` for the notes.
    const moduleDisplayName = faultingModule ? (faultingModule.name.split(/[\\/]/).pop() ?? faultingModule.name) : null;
    const where = moduleDisplayName ? `${moduleDisplayName}+${faultingModule!.offset}` : 'an address outside every loaded image';
    const headline = `${processType ?? 'process'} died with ${exceptionName} (${hex(exception.code, 8)}) at ${where}${faultingAddress ? `, ${access} of ${faultingAddress}` : ''}`;

    return {
      filename: dumpPath.split(/[\\/]/).pop() ?? dumpPath,
      path: dumpPath,
      dumpModifiedAt: new Date(stats.mtimeMs).toISOString(),
      processType,
      pid: Number.isFinite(parsedPid) ? parsedPid : null,
      productVersion: crashKeys.ver ?? annotations.ver ?? annotations._version ?? null,
      exceptionCode: hex(exception.code, 8),
      exceptionName,
      exceptionAddress: hex64(exception.address),
      instructionPointer,
      faultingAccess: access,
      faultingAddress,
      faultingModule,
      threadCount,
      nativeAddons,
      headline,
    };
  } catch {
    return null;
  } finally {
    try {
      await handle?.close();
    } catch {
      // Closing a read-only handle cannot fail in a way the caller can act on.
    }
  }
}

/** Dump files under a directory tree, newest first. */
export function listCrashDumps(dir: string): string[] {
  const found: Array<{ path: string; mtime: number }> = [];
  const walk = (current: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.dmp')) {
        try {
          found.push({ path: full, mtime: fs.statSync(full).mtimeMs });
        } catch {}
      }
    }
  };
  walk(dir);
  return found.sort((a, b) => b.mtime - a.mtime).map((entry) => entry.path);
}
