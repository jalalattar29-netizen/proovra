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
 * over the same stored facts, through the SAME shared decision
 * (`decideEntitlementSource`), with the Enterprise standing and the paid
 * lifecycle supplied by the host's own commercial scope:
 *
 *   - a lapsed Enterprise contract grants nothing, including through a stored
 *     row;
 *   - otherwise an unexpired stored grant decides — except a product-line
 *     (source PLAN) grant while the paid subscription it was applied for is
 *     terminally lapsed (PRO-R3-07; matrix review NEW-RG-13-2: this reader
 *     ignored the lapse, so a PLAN grant still admitted a build the API
 *     refused);
 *   - otherwise an ACTIVE Enterprise contract sells it (the ENTERPRISE line);
 *   - otherwise the conservative default: not entitled.
 *
 * It is not a second authority: the API suite pins it against
 * `resolveEntitlement` over that whole matrix
 * (ws-sched-exchange-build-entitlement-parity.test.ts), so the two cannot
 * drift apart unnoticed.
 */
import type { PrismaClient } from "@prisma/client";

import { decideEntitlementSource, entitlementGrantLive } from "./entitlement-decision.js";

export type EnterpriseContractStanding = "NOT_ENTERPRISE" | "CONTRACT_ACTIVE" | "CONTRACT_LAPSED";

export const EVIDENCE_EXCHANGE_ENTITLEMENT_KEY = "FEATURE_EVIDENCE_EXCHANGE" as const;

export async function readEvidenceExchangeEntitlement(
  prisma: Pick<PrismaClient, "entitlementGrant">,
  input: {
    teamId: string;
    standing: EnterpriseContractStanding;
    /** PRO-R3-07 — the paid subscription is terminally lapsed (lifecycle `mutationsAllowed === false`). */
    paidLapsed?: boolean;
    now?: Date;
  },
): Promise<boolean> {
  if (input.standing === "CONTRACT_LAPSED") return false;
  const now = input.now ?? new Date();
  const row = await prisma.entitlementGrant.findUnique({
    where: { teamId_key: { teamId: input.teamId, key: EVIDENCE_EXCHANGE_ENTITLEMENT_KEY } },
    select: { kind: true, valueBool: true, expiresAtUtc: true, source: true },
  });
  const suspendedByLapse = input.paidLapsed === true && row?.source === "PLAN";
  const source = decideEntitlementSource({
    standing: input.standing,
    grantLive: entitlementGrantLive(row, now) && !suspendedByLapse,
    contractSellsKey: true,
  });
  if (source === "GRANT") {
    // A row stored under another kind is not a FEATURE grant (the engine projects
    // it as a number, which is never `true`).
    if (row!.kind === "QUOTA" || row!.kind === "LIMIT") return false;
    return row!.valueBool === true;
  }
  return source === "CONTRACT";
}
