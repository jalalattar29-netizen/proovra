import type { FastifyReply, FastifyRequest } from "fastify";
import { createErrorResponse, ErrorCode } from "../errors.js";
import {
  verifyJwt,
  resolveSupportedProvenance,
  provenanceToPolicyAuthMethod,
} from "../services/jwt.js";
import { evaluateOrgContextForSession } from "../services/identity/org-security-policy.service.js";
import {
  hashSessionId,
  isSessionRevoked,
} from "../services/identity-security/session-revocation.service.js";
import { recordHeartbeat } from "../services/access-control/session-inventory.service.js";
// PHASE 13 §4 (2026-08-17) — the members roster's "Last seen" column. Imported
// through the canonical membership orchestrator, NOT from rbac.service directly:
// the program architecture registry locks the rbac engine to a single importer,
// and a middleware that reaches past it is exactly the second authority that
// lock exists to prevent.
import { touchMemberLastSeen } from "../services/identity/membership-provisioning.service.js";
import { getSecret } from "../config/runtime-secrets.js";
import { prisma } from "../db.js";
import { gateSecurityAction } from "../services/governance/policy-runtime-gates.service.js";
import { enforceSessionTimeoutPolicy } from "../services/identity-security/session-timeout-policy.service.js";

function readCookie(header: string | undefined, name: string): string | null {
  if (!header) return null;
  const parts = header.split(";").map((part) => part.trim());
  for (const part of parts) {
    if (part.startsWith(`${name}=`)) {
      return decodeURIComponent(part.slice(name.length + 1));
    }
  }
  return null;
}

export async function requireAuth(req: FastifyRequest, reply: FastifyReply) {
  try {
    const auth = req.headers.authorization ?? "";
    const bearerToken = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
    const cookieToken =
      (req.cookies as { proovra_session?: string } | undefined)?.proovra_session ??
      readCookie(req.headers.cookie, "proovra_session");

    const token = bearerToken || cookieToken;

    if (!token) {
      req.log.info(
        {
          requestId: req.id,
          hasAuthHeader: Boolean(req.headers.authorization),
          hasCookie: Boolean(req.headers.cookie),
          cookiePresent: Boolean(cookieToken),
          host: req.headers.host,
          origin: req.headers.origin,
        },
        "auth.missing_token"
      );

      return reply
        .code(401)
        .send(createErrorResponse(ErrorCode.UNAUTHORIZED, req.id));
    }

    // Phase P2.0 — AUTH_JWT_SECRET is in the migrated set. Resolved
    // via the typed accessor: AWS Secrets Manager cache first, env
    // fallback. Synchronous in-memory lookup on the hot path; no
    // per-request network calls.
    const secret = getSecret("AUTH_JWT_SECRET");
    if (!secret) {
      throw new Error("AUTH_JWT_SECRET is not set");
    }

    const payload = verifyJwt(token, secret);

    // PHASE R8.1.2 — refuse MFA-pending tokens. A pending token is
    // ONLY valid for `POST /v1/auth/mfa/verify`; it must NEVER act as
    // a full session. Tokens carrying `mfa: "pending"` reach here only
    // if the client misuses them (e.g. places one in the session
    // cookie). Reject with the same generic 401 to avoid leaking
    // discriminator semantics to an attacker.
    if (payload.mfa === "pending") {
      req.log.info(
        { requestId: req.id, userId: payload.sub },
        "auth.rejected_mfa_pending_token",
      );
      return reply
        .code(401)
        .send(createErrorResponse(ErrorCode.UNAUTHORIZED, req.id));
    }

    // PHASE 10 §10.2/§6 — CANONICAL PROVENANCE RULE (generic, no per-provider
    // branch): an interactive session is accepted ONLY when the token carries a
    // SUPPORTED, server-proven authentication provenance. A token whose
    // `authMethod` is missing, malformed, UNKNOWN, or any historical/unsupported
    // provider has no proven provenance and MUST reauthenticate — it is NEVER
    // coerced to PASSWORD or any valid method, and it establishes NO
    // authenticated context (Personal, Owned Workspace, Organization, or context
    // switch). Public resource-scoped tokens use their own domain mechanisms and
    // never reach this middleware.
    const provenance = resolveSupportedProvenance(payload.authMethod);
    if (provenance === null) {
      req.log.info(
        { requestId: req.id, userId: payload.sub },
        "auth.reauthentication_required",
      );
      return reply.code(401).send(
        createErrorResponse(ErrorCode.UNAUTHORIZED, req.id, {
          reason: "reauthentication_required",
        }),
      );
    }

    // Phase 19 — session revocation registry check. Fast: single
    // findFirst keyed by userId. Fails CLOSED on the rare case
    // where the deny list can't be read (Prisma outage).
    const sid = typeof payload.sid === "string" ? payload.sid : null;
    const iat = typeof payload.iat === "number" ? payload.iat : null;
    try {
      const revoked = await isSessionRevoked({
        userId: payload.sub,
        sessionIdHash: sid ? hashSessionId(sid) : null,
        iat,
      });
      if (revoked) {
        req.log.info(
          { requestId: req.id, userId: payload.sub },
          "auth.session_revoked",
        );
        return reply
          .code(401)
          .send(createErrorResponse(ErrorCode.UNAUTHORIZED, req.id));
      }
    } catch (err) {
      req.log.warn(
        {
          requestId: req.id,
          errorMessage: err instanceof Error ? err.message : "revocation_check_failed",
        },
        "auth.revocation_check_failed",
      );
      return reply
        .code(401)
        .send(createErrorResponse(ErrorCode.UNAUTHORIZED, req.id));
    }

    // Phase 4A Closure — SECURITY policy gate at session-authenticate time.
    // When the JWT carries a session id, look up the workspace anchor (teamId)
    // and run gateSecurityAction with action="session_authenticate". The
    // governance policy engine (evaluateSecurityPolicy) inspects effective
    // SECURITY policies (requireMfa / requireSaml / allowedActions). A BLOCK
    // verdict refuses the request with 401 — closes the loop between Phase 4A
    // SECURITY policies and the actual authentication path. Skipped for
    // sessions without a resolvable teamId (personal-space tokens have no
    // workspace policies to evaluate, so the gate is a no-op there by design).
    // PHASE 13 §4 (2026-08-17) — hoisted out of the `if (sid)` block so the
    // membership heartbeat at the end of a SUCCESSFUL authentication can bind
    // the correct tenant. It is the session row's own anchor, never a
    // caller-supplied header, so a request cannot nominate the workspace whose
    // membership it refreshes.
    let sessionTeamId: string | null = null;
    if (sid) {
      // Single session-row read reused by BOTH the Phase 4A security
      // gate and the Phase 3 session-timeout policy enforcement below,
      // so the hot path adds at most one lookup. `lastSeenAtUtc` feeds
      // the idle-timeout computation.
      let sessionRow: { teamId: string | null; lastSeenAtUtc: Date } | null =
        null;
      // PHASE 10 §1 — SESSION STATE READ. Infra failure here means we cannot
      // classify the request's workspace context → FAIL CLOSED with a generic
      // 503 (never allow-through). The route handler is not reached.
      try {
        sessionRow = await prisma.authenticatedSession.findFirst({
          where: {
            userId: payload.sub,
            sessionIdHash: hashSessionId(sid),
          },
          select: { teamId: true, lastSeenAtUtc: true },
        });
      } catch (err) {
        req.log.error(
          {
            requestId: req.id,
            errorMessage:
              err instanceof Error ? err.message : "session_state_read_failed",
          },
          "auth.security_context_unavailable",
        );
        return reply
          .code(503)
          .send(createErrorResponse(ErrorCode.SECURITY_CONTEXT_UNAVAILABLE, req.id));
      }

      const teamId = sessionRow?.teamId ?? null;
      sessionTeamId = teamId;
      // Only workspace-bound sessions carry Organization security policy.
      // Personal / teamless sessions have no OrganizationSecurityPolicy to
      // evaluate (§1: Personal/OWNED never require Organization policy).
      if (teamId) {
        // PHASE 10 §1 — ORGANIZATION security-policy enforcement. This is the
        // authoritative composition: Phase-4A SECURITY gate + CONTINUOUS
        // org-context policy (mandatory-SSO org-bound + org lifecycle + session
        // policy) on EVERY request whose workspace is an ORGANIZATION workspace
        // (not only the switch seam). It reads LIVE policy so a tightening
        // affects subsequent requests. FAIL CLOSED: any infrastructure read
        // failure (workspace / organization / policy / SSO / managed-identity /
        // gate) yields a generic 503 and the handler is NEVER reached — infra
        // errors are NEVER converted to allow. A COMPUTED denial (non-compliant
        // session / ambiguous context) yields the canonical 401, ZERO mutation.
        let verdict: Awaited<ReturnType<typeof gateSecurityAction>>;
        let orgGate: { allowed: boolean; reason?: string };
        try {
          verdict = await gateSecurityAction({
            teamId,
            userId: payload.sub,
            action: "session_authenticate",
            mfaSatisfied: payload.mfa !== "pending",
          });
          // Provenance is guaranteed SUPPORTED here (unsupported was rejected
          // at the door), so policyMethod is non-null.
          const policyMethod = provenanceToPolicyAuthMethod(payload.authMethod);
          const authAtSec =
            typeof payload.authAt === "number" ? payload.authAt : iat ?? 0;
          orgGate = policyMethod
            ? await evaluateOrgContextForSession({
                userId: payload.sub,
                teamId,
                method: policyMethod,
                ssoConnId:
                  typeof payload.ssoConnId === "string" ? payload.ssoConnId : null,
                authAtMs: authAtSec > 0 ? authAtSec * 1000 : Date.now(),
                lastSeenAtMs: sessionRow?.lastSeenAtUtc
                  ? sessionRow.lastSeenAtUtc.getTime()
                  : Date.now(),
              })
            : // No supported provenance would already have been rejected above;
              // defence-in-depth → treat as reauthenticate, not allow.
              { allowed: false, reason: "reauthentication_required" };
        } catch (err) {
          // FAIL CLOSED — an Organization security-policy read failed. Generic
          // 503, no tenant details, handler not reached. NEVER fail open.
          req.log.error(
            {
              requestId: req.id,
              errorMessage:
                err instanceof Error ? err.message : "security_gate_failed",
            },
            "auth.security_context_unavailable",
          );
          return reply
            .code(503)
            .send(createErrorResponse(ErrorCode.SECURITY_CONTEXT_UNAVAILABLE, req.id));
        }

        if (!verdict.ok) {
          req.log.info(
            {
              requestId: req.id,
              userId: payload.sub,
              denial: verdict.denial,
              reason: verdict.reason,
            },
            "auth.security_policy_denied",
          );
          return reply
            .code(401)
            .send(createErrorResponse(ErrorCode.UNAUTHORIZED, req.id));
        }
        if (!orgGate.allowed) {
          req.log.info(
            { requestId: req.id, userId: payload.sub, reason: orgGate.reason },
            "auth.org_context_policy_denied",
          );
          return reply.code(401).send(
            createErrorResponse(ErrorCode.UNAUTHORIZED, req.id, {
              reason: "reauthentication_required",
            }),
          );
        }
      }

      // Phase 3 (Enterprise Identity) — enforce the org's role-tiered
      // session-timeout policy. Connects the previously stored-but-not-
      // enforced reviewer/contributor session-timeout fields to actual
      // enforcement. When the caller's session age or idle time exceeds
      // the applicable timeout for their workspace role, reject with a
      // 401 (session_expired) so the client re-authenticates. FAILS SAFE:
      // `enforceSessionTimeoutPolicy` never throws and degrades to the
      // JWT exp cap on any lookup error, so a policy-table outage cannot
      // lock everyone out. Personal-space (teamless) sessions are a
      // no-op. The external reviewer portal never reaches this code
      // (separate token/session model), so its sessions are unaffected.
      const timeout = await enforceSessionTimeoutPolicy({
        userId: payload.sub,
        teamId: sessionRow?.teamId ?? null,
        iat,
        lastSeenAtMs: sessionRow?.lastSeenAtUtc
          ? sessionRow.lastSeenAtUtc.getTime()
          : null,
      });
      if (timeout.action === "expire") {
        req.log.info(
          {
            requestId: req.id,
            userId: payload.sub,
            reason: timeout.reason,
            appliedTimeoutSeconds: timeout.appliedTimeoutSeconds,
            role: timeout.role,
          },
          "auth.session_expired_by_policy",
        );
        return reply.code(401).send(
          createErrorResponse(
            ErrorCode.TOKEN_EXPIRED,
            req.id,
            { reason: "session_expired" },
          ),
        );
      }
    }

    req.user = {
      sub: payload.sub,
      provider: payload.provider,
      email: payload.email,
      role: payload.role ?? null,
      // Phase 2.4 — expose the hashed session id so user-facing
      // session routes (GET /v1/users/me/sessions) can identify the
      // current session row. `sid` is already hashed above for the
      // revocation check; we re-use that result by recomputing here
      // (cheap SHA-256). If the JWT has no `sid` we leave it null.
      sessionIdHash: sid ? hashSessionId(sid) : null,
      // PHASE 10 §10.2 — provenance is guaranteed SUPPORTED here (unsupported
      // was rejected above), so org/session-policy gates can trust these.
      authMethod: provenance,
      authAt: typeof payload.authAt === "number" ? payload.authAt : null,
      ssoConnId: typeof payload.ssoConnId === "string" ? payload.ssoConnId : null,
      mfaAt: typeof payload.mfaAt === "number" ? payload.mfaAt : null,
    };
    req.log = req.log.child({ userId: payload.sub });

    // Phase 26.75 — Sampled heartbeat. Fire-and-forget; the helper is
    // self-throttled via shouldWriteHeartbeat() so it writes at most
    // once per session per window (default 60s). Wrapped in a kill-
    // switch + a defensive catch so a heartbeat failure NEVER fails
    // an authenticated request.
    if (sid && process.env["SESSION_HEARTBEAT_ENABLED"] !== "false") {
      void recordHeartbeat({ userId: payload.sub, sid })
        .then((res) => {
          // PHASE 13 §4 (2026-08-17) — membership heartbeat, chained off the
          // SESSION heartbeat's own sample decision.
          //
          // `TeamMember.lastSeenAtUtc` is the "Last seen" column of the members
          // roster and had no writer at all, so it rendered blank for every
          // member of every workspace. It is written here and only here.
          //
          // Three properties this placement buys, none of them accidental:
          //
          //   - It is past every gate. Reaching this line means the token
          //     verified, the session was not revoked, the security policy
          //     allowed the request and the session-timeout policy did not
          //     expire it. A FAILED authentication returns long before here, so
          //     a rejected request can never advance a member's last-seen.
          //   - The tenant is the session row's anchor (`sessionTeamId`), so the
          //     write lands on the membership the caller is actually acting
          //     under.
          //   - Gating on `res.written` inherits the session heartbeat's sample
          //     window, so the membership row is written at most once per
          //     session per window rather than once per request.
          if (!res.written || !sessionTeamId) return null;
          return touchMemberLastSeen({
            teamId: sessionTeamId,
            userId: payload.sub,
          });
        })
        .catch(() => null);
    }
  } catch (err) {
    req.log.warn(
      {
        requestId: req.id,
        errorMessage: err instanceof Error ? err.message : "Invalid token",
      },
      "auth.invalid_token"
    );

    return reply
      .code(401)
      .send(createErrorResponse(ErrorCode.UNAUTHORIZED, req.id));
  }
}