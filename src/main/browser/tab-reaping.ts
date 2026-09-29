import type { AntiFanTab } from '../../shared/contracts';

export const AGENT_TAB_IDLE_MS = 10 * 60 * 1000;
export const AGENT_TAB_REAP_SWEEP_INTERVAL_MS = 60 * 1000;

export interface ReapingContext {
  claimedTabIds: ReadonlySet<string>;
  agentWorkingTabIds?: ReadonlySet<string>;
  reservedForCloseTabIds?: ReadonlySet<string>;
  now?: number;
  idleMs?: number;
}

export type ReapingDecision =
  | { reap: true }
  | { reap: false; reason: ReapingRefusal };

export type ReapingRefusal =
  | 'not-agent-plane'
  | 'claimed'
  | 'agent-working'
  | 'reserved-for-close'
  | 'not-idle';

export function shouldReapAgentTab(
  tab: { id: string; state: AntiFanTab; lastActiveAt?: number; agentActivityAt?: number },
  ctx: ReapingContext
): ReapingDecision {
  if (tab.state.offscreen !== true) return { reap: false, reason: 'not-agent-plane' };
  if (ctx.claimedTabIds.has(tab.id)) return { reap: false, reason: 'claimed' };
  if (ctx.agentWorkingTabIds?.has(tab.id)) return { reap: false, reason: 'agent-working' };
  if (ctx.reservedForCloseTabIds?.has(tab.id)) return { reap: false, reason: 'reserved-for-close' };

  const now = typeof ctx.now === 'number' ? ctx.now : Date.now();
  const idleMs = typeof ctx.idleMs === 'number' && ctx.idleMs > 0 ? ctx.idleMs : AGENT_TAB_IDLE_MS;
  const activityAt = typeof tab.agentActivityAt === 'number' && tab.agentActivityAt > 0
    ? tab.agentActivityAt
    : (typeof tab.lastActiveAt === 'number' && tab.lastActiveAt > 0 ? tab.lastActiveAt : 0);
  if (now - activityAt < idleMs) return { reap: false, reason: 'not-idle' };

  return { reap: true };
}
