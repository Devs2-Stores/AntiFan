import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { HASH_CONTRACT, sha256Buffer, sha256Text, textDigest } from '../../scripts/lib/atomic-record.mjs';
import {
  CHECKS_STATUS,
  commandLogPrefix,
  isPublishComplete,
  projectCaptureDoc,
  projectVerdictDoc,
  readCommandRecords,
  readInstrument,
  runStatus,
  stampVerdictSetIndex,
} from '../../.canary/tools/theme-fidelity-run.mjs';

/** A campaign where every leg completed and the structural checks came back clean. */
const CLEAN_CAMPAIGN = {
  capturesComplete: true,
  compareSetsComplete: true,
  missingVerdicts: 0,
  checksPresent: true,
  checksStatus: CHECKS_STATUS.CLEAN,
  structuralPresent: true,
  structuralRefused: false,
  structuralRefusalCount: 0,
  checksGaps: 0,
  driftPresent: true,
};

const tempDirs = [];
const tempDir = (prefix) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
};

after(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

describe('publish predicate', () => {
  it('publishes a campaign whose every leg completed and whose structural checks are clean', () => {
    assert.equal(isPublishComplete(CLEAN_CAMPAIGN), true);
  });

  it('does not publish when the checks stage refused', () => {
    // The structural refusal list is what makes the checks stage exit 3 with status REFUSED;
    // it is a refusal, not a pass, so current.json must never be published from it.
    assert.equal(isPublishComplete({ ...CLEAN_CAMPAIGN, checksStatus: 'REFUSED' }), false);
    assert.equal(isPublishComplete({ ...CLEAN_CAMPAIGN, checksStatus: 'REFUSED', structuralRefused: true, structuralRefusalCount: 21 }), false);
  });

  it('does not publish when the checks stage failed', () => {
    assert.equal(isPublishComplete({ ...CLEAN_CAMPAIGN, checksStatus: CHECKS_STATUS.FAILED }), false);
  });

  it('refuses any checks status other than the clean one the producer mints', () => {
    // The gate is an allowlist, not a denylist: a status the checks stage has never minted,
    // and any status a future producer adds, must refuse rather than publish.
    for (const unknown of ['TIMEOUT', 'ABORTED', 'UNKNOWN', 'CRASHED', 'REFUSED_BY_CHILD']) {
      assert.equal(isPublishComplete({ ...CLEAN_CAMPAIGN, checksStatus: unknown }), false, `${unknown} must not publish`);
    }
    assert.equal(isPublishComplete({ ...CLEAN_CAMPAIGN, checksStatus: 'OK' }), false);
    assert.equal(isPublishComplete({ ...CLEAN_CAMPAIGN, checksStatus: CHECKS_STATUS.CLEAN }), true);
  });

  it('does not publish on a structural refusal even when every leg completed', () => {
    assert.equal(isPublishComplete({ ...CLEAN_CAMPAIGN, structuralRefused: true }), false);
    assert.equal(isPublishComplete({ ...CLEAN_CAMPAIGN, structuralRefusalCount: 1 }), false);
  });

  it('does not publish an absent checks record, an empty status, or a recorded checks gap', () => {
    assert.equal(isPublishComplete({ ...CLEAN_CAMPAIGN, checksPresent: false }), false);
    assert.equal(isPublishComplete({ ...CLEAN_CAMPAIGN, checksStatus: null }), false);
    assert.equal(isPublishComplete({ ...CLEAN_CAMPAIGN, checksStatus: '' }), false);
    assert.equal(isPublishComplete({ ...CLEAN_CAMPAIGN, checksGaps: 1 }), false);
  });

  it('does not publish while a capture, a verdict set, a structural report or drift proof is missing', () => {
    assert.equal(isPublishComplete({ ...CLEAN_CAMPAIGN, capturesComplete: false }), false);
    assert.equal(isPublishComplete({ ...CLEAN_CAMPAIGN, compareSetsComplete: false }), false);
    assert.equal(isPublishComplete({ ...CLEAN_CAMPAIGN, missingVerdicts: 1 }), false);
    assert.equal(isPublishComplete({ ...CLEAN_CAMPAIGN, structuralPresent: false }), false);
    assert.equal(isPublishComplete({ ...CLEAN_CAMPAIGN, driftPresent: false }), false);
  });

  it('is fail-closed: an omitted input never publishes', () => {
    assert.equal(isPublishComplete(), false);
    assert.equal(isPublishComplete({ checksStatus: CHECKS_STATUS.CLEAN }), false);
  });
});

describe('report status', () => {
  it('names a structural refusal even when the refusal list is missing or empty', () => {
    // The checks stage mints REFUSED precisely when it refused; a corrupt or empty refusal
    // array must not degrade that refusal to a bare INCOMPLETE.
    assert.equal(runStatus({ auditPass: true, complete: false, checksStatus: CHECKS_STATUS.REFUSED, structuralRefused: false }), 'REFUSED_STRUCTURAL');
    assert.equal(runStatus({ auditPass: true, complete: false, checksStatus: CHECKS_STATUS.REFUSED, structuralRefused: true }), 'REFUSED_STRUCTURAL');
    assert.equal(runStatus({ auditPass: true, complete: false, checksStatus: CHECKS_STATUS.CLEAN, structuralRefused: true }), 'REFUSED_STRUCTURAL');
  });

  it('still distinguishes a clean publish, a plain incomplete run, and a safety refusal', () => {
    assert.equal(runStatus({ auditPass: true, complete: true, checksStatus: CHECKS_STATUS.CLEAN }), 'COMPLETE');
    assert.equal(runStatus({ auditPass: true, complete: false, checksStatus: CHECKS_STATUS.CLEAN }), 'INCOMPLETE');
    assert.equal(runStatus({ auditPass: false, complete: true, checksStatus: CHECKS_STATUS.CLEAN }), 'REFUSED');
  });
});

describe('artifact hash normalisation', () => {
  it('hashes CRLF text identically to LF text, while the byte digest does not', () => {
    assert.equal(sha256Text('a\r\nb'), sha256Text('a\nb'));
    assert.equal(sha256Text('a\rb'), sha256Text('a\nb'));
    assert.notEqual(sha256Buffer('a\r\nb'), sha256Buffer('a\nb'));
  });

  it('digests a CRLF command log exactly as its LF twin', () => {
    const crlfDir = tempDir('fidelity-log-crlf-');
    const lfDir = tempDir('fidelity-log-lf-');
    const crlfFile = path.join(crlfDir, 'commands.jsonl');
    const lfFile = path.join(lfDir, 'commands.jsonl');
    fs.writeFileSync(crlfFile, '{"stage":"preflight"}\r\n{"stage":"checks"}\r\n');
    fs.writeFileSync(lfFile, '{"stage":"preflight"}\n{"stage":"checks"}\n');

    const crlfLog = readCommandRecords(crlfFile);
    const lfLog = readCommandRecords(lfFile);
    assert.equal(lfLog.lines, 2);
    assert.equal(crlfLog.sha256, lfLog.sha256);
    // The bytes really do differ: the equality above is the normalisation, not a coincidence.
    assert.notEqual(sha256Buffer(fs.readFileSync(crlfFile)), sha256Buffer(fs.readFileSync(lfFile)));
  });

  it('pins only the prefix of an append-only log, and the prefix re-hashes to the pin', () => {
    const pinnedText = '{"stage":"subject"}\n{"stage":"compare"}\n';
    const finalText = `${pinnedText}{"stage":"report"}\n`;
    const pinnedDigest = sha256Text(commandLogPrefix(finalText, 2));
    assert.equal(commandLogPrefix(finalText, 2), pinnedText);
    assert.equal(pinnedDigest, sha256Text(pinnedText));
    // Re-hashing the grown file must not match; the pin names the prefix, not the whole file.
    assert.notEqual(pinnedDigest, sha256Text(finalText));
    assert.equal(commandLogPrefix(finalText, 0), '');
  });

  it('names the normalised contract on a record built from a CRLF fixture, and the LF twin re-derives it', () => {
    const dir = tempDir('fidelity-log-contract-');
    const file = path.join(dir, 'commands.jsonl');
    const crlf = '{"stage":"preflight"}\r\n{"stage":"checks"}\r\n';
    const lf = '{"stage":"preflight"}\n{"stage":"checks"}\n';
    fs.writeFileSync(file, crlf);

    const record = readCommandRecords(file);
    assert.equal(record.hashContract, HASH_CONTRACT.LF_NORMALIZED);
    assert.equal(record.sha256, sha256Text(lf));
    // The contract is named precisely because the on-disk bytes are not the pinned bytes.
    assert.notEqual(record.sha256, sha256Buffer(fs.readFileSync(file)));
  });

  it('pins the append-only command log as a prefix: contract, bytes, lines and growth agree', () => {
    const dir = tempDir('fidelity-command-pin-');
    const file = path.join(dir, 'commands.jsonl');
    const pinnedText = '{"stage":"preflight"}\n{"stage":"references"}\n';
    fs.writeFileSync(file, pinnedText);

    const pin = readCommandRecords(file);
    assert.equal(pin.appendOnly, true);
    assert.equal(pin.hashContract, HASH_CONTRACT.LF_NORMALIZED);
    assert.equal(pin.lines, 2);
    assert.equal(pin.rawLines, 2);
    assert.equal(pin.bytes, Buffer.byteLength(pinnedText));
    assert.equal(pin.sha256, sha256Text(pinnedText));

    // Every stage appends its own record after this pin is taken. The pin describes the
    // prefix, so a verifier re-derives it with commandLogPrefix rather than the grown file.
    fs.appendFileSync(file, '{"stage":"report"}\n');
    const grown = fs.readFileSync(file, 'utf8');
    assert.equal(sha256Text(commandLogPrefix(grown, pin.rawLines)), pin.sha256);
    assert.equal(Buffer.byteLength(commandLogPrefix(grown, pin.rawLines)), pin.bytes);
    assert.notEqual(sha256Text(grown), pin.sha256);
  });

  it('re-derives the recorded pin from a log with a blank line, where the record count would not', () => {
    // The pin digests the raw text, blank lines included; `lines` is the parser's record
    // count and is smaller than `rawLines` here. A verifier told to slice by `lines` would
    // hash a truncated prefix and report an unchanged file as tampered — the exact failure
    // the recorded raw count exists to prevent.
    const dir = tempDir('fidelity-command-pin-blank-');
    const file = path.join(dir, 'commands.jsonl');
    const raw = '{"stage":"preflight"}\n\n{"stage":"report"}\n';
    fs.writeFileSync(file, raw);

    const pin = readCommandRecords(file);
    assert.equal(pin.lines, 2);
    assert.equal(pin.rawLines, 3);
    assert.equal(pin.sha256, sha256Text(raw));

    assert.equal(commandLogPrefix(raw, pin.rawLines), raw);
    assert.equal(sha256Text(commandLogPrefix(raw, pin.rawLines)), pin.sha256);
    assert.notEqual(sha256Text(commandLogPrefix(raw, pin.lines)), pin.sha256);
  });
});

describe('artifact digest contract', () => {
  it('carries the child-declared contract for each digest instead of relabelling it', () => {
    const crlfDom = '<p>a\r\nb</p>';
    const lfDom = '<p>a\nb</p>';
    const doc = {
      kind: 'theme-fidelity-capture',
      status: 'CAPTURED',
      // A DOM dump is text: the harness digests it with CRLF normalised to LF, so its
      // declared contract is lf-normalized and a CRLF checkout must not read as tampered.
      dom: { file: 'subject/dom/home.html', sha256: sha256Text(crlfDom), hashContract: HASH_CONTRACT.LF_NORMALIZED, bytes: Buffer.byteLength(crlfDom) },
      png: { file: 'subject/png/home.png', sha256: sha256Buffer(Buffer.from([0x89, 0x50, 0x4e, 0x47])), hashContract: HASH_CONTRACT.BYTE_EXACT, bytes: 4 },
    };
    const projected = projectCaptureDoc({ value: doc, file: 'subject/home__1440x900.json', ...textDigest(JSON.stringify(doc)) }, 'subject');

    assert.equal(projected.hashContract, HASH_CONTRACT.LF_NORMALIZED); // the JSON document itself
    assert.equal(projected.dom.hashContract, HASH_CONTRACT.LF_NORMALIZED);
    assert.equal(projected.png.hashContract, HASH_CONTRACT.BYTE_EXACT);
    // The CRLF dump and its LF twin are one document under that contract: no false tamper.
    assert.equal(projected.dom.sha256, sha256Text(lfDom));

    // A document that declares no contract is labelled by artifact kind, and a declared one
    // is forwarded verbatim — the parent never overrides what the digest was taken under.
    const undeclared = projectCaptureDoc({ value: { kind: 'theme-fidelity-capture', dom: { file: 'd', sha256: 'd'.repeat(64) }, png: { file: 'p', sha256: 'p'.repeat(64) } }, file: 'f', ...textDigest('{}') }, 'subject');
    assert.equal(undeclared.dom.hashContract, HASH_CONTRACT.LF_NORMALIZED);
    assert.equal(undeclared.png.hashContract, HASH_CONTRACT.BYTE_EXACT);
    const declared = projectCaptureDoc({ value: { kind: 'theme-fidelity-capture', dom: { file: 'd', sha256: 'd'.repeat(64), hashContract: HASH_CONTRACT.BYTE_EXACT } }, file: 'f', ...textDigest('{}') }, 'subject');
    assert.equal(declared.dom.hashContract, HASH_CONTRACT.BYTE_EXACT);
  });
});

describe('verdict leg generation evidence', () => {
  it('stamps the instrument block into a set index before its digest is pinned, and is stable on re-stamp', () => {
    const dir = tempDir('fidelity-set-index-');
    const file = path.join(dir, 'index.json');
    const index = {
      kind: 'theme-fidelity-verdict-index',
      status: 'COMPLETE',
      startedAt: '2026-01-01T00:00:00.000Z',
      finishedAt: '2026-01-01T00:01:00.000Z',
      pairs: [],
    };
    fs.writeFileSync(file, `${JSON.stringify(index, null, 2)}\n`);
    const before = sha256Text(fs.readFileSync(file, 'utf8'));

    const stamp = stampVerdictSetIndex(file);
    assert.notEqual(stamp, null);
    assert.equal(stamp.revision, readInstrument().revision);
    assert.equal(stamp.epoch, index.finishedAt);

    const stampedText = fs.readFileSync(file, 'utf8');
    // The digest the compare index pins covers the stamped bytes, not the child's pre-stamp ones.
    assert.notEqual(sha256Text(stampedText), before);
    assert.equal(JSON.parse(stampedText).instrument.revision, readInstrument().revision);

    // Re-stamping the same generation must not move the digest, or a verifier re-deriving it fails.
    stampVerdictSetIndex(file);
    assert.equal(sha256Text(fs.readFileSync(file, 'utf8')), sha256Text(stampedText));
  });

  it('carries the leg generation evidence a verdict document records into the report projection', () => {
    const outDir = tempDir('fidelity-verdict-projection-');
    const setDir = path.join(outDir, 'compare', 'r1-vs-subject');
    const file = path.join(setDir, 'home__1440x900.json');
    const doc = {
      kind: 'theme-fidelity-verdict',
      status: null,
      verdict: 'PASS',
      mechanism: 'PIXEL',
      reason: null,
      compare: { mismatchPercentage: 0 },
      instrumentRevision: 'a1b2c3d4',
      provenanceDrift: { symmetric: true, fields: ['docHeight'] },
      crossSideIdentity: { symmetric: true },
      settlePasses: [{ attempt: 1, settled: true }],
    };

    const projected = projectVerdictDoc({ value: doc, file, ...textDigest(JSON.stringify(doc)) }, setDir, outDir);
    assert.equal(projected.file, 'compare/r1-vs-subject/home__1440x900.json');
    assert.equal(projected.instrumentRevision, 'a1b2c3d4');
    assert.deepEqual(projected.provenanceDrift, doc.provenanceDrift);
    assert.deepEqual(projected.crossSideIdentity, doc.crossSideIdentity);
    assert.deepEqual(projected.settlePasses, doc.settlePasses);
    // A leg with no such evidence stays explicitly null rather than absent.
    const bare = projectVerdictDoc({ value: { kind: 'theme-fidelity-verdict', verdict: 'PASS' }, file, ...textDigest('{}') }, setDir, outDir);
    assert.equal(bare.instrumentRevision, null);
    assert.equal(bare.provenanceDrift, null);
    assert.equal(bare.crossSideIdentity, null);
    assert.equal(bare.settlePasses, null);
  });
});

describe('instrument revision', () => {
  it('mints a revision over every instrument file and records a missing one as null without throwing', () => {
    const { revision, files } = readInstrument();
    // Every instrument file must be readable and carry a digest under the named contract;
    // the revision is only meaningful if its inputs are real.
    for (const file of files) {
      assert.notEqual(file.sha256, null, `${file.path} must be readable to be part of the revision`);
      assert.match(file.sha256, /^[0-9a-f]{64}$/);
      assert.equal(file.hashContract, HASH_CONTRACT.LF_NORMALIZED);
    }
    assert.match(revision, /^[0-9a-f]{64}$/);
    // The digest library defines what every recorded digest means, so changing digest
    // semantics has to mint a new revision: it must be one of the instrument files.
    assert.ok(files.some((file) => file.path === 'scripts/lib/atomic-record.mjs'), 'the digest library must be part of the instrument revision');

    const sparseRepo = tempDir('fidelity-instrument-sparse-');
    fs.writeFileSync(path.join(sparseRepo, 'present.mjs'), 'export const a = 1;\n');
    const partial = readInstrument({ repo: sparseRepo, files: ['present.mjs', 'absent.mjs'] });
    assert.equal(partial.files[0].sha256.length, 64);
    assert.equal(partial.files[0].hashContract, HASH_CONTRACT.LF_NORMALIZED);
    assert.equal(partial.files[1].sha256, null);
    assert.equal(partial.files[1].hashContract, null);
    assert.match(partial.revision, /^[0-9a-f]{64}$/);
  });

  it('mints the same revision for the same tool source in a CRLF and an LF checkout', () => {
    const crlfRepo = tempDir('fidelity-instrument-crlf-');
    const lfRepo = tempDir('fidelity-instrument-lf-');
    const source = 'export const a = 1;\nexport const b = 2;\n';
    fs.writeFileSync(path.join(crlfRepo, 'tool.mjs'), source.replace(/\n/g, '\r\n'));
    fs.writeFileSync(path.join(lfRepo, 'tool.mjs'), source);

    const crlf = readInstrument({ repo: crlfRepo, files: ['tool.mjs'] });
    const lf = readInstrument({ repo: lfRepo, files: ['tool.mjs'] });
    assert.equal(crlf.files[0].sha256, lf.files[0].sha256);
    assert.equal(crlf.revision, lf.revision);
  });

  it('mints a different revision when the tool source changes', () => {
    const repo = tempDir('fidelity-instrument-change-');
    const file = path.join(repo, 'tool.mjs');
    fs.writeFileSync(file, 'export const a = 1;\n');
    const before = readInstrument({ repo, files: ['tool.mjs'] });
    fs.writeFileSync(file, 'export const a = 2;\n');
    const after = readInstrument({ repo, files: ['tool.mjs'] });
    assert.notEqual(before.revision, after.revision);
  });
});
