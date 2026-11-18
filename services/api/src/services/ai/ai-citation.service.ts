/**
 * Phase C4 — Server-validated internal citations.
 *
 * A Copilot observation is only "grounded" if it cites an internal object that
 * the server can re-validate: exists, in-tenant, still authorized, and the
 * cited version matches what was analyzed. The model can PROPOSE citations, but
 * only citations that survive validation are rendered. Invented / cross-tenant /
 * stale / deleted citations are dropped.
 */

export const CITATION_TYPES = [
  "EVIDENCE_RECORD",
  "CASE",
  "CUSTODY_EVENT",
  "VERIFICATION_SIGNAL",
  "REVIEW_ASSIGNMENT",
  "REVIEW_DECISION",
  "REPORT",
  "VERIFICATION_PACKAGE",
  "POLICY",
  "WORKFLOW_STATUS",
] as const;
export type CitationType = (typeof CITATION_TYPES)[number];

export type AiCitation = {
  type: CitationType;
  objectId: string;
  displayLabel: string;
  sourceField: string | null;
  objectVersion: number | null;
  timestampUtc: string | null;
  route: string;
  workspaceId: string;
  analyzedAtUtc: string;
};

export type CitationRejectReason =
  | "UNKNOWN_TYPE"
  | "MISSING_OBJECT_ID"
  | "NOT_FOUND"
  | "CROSS_TENANT"
  | "NOT_AUTHORIZED"
  | "VERSION_MISMATCH"
  | "SEQUENCE_MISSING"
  | "MALFORMED_ROUTE"
  | "DELETED";

/**
 * Resolver a caller supplies per citation type. Returns the authoritative
 * record facts the validator checks against, or null if not found/inaccessible.
 * The caller wires these to the real authorized loaders (never bypassing authz).
 */
export type CitationTarget = {
  workspaceId: string;
  currentVersion: number | null;
  deleted: boolean;
  authorized: boolean;
  sequenceExists?: boolean;
  /**
   * PRO-AI1-05 — the in-app route of the VALIDATED object, derived by the
   * server from (type, id). The model's own route is never rendered: a
   * citation for evidence X links to X's page, or to nothing.
   */
  route?: string | null;
};
export type CitationResolver = (
  type: CitationType,
  objectId: string,
) => Promise<CitationTarget | null>;

// PRO-AI1-05 — a single leading slash only: "//host" is a protocol-relative
// URL that leaves the application.
const ROUTE_RE = /^\/(?!\/)[a-z0-9/_:.[\]-]*$/i;

/** True for a same-origin in-app path (never protocol-relative). */
export function isSafeInAppRoute(route: string | null | undefined): boolean {
  return typeof route === "string" && ROUTE_RE.test(route);
}

export type CitationValidation = {
  valid: AiCitation[];
  rejected: Array<{ citation: AiCitation; reason: CitationRejectReason }>;
};

/**
 * Validate a set of model-proposed citations against the server. Every check is
 * fail-closed: anything unverifiable is rejected, not rendered.
 */
export async function validateCitations(
  citations: AiCitation[],
  ctx: { workspaceId: string },
  resolve: CitationResolver,
): Promise<CitationValidation> {
  const valid: AiCitation[] = [];
  const rejected: CitationValidation["rejected"] = [];

  for (const c of citations) {
    const reject = (reason: CitationRejectReason) => rejected.push({ citation: c, reason });

    if (!CITATION_TYPES.includes(c.type)) { reject("UNKNOWN_TYPE"); continue; }
    if (!c.objectId || typeof c.objectId !== "string") { reject("MISSING_OBJECT_ID"); continue; }
    // A model route that is not even a same-origin path (protocol-relative,
    // scheme) marks a suspect citation: dropped. A well-formed one is still
    // never rendered — it is replaced by the server's route below.
    if (!c.route || !ROUTE_RE.test(c.route)) { reject("MALFORMED_ROUTE"); continue; }
    if (c.workspaceId !== ctx.workspaceId) { reject("CROSS_TENANT"); continue; }

    const target = await resolve(c.type, c.objectId);
    if (!target) { reject("NOT_FOUND"); continue; }
    if (target.deleted) { reject("DELETED"); continue; }
    if (target.workspaceId !== ctx.workspaceId) { reject("CROSS_TENANT"); continue; }
    if (!target.authorized) { reject("NOT_AUTHORIZED"); continue; }
    if (c.type === "CUSTODY_EVENT" && target.sequenceExists === false) { reject("SEQUENCE_MISSING"); continue; }
    if (
      c.objectVersion != null &&
      target.currentVersion != null &&
      c.objectVersion !== target.currentVersion
    ) { reject("VERSION_MISMATCH"); continue; }

    // PRO-AI1-05 — the link is the server's, bound to the validated object.
    const route = isSafeInAppRoute(target.route) ? (target.route as string) : "";
    valid.push({ ...c, route });
  }
  return { valid, rejected };
}

/**
 * PRO-AI1-05 — the citations a client receives: the model's entries whose
 * (type, objectId) survived validation, each carrying the SERVER's route for
 * that object (empty when the object has no page). Matching on the pair, not
 * the id alone, so an invalid citation cannot ride on a valid one's id.
 */
export function projectValidatedCitations(
  modelCitations: ReadonlyArray<Record<string, unknown>>,
  validation: CitationValidation,
): Array<Record<string, unknown>> {
  const routeByKey = new Map(validation.valid.map((c) => [`${c.type}|${c.objectId}`, c.route]));
  return modelCitations
    .filter((c) => routeByKey.has(`${String(c.type)}|${String(c.objectId ?? "")}`))
    .map((c) => ({ ...c, route: routeByKey.get(`${String(c.type)}|${String(c.objectId ?? "")}`) ?? "" }));
}

/** True when at least one citation survived validation (grounding requirement). */
export function hasGrounding(validation: CitationValidation): boolean {
  return validation.valid.length > 0;
}
