# Antigravity mixed tool-call fix

Status: implementation verified; live app restart verification pending.

## Repaired behavior

- Mixed text plus `functionCall` dispatches the tool without exposing transcript text as an assistant reply.
- The final SSE event is parsed even when the stream ends without a trailing newline.
- A Run continues through durable `tool_called` and `tool_result` events and completes only after a later non-empty assistant response.

## Verification

- Typecheck: pass.
- Focused tests: 35/35 pass.
- Full tests: 495/495 pass.
- Electron Harness E2E: 11/11 pass.
- Code review: no blocking findings for the reported failure.

## Pending

- Restart the running desktop application so it loads the rebuilt Main bundle.
- Retry the real Project prompt against Antigravity Subscription and confirm a durable final assistant reply.
