import { createErrorResponse, ErrorCode } from "../errors.js";
import { verifyJwt } from "../services/jwt.js";
import { hashSessionId, isSessionRevoked, } from "../services/identity-security/session-revocation.service.js";
import { recordHeartbeat } from "../services/access-control/session-inventory.service.js";
import { getSecret } from "../config/runtime-secrets.js";
import { prisma } from "../db.js";
import { gateSecurityAction } from "../services/governance/policy-runtime-gates.service.js";
function readCookie(header, name) {
    if (!header)
        return null;
    const parts = header.split(";").map((part) => part.trim());
    for (const part of parts) {
        if (part.startsWith(`${name}=`)) {
            return decodeURIComponent(part.slice(name.length + 1));
        }
    }
    return null;
}
export async function requireAuth(req, reply) {
    try {
        const auth = req.headers.authorization ?? "";
        const bearerToken = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
        const cookieToken = req.cookies?.proovra_session ??
            readCookie(req.headers.cookie, "proovra_session");
        const token = bearerToken || cookieToken;
        if (!token) {
            req.log.info({
                requestId: req.id,
                hasAuthHeader: Boolean(req.headers.authorization),
                hasCookie: Boolean(req.headers.cookie),
                cookiePresent: Boolean(cookieToken),
                host: req.headers.host,
                origin: req.headers.origin,
            }, "auth.missing_token");
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
            req.log.info({ requestId: req.id, userId: payload.sub }, "auth.rejected_mfa_pending_token");
            return reply
                .code(401)
                .send(createErrorResponse(ErrorCode.UNAUTHORIZED, req.id));
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
                req.log.info({ requestId: req.id, userId: payload.sub }, "auth.session_revoked");
                return reply
                    .code(401)
                    .send(createErrorResponse(ErrorCode.UNAUTHORIZED, req.id));
            }
        }
        catch (err) {
            req.log.warn({
                requestId: req.id,
                errorMessage: err instanceof Error ? err.message : "revocation_check_failed",
            }, "auth.revocation_check_failed");
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
        if (sid) {
            try {
                const sessionRow = await prisma.authenticatedSession.findFirst({
                    where: {
                        userId: payload.sub,
                        sessionIdHash: hashSessionId(sid),
                    },
                    select: { teamId: true },
                });
                const teamId = sessionRow?.teamId ?? null;
                if (teamId) {
                    const verdict = await gateSecurityAction({
                        teamId,
                        userId: payload.sub,
                        action: "session_authenticate",
                        mfaSatisfied: payload.mfa !== "pending",
                    });
                    if (!verdict.ok) {
                        req.log.info({
                            requestId: req.id,
                            userId: payload.sub,
                            denial: verdict.denial,
                            reason: verdict.reason,
                        }, "auth.security_policy_denied");
                        return reply
                            .code(401)
                            .send(createErrorResponse(ErrorCode.UNAUTHORIZED, req.id));
                    }
                }
            }
            catch (err) {
                // Fail OPEN on policy-engine read failure — auth has already passed
                // JWT + revocation checks; a Prisma outage on the policy table must
                // not lock out every user. The failure is logged for security ops.
                req.log.warn({
                    requestId: req.id,
                    errorMessage: err instanceof Error ? err.message : "security_gate_failed",
                }, "auth.security_gate_failed");
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
        };
        req.log = req.log.child({ userId: payload.sub });
        // Phase 26.75 — Sampled heartbeat. Fire-and-forget; the helper is
        // self-throttled via shouldWriteHeartbeat() so it writes at most
        // once per session per window (default 60s). Wrapped in a kill-
        // switch + a defensive catch so a heartbeat failure NEVER fails
        // an authenticated request.
        if (sid && process.env["SESSION_HEARTBEAT_ENABLED"] !== "false") {
            void recordHeartbeat({ userId: payload.sub, sid }).catch(() => null);
        }
    }
    catch (err) {
        req.log.warn({
            requestId: req.id,
            errorMessage: err instanceof Error ? err.message : "Invalid token",
        }, "auth.invalid_token");
        return reply
            .code(401)
            .send(createErrorResponse(ErrorCode.UNAUTHORIZED, req.id));
    }
}
