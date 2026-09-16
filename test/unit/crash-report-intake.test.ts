/**
 * Crash dump forensics + intake.
 *
 * A native death runs no JS handler, so the dump is the only witness — these tests pin the
 * contract that lets the Hub name it: parse the exception, resolve the faulting module, read
 * the process annotations, and record the result exactly once as an OPEN P0.
 *
 * Fixtures are synthetic minidumps built to the byte layout the parser reads, so the suite
 * stays hermetic; the layout itself was verified against a real 68 MB Chromium dump.
 */
import { after, test, describe } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { IssueRegister } from '../../src/main/session/issue-register';
import { StorageLocations } from '../../src/main/config/storage-locations';
import { listCrashDumps, summarizeCrashDump } from '../../src/main/diagnostics/crash-dump-forensics';
import { intakeCrashReports } from '../../src/main/diagnostics/crash-report-intake';

const originalDataRoot = process.env.ANTIFAN_DATA_ROOT;
const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-crash-intake-'));
process.env.ANTIFAN_DATA_ROOT = dataRoot;
StorageLocations.resetCache();

// The register is process-wide and private-instanced; the test redirects the data root, so
// the instance must be dropped afterwards for anything that reads the real root later.
const registerSingleton = IssueRegister as unknown as { instance: IssueRegister | null };

after(() => {
  registerSingleton.instance = null;
  if (originalDataRoot === undefined) delete process.env.ANTIFAN_DATA_ROOT;
  else process.env.ANTIFAN_DATA_ROOT = originalDataRoot;
  StorageLocations.resetCache();
  fs.rmSync(dataRoot, { recursive: true, force: true });
});

/** Length-prefixed UTF-8 string, the form both Crashpad dictionaries and crash keys use. */
function lengthPrefixed(text: string): Buffer {
  const bytes = Buffer.from(text, 'utf8');
  const header = Buffer.alloc(4);
  header.writeUInt32LE(bytes.length, 0);
  return Buffer.concat([header, bytes]);
}

function minidumpString(text: string): Buffer {
  const bytes = Buffer.from(text, 'utf16le');
  const header = Buffer.alloc(4);
  header.writeUInt32LE(bytes.length, 0);
  return Buffer.concat([header, bytes]);
}

/**
 * Build a dump shaped like Crashpad's: header + directory, then the thread, exception,
 * module and CrashpadInfo streams. The annotation dictionary and its strings are laid
 * out BEFORE the CrashpadInfo stream and addressed by absolute file offset, so the
 * crash-key pool scan (which reads only the gap after CrashpadInfo) can never see them:
 * annotations in these fixtures are reachable only through the dictionary descriptor.
 */
function buildMinidump(options?: {
  exceptionCode?: number;
  faultingAddress?: bigint;
  instructionPointer?: bigint;
  writeAccess?: boolean;
  modules?: Array<{ name: string; base: bigint; size: number }>;
  crashKeys?: Record<string, string>;
  annotations?: Record<string, string>;
}): Buffer {
  const exceptionCode = options?.exceptionCode ?? 0xc0000005;
  const faultingAddress = options?.faultingAddress ?? 0n;
  const instructionPointer = options?.instructionPointer ?? 0x7ff600001234n;
  const modules = options?.modules ?? [
    { name: 'C:\\app\\electron.exe', base: 0x7ff600000000n, size: 0x01000000 },
    { name: 'C:\\app\\node_modules\\node-pty\\prebuilds\\win32-x64\\pty.node', base: 0x7ff700000000n, size: 0x1000 },
  ];
  const crashKeys = options?.crashKeys ?? { pid: '4321', ptype: 'browser', platform: 'win32', osarch: 'x86_64' };
  const annotations = options?.annotations ?? { _productName: 'AntiFan Desktop', ver: '43.4.0' };

  const threadCount = 58;
  const threadList = Buffer.alloc(4 + threadCount * 48);
  threadList.writeUInt32LE(threadCount, 0);

  const exception = Buffer.alloc(168);
  exception.writeUInt32LE(1234, 0);
  exception.writeUInt32LE(exceptionCode, 8);
  exception.writeBigUInt64LE(instructionPointer, 24);
  exception.writeUInt32LE(2, 32);
  exception.writeBigUInt64LE(options?.writeAccess ? 1n : 0n, 40);
  exception.writeBigUInt64LE(faultingAddress, 48);

  const moduleNames = modules.map((module) => minidumpString(module.name));
  const moduleTable = Buffer.alloc(4 + modules.length * 108);
  moduleTable.writeUInt32LE(modules.length, 0);
  // Names are addressed by absolute file offset, so they are laid out after the table.
  const moduleNameOffsets: number[] = [];
  let moduleNameCursor = 0;
  modules.forEach((module, index) => {
    moduleNameOffsets.push(moduleNameCursor);
    moduleNameCursor += moduleNames[index]!.length;
  });

  const annotationEntries = Object.entries(annotations);
  const dictionary = Buffer.alloc(4 + annotationEntries.length * 8);
  dictionary.writeUInt32LE(annotationEntries.length, 0);
  // Entries are written after the layout pass below: the SimpleStringDictionary stores
  // absolute file offsets, which are only known once annotationStringsRva is computed.
  const annotationStringOffsets: Array<{ key: number; value: number }> = [];
  const annotationStrings: Buffer[] = [];
  let annotationCursor = 0;
  annotationEntries.forEach(([key, value]) => {
    const keyBuffer = lengthPrefixed(key);
    const valueBuffer = lengthPrefixed(value);
    annotationStringOffsets.push({ key: annotationCursor, value: annotationCursor + keyBuffer.length });
    annotationCursor += keyBuffer.length + valueBuffer.length;
    annotationStrings.push(keyBuffer, valueBuffer);
  });

  const crashKeyBuffers = Object.entries(crashKeys).flatMap(([key, value]) => [
    lengthPrefixed(key),
    lengthPrefixed(value),
  ]);

  // Header (32) + directory (4 * 12 = 48) then each stream in turn, 8-byte aligned.
  const headerSize = 32;
  const streamCount = 4;
  const align = (value: number): number => Math.ceil(value / 8) * 8;
  const threadRva = align(headerSize + streamCount * 12);
  const exceptionRva = align(threadRva + threadList.length);
  const moduleRva = align(exceptionRva + exception.length);
  const moduleNamesRva = align(moduleRva + moduleTable.length);
  const dictionaryRva = align(moduleNamesRva + moduleNameCursor);
  const annotationStringsRva = align(dictionaryRva + dictionary.length);
  const crashpadRva = align(annotationStringsRva + annotationCursor);
  const crashKeysRva = align(crashpadRva + 64);
  modules.forEach((module, index) => {
    const at = 4 + index * 108;
    moduleTable.writeBigUInt64LE(module.base, at);
    moduleTable.writeUInt32LE(module.size, at + 8);
    moduleTable.writeUInt32LE(moduleNamesRva + moduleNameOffsets[index]!, at + 20);
  });

  const crashpadInfo = Buffer.alloc(64);
  crashpadInfo.writeUInt32LE(1, 0);
  crashpadInfo.writeUInt32LE(dictionary.length, 36);
  crashpadInfo.writeUInt32LE(dictionaryRva, 40);

  annotationStringOffsets.forEach((offsets, index) => {
    dictionary.writeUInt32LE(annotationStringsRva + offsets.key, 4 + index * 8);
    dictionary.writeUInt32LE(annotationStringsRva + offsets.value, 4 + index * 8 + 4);
  });

  const total = crashKeysRva + crashKeyBuffers.reduce((sum, buffer) => sum + buffer.length, 0);
  const dump = Buffer.alloc(align(total) + 8);

  dump.write('MDMP', 0, 'latin1');
  dump.writeUInt32LE(42899, 4);
  dump.writeUInt32LE(streamCount, 8);
  dump.writeUInt32LE(32, 12);

  const streamTypes = [3, 6, 4, 0x43500001];
  const streamSizes = [threadList.length, exception.length, moduleTable.length + moduleNameCursor, 64];
  const streamRvas = [threadRva, exceptionRva, moduleRva, crashpadRva];
  streamTypes.forEach((type, index) => {
    const at = 32 + index * 12;
    dump.writeUInt32LE(type, at);
    dump.writeUInt32LE(streamSizes[index]!, at + 4);
    dump.writeUInt32LE(streamRvas[index]!, at + 8);
  });

  threadList.copy(dump, threadRva);
  exception.copy(dump, exceptionRva);
  moduleTable.copy(dump, moduleRva);
  let nameCursor = moduleNamesRva;
  moduleNames.forEach((name) => {
    name.copy(dump, nameCursor);
    nameCursor += name.length;
  });
  crashpadInfo.copy(dump, crashpadRva);
  dictionary.copy(dump, dictionaryRva);
  let annotationCursorWrite = annotationStringsRva;
  annotationStrings.forEach((buffer) => {
    buffer.copy(dump, annotationCursorWrite);
    annotationCursorWrite += buffer.length;
  });
  let crashKeyCursor = crashKeysRva;
  crashKeyBuffers.forEach((buffer) => {
    buffer.copy(dump, crashKeyCursor);
    crashKeyCursor += buffer.length;
  });

  return dump;
}

function writeDump(dir: string, filename: string, contents: Buffer): string {
  const target = path.join(dir, filename);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, contents);
  return target;
}

describe('summarizeCrashDump', () => {
  test('names the process, the exception, the faulting module and the loaded native addons', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-dump-'));
    const dump = writeDump(dir, 'de686712-4d6e-45ad-a1c3-76106343809c.dmp', buildMinidump());

    const summary = await summarizeCrashDump(dump);
    assert.ok(summary, 'a well-formed dump must summarize');
    assert.equal(summary.exceptionCode, '0xc0000005');
    assert.equal(summary.exceptionName, 'STATUS_ACCESS_VIOLATION');
    assert.equal(summary.processType, 'browser');
    assert.equal(summary.pid, 4321);
    assert.equal(summary.productVersion, '43.4.0');
    assert.equal(summary.faultingAccess, 'read');
    assert.equal(summary.faultingAddress, '0x0000000000000000');
    assert.equal(summary.threadCount, 58);
    assert.equal(summary.faultingModule?.offset, '0x0000000000001234');
    assert.equal(summary.faultingModule?.name, 'C:\\app\\electron.exe');
    assert.equal(summary.nativeAddons.length, 1);
    assert.match(summary.nativeAddons[0]!, /pty\.node$/);
    assert.match(summary.headline, /browser died with STATUS_ACCESS_VIOLATION/);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('reads annotations through the dictionary when they sit outside the crash-key pool window', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-dump-'));
    // No crash-key pool at all: `ver` can only come from the SimpleStringDictionary,
    // whose strings this fixture places before the CrashpadInfo stream — outside the
    // window the pool scan reads.
    const dump = buildMinidump({ crashKeys: {}, annotations: { _productName: 'AntiFan Desktop', ver: '99.1.2' } });
    const target = writeDump(dir, 'dictionary-only.dmp', dump);

    const summary = await summarizeCrashDump(target);
    assert.ok(summary, 'a well-formed dump must summarize');
    assert.equal(summary.productVersion, '99.1.2');
    assert.equal(summary.processType, null);
    assert.equal(summary.pid, null);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('reports a write fault and an address outside every image without inventing a module', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-dump-'));
    // Write = ExceptionInformation[0] of 1; the address sits below every module base.
    const dump = buildMinidump({ instructionPointer: 0x1234n, faultingAddress: 0xdeadbeefn, writeAccess: true });
    const target = writeDump(dir, 'write-fault.dmp', dump);

    const summary = await summarizeCrashDump(target);
    assert.ok(summary);
    assert.equal(summary.faultingAccess, 'write');
    assert.equal(summary.faultingAddress, '0x00000000deadbeef');
    assert.equal(summary.faultingModule, null);
    assert.match(summary.headline, /outside every loaded image/);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('returns null for a file that is not a minidump instead of throwing', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-dump-'));
    const target = writeDump(dir, 'garbage.dmp', Buffer.from('not a dump at all', 'utf8'));
    assert.equal(await summarizeCrashDump(target), null);
    assert.equal(await summarizeCrashDump(path.join(dir, 'missing.dmp')), null);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('lists dumps newest first', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-dump-'));
    const older = writeDump(dir, 'nested/older.dmp', buildMinidump());
    const newer = writeDump(dir, 'newer.dmp', buildMinidump());
    fs.utimesSync(older, new Date(1000), new Date(1000));
    fs.utimesSync(newer, new Date(2000), new Date(2000));

    const listed = listCrashDumps(dir);
    assert.equal(listed.length, 2);
    assert.equal(path.basename(listed[0]!), 'newer.dmp');
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('intakeCrashReports', () => {
  test('records an unreported dump once as an OPEN P0 and stays silent on the next launch', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-intake-'));
    writeDump(dir, 'crash-a.dmp', buildMinidump());

    const first = await intakeCrashReports({ crashDumpsDir: dir });
    assert.equal(first.reported.length, 1);
    assert.equal(first.alreadyReported, 0);

    const register = IssueRegister.getInstance();
    const issues = register.list({ errorCode: 'NATIVE_CRASH' });
    assert.equal(issues.length, 1);
    assert.equal(issues[0]!.severity, 'P0');
    assert.equal(issues[0]!.status, 'OPEN');
    assert.deepEqual(issues[0]!.affected, ['crash-a.dmp']);
    assert.match(issues[0]!.errorMessage, /electron\.exe\+0x0000000000001234/);
    const detail: unknown = JSON.parse(issues[0]!.notes ?? '{}');
    assert.ok(detail && typeof detail === 'object' && 'faultingAccess' in detail);
    assert.equal(detail.faultingAccess, 'read');
    assert.ok('nativeAddons' in detail && Array.isArray(detail.nativeAddons));
    assert.equal(detail.nativeAddons.length, 1);

    const second = await intakeCrashReports({ crashDumpsDir: dir });
    assert.equal(second.reported.length, 0);
    assert.equal(second.alreadyReported, 1);
    assert.equal(register.list({ errorCode: 'NATIVE_CRASH' }).length, 1);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('reports an unreadable dump as P1 rather than losing the evidence of a death', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-intake-'));
    writeDump(dir, 'truncated.dmp', Buffer.from('MDMP', 'latin1'));

    const result = await intakeCrashReports({ crashDumpsDir: dir });
    assert.deepEqual(result.unreadable, ['truncated.dmp']);
    const issues = IssueRegister.getInstance().list({ errorCode: 'CRASH_DUMP_UNREADABLE' });
    assert.equal(issues.length, 1);
    assert.equal(issues[0]!.severity, 'P1');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('caps reports per launch and discards the rest so a crash loop cannot flood the register', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-intake-'));
    for (let index = 0; index < 3; index += 1) {
      writeDump(dir, `capped-${index}.dmp`, buildMinidump());
    }

    const result = await intakeCrashReports({ crashDumpsDir: dir, maxReports: 2 });
    assert.equal(result.reported.length, 2);
    assert.equal(result.discarded, 1);
    const reported = IssueRegister.getInstance()
      .list({ errorCode: 'NATIVE_CRASH' })
      .filter((issue) => (issue.affected ?? []).some((name) => name.startsWith('capped-')));
    assert.equal(reported.length, 2);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
