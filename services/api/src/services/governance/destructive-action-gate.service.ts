/**
 * Phase X.1 — Destructive Action Gate Orchestrator.
 *
 * Centralizes the glue logic that wrapped every destructive evidence
 * route handler (delete / archive / unarchive). The pattern was
 * repeated inline in `services/api/src/routes/evidence.routes.ts`:
 *
 *   1. Look up the actor's team membership
 *   2. Call `enforceSensitiveAction(...)` for the policy decision
 *   3. On block, emit a custody event with a code-specific event type
 *   4. Map the decision code to an HTTP status (503 for transient
 *      governance failure, 403 for admin-only blocks, 409 otherwise)
 *   5. Return a structured response body
 *
 * This orchestrator owns steps 1–5 so the route handler shrinks to:
 *   - parse input
 *   - call `runDestructiveActionGate({...})`
 *   - on `gated`, reply with the supplied status + body
 *   - on `allowed`, proceed with the actual mutation
 *
 * Hard rules:
 *   - NO behavior change. The orchestrator MUST produce the exact
 *     same status codes, custody-event types, and response bodies the
 *     inline glue produced. Verified by the cross-runtime regression
 *     test (`phase-x1-architecture-closure.test.ts`).
 *   - NO new policy decisions. This module ONLY orchestrates the
 *     existing `enforceSensitiveAction` decision. It is not a parallel
 *     policy engine.
 *   - The actual mutation (Evidence.delete / archive / etc.) stays in
 *     the route handler — this gate is the PRE-MUTATION decision.
 */

import type { FastifyRequest } from "fastify";
import * as prismaPkg from "@prisma/client";
import type { PrismaClient } from "@prisma/client";

import { prisma as defaultPrisma } from "../../db.js";
import { appendCustodyEvent } from "../../services/custody-events.service.js";
import {
  enforceSensitiveAction,
  type SensitiveAction,
} from "../governance.service.js";

export type DestructiveActionInput = {
  action: SensitiveAction;
  actorUserId: string;
  evidence: {
    id: string;
    teamId: string | null;
    retentionUntilUtc: Date | null;
  };
  /** Operator-readable label for the custody event payload. */
  routeLabel: "delete" | "archive" | "unarchive" | "generate_report" | "generate_package" | "publish_public_verify" | "download_original";
  /** Inbound HTTP context — used for custody event IP / UA capture. */
  req?: Pick<FastifyRequest, "ip" | "headers">;
};

export type DestructiveActionGateResult =
  | {
      gated: false;
    }
  | {
      gated: true;
      statusCode: 403 | 409 | 503;
      body: {
        code: string;
        reason: string;
        message: string;
      };
    };

/**
 * Run the canonical destructive-action gate. Returns either
 * `{ gated: false }` (the caller should proceed with the mutation)
 * or `{ gated: true, statusCode, body }` (the caller should reply
 * verbatim).
 */
export async function runDestructiveActionGate(
  input: DestructiveActionInput,
  client: PrismaClient = defaultPrisma,
): Promise<DestructiveActionGateResult> {
  if (!input.evidence.teamId) {
    // Personal-scope evidence — Phase 9.5 governance applies only at
    // workspace scope. Match the pre-Phase X.1 behavior exactly.
    return { gated: false };
  }

  const membership = await client.teamMember.findUnique({
    where: {
      teamId_userId: {
        teamId: input.evidence.teamId,
        userId: input.actorUserId,
      },
    },
  });

  const decision = await enforceSensitiveAction(
    input.action,
    {
      teamId: input.evidence.teamId,
      role: membership?.role,
      evidence: {
        id: input.evidence.id,
        teamId: input.evidence.teamId,
        retentionUntilUtc: input.evidence.retentionUntilUtc,
      },
    },
    client,
  );

  if (decision.allowed) return { gated: false };

  // Map decision code → custody event type. Matches the pre-Phase X.1
  // mapping in evidence.routes.ts exactly.
  const custodyEventType =
    decision.code === "DELETE_BLOCKED_BY_LEGAL_HOLD"
      ? prismaPkg.CustodyEventType.DELETE_BLOCKED_BY_LEGAL_HOLD
      : decision.code === "DELETE_BLOCKED_BY_RETENTION"
        ? prismaPkg.CustodyEventType.DELETE_BLOCKED_BY_RETENTION
        : prismaPkg.CustodyEventType.EXPORT_BLOCKED_BY_POLICY;

  // Custody event for the blocked attempt — visible in the same
  // forensic chain as integrity events. Best-effort; never breaks the
  // gate response.
  await appendCustodyEvent({
    evidenceId: input.evidence.id,
    eventType: custodyEventType,
    payload: {
      action: input.routeLabel,
      reason: decision.reason,
      actorUserId: input.actorUserId,
    },
    ip: input.req?.ip,
    userAgent: input.req?.headers["user-agent"] as string | undefined,
  }).catch(() => null);

  // Map decision code → HTTP status. Matches the pre-Phase X.1
  // mapping in evidence.routes.ts exactly.
  const statusCode: 403 | 409 | 503 =
    decision.code === "GOVERNANCE_CHECK_FAILED"
      ? 503
      : decision.code === "DELETE_RESTRICTED_TO_ADMIN"
        ? 403
        : 409;

  const message =
    input.routeLabel === "delete"
      ? "Evidence deletion is not permitted under the current governance state."
      : input.routeLabel === "archive"
        ? "Evidence archive is not permitted under the current governance state."
        : "This action is not permitted under the current governance state.";

  return {
    gated: true,
    statusCode,
    body: {
      code: decision.code,
      reason: decision.reason,
      message,
    },
  };
}
