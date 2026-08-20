---
phase: 3
title: "Prove Antigravity Conversation and AgentAPI Semantics"
status: completed
priority: P0
effort: "0.5-1 day"
dependencies: [1]
---

# Phase 3: Prove Antigravity Conversation and AgentAPI Semantics

## Context Links

- [Plan](./plan.md)
- Previous incomplete probe:
  `../260819-2334-route-antifan-chat-to-exact-antigravity-conversation/research/sidecar-contract-probe.md`
- Official Antigravity Sidecar documentation used by the previous plan

## Overview

Run the live gate that the previous cooked plan marked complete without
evidence. Discover an Antigravity-owned conversation ID source, prove exact
non-active delivery, classify `agentapi` acceptance, and record compatibility
for the installed version. Do not enable exact Auto if any load-bearing fact is
unknown.

## Requirements

- Run from a real Antigravity-managed Sidecar environment on this machine.
- Record Antigravity version/commit/build, Sidecar environment, Node executable,
  `agentapi` executable type/path, and router fingerprint.
- Discover conversation IDs from an Antigravity-owned source before consulting
  transcript observation. Transcript directory equality may be accepted only
  after independent correlation proves it.
- Keep conversation A active while sending unique markers to B three times.
- Cover idle B, running B, invalid ID, Sidecar restart, and Antigravity restart.
- Determine whether exit 0 proves command acceptance, queue acceptance, or only
  process completion. Capture official event/receipt evidence when available.
- Test Markdown, PNG, JPEG, plain text, unsupported MIME, missing file, modified
  file, and 8-file/10 MiB boundary behavior separately.
- Record prompt argv visibility and current-user trust boundary.

## Related Code and Evidence Files

- Modify: `E:/Work/apps/antigravity-browser/scripts/probe-agentapi-sidecar.mjs`
- Modify: `E:/Work/apps/antigravity-browser/test/agentapi-sidecar-probe.test.cjs`
- Create: `research/antigravity-live-sidecar-compatibility.md`
- Create: bounded redacted JSON evidence under `research/evidence/`
- Read only during probe: installed Antigravity metadata, Sidecar environment,
  and the two disposable transcripts

## Implementation Steps

1. Install the Phase 1 packaged Sidecar into a disposable or explicitly owned
   live Antigravity profile and confirm heartbeat/restart.
2. Capture the compatibility fingerprint before sending any prompt.
3. Enumerate documented Sidecar event/environment data and identify candidate
   authoritative conversation IDs.
4. Create unique manual markers in disposable A and B, correlate the official
   ID source, and document whether transcript folder IDs match or require a map.
5. Keep A active; send three unique prompts to B. Verify focus remains A and no
   marker appears in A.
6. Repeat against idle B, running B, invalid ID, after Sidecar restart, and after
   Antigravity restart. Record deterministic queue/reject/unknown behavior.
7. Correlate `agentapi` exit, stdout/stderr metadata, official event/receipt,
   transcript prompt observation, response observation, and first-token timing
   as separate facts.
8. Run per-MIME and attachment-budget cases using copied fixtures with known
   hashes. Prove what the agent can actually access.
9. Inspect child argv once and verify application logs/evidence redact prompt
   text and credentials.
10. Write a GO/NO-GO gate report with raw command names, timestamps, IDs
    redacted where needed, and repeated-result counts.

## Todo

- [ ] Capture installed Antigravity and Sidecar fingerprint.
- [ ] Discover authoritative conversation ID source.
- [ ] Prove or reject transcript ID equality.
- [ ] Complete A-active/B-target repeated-send matrix.
- [ ] Classify idle/running/invalid/restart semantics.
- [ ] Classify exit 0 versus official acceptance evidence.
- [ ] Complete attachment capability/budget matrix.
- [ ] Publish redacted evidence and GO/NO-GO decision.

## Hard Gate

Phase 4 may start only if:

- [ ] An Antigravity-owned, restart-stable target ID source exists.
- [ ] Three repeated sends reach only B while A remains active.
- [ ] Running-target behavior is deterministic queue or clean rejection.
- [ ] The executable can be launched safely on Windows without raw prompt shell
  interpolation. `.cmd`/`.bat` wrappers require a proven safe wrapper path.
- [ ] The evidence source supporting `ide-api-accepted` is named and observable.
- [ ] Supported attachment classes are proven rather than inferred from exit 0.

If any item fails, keep exact Auto disabled and re-scope to explicit Draft plus
passive transcript observation.

## Validation

- Unit probe tests pass.
- Live report includes version fingerprint, commands, timestamps, route matrix,
  hashes/counts, and separate delivery/observation evidence.
- No raw prompt, token, or credential appears in report/log output.

## Success Criteria

- [ ] Exact conversation identity and routing are empirically reproducible.
- [ ] The plan no longer assumes transcript folder ID equality.
- [ ] AgentAPI acceptance and transcript/first-token observation are distinct.
- [ ] Unsupported states fail closed before publication.

## Rollback

Remove only the probe/Sidecar entry from the owned profile, preserve redacted
evidence, and leave exact Auto disabled. Never delete transcripts used as live
evidence.
