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
 * `oneOf` alternatives the call failed to satisfy, each as its declared member list.
 *
 * A schema may advertise mutually exclusive argument forms -
 * `oneOf: [{ required: ['expression'] }, { required: ['expressionFile'] }]` - where the
 * flat `required` list cannot express "one of these shapes". The gate is satisfied when
 * at least one alternative's members are ALL present with usable values; supplying
 * members of several alternatives at once still passes here, because which combination
 * is legal is the capability's domain decision, not the gate's. An alternative that
 * declares no usable `required` list constrains nothing and counts as satisfied.
 * The result is empty when the schema declares no `oneOf` or when any alternative holds.
 */
export function findUnsatisfiedOneOfAlternatives(
  inputSchema: Record<string, unknown> | undefined,
  params: Record<string, unknown> | undefined
): string[][] {
  const oneOf = inputSchema?.oneOf;
  if (!Array.isArray(oneOf) || oneOf.length === 0) return [];
  const supplied = params ?? {};
  const unsatisfied: string[][] = [];
  for (const entry of oneOf) {
    const group = entry && typeof entry === 'object' ? (entry as Record<string, unknown>).required : undefined;
    const members = Array.isArray(group)
      ? group.filter((rawName): rawName is string => typeof rawName === 'string' && rawName.trim().length > 0)
      : [];
    const satisfied = members.every(
      (name) => Object.prototype.hasOwnProperty.call(supplied, name) && !isUnusableArg(supplied[name])
    );
    if (!satisfied) unsatisfied.push(members);
  }
  return unsatisfied.length === oneOf.length ? unsatisfied : [];
}

export interface RequiredArgsRefusal {
  /** Flat `required` fields the call did not supply with a usable value, in schema order. */
  missing: string[];
  /** `oneOf` alternatives, each as its declared member list, when none was fully supplied. */
  unsatisfiedAlternatives: string[][];
  /** Caller-facing refusal text naming the capability and every unsatisfied contract. */
  message: string;
}

/**
 * Evaluates the advertised schema's presence contract - the flat `required` list and the
 * `oneOf` alternatives are independent clauses, and when both are declared both must hold.
 * Returns undefined when the call satisfies everything the schema declares.
 */
export function checkRequiredArgs(
  capabilityName: string,
  inputSchema: Record<string, unknown> | undefined,
  params: Record<string, unknown> | undefined
): RequiredArgsRefusal | undefined {
  const missing = findMissingRequiredArgs(inputSchema, params);
  const unsatisfiedAlternatives = findUnsatisfiedOneOfAlternatives(inputSchema, params);
  if (missing.length === 0 && unsatisfiedAlternatives.length === 0) return undefined;
  const clauses: string[] = [];
  if (missing.length > 0) {
    clauses.push(
      `requires ${missing.join(', ')}, and this call supplied no usable value for ${missing.length === 1 ? 'it' : 'them'}`
    );
  }
  if (unsatisfiedAlternatives.length > 0) {
    const alternatives = unsatisfiedAlternatives
      .map((members) => (members.length > 0 ? members.join(' + ') : '(no required fields)'))
      .join(', or ');
    clauses.push(`requires one of ${alternatives}, and this call satisfied none of those forms`);
  }
  const message =
    `Capability '${capabilityName}' ${clauses.join('; it also ')}. ` +
    'The argument is refused rather than defaulted from session state, because a default would act on a target the caller never named. ' +
    `Supply ${missing.length === 1 && unsatisfiedAlternatives.length === 0 ? 'the field' : 'the fields'} explicitly and retry.`;
  return { missing, unsatisfiedAlternatives, message };
}

/**
 * Refuses a call whose required arguments are absent or unusable. The refusal names the
 * capability and every offending field or unsatisfied alternative form, because a caller
 * that omitted a required target needs to be told which one rather than handed a default.
 */
export function assertRequiredArgs(
  capabilityName: string,
  inputSchema: Record<string, unknown> | undefined,
  params: Record<string, unknown> | undefined
): void {
  const refusal = checkRequiredArgs(capabilityName, inputSchema, params);
  if (!refusal) return;
  throw new CapabilityError('INVALID_ARGUMENT', refusal.message, {
    capability: capabilityName,
    missing: refusal.missing,
    unsatisfiedAlternatives: refusal.unsatisfiedAlternatives,
  });
}
