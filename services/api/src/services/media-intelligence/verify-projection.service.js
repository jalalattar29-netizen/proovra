/**
 * Phase 31.12 — Public-safe Verify-page media intelligence projection.
 *
 * Produces the BOUNDED, public-safe shape that the `/public/verify/:id`
 * route attaches to its response. This is a DIFFERENT projection from
 * the workspace-internal one in `report-projection.service.ts` —
 * substantially more conservative because the verify endpoint is
 * anonymous.
 *
 * Hard custody / privacy rules:
 *
 *   * NEVER exposes per-signal IDs, material IDs, severities, status,
 *     timestamps, or safe summaries. Anyone hitting the public verify
 *     URL is anonymous; surfacing per-signal detail could leak the
 *     workspace's review activity to outsiders.
 *   * EMITS ONLY:
 *       - hasObservations: boolean — true when ≥1 non-dismissed
 *         signal exists.
 *       - observationCount: number — bounded count, capped at 99.
 *       - advisory: string — fixed bounded disclaimer carrying NO
 *         forbidden vocabulary and NO authenticity/admissibility
 *         claims.
 *   * NEVER throws. Returns `null` on any error or on no-data; the
 *     caller treats both identically (no section rendered).
 *   * DISMISSED signals filtered out — operators dismissed them; the
 *     public count never includes them.
 *   * Team-anchored read (`team_id = $1`) so the projection cannot
 *     accidentally leak signals from another tenant.
 *   * No storage internals, no GPS, no private/legal notes are
 *     queried — the SQL projects ONLY the bounded `COUNT(*)` shape.
 */
import { prisma as defaultPrisma } from "../../db.js";
// =============================================================================
// Constants
// =============================================================================
const MAX_PUBLIC_COUNT = 99;
const ADVISORY_DISCLAIMER = "The workspace operator has recorded advisory observations about this material. The observations are deterministic, machine-derived metadata observations. They do not classify the recorded content and they do not establish legal weight; the canonical custody record remains the authoritative integrity artifact.";
// =============================================================================
// Entry point
// =============================================================================
/**
 * Project the bounded public-safe shape. Returns `null` when there's
 * no surfaceable data OR on any error. The caller renders no section
 * in either case.
 */
export async function projectVerifyMediaIntelligence(input, client = defaultPrisma) {
    if (!input.teamId || !input.evidenceId)
        return null;
    try {
        const rows = (await client.$queryRawUnsafe(`SELECT COUNT(*)::int AS "count"
         FROM "media_intelligence_signals"
        WHERE "team_id" = $1
          AND "evidence_id" = $2
          AND "status" IN ('PENDING','ACKNOWLEDGED')`, input.teamId, input.evidenceId));
        const raw = rows[0]?.count ?? 0;
        if (raw <= 0)
            return null;
        const bounded = Math.min(Math.max(0, Math.floor(raw)), MAX_PUBLIC_COUNT);
        return {
            hasObservations: true,
            observationCount: bounded,
            advisory: ADVISORY_DISCLAIMER,
        };
    }
    catch {
        return null;
    }
}
// Re-export the disclaimer text so the source-contract test can verify
// it doesn't drift across the API/UI boundary.
export const VERIFY_MEDIA_INTELLIGENCE_DISCLAIMER = ADVISORY_DISCLAIMER;
