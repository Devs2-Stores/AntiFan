# Agent Browser Visual Cursor Gap Analysis

Conducted: 2026-08-20

## Verdict

AntiFan already had the same core visual primitives as the archived Agent Browser implementation: injected overlay, animated cursor, target highlight, action banner, click ripple, and typed input animation. The missing layer was orchestration. Navigation, reload, tab activation, generic scrolling, and highlighting could bypass cursor choreography.

## Required Pipeline

Every mutating browser action should use one sequence:

1. Resolve the exact tab and DOM target.
2. Scroll the target into the viewport when applicable.
3. Move the visual cursor to the target or viewport action anchor.
4. Show an action label and wait for visible motion.
5. Execute the browser action.
6. Keep feedback visible until the next action.

Read-only evidence actions such as DOM capture, screenshots, console inspection, and network inspection should not fake pointer movement.

## Current Coverage

| Action | Cursor coverage |
| --- | --- |
| Click, type, hover | Full |
| Scroll, highlight | Added target/viewport movement |
| Navigate, reload | Added pre-action movement and post-load ready state |
| Switch tab | Added active-tab cursor state |
| DOM, screenshot, diagnostics | Intentionally read-only |
| Drag, upload, keyboard, dialog | Not implemented in the MCP contract |

## Remaining Work

- Add drag/drop with source-to-target cursor travel.
- Add keyboard/press-key feedback anchored to the focused element.
- Add file upload targeting and dialog handling.
- Route any future browser mutation through a shared action orchestrator rather than adding isolated visual calls.

## Sources

- Current implementation: `src/main/browser/agent-browser.ts`
- Current host routing: `src/main/browser/native-tab-host.ts`
- Archived AntiFan/Antigravity Agent Browser implementation under `E:/Work/apps/_archive/antigravity-browser-desktop`
