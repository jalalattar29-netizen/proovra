/**
 * Platform Control Center P1 — Evidence Pipeline Health console API.
 *
 *   GET /v1/admin/evidence-health — platform-wide, READ-ONLY.
 *
 * Gated by `requirePlatformAdmin`. Returns a snapshot of the evidence
 * pipeline (uploads → evidence → reports → packages → preservation)
 * built ENTIRELY from real DB counts + the existing queue-inventory
 * projection. Absent signals are `null` ("Not measured" / "Not
 * connected"), NEVER a fabricated healthy 0.
 *
 * Hard rules honoured here:
 *   - No hashing / signing / custody / report / package generation.
 *     This route counts. It does not touch evidence core logic.
 *   - No evidence CONTENTS are exposed: no bytes, storage keys,
 *     signatures, fingerprints, titles, GPS, private notes. Only
 *     aggregate counts + operational status rollups.
 *   - The queue numbers reuse queue-inventory.service.ts — this route
 *     does not open its own Redis connection.
 *
 * Registration: the owner wires this into server.ts + routeRegistry
 * (`platform.evidence_ops` → /admin/evidence-ops).
 */

import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { createErrorResponse, ErrorCode } from "../errors.js";
import { requirePlatformAdmin } from "../middleware/require-platform-admin.js";
import {
  EVIDENCE_HEALTH_COHORTS,
  buildEvidenceHealthCohorts,
  isEvidenceHealthCohort,
} from "../services/admin/evidence-health-cohorts.service.js";
import { buildEvidenceHealthSnapshot } from "../services/operations/evidence-health.service.js";
import {
  EVIDENCE_HEALTH_SIGNALS,
  isEvidenceHealthSignal,
  listAdminEvidenceRecords,
} from "../services/admin/evidence-records.service.js";

const querySchema = z.object({
  windowHours: z.coerce.number().int().min(1).max(24 * 30).optional(),
});

// TENANT_SCOPE_EXCEPTION: platform_admin_global -- every route in this plugin is
// gated by requirePlatformAdmin and reads GLOBAL cross-tenant aggregates. It is
// intentionally NOT scoped to a single tenant; the platform-admin gate IS the
// authorization boundary. No per-tenant authorizeOrFail applies here.
export async function adminEvidenceOpsRoutes(app: FastifyInstance) {
  app.get(
    "/v1/admin/evidence-health",
    { preHandler: requirePlatformAdmin },
    async (req, reply) => {
      const parsed = querySchema.safeParse(req.query ?? {});
      if (!parsed.success) {
        return reply.code(400).send(
          createErrorResponse(
            ErrorCode.VALIDATION_ERROR,
            req.id,
            { reason: parsed.error.message },
            "Invalid evidence-health query",
          ),
        );
      }

      const snapshot = await buildEvidenceHealthSnapshot({
        windowHours: parsed.data.windowHours,
      });

      // ADM-013 — the OVERLAPPING cohorts, with the overlap stated.
      //
      // The signal drill-downs below answer "which records have this failure".
      // They cannot answer "how many records need attention", because a record
      // with a failed timestamp AND no report appears under two signals and is
      // one record. That question is what produced "34 + 16" being read as 50.
      const cohorts = await buildEvidenceHealthCohorts();

      return reply.code(200).send({
        snapshot,
        cohorts,
        // ADM-029 — every failure count is now traceable. The tile links here
        // with its own signal, and the roster below returns exactly the records
        // that count is over.
        drillDown: Object.fromEntries(
          Object.entries(EVIDENCE_HEALTH_SIGNALS).map(([key, def]) => [
            key,
            { label: def.label, href: `/admin/evidence-ops/records?signal=${key}` },
          ]),
        ),
      });
    },
  );

  // ---------------------------------------------------------------------------
  // GET /v1/admin/evidence-health/records — THE drill-down (ADM-029).
  //
  // Returns the evidence records behind one health signal, with the workspace
  // and customer they belong to. Operational metadata only: no bytes, no
  // storage key, no hash, no signature, no internal notes. See the module
  // comment on `evidence-records.service.ts` for exactly where that line is
  // drawn and why a platform-admin gate does not move it.
  // ---------------------------------------------------------------------------
  const recordsQuerySchema = z.object({
    signal: z.string().trim().min(1).max(64).optional(),
    /** ADM-013 — an overlapping-cohort filter. See the cohort service. */
    cohort: z.string().trim().min(1).max(64).optional(),
    page: z.coerce.number().int().min(1).max(100000).optional().default(1),
    limit: z.coerce.number().int().min(1).max(200).optional().default(50),
    teamId: z.string().uuid().optional(),
    organizationId: z.string().uuid().optional(),
    /** ADM-019 — resolve ONE record, so a search hit keeps its identity. */
    evidenceId: z.string().uuid().optional(),
  });

  app.get(
    "/v1/admin/evidence-health/records",
    { preHandler: requirePlatformAdmin },
    async (req, reply) => {
      const parsed = recordsQuerySchema.safeParse(req.query ?? {});
      // Either a known signal, or an explicit record id. Neither is a query
      // this endpoint can answer, and an unknown signal must not silently
      // degrade into "every live record on the platform".
      const signalOk =
        parsed.success &&
        (parsed.data.signal === undefined ||
          isEvidenceHealthSignal(parsed.data.signal));
      // An unknown COHORT degrades the same way an unknown signal would —
      // into "every live record on the platform" — so it is refused for the
      // same reason.
      const cohortOk =
        parsed.success &&
        (parsed.data.cohort === undefined ||
          isEvidenceHealthCohort(parsed.data.cohort));
      const targetOk =
        parsed.success &&
        (parsed.data.signal !== undefined ||
          parsed.data.cohort !== undefined ||
          parsed.data.evidenceId !== undefined);
      if (!parsed.success || !signalOk || !cohortOk || !targetOk) {
        return reply.code(400).send(
          createErrorResponse(
            ErrorCode.VALIDATION_ERROR,
            req.id,
            {
              reason: !parsed.success
                ? parsed.error.message
                : !signalOk
                  ? `unknown signal '${parsed.data.signal}'`
                  : !cohortOk
                    ? `unknown cohort '${parsed.data.cohort}'`
                    : "one of 'signal', 'cohort' or 'evidenceId' is required",
              allowedSignals: Object.keys(EVIDENCE_HEALTH_SIGNALS),
              allowedCohorts: Object.keys(EVIDENCE_HEALTH_COHORTS),
            },
            "Invalid evidence-records query",
          ),
        );
      }

      const result = await listAdminEvidenceRecords({
        signal:
          parsed.data.signal && isEvidenceHealthSignal(parsed.data.signal)
            ? parsed.data.signal
            : undefined,
        cohort:
          parsed.data.cohort && isEvidenceHealthCohort(parsed.data.cohort)
            ? parsed.data.cohort
            : undefined,
        evidenceId: parsed.data.evidenceId,
        page: parsed.data.page,
        limit: parsed.data.limit,
        teamId: parsed.data.teamId,
        organizationId: parsed.data.organizationId,
      });

      return reply.code(200).send(result);
    },
  );
}
