/**
 * Phase 26.75 — Adaptive auth runtime gate.
 *
 * Single helper that route handlers call BEFORE running a privileged
 * action. Combines:
 *   - Phase 26.5 adaptive auth decision (risk + trust + age)
 *   - Phase 26.75 session quarantine check
 *   - Phase 26.75 privileged-session age gate (per-action freshness)
 *   - Phase 19 step-up middleware integration
 *
 * Behavior:
 *   - LOW risk + non-stale + not-quarantined → ALLOW (no-op)
 *   - Quarantined session → BLOCK with `privileged_session_blocked`
 *   - MEDIUM risk → STEP_UP (route invokes existing step-up middleware)
 *   - HIGH risk (untrusted) OR privileged-action-stale → REQUIRE_REAUTH
 *   - CRITICAL → BLOCK + open runtime incident
 *
 * Hard rules:
 *   - The gate runs AFTER the route's existing access-policy check.
 *     It NEVER widens permission; it can only narrow.
 *   - The gate is feature-flagged via `ADAPTIVE_AUTH_RUNTIME_ENABLED`.
 *     When false, the gate becomes a no-op (returns ALLOW) so the
 *     enterprise migration can be staged.
 *   - Failures are observable but never fail-closed unless the
 *     decision is explicitly BLOCK — auth integrity is preserved.
 */

import type { FastifyReply, FastifyRequest } from "fastify";

import type { PrismaClient } from "@prisma/client";
import {
  privilegedActionRequiresFreshAuth,
  type PrivilegedAction,
  type RuntimeAdaptiveDecision,
} from "@proovra/shared";

import { prisma as defaultPrisma } from "../../db.js";
import { bump } from "../ops/metrics.service.js";
import { safeEmitSecurityEvent } from "../security/security-event.service.js";
import { hashSessionId } from "../identity-security/session-revocation.service.js";
import { isSessionQuarantined } from "./session-quarantine.service.js";
import { decideAdaptiveAuth } from "./adaptive-auth.service.js";
import { recordIncident } from "../observability/incident.service.js";
import { requireStepUpForSensitiveAction } from "../identity-security/step-up-middleware.js";

// -----------------------------------------------------------------------------
// Public — runtimeAdaptiveGate
// -----------------------------------------------------------------------------

export type RuntimeAdaptiveGateInput = {
  req: FastifyRequest;
  reply: FastifyReply;
  teamId: string;
  userId: string;
  action: PrivilegedAction;
  /** Whether the workspace policy demands step-up for sensitive flows. */
  workspaceRequiresStepUp?: boolean;
  /**
   * The caller runs requireStepUpForSensitiveAction itself after this gate. A
   * challenge is single use, so a step-up decision is handed back to it as
   * `stepUpRequired` instead of being answered here.
   */
  callerEnforcesStepUp?: boolean;
};

export type RuntimeAdaptiveGateResult =
  | { allow: true; stepUpRequired?: boolean }
  | { allow: false; sent: true; decision: RuntimeAdaptiveDecision["decision"] };

export async function runtimeAdaptiveGate(
  input: RuntimeAdaptiveGateInput,
  client: PrismaClient = defaultPrisma,
): Promise<RuntimeAdaptiveGateResult> {
  if (process.env["ADAPTIVE_AUTH_RUNTIME_ENABLED"] === "false") {
    return { allow: true };
  }

  // (1) Quarantine block — THE quarantine authority, shared with every
  // privileged route that calls `refuseIfSessionQuarantined` directly
  // (IDENT-019). It also resolves the session row the later steps use.
  const quarantine = await checkSessionQuarantine(input, client);
  if (quarantine.refused) {
    return { allow: false, sent: true, decision: "BLOCK" };
  }
  const session = quarantine.session;
  if (!session) {
    // No sid claim (legacy token) or no inventory row (legacy session):
    // allow, as before.
    return { allow: true };
  }

  // (2) Privileged-action age check.
  if (
    privilegedActionRequiresFreshAuth({
      sessionIssuedAtUtc: session.issuedAtUtc,
      action: input.action,
    })
  ) {
    bump("forced_reauth_runtime_total");
    bump("adaptive_auth_reauth_total");
    safeEmitSecurityEvent({
      teamId: input.teamId,
      eventType: "forced_runtime_reauthentication",
      severity: "WARNING",
      details: {
        sessionId: session.id,
        subjectUserId: input.userId,
        action: input.action,
        reason: "session_too_old_for_privileged_action",
      },
    });
    input.reply.code(401).send({
      error: {
        code: "reauth_required",
        message: "Sign in again to perform this action.",
        reason: "session_too_old_for_privileged_action",
      },
    });
    return { allow: false, sent: true, decision: "REQUIRE_REAUTH" };
  }

  // (3) Adaptive decision (risk + trusted-device).
  const decision = await decideAdaptiveAuth(
    {
      teamId: input.teamId,
      userId: input.userId,
      sessionId: session.id,
      highPrivilegeAction: true,
      workspaceRequiresStepUp: !!input.workspaceRequiresStepUp,
    },
    client,
  );

  switch (decision.decision) {
    case "ALLOW":
      bump("adaptive_auth_allow_total");
      return { allow: true };
    case "REQUIRE_STEP_UP": {
      bump("adaptive_auth_step_up_total");
      if (input.callerEnforcesStepUp) return { allow: true, stepUpRequired: true };
      // The canonical gate, so the answer is one a client can satisfy. This used
      // to send a lowercase code no client recognised and never read the
      // challenge header, so a medium-risk session could not act at all.
      const stepUp = await requireStepUpForSensitiveAction(
        {
          req: input.req,
          reply: input.reply,
          teamId: input.teamId,
          userId: input.userId,
          purpose: decision.stepUpPurpose ?? "SESSION_SANITY_CHECK",
          resourceKind: "adaptive_runtime_gate",
          resourceId: null,
        },
        client,
      );
      if (stepUp.sent) return { allow: false, sent: true, decision: "REQUIRE_STEP_UP" };
      return { allow: true };
    }
    case "REQUIRE_REAUTH":
      bump("adaptive_auth_reauth_total");
      input.reply.code(401).send({
        error: {
          code: "reauth_required",
          message: "Sign in again to perform this action.",
          reason: decision.reason,
        },
      });
      return { allow: false, sent: true, decision: "REQUIRE_REAUTH" };
    case "BLOCK": {
      bump("adaptive_auth_block_total");
      // Open a runtime incident; the helper dedupes at the (team,
      // hourly) fingerprint level so a single bad session does not
      // spawn dozens of incidents.
      try {
        await recordIncident({
          sourceId: "identity.runtime_block",
          teamId: input.teamId,
          category: "IDENTITY_SECURITY",
          severity: "HIGH",
          fingerprint: `runtime-block:${input.teamId}:${input.action}:${Math.floor(Date.now() / 3600_000)}`,
          message: {
            code: "ops.identity.runtime_block",
            params: { action: input.action, riskScore: Math.round(decision.riskScore) },
          },
          runbookSlug: "runtime-adaptive-block",
          metadata: {
            sessionId: session.id,
            action: input.action,
            riskScore: decision.riskScore,
          },
        });
        bump("runtime_incident_total");
      } catch {
        /* incident creation is best-effort */
      }
      input.reply.code(403).send({
        error: {
          code: "session_blocked",
          message: "This session has been blocked from privileged actions.",
          reason: decision.reason,
        },
      });
      return { allow: false, sent: true, decision: "BLOCK" };
    }
    default:
      return { allow: true };
  }
}

// -----------------------------------------------------------------------------
// Public — refuseIfSessionQuarantined (IDENT-019)
// -----------------------------------------------------------------------------

export type RefuseIfSessionQuarantinedInput = {
  req: FastifyRequest;
  reply: FastifyReply;
  /** Workspace the action targets, for the security event; null when none. */
  teamId: string | null;
  userId: string;
  action: PrivilegedAction;
};

/**
 * IDENT-019 — the ONE quarantine authority (decision D13: a quarantined
 * session keeps reads; high-privilege actions are refused).
 *
 * Routes that perform a declared privileged action (PRIVILEGED_ACTIONS) but
 * do not run the full `runtimeAdaptiveGate` call this AFTER their own
 * authentication and access-policy checks and BEFORE any side effect. It
 * only narrows: it never allows anything the route would have refused.
 *
 * It runs ONLY the quarantine step of the gate — no age/freshness window and
 * no risk/step-up decision. When it refuses, the 403 `session_quarantined`
 * reply has already been sent and the route must return.
 *
 * Same semantics as the gate: a no-op when ADAPTIVE_AUTH_RUNTIME_ENABLED is
 * "false"; a token with no `sid` claim, or a sid with no inventory row, is
 * allowed (legacy sessions).
 */
export async function refuseIfSessionQuarantined(
  input: RefuseIfSessionQuarantinedInput,
  client: PrismaClient = defaultPrisma,
): Promise<{ refused: boolean }> {
  if (process.env["ADAPTIVE_AUTH_RUNTIME_ENABLED"] === "false") {
    return { refused: false };
  }
  const { refused } = await checkSessionQuarantine(input, client);
  return { refused };
}

type RuntimeSessionRow = {
  id: string;
  issuedAtUtc: Date;
  quarantinedAtUtc: Date | null;
  quarantineReleaseAtUtc: Date | null;
};

async function checkSessionQuarantine(
  input: RefuseIfSessionQuarantinedInput,
  client: PrismaClient,
): Promise<{ refused: boolean; session: RuntimeSessionRow | null }> {
  // Resolve the AuthenticatedSession row from the JWT sid claim. The
  // auth middleware has already verified the JWT; we re-read the sid
  // from the Authorization / cookie path.
  const sid = readSidFromRequest(input.req);
  if (!sid) {
    // No sid claim = a legacy token. Allowed.
    return { refused: false, session: null };
  }
  const sessionIdHash = hashSessionId(sid);
  const session = await client.authenticatedSession.findFirst({
    where: {
      userId: input.userId,
      sessionIdHash,
    },
    select: {
      id: true,
      issuedAtUtc: true,
      quarantinedAtUtc: true,
      quarantineReleaseAtUtc: true,
    },
  });
  if (!session) {
    // Legacy session without inventory row — allowed.
    return { refused: false, session: null };
  }

  // Read-only paths are never gated here (only routes that already know
  // they are privileged call this).
  const quarantined = await isSessionQuarantined(
    { sessionId: session.id },
    client,
  );
  if (quarantined) {
    bump("privileged_session_blocked_total");
    safeEmitSecurityEvent({
      teamId: input.teamId,
      eventType: "privileged_session_blocked",
      severity: "WARNING",
      details: {
        sessionId: session.id,
        subjectUserId: input.userId,
        action: input.action,
        reason: "session_quarantined",
      },
    });
    input.reply.code(403).send({
      error: {
        code: "session_quarantined",
        message: "This session is quarantined; privileged actions blocked.",
      },
    });
    return { refused: true, session };
  }
  return { refused: false, session };
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function readSidFromRequest(req: FastifyRequest): string | null {
  // The auth middleware already verified the JWT; we re-decode the
  // payload here to read the `sid` claim without re-verifying.
  const auth = req.headers["authorization"] ?? "";
  const bearer = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  const cookieHeader = req.headers["cookie"];
  const cookieToken = readCookie(cookieHeader, "proovra_session");
  const token = bearer || cookieToken;
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const json = Buffer.from(parts[1], "base64url").toString("utf8");
    const parsed = JSON.parse(json) as { sid?: unknown };
    return typeof parsed.sid === "string" && parsed.sid.length > 0
      ? parsed.sid
      : null;
  } catch {
    return null;
  }
}

function readCookie(header: string | undefined, name: string): string | null {
  if (!header) return null;
  const parts = header.split(";").map((p) => p.trim());
  for (const p of parts) {
    if (p.startsWith(`${name}=`)) {
      return decodeURIComponent(p.slice(name.length + 1));
    }
  }
  return null;
}
