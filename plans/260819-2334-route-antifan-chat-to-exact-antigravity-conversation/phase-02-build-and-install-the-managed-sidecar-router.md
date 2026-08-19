---
phase: 2
title: "Build and install the managed Sidecar router"
status: completed
priority: P0
effort: "1-2 days"
dependencies: [1]
---

# Phase 02: Build and Install the Managed Sidecar Router

## Context Links

- Plan: [plan.md](./plan.md)
- Required evidence: [Phase 01](./phase-01-start.md)
- Current extension bridge:
  `E:/Work/apps/antigravity-browser/src/desktopCommandBridge.ts`

## Overview

Build a zero-dependency Node Sidecar that owns one dedicated inbox, invokes
`agentapi send-message`, and writes truthful results. Add explicit install,
enable, update, and removal commands without overwriting unrelated Gemini config.

## Requirements

- Functional: Sidecar ID is `antifan-chat-router`; config uses documented
  `command`, `args`, `restart_policy`, `description`, and `display_name` fields.
- Functional: use `ANTIGRAVITY_EXECUTABLE_DATA_DIR` for inbox, results,
  heartbeat, idempotency records, and logs.
- Functional: accept only exact `send-message` commands with conversation ID,
  prompt, workspace identity, source command ID, digests, expiry, and optional
  staged file refs.
- Functional: authenticate canonical request/result records with a per-install
  HMAC key and reject mismatched bindings. This protects against corruption and
  accidental injection, not a malicious process running as the same OS user.
- Functional: atomically claim each command once and persist the lifecycle
  `queued -> claimed -> invoking -> accepted|failed|unknown`.
- Functional: run one global single-flight worker. Do not claim or invoke the
  next command until the current command is terminal.
- Functional: expose heartbeat/capabilities including protocol version,
  per-MIME attachment mode, maximum prompt bytes, and maximum staged refs.
- Functional: install/update script copies built files and merges only the
  Sidecar entry in `~/.gemini/config/config.json`; it pins the Phase 1 verified
  absolute Node and router paths. Removal deletes only hash-matching owned files.
- Non-functional: no network listener, arbitrary executable field, prompt/body
  logging, shell interpolation, or automatic retry after an unknown outcome.
- Non-functional: acknowledge prompt argv visibility to the current OS user;
  persisted logs and receipts contain only digest, length, IDs, and bounded errors.

## Architecture

```text
~/.gemini/antigravity/sidecar_data/antifan-chat-router/data/
  host.json
  commands/cmd-<id>.json
  processing/cmd-<id>.<instance>.json
  results/cmd-<id>.res.json
  completed/<command-id>.json

Correct workspace Extension Host (Phase 3)
  -> write exact request to Sidecar command inbox

Antigravity-managed Sidecar
  poll oldest command -> validate HMAC/bindings -> atomic rename -> claimed
  -> persist invoking before spawn -> idempotency check
  -> agentapi send-message <conversationId> <prompt>
  -> classify accepted / failed / unknown -> signed atomic result
```

This path is separate from `<workspace>/.antigravity/mcp-bridge`. The extension
claims the Desktop command using the cooked protocol, then creates a second,
correlated request for the Sidecar. Sidecar never scans workspace bridge files.

## Protocol Contract

Command v1 minimum fields:

```json
{
  "protocolVersion": 1,
  "id": "sidecar-request-...",
  "sourceCommandId": "workspace-command-...",
  "createdAtEpochMs": 0,
  "expiresAtEpochMs": 0,
  "conversationId": "...",
  "expectedSidecarInstanceId": "sidecar-instance-...",
  "workspacePath": "E:/Work/project",
  "promptText": "...",
  "promptDigest": "sha256",
  "attachments": [],
  "attachmentManifestDigest": "sha256",
  "authTag": "hmac-sha256"
}
```

Result preserves existing delivery vocabulary and adds route/provider evidence
only in metadata. `ide-api-accepted` is emitted only when the Phase 1 evidence
defines a positive `agentapi` acceptance signal. Ambiguous termination is
`unknown`, never `failed` or retried.

Every signed result echoes `id`, `sourceCommandId`, `conversationId`, the
expected and actual Sidecar instance IDs, normalized `workspacePath`, prompt
digest, attachment manifest digest/count, lifecycle state, start/completion
timestamps, delivery state, and bounded provider evidence. The extension
ignores/quarantines any
result that does not match the request exactly.

## Recovery Contract

- `claimed` with no persisted `invoking` transition proves the child was not
  started; restart writes a deterministic `failed` result and does not resend.
- The router persists `invoking` before spawning `agentapi`. Any restart that
  finds `invoking` writes `unknown`; it never replays the command.
- A queued request addressed to a stale Sidecar instance fails before
  invocation. A request already in `invoking` remains `unknown` after restart.
- `accepted`, `failed`, and `unknown` are terminal idempotency barriers.
- Commands are ordered by `createdAtEpochMs`, then ID, and processed globally
  one at a time.

## Related Code Files

- Create: `E:/Work/apps/antigravity-browser/sidecars/antifan-chat-router/router.mjs`
  - standalone validation, polling, claim, `agentapi`, result, heartbeat, teardown.
- Create: `E:/Work/apps/antigravity-browser/sidecars/antifan-chat-router/sidecar.json`
  - source configuration template; installer writes verified absolute command
    and router paths into the owned Gemini entry.
- Create: `E:/Work/apps/antigravity-browser/scripts/install-sidecar.mjs`
  - install/update/remove with backup and ownership checks.
- Modify: `E:/Work/apps/antigravity-browser/package.json`
  - compile/install/remove/verify commands for Sidecar artifacts.
- Create:
  `E:/Work/apps/antigravity-browser/test/sidecar-conversation-router.test.cjs`
  - protocol, claim, timeout, idempotency, child-process seam, cleanup.
- Create: `E:/Work/apps/antigravity-browser/test/sidecar-install.test.cjs`
  - config merge, concurrent update, manifest ownership, update/remove, Windows paths.

## Implementation Steps

1. Freeze canonical request/result/host v1 contracts from Phase 1 evidence with
   bounded validators for IDs, prompt bytes, expiry, normalized workspace,
   digest, per-MIME attachment count/bytes, and HMAC.
2. Implement the router with injectable filesystem, clock, and `agentapi` runner
   seams. Keep the resolved `agentapi` executable and action constant and use
   argument arrays without shell interpolation.
3. Add global single-flight polling, deterministic ordering, atomic claim, and
   durable `claimed`/`invoking` transitions before child spawn.
4. Implement recovery exactly as specified above. Never replay a processing
   record whose invocation may have begun.
5. Translate proven acceptance/failure/ambiguous signals into existing delivery
   states and write a fully bound signed result atomically.
6. Write `host.json` heartbeat with Sidecar instance ID, verified Node/agentapi
   fingerprints, protocol version, and per-MIME capabilities.
7. Generate a random per-install HMAC key under the current user's owned install
   directory. Keep it out of config and logs; document same-user limitations.
8. Add installer/update/remove flow using read-hash/re-read comparison and an
   atomic temp replacement. Preserve unrelated fields, store an ownership
   manifest/revision/hashes, and refuse removal of replaced or modified files.
9. Write the verified absolute Node executable into the Sidecar config; never
   rely on ambient PATH. Back up config before the compare-and-replace step.
10. Add unit and integration tests using an injected fake `agentapi` runner;
    keep the live probe as a separate acceptance test.

## Todo

- [ ] Lock Sidecar command/result/host v1 contracts.
- [ ] Implement safe `agentapi` runner and router lifecycle.
- [ ] Implement serialized durable claim/recovery/idempotency.
- [ ] Bind and authenticate request/result records.
- [ ] Add heartbeat/capability discovery.
- [ ] Add concurrent-safe owned install/update/remove commands.
- [ ] Cover router and installer failure modes.

## Success Criteria

- [ ] Two router instances seeing one command invoke `agentapi` at most once.
- [ ] Duplicate command ID never invokes `agentapi` twice, including restart.
- [ ] Commands run globally one at a time in deterministic order.
- [ ] Expired/malformed commands never invoke `agentapi` and receive bounded
  failure evidence when safe to correlate.
- [ ] Crash in `claimed` produces deterministic failure with zero child spawn;
  crash in `invoking` produces `unknown` and no retry.
- [ ] Timeout/ambiguous child termination produces `unknown`, a terminal
  idempotency barrier, and no retry.
- [ ] Forged, wrong-key, or binding-mismatched results are rejected.
- [ ] Installer preserves unrelated `config.json` bytes semantically and can be
  rerun idempotently; concurrent config mutation aborts instead of overwriting.
- [ ] Removal refuses to delete installed files whose hashes no longer match the
  ownership manifest.
- [ ] Installed config contains the verified absolute Node/router paths.
- [ ] `npm test` and compile pass in `E:/Work/apps/antigravity-browser`.

## Risk Assessment

| Risk / assumption | Observable break signal | Pre-decided response |
|---|---|---|
| Runtime data path is stable and user-scoped | Env missing or path outside Gemini data | Fail startup; do not fall back to CWD |
| Atomic rename is sufficient for one-user Windows | Duplicate invocation test fails | Add exclusive lock file within Sidecar data only |
| Crash occurs after API accept but before result | Processing file remains with no result | Mark `unknown`; never replay automatically |
| Config changes during install | Read hash differs before replace | Abort safely; ask user to rerun after current writer finishes |
| Installed file ownership changed | Manifest hash differs on update/remove | Refuse overwrite/delete and report the exact path |
| Prompt appears in logs | Test finds prompt/body in stdout/stderr records | Log digest/length only; redact child output |
| Same-user process forges a valid request | Process can read the install key | Accept as explicit personal-tool trust limit; do not claim hostile same-user isolation |

## Security Considerations

- Reject traversal, symlink/reparse escapes, and attachment refs outside the
  declared existing workspace.
- Never accept executable names, arbitrary agentapi subcommands, env overrides,
  or shell fragments from command JSON.
- Canonically HMAC request/result records and verify every echoed binding before
  accepting a result.
- Bound prompt, error, file count, and persisted record size.
- Do not store credentials; Antigravity owns the Sidecar environment.
- Document that prompt text remains visible in process argv during invocation.

## Rollback

Run the owned remove command to disable/remove `antifan-chat-router`. Restore the
config backup only if merge validation failed; never replace a newer user config
with an older backup automatically.
