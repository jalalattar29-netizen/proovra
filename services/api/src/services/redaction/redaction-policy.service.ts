/**
 * PROOVRA Phase 3A → Elite Closure — Workspace detection-policy engine.
 *
 * Phase 3A Closure shipped this as an in-memory cache; the Elite
 * Closure replaces the cache with a real Prisma-backed store
 * (`redaction-policy-store.service.ts`) while keeping the bounded
 * `isPolicyAllowed` / `detectionKindEnabled` signatures so the
 * detection orchestrator does NOT change.
 *
 * Hard rules:
 *   * NEVER default-deny: missing provider/kind entries mean
 *     enabled. Disabling requires an explicit `false` in some
 *     published policy assignment scoped to (workspace | case |
 *     project).
 *   * Reads consult `resolveEffectivePolicy` which applies the
 *     deterministic GLOBAL → WORKSPACE → CASE → PROJECT
 *     inheritance.
 *   * Writes go through the bounded versioned store — `setRedactionDetectionPolicy`
 *     becomes a back-compat shim that creates + publishes a
 *     synthetic "Workspace Defaults" policy.
 */

import type { PrismaClient } from "@prisma/client";

import {
  type RedactionDetectionKind,
  type RedactionDetectionProvider,
} from "@proovra/shared";

import { prisma as defaultPrisma } from "../../db.js";
import {
  createPolicy,
  createPolicyVersion,
  resolveEffectivePolicy,
  transitionPolicyVersion,
} from "./redaction-policy-store.service.js";

// ---------------------------------------------------------------------------
// Public types — preserved from Phase 3A Closure
// ---------------------------------------------------------------------------

export type RedactionDetectionPolicy = {
  teamId: string;
  providers: Partial<Record<RedactionDetectionProvider, boolean>>;
  kinds: Partial<Record<RedactionDetectionKind, boolean>>;
  description: string | null;
  updatedAtUtc: string;
};

const WORKSPACE_DEFAULTS_NAME = "Workspace Defaults";

// ---------------------------------------------------------------------------
// Reads — delegated to the Prisma-backed inheritance resolver
// ---------------------------------------------------------------------------

export async function getRedactionDetectionPolicy(input: {
  prisma?: PrismaClient;
  teamId: string;
  caseId?: string | null;
  projectId?: string | null;
}): Promise<RedactionDetectionPolicy> {
  const effective = await resolveEffectivePolicy({
    prisma: input.prisma,
    teamId: input.teamId,
    caseId: input.caseId ?? null,
    projectId: input.projectId ?? null,
  });
  // Strip default-allow keys: the legacy shape only stores explicit
  // toggles. Anything still true is the default, anything false is
  // the bounded opt-out.
  const providers: Partial<Record<RedactionDetectionProvider, boolean>> = {};
  for (const [k, v] of Object.entries(effective.providers)) {
    if (v === false) providers[k as RedactionDetectionProvider] = false;
  }
  return {
    teamId: input.teamId,
    providers,
    kinds: effective.kinds,
    description: null,
    updatedAtUtc: effective.effectiveAtUtc,
  };
}

/**
 * Back-compat shim. Edits a workspace-default policy version,
 * publishes it, and binds a WORKSPACE-scoped assignment. The
 * Prisma store is the source of truth; the in-memory cache from
 * the Phase 3A Closure is GONE.
 *
 * The bounded admin route (`PATCH /v1/redaction/policy`) continues
 * to use this for quick toggles; the new Policy Management Console
 * uses the full versioned store directly.
 */
export async function setRedactionDetectionPolicy(input: {
  prisma?: PrismaClient;
  teamId: string;
  actorUserId: string;
  providers?: Partial<Record<RedactionDetectionProvider, boolean>>;
  kinds?: Partial<Record<RedactionDetectionKind, boolean>>;
  description?: string | null;
}): Promise<RedactionDetectionPolicy & { pendingPolicyVersionId?: string | null; applied?: boolean }> {
  const prisma = input.prisma ?? defaultPrisma;
  // Find (or create) the workspace-default policy.
  let policy = await prisma.redactionPolicy.findFirst({
    where: {
      teamId: input.teamId,
      name: WORKSPACE_DEFAULTS_NAME,
      archivedAt: null,
    },
    select: { id: true },
  });
  if (!policy) {
    const created = await createPolicy({
      prisma,
      teamId: input.teamId,
      name: WORKSPACE_DEFAULTS_NAME,
      createdByUserId: input.actorUserId,
    });
    if (!created.ok) {
      // Fall back to the legacy bounded read — empty toggles, default-allow.
      return {
        teamId: input.teamId,
        providers: input.providers ?? {},
        kinds: input.kinds ?? {},
        description: input.description ?? null,
        updatedAtUtc: new Date().toISOString(),
      };
    }
    policy = { id: created.policyId };
  }

  // Build the document on top of the current effective policy.
  const effective = await resolveEffectivePolicy({
    prisma,
    teamId: input.teamId,
  });
  const docProviders: Partial<Record<RedactionDetectionProvider, boolean>> = {};
  for (const [k, v] of Object.entries(effective.providers)) {
    if (v === false) docProviders[k as RedactionDetectionProvider] = false;
  }
  for (const [k, v] of Object.entries(input.providers ?? {})) {
    docProviders[k as RedactionDetectionProvider] = !!v;
  }
  const docKinds = { ...effective.kinds, ...(input.kinds ?? {}) };

  const versioned = await createPolicyVersion({
    prisma,
    teamId: input.teamId,
    policyId: policy.id,
    authoredByUserId: input.actorUserId,
    rationale: input.description ?? null,
    document: {
      schemaVersion: "PROOVRA_REDACTION_POLICY_V1",
      providers: docProviders,
      kinds: docKinds,
      ruleActions: effective.ruleActions,
      customRules: effective.customRules,
    },
  });
  if (!versioned.ok) {
    // PRO-R3-08 — nothing was written: say so, never echo the request back.
    return {
      teamId: input.teamId,
      providers: effective.providers,
      kinds: effective.kinds,
      description: input.description ?? null,
      updatedAtUtc: new Date().toISOString(),
      pendingPolicyVersionId: null,
      applied: false,
    };
  }
  /*
   * PRO-R3-08 — the quick toggle is a DRAFT submitted for review by the real
   * actor, through the same transitions and separation of duties as the
   * Policy Management Console. It used to approve and publish itself under a
   * nil-UUID "system actor", so one administrator changed policy with no
   * second person, and every step's failure was ignored. Approval, publication
   * and assignment now happen in the console, by someone other than the author.
   */
  const submitted = await transitionPolicyVersion({
    prisma,
    teamId: input.teamId,
    policyVersionId: versioned.policyVersionId,
    toState: "IN_REVIEW",
    actorUserId: input.actorUserId,
  });
  // The effective policy is unchanged until another administrator approves.
  return {
    teamId: input.teamId,
    providers: effective.providers,
    kinds: effective.kinds,
    description: input.description ?? null,
    updatedAtUtc: new Date().toISOString(),
    pendingPolicyVersionId: (submitted as { ok?: boolean }).ok === false ? null : versioned.policyVersionId,
    applied: false,
  };
}

// ---------------------------------------------------------------------------
// Orchestrator gate — preserved Phase 3A Closure signature
// ---------------------------------------------------------------------------

export async function isPolicyAllowed(input: {
  prisma?: PrismaClient;
  teamId: string;
  providers: ReadonlyArray<RedactionDetectionProvider>;
  caseId?: string | null;
  projectId?: string | null;
}): Promise<Set<RedactionDetectionProvider>> {
  const effective = await resolveEffectivePolicy({
    prisma: input.prisma,
    teamId: input.teamId,
    caseId: input.caseId ?? null,
    projectId: input.projectId ?? null,
  });
  const allowed = new Set<RedactionDetectionProvider>();
  for (const p of input.providers) {
    if (effective.providers[p] === false) continue;
    allowed.add(p);
  }
  return allowed;
}

export async function detectionKindEnabled(input: {
  prisma?: PrismaClient;
  teamId: string;
  kind: RedactionDetectionKind;
  caseId?: string | null;
  projectId?: string | null;
}): Promise<boolean> {
  const effective = await resolveEffectivePolicy({
    prisma: input.prisma,
    teamId: input.teamId,
    caseId: input.caseId ?? null,
    projectId: input.projectId ?? null,
  });
  return effective.kinds[input.kind] !== false;
}

// Back-compat test helper — the Prisma-backed store does not need
// a cache reset, but tests written against the Phase 3A Closure
// shape still import this symbol. We make it a no-op.
export function __resetPolicyCacheForTests(): void {
  /* no-op — policy now lives in Prisma */
}
