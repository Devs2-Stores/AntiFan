# Terminal scrollback / scrollbar verification — evidence packet

Scope: `/skill:debug` report "Agent trả Output rất dài, nhưng thanh scroll Terminal cụt ngủn, ko scroll lên để xem được" plus the follow-up scenarios requested during the session:

1. nhiều tab terminal chạy output cùng lúc, chuyển qua chuyển lại
2. có terminal split, split cũng có output, click tab qua lại
3. check kỹ thanh scroll và content bị mất
4. kéo giãn / thu gọn Terminal Split

All probes ran against `.compiled` (`npm run compile`) with the renderer fix applied, Electron 43.4.0 + `@xterm/xterm 6.0.0`, on this workstation. Broadcast payloads were wire-budgeted exactly like `listSessions()` (`safeSliceTailJsonBounded`, active ≈16 KiB / background ≈8 KiB) while `get-full-buffer` served the authoritative transcript, so every pane had to hydrate from the full buffer to keep history.

## Measured results (post-fix)

### Multi-tab concurrent streaming + tab thrash (probe `terminal-multitab-stream`, `terminal-authoritative-audit`)
4 sessions × 900-row transcripts + 40 live frames each, tabs clicked every ~110 ms:

| pane | rows | history markers | first/last | gaps | dupes | live missing | live duplicated | lastRenderedSeq |
|---|---|---|---|---|---|---|---|---|
| AntiFan | 942 | 900/900 | 1/900 | 0 | 0 | 0/40 | 0 | 140 (expected 140) |
| AntiFan Debug | 942 | 900/900 | 1/900 | 0 | 0 | 0/40 | 0 | 140 |
| F1GENZ Multiform | 942 | 900/900 | 1/900 | 0 | 0 | 0/40 | 0 | 140 |
| Shop | 942 | 900/900 | 1/900 | 0 | 0 | 0/40 | 0 | 140 |

- `degradedBanners: 0`, no duplicated line, no out-of-order line, no renderer error.
- Scroll position preserved across switch away/back: `viewportY 120 → 120` (`preserved: true`).
- Scrolled-up pane is not yanked while output keeps arriving: `vp 200 → 200` while `baseY 909 → 915`.
- Pre-fix renderer, same harness: every pane `headMarkers: 0`, panes held only 91–203 rows (`hydrated from the wire slice`), i.e. the transcript head was gone.

### Split pane with its own output, tab thrash, close/reopen (probe `terminal-multitab-split`, `terminal-split-resize-collapse`)
- Split pane (own 900-row transcript, streaming concurrently): `hist=900/900 gaps=0 dupes=0 liveMissing=0 liveDup=0 seq` matches expected, pane re-mounted after tab thrash (`splitHostRect 1126×88`).
- Pool contains only the 4 real sessions after the ghost split pane was cleaned up: `poolIds = [session-1..4]`.
- Close through `#btnCloseSplitPane` → `domClean: true`, `splitEnabled: false`; the split session kept streaming while unmounted; after reopen through `#btnSplitTerminal` the pane again held `hist=900/900 gaps=0 dupes=0 liveMiss=0`.
- Ctrl+Shift+D close/reopen: same clean result.

### Drag / collapse of the split (probe `terminal-split-resize-collapse`)
Streaming ran throughout; each step audited both panes.

| requested main ratio | main px | split px | resulting lower ratio | split PTY rows | history | gaps/dupes |
|---|---|---|---|---|---|---|
| 0.50 | 298 | 297 | 0.499 | 19 | 900/900 | 0/0 |
| 0.70 | 417 | 178 | 0.299 | 10 | 900/900 | 0/0 |
| 0.85 | 506 | 89 | 0.150 | 4 | 900/900 | 0/0 |
| 0.35 | 208 | 387 | 0.650 | 25 | 900/900 | 0/0 |
| 0.05 (below min) | 60 | 535 | 0.899 | 36 | 900/900 | 0/0 |
| 0.98 (above max) | 535 | 60 | 0.101 | 36 | 900/900 | 0/0 |

- Both panes clamp at 60 px (`paneMin = min(60, floor(usable*0.15))`), no pane collapses to zero, split PTY rows never below 4 (`MIN_SPLIT_TERMINAL_ROWS`).
- After every drag, close, reopen, keyboard toggle, window shrink (880×560) and restore (1180×780): `hist=900/900, gaps=0, dupes=0, liveMiss=0, liveDup=0` in all panes and in the split; `degradedBanners: 0`; no renderer error.

### Scrollbar geometry and real-mouse usability (probes `terminal-content-scrollbar-audit`, `terminal-wheel-routing`, `terminal-slider-usability`)
- Slider is proportional but floored: 900 rows → **28 px** thumb on a 602 px track; with the pane split in half, 462 px track → **20 px** (the floor); a 12 000-row session → **20 px**. Formula from the xterm bundle: `max(20, floor(track * (track - 2*arrow) / content))`.
- The scrollbar is auto-hidden: class toggles `visible scrollbar vertical` ↔ `invisible scrollbar vertical fade`, `opacity` 0 → 1 on hover/scroll. Slider colour = foreground at 20 % (`rgba(219,231,245,0.2)`); the app's own scrollbar CSS targets `.xterm-viewport::-webkit-scrollbar`, which xterm 6 no longer renders, so it is dead code.
- Real wheel input through Chromium (CDP `Input.dispatchMouseEvent`): 3 ticks of −120 → `viewportY 400 → 389`; 3 ticks of +120 → `400 → 411`. `handleMouseWheel: true`, event target `.xterm-screen`, `isTrusted: true`, `defaultPrevented: false`.
- With a TUI holding mouse tracking (`\x1b[?1000h`) xterm sets `handleMouseWheel: false` and the wheel is forwarded to the app (0 px movement) — by design; `\x1b[?1000l` restores it (`400 → 389`). `\x1b[?2004h` does not affect it.
- No keyboard scrollback fallback: Shift+PageUp, Shift+PageDown, Ctrl+Shift+Up and plain PageUp all moved `viewportY` by 0.
- Real slider/scrollbar interaction works once the pointer is over it (`elementFromPoint → "slider"`): thumb drag at the bottom clamps (0 px, already at end), track drag moved `viewportY 869 → 43`.

### Retention ceiling (documented limit, unchanged by the fix)
12 000-row transcript (≈300 KB, below the 512 Ki-char main cap), renderer main pane `scrollback: 10000`:
- rendered rows `10043` (= 10 000 scrollback + 43 visible), markers `8041` seen, first retained `H1959`, last `H9999`, header row gone.
- i.e. the oldest ~1 958 lines fall off once a transcript exceeds the 10 000-row renderer ceiling; the main-side cap (512 Ki chars ≈ 4 000–8 000 lines) triggers first in normal ANSI output.

## Defect found while testing (not caused by the hydration fix)
`Uncaught TypeError: Cannot read properties of undefined (reading 'dimensions')` from xterm itself, during tab thrash with a split mounted:

```
at get dimensions (xterm.js:1:107867)
at u._sync (xterm.js:1:52240)
at (xterm.js:1:52005)
at t.RenderDebouncer._runRefreshCallbacks (xterm.js:1:45972)
at t.RenderDebouncer._innerRefresh (xterm.js:1:45888)
```

`Viewport._sync` runs from a pending render-debouncer refresh after the terminal has been disposed (`unmountSplit` → `splitTerm.dispose()`), so `_renderService` is already gone. Consequence: an uncaught renderer error on every split unmount that races a pending refresh; the split still remounts correctly and content stays complete (verified above). The same signature makes the renderer smoke Step 9 split-geometry assertions flaky.

## Reproduction commands
```
npm run compile
node scripts/run-electron.cjs tmp/<probe>.cjs      # throwaway probes, deleted after the run
node scripts/run-electron.cjs test/e2e/terminal-renderer-smoke.cjs   # permanent Step 5c regression
```
