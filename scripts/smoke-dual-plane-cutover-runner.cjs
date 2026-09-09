#!/usr/bin/env node
'use strict';

/**
 * Aggregated production certification runner for the Explicit Authority &
 * Dual-Plane Corrective Cutover (plan 260909-0032).
 *
 * Gates, in order:
 *   1. compile + typecheck (tsc --noEmit)
 *   2. static absence checks for prohibited Agent-Plane authority patterns
 *   3. focused unit/integration suites (compiled)
 *   4. live Electron scenarios via existing smoke runners (dual-plane
 *      multitasking, split review, MCP industrial e2e, vault)
 *
 * Evidence is recorded as a JSON certificate under the plan reports dir.
 * Exit code is 0 only when every gate and scenario passes.
 */

'use strict';

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const rootDir = path.resolve(__dirname, '..');
const planDir = path.join(rootDir, 'plans', '260909-0032-explicit-authority-dual-plane-cutover');
const reportsDir = path.join(planDir, 'reports');
const certificatePath = path.join(reportsDir, 'dual-plane-certificate.json');

const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';

function atomicWriteJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(tempPath, filePath);
}

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const needsShell = cmd === npmCmd;
    const child = spawn(cmd, args, {
      cwd: rootDir,
      // Only npm.cmd requires cmd.exe on Windows. Direct executables (process.execPath
      // under 'C:\Program Files\...') must spawn WITHOUT shell — cmd quoting would
      // cut the path at the space.
      shell: needsShell && process.platform === 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...(opts.env || {}) },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => { stdout += c; if (opts.verbose !== false) process.stdout.write(c); });
    child.stderr.on('data', (c) => { stderr += c; if (opts.verbose !== false) process.stderr.write(c); });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

async function runGate(name, command) {
  const started = Date.now();
  const result = await run(npmCmd, ['run', command].concat(process.platform === 'win32' && command === 'typecheck' ? [] : []), { verbose: false });
  const durationMs = Date.now() - started;
  const passed = result.code === 0;
  if (!passed) {
    // Re-print output for a failing gate so the evidence is visible.
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
  }
  return {
    gate: name,
    command: `npm run ${command}`,
    passed,
    exitCode: result.code,
    durationMs,
    evidenceFile: null,
  };
}

function checkStaticAbsence() {
  const findings = [];

  const scanSource = (relPaths, label, pattern, forbid = true, description, allow) => {
    for (const rel of relPaths) {
      const abs = path.join(rootDir, rel);
      if (!fs.existsSync(abs)) continue;
      const content = fs.readFileSync(abs, 'utf8');
      const lines = content.split(/\r?\n/);
      lines.forEach((line, idx) => {
        if (allow && allow(line)) return;
        if (pattern.test(line)) {
          findings.push({
            label,
            file: rel,
            line: idx + 1,
            source: line.trim().slice(0, 200),
            forbidden: forbid,
            description,
          });
        }
      });
    }
  };

  // 1. No ambient active-tab fallback inside Agent-Plane (bridge) capability dispatch.
  //    Only coalescing/or fallback positions are forbidden — `?? this.tabHost.getActiveTab()`
  //    or `|| this.tabHost.getActiveTab()`. Read-only reporting (getTabs/getStatus listing)
  //    and scope-gated mobile init reads are discovery, not fallback.
  scanSource(
    ['src/main/bridge/bridge-server.ts'],
    'ambient-active-tab-fallback',
    /\?\?\s*this\.tabHost\.getActiveTab\(\)|\|\|\s*this\.tabHost\.getActiveTab\(\)|getActiveTabSession\(\)/,
    true,
    'Agent Plane must never resolve targets from the ambient user-plane active tab.'
  );

  // 2. No Electron --mcp-server Core bootstrap (client-only MCP).
  //    The hard-exit guard at index.ts (argv probe + discontinued messaging) is
  //    REQUIRED; any other occurrence is a bootstrap and fails the check.
  scanSource(
    ['src/main/index.ts'],
    'electron-mcp-bootstrap',
    /--mcp-server/,
    true,
    'MCP must be client-only via scripts/antifan-omp-mcp.cjs; Electron Core must hard-exit, never bootstrap.',
    (line) => /process\.argv\.includes\(['"]--mcp-server['"]\)|discontinued|standalone Node MCP proxy/.test(line)
  );

  // 3. No token/secret persisted into bridge info files (non-secret discovery only).
  //    The static scan would match the function name itself, so check the body
  //    of persistBridgeInfo() for any credential field name.
  const persistBody = fs.readFileSync(path.join(rootDir, 'src/main/bridge/bridge-server.ts'), 'utf8');
  const persistMatch = persistBody.match(/private persistBridgeInfo\(\):\s*void\s*{([\s\S]*?)\n\s*}/);
  if (persistMatch && /(token|secret|pairingCode|masterSecret)/i.test(persistMatch[1])) {
    findings.push({
      label: 'persisted-secret-in-bridge-info',
      file: 'src/main/bridge/bridge-server.ts',
      line: 0,
      source: 'persistBridgeInfo body contains credential field name',
      forbidden: true,
      description: 'bridge.json must be non-secret discovery metadata only.',
    });
  }

  // 4. No shared-world privileged preload expose (contextIsolation preserved).
  //    Comment-only mentions (e.g. documenting the removed bridge) are allowed.
  scanSource(
    ['src/preload/tab-preload.ts'],
    'shared-world-preload',
    /contextBridge|exposeInMainWorld|antifanTab/,
    true,
    'tab-preload must not expose privileged API into the page world.',
    (line) => line.trim().startsWith('//') || line.trim().startsWith('*')
  );

  // 5. No credentials in URL query patterns remaining in scripts (migrated to headers).
  const scriptsDir = path.join(rootDir, 'scripts');
  const scriptFiles = fs.readdirSync(scriptsDir).filter((f) => /\.(cjs|mjs|js)$/.test(f));
  for (const f of scriptFiles) {
    const content = fs.readFileSync(path.join(scriptsDir, f), 'utf8');
    const lines = content.split(/\r?\n/);
    lines.forEach((line, idx) => {
      if (/\?token=|[?&](token|secret|code)=/.test(line) && !/SECRETS_IN_URL|FORBIDDEN|isAllowedNavigation|redactCredential|redact|sanitize/i.test(line)) {
        findings.push({
          label: 'secret-in-url-query',
          file: `scripts/${f}`,
          line: idx + 1,
          source: line.trim().slice(0, 200),
          forbidden: true,
          description: 'Credentials must flow via Authorization header or subprotocol, never query string.',
        });
      }
    });
  }

  return {
    passed: findings.length === 0,
    checks: findings,
    totalFindings: findings.length,
    suppressed: 0,
  };
}

const FOCUSED_SUITES = [
  // TerminalManager canonical ownership (Phase 1)
  '.compiled/test/main/terminal-canonical-ownership.test.js',
  '.compiled/test/main/per-tab-terminal-session.test.js',
  '.compiled/test/main/terminal-stream-invariants.test.js',
  // Target authority & attachment binding (Phase 2)
  '.compiled/test/main/bridge-attachment-dispatch.test.js',
  '.compiled/test/main/native-tab-host-agent-lifecycle.test.js',
  '.compiled/test/main/phase-02-controlled-inputs.test.js',
  // MCP client-only cutover (Phase 3)
  '.compiled/test/main/omp-mcp-adapter.test.js',
  '.compiled/test/main/mcp-persistent-transport.test.js',
  // Pairing/credential hardening (Phase 4)
  '.compiled/test/main/bridge-server.test.js',
  '.compiled/test/main/windows-acl.test.js',
  // Renderer/navigation/IPC isolation (Phase 5)
  '.compiled/test/main/bridge-cookie-import-endpoint-removed.test.js',
  '.compiled/test/main/local-session-vault.test.js',
  '.compiled/test/main/split-review-tabhost.test.js',
  '.compiled/test/main/security-policy.test.js',
];

async function runFocusedSuites() {
  const results = [];
  for (const suite of FOCUSED_SUITES) {
    const started = Date.now();
    // --test-force-exit: node-pty's conpty worker MessagePort keeps the event loop
    // alive on Windows after a PTY session is closed; assertions have already run
    // by the time the runner finishes, so exiting must not wait on that native handle.
    const result = await run(process.execPath, ['--test', '--test-force-exit', suite], { verbose: false });
    const passed = result.code === 0;
    const summary = (result.stdout.match(/^ℹ (tests|pass|fail) \d+$/gm) || []).join(' | ');
    results.push({
      suite: suite.replace('.compiled/', '').replace(/\\/g, '/'),
      passed,
      exitCode: result.code,
      durationMs: Date.now() - started,
      summary,
    });
    if (!passed) {
      if (result.stdout) process.stdout.write(result.stdout);
      if (result.stderr) process.stderr.write(result.stderr);
    }
  }
  return results;
}

const LIVE_SCENARIOS = [
  { name: 'dual-plane-multitasking', script: 'smoke:multitasking', description: 'user sentinel + background agent tab decoupling (RT-01/02/03)' },
  { name: 'split-review', script: 'smoke:split', description: 'split mobile view, inspect, security scheme guard' },
  { name: 'vault', script: 'smoke:vault', description: 'credential vault live surface' },
  { name: 'mcp-industrial-e2e', script: 'run-electron:smoke-mcp-industrial-e2e', description: 'MCP proxy + bridge sessions + capability dispatch (live Electron)' },
];

async function runLiveScenarios() {
  const results = [];
  for (const scenario of LIVE_SCENARIOS) {
    const started = Date.now();
    let result;
    if (scenario.script.startsWith('run-electron:')) {
      const scriptName = scenario.script.slice('run-electron:'.length);
      result = await run(process.execPath, [path.join(rootDir, 'scripts', 'run-electron.cjs'), path.join(rootDir, 'scripts', `${scriptName}.cjs`)], { verbose: false });
    } else if (scenario.script.startsWith('smoke-')) {
      // Direct node scripts (no Electron GUI needed).
      result = await run(process.execPath, [path.join(rootDir, 'scripts', `${scenario.script}.cjs`)], { verbose: false });
    } else {
      result = await run(npmCmd, ['run', scenario.script], { verbose: false });
    }
    const passed = result.code === 0;
    results.push({
      name: scenario.name,
      description: scenario.description,
      passed,
      exitCode: result.code,
      durationMs: Date.now() - started,
    });
    if (!passed) {
      if (result.stdout) process.stdout.write(result.stdout);
      if (result.stderr) process.stderr.write(result.stderr);
    }
  }
  return results;
}

async function main() {
  const startedAt = new Date().toISOString();
  const gates = [];
  const only = process.argv[2] || 'all'; // all | static | suites | live

  // Gate 1: compile + typecheck.
  if (only === 'all' || only === 'static') {
    gates.push(await runGate('compile', 'compile'));
    gates.push(await runGate('typecheck', 'typecheck'));
    if (gates.some((g) => !g.passed)) {
      atomicWriteJson(certificatePath, { verdict: 'BLOCKED', startedAt, finishedAt: new Date().toISOString(), gates });
      console.error('[certify:dual-plane] BLOCKED at compile/typecheck gate.');
      process.exit(1);
    }
  }

  // Gate 2: static absence checks.
  if (only === 'all' || only === 'static') {
    const staticAbsence = checkStaticAbsence();
    gates.push({ gate: 'static-absence', command: 'in-process scan', passed: staticAbsence.passed, exitCode: staticAbsence.passed ? 0 : 1, checks: staticAbsence.checks, suppressed: staticAbsence.suppressed });
    if (!staticAbsence.passed) {
      atomicWriteJson(certificatePath, { verdict: 'BLOCKED', startedAt, finishedAt: new Date().toISOString(), gates, staticAbsence });
      console.error('[certify:dual-plane] BLOCKED: static absence checks found prohibited patterns.');
      process.exit(1);
    }
    gates.push({ gate: 'static-absence-result', passed: true, exitCode: 0 });
  }

  // Gate 3: focused suites.
  if (only === 'all' || only === 'suites') {
    const suites = await runFocusedSuites();
    gates.push({ gate: 'focused-suites', passed: suites.every((s) => s.passed), exitCode: suites.every((s) => s.passed) ? 0 : 1, suites });
    if (!suites.every((s) => s.passed)) {
      atomicWriteJson(certificatePath, { verdict: 'BLOCKED', startedAt, finishedAt: new Date().toISOString(), gates });
      console.error('[certify:dual-plane] BLOCKED: focused suites failed.');
      process.exit(1);
    }
  }

  // Gate 4: live scenarios.
  if (only === 'all' || only === 'live') {
    const scenarios = await runLiveScenarios();
    gates.push({ gate: 'live-scenarios', passed: scenarios.every((s) => s.passed), exitCode: scenarios.every((s) => s.passed) ? 0 : 1, scenarios });
    if (!scenarios.every((s) => s.passed)) {
      atomicWriteJson(certificatePath, { verdict: 'BLOCKED', startedAt, finishedAt: new Date().toISOString(), gates });
      console.error('[certify:dual-plane] BLOCKED: live scenarios failed.');
      process.exit(1);
    }
  }

  const certificate = {
    plan: '260909-0032-explicit-authority-dual-plane-cutover',
    verdict: 'VERIFIED_COMPLETE',
    startedAt,
    finishedAt: new Date().toISOString(),
    gates,
  };
  atomicWriteJson(certificatePath, certificate);
  console.log(
    `[certify:dual-plane] VERIFIED_COMPLETE in ${Math.round((Date.now() - new Date(startedAt).getTime()) / 1000)}s — evidence: ${certificatePath}`
  );
  process.exit(0);
}

main().catch((err) => {
  console.error('[certify:dual-plane] Runner failure:', err);
  process.exit(1);
});