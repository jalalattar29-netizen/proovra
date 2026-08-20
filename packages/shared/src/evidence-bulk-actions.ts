/**
 * EVIDENCE BULK ACTIONS — one request contract for the browser and the API.
 *
 * WHY THIS MODULE EXISTS
 * ---------------------------------------------------------------------------
 * The Evidence Library serialised its bulk request by hand:
 *
 *   JSON.stringify({ action, evidenceIds, caseId: caseId ?? null })
 *
 * while the API validated it with a schema declaring
 *
 *   caseId: z.string().uuid().optional()      // optional, NOT nullable
 *
 * so every action that has no target case — Archive above all — sent
 * `caseId: null` and was rejected with a 400 before a single record was
 * examined. Two hand-maintained shapes of the same request, drifting.
 *
 * The schema below is the ONLY definition of that request. The API validates
 * with it; the browser builds its payload with `buildEvidenceBulkRequest`,
 * which omits an absent optional rather than serialising a null. Neither side
 * restates the action vocabulary, the id bound, or the optionality of
 * `caseId`.
 */
import { z } from "zod";

/**
 * The action vocabulary, in the exact casing both sides must use.
 *
 * Ordered as the operator sees it in the toolbar so the two lists can be read
 * against each other.
 */
export const EVIDENCE_BULK_ACTIONS = [
  "ADD_TO_CASE",
  "REMOVE_FROM_CASE",
  "ARCHIVE",
  "RESTORE_ARCHIVED",
  "TRASH",
  "RESTORE_TRASH",
  "EXPORT_METADATA_CSV",
] as const;

export const EvidenceBulkActionSchema = z.enum(EVIDENCE_BULK_ACTIONS);
export type EvidenceBulkActionName = z.infer<typeof EvidenceBulkActionSchema>;

/**
 * The most records one request may carry.
 *
 * Exported so the client can refuse — and explain — an over-long selection
 * BEFORE submitting it, instead of discovering the bound as an opaque 400.
 */
export const EVIDENCE_BULK_MAX_IDS = 100;

/** The actions that require a target case. */
export const EVIDENCE_BULK_ACTIONS_REQUIRING_CASE = ["ADD_TO_CASE"] as const;

export function evidenceBulkActionRequiresCase(action: EvidenceBulkActionName): boolean {
  return (EVIDENCE_BULK_ACTIONS_REQUIRING_CASE as readonly string[]).includes(action);
}

/**
 * THE request contract for `POST /v1/evidence/bulk`.
 *
 * `caseId` is optional and NOT nullable: an action with no target case omits
 * the key. Widening it to accept `null` would be widening a contract to fit an
 * incorrect payload, so the payload is what changed.
 */
export const EvidenceBulkRequestSchema = z
  .object({
    action: EvidenceBulkActionSchema,
    evidenceIds: z.array(z.string().uuid()).min(1).max(EVIDENCE_BULK_MAX_IDS),
    caseId: z.string().uuid().optional(),
  })
  /**
   * An action that TARGETS a case must name one.
   *
   * `caseId` is optional per-field because most actions have no case at all,
   * which left `ADD_TO_CASE` with no target passing the contract and being
   * caught only by a runtime check inside the route. The requirement belongs
   * to the request, so it is stated here: the route's own guard stays as
   * defence, but the contract no longer describes a request the product has
   * no meaning for.
   */
  .superRefine((request, ctx) => {
    if (evidenceBulkActionRequiresCase(request.action) && !request.caseId) {
      ctx.addIssue({
        code: "custom",
        path: ["caseId"],
        message: `caseId is required for ${request.action}`,
      });
    }
  });

export type EvidenceBulkRequest = z.infer<typeof EvidenceBulkRequestSchema>;

/**
 * Build the request body a client sends.
 *
 * - de-duplicates ids while preserving selection order;
 * - omits `caseId` unless there is a real one (never `null`, never `""`);
 * - returns the exact object that is serialised, so a test can assert on the
 *   bytes the page would actually send.
 *
 * It deliberately does NOT validate: the server is the authority on whether a
 * request is acceptable. What this guarantees is that the client cannot
 * express a shape the contract has no word for.
 */
export function buildEvidenceBulkRequest(input: {
  action: EvidenceBulkActionName;
  evidenceIds: readonly string[];
  caseId?: string | null;
}): EvidenceBulkRequest {
  const evidenceIds = [...new Set(input.evidenceIds)];
  const caseId = typeof input.caseId === "string" ? input.caseId.trim() : "";
  return {
    action: input.action,
    evidenceIds,
    ...(caseId ? { caseId } : {}),
  };
}
