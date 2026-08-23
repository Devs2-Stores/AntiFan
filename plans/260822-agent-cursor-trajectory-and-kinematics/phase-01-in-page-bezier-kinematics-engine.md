# Phase 1: In-Page Kinematics Engine

## Goal
Implement Cubic Bézier path interpolation, Fitts's law velocity curves, and a full multi-step trajectory execution loop (`window.__antifanAgentTrajectory`) in `src/main/browser/agent-browser.ts`.

## Changes
- Add mathematical helper functions for Cubic Bézier points calculation:
  $B(t) = (1-t)^3 P_0 + 3(1-t)^2 t P_1 + 3(1-t) t^2 P_2 + t^3 P_3$
- Implement `window.__antifanAgentTrajectory(steps, options)`:
  - Sequence execution loop across waypoints.
  - Dynamic rect measurement before each step (`querySelectorDeep`).
  - Action handlers: `move`, `hover`, `click` (with ripple), `scroll` (with smooth scroll animation), `type` (input field focus and character dispatch), `wait` (dwell delay).
  - Ambient idle wandering (micro-movements $\pm 3\text{px}$) after trajectory completion.
  - User interruption listener (`mousemove` abort trigger).

## Verification
- Unit testing of syntax and contract exports via `test/main/agent-browser-script.test.ts`.
