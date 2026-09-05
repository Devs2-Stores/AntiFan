'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const CAPABILITY_INVOCATIONS_PER_BATCH = 25;
const ARTIFACT_WRITES_PER_BATCH = 2;
const RECEIPT_WRITES_PER_BATCH = 4;
const CERTIFICATION_BATCH_COUNT = 3;
const CAPABILITY_TIMEOUT_MS = 30_000;

function withTimeout(label, promise, timeoutMs = CAPABILITY_TIMEOUT_MS) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} exceeded ${timeoutMs}ms`)), timeoutMs);
    }),
  ]).finally(() => clearTimeout(timer));
}


function copyDirectory(source, destination) {
  fs.mkdirSync(destination, { recursive: true });
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const from = path.join(source, entry.name);
    const to = path.join(destination, entry.name);
    if (entry.isDirectory()) copyDirectory(from, to);
    else if (entry.isFile()) fs.copyFileSync(from, to);
  }
}

function prepareFreezeFixture(rootDir, tempRoot) {
  const workspaceRoot = path.join(tempRoot, 'workspace');
  const productRoot = path.join(rootDir, 'test', 'fixtures', 'golden-workflow', 'product-card');
  const drawerRoot = path.join(rootDir, 'test', 'fixtures', 'golden-workflow', 'hamburger-drawer');
  copyDirectory(path.join(productRoot, 'theme'), workspaceRoot);
  copyDirectory(path.join(drawerRoot, 'theme'), workspaceRoot);
  fs.mkdirSync(path.join(workspaceRoot, 'storefront'), { recursive: true });
  const productHtml = fs.readFileSync(path.join(productRoot, 'storefront', 'index.html'), 'utf8')
    .replace('../theme/assets/component-card.css', '/assets/component-card.css');
  fs.writeFileSync(path.join(workspaceRoot, 'storefront', 'index.html'), productHtml, 'utf8');
  fs.copyFileSync(
    path.join(drawerRoot, 'storefront', 'index.html'),
    path.join(workspaceRoot, 'storefront', 'drawer.html')
  );
  return workspaceRoot;
}

function startFreezeFixtureServer(workspaceRoot) {
  const server = http.createServer((request, response) => {
    const requestUrl = new URL(request.url || '/', 'http://127.0.0.1');
    const routes = new Map([
      ['/', ['storefront/index.html', 'text/html; charset=utf-8']],
      ['/index.html', ['storefront/index.html', 'text/html; charset=utf-8']],
      ['/drawer.html', ['storefront/drawer.html', 'text/html; charset=utf-8']],
      ['/assets/component-card.css', ['assets/component-card.css', 'text/css; charset=utf-8']],
      ['/assets/component-drawer.css', ['assets/component-drawer.css', 'text/css; charset=utf-8']],
    ]);
    const route = routes.get(requestUrl.pathname);
    if (!route) {
      response.writeHead(404, { 'Cache-Control': 'no-store' });
      response.end('Not Found');
      return;
    }
    response.writeHead(200, { 'Content-Type': route[1], 'Cache-Control': 'no-store, max-age=0' });
    response.end(fs.readFileSync(path.join(workspaceRoot, route[0])));
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('Freeze fixture server did not expose a TCP port'));
        return;
      }
      resolve({
        server,
        productUrl: `http://127.0.0.1:${address.port}/index.html`,
        drawerUrl: `http://127.0.0.1:${address.port}/drawer.html`,
      });
    });
  });
}

async function closeFreezeFixtureServer(server) {
  if (!server) return;
  try { server.closeAllConnections?.(); } catch {}
  await new Promise((resolve) => server.close(() => resolve()));
}

function createBrowserControl(rootDir, tabHost, runtime) {
  const { BrowserControlPort } = require(path.join(rootDir, '.compiled', 'src', 'main', 'tools', 'browser-control-port.js'));
  const browser = new BrowserControlPort({
    getTabList: () => tabHost.getTabList(),
    getBrowserEpoch: () => tabHost.getBrowserEpoch(),
    getActiveTabId: () => tabHost.getActiveTabId(),
    getAutomationTabId: () => tabHost.getAutomationTabId(),
    setAutomationTabId: (id) => tabHost.setAutomationTabId(id),
    createTab: (url, activate = false) => tabHost.createTab(url, activate),
    closeTab: (id) => tabHost.closeTab(id),
    switchTab: (id) => tabHost.switchTab(id),
    navigate: (id, url) => tabHost.navigateAndWait(id, url),
    reload: (id) => tabHost.reloadAndWait(id),
    getDom: (selector, id, paneId) => tabHost.getDom(selector, id, paneId),
    captureScreenshot: (rect, id, paneId, options) => tabHost.captureScreenshot(rect, id, paneId, options),
    evalJs: (expression, id, paneId) => tabHost.evalJs(expression, id, paneId),
    getDocumentGeneration: (id) => tabHost.getDocumentGeneration(id),
    getMutationRevision: (id) => tabHost.getMutationRevision(id),
    bumpMutationRevision: (id) => tabHost.bumpMutationRevision(id),
    isCurrentTarget: (target) => tabHost.isCurrentTarget(target),
    getDiagnostics: (id, level) => tabHost.getDiagnostics(id, level),
    runResponsiveCheck: (params) => tabHost.runResponsiveCheck(params),
    agentTrajectory: (params) => tabHost.agentTrajectory(params),
    dispatchAgentAction: (action, params) => tabHost.dispatchAgentAction(action, params),
    agentMove: (args) => tabHost.agentMove(args),
    agentClick: (params) => tabHost.agentClick(params),
    agentType: (params) => tabHost.agentType(params),
    agentScroll: (params) => tabHost.agentScroll(params),
    agentHover: (params) => tabHost.agentHover(params),
    agentHighlight: (params) => tabHost.agentHighlight(params),
    agentClear: (id, paneId) => tabHost.agentClear(id, paneId),
    agentSnapshot: (id, paneId, selector, viewportOnly) => tabHost.agentSnapshot(id, paneId, selector, viewportOnly),
    agentFind: (params) => tabHost.agentFind(params),
    sendKeyboardPress: (params) => tabHost.sendKeyboardPress(params),
    inspectStyles: (params) => tabHost.inspectStyles(params),
    inspectRegion: (params) => tabHost.inspectRegion(params),
    inspectFont: (params) => tabHost.inspectFont(params),
    getMatchedStylesForNode: (params) => tabHost.getMatchedStylesForNode(params),
    setViewportSize: (options) => tabHost.setViewportSize(options),
    setDevicePreset: (id, presetId) => tabHost.setDevicePreset(id, presetId),
    getDevicePresets: () => tabHost.getDevicePresets(),
    getTabViewportMetrics: (id, paneId) => tabHost.getTabViewportMetrics(id, paneId),
  }, runtime.artifacts);
  tabHost.setViewportGate(browser.viewportGate);
  runtime.registerBrowser(browser);
  return browser;
}

function certificationWorkloadCounts() {
  return {
    capabilityInvocations: CAPABILITY_INVOCATIONS_PER_BATCH * CERTIFICATION_BATCH_COUNT,
    artifactWrites: ARTIFACT_WRITES_PER_BATCH * CERTIFICATION_BATCH_COUNT,
    receiptWrites: RECEIPT_WRITES_PER_BATCH * CERTIFICATION_BATCH_COUNT,
  };
}

async function runThemeProbeBatch(options) {
  const { runtime, session, tabHost, tabId, productUrl, drawerUrl, workspaceRoot, batchIndex } = options;
  const counters = { capabilityInvocations: 0, artifactWrites: 0, receiptWrites: 0 };
  const canaries = {
    staleAuthorityAcceptedCount: 0,
    staleDocumentAcceptedCount: 0,
    staleMutationVerifiedCount: 0,
    falseClaimVerifiedCount: 0,
  };
  let authorityRevision = runtime.runs.attachments.getAttachment(session.launch.attachmentId)?.authorityRevision || session.launch.authorityRevision;
  let dispatchSequence = 0;

  const dispatch = async (name, params = {}, expectations = {}) => {
    dispatchSequence += 1;
    if (expectations.ledgerOwned !== false) counters.capabilityInvocations += 1;
    console.log(`[core-freeze] batch ${batchIndex} dispatch ${dispatchSequence}: ${name}`);
    const response = await withTimeout(
      `Batch ${batchIndex} capability ${dispatchSequence} (${name})`,
      runtime.transport.dispatchIntent({
        requestId: `freeze-${batchIndex}-${dispatchSequence}-${crypto.randomUUID()}`,
        idempotencyKey: `freeze-${batchIndex}-${dispatchSequence}-${crypto.randomUUID()}`,
        attachmentId: session.launch.attachmentId,
        attachmentSecret: session.launch.secret,
        authorityRevision: expectations.authorityRevision || authorityRevision,
        name,
        params,
      })
    );
    if (response.replacementAuthorityRevision) authorityRevision = response.replacementAuthorityRevision;
    if (expectations.ok === false) {
      assert.equal(response.ok, false, `${name} must be rejected`);
      if (expectations.errorCodes) assert.ok(expectations.errorCodes.includes(response.error?.code), `${name} rejected with ${response.error?.code}`);
    } else {
      assert.equal(response.ok, true, `${name} failed: ${response.error?.code || ''} ${response.error?.message || ''}`);
    }
    return response;
  };

  assert.equal(
    tabHost.setViewportSize({ width: 1024, height: 900, mobile: false, deviceScaleFactor: 1, tabId }),
    true,
    'Product Card viewport must be configured'
  );
  const productNavigation = await dispatch('anti.browser.navigate', { url: productUrl, tabId });
  assert.equal(productNavigation.data?.navigated, true);

  const screenshot = await dispatch('anti.screenshot.viewport', { tabId, format: 'png' });
  assert.equal(screenshot.data?.mime, 'image/png');
  assert.ok(screenshot.data?.byteLength > 8);
  counters.artifactWrites += 1;

  const dom = await dispatch('anti.inspect.dom', { selector: '.product-card', tabId });
  assert.equal(dom.data?.kind, 'dom');
  counters.artifactWrites += 1;

  const preStyles = await dispatch('anti.inspect.styles', { selector: '.product-card', properties: ['margin-top'], tabId });
  const beforeMargin = preStyles.data?.styles?.['margin-top'];
  assert.ok(beforeMargin === '24px' || beforeMargin === '31px');

  const preMatched = await dispatch('anti.inspect.matched_styles', { selector: '.product-card', tabId });
  assert.equal(preMatched.data?.data?.definitionOfDone, 'STRONG PASS');
  assert.equal(preMatched.data?.signals?.hasSourceRange, true);

  const source = await dispatch('anti.theme.resolve_element', { selector: '.product-card', workspaceRoot, tabId });
  assert.equal(source.data?.data?.ambiguous, false);
  assert.equal(source.data?.data?.primaryCandidate?.file, 'snippets/card-product.liquid');
  assert.equal(source.data?.data?.primaryCandidate?.confidence, 'HIGH');

  const cssPath = path.join(workspaceRoot, 'assets', 'component-card.css');
  const initialCss = fs.readFileSync(cssPath, 'utf8');
  const nextMargin = beforeMargin === '24px' ? '31px' : '24px';
  const updatedCss = initialCss.replace(/(\.product-card\s*\{\s*margin-top:\s*)(24|31)px;/, `$1${nextMargin};`);
  assert.notEqual(updatedCss, initialCss, 'Product card mutation target must change');
  const write = await dispatch('file.write', { path: 'assets/component-card.css', content: updatedCss });
  assert.equal(write.data?.sha256, crypto.createHash('sha256').update(updatedCss).digest('hex'));

  const reload = await dispatch('anti.browser.reload', { tabId });
  assert.equal(reload.data?.reloaded, true);
  assert.equal(
    tabHost.setViewportSize({ width: 1024, height: 900, mobile: false, deviceScaleFactor: 1, tabId }),
    true,
    'Product Card viewport must be restored after reload'
  );
  const postReloadWidth = await tabHost.evalJs('window.innerWidth', tabId);
  assert.equal(postReloadWidth, 1024, 'Product Card mutation evidence requires a 1024px rendered viewport');

  const postStyles = await dispatch('anti.inspect.styles', { selector: '.product-card', properties: ['margin-top'], tabId });
  assert.equal(postStyles.data?.styles?.['margin-top'], nextMargin);
  const postMatched = await dispatch('anti.inspect.matched_styles', { selector: '.product-card', tabId });
  assert.equal(postMatched.data?.data?.definitionOfDone, 'STRONG PASS');
  assert.ok(postMatched.data?.data?.activeRules?.some((rule) => rule.property === 'margin-top' && rule.value === nextMargin));

  const responsive = await dispatch('anti.inspect.responsive_matrix', { selector: '.product-card', tabId });
  assert.equal(responsive.data?.signals?.allBreakpointsTested, true);
  assert.equal(responsive.data?.signals?.hasTargetOverflow, false);
  assert.equal(responsive.data?.signals?.hasDocOverflow, false);

  const productClaim = await dispatch('anti.verification.record_claim', {
    claim: `Freeze batch ${batchIndex}: Product card source, active CSS, mutation, and responsive boundaries are proven`,
    category: 'CUSTOM',
    actor: 'agent',
    tabId,
    selector: '.product-card',
    proofObligations: [
      { id: 'source', metric: 'theme.source_mapping.file_identified', expected: true, critical: true },
      { id: 'css-active', metric: 'theme.css.active_rule_matched', expected: true, critical: true },
      { id: 'target-overflow', metric: 'theme.responsive.no_target_overflow', expected: true, critical: true },
      { id: 'css-strong', metric: 'theme.css.strong_pass_resolved', expected: true, critical: true },
      { id: 'document-overflow', metric: 'theme.responsive.no_doc_overflow', expected: true },
    ],
  });
  const productVerification = await dispatch('anti.verification.verify_claim', { claimId: productClaim.data?.id });
  counters.receiptWrites += 1;
  assert.equal(productVerification.data?.verdict, 'VERIFIED');

  await dispatch('browser.set-viewport', { width: 375, height: 667, mobile: true, deviceScaleFactor: 2, tabId });
  const drawerNavigation = await dispatch('anti.browser.navigate', { url: drawerUrl, tabId });
  assert.equal(drawerNavigation.data?.navigated, true);

  const staleMutationClaim = await dispatch('anti.verification.record_claim', {
    claim: `Freeze batch ${batchIndex}: Drawer changed before an interaction occurred`,
    category: 'INTERACTION',
    actor: 'agent',
    tabId,
    selector: '#menu-toggle',
  });
  const staleMutationVerification = await dispatch('anti.verification.verify_claim', { claimId: staleMutationClaim.data?.id });
  counters.receiptWrites += 1;
  if (staleMutationVerification.data?.verdict === 'VERIFIED') canaries.staleMutationVerifiedCount += 1;
  assert.equal(staleMutationVerification.data?.verdict, 'INCONCLUSIVE');

  const drawerClaim = await dispatch('anti.verification.record_claim', {
    claim: `Freeze batch ${batchIndex}: Trusted Chromium click opens the drawer without overflow`,
    category: 'INTERACTION',
    actor: 'agent',
    tabId,
    selector: '#menu-toggle',
  });
  const drawerTrace = await dispatch('anti.trace.interaction', { action: 'click', selector: '#menu-toggle', settleMs: 180, tabId });
  assert.equal(drawerTrace.data?.interactionMode, 'trusted_cdp');
  assert.equal(drawerTrace.data?.verified, true);
  assert.equal(drawerTrace.data?.verdict, 'DRAWER_EXPANDED');
  const drawerVerification = await dispatch('anti.verification.verify_claim', { claimId: drawerClaim.data?.id });
  counters.receiptWrites += 1;
  assert.equal(drawerVerification.data?.verdict, 'VERIFIED');

  const drawerResponsive = await dispatch('anti.inspect.responsive_matrix', { selector: '#site-drawer', tabId });
  assert.equal(drawerResponsive.data?.signals?.hasTargetOverflow, false);
  assert.equal(drawerResponsive.data?.signals?.hasDocOverflow, false);

  const noOpClaim = await dispatch('anti.verification.record_claim', {
    claim: `Freeze batch ${batchIndex}: No-op control produced a completed transition`,
    category: 'INTERACTION',
    actor: 'agent',
    tabId,
    selector: '#noop-action',
  });
  const noOpTrace = await dispatch('anti.trace.interaction', { action: 'click', selector: '#noop-action', settleMs: 120, tabId });
  assert.equal(noOpTrace.data?.actionSuccess, true);
  assert.equal(noOpTrace.data?.verified, false);
  assert.equal(noOpTrace.data?.verdict, 'NO_OBSERVABLE_EFFECT');
  const noOpVerification = await dispatch('anti.verification.verify_claim', { claimId: noOpClaim.data?.id });
  counters.receiptWrites += 1;
  if (noOpVerification.data?.verdict === 'VERIFIED') canaries.falseClaimVerifiedCount += 1;
  assert.equal(noOpVerification.data?.verdict, 'REJECTED');

  const currentDocumentGeneration = tabHost.getDocumentGeneration(tabId);
  const attachment = runtime.runs.attachments.getAttachment(session.launch.attachmentId);
  assert.ok(attachment?.browserTarget);
  const staleDocumentRevision = await runtime.runs.attachments.rotateAuthorityRevision(session.launch.attachmentId, {
    tabId,
    documentGeneration: Math.max(1, currentDocumentGeneration - 1),
    browserTarget: { ...attachment.browserTarget, tabId, documentGeneration: Math.max(1, currentDocumentGeneration - 1) },
  });
  authorityRevision = staleDocumentRevision;
  const staleDocumentResponse = await dispatch(
    'anti.trace.interaction',
    { action: 'click', selector: '#noop-action', settleMs: 20, tabId },
    { ok: false, errorCodes: ['TARGET_STALE'] }
  );
  if (staleDocumentResponse.ok) canaries.staleDocumentAcceptedCount += 1;

  const currentAttachment = runtime.runs.attachments.getAttachment(session.launch.attachmentId);
  assert.ok(currentAttachment?.browserTarget);
  authorityRevision = await runtime.runs.attachments.rotateAuthorityRevision(session.launch.attachmentId, {
    tabId,
    documentGeneration: currentDocumentGeneration,
    browserTarget: { ...currentAttachment.browserTarget, tabId, documentGeneration: currentDocumentGeneration },
  });
  const staleAuthorityResponse = await dispatch(
    'anti.inspect.dom',
    { selector: 'body', tabId },
    { ok: false, errorCodes: ['REVISION_STALE'], authorityRevision: staleDocumentRevision, ledgerOwned: false }
  );
  if (staleAuthorityResponse.ok) canaries.staleAuthorityAcceptedCount += 1;

  assert.deepEqual(counters, {
    capabilityInvocations: CAPABILITY_INVOCATIONS_PER_BATCH,
    artifactWrites: ARTIFACT_WRITES_PER_BATCH,
    receiptWrites: RECEIPT_WRITES_PER_BATCH,
  });
  return {
    counters,
    canaries,
    positiveVerdicts: { productCard: productVerification.data?.verdict, drawer: drawerVerification.data?.verdict },
    negativeVerdicts: { staleMutation: staleMutationVerification.data?.verdict, noOp: noOpVerification.data?.verdict },
  };
}

module.exports = {
  CAPABILITY_INVOCATIONS_PER_BATCH,
  ARTIFACT_WRITES_PER_BATCH,
  RECEIPT_WRITES_PER_BATCH,
  CERTIFICATION_BATCH_COUNT,
  CAPABILITY_TIMEOUT_MS,
  withTimeout,
  certificationWorkloadCounts,
  prepareFreezeFixture,
  startFreezeFixtureServer,
  closeFreezeFixtureServer,
  createBrowserControl,
  runThemeProbeBatch,
};
