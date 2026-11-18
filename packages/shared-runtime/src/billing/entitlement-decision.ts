/**
 * RG-13 (WS-ENT, 2026-11-18) — THE packaging-entitlement decision, shared by
 * the API (`resolveEntitlement`, entitlement.service.ts) and the Worker.
 *
 * WHY IT LIVES HERE. The Worker runs sweeps that act on entitlement-gated
 * features (archive-tier auto-transition, lifecycle webhook delivery) and may
 * not import the API's engine. Before this module those sweeps asked nothing
 * at all, so a workspace that never bought archive tiers had its originals
 * tagged for deep archive, and a workspace that lost webhooks kept delivering.
 * The DECISION (which of a stored grant, the Enterprise contract or the
 * default answers) is stated once, here; each host only reads its facts.
 *
 * The rule, unchanged from the API engine:
 *   - a lapsed Enterprise contract grants nothing, including through a
 *     stored grant row;
 *   - otherwise a stored, unexpired grant answers;
 *   - otherwise an ACTIVE Enterprise contract answers with what the
 *     ENTERPRISE line sells;
 *   - otherwise the default.
 */

export type EntitlementStanding = "NOT_ENTERPRISE" | "CONTRACT_ACTIVE" | "CONTRACT_LAPSED";

export type EntitlementDecisionSource = "GRANT" | "CONTRACT" | "DEFAULT";

export function decideEntitlementSource(input: {
  standing: EntitlementStanding;
  /** A stored grant row exists and has not expired. */
  grantLive: boolean;
  /** The ENTERPRISE product line states a value for this key. */
  contractSellsKey: boolean;
}): EntitlementDecisionSource {
  if (input.standing === "CONTRACT_LAPSED") return "DEFAULT";
  if (input.grantLive) return "GRANT";
  if (input.standing === "CONTRACT_ACTIVE" && input.contractSellsKey) return "CONTRACT";
  return "DEFAULT";
}

export function entitlementGrantLive(
  row: { expiresAtUtc: Date | null } | null | undefined,
  now: Date = new Date(),
): boolean {
  if (!row) return false;
  return row.expiresAtUtc === null || row.expiresAtUtc.getTime() > now.getTime();
}

/**
 * The FEATURE keys a Worker sweep asks about, with what the ENTERPRISE line
 * sells for each. The API's `PLAN_LINE_ENTITLEMENTS.ENTERPRISE` must agree;
 * `services/api/test/ws-ent-entitlement-decision.test.ts` pins that.
 */
export const WORKER_FEATURE_ENTITLEMENTS = {
  FEATURE_ARCHIVE_TIERS: { enterpriseLine: true, defaultValue: false },
  FEATURE_WEBHOOKS: { enterpriseLine: true, defaultValue: false },
} as const;

export type WorkerFeatureEntitlementKey = keyof typeof WORKER_FEATURE_ENTITLEMENTS;

/** Structural client: a PrismaClient or transaction client from either host. */
export type EntitlementFactsClient = {
  entitlementGrant: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    findUnique: (args: any) => PromiseLike<unknown>;
  };
};

/**
 * A FEATURE key's value for one workspace, given the host-resolved standing.
 * FAIL CLOSED: a grant read that fails answers the default (false).
 */
export async function resolveWorkerFeatureEntitlement(
  client: EntitlementFactsClient,
  input: {
    teamId: string;
    key: WorkerFeatureEntitlementKey;
    standing: EntitlementStanding;
    /** PRO-R3-07 — the paid subscription is terminally lapsed: a product-line (PLAN) grant does not answer. */
    paidLapsed?: boolean;
    now?: Date;
  },
): Promise<boolean> {
  const spec = WORKER_FEATURE_ENTITLEMENTS[input.key];
  if (input.standing === "CONTRACT_LAPSED") return spec.defaultValue;
  let row: { valueBool: boolean | null; expiresAtUtc: Date | null; source?: string | null } | null = null;
  try {
    row = (await client.entitlementGrant.findUnique({
      where: { teamId_key: { teamId: input.teamId, key: input.key } },
      select: { valueBool: true, expiresAtUtc: true, source: true },
    })) as { valueBool: boolean | null; expiresAtUtc: Date | null; source?: string | null } | null;
  } catch {
    return spec.defaultValue;
  }
  const source = decideEntitlementSource({
    standing: input.standing,
    grantLive: entitlementGrantLive(row, input.now) && !(input.paidLapsed === true && row?.source === "PLAN"),
    contractSellsKey: true,
  });
  if (source === "GRANT") return row?.valueBool === true;
  if (source === "CONTRACT") return spec.enterpriseLine;
  return spec.defaultValue;
}

// ---------------------------------------------------------------------------
// The per-use QUOTA meter (atomic admission)
// ---------------------------------------------------------------------------

/** Structural client with raw-query support. */
export type EntitlementMeterClient = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  $queryRaw: (query: TemplateStringsArray, ...values: any[]) => PromiseLike<unknown>;
};

/**
 * Admit `amount` units of a per-use QUOTA (API requests per day, webhook
 * deliveries per day) against `limit`, and record them, in ONE statement.
 *
 * The conditional upsert is the atomicity: concurrent callers at limit - 1
 * serialise on the period row and exactly one is admitted. A unit refused is
 * never recorded, so a refusal does not consume. The period row is the UTC
 * day / month of `periodStartUtc` (`entitlementPeriodStart`), so the reset is
 * the next UTC period boundary.
 */
export async function consumeEntitlementMeter(
  client: EntitlementMeterClient,
  input: { teamId: string; key: string; periodStartUtc: Date; amount: number; limit: number },
): Promise<{ ok: boolean; consumed: number | null }> {
  const amount = Math.max(0, Math.floor(input.amount));
  const limit = Math.max(0, Math.floor(input.limit));
  if (amount === 0) return { ok: true, consumed: null };
  if (amount > limit) return { ok: false, consumed: null };
  const rows = (await client.$queryRaw`
    INSERT INTO entitlement_usage (team_id, key, period_start_utc, consumed, updated_at)
    VALUES (${input.teamId}::uuid, ${input.key}, ${input.periodStartUtc}, ${BigInt(amount)}, now())
    ON CONFLICT (team_id, key, period_start_utc)
    DO UPDATE SET consumed = entitlement_usage.consumed + EXCLUDED.consumed, updated_at = now()
      WHERE entitlement_usage.consumed + EXCLUDED.consumed <= ${BigInt(limit)}
    RETURNING consumed
  `) as Array<{ consumed: bigint | number }>;
  if (!Array.isArray(rows) || rows.length === 0) return { ok: false, consumed: null };
  return { ok: true, consumed: Number(rows[0]!.consumed) };
}
