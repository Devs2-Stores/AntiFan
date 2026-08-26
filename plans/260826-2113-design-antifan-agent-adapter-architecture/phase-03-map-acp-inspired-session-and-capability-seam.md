---
title: "Phase 3: Map ACP-inspired session and capability seam"
status: complete
---

# Phase 3: Map ACP-inspired session and capability seam

## Overview

Translate ACP concepts into AntiFan concepts without importing protocol assumptions that conflict with the desktop harness. ACP requires initialization before session setup, supports new/load/resume session paths where advertised, streams prompt-turn updates, reports tool calls, and defines cancellation/elicitation interactions. AntiFan must adapt these concepts to its own authority model.

## Requirements

- [x] Treat ACP protocol version and capability fields as negotiated runtime metadata, not as permission to bypass AntiFan policy.
- [x] Support initialize-before-session ordering and explicit session identity; do not infer session readiness from process spawn alone.
- [x] Model `session/new`, `session/load`, and `session/resume` only when the adapter advertises and implements the corresponding capability.
- [x] Normalize prompt-turn updates and tool-call reports into AntiFan events while preserving opaque runtime IDs and run correlation.
- [x] Translate permissions/elicitation into AntiFan approval requests; the adapter MUST NOT directly prompt the user or grant itself authority.
- [x] Map cancellation to the active run and nested runtime work, then confirm terminal cancellation and cleanup.

## Implementation Steps

1. Create a concept map: ACP `initialize` → adapter handshake; `session/new|load|resume` → adapter session methods; `session/prompt` → adapter prompt stream; `session/update` → normalized event stream; tool calls → tool intent/result events; `$/cancel_request` → adapter cancellation; elicitation → control-plane approval.
2. Define capability advertisement and rejection behavior for unsupported session modes, prompt features, tool categories, permissions, and resume semantics.
3. Define handshake metadata: protocol version, adapter/runtime name and version, advertised capabilities, session capabilities, and diagnostics. Keep this metadata bounded and persisted with the run record.
4. Define event translation precedence: malformed input is diagnostic/error; unsupported capability is explicit failure; user denial is a denial outcome; cancellation is distinct from runtime failure; only the control plane can mark verification complete.
5. Define reconnect behavior: session resume is allowed only when capability and identity checks pass; otherwise fail closed and start a new run/session according to policy rather than silently attaching.
6. Make the resume rule executable: no adapter may expose `resumeSession` as a successful path until a control-plane caller supplies and validates the persisted project/workspace/run/user lineage, adapter identity/version compatibility, opaque session reference, and fresh cancellation/lease context. Unsupported or unimplemented resume returns an explicit unsupported outcome.

## Todo

- [x] Write ACP-to-AntiFan concept mapping
- [x] Define capability negotiation and unsupported-feature semantics
- [x] Define permissions, elicitation, and cancellation translation
- [x] Define session identity, reconnect, and resume safety rules

## Success Criteria

- [x] The design is compatible with ACP lifecycle concepts while remaining implementable by the existing subprocess backend.
- [x] Unsupported or unadvertised ACP features fail explicitly without accidental fallback to unsafe behavior.
- [x] User approval, cancellation, and verification ownership remain in AntiFan.
- [x] Session replay/resume cannot attach an old runtime to a different project, run, or user context.
