/**
 * GOV-005 — WHICH NAMED RETENTION POLICY GOVERNS THIS RECORD.
 *
 * Named policies had no binding step: nothing ever wrote
 * `Evidence.retentionPolicyVersionId`, so "immutable" blocked nothing, retention
 * days changed no date, and certificates cited nothing. This is that step, used
 * by the one writer that creates a record and by the sweep when a record's date
 * runs out. Both hosts need it, so it lives here and takes its client explicitly.
 *
 * The rule is the catalog's precedence (`pickHighestPrecedencePolicy`, the same
 * one the retention pages resolve with). REGULATORY policies do not bind: a record
 * carries no jurisdiction to match them against.
 *
 * Binding is EXTEND-ONLY. A date only ever moves later and a policy can never
 * shorten retention already recorded. Existing records are not rewritten when a
 * policy is created or edited; a record picks up the policy in force at creation
 * and is checked again when its date expires.
 */

import type { PrismaClient } from "@prisma/client";
import { pickHighestPrecedencePolicy, type RetentionPolicyScope, type RetentionPolicyStatus } from "@proovra/shared";

export type RecordRetentionBinding = {
  retentionPolicyId: string;
  retentionPolicyVersionId: string;
  /** `null` is indefinite retention: no date, and no review opens. */
  retentionDays: number | null;
  immutable: boolean;
};

type BindingClient = Pick<
  PrismaClient,
  "evidenceRetentionPolicy" | "evidenceRetentionPolicyVersion" | "team" | "organizationPolicy"
>;

const ORGANIZATION_TEMPLATE_KEY = "retention.default";

/** An immutable organization template is a floor (§9.4). `null` is indefinite. */
async function organizationFloorDays(
  client: BindingClient,
  teamId: string,
  days: number | null,
): Promise<number | null> {
  const team = await client.team.findUnique({ where: { id: teamId }, select: { organizationId: true } });
  if (!team?.organizationId) return days;
  const row = await client.organizationPolicy.findUnique({
    where: {
      organization_policies_org_key_uniq: {
        organizationId: team.organizationId,
        key: ORGANIZATION_TEMPLATE_KEY,
      },
    },
    select: { value: true },
  });
  const template = row?.value as { retentionDays?: unknown; immutable?: unknown } | null | undefined;
  if (template?.immutable !== true) return days;
  const floor = template.retentionDays;
  if (floor === null) return null;
  if (typeof floor !== "number") return days;
  return days === null ? null : Math.max(days, floor);
}

export async function resolveRecordRetentionBinding(
  client: BindingClient,
  input: { teamId: string; evidenceType?: string | null; caseIds?: readonly string[] },
): Promise<RecordRetentionBinding | null> {
  const arms: Array<Record<string, unknown>> = [{ scope: "WORKSPACE" }];
  if (input.evidenceType) arms.push({ scope: "EVIDENCE_TYPE", scopeQualifier: input.evidenceType });
  if (input.caseIds && input.caseIds.length > 0) {
    arms.push({ scope: "CASE", caseId: { in: [...input.caseIds] } });
  }
  const candidates = await client.evidenceRetentionPolicy.findMany({
    where: { teamId: input.teamId, status: "ACTIVE", OR: arms },
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      scope: true,
      status: true,
      retentionDays: true,
      immutable: true,
      currentVersion: true,
    },
  });
  const winner = pickHighestPrecedencePolicy(
    candidates.map((c) => ({
      ...c,
      scope: c.scope as RetentionPolicyScope,
      status: c.status as RetentionPolicyStatus,
    })),
  );
  if (!winner) return null;
  const version = await client.evidenceRetentionPolicyVersion.findFirst({
    where: { retentionPolicyId: winner.id, version: winner.currentVersion },
    select: { id: true, immutable: true },
  });
  if (!version) return null;
  return {
    retentionPolicyId: winner.id,
    retentionPolicyVersionId: version.id,
    retentionDays: await organizationFloorDays(client, input.teamId, winner.retentionDays),
    immutable: version.immutable === true,
  };
}
