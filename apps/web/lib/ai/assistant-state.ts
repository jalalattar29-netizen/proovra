/**
 * WHAT THE ASSISTANT SHOULD SAY WHEN IT CANNOT ANSWER.
 *
 * =============================================================================
 * THE DEFECT THIS REPLACES
 * =============================================================================
 * The panel used to decide its own state like this:
 *
 *     const unavailableReason =
 *       apiError?.code === "AI_DISABLED" ||
 *       apiError?.statusCode === 404 || 503 || 502 || 504;
 *     if (unavailableReason) setError("AI assistant unavailable.");
 *     else setError("AI assistant currently unavailable. Continue without AI.");
 *
 * Two things were wrong with that, and both were user-visible.
 *
 * `AI_DISABLED` is a code no route emits — not in this repository, not in any
 * shape. The one branch meant to recognise a deliberate shutdown could never
 * match, so a deliberate shutdown fell to the `else`.
 *
 * And the `else` said "currently unavailable" to EVERYTHING it did not
 * recognise: a workspace that had switched the assistant off, a plan that
 * never included it, a role not permitted to use it, a rate limit, a spent
 * budget, an expired session. All of these are true statements about a working
 * system, and all of them were reported as a malfunction. A workspace owner
 * who turned AI off was told their product was broken.
 *
 * =============================================================================
 * WHY A PURE MODULE
 * =============================================================================
 * This is the whole reason the old mapping went unchallenged: it lived inside
 * a `catch` block in a rendering component, where the only way to test it was
 * to render the component and provoke a network failure. Nobody did. As a pure
 * function from an error to a state, every branch is one assertion.
 *
 * =============================================================================
 * THE RULE FOR THE COPY
 * =============================================================================
 * Each state says what is true, then what the reader can do. It never says
 * "unavailable" for something that is working as configured, never blames the
 * reader for a platform decision, and never invites a retry that is certain to
 * fail — a plan entitlement does not change because a button was pressed
 * again.
 *
 * No state suggests the reader change configuration they may not own, and none
 * repeats operator prose from the server: `reason` on a policy decision is
 * written for logs and can name internals, so the UI maps the bounded
 * `decision` enum to its own words instead.
 */

/** Bounded reasons the assistant can be unable to answer. */
export type AssistantStateKind =
  | "READY"
  | "POLICY_DISABLED"
  | "ROLE_NOT_PERMITTED"
  | "NOT_AVAILABLE_FOR_PLAN"
  | "RATE_LIMITED"
  | "COST_GUARD"
  | "TEMPORARILY_UNAVAILABLE"
  | "PROVIDER_TIMEOUT"
  | "PROVIDER_ERROR"
  | "CONFIGURATION_ERROR"
  | "SAFETY_BLOCKED"
  | "INVALID_REQUEST"
  | "SESSION_EXPIRED"
  | "SENSITIVE_ROUTE"
  | "UNKNOWN_ERROR";

export type AssistantState = {
  kind: AssistantStateKind;
  /** Short line naming the situation. Never "unavailable" unless it is. */
  title: string;
  /** What it means and what still works. One or two sentences. */
  body: string;
  /**
   * Whether the composer stays usable.
   *
   * False only where a further question CANNOT be served: the platform will
   * refuse it identically every time. A rate limit leaves this true — the
   * limit expires — while a plan entitlement does not.
   */
  canSend: boolean;
  /**
   * How the state should read. `notice` is a working system saying no;
   * `problem` is something that went wrong. The distinction is the point of
   * this module, so it is carried explicitly rather than inferred from copy.
   */
  tone: "notice" | "problem";
};

/** The shape the web transport produces for a failed request. */
export type AssistantErrorLike = {
  code?: string;
  statusCode?: number;
  details?: Record<string, unknown> | undefined;
};

const READY: AssistantState = {
  kind: "READY",
  title: "",
  body: "",
  canSend: true,
  tone: "notice",
};

/**
 * Copy for each workspace-policy decision.
 *
 * The server sends a bounded enum precisely so this mapping can exist. Anything
 * not listed falls through to a conservative default rather than guessing.
 */
function fromPolicyDecision(decision: string): AssistantState {
  switch (decision) {
    case "WORKSPACE_DISABLED":
      return {
        kind: "POLICY_DISABLED",
        title: "The assistant is turned off for this workspace",
        body:
          "An owner or admin disabled AI here. Nothing else is affected — capture, reports, verification and packages work exactly as normal.",
        canSend: false,
        tone: "notice",
      };
    case "FEATURE_DISABLED":
      return {
        kind: "POLICY_DISABLED",
        title: "Assistant chat is turned off for this workspace",
        body:
          "AI is enabled here, but the support assistant specifically is switched off in the workspace AI policy.",
        canSend: false,
        tone: "notice",
      };
    case "ROLE_NOT_PERMITTED":
      return {
        kind: "ROLE_NOT_PERMITTED",
        title: "Your role cannot use the assistant",
        body:
          "This workspace limits the assistant to certain roles. An owner or admin can change which roles are permitted.",
        canSend: false,
        tone: "notice",
      };
    case "PLAN_NOT_ENTITLED":
      return {
        kind: "NOT_AVAILABLE_FOR_PLAN",
        title: "Not included in this plan",
        body:
          "The assistant is not part of the current plan. Everything else on your plan is unaffected.",
        canSend: false,
        tone: "notice",
      };
    case "DATA_CLASS_NOT_ALLOWED":
      return {
        kind: "POLICY_DISABLED",
        title: "This workspace does not allow sending this kind of data",
        body:
          "The workspace AI policy restricts what may be sent to a provider, and this request falls outside it.",
        canSend: false,
        tone: "notice",
      };
    case "GLOBAL_DISABLED":
    case "PROVIDER_NOT_CONFIGURED":
      /*
       * An operator configuration gap, NOT a workspace decision — and the one
       * case where the assistant is not fully out of action. The server still
       * answers questions about the product itself from knowledge compiled
       * into the build, so the composer stays open; only questions needing a
       * model come back unanswered.
       */
      return {
        kind: "CONFIGURATION_ERROR",
        title: "AI responses are switched off on this deployment",
        body:
          "Questions about how PROOVRA works are still answered. Anything needing the AI model is unavailable until an administrator enables it.",
        canSend: true,
        tone: "notice",
      };
    default:
      return {
        kind: "POLICY_DISABLED",
        title: "The assistant is not available here",
        body:
          "A workspace policy prevents the assistant from answering. Evidence workflows are unaffected.",
        canSend: false,
        tone: "notice",
      };
  }
}

/**
 * Classify a failed chat request.
 *
 * Order matters: a specific code beats a status class, because several
 * distinct situations share a status. Three different 429s mean three
 * different things to the reader — slow down, the workspace's monthly
 * allowance is spent, the budget is spent — and only the code separates them.
 */
export function classifyAssistantError(err: AssistantErrorLike): AssistantState {
  const code = err.code ?? "";
  const status = err.statusCode ?? 0;
  const decision =
    typeof err.details?.["decision"] === "string"
      ? (err.details["decision"] as string)
      : "";

  if (code === "AI_WORKSPACE_POLICY_DENIED") {
    return fromPolicyDecision(decision);
  }

  if (code === "AI_CHAT_RATE_LIMITED") {
    return {
      kind: "RATE_LIMITED",
      title: "Too many questions at once",
      body: "Wait a moment and ask again. This limit resets on its own.",
      canSend: true,
      tone: "notice",
    };
  }

  /*
   * NOT INCLUDED is not EXHAUSTED, and this is the branch that used to
   * conflate them.
   *
   * A plan with no AI allowance threw `AI_MONTHLY_LIMIT_REACHED`, so a FREE
   * account's very first message — before any usage existed — was answered
   * with "This workspace has used its AI allowance". The API now sends
   * `AI_NOT_INCLUDED` (402) for a capability the plan does not carry, and
   * keeps `AI_MONTHLY_LIMIT_REACHED` (429) for one that is genuinely spent.
   */
  if (code === "AI_NOT_INCLUDED") {
    return {
      kind: "NOT_AVAILABLE_FOR_PLAN",
      title: "Not included in this plan",
      body:
        "AI assistance is not part of your current plan. Capture, custody, verification and reporting are fully available without it.",
      canSend: false,
      tone: "notice",
    };
  }

  if (code === "AI_MONTHLY_LIMIT_REACHED" || code.startsWith("AI_BUDGET_")) {
    return {
      kind: "COST_GUARD",
      title: "This workspace has used its AI allowance",
      body:
        "The monthly limit for AI requests has been reached. It resets with the next billing period; capture, reports and verification are unaffected.",
      canSend: false,
      tone: "notice",
    };
  }

  if (code === "AI_CHAT_TIMEOUT" || status === 504) {
    return {
      kind: "PROVIDER_TIMEOUT",
      title: "The assistant took too long to answer",
      body: "Ask again. Nothing else was affected — evidence workflows never wait on AI.",
      canSend: true,
      tone: "problem",
    };
  }

  if (status === 401) {
    return {
      kind: "SESSION_EXPIRED",
      title: "Your session has expired",
      body: "Sign in again to continue using the assistant.",
      canSend: false,
      tone: "notice",
    };
  }

  if (status === 400 || status === 422) {
    return {
      kind: "INVALID_REQUEST",
      title: "That question could not be sent",
      body: "Try rewording it, or shortening it if it was very long.",
      canSend: true,
      tone: "problem",
    };
  }

  if (status === 502 || status === 503 || status === 404) {
    return {
      kind: "TEMPORARILY_UNAVAILABLE",
      title: "The assistant is temporarily unreachable",
      body: "This is a problem on our side. Try again shortly; nothing else is affected.",
      canSend: true,
      tone: "problem",
    };
  }

  if (status >= 500) {
    return {
      kind: "PROVIDER_ERROR",
      title: "The assistant could not complete that",
      body: "Something went wrong answering. Try again; evidence workflows are unaffected.",
      canSend: true,
      tone: "problem",
    };
  }

  return {
    kind: "UNKNOWN_ERROR",
    title: "The assistant could not answer",
    body: "Something unexpected happened. Try again, or continue without AI — nothing else is affected.",
    canSend: true,
    tone: "problem",
  };
}

/**
 * Classify a SUCCESSFUL response whose payload reports a non-answer.
 *
 * A 200 is not proof of an answer. The provider layer catches its own failures
 * and reports them in the body as `status: "error"`, and the cost guard and
 * scope classifier report refusals the same way — so a panel that only
 * inspected HTTP status would render an apology as though it were advice.
 */
export function classifyAssistantResult(
  status: "ok" | "blocked" | "disabled" | "error",
): AssistantState {
  switch (status) {
    case "ok":
      return READY;
    case "blocked":
      return {
        kind: "SAFETY_BLOCKED",
        title: "The assistant cannot answer that",
        body:
          "PROOVRA's assistant answers questions about using the product. It does not judge whether evidence is authentic, identify people, or give legal advice.",
        canSend: true,
        tone: "notice",
      };
    case "disabled":
      return {
        kind: "CONFIGURATION_ERROR",
        title: "AI responses are switched off on this deployment",
        body:
          "Questions about how PROOVRA works are still answered. Anything needing the AI model is unavailable until an administrator enables it.",
        canSend: true,
        tone: "notice",
      };
    case "error":
    default:
      return {
        kind: "PROVIDER_ERROR",
        title: "The assistant could not complete that",
        body: "Something went wrong answering. Try again; evidence workflows are unaffected.",
        canSend: true,
        tone: "problem",
      };
  }
}

/** The state for a route the widget must never send from. */
export const SENSITIVE_ROUTE_STATE: AssistantState = {
  kind: "SENSITIVE_ROUTE",
  title: "The assistant is off on this page",
  body:
    "This screen can show sensitive material, so nothing from it is sent to the assistant. It works normally elsewhere.",
  canSend: false,
  tone: "notice",
};

export const READY_STATE = READY;
