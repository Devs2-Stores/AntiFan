---
phase: 1
title: "Prove Sidecar routing and ID semantics"
status: completed
priority: P0
effort: "0.5-1 day"
dependencies: []
---

# Phase 01: Prove Sidecar Routing and ID Semantics

## Context Links

- Plan: [plan.md](./plan.md)
- Research:
  [independent chat routing](../reports/260819-2313-antigravity-independent-chat-routing-research.md)
- Official docs: <https://antigravity.google/docs/sidecars/>

## Overview

Run a disposable, documented probe inside an Antigravity-managed Sidecar. Lock
the load-bearing facts before production protocol or UI work begins.

## Requirements

- Functional: discover an authoritative Antigravity-owned source of
  `conversation_id` values before sending to a candidate. Correlate a manually
  selected conversation and unique marker to that source; do not bootstrap the
  proof from transcript session ID equality.
- Functional: resolve and invoke `agentapi` from the actual Sidecar environment
  on Windows without concatenating prompt text into a shell command.
- Functional: prove the absolute Node executable and absolute router path that
  Antigravity can launch; ambient `node` or inherited developer PATH is not an
  accepted production assumption.
- Functional: target a non-active conversation with a unique marker and prove
  only the intended transcript receives it.
- Functional: compare the selected transcript session ID with the ID accepted by
  `agentapi`; document a mapping source if they differ.
- Functional: record behavior for idle conversation, running conversation,
  missing conversation, Antigravity restart, and CLI completion/acceptance
  evidence. Running-conversation behavior must be deterministic queue or clean
  rejection; interruption or silent replacement fails the gate.
- Functional: test whether workspace-staged Markdown and PNG paths are usable
  through prompt-only `send-message` without silently losing evidence. Record
  capability independently for each MIME class.
- Non-functional: no private RPC, UI automation, production command mutation,
  or automatic resend.
- Non-functional: document that prompt text is visible in `agentapi` argv for
  the child lifetime and that the threat model trusts the current OS user.

## Architecture

The probe runs as a temporary global Sidecar because only managed Sidecars get
the supported `agentapi` PATH and credentials. It first inventories documented
Sidecar environment/event data to find an Antigravity-owned conversation ID,
then correlates that ID to one manually selected transcript using a unique
manual marker. Only after that discovery does it call `send-message`. It writes
structured, redacted results to its own runtime data directory. Raw transcripts
are observation, never the authority that invents the target ID.

## Related Code Files

- Create: `E:/Work/apps/antigravity-browser/scripts/probe-agentapi-sidecar.mjs`
  - reusable managed-environment probe; no production routing.
- Create: `E:/Work/apps/antigravity-browser/test/agentapi-sidecar-probe.test.cjs`
  - argument handling, redaction, bounds, result parsing.
- Create:
  `E:/Work/apps/antifan-browser-desktop/plans/260819-2334-route-antifan-chat-to-exact-antigravity-conversation/research/sidecar-contract-probe.md`
  - installed version, commands, observations, and gate decision.
- Read only: `E:/Work/apps/antifan-browser-desktop/src/main/bridge/transcript-syncer.ts`
  - current session IDs and transcript paths.

## Implementation Steps

1. Record the managed environment, `agentapi` resolution, Sidecar runtime/event
   files, and the absolute Node executable used by the real Sidecar launch.
2. Create a marker manually in selected conversation B and locate the matching
   Antigravity-owned `conversation_id`. Document the mapping source and restart
   behavior before accepting any ID as a send target.
3. Add a probe entrypoint that reads a bounded JSON request from its Sidecar
   data directory and invokes the resolved `agentapi` with an argument array and
   `shell: false`. Reject raw prompt interpolation through a shell.
4. Keep conversation A active; send the marker to authoritative target B; capture focus,
   exit code, stdout/stderr metadata, Sidecar event file, and transcript result.
5. Repeat with B idle, B running, invalid ID, and after an Antigravity restart.
   Distinguish deterministic accept/queue/reject from ambiguous completion.
6. Send separate prompts referencing staged Markdown and PNG fixtures with
   verifiable content. Record usable/unsupported/unknown per MIME class.
7. Inspect the spawned process once to confirm the documented argv exposure;
   verify AntiFan captures no prompt body in logs or persisted diagnostics.
8. Write the compatibility fingerprint: Antigravity version/commit, Sidecar ID,
   authoritative ID source, mapping rule, Node/agentapi paths, receipt semantics,
   busy behavior, per-MIME capability, and prompt exposure boundary.
9. Apply the hard gate below before Phase 2.

## Hard Gate

- Proceed only when exact non-active routing is repeatable and an
  Antigravity-owned authoritative conversation-ID source is available.
- If ID discovery or restart-stable mapping is unavailable, stop and replan; do
  not guess from transcript folder names or scrape UI state.
- If the absolute Node launcher used by Antigravity cannot be proven, stop; do
  not ship a config that assumes ambient `node`.
- If safe Windows invocation requires shell interpolation of raw prompts, stop
  and replan the adapter boundary.
- If running-conversation behavior interrupts/replaces work or acceptance cannot
  be classified, stop and replan the send policy.
- If a MIME class is unsupported or unknown, exact dispatch with that class is
  blocked and eligible only for pre-publication Draft fallback.
- If argv visibility is unacceptable for this personal-tool threat model, stop;
  the documented CLI exposes no stdin prompt contract.

## Todo

- [ ] Add bounded managed-Sidecar probe.
- [ ] Discover authoritative conversation ID and mapping source.
- [ ] Prove absolute Node and `agentapi` launch paths.
- [ ] Prove non-active exact routing.
- [ ] Record exit/event/busy semantics.
- [ ] Record Markdown and PNG behavior per MIME class.
- [ ] Record argv/logging trust boundary.
- [ ] Publish the compatibility probe report.

## Success Criteria

- [ ] Three repeated sends target B while A is active, with zero markers in A.
- [ ] Focus remains on A during all successful exact sends.
- [ ] Conversation ID mapping has a named Antigravity-owned source and restart behavior.
- [ ] Sidecar launch uses a verified absolute Node executable; no PATH-only
  assumption remains.
- [ ] `agentapi` acceptance evidence is distinguished from transcript
  observation and first-token timing.
- [ ] Running-conversation behavior is deterministic queue or clean rejection,
  never interruption or silent replacement.
- [ ] Attachment capability is `supported`, `unsupported`, or `unknown`; never
  inferred from command exit alone and recorded per MIME class.
- [ ] Report states that prompt argv is visible to the current user while logs
  contain digest/length only.
- [ ] A go/no-go decision for Phase 2 is written in the probe report.

## Risk Assessment

| Risk / assumption | Observable break signal | Pre-decided response |
|---|---|---|
| No authoritative conversation ID source exists | Only transcript folder guesses are available | Stop and replan; no exact route claim |
| `agentapi` is safely spawnable on Windows | Only `.cmd` plus unsafe shell interpolation works | Stop; design a safe wrapper boundary |
| Antigravity can launch the chosen Node runtime | Sidecar works only from a developer shell | Pin a proven absolute executable or stop |
| Exit code means API acceptance | Exit 0 but no matching event/transcript marker | Keep receipt `unknown`; inspect events before proceeding |
| Busy target preserves current work | Existing generation is interrupted/replaced | Stop and replan serialization/send policy |
| Prompt paths preserve artifact value | Agent cannot inspect staged Markdown/PNG | Mark that MIME unsupported; require pre-publication Draft fallback |
| Prompt secrecy exceeds the CLI contract | Process inspection shows prompt argv | Accept same-user boundary or stop; never claim argv secrecy |

## Rollback

Disable and remove only the temporary probe Sidecar configuration. Preserve its
redacted report; do not delete Antigravity transcripts or runtime event evidence.
