/**
 * PROOVRA C2PA — internal evidence detail projection (Phase M2.1).
 *
 * Returns the bounded C2PA state stored on an evidence record. Used
 * by the internal `GET /v1/evidence/:id/c2pa` endpoint to populate
 * the operator-facing C2PA panel.
 *
 * Hard rules:
 *   * NEVER returns raw manifest bytes — only the bounded summary
 *     and (for raw-manifest preservation) the artifact references.
 *   * NEVER returns private signing material.
 *   * Always carries the standing C2PA limitations so the panel can
 *     surface them without re-deriving them.
 */
import { STANDING_C2PA_LIMITATIONS, buildDisabledC2paSummary, } from "@proovra/shared";
import { prisma } from "../../db.js";
export async function loadEvidenceC2paPanel(input) {
    const ev = await prisma.evidence.findFirst({
        where: { id: input.evidenceId, teamId: input.teamId },
        select: {
            id: true,
            verificationPackageMetadata: true,
        },
    });
    if (!ev)
        return null;
    const meta = ev.verificationPackageMetadata;
    const projectedAtUtc = new Date().toISOString();
    const summary = meta?.c2pa ??
        buildDisabledC2paSummary({
            evidenceId: ev.id,
            generatedAtUtc: projectedAtUtc,
        });
    return {
        evidenceId: ev.id,
        summary,
        limitations: STANDING_C2PA_LIMITATIONS,
        projectedAtUtc,
    };
}
