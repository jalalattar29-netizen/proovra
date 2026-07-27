/**
 * PHASE 6 §9.4 (2026-07-22) — ONE canonical policy-precedence model.
 *
 * The mandated scope chain, outermost first:
 *
 *   PLATFORM_BASELINE → ORGANIZATION → WORKSPACE → CASE → EVIDENCE_HOLD
 *
 * Rules encoded here (pure engine, no storage coupling):
 *   1. The DEEPEST scope with a defined value wins by default — child
 *      scopes specialize parent defaults.
 *   2. A MANDATORY parent layer is a floor: a deeper value that is
 *      WEAKER (per the policy family's own `strongerOf` comparator)
 *      cannot displace it — the parent prevails and the result is
 *      flagged so surfaces can render "enforced by organization".
 *      Child scopes may STRENGTHEN mandatory parents, never weaken.
 *   3. EVIDENCE_HOLD is absolute for destruction-family decisions:
 *      `legalHoldPrevails` short-circuits every other layer. (The
 *      destruction gates already enforce this operationally; the
 *      engine is the shared vocabulary they converge on.)
 *
 * Adoption ledger (docs/architecture/program-ledger.md, Phase 6): the
 * §9.4 scout catalogued 5+ ad-hoc `resolveEffective*` resolvers, each
 * with a private scope vocabulary. They migrate onto this engine
 * incrementally; `retention-inheritance.service.ts` is the first
 * adopter (org immutable template = mandatory floor — previously
 * documented but UNENFORCED).
 */

export const POLICY_SCOPE_PRECEDENCE = [
  "PLATFORM_BASELINE",
  "ORGANIZATION",
  "WORKSPACE",
  "CASE",
  "EVIDENCE_HOLD",
] as const;
export type PolicyScope = (typeof POLICY_SCOPE_PRECEDENCE)[number];

export type PolicyLayer<T> = {
  scope: PolicyScope;
  /** Undefined = this scope does not define the policy. */
  value: T | undefined;
  /**
   * Mandatory layers are floors for every DEEPER scope: a weaker child
   * value cannot displace them. Meaningless on the deepest layer.
   */
  mandatory?: boolean;
};

export type EffectivePolicy<T> =
  | {
      defined: true;
      value: T;
      scope: PolicyScope;
      /**
       * True when a deeper scope defined a WEAKER value that a
       * mandatory parent overrode. Surfaces render "enforced by
       * <scope>" from this.
       */
      parentPrevailed: boolean;
      /** The scope whose weaker value was overridden, when any. */
      overriddenScope: PolicyScope | null;
    }
  | { defined: false };

/**
 * Resolve one policy value across the canonical scope chain.
 *
 * `strongerOf(a, b)` is the policy family's own strength order: it
 * returns whichever of the two values is at least as strong. It MUST
 * be total for the family's value domain (e.g. retention: indefinite
 * beats any number; larger day-count beats smaller).
 */
export function resolveEffectivePolicyValue<T>(
  layers: ReadonlyArray<PolicyLayer<T>>,
  strongerOf: (a: T, b: T) => T,
): EffectivePolicy<T> {
  // Normalize into canonical order regardless of caller ordering.
  const ordered = [...layers].sort(
    (a, b) =>
      POLICY_SCOPE_PRECEDENCE.indexOf(a.scope) -
      POLICY_SCOPE_PRECEDENCE.indexOf(b.scope),
  );

  let effective: { value: T; scope: PolicyScope } | null = null;
  let mandatoryFloor: { value: T; scope: PolicyScope } | null = null;
  let parentPrevailed = false;
  let overriddenScope: PolicyScope | null = null;

  for (const layer of ordered) {
    if (layer.value === undefined) continue;

    if (mandatoryFloor !== null) {
      // A deeper layer may only displace the floor by being at least
      // as strong as it.
      const stronger = strongerOf(layer.value, mandatoryFloor.value);
      if (stronger !== layer.value) {
        // Weaker child — the mandatory parent prevails.
        parentPrevailed = true;
        overriddenScope = layer.scope;
        effective = mandatoryFloor;
        continue;
      }
    }

    effective = { value: layer.value, scope: layer.scope };
    if (layer.mandatory) {
      mandatoryFloor = { value: layer.value, scope: layer.scope };
      // A new (deeper) floor resets any earlier override bookkeeping —
      // the deepest applicable floor governs from here on.
      parentPrevailed = false;
      overriddenScope = null;
    }
  }

  if (!effective) return { defined: false };
  return {
    defined: true,
    value: effective.value,
    scope: effective.scope,
    parentPrevailed,
    overriddenScope,
  };
}

/**
 * §9.4 rule 3 — Legal Hold always prevents conflicting destruction.
 * Destruction-family callers evaluate the hold FIRST; every other
 * layer is irrelevant while a hold is active.
 */
export function legalHoldPrevails(input: {
  hasActiveLegalHold: boolean;
}): { destructionAllowed: false; reason: "LEGAL_HOLD_ACTIVE" } | null {
  if (input.hasActiveLegalHold) {
    return { destructionAllowed: false, reason: "LEGAL_HOLD_ACTIVE" };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Retention strength order — the first adopter's comparator. Retention
// strength: keeping evidence LONGER is stronger. `null` = indefinite
// (FOREVER) beats every finite day-count; otherwise larger wins.
// ---------------------------------------------------------------------------
export function strongerRetentionDays(
  a: number | null,
  b: number | null,
): number | null {
  if (a === null || b === null) return null;
  return a >= b ? a : b;
}
