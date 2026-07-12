/**
 * Phase C4 (live) — DB-backed citation resolver factory.
 *
 * Produces the `CitationResolver` the Copilot orchestrators pass to
 * `validateCitations`. Each citation type maps to an injectable per-type lookup
 * that returns the authoritative facts (workspace, current version, deleted,
 * authorized, sequence) the validator checks. The model may reference an object
 * id/version/route, but the SERVER performs the lookup — an invented reference
 * resolves to null (rejected) and the tenant is never taken from the model.
 *
 * Lookups are injected so the resolver is unit-testable without a live DB; the
 * route wires the real Prisma-backed lookups.
 */
import type {
  CitationResolver,
  CitationTarget,
  CitationType,
} from "./ai-citation.service.js";

export type CitationTypeLookup = (
  objectId: string,
) => Promise<CitationTarget | null>;

export type CitationLookups = Partial<Record<CitationType, CitationTypeLookup>>;

/**
 * Compose a `CitationResolver` from per-type lookups. Any citation whose type
 * has no configured lookup resolves to null (rejected — fail-closed).
 */
export function buildCitationResolver(lookups: CitationLookups): CitationResolver {
  return async (type: CitationType, objectId: string): Promise<CitationTarget | null> => {
    const lookup = lookups[type];
    if (!lookup) return null;
    return lookup(objectId);
  };
}

/**
 * Minimal Prisma surface the built-in lookups need (kept narrow so callers can
 * pass the real client or a test double).
 */
export type CitationPrisma = {
  evidence: {
    findUnique: (args: {
      where: { id: string };
      select: Record<string, true>;
    }) => Promise<
      | { teamId: string | null; deletedAt: Date | null; verificationPackageVersion: number | null }
      | null
    >;
  };
  case: {
    findUnique: (args: {
      where: { id: string };
      select: Record<string, true>;
    }) => Promise<{ teamId: string | null; deletedAt?: Date | null } | null>;
  };
};

/**
 * Real evidence + case lookups scoped to a workspace. Authorization at the
 * workspace boundary: the target's teamId must equal the request's teamId (the
 * validator re-checks this). `authorized` is true when the row is in-tenant.
 */
export function buildWorkspaceCitationLookups(
  prisma: CitationPrisma,
  teamId: string,
): CitationLookups {
  return {
    EVIDENCE_RECORD: async (id) => {
      const row = await prisma.evidence.findUnique({
        where: { id },
        select: { teamId: true, deletedAt: true, verificationPackageVersion: true },
      });
      if (!row) return null;
      return {
        workspaceId: row.teamId ?? "",
        currentVersion: row.verificationPackageVersion ?? null,
        deleted: row.deletedAt != null,
        authorized: row.teamId === teamId,
      };
    },
    CASE: async (id) => {
      const row = await prisma.case.findUnique({
        where: { id },
        select: { teamId: true },
      });
      if (!row) return null;
      return {
        workspaceId: row.teamId ?? "",
        currentVersion: null,
        deleted: row.deletedAt != null,
        authorized: row.teamId === teamId,
      };
    },
  };
}
