/**
 * PV-DUP-002 — THE ORGANIZATION'S RETENTION TEMPLATE, READ ONE WAY.
 *
 * An organization publishes a retention default as `OrganizationPolicy` with
 * `key = "retention.default"` (`POST /v1/orgs/:id/policies/retention`). This
 * module is the only reader of that template for retention decisions, and it
 * owns the one rule about it: an IMMUTABLE template is a mandatory floor that
 * a workspace-level policy may strengthen but never weaken (§9.4, through the
 * canonical precedence engine).
 *
 * It deliberately knows nothing about workspace policies. The effective
 * decision is made in ONE place — `resolveEffectiveRetentionPolicy` in the
 * retention engine — which reads this template once and applies the floor.
 * The inheritance projection is derived from that decision, so the two panels
 * on the retention page cannot contradict each other again.
 *
 * A database failure PROPAGATES. The previous reader caught every error and
 * answered "no template", which the page rendered as "No retention policy
 * applies" — a false all-clear for a read that had in fact failed.
 */

import type { PrismaClient } from "@prisma/client";

import { prisma as defaultPrisma } from "../../db.js";
import {
  resolveEffectivePolicyValue,
  strongerRetentionDays,
} from "../governance/policy-precedence.js";

export const RETENTION_TEMPLATE_KEY = "retention.default";

export type RetentionTemplateValue = {
  retentionDays: number | null;
  immutable: boolean;
  description: string | null;
};

/** Parse a stored template. A malformed value is treated as no template. */
export function readRetentionTemplate(raw: unknown): RetentionTemplateValue | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  if (obj.retentionDays !== null && typeof obj.retentionDays !== "number") return null;
  return {
    retentionDays: obj.retentionDays === null ? null : (obj.retentionDays as number),
    immutable: obj.immutable === true,
    description: typeof obj.description === "string" ? obj.description : null,
  };
}

export type OrganizationRetentionTemplate = {
  organizationId: string | null;
  template: RetentionTemplateValue | null;
};

/**
 * The template governing a workspace's organization, if one is published.
 * Throws on a database failure — the caller must not read that as "none".
 */
export async function readOrganizationRetentionTemplate(
  teamId: string,
  client: PrismaClient = defaultPrisma,
): Promise<OrganizationRetentionTemplate> {
  const team = await client.team.findUnique({
    where: { id: teamId },
    select: { organizationId: true },
  });
  const organizationId = team?.organizationId ?? null;
  if (!organizationId) return { organizationId: null, template: null };
  const row = await client.organizationPolicy.findUnique({
    where: {
      organization_policies_org_key_uniq: { organizationId, key: RETENTION_TEMPLATE_KEY },
    },
    select: { value: true },
  });
  return { organizationId, template: readRetentionTemplate(row?.value ?? null) };
}

/** `null` is indefinite retention — the strongest value there is. */
export function isWeakerRetention(candidate: number | null, reference: number | null): boolean {
  if (candidate === null) return false;
  if (reference === null) return true;
  return candidate < reference;
}

/**
 * Apply the organization's mandatory floor to a workspace-level value. Only an
 * IMMUTABLE template is a floor; an advisory one never changes the value.
 */
export function applyOrganizationRetentionFloor(
  workspaceRetentionDays: number | null,
  template: RetentionTemplateValue | null,
): { retentionDays: number | null; mandatoryFloorApplied: boolean } {
  if (!template?.immutable) {
    return { retentionDays: workspaceRetentionDays, mandatoryFloorApplied: false };
  }
  const effective = resolveEffectivePolicyValue<number | null>(
    [
      { scope: "ORGANIZATION", value: template.retentionDays, mandatory: true },
      { scope: "WORKSPACE", value: workspaceRetentionDays },
    ],
    strongerRetentionDays,
  );
  if (effective.defined && effective.parentPrevailed) {
    return { retentionDays: effective.value, mandatoryFloorApplied: true };
  }
  return { retentionDays: workspaceRetentionDays, mandatoryFloorApplied: false };
}
