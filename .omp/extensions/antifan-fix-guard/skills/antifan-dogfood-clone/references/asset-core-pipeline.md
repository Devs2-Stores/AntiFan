# Asset Core Localization Pipeline Reference

## 1. Overview
The AntiFan Asset Core (`AssetHarvester` and `AssetLocalizer` in `packages/site-clone/src/models/`) is a 3-phase, fail-closed subresource localization engine:
1. **A0 Harvesting**: Discovers all stylesheets, scripts, images, fonts, posters, and CSS `url(...)` declarations.
2. **A1 Hardened Download**: Streams files over an SSRF-protected, IP-pinned pipeline with sha256 checksums and atomic rename transactions.
3. **A2 Syntax-Aware Rewriting**: Rewrites HTML and CSS attributes to point to local assets (`assets/<filename>` or `/assets/<filename>`).
4. **A3 Verification Ledger**: Performs direct token audit ensuring zero remote network dependencies remain.

---

## 2. Complete Integration Example

```typescript
import { AssetHarvester } from '../packages/site-clone/dist/models/asset-harvester.js';
import { AssetLocalizer } from '../packages/site-clone/dist/models/asset-localizer.js';

// 1. Harvest from HTML
const harvester = new AssetHarvester();
const manifest = harvester.harvestFromHtml(html, assetsDir);

// 2. Download with SSRF guard and bounded concurrency
const localizer = new AssetLocalizer();
const downloadResult = await localizer.downloadAssets(manifest.images, {
  assetsDir: 'clone/<site>/assets',
  concurrency: 10,
  timeoutMs: 15000,
  maxAssetBytes: 50 * 1024 * 1024
});

// 3. Syntax-aware rewriting
const rewriteResult = localizer.rewriteFiles([
  { path: 'index.html', content: html }
], manifest, { mode: 'relative' });

const localizedHtml = rewriteResult.files[0].rewrittenContent;
```

---

## 3. Hardened Security Invariants
1. **IP Pinning & DNS Rebinding Guard**:
   `isPrivateOrReservedIp(ip)` blocks `127.0.0.0/8`, `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `169.254.0.0/16`, `100.64.0.0/10`, and IPv6 equivalents.
2. **Anti-Spoofing HTML Guard**:
   Inspects the first 128 bytes of every downloaded image/font stream. If it encounters `<!doctype` or `<html`, it rejects the asset as `REJECTED_HTML_ERROR_PAGE`.
3. **Atomic Transactions**:
   Downloads to `.${filename}.${randomBytes(6).hex}.tmp` and renames to `filename` only upon successful byte limit verification and sha256 checksum computation.
