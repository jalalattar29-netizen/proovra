import type { FastifyReply, FastifyRequest } from "fastify";
import { createErrorResponse, ErrorCode } from "../errors.js";
import { verifyJwt } from "../services/jwt.js";
import {
  hashSessionId,
  isSessionRevoked,
} from "../services/identity-security/session-revocation.service.js";
import { recordHeartbeat } from "../services/access-control/session-inventory.service.js";

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

    const secret = process.env.AUTH_JWT_SECRET;
    if (!secret) {
      throw new Error("AUTH_JWT_SECRET is not set");
    }

    const payload = verifyJwt(token, secret);

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

    req.user = {
      sub: payload.sub,
      provider: payload.provider,
      email: payload.email,
      role: payload.role ?? null,
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