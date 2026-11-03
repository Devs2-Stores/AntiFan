/**
 * Idle-media policy for Chrome tabs left in the background.
 *
 * Hibernation deliberately refuses an audible tab, so a page that plays media (or runs an animation
 * loop) is kept fully alive for as long as it stays audible — from a window the user is not even
 * looking at. On 02/11/2026, with 43 tabs over dozens of project windows, one such tab held a
 * renderer at ~125% of a core and the GPU process at ~173%: every window composites through that
 * process, so the whole app felt slow.
 *
 * This policy freezes that work instead of destroying the page: CSS animations pause, transitions are
 * cut, and playing media is paused and remembered, so returning to the tab resumes it. Nothing is
 * unloaded, so no form state, scroll position or session is lost — the reversible half of hibernation.
 */

/** How long a tab must be out of sight before its media is paused. */
export const MEDIA_IDLE_MS = 5 * 60 * 1000;

/** Facts the host supplies once per sweep; the policy itself stays pure. */
export interface MediaIdleFacts {
  /** The tab is the one presented in its window. */
  presented: boolean;
  /** The tab's window is focused, visible and not minimized. */
  windowVisibleAndFocused: boolean;
  /** Ms since the tab was last presented or received input. */
  idleMs: number;
  /** Page is emitting sound, or the window is idle long enough that an animation is the reason. */
  playing: boolean;
  /** An agent/MCP/CDP session owns this tab right now. */
  agentPlane: boolean;
  /** A page vetoed unloading (dirty form); never touch it. */
  unloadVetoed: boolean;
}

export type MediaIdleDecision =
  | { pause: true }
  | { pause: false; reason: MediaIdleRefusal };

export type MediaIdleRefusal =
  | 'window-in-use'
  | 'agent-plane'
  | 'unload-veto'
  | 'not-idle'
  | 'not-playing';

/**
 * Whether the tab's media and animations should be frozen at this sweep.
 *
 * A focused window is never touched, and neither is a tab an agent is driving: those are the two
 * cases where pausing would break work in progress. Everything else waits out the idle floor.
 */
export function shouldPauseIdleMedia(facts: MediaIdleFacts): MediaIdleDecision {
  if (facts.agentPlane) return { pause: false, reason: 'agent-plane' };
  if (facts.unloadVetoed) return { pause: false, reason: 'unload-veto' };
  if (facts.windowVisibleAndFocused) return { pause: false, reason: 'window-in-use' };
  if (facts.idleMs < MEDIA_IDLE_MS) return { pause: false, reason: 'not-idle' };
  if (!facts.playing && !facts.presented) return { pause: false, reason: 'not-playing' };
  return { pause: true };
}

/**
 * Freeze applied to the page. `animation-play-state` stops CSS loops (the common cause of a pinned
 * GPU process) without removing the element, and `transition: none` avoids a cascade of transitions
 * firing on resume.
 */
export const MEDIA_FREEZE_CSS =
  '*,*::before,*::after{animation-play-state:paused!important;transition:none!important}';

/**
 * Mark and pause every playing media element. The dataset flag is what makes resume precise: only
 * the media this policy paused is played again, never something the user paused themselves.
 */
export const MEDIA_PAUSE_SCRIPT = `(() => {
  const items = document.querySelectorAll('video,audio');
  let paused = 0;
  for (const el of items) {
    if (el.paused || el.ended) continue;
    try {
      el.dataset.antifanIdlePaused = '1';
      el.pause();
      paused += 1;
    } catch {}
  }
  return paused;
})()`;

/** Play back exactly the media this policy paused. Autoplay refusals are swallowed. */
export const MEDIA_RESUME_SCRIPT = `(() => {
  const items = document.querySelectorAll('[data-antifan-idle-paused="1"]');
  for (const el of items) {
    try {
      delete el.dataset.antifanIdlePaused;
      const played = el.play();
      if (played && typeof played.catch === 'function') played.catch(() => {});
    } catch {}
  }
  return items.length;
})()`;
