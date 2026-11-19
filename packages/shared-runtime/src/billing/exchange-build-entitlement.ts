/**
 * WS-SCHED / PRO-W1-07 (DEC-04) — the Evidence Exchange entitlement, re-read by
 * the Worker when it CLAIMS a package build.
 *
 * The builder trusted the BUILDING row: the API had answered
 * FEATURE_EVIDENCE_EXCHANGE when the package was requested, and a build claimed
 * later (a queued package, a lease taken over after thirty minutes, "Build
 * again") ran whatever the workspace had become since.
 *
 * The Worker may not import the API's entitlement engine
 * (`resolveEntitlement`, services/api/src/services/packaging/
 * entitlement.service.ts), so this is that engine's answer FOR THIS ONE KEY,
 * over the same stored facts, with the Enterprise standing supplied by the
 * host's own commercial scope:
 *
 *   - a lapsed Enterprise contract grants nothing, including through a stored
 *     row;
 *   - otherwise an unexpired stored grant decides;
 *   - otherwise an ACTIVE Enterprise contract sells it (the ENTERPRISE line);
 *   - otherwise the conservative default: not entitled.
 *
 * It is not a second authority: the API suite pins it against
 * `resolveEntitlement` over that whole matrix
 * (ws-sched-exchange-build-entitlement-parity.test.ts), so the two cannot
 * drift apart unnoticed.
 */
import type { PrismaClient } from "@prisma/client";

export type EnterpriseContractStanding = "NOT_ENTERPRISE" | "CONTRACT_ACTIVE" | "CONTRACT_LAPSED";

export const EVIDENCE_EXCHANGE_ENTITLEMENT_KEY = "FEATURE_EVIDENCE_EXCHANGE" as const;

export async function readEvidenceExchangeEntitlement(
  prisma: Pick<PrismaClient, "entitlementGrant">,
  input: { teamId: string; standing: EnterpriseContractStanding; now?: Date },
): Promise<boolean> {
  if (input.standing === "CONTRACT_LAPSED") return false;
  const now = input.now ?? new Date();
  const row = await prisma.entitlementGrant.findUnique({
    where: { teamId_key: { teamId: input.teamId, key: EVIDENCE_EXCHANGE_ENTITLEMENT_KEY } },
    select: { kind: true, valueBool: true, expiresAtUtc: true },
  });
  if (row && !(row.expiresAtUtc !== null && row.expiresAtUtc.getTime() <= now.getTime())) {
    // A row stored under another kind is not a FEATURE grant (the engine projects
    // it as a number, which is never `true`).
    if (row.kind === "QUOTA" || row.kind === "LIMIT") return false;
    return row.valueBool === true;
  }
  return input.standing === "CONTRACT_ACTIVE";
}
