/**
 * THE RUNBOOK CAPABILITY CHECK, RESOLVED FROM A REQUEST.
 *
 * The server-component boundary (`server-authorization.ts`) reads `cookies()`
 * and stops the body being rendered. It cannot set a status: by the time a
 * dynamic page under the (app) layout has an opinion, the layout has streamed
 * and the status line is spent, so the best it could do was an empty shell
 * with HTTP 200 — which a monitor, a link checker and a CDN all read as
 * success.
 *
 * Middleware still owns the status, so the same decision is resolved here from
 * a `NextRequest` instead. It is the identical rule against the identical
 * authority; only the source of the cookie differs.
 *
 * Fails closed on every path that is not an explicit grant, including a
 * network error, a non-JSON body and a 5xx. A content boundary that opens when
 * its authority is unreachable is not a boundary.
 */

import type { NextRequest } from "next/server";

import { apiBaseUrl } from "../api";

export type RunbookAccess = "AUTHORIZED" | "UNAUTHENTICATED" | "FORBIDDEN";

/** The capability the route registry declares for `platform.runbook_document`. */
const REQUIRED_CAPABILITY = "RUNBOOKS_VIEW";

export async function resolveRunbookAccessForRequest(
  req: NextRequest,
): Promise<RunbookAccess> {
  const session = req.cookies.get("proovra_session")?.value;
  if (!session) return "UNAUTHENTICATED";

  let res: Response;
  try {
    res = await fetch(`${apiBaseUrl()}/v1/platform/context`, {
      headers: { authorization: `Bearer ${session}` },
      cache: "no-store",
    });
  } catch {
    return "FORBIDDEN";
  }

  if (res.status === 401) return "UNAUTHENTICATED";
  if (!res.ok) return "FORBIDDEN";

  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return "FORBIDDEN";
  }

  const capabilities = (body as { capabilities?: Record<string, unknown> } | null)
    ?.capabilities;
  return capabilities?.[REQUIRED_CAPABILITY] === true
    ? "AUTHORIZED"
    : "FORBIDDEN";
}
