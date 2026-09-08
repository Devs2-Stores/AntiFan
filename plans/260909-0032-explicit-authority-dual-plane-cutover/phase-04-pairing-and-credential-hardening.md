---
phase: 4
title: "Pairing & Credential Hardening"
status: pending
priority: P1
effort: "1d"
dependencies: [3]
---

# Phase 4: Pairing & Credential Hardening

## Overview

Replace reusable master-token discovery and URL transport with one-time pairing and scoped session credentials, then enforce real Windows filesystem confidentiality.

## Requirements

- Functional: Local MCP and mobile clients exchange a one-time code for a short-lived scoped credential.
- Functional: Pairing codes are single-use, bounded, revocable, and never equivalent to the master Bridge secret.
- Non-functional: Credentials never appear in URL query strings, logs, screenshots, clipboard payloads, or plaintext discovery manifests; Windows DACLs protect all credential paths.

## Architecture

Discovery exposes non-secret endpoint metadata. `POST /api/pairing/exchange` accepts a single-use code plus client class/instance identity. MCP receives an `ExecutionAttachment`; mobile receives a distinct bounded `MobileSessionGrant`. Autonomous local MCP atomically claims one per-client challenge from a bounded NTFS-protected runtime queue; concurrent proxies never share one consumable code. Mobile binds loopback by default; LAN exposure requires explicit user opt-in plus scoped pairing and firewall guidance. Atomic replacement reapplies restrictive directory and file DACLs to temporary and final paths.

## Related Code Files

- Modify: `src/main/bridge/bridge-server.ts`
- Modify: `scripts/antifan-omp-mcp.cjs`
- Modify: `src/main/security/windows-acl.ts`
- Modify: `src/main/bridge/mobile-remote-html.ts`
- Modify: `scripts/antifan-agent.cjs`
- Modify: storage/discovery helpers owning `bridge.json` and companion manifests
- Modify: bridge authentication, pairing, logging, and Windows ACL tests
- Delete: reusable master token fields from persisted discovery and QR/query payloads

## Implementation Steps

1. Inventory every bridge/master/attachment token generation, serialization, URL, logging, and comparison site.
2. Define pairing state keyed by hashed one-time code with TTL, intended client class, requested grant ceiling, consumed/revoked state, and attempt limit.
3. Publish endpoint metadata without reusable bearer secrets; proxy/mobile exchanges a code over the authenticated local pairing flow.
4. Issue MCP credentials through `AttachmentRegistry`; issue mobile credentials through a separate `MobileSessionGrant` owner; reject replay, expiry, over-grant, and client mismatch.
5. Remove token query authentication and redact credentials consistently from diagnostics, errors, telemetry, screenshots, and persisted payloads.
6. Extend `windows-acl.ts` with explicit file-level ACL enforcement; apply directory ACL after creation and file ACL after every atomic write/rename, then verify effective ownership and ACE inheritance.
7. Implement loopback-default mobile networking; explicit LAN opt-in controls bind address, advertised URL/QR, scoped authentication, and firewall guidance.
8. Add tests for single use, expiry, replay, concurrent queue claims, grant escalation, loopback/LAN policy, log/URL/config absence, token rotation, and unauthorized local users where testable.
9. Run Windows runtime proof inspecting effective ACLs and exercising concurrent MCP pairing plus opt-in mobile LAN pairing without secret-bearing URLs.

## Success Criteria

- [ ] Discovery files contain endpoint metadata only, no reusable bearer token.
- [ ] QR/mobile URL and WebSocket URL contain no master or attachment credential.
- [ ] One-time pairing code succeeds once and then rejects replay.
- [ ] Issued credentials have bounded scope and TTL and are revocable.
- [ ] Logs and errors contain no raw credential values.
- [ ] Credential directories/files retain restrictive Windows DACLs after rotation and atomic replacement.
- [ ] Mobile companion binds loopback by default and advertises LAN only after explicit opt-in.

<!-- Updated: Validation Session 1 - protected runtime queue; opt-in LAN -->

## Risk Assessment
- **Bootstrap deadlock:** removing the discovery token before pairing works would strand clients. Signal: fresh proxy cannot obtain an attachment. Response: implement and verify exchange first, then remove persisted secret in the same atomic release.
- **ACL inheritance drift:** atomic rename may restore permissive inherited ACLs. Signal: effective ACL after rotation differs from initial creation. Response: enforce and verify ACL on both temporary and final paths every write.
- **Pairing brute force:** short codes without rate limits are guessable. Signal: repeated failed exchanges do not throttle/expire state. Response: cryptographically random codes, short TTL, bounded attempts, loopback/local-presence policy.
- **Concurrent pairing starvation:** a single runtime-file code cannot bootstrap two proxies. Signal: the second concurrent proxy consumes an already-used code. Response: bounded per-client challenges with atomic claim/consume semantics and expiry cleanup.
