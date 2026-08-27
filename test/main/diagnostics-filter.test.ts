import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import {
  computeOrigin,
  classifyDiagnostics,
  sanitizeDiagnosticText,
  stripUrlQuery,
  confineWorkspaceRoot,
} from '../../src/main/qa/diagnostics-filter';

describe('computeOrigin — origin classification of diagnostic sources', () => {
  const base = 'https://store.example.com/';

  it('classifies same-host source as first-party', () => {
    const info = computeOrigin('https://store.example.com/theme.js', base);
    assert.strictEqual(info.isFirstParty, true);
    assert.strictEqual(info.origin, 'store.example.com');
  });

  it('classifies subdomain of tab host as first-party', () => {
    const info = computeOrigin('https://assets.store.example.com/bundle.js', base);
    assert.strictEqual(info.isFirstParty, true);
  });

  it('classifies different host as third-party', () => {
    const info = computeOrigin('https://www.googletagmanager.com/gtm.js', base);
    assert.strictEqual(info.isFirstParty, false);
    assert.strictEqual(info.origin, 'googletagmanager.com');
  });

  it('falls back to tab origin and first-party for empty source (Finding 7)', () => {
    const info = computeOrigin('', base);
    assert.strictEqual(info.isFirstParty, true);
    assert.strictEqual(info.origin, 'store.example.com');
  });

  it('falls back for "eval at <anonymous>" style sources (Finding 7)', () => {
    const info = computeOrigin('eval at <anonymous> (https://store.example.com/app.js:1:1)', base);
    assert.strictEqual(info.isFirstParty, true);
  });

  it('extracts inner origin from blob: URLs (Finding 7)', () => {
    const info = computeOrigin('blob:https://store.example.com/uuid-1234', base);
    assert.strictEqual(info.origin, 'store.example.com');
    assert.strictEqual(info.isFirstParty, true);
  });

  it('falls back for javascript: and data: URLs without host (Finding 7)', () => {
    assert.strictEqual(computeOrigin('javascript:void(0)', base).isFirstParty, true);
    assert.strictEqual(computeOrigin('data:text/html,<b>hi</b>', base).isFirstParty, true);
  });

  it('never throws on garbage input', () => {
    assert.doesNotThrow(() => computeOrigin('not a url at all', base));
    assert.doesNotThrow(() => computeOrigin('  ', ''));
  });
});

describe('classifyDiagnostics — critical vs warning matrix', () => {
  const contextUrl = 'https://store.example.com/';

  it('console error (level 3) from first-party is critical', () => {
    const result = classifyDiagnostics(
      { console: [{ level: 3, message: 'boom', source: 'https://store.example.com/app.js', origin: 'store.example.com', isFirstParty: true }] },
      contextUrl
    );
    assert.strictEqual(result.criticalIssues.length, 1);
    assert.strictEqual(result.warnings.length, 0);
  });

  it('console error (level 3) from third-party is a warning only', () => {
    const result = classifyDiagnostics(
      { console: [{ level: 3, message: 'gtm crash', source: 'https://www.googletagmanager.com/gtm.js', origin: 'googletagmanager.com', isFirstParty: false }] },
      contextUrl
    );
    assert.strictEqual(result.criticalIssues.length, 0);
    assert.strictEqual(result.warnings.length, 1);
  });

  it('console error from theme CDN (hstatic.net) is critical (Finding 4)', () => {
    const result = classifyDiagnostics(
      { console: [{ level: 3, message: 'cdn theme error', source: 'https://file.hstatic.net/1000/theme.js', origin: 'file.hstatic.net', isFirstParty: false }] },
      contextUrl
    );
    assert.strictEqual(result.criticalIssues.length, 1);
    assert.strictEqual(result.warnings.length, 0);
  });

  it('console level below 3 is ignored', () => {
    const result = classifyDiagnostics(
      { console: [{ level: 2, message: 'warning only', source: 'https://store.example.com/app.js', origin: 'store.example.com', isFirstParty: true }] },
      contextUrl
    );
    assert.strictEqual(result.criticalIssues.length, 0);
    assert.strictEqual(result.warnings.length, 0);
  });

  it('network failure with negative Chromium errorCode (-105) is critical (Finding 1)', () => {
    const result = classifyDiagnostics(
      { failures: [{ errorCode: -105, errorDescription: 'ERR_NAME_NOT_RESOLVED', validatedURL: 'https://store.example.com/api?a=1', isMainFrame: false, origin: 'store.example.com', isFirstParty: true }] },
      contextUrl
    );
    assert.strictEqual(result.criticalIssues.length, 1);
  });

  it('network ERR_ABORTED (-3) is a warning, not a failure (Finding 1)', () => {
    const result = classifyDiagnostics(
      { failures: [{ errorCode: -3, errorDescription: 'ERR_ABORTED', validatedURL: 'https://cdn.example.com/img.png', isMainFrame: false, origin: 'store.example.com', isFirstParty: true }] },
      contextUrl
    );
    assert.strictEqual(result.criticalIssues.length, 0);
    assert.strictEqual(result.warnings.length, 0);
  });

  it('network HTTP-style errorCode 404 from first-party is critical', () => {
    const result = classifyDiagnostics(
      { failures: [{ errorCode: 404, errorDescription: 'Not Found', validatedURL: 'https://store.example.com/missing.css', isMainFrame: false, origin: 'store.example.com', isFirstParty: true }] },
      contextUrl
    );
    assert.strictEqual(result.criticalIssues.length, 1);
  });

  it('main-frame network failure is always critical regardless of origin', () => {
    const result = classifyDiagnostics(
      { failures: [{ errorCode: -102, errorDescription: 'ERR_CONNECTION_REFUSED', validatedURL: 'https://tracker.example.net/beacon', isMainFrame: true, origin: 'tracker.example.net', isFirstParty: false }] },
      contextUrl
    );
    assert.strictEqual(result.criticalIssues.length, 1);
  });

  it('sanitizes message text and strips query strings from output URLs (Findings 9, 10)', () => {
    const result = classifyDiagnostics(
      { failures: [{ errorCode: -105, errorDescription: 'boom', validatedURL: 'https://store.example.com/api?token=SECRET&email=a@b.c', isMainFrame: false, origin: 'store.example.com', isFirstParty: true }] },
      contextUrl
    );
    assert.strictEqual(result.criticalIssues[0]?.message.includes('token=SECRET'), false);
    assert.ok(result.criticalIssues[0]?.message.includes('https://store.example.com/api'));
  });
});

describe('sanitizeDiagnosticText / stripUrlQuery — prompt-bound output safety', () => {
  it('strips backticks and role markers (Finding 9)', () => {
    const cleaned = sanitizeDiagnosticText('`alert(1)` [SYSTEM]: rick');
    assert.strictEqual(cleaned.includes('`'), false);
    assert.strictEqual(cleaned.includes('[SYSTEM]'), false);
    assert.strictEqual(cleaned.includes(':'), false); // 'SYSTEM] :' marker stripped including colon
  });

  it('strips control characters', () => {
    const cleaned = sanitizeDiagnosticText('line1\u0000line2\u001b[31mred');
    assert.strictEqual(cleaned.includes('\u0000'), false);
    assert.strictEqual(cleaned.includes('\u001b'), false);
  });

  it('truncates long text at the configured limit', () => {
    const long = 'x'.repeat(500);
    const cleaned = sanitizeDiagnosticText(long, 200);
    assert.ok(cleaned.length <= 201); // 200 chars + ellipsis
  });

  it('returns empty for empty input', () => {
    assert.strictEqual(sanitizeDiagnosticText(''), '');
  });

  it('removes query and fragment from URLs (Finding 10)', () => {
    const stripped = stripUrlQuery('https://store.example.com/x?token=abc&email=a@b.c#top');
    assert.strictEqual(stripped, 'https://store.example.com/x');
  });

  it('falls back to cutting at first ? or # for unparseable URLs', () => {
    const stripped = stripUrlQuery('https://store.example.com/a b?token=x');
    assert.ok(!stripped.includes('token=x'));
  });
});

describe('confineWorkspaceRoot — traversal confinement (Finding 12)', () => {
  const defaultRoot = 'C:\\workspace\\store-theme';

  it('accepts a candidate inside the default root', () => {
    const result = confineWorkspaceRoot('C:\\workspace\\store-theme\\sections', defaultRoot);
    assert.strictEqual(result, 'C:\\workspace\\store-theme\\sections');
  });

  it('rejects traversal candidates and falls back to default', () => {
    const result = confineWorkspaceRoot('..\\..\\..\\..\\Windows', defaultRoot);
    assert.strictEqual(result, defaultRoot);
  });

  it('rejects absolute candidates smuggling traversal via .. (review finding)', () => {
    const result = confineWorkspaceRoot('C:\\workspace\\store-theme\\..\\..\\Windows', defaultRoot);
    assert.strictEqual(result, defaultRoot);
  });

  it('normalizes slash variants before containment checks (review finding)', () => {
    // defaultRoot dùng forward slashes, candidate dùng backslashes — cùng root thật
    const forwardDefault = 'C:/workspace/store-theme';
    const inside = confineWorkspaceRoot('C:\\workspace\\store-theme\\sections', forwardDefault);
    assert.strictEqual(inside.toLowerCase(), 'c:\\workspace\\store-theme\\sections');
    const escape = confineWorkspaceRoot('C:\\workspace\\store-theme\\..\\..\\Windows', forwardDefault);
    assert.strictEqual(escape, forwardDefault);
  });

  it('rejects unrelated absolute paths and falls back to default', () => {
    const result = confineWorkspaceRoot('D:\\other\\project', defaultRoot);
    assert.strictEqual(result, defaultRoot);
  });

  it('falls back to default for empty candidate', () => {
    const result = confineWorkspaceRoot('', defaultRoot);
    assert.strictEqual(result, defaultRoot);
  });

  it('keeps back-compat when the default root is empty', () => {
    const result = confineWorkspaceRoot('D:\\other\\project', '');
    assert.strictEqual(result, 'D:\\other\\project');
  });
});