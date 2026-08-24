/**
 * WORKSPACE READ SCOPE — the single query authority for the two
 * mixed-ownership models in this schema.
 *
 * The fact this module exists to encode
 * ------------------------------------
 * `Evidence.team_id` and `Case.team_id` are both NULLABLE. Until Phase
 * HOME-DATA-OWNERSHIP the write paths used that: personal records were stored
 * with `team_id = NULL` and "NULL means personal". Both write paths now stamp
 * a REAL workspace id on every new row — `cases.routes.ts` bootstraps the
 * owner's personal workspace rather than writing NULL, and the capture path
 * does the same — and `scripts/backfill-personal-team-ownership.ts` migrates
 * the legacy rows.
 *
 * READS cannot assume the backfill has run. Local checkouts, restored
 * snapshots and any production database before the backfill still hold rows
 * whose ownership is carried by `owner_user_id` alone. A read written as
 * `WHERE team_id = :workspace` silently omits every one of them, and the
 * omission is invisible: it returns a smaller number, not an error. That is
 * how Operations rendered "workspace clear" over a workspace whose Home was
 * simultaneously reporting CRITICAL conditions.
 *
 * The rule
 * --------
 *   PERSONAL workspace:   team_id = :workspace
 *                         OR (team_id IS NULL AND owner_user_id = :owner)
 *   Every other kind:     team_id = :workspace
 *
 * The NULL arm is ALWAYS conjoined with the owner. That conjunction is what
 * makes the widening safe: a personal workspace has exactly one owner, so the
 * arm can only ever reach that person's own orphan rows. An unbound
 * `team_id IS NULL` arm — the obvious-looking shortcut — would return every
 * tenant's orphans to whoever asked, which is strictly worse than the
 * omission it was written to fix.
 * `services/api/scripts/verify-workspace-scope-authorities.mjs` fails the
 * build on one.
 *
 * Why it lives in shared-runtime
 * ------------------------------
 * The rule started in `services/api`. The Worker cannot import from there, so
 * the Worker's org-health refresh, archive-tier sweep and graph reconciliation
 * each wrote their own `where: { teamId }` — and a background job that reads a
 * SMALLER population than the page it feeds is exactly the disagreement this
 * convergence exists to end. This package is where Prisma-using logic that
 * neither service may own alone belongs; the seat-occupancy authority and the
 * reconciliation-run authority moved here for the same reason.
 *
 * What this module is NOT
 * -----------------------
 * It is not authorization. It answers "which rows belong to this workspace",
 * never "may this actor read them" — membership, role, lifecycle and
 * capability are decided upstream by the canonical `AuthorizedWorkspaceContext`
 * chain in `services/api/src/middleware/authorize.ts`, and nothing here
 * re-derives any of it. Merging the two would mean a read-scope change could
 * quietly become an access change.
 *
 * It is also read-only. Every function is a pure projection of an already
 * proven context into a Prisma `where` fragment; none of them writes.
 */

import type { Prisma, PrismaClient } from "@prisma/client";

import { getRegisteredPrisma } from "./prisma-registry.js";

// ---------------------------------------------------------------------------
// Branded scope types.
//
// The brand is a phantom, optional property: it exists only in the type
// system, is never written at runtime, and does not change how Prisma sees the
// value. What it buys is that the scope becomes RECOGNISABLE as it is passed
// between functions and modules — a parameter annotated
// `WorkspaceEvidenceScope` is provably a canonical scope no matter how far it
// travelled from the call that produced it.
//
// The architecture verifier reads exactly that annotation. Without it the scan
// could only recognise a scope inside the function that built one, so any
// helper that ACCEPTED a scope would read as unscoped — which pushes the rule
// toward either false failures or a hand-maintained exception list, and this
// codebase has already paid once for the second.
// ---------------------------------------------------------------------------

declare const WORKSPACE_SCOPE_BRAND: unique symbol;

/** A Prisma Evidence filter proven to express the canonical workspace rule. */
export type WorkspaceEvidenceScope = Prisma.EvidenceWhereInput & {
  readonly [WORKSPACE_SCOPE_BRAND]?: "evidence";
};

/** A Prisma Case filter proven to express the canonical workspace rule. */
export type WorkspaceCaseScope = Prisma.CaseWhereInput & {
  readonly [WORKSPACE_SCOPE_BRAND]?: "case";
};

export type PersonalScope = {
  isPersonal: boolean;
  ownerUserId: string | null;
};

/**
 * The minimum a caller must prove to obtain a scope.
 *
 * A full `CanonicalWorkspaceContext` satisfies this STRUCTURALLY, which is the
 * intended path: that context is minted only by the canonical authorization
 * chain, so a caller holding one has already proven membership, status,
 * lifecycle and permission on this exact workspace, and can pass it straight
 * in with no adapter and no hand-assembly of the three fields.
 *
 * Stated structurally rather than as the context type itself so that this
 * package does not depend on `services/api`, and so the LEGACY_TRANSITIONAL
 * entry points below — the ones that still start from a bare workspace id
 * because their callers have not been migrated to carry a context yet — can
 * build the same shape from a single indexed lookup and feed the SAME
 * projection. One rule, two ways in, rather than two rules.
 */
export type WorkspaceScopeInput = {
  readonly physicalWorkspaceId: string;
  readonly workspaceKind: "PERSONAL" | "OWNED" | "ORGANIZATION";
  readonly personalOwnerUserId: string | null;
};

// ---------------------------------------------------------------------------
// The projection. ONE implementation; everything else routes through it.
// ---------------------------------------------------------------------------

/**
 * Is this workspace one whose population must widen to owner-bound NULL-team
 * rows, and if so, to whom?
 *
 * A workspace widens only when it is PERSONAL *and* has a known owner. A
 * PERSONAL workspace with no recorded owner falls through to the strict
 * filter: there is no id to bind the NULL arm to, and an unbound arm is not an
 * acceptable substitute for a missing one.
 */
function widensToOwner(input: WorkspaceScopeInput): string | null {
  if (input.workspaceKind !== "PERSONAL") return null;
  return input.personalOwnerUserId ?? null;
}

/**
 * Canonical Evidence population for one workspace.
 *
 * Pure. No database access, no writes, no authorization. Given a context the
 * caller has already proven, it returns the filter and nothing else.
 */
export function evidenceScopeFor(
  input: WorkspaceScopeInput,
): WorkspaceEvidenceScope {
  const owner = widensToOwner(input);
  if (owner) {
    return {
      OR: [
        { teamId: input.physicalWorkspaceId },
        { AND: [{ ownerUserId: owner }, { teamId: null }] },
      ],
    };
  }
  return { teamId: input.physicalWorkspaceId };
}

/**
 * Canonical Case population for one workspace.
 *
 * Identical rule, and deliberately so: `Case` carries the same nullable
 * `team_id` and the same `owner_user_id`, and its write path was corrected in
 * the same phase as Evidence's. Two models with one ownership contract get one
 * rule; giving Case its own would be a second authority that agreed only until
 * the first time one of them was edited.
 */
export function caseScopeFor(input: WorkspaceScopeInput): WorkspaceCaseScope {
  const owner = widensToOwner(input);
  if (owner) {
    return {
      OR: [
        { teamId: input.physicalWorkspaceId },
        { AND: [{ ownerUserId: owner }, { teamId: null }] },
      ],
    };
  }
  return { teamId: input.physicalWorkspaceId };
}

/**
 * Canonical Evidence population across SEVERAL workspaces at once.
 *
 * For the genuinely multi-workspace surfaces — the personal inbox, the
 * cross-workspace analytics rollup — which previously wrote
 * `teamId: { in: teamIds }` and therefore omitted the legacy NULL-team rows of
 * every personal workspace in the list.
 *
 * Built as a union of per-workspace scopes rather than as one clever
 * predicate. A single `OR: [{ teamId: { in: ids } }, { teamId: null,
 * ownerUserId: { in: owners } }]` looks equivalent and is not: it would admit
 * a row owned by owner A whose workspace is not in the list at all, because
 * nothing ties an owner back to the workspace that made them eligible. Each
 * arm here carries its own workspace's owner, so the binding survives the
 * union.
 */
export function evidenceScopeForMany(
  inputs: ReadonlyArray<WorkspaceScopeInput>,
): WorkspaceEvidenceScope {
  // An empty list must match NOTHING. `{ OR: [] }` is not that — Prisma
  // treats an empty OR as an unconstrained filter, which would turn "this
  // user belongs to no workspace" into "return every row in the table".
  if (inputs.length === 0) return { id: { in: [] } };
  return { OR: inputs.map((input) => evidenceScopeFor(input)) };
}

/** Multi-workspace resolver for callers that hold only workspace ids. */
export async function workspaceEvidenceWhereMany(
  teamIds: ReadonlyArray<string>,
  client: PrismaClient = getRegisteredPrisma(),
): Promise<WorkspaceEvidenceScope> {
  const unique = [...new Set(teamIds)];
  const inputs = await Promise.all(
    unique.map((teamId) => scopeInputForTeamId(teamId, client)),
  );
  return evidenceScopeForMany(inputs);
}

/**
 * SCOPING A DEPENDENT MODEL.
 *
 * A row on a model that hangs off Evidence — a reviewer comment, an
 * annotation, a review workflow, a part — belongs to the workspace its
 * Evidence belongs to. Scope those by spelling the relation inline:
 *
 *     where: { evidence: <scope>, ... }
 *
 * There is deliberately NO wrapper helper for this. Two earlier ones
 * (`evidenceRelationScopeFor`, `workspaceEvidenceRelationWhere`) were exported
 * and never called, because the inline form is shorter than importing them —
 * and an exported rule nobody invokes is exactly the state `workspaceCaseWhere`
 * was in when Case reads drifted away from Evidence reads. The architecture
 * verifier recognises the inline form as RELATION_SCOPED, so the rule is
 * enforced without a function to forget.
 *
 * `EvidenceReviewWorkflow` is the case that matters most: it has its OWN
 * nullable `team_id` which its writer sets to NULL whenever the caller omits
 * one, so scoping it by that column reproduces the original defect on a second
 * table. Scoping it through `evidence` cannot.
 */

// ---------------------------------------------------------------------------
// LEGACY_TRANSITIONAL entry points.
//
// These start from a bare workspace id and resolve the owner themselves. They
// exist because most consumers on this codebase still receive a `teamId`
// string rather than a proven context; migrating every one of them in a single
// pass would have meant touching hundreds of call sites to change one rule.
//
// They are NOT a second authority: each is a thin resolver in front of the
// projections above, so a change to the rule changes both paths at once. As
// consumers gain a `CanonicalWorkspaceContext` they should move to
// `evidenceScopeFor` / `caseScopeFor`, which need no query at all.
// ---------------------------------------------------------------------------

/**
 * "Is this workspace personal, and who owns it?" — one indexed primary-key
 * lookup.
 *
 * The client is optional and defaults to the host's registered Prisma. It is
 * accepted explicitly so a caller that already holds a transaction — or a test
 * with an in-memory fake — resolves the scope through the SAME connection it
 * runs its query on, rather than silently reaching a second one.
 */
export async function resolvePersonalScope(
  teamId: string,
  client: PrismaClient = getRegisteredPrisma(),
): Promise<PersonalScope> {
  const team = await client.team.findUnique({
    where: { id: teamId },
    select: { isPersonal: true, ownerUserId: true },
  });
  return {
    isPersonal: team?.isPersonal === true,
    ownerUserId: team?.ownerUserId ?? null,
  };
}

/**
 * Resolve a bare workspace id into the scope input the projections take.
 *
 * `isPersonal` is the column the personal-workspace fallback has always keyed
 * on, and it is the first thing `resolveWorkspaceKind` consults, so the two
 * cannot disagree about which workspaces widen.
 */
async function scopeInputForTeamId(
  teamId: string,
  client: PrismaClient,
): Promise<WorkspaceScopeInput> {
  const scope = await resolvePersonalScope(teamId, client);
  return {
    physicalWorkspaceId: teamId,
    workspaceKind: scope.isPersonal ? "PERSONAL" : "ORGANIZATION",
    personalOwnerUserId: scope.ownerUserId,
  };
}

/** Workspace filter for Evidence reads, from a bare workspace id. */
export async function workspaceEvidenceWhere(
  teamId: string,
  client: PrismaClient = getRegisteredPrisma(),
): Promise<WorkspaceEvidenceScope> {
  return evidenceScopeFor(await scopeInputForTeamId(teamId, client));
}

/** Workspace filter for Case reads, from a bare workspace id. */
export async function workspaceCaseWhere(
  teamId: string,
  client: PrismaClient = getRegisteredPrisma(),
): Promise<WorkspaceCaseScope> {
  return caseScopeFor(await scopeInputForTeamId(teamId, client));
}

