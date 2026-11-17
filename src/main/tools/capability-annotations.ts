/**
 * MCP tool annotations and effect flags, derived from the capability policy so a client can tell a
 * read tool from a destructive one without a second hand-kept table.
 *
 * Only values that differ from the MCP defaults are emitted (readOnlyHint false, destructiveHint true,
 * idempotentHint false are the defaults): the advertised list is paid for on every agent request.
 */

export interface CapabilityEffectFlags {
  writesFilesystem: boolean;
  /** Starts or signals an OS process / types into a shell. */
  launchesProcess: boolean;
  /** Runs caller-supplied code (page script, shell line). */
  executesForeignCode: boolean;
  accessesNetwork: boolean;
  mayDiscardData: boolean;
  /** Explicit `false` marks a write that is not idempotent despite its effect class. */
  idempotent: boolean;
}

/**
 * Audited capabilities whose effect is wider than their policy `effect` says. Capabilities absent here
 * are unaudited: they get no flags, so they are classified by `effect` alone.
 */
export const EFFECT_FLAGS: Readonly<Record<string, Partial<CapabilityEffectFlags>>> = Object.freeze({
  'terminal.write': { launchesProcess: true, executesForeignCode: true },
  'terminal.create': { launchesProcess: true },
  'terminal.close': { mayDiscardData: true },
  'file.write': { writesFilesystem: true },
  'anti.browser.evaluate': { executesForeignCode: true },
  'anti.browser.evaluate_frame': { executesForeignCode: true },
  'anti.inspect.eval': { executesForeignCode: true },
  'anti.agent.file_upload': { writesFilesystem: true, accessesNetwork: true },
  'theme.transaction.begin': { writesFilesystem: true },
  'theme.transaction.write_cas': { writesFilesystem: true },
  'theme.transaction.rollback': { writesFilesystem: true, mayDiscardData: true },
  'theme.transaction.resolve_hold': { writesFilesystem: true, mayDiscardData: true },
  'theme.qa_rollback': { writesFilesystem: true, mayDiscardData: true },
});

export interface McpAnnotations {
  readOnlyHint?: true;
  destructiveHint?: false;
  idempotentHint?: true;
}

export type PolicyEffect = 'read' | 'idempotent-write' | 'destructive-mutation' | 'interactive-effect' | 'management';

export function annotationsFromPolicy(name: string, policy: { effect: PolicyEffect }): McpAnnotations {
  const f = EFFECT_FLAGS[name] ?? {};
  const touches = Boolean(f.writesFilesystem || f.launchesProcess || f.executesForeignCode || f.mayDiscardData);
  if (policy.effect === 'read' && !touches) return { readOnlyHint: true };
  const destructive =
    policy.effect === 'destructive-mutation' || Boolean(f.mayDiscardData || f.executesForeignCode || f.launchesProcess);
  const idempotent = policy.effect === 'idempotent-write' && f.idempotent !== false;
  const out: McpAnnotations = {};
  if (!destructive) out.destructiveHint = false;
  if (idempotent) out.idempotentHint = true;
  return out;
}

/** True when the capability can run a process or foreign code and so must sit at the execute/eval tier (or be allow-listed). */
export function needsExecuteTier(name: string): boolean {
  const f = EFFECT_FLAGS[name];
  return Boolean(f && (f.launchesProcess || f.executesForeignCode));
}
