/**
 * THE SERVER-SIDE BOUNDARY FOR RUNBOOK CONTENT.
 *
 * =============================================================================
 * WHAT WENT WRONG
 * =============================================================================
 * `/admin/platform/runbooks/[slug]` is a server component that resolved the
 * runbook and rendered its body as children of `<PageRouteGate>`. That gate is
 * a `"use client"` component: it decides what a BROWSER paints after hydration.
 * It never ran for anything that did not execute JavaScript.
 *
 * The body was therefore already in the payload by the time the gate had an
 * opinion. `curl` with no credentials received HTTP 200 and the full procedure
 * — internal env var names, `services/api/src/...` paths, audit-chain
 * internals — for all 33 runbooks. A client-side gate is a UX affordance. It
 * is not an authorization boundary, and it cannot become one.
 *
 * =============================================================================
 * WHAT THIS DOES
 * =============================================================================
 * Resolves, on the server, whether the caller may read runbook content, using
 * the same capability the route registry declares (`RUNBOOKS_VIEW`) and the
 * same authority every other surface reads (the platform-context envelope).
 * The page calls this BEFORE it touches the catalog, so an unauthorized
 * response is not a hidden body — there is no body in it.
 *
 * Reading `cookies()` also opts the route out of static prerendering, which is
 * the second half of the fix: a statically generated HTML file cannot be
 * authorized per request, because it is written once at build time and handed
 * to whoever asks.
 *
 * =============================================================================
 * WHY IT FAILS CLOSED
 * =============================================================================
 * Every path that is not an explicit `RUNBOOKS_VIEW === true` returns a denial,
 * including a network error, a non-JSON body, and a 5xx from the API. A
 * content boundary that opens when its authority is unreachable is not a
 * boundary. The cost of failing closed here is that an admin sees a denial
 * during an API outage; the cost of failing open is publishing the runbooks.
 */

import { cookies } from "next/headers";
import { cache } from "react";

import { apiBaseUrl } from "../api";

export type RunbookAccess = "AUTHORIZED" | "UNAUTHENTICATED" | "FORBIDDEN";

/** The capability the route registry declares for `platform.runbook_document`. */
const REQUIRED_CAPABILITY = "RUNBOOKS_VIEW";

/**
 * Per-request memo. A page may ask more than once (metadata and body); the
 * boundary must not become a per-render API call. `cache` is request-scoped,
 * so one user's answer can never be handed to another.
 */
export const resolveRunbookAccess = cache(async (): Promise<RunbookAccess> => {
  const session = (await cookies()).get("proovra_session")?.value;
  if (!session) return "UNAUTHENTICATED";

  let res: Response;
  try {
    res = await fetch(`${apiBaseUrl()}/v1/platform/context`, {
      headers: { authorization: `Bearer ${session}` },
      // Never reuse another request's authorization answer.
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
});
