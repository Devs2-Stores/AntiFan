const fs = require('fs');

const file = 'e:/Work/apps/antigravity-browser/src/proxyServer.ts';
let code = fs.readFileSync(file, 'utf8');

const targetOld = `            const requestIsDocument = !req.headers['sec-fetch-dest'] || req.headers['sec-fetch-dest'] === 'document';
            if (redirectOrigin !== targetUrlObj.origin && !requestIsDocument) {
              targetRes.resume();
              res.writeHead(403, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' });
              res.end('Cross-origin subresource redirect blocked for this browser session');
              return;
            }
            if (redirectOrigin !== targetUrlObj.origin) {
              const resolvedRedirect = await resolveTargetAddress(redirectUrl.hostname);
              targetRes.resume();
              if (resolvedRedirect.networkClass !== 'public') {
                res.writeHead(403, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' });
                res.end('Private cross-origin redirect blocked for this browser session');
                return;
              }
              const redirectJson = JSON.stringify({ url: redirectUrl.href, networkClass: 'public' }).replace(/</g, '\\\\u003c');
              res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
              res.end(\`<script>window.__AG_TRUSTED_REDIRECT__=\${redirectJson}</script><script src="/__antigravity_inspector.js?session=\${encodeURIComponent(session)}&auth=\${sessionAuth.value}"></script>\`);
              return;
            }`;

const targetNew = `            const requestIsDocument = !req.headers['sec-fetch-dest'] || req.headers['sec-fetch-dest'] === 'document';
            if (redirectOrigin !== targetUrlObj.origin) {
              const resolvedRedirect = await resolveTargetAddress(redirectUrl.hostname);
              if (resolvedRedirect.networkClass !== 'public') {
                targetRes.resume();
                res.writeHead(403, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' });
                res.end('Private cross-origin redirect blocked for this browser session');
                return;
              }
              if (requestIsDocument) {
                targetRes.resume();
                const redirectJson = JSON.stringify({ url: redirectUrl.href, networkClass: 'public' }).replace(/</g, '\\\\u003c');
                res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
                res.end(\`<script>window.__AG_TRUSTED_REDIRECT__=\${redirectJson}</script><script src="/__antigravity_inspector.js?session=\${encodeURIComponent(session)}&auth=\${sessionAuth.value}"></script>\`);
                return;
              }
            }`;

if (code.includes(targetOld)) {
  code = code.replace(targetOld, targetNew);
  fs.writeFileSync(file, code, 'utf8');
  console.log('SUCCESS: proxyServer.ts updated!');
} else {
  console.log('Target block not matched directly, checking normalized replacement');
  // Normalize newlines and replace
  const lines = code.split('\n');
  const findIdx = lines.findIndex(l => l.includes('Cross-origin subresource redirect blocked for this browser session'));
  if (findIdx !== -1) {
    console.log('Found block at line', findIdx);
    // Remove the blocking if statement
    let startIdx = findIdx - 1;
    while (startIdx > 0 && !lines[startIdx].includes('if (redirectOrigin !== targetUrlObj.origin && !requestIsDocument)')) {
      startIdx--;
    }
    let endIdx = findIdx + 1;
    while (endIdx < lines.length && !lines[endIdx].includes('return;')) {
      endIdx++;
    }
    if (lines[endIdx + 1].includes('}')) endIdx++;
    lines.splice(startIdx, endIdx - startIdx + 1);
    code = lines.join('\n');
    fs.writeFileSync(file, code, 'utf8');
    console.log('SUCCESS: proxyServer.ts stripped blocking subresource redirect check!');
  } else {
    console.log('Already clean!');
  }
}
