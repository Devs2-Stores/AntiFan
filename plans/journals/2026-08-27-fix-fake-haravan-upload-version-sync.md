---
title: Fix Fake Haravan Upload Success and Version Mismatch
date: 2026-08-27
summary: "Made Haravan uploader's simulated path honest (no false success claim), synced package.json/package-lock to v1.3.0 matching CHANGELOG. 255 tests green; pushed as 5af8b1a."
---

# Fix Fake Haravan Upload Success and Version Mismatch

Removed two contract lies from the shipped codebase.

> Historical work record — not durable authority. Prefer docs/specs/ADRs for current decisions.

## Root causes (OBSERVED)

1. `src/main/browser/haravan-uploader.ts:130-144` — `uploadImageToHaravan` never issued an upload request (comment admitted "simulate / delegate"); the simulated path fabricated a CDN URL, copied it to clipboard, showed "Upload thành công!", and returned `{ success: true }`. Real multipart upload is not implemented.

2. `package.json`/`package-lock.json` were pinned at `1.0.0` while `CHANGELOG.md` documents the current release as `v1.3.0` (2026-08-27). The manifest lagged the release docs.

## Fix (commit 5af8b1a)

- Simulated path is now honest: `success: false`, new additive field `predicted: true`, `message` explains real upload is unsupported, and the dialog is a warning ("Chưa upload — URL CDN dự kiến") instead of a success claim. Signature adds `predicted?: boolean` (additive, non-breaking).
- Blast radius: two context-menu call sites (`native-tab-host.ts:1283`, `tab-context-menu.ts:127`) ignore the return value — no caller breakage.
- Root version in `package.json` and `package-lock.json` bumped to `1.3.0`; dependency versions untouched.

## Verification

- `npm run verify` → 255 tests / 58 suites / 0 fail (matches baseline), typecheck pass.
- No automated test covers the uploader dialog path — the repo has no electron-mock convention in its node:test harness; verification for that path is typecheck + contract walk, stated honestly.

## Open

- Real Haravan multipart upload remains unimplemented (needs authenticated endpoint integration) — flag on feature list, not a bug fix.