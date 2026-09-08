/**
 * THE ONE PLACE THE ADMIN CONSOLE DECIDES WHAT A READ IS DOING.
 *
 * ===========================================================================
 * WHY THIS EXISTS
 * ===========================================================================
 * Ten admin surfaces stored a failed read as the same value a successful empty
 * read produces — `null`, or an empty array — and then rendered both through
 * one branch. The branch they shared was the EmptyState, whose copy asserts
 * absence:
 *
 *     "…right now there are none."                       /admin/alerts
 *     "…an empty table means nothing is currently open"   /admin/operations
 *     "No customers yet…"                                 /admin/customers
 *
 * Measured against a live aborted read, all three of those sentences were on
 * screen. The only signal that anything had failed was a toast that had already
 * gone.
 *
 * The fix is not ten more `error` booleans. It is one taxonomy, one classifier
 * and one rendered surface, so that "the read failed" cannot be spelled the
 * same way as "the server said there is nothing".
 *
 * ===========================================================================
 * WHY THE COPY LIVES HERE TOO
 * ===========================================================================
 * The browser test that proves a failed read does NOT render the empty claim
 * has to know what the empty claim is. If the test spells it out itself, the
 * test is asserting a phrase its author invented, and it passes for as long as
 * the author's memory happens to match the product — which is exactly how the
 * assertion this replaces came to be structurally unfailable.
 *
 * So the empty-state sentences are constants HERE, the pages render them from
 * here, and `admin-states.spec.ts` imports the same constants. There is one
 * authority for the words, and the test cannot drift from the product.
 */

/**
 * Every state an admin read can actually be in.
 *
 * Not every surface can reach every state — a platform-wide aggregate has no
 * plan gate — but a state a surface CAN reach must be represented explicitly
 * rather than collapsed into a neighbour.
 */
export type AdminReadState =
  | "IDLE"
  | "LOADING"
  | "SUCCESS_POPULATED"
  | "SUCCESS_EMPTY"
  | "FAILURE"
  | "PARTIAL"
  | "STALE"
  | "REFUSED"
  | "PLAN_GATED"
  | "STEP_UP_REQUIRED";

/**
 * Why a read did not produce data.
 *
 * `denied`, `plan` and `step-up` are REFUSALS: the platform understood the
 * request and declined it. Retrying them changes nothing, so the surface must
 * not offer a Retry that will fail identically. `error` and `unavailable` are
 * failures, and those are worth retrying.
 */
export type AdminReadFailureKind =
  | "error"
  | "denied"
  | "plan"
  | "step-up"
  | "unavailable";

export type AdminReadFailure = {
  kind: AdminReadFailureKind;
  /** One operator-safe sentence. Never a raw error message. */
  message: string;
  /** False for refusals — a repeat of the same request returns the same answer. */
  retryable: boolean;
};

/** Maps a failure onto the state vocabulary above. */
export function failureToState(f: AdminReadFailure): AdminReadState {
  if (f.kind === "denied") return "REFUSED";
  if (f.kind === "plan") return "PLAN_GATED";
  if (f.kind === "step-up") return "STEP_UP_REQUIRED";
  return "FAILURE";
}

/**
 * CLASSIFY, DO NOT PASS THROUGH.
 *
 * `toSafeUserError` is the sanctioned display path for an error message and
 * this defers to it for the `error` case. What it adds is the distinction the
 * pages were missing: a 403 is not an outage, and telling an operator to retry
 * a refusal sends them round a loop.
 *
 * The `fallback` is the page's own sentence for "we could not read this",
 * used when the error carries nothing safe to show.
 */
export function classifyAdminReadFailure(
  err: unknown,
  fallback: string,
  toSafeMessage: (e: unknown, opts: { message: string }) => { message: string },
): AdminReadFailure {
  const e = err as { statusCode?: number; code?: string; body?: unknown };
  const status = typeof e?.statusCode === "number" ? e.statusCode : 0;
  const code = typeof e?.code === "string" ? e.code : "";

  if (code === "STEP_UP_REQUIRED" || status === 428) {
    return {
      kind: "step-up",
      message:
        "This read needs a fresh identity check. Confirm your identity and open it again.",
      retryable: false,
    };
  }
  if (status === 402 || code === "enterprise_feature_required") {
    return {
      kind: "plan",
      message:
        "This workspace's plan does not include this surface, so there is nothing to read here.",
      retryable: false,
    };
  }
  if (status === 403 || status === 404) {
    return {
      kind: "denied",
      message:
        "Your account does not hold the platform scope this surface reads. Nothing is failing — ask a platform administrator for the scope.",
      retryable: false,
    };
  }
  return {
    kind: "error",
    message: toSafeMessage(err, { message: fallback }).message,
    retryable: true,
  };
}

/**
 * THE EMPTY-STATE CLAIM EACH SURFACE MAKES WHEN THE SERVER SUCCEEDS.
 *
 * These are the sentences that must NEVER appear after a failed read. They are
 * exported so the pages render them and the browser test asserts their absence
 * from the same string.
 *
 * Keyed by route, because that is what the test iterates.
 */
export const ADMIN_EMPTY_COPY = {
  "/admin": {
    title: "No platform overview yet",
    body: "The platform overview aggregate returned no figures. As customers, workspaces and evidence records exist, they appear here.",
  },
  "/admin/alerts": {
    title: "No active alerts",
    body: "No alert-worthy platform signals are currently active. Open incidents, recent high/critical security events, failed jobs, failed payments, and SSO outages would appear here — right now there are none.",
  },
  "/admin/operations": {
    title: "No conditions match",
    body: "No operational condition matches the current filters. With the Status filter on Open, an empty table means nothing is currently open — not that nothing was measured.",
  },
  "/admin/executive": {
    title: "No executive figures yet",
    body: "The executive aggregate returned no figures. Once revenue, customers, leads and usage records exist, the honest platform KPIs appear here.",
  },
  "/admin/costs": {
    title: "No cost data",
    body: "The cost aggregate returned no figures. Once provider usage events exist, estimated costs, per-provider breakdown, budgets and embeddings spend appear here.",
  },
  "/admin/adoption": {
    title: "No adoption data",
    body: "Feature adoption is derived from live records. Once workspaces configure capabilities and capture evidence, each capability's real counts appear here. Nothing on this page is estimated.",
  },
  "/admin/customers": {
    title: "No customers yet",
    body: "Customer organizations appear here once they exist. This roster is read-only and reflects live records.",
  },
  "/admin/users": {
    title: "No people found",
    body: "No platform user matches the current filters. Adjust the search or filters above.",
  },
  "/admin/workspaces": {
    title: "No workspaces match",
    body: "No workspace matches the current filters. Adjust the search or filters above — the Lifecycle filter defaults to Live, so closed workspaces are hidden unless you ask for them.",
  },
  "/admin/timeline": {
    title: "No platform events",
    body: "No platform-operational events match the current filters. As admin actions, organization lifecycle events, security events, incidents, or billing/team events are recorded, they appear here — evidence custody events are never included.",
  },
  "/admin/contact-sales": {
    title: "No contact-sales inquiries yet",
    body: "New enquiries from the public site appear here as they are submitted.",
  },
} as const;

export type AdminEmptyCopyRoute = keyof typeof ADMIN_EMPTY_COPY;

/**
 * THE FALLBACK SENTENCE EACH SURFACE USES WHEN ITS READ FAILS.
 *
 * Deliberately parallel to `ADMIN_EMPTY_COPY` so the two can be compared, and
 * so a reviewer can see at a glance that no failure sentence claims absence.
 */
export const ADMIN_FAILURE_COPY = {
  "/admin/contact-sales":
    "The contact-sales list could not be read. This is not an empty pipeline — enquiries may exist that this console cannot see right now.",
  "/admin": "The platform overview could not be loaded. This is a not-connected state, not an empty platform.",
  "/admin/alerts":
    "The alert list could not be read. This is not an all-clear — the platform may have active signals this console cannot see right now.",
  "/admin/operations":
    "Open conditions could not be read. This is not an all-clear — the platform may have open conditions this console cannot see right now.",
  "/admin/executive": "The executive aggregate could not be loaded. This is a not-connected state, not an empty platform.",
  "/admin/costs": "The cost aggregate could not be loaded. This is a not-connected state, not an unspent platform.",
  "/admin/adoption": "The adoption report could not be loaded. This is a not-connected state, not an unused platform.",
  "/admin/customers": "The customer roster could not be read. This is a not-connected state, not an empty roster.",
  "/admin/users": "The people directory could not be read. This is a not-connected state, and it is not a statement about your filters.",
  "/admin/workspaces": "The workspace inventory could not be read. This is a not-connected state, and it is not a statement about your filters.",
  "/admin/timeline": "The platform timeline could not be read. This is a not-connected state, not a quiet platform.",
  "/admin/dashboard": "The analytics bundle could not be loaded. This is a not-connected state, not an unvisited platform.",
} as const;
