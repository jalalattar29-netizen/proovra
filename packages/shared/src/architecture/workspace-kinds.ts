/**
 * PROOVRA Target Domain Blueprint — Workspace kinds (Phase 1.5 constitutional).
 *
 * This module encodes the TARGET workspace-kind vocabulary as a single,
 * cross-package, additive source of truth. It does NOT replace the
 * existing runtime `WorkspaceScope` enum (services/api/src/services/
 * platform-context/types.ts:98), which still emits "PERSONAL" | "TEAM"
 * for backward compatibility while the rename to "ORGANIZATION" is
 * sequenced through Phase 3+.
 *
 * NEW code that needs to encode the TARGET model should import from
 * here. Existing code that reads the runtime envelope continues to read
 * "PERSONAL" | "TEAM" — that drift is documented in
 * docs/architecture/domain-debt-register.md and current-to-target-domain-map.md.
 *
 * Constitutional invariants enforced here:
 *   INV-1: TARGET_WORKSPACE_KINDS is exactly ["PERSONAL", "ORGANIZATION"].
 *   INV-2: No fake workspace kinds (TeamWorkspace, ReviewerWorkspace,
 *          GovernanceWorkspace, OperationsWorkspace) ever enter this list.
 *   INV-14: This is the canonical scope-axis vocabulary for the workspace
 *           kind. New scope discriminators are forbidden.
 *
 * See: docs/architecture/proovra-domain-model.md
 * See: docs/architecture/architecture-invariants.md
 */

/**
 * The canonical set of Workspace kinds in the Target Domain Blueprint.
 *
 * EXACTLY TWO VALUES. No other workspace kind is permitted.
 *
 * Future code must import this constant rather than hard-coding the strings.
 */
export const TARGET_WORKSPACE_KINDS = ["PERSONAL", "ORGANIZATION"] as const;

/**
 * The target Workspace kind union type, derived from the canonical constant.
 *
 * Use this type in new code that operates against the target model.
 */
export type TargetWorkspaceKind = (typeof TARGET_WORKSPACE_KINDS)[number];

/**
 * Type guard — does the value represent the Personal Workspace kind?
 *
 * Accepts the legacy runtime string "PERSONAL" (which today's envelope
 * emits) AND the target string "PERSONAL" (identical). The function will
 * also tolerate the legacy `WorkspaceScope` value "TEAM" returning false,
 * which is correct (TEAM is not Personal in any vocabulary).
 */
export function isPersonalWorkspaceKind(
  value: string | null | undefined,
): boolean {
  return value === "PERSONAL";
}

/**
 * Type guard — does the value represent the Organization Workspace kind
 * in the TARGET model?
 *
 * Accepts:
 *   - "ORGANIZATION" (the target value)
 *   - "TEAM" (the legacy runtime value that maps to ORGANIZATION in the
 *     target model — i.e. a non-personal `Team` row, which is conceptually
 *     today's "team workspace" but tomorrow's "organization workspace")
 *
 * The bridging behavior is intentional: code that asks "is this an
 * Organization Workspace?" gets a correct answer whether the envelope
 * emits today's "TEAM" or tomorrow's "ORGANIZATION".
 */
export function isOrganizationWorkspaceKind(
  value: string | null | undefined,
): boolean {
  return value === "ORGANIZATION" || value === "TEAM";
}

/**
 * Runtime assertion — throw if the value is not one of the TARGET workspace
 * kinds. Use in code paths that MUST already be operating on the target
 * vocabulary (i.e. new code, not legacy paths).
 *
 * Does NOT tolerate the legacy "TEAM" value — this assertion is for code
 * that is post-migration. For bridging code, use `coerceLegacyScopeToTargetKind`.
 *
 * @param value the value to check
 * @param context optional caller identifier for the error message
 */
export function assertTargetWorkspaceKind(
  value: unknown,
  context = "workspace kind",
): asserts value is TargetWorkspaceKind {
  if (
    typeof value !== "string" ||
    !(TARGET_WORKSPACE_KINDS as readonly string[]).includes(value)
  ) {
    throw new Error(
      `[architecture] ${context} must be one of ${JSON.stringify(
        TARGET_WORKSPACE_KINDS,
      )}; got ${JSON.stringify(value)}. ` +
        `See docs/architecture/proovra-domain-model.md for the canonical model.`,
    );
  }
}

/**
 * Bridge helper — coerce a legacy `WorkspaceScope` value ("PERSONAL" | "TEAM")
 * to the equivalent target `WorkspaceKind` value ("PERSONAL" | "ORGANIZATION").
 *
 * Use this only in transition code that consumes the legacy envelope but
 * needs to express the result in target vocabulary. Returns null if the
 * input is neither legacy value.
 */
export function coerceLegacyScopeToTargetKind(
  legacyScope: string | null | undefined,
): TargetWorkspaceKind | null {
  if (legacyScope === "PERSONAL") return "PERSONAL";
  if (legacyScope === "TEAM") return "ORGANIZATION";
  return null;
}

/**
 * The legacy runtime scope vocabulary, retained here as a named constant so
 * source-contract tests can pin its current set and detect new additions.
 *
 * **DO NOT ADD VALUES.** If the runtime needs a new scope value, that is a
 * constitutional change and must be approved by the architecture board.
 */
export const LEGACY_WORKSPACE_SCOPES = ["PERSONAL", "TEAM"] as const;
export type LegacyWorkspaceScope = (typeof LEGACY_WORKSPACE_SCOPES)[number];

/**
 * Forbidden workspace-kind tokens. Source-contract tests grep new code for
 * these and fail the build if they appear in non-allowlisted files.
 *
 * Each token represents a "fake workspace type" that the TOM explicitly
 * forbids (INV-2).
 */
export const FORBIDDEN_WORKSPACE_KIND_TOKENS = [
  "TeamWorkspace",
  "ReviewerWorkspace",
  "GovernanceWorkspace",
  "OperationsWorkspace",
] as const;
export type ForbiddenWorkspaceKindToken =
  (typeof FORBIDDEN_WORKSPACE_KIND_TOKENS)[number];

/**
 * Forbidden workspace-kind UI strings (case-insensitive grep). Same rule as
 * tokens above but for user-facing copy.
 */
export const FORBIDDEN_WORKSPACE_KIND_UI_STRINGS = [
  "team workspace",
  "reviewer workspace",
  "governance workspace",
  "operations workspace",
] as const;
