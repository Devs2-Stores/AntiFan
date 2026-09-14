import { CapabilityError } from '../../shared/control-plane-contracts';

/**
 * Required-argument enforcement for the authenticated (agent-facing) capability surface.
 *
 * Every capability advertises an `inputSchema`, and that schema's `required` list is a
 * promise to the caller: without those fields the tool cannot know what the caller
 * wants. Several implementations nevertheless resolve them from ambient state - `tabId`
 * defaults to the session's bound tab. Measured on the live bridge, all three of
 * `tabs.activate {}`, `rebind_target {}` and `set_automation_target {}` are ACCEPTED
 * even though each schema marks `tabId` required, so the schema and the behaviour
 * disagree and a caller cannot distinguish "act on the tab I named" from "act on
 * whatever this session happens to be bound to".
 *
 * This gate makes the advertised schema authoritative on the authenticated path. The
 * trusted/internal path is deliberately not gated, so runtime code that legitimately
 * relies on a default keeps working.
 */

/**
 * A key that is present but carries nothing usable. An empty array or empty object is
 * NOT unusable: `filePaths: []` and `filters: {}` are real caller intent whose
 * semantics belong to the capability, and refusing them here would mask the domain
 * error that explains them. `false` and `0` are likewise real values.
 */
function isUnusableArg(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (typeof value === 'string' && value.trim().length === 0) return true;
  return false;
}

/** Required argument names that the call did not supply with a usable value, in schema order. */
export function findMissingRequiredArgs(
  inputSchema: Record<string, unknown> | undefined,
  params: Record<string, unknown> | undefined
): string[] {
  const required = inputSchema?.required;
  if (!Array.isArray(required) || required.length === 0) return [];
  const supplied = params ?? {};
  const missing: string[] = [];
  for (const rawName of required) {
    if (typeof rawName !== 'string' || rawName.trim().length === 0) continue;
    if (!Object.prototype.hasOwnProperty.call(supplied, rawName) || isUnusableArg(supplied[rawName])) {
      missing.push(rawName);
    }
  }
  return missing;
}

/**
 * Refuses a call whose required arguments are absent or unusable. The refusal names the
 * capability and every offending field, because a caller that omitted a required target
 * needs to be told which one rather than handed a default.
 */
export function assertRequiredArgs(
  capabilityName: string,
  inputSchema: Record<string, unknown> | undefined,
  params: Record<string, unknown> | undefined
): void {
  const missing = findMissingRequiredArgs(inputSchema, params);
  if (missing.length === 0) return;
  throw new CapabilityError(
    'INVALID_ARGUMENT',
    `Capability '${capabilityName}' requires ${missing.join(', ')}, and this call supplied no usable value for ${missing.length === 1 ? 'it' : 'them'}. ` +
      'The argument is refused rather than defaulted from session state, because a default would act on a target the caller never named. ' +
      `Supply ${missing.length === 1 ? 'the field' : 'the fields'} explicitly and retry.`,
    { capability: capabilityName, missing }
  );
}
