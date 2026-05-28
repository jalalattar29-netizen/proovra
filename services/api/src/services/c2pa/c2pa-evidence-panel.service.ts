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

import {
  STANDING_C2PA_LIMITATIONS,
  buildDisabledC2paSummary,
  type C2paEvidenceSummary,
  type C2paLimitationCode,
} from "@proovra/shared";
import { prisma } from "../../db.js";

export type C2paEvidencePanelResult = {
  evidenceId: string;
  /** Bounded summary projection (always present, even if disabled). */
  summary: C2paEvidenceSummary;
  /** Bounded standing limitations — always the full set. */
  limitations: ReadonlyArray<C2paLimitationCode>;
  /** UTC ISO timestamp of when this projection was assembled. */
  projectedAtUtc: string;
};

export async function loadEvidenceC2paPanel(input: {
  evidenceId: string;
  teamId: string;
}): Promise<C2paEvidencePanelResult | null> {
  const ev = await prisma.evidence.findFirst({
    where: { id: input.evidenceId, teamId: input.teamId },
    select: {
      id: true,
      verificationPackageMetadata: true,
    },
  });
  if (!ev) return null;
  const meta = ev.verificationPackageMetadata as
    | { c2pa?: C2paEvidenceSummary | null }
    | null
    | undefined;
  const projectedAtUtc = new Date().toISOString();
  const summary: C2paEvidenceSummary =
    meta?.c2pa ??
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
