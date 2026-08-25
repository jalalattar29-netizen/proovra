/**
 * WORKSPACE-SCOPE CONVERGENCE — the ONE place that decides, and reads, an
 * incident's scope.
 *
 * The defect this closes
 * ----------------------
 * `OperationalIncident.team_id` is nullable, and one absence carried two
 * incompatible meanings:
 *
 *   * an incident that belongs to no tenant — an account-tier security event
 *     recorded before any workspace was resolved; and
 *   * an ORPHAN. The `team` relation is `ON DELETE SET NULL`, so deleting a
 *     workspace rewrites every one of its incidents into the same NULL bucket.
 *
 * Four tenant surfaces asked for `OR: [{ teamId: X }, { teamId: null }]` to
 * pick up the first, and therefore also returned every OTHER tenant's orphans
 * to whoever asked. That is a cross-tenant read produced by an overloaded
 * absence, not by a missing check.
 *
 * `IncidentScope` records the intent explicitly. This module is the only place
 * that assigns it and the only place that builds a predicate from it, so the
 * write rule and the read rule cannot drift apart — which is the failure mode
 * that made the NULL ambiguous in the first place.
 */

import * as prismaPkg from "@prisma/client";
import type { Prisma } from "@prisma/client";

export type IncidentScopeName = prismaPkg.IncidentScope;

/**
 * How a caller DECLARES the scope of an incident it is recording.
 *
 * Deliberately not "the scope" — a caller states which of two situations it is
 * in, and this module derives the stored value. A caller that could pass
 * `scope: "WORKSPACE"` alongside `teamId: null` would be able to write the
 * contradiction the column exists to prevent.
 */
export type IncidentScopeDeclaration =
  | { kind: "WORKSPACE"; workspaceId: string }
  /**
   * A deliberate platform-wide condition. Visible ONLY through protected
   * platform authorities, never through a tenant surface.
   *
   * No caller in this codebase uses it yet, and that is the honest state: the
   * only existing producer of a NULL-team incident is the account-tier
   * security-event path, which is not a platform declaration. The variant
   * exists so that when a genuine platform writer is added it has a way to say
   * so, rather than reaching for a NULL and hoping a reader guesses right.
   */
  | { kind: "PLATFORM" };

/**
 * Derive what to store, from a workspace id that may be absent.
 *
 * A present workspace id is WORKSPACE. An ABSENT one is LEGACY_UNSCOPED —
 * never WORKSPACE (which would be a lie about which tenant it belongs to) and
 * never PLATFORM (which would be inventing an intent the caller did not
 * express). The row is kept in full and stays out of every surface until a
 * human classifies it.
 */
export function scopeForWorkspaceId(
  workspaceId: string | null | undefined,
): prismaPkg.IncidentScope {
  return workspaceId
    ? prismaPkg.IncidentScope.WORKSPACE
    : prismaPkg.IncidentScope.LEGACY_UNSCOPED;
}

/** Derive what to store from an explicit declaration. */
export function scopeForDeclaration(
  declaration: IncidentScopeDeclaration,
): prismaPkg.IncidentScope {
  return declaration.kind === "PLATFORM"
    ? prismaPkg.IncidentScope.PLATFORM
    : prismaPkg.IncidentScope.WORKSPACE;
}

/**
 * THE tenant predicate. Every workspace-facing incident read composes this.
 *
 * Both halves are load-bearing. `scope: WORKSPACE` excludes platform rows and
 * legacy orphans; `teamId: <workspace>` picks one tenant out of the rest. The
 * predicate is a conjunction with no `OR` arm at all, which is what makes it
 * impossible for this read to widen the way the one it replaces did.
 */
export function workspaceIncidentWhere(
  workspaceId: string,
): Prisma.OperationalIncidentWhereInput {
  return {
    scope: prismaPkg.IncidentScope.WORKSPACE,
    teamId: workspaceId,
  };
}

/**
 * The platform-surface predicate, for protected platform authorities only.
 *
 * LEGACY_UNSCOPED is deliberately EXCLUDED. An unclassified orphan is not a
 * platform incident; presenting it as one in the platform console would
 * reproduce the same overload one level up, and would show a platform operator
 * a deleted tenant's conditions as if they were the platform's own.
 */
export function platformIncidentWhere(): Prisma.OperationalIncidentWhereInput {
  return { scope: prismaPkg.IncidentScope.PLATFORM };
}

/**
 * The quarantine predicate: rows nobody has classified.
 *
 * Exposed so an operator tool can FIND them — retention and reclassification
 * are real needs — and so a test can assert that no tenant or platform read
 * returns them. It is not used by any product surface.
 */
export function legacyUnscopedIncidentWhere(): Prisma.OperationalIncidentWhereInput {
  return { scope: prismaPkg.IncidentScope.LEGACY_UNSCOPED };
}
