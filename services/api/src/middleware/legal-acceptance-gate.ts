/**
 * A1-06 — CURRENT TERMS, ENFORCED BY THE SERVER, AT ONE POINT.
 *
 * Re-acceptance used to be a per-route opt-in: thirteen route files wrapped
 * `requireAuth` in a local `requireAuthAndLegal`, and roughly a thousand
 * `requireAuth` sites did not. Whether a person with outstanding terms could
 * create a share, an intake link or an upload session therefore depended on
 * which file the route happened to live in.
 *
 * The rule now (product decision A1-06): an authenticated WRITE needs the
 * current acceptance. `requireAuth` runs on every session-authenticated route,
 * so the check is made there, once, for every non-safe method, unless the route
 * is in the reviewed exemption classification in
 * `legal-acceptance-route-policy.ts`. A read is never refused for terms: a
 * person keeps seeing their own data, and the flows they must be able to reach
 * without agreeing (cancel, export, close the account, revoke) start with reads.
 *
 * The refusal is the one `requireLegalAcceptance` has always sent — 428
 * `LEGAL_REACCEPT_REQUIRED` with the missing policies — so the web prompt, the
 * native acceptance screen and the extension already know it. It is sent
 * before the handler runs, so a refused write leaves no row behind.
 *
 * Routes that never reach `requireAuth` (webhooks, public Verify, intake and
 * portal tokens, API keys, SCIM, cron and internal secrets) are not session
 * actors and are not gated here; the classification records each of them and
 * why (`NON_SESSION_WRITE_ROUTES`), and an enumeration test over the live route
 * table fails when a write route is neither enforced nor classified.
 */
import type { FastifyReply, FastifyRequest } from "fastify";

import { assertUserHasRequiredLegalAcceptances } from "../services/legal-acceptance.service.js";
import { legalAcceptanceExemptionFor } from "./legal-acceptance-route-policy.js";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export const LEGAL_REACCEPT_REQUIRED_CODE = "LEGAL_REACCEPT_REQUIRED";

/** Requests already proven current, so a route-level check does not read twice. */
const verified = new WeakSet<FastifyRequest>();

/** Does this request need the current acceptance? Pure: method + route pattern. */
export function legalAcceptanceRequiredFor(method: string, routePattern: string | null): boolean {
  if (SAFE_METHODS.has(method.toUpperCase())) return false;
  if (routePattern && legalAcceptanceExemptionFor(method, routePattern)) return false;
  return true;
}

/**
 * Sends the shared refusal and returns true when `userId` has not accepted the
 * current required versions. A status read that fails is not "terms owed": it
 * answers 503, so a database fault never puts an acceptance prompt in front of
 * someone who has already accepted (and can never loop one).
 */
export async function refuseWithoutCurrentLegalAcceptance(
  req: FastifyRequest,
  reply: FastifyReply,
  userId: string,
): Promise<boolean> {
  if (verified.has(req)) return false;
  try {
    await assertUserHasRequiredLegalAcceptances({ userId });
  } catch (err) {
    const coded =
      err instanceof Error && "code" in err && (err as { code?: unknown }).code === LEGAL_REACCEPT_REQUIRED_CODE;
    if (!coded) {
      req.log.error(
        { requestId: req.id, errorMessage: err instanceof Error ? err.message : "legal_status_unavailable" },
        "legal.acceptance_status_unavailable",
      );
      await reply.code(503).send({
        error: {
          code: "SECURITY_CONTEXT_UNAVAILABLE",
          message: "We could not confirm your account status. Try again in a moment.",
          requestId: req.id,
        },
      });
      return true;
    }
    await reply.code(428).send({
      error: {
        code: "LEGAL_REACCEPT_REQUIRED",
        message: "You must accept the latest legal policies before continuing.",
        requestId: req.id,
        details: (err as { details?: unknown }).details,
      },
    });
    return true;
  }
  verified.add(req);
  return false;
}

/**
 * Called by `requireAuth` once the session is proven. Returns true when the
 * request must stop (the refusal has been sent).
 */
export async function refuseStaleLegalAcceptanceOnWrite(
  req: FastifyRequest,
  reply: FastifyReply,
  userId: string,
  routePattern: string | null,
): Promise<boolean> {
  if (!legalAcceptanceRequiredFor(req.method, routePattern)) return false;
  return refuseWithoutCurrentLegalAcceptance(req, reply, userId);
}
