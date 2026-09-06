const { app } = require('electron');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

app.commandLine.appendSwitch('no-sandbox');
app.commandLine.appendSwitch('disable-gpu');
app.on('window-all-closed', (event) => {
  event.preventDefault();
});

const rootDir = path.resolve(__dirname, '..');
const tempRoot = process.env.ANTIFAN_LIVE_PROOF_TEMP_ROOT;
const proofPath = process.env.ANTIFAN_LIVE_PROOF_STAGING_PATH;
if (!tempRoot || !proofPath) {
  throw new Error('Live visual evidence proof worker requires orchestrator-owned temp and staging paths');
}
const tempUserData = path.join(tempRoot, 'user-data');
const workspaceRoot = path.join(tempRoot, 'workspace');
app.setPath('userData', tempUserData);

function sha256(content) {
  return crypto.createHash('sha256').update(content).digest('hex');
}

function atomicWriteJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(tempPath, filePath);
}

function checksumObject(value, checksumField) {
  const copy = { ...value };
  delete copy[checksumField];
  return sha256(Buffer.from(JSON.stringify(copy), 'utf8'));
}

/**
 * Presence-only check for Sapo CLI and store preview environment.
 * Invariant: NEVER prints, reads, or leaks credential values.
 */
function probeSapoPrerequisites() {
  const missing = [];

  // Check Sapo CLI binary on system PATH
  const sapoCmd = process.platform === 'win32' ? 'where' : 'which';
  const sapoCli = spawnSync(sapoCmd, ['sapo'], { stdio: 'ignore' });
  const themekitCli = spawnSync(sapoCmd, ['themekit'], { stdio: 'ignore' });
  const hasCli = sapoCli.status === 0 || themekitCli.status === 0;
  if (!hasCli) {
    missing.push('SAPO_THEME_CLI_WATCHER (sapo/themekit CLI binary not found on PATH)');
  }

  // Check authenticated Sapo theme preview URL variable presence
  const envKeys = Object.keys(process.env);
  const hasPreviewUrl = envKeys.includes('SAPO_THEME_PREVIEW_URL') || envKeys.includes('SAPO_PREVIEW_URL');
  if (!hasPreviewUrl) {
    missing.push('SAPO_THEME_PREVIEW_URL (Environment variable not set)');
  }

  return {
    available: hasCli && hasPreviewUrl,
    hasCli,
    hasPreviewUrl,
    missing,
  };
}

async function run() {
  console.log('[Live Visual Evidence Proof] Evaluating Phase 7 Sapo-first live workflow prerequisites...');
  try { fs.unlinkSync(proofPath); } catch {}

  const sapoProbe = probeSapoPrerequisites();

  // CONTRACT: Phase 7 R2 & Success Criteria:
  // "V-25 EVIDENCE BẮT BUỘC từ đường sync Sapo thật (Sapo CLI event/output hoặc preview store Sapo);
  //  chạy qua haravan-sync-barrier chỉ là chạy phụ trợ, KHÔNG bao giờ tính là evidence V-25/freeze #18.
  //  Nếu thiếu prerequisite (credential/preview URL/CLI sync evidence): phase KHÔNG đạt;
  //  giữ trạng thái terminal blocker BLOCKED với đúng thiếu sót được nêu, V-25 vẫn pending
  //  — không có proof giả, không tính BLOCKED là thành công."
  if (!sapoProbe.available) {
    console.log('[Live Visual Evidence Proof] Prerequisites check: INCOMPLETE (Terminal Blocker)');
    for (const item of sapoProbe.missing) {
      console.log(`  - Missing: ${item}`);
    }
    console.log('[Live Visual Evidence Proof] Invariant enforced: No local/synthetic substitute comparison or receipt emitted.');

    const blockerReport = {
      schemaVersion: 1,
      type: 'antifan-live-visual-evidence-proof',
      verdict: 'BLOCKED',
      v25Status: 'BLOCKED',
      freezeChecklist18: 'PENDING_REAL_SAPO_SYNC',
      sapoPrerequisites: {
        available: false,
        hasCli: sapoProbe.hasCli,
        hasPreviewUrl: sapoProbe.hasPreviewUrl,
        missing: sapoProbe.missing,
      },
      blockerDetails: {
        reason: 'Missing real Sapo Theme CLI sync watcher and live Sapo preview store URL.',
        requirement: 'Audit v5 §25 / Freeze #18 strictly mandates real Sapo sync attestation. Local/Haravan paths never count as V-25 evidence.',
        resolution: 'Install Sapo CLI binary on PATH and provide authenticated Sapo preview URL in SAPO_THEME_PREVIEW_URL.',
      },
      substituteEvidenceEmitted: false,
      timestamp: new Date().toISOString(),
      teardown: {
        passed: true,
        processBoundTempCleanup: 'pending',
        resourceOwners: {},
      },
    };

    blockerReport.proofChecksum = checksumObject(blockerReport, 'proofChecksum');
    atomicWriteJson(proofPath, blockerReport);
    console.log(`[OK] Staged sanitized terminal blocker report: ${path.basename(proofPath)}`);
    return;
  }

  // Future path when real Sapo CLI and store preview credentials are provided
  throw new Error('Real Sapo live sync execution path pending live environment configuration');
}

app.whenReady().then(() => run()
  .then(() => app.exit(0))
  .catch((error) => {
    console.error('[Live Visual Evidence Proof FAIL]', error);
    app.exit(1);
  }));
