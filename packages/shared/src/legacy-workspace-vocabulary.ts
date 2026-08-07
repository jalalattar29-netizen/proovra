/**
 * PHASE 12 CORRECTIVE PASS §1 (ARCH-001 + LEGACY-001, 2026-08-07) — THE
 * BOUNDED, VERSIONED, READ-ONLY COMPATIBILITY ADAPTER.
 *
 * Why this exists
 * ---------------------------------------------------------------------------
 * The runtime vocabulary changed: `workspaceType: "PERSONAL" | "TEAM"` became
 * `billingShape: "SINGLE_OCCUPANT" | "SHARED"`, and the `TEAM_WORKSPACE_*`
 * error codes became shape-named ones. A client already installed on somebody's
 * phone does not update because the server did, and an error code it cannot
 * parse is an error it renders as "something went wrong".
 *
 * So the old spellings remain REACHABLE — and only reachable — through this
 * module. Everything about it is deliberately narrow:
 *
 *   READ-ONLY      It maps a canonical value to a legacy STRING. It cannot
 *                  produce a canonical value from a legacy one, so no request
 *                  can enter the system speaking the old language.
 *   NON-AUTHORIZING  It takes no actor, no workspace and no permission, and
 *                  returns no decision. There is nothing here to authorize
 *                  with.
 *   NON-PERSISTING It touches no database. A legacy string never becomes a
 *                  stored fact.
 *   METERED        Every call increments a counter, so "who is still on the
 *                  old vocabulary?" is a number an operator can read rather
 *                  than a guess.
 *   VERSIONED      `LEGACY_WORKSPACE_VOCABULARY_VERSION` is emitted alongside
 *                  the values it produces, so a client knows which contract it
 *                  is being answered in.
 *   REMOVABLE      `LEGACY_WORKSPACE_VOCABULARY_REMOVAL_CONDITION` states
 *                  exactly what has to be true before this file is deleted.
 *
 * `phase-12-arch-001-workspace-vocabulary.test.ts` fails if any of those
 * properties stops holding — in particular if this module is ever imported by
 * an authorization path or a writer.
 */

/**
 * The contract version of the LEGACY projection, not of the product. Bumped
 * only if the legacy shape itself has to change, which would mean two
 * generations of old client — a situation this module exists to make visible
 * rather than to accommodate silently.
 */
export const LEGACY_WORKSPACE_VOCABULARY_VERSION = 1 as const;

/**
 * The condition under which this file is deleted. Stated as DATA so it is
 * checkable, not as a promise in a comment.
 */
export const LEGACY_WORKSPACE_VOCABULARY_REMOVAL_CONDITION =
  "Delete when `legacy_workspace_vocabulary_projection_total` has been zero across a full release observation window AND the minimum supported mobile build is at or past the release that adopted `billingShape` + the shape-named error codes. Until then it is the only thing standing between an old client and an unparseable response." as const;

export type LegacyWorkspaceScopeType = "PERSONAL" | "TEAM";

/** Counter name. Owned by the shared metrics registry; incremented via the hook below. */
export const LEGACY_VOCABULARY_METRIC =
  "legacy_workspace_vocabulary_projection_total" as const;

type MeterHook = (metric: typeof LEGACY_VOCABULARY_METRIC) => void;

let meter: MeterHook | null = null;

/**
 * Install the counter.
 *
 * A hook rather than a direct import because @proovra/shared must not depend
 * on the runtime metrics package — and because a host that forgets to install
 * one gets an unmetered adapter, which the gate treats as a failure.
 */
export function setLegacyVocabularyMeter(hook: MeterHook | null): void {
  meter = hook;
}

/** In-process count, for hosts with no metrics registry and for the gate. */
let localCount = 0;
export function legacyVocabularyProjectionCount(): number {
  return localCount;
}
export function resetLegacyVocabularyProjectionCount(): void {
  localCount = 0;
}

function record(): void {
  localCount += 1;
  meter?.(LEGACY_VOCABULARY_METRIC);
}

/**
 * Canonical commercial shape → the legacy spelling an old client expects.
 *
 * ONE DIRECTION ONLY. There is deliberately no `legacyToCanonical`: a client
 * that sends "TEAM" must not be able to name a tenancy the server then acts
 * on, and the absence of the inverse is what makes that structurally true
 * rather than merely intended.
 */
export function legacyWorkspaceTypeFor(
  billingShape: "SINGLE_OCCUPANT" | "SHARED",
): LegacyWorkspaceScopeType {
  record();
  return billingShape === "SINGLE_OCCUPANT" ? "PERSONAL" : "TEAM";
}

/**
 * Canonical error code → the legacy code an old client can still branch on.
 *
 * Only the codes that actually changed are listed. An unlisted code is
 * returned unchanged, because inventing a legacy spelling for a code that
 * never had one would be manufacturing a compatibility problem.
 */
const LEGACY_ERROR_CODES: Readonly<Record<string, string>> = Object.freeze({
  PLAN_NOT_ALLOWED_FOR_SHARED_WORKSPACE: "PLAN_NOT_ALLOWED_FOR_TEAM_WORKSPACE",
  SHARED_WORKSPACE_LIMIT_REACHED: "TEAM_WORKSPACE_LIMIT_REACHED",
  SHARED_WORKSPACE_PLAN_REQUIRED: "TEAM_WORKSPACE_PLAN_REQUIRED",
  SHARED_WORKSPACE_FORBIDDEN: "TEAM_WORKSPACE_FORBIDDEN",
});

export function legacyErrorCodeFor(canonicalCode: string): string {
  const legacy = LEGACY_ERROR_CODES[canonicalCode];
  if (!legacy) return canonicalCode;
  record();
  return legacy;
}

/**
 * The full legacy envelope, for a surface that answers an old client.
 *
 * Carries its own version so the client knows which contract it was answered
 * in — a bare legacy string is indistinguishable from a server that never
 * migrated.
 */
export function legacyWorkspaceVocabularyEnvelope(input: {
  billingShape: "SINGLE_OCCUPANT" | "SHARED";
}): {
  legacyVocabularyVersion: typeof LEGACY_WORKSPACE_VOCABULARY_VERSION;
  workspaceType: LegacyWorkspaceScopeType;
} {
  return {
    legacyVocabularyVersion: LEGACY_WORKSPACE_VOCABULARY_VERSION,
    workspaceType: legacyWorkspaceTypeFor(input.billingShape),
  };
}
