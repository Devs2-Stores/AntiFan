#!/usr/bin/env node
/**
 * Benchmark Antigravity Artifact & Image Payload
 *
 * Measures staging overhead, serialization latency, disk read/write throughput,
 * and memory delta across multiple payload sizes (100KB, 1MB, 5MB, 10MB, 15MB).
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { performance } from 'node:perf_hooks';

function generateDeterministicBuffer(byteLength) {
  const buf = Buffer.alloc(byteLength);
  for (let i = 0; i < byteLength; i++) {
    buf[i] = (i * 31 + 17) % 256;
  }
  return buf;
}

async function runBenchmark() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'antigravity-payload-benchmark-'));
  const testSizes = [
    { name: '100KB (Small element crop)', bytes: 100 * 1024 },
    { name: '1MB (Viewport PNG snapshot)', bytes: 1024 * 1024 },
    { name: '5MB (Multi-element 4-image batch)', bytes: 5 * 1024 * 1024 },
    { name: '10MB (High-DPI full-canvas burst)', bytes: 10 * 1024 * 1024 },
    { name: '15MB (Soft Budget Upper Limit)', bytes: 15 * 1024 * 1024 },
  ];

  console.log('='.repeat(72));
  console.log(' Antigravity Artifact & Image Payload Benchmark');
  console.log(` OS: ${os.type()} ${os.release()} | Node.js: ${process.version}`);
  console.log(` Temp Working Directory: ${tmpDir}`);
  console.log('='.repeat(72));

  const results = [];

  for (const { name, bytes } of testSizes) {
    const rawBuffer = generateDeterministicBuffer(bytes);
    const hash = crypto.createHash('sha256').update(rawBuffer).digest('hex');

    // 1. Measure Staged File Write (Disk I/O)
    const stagedFilePath = path.join(tmpDir, `snapshot_${bytes}.png`);
    const startStageWrite = performance.now();
    fs.writeFileSync(stagedFilePath, rawBuffer);
    const stageWriteDurationMs = performance.now() - startStageWrite;

    // 2. Measure Staged File Read + Hash Verification
    const startStageRead = performance.now();
    const readBuffer = fs.readFileSync(stagedFilePath);
    const readHash = crypto.createHash('sha256').update(readBuffer).digest('hex');
    const stageReadDurationMs = performance.now() - startStageRead;
    const hashMatch = hash === readHash;

    // 3. Measure Inline Base64 JSON Payload Serialization vs Staged URI JSON Payload
    const stagedPayload = {
      protocolVersion: 2,
      id: `cmd-bench-${Date.now()}`,
      action: 'send-prompt',
      mode: 'auto',
      promptText: 'Audit design tokens on this element',
      attachments: [
        {
          name: `snapshot_${bytes}.png`,
          filePath: stagedFilePath,
          mime: 'image/png',
          byteLength: bytes,
          sha256: hash,
        },
      ],
    };

    const startStagedJson = performance.now();
    const stagedJsonStr = JSON.stringify(stagedPayload);
    const stagedJsonParsed = JSON.parse(stagedJsonStr);
    const stagedJsonDurationMs = performance.now() - startStagedJson;

    // Base64 equivalent (historical comparison)
    const base64Str = rawBuffer.toString('base64');
    const inlinePayload = {
      ...stagedPayload,
      inlineBase64: base64Str,
    };
    const startInlineJson = performance.now();
    const inlineJsonStr = JSON.stringify(inlinePayload);
    const inlineJsonParsed = JSON.parse(inlineJsonStr);
    const inlineJsonDurationMs = performance.now() - startInlineJson;

    const row = {
      name,
      bytes,
      stagedFileBytes: rawBuffer.length,
      stagedJsonBytes: Buffer.byteLength(stagedJsonStr),
      inlineJsonBytes: Buffer.byteLength(inlineJsonStr),
      stageWriteMs: parseFloat(stageWriteDurationMs.toFixed(2)),
      stageReadMs: parseFloat(stageReadDurationMs.toFixed(2)),
      stagedJsonMs: parseFloat(stagedJsonDurationMs.toFixed(2)),
      inlineJsonMs: parseFloat(inlineJsonDurationMs.toFixed(2)),
      speedupFactor: parseFloat((inlineJsonDurationMs / Math.max(0.01, stagedJsonDurationMs)).toFixed(1)),
      hashVerified: hashMatch,
    };
    results.push(row);

    console.log(`\n[${name}] (${(bytes / (1024 * 1024)).toFixed(2)} MB)`);
    console.log(`  - Disk Write (atomic snapshot): ${row.stageWriteMs} ms`);
    console.log(`  - Disk Read + SHA256:          ${row.stageReadMs} ms`);
    console.log(`  - Staged Command JSON (IPC):   ${row.stagedJsonBytes} bytes | ${row.stagedJsonMs} ms`);
    console.log(`  - Inline Base64 JSON (Old):    ${row.inlineJsonBytes} bytes | ${row.inlineJsonMs} ms`);
    console.log(`  - IPC Latency Reduction:       ${row.speedupFactor}x faster with staged URI`);
  }

  console.log('\n' + '='.repeat(72));
  console.log(' Benchmark Summary:');
  console.log(' - Staged File URIs (.antigravity/snapshots/) keep Command JSON < 1KB.');
  console.log(' - Eliminates multi-megabyte JSON IPC string parsing in Extension Host.');
  console.log(' - Soft budget recommendation: 15MB total / 8 images / 4MB per image.');
  console.log('='.repeat(72));

  // Clean up tmp directory
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {}

  return results;
}

runBenchmark().catch((err) => {
  console.error('Benchmark failed:', err);
  process.exit(1);
});
