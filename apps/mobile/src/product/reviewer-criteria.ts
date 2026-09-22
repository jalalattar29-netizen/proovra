/**
 * REVIEWER CRITERIA — pure projections for the criteria catalogue.
 *
 * Ports `apps/web/app/(app)/settings/reviewer-criteria/page.tsx` over
 * `GET /v1/reviewer-criteria?teamId=`, `.../:id/duplicate`, `.../:id/:action`
 * and `GET .../:id/usage`.
 *
 * ===========================================================================
 * PUBLISHED IS IMMUTABLE, AND THAT IS THE WHOLE POINT
 * ===========================================================================
 * Criteria are human-authored and versioned, and a PUBLISHED version cannot be
 * edited — the API answers 409 `published_immutable`. A reviewer's decision is
 * only meaningful against a criteria version that cannot have changed
 * underneath it afterwards, so a surface that offers "edit" on a published set
 * is not a convenience, it is an invitation to a request that will be refused
 * and, worse, a suggestion that the record could be rewritten.
 *
 * To change a published set you DUPLICATE it, which creates a new draft. That
 * is the affordance this module exposes in its place.
 *
 * AI never creates or publishes criteria. Nothing here generates one.
 *
 * Pure: no React, no react-native, no fetch.
 */
import type { ProovraStatusTone } from "@proovra/ui";

const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" ? (v as Record<string, unknown>) : {};
const rows = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string | null =>
  typeof v === "string" && v.length > 0 ? v : null;
const num = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

export function buildCriteriaPath(teamId: string): string {
  return `/v1/reviewer-criteria?teamId=${encodeURIComponent(teamId)}`;
}

export function buildCriteriaActionPath(setId: string, action: string): string {
  return `/v1/reviewer-criteria/${encodeURIComponent(setId)}/${encodeURIComponent(action)}`;
}

export function buildCriteriaUsagePath(setId: string, teamId: string): string {
  return (
    `/v1/reviewer-criteria/${encodeURIComponent(setId)}/usage` +
    `?teamId=${encodeURIComponent(teamId)}`
  );
}

// ---------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------

export interface CriteriaVersion {
  id: string;
  version: number;
  title: string;
  publishedAtIso: string | null;
  createdAtIso: string | null;
  criteriaCount: number;
}

export interface CriteriaSet {
  id: string;
  name: string;
  description: string | null;
  status: string;
  versions: CriteriaVersion[];
  updatedAtIso: string | null;
}

export function parseCriteriaSets(payload: unknown): CriteriaSet[] {
  return rows(obj(payload).sets ?? obj(payload).criteriaSets ?? payload)
    .map((raw) => {
      const s = obj(raw);
      const id = str(s.id);
      if (!id) return null;

      const versions = rows(s.versions)
        .map((vraw) => {
          const v = obj(vraw);
          const vid = str(v.id);
          if (!vid) return null;
          return {
            id: vid,
            version: num(v.version) ?? 0,
            title: str(v.title) ?? "",
            publishedAtIso: str(v.publishedAt),
            createdAtIso: str(v.createdAt),
            criteriaCount: rows(v.criteria).length,
          };
        })
        .filter((v): v is CriteriaVersion => v !== null)
        // Newest version first: that is the one in force.
        .sort((a, b) => b.version - a.version);

      return {
        id,
        name: str(s.name) ?? "Untitled criteria set",
        description: str(s.description),
        status: str(s.status) ?? "DRAFT",
        versions,
        updatedAtIso: str(s.updatedAt),
      };
    })
    .filter((s): s is CriteriaSet => s !== null);
}

export interface CriteriaUsage {
  version: number;
  runCount: number;
  reviewCount: number;
  reviewerCount: number;
  lastUsedAtIso: string | null;
}

export function parseCriteriaUsage(payload: unknown): CriteriaUsage[] {
  return rows(obj(payload).usage ?? payload)
    .map((raw) => {
      const u = obj(raw);
      const version = num(u.version);
      if (version === null) return null;
      return {
        version,
        runCount: num(u.runCount) ?? 0,
        reviewCount: num(u.reviewCount) ?? 0,
        reviewerCount: num(u.reviewerCount) ?? 0,
        lastUsedAtIso: str(u.lastUsedAt),
      };
    })
    .filter((u): u is CriteriaUsage => u !== null)
    .sort((a, b) => b.version - a.version);
}

// ---------------------------------------------------------------------------
// What a set can actually do
// ---------------------------------------------------------------------------

export type CriteriaAction = "publish" | "duplicate" | "retire";

/**
 * The actions this set permits, in the web's order.
 *
 * Exactly what the web offers, and no more:
 *   DRAFT      → publish, retire
 *   PUBLISHED  → duplicate, retire
 *   RETIRED    → nothing
 *
 * Duplicate is offered ONLY on a published set, because that is the web's
 * affordance and this is a port. A draft is already the editable thing; a
 * second draft of it is a copy nobody asked for.
 *
 * A PUBLISHED set is NOT editable, so no edit affordance is offered for one —
 * the API answers 409 `published_immutable`, and an offer that cannot succeed
 * is worse than an absence because it implies the record could be rewritten.
 */
export function availableActions(set: CriteriaSet): CriteriaAction[] {
  const status = set.status.toUpperCase();
  const out: CriteriaAction[] = [];
  if (status === "DRAFT") out.push("publish");
  if (status === "PUBLISHED") out.push("duplicate");
  if (status !== "RETIRED") out.push("retire");
  return out;
}

export function isEditable(set: CriteriaSet): boolean {
  return set.status.toUpperCase() === "DRAFT";
}

export function criteriaActionLabel(action: CriteriaAction): string {
  switch (action) {
    case "publish":
      return "Publish";
    case "duplicate":
      return "Duplicate as draft";
    case "retire":
      return "Retire";
  }
}

/** Publishing is irreversible: the version it creates can never be edited. */
export function criteriaActionConsequence(action: CriteriaAction): string | null {
  switch (action) {
    case "publish":
      return "Publishing fixes this version permanently. It cannot be edited afterwards — to change it later, duplicate it as a new draft.";
    case "retire":
      return "Retiring takes this set out of use for new reviews. Reviews already made against it are unaffected.";
    case "duplicate":
      return null;
  }
}

export function criteriaStatusTone(status: string): ProovraStatusTone {
  switch (status.toUpperCase()) {
    case "PUBLISHED":
      return "verified";
    case "DRAFT":
      return "pending";
    case "RETIRED":
      return "neutral";
    default:
      return "neutral";
  }
}

export function criteriaStatusLabel(status: string): string {
  const s = status.replace(/_/g, " ").toLowerCase();
  return s.length === 0 ? "Unknown" : s.charAt(0).toUpperCase() + s.slice(1);
}

/** The 409 the API raises when something tries to edit a published version. */
export function isPublishedImmutable(err: unknown): boolean {
  const e = obj(err);
  return num(e.statusCode) === 409 || str(e.code) === "published_immutable";
}
