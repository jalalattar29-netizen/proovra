/**
 * PROOVRA Feedback System — central API/backend error sanitization.
 *
 * The ONE place that turns any thrown error (ApiError, generic API error,
 * network failure, DOMException, unknown) into user-safe feedback.
 *
 * Guarantees:
 *   - NEVER returns a raw backend `message`, SQL/Prisma/service text,
 *     stack trace, or raw enum code as the user-facing string.
 *   - Maps known error codes / HTTP statuses to calm, actionable copy
 *     answering: what happened · is data safe · what to do next.
 *   - Surfaces the requestId/trace id ONLY as `supportReference`
 *     (rendered by ProovraSupportReference with a Copy button) — never
 *     inline inside the sentence.
 */

export type SafeErrorSeverity = "error" | "warning" | "info";

export interface SafeUserError {
  title: string;
  message: string;
  severity: SafeErrorSeverity;
  actionLabel?: string;
  actionHref?: string;
  /** Internal trace/request id — display ONLY via ProovraSupportReference. */
  supportReference?: string;
}

interface ErrorLike {
  code?: unknown;
  statusCode?: unknown;
  status?: unknown;
  requestId?: unknown;
  name?: unknown;
}

function readString(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

function readStatus(e: ErrorLike): number | undefined {
  const s = typeof e.statusCode === "number" ? e.statusCode : e.status;
  return typeof s === "number" ? s : undefined;
}

/**
 * Known error codes → safe copy. Codes are matched case-insensitively.
 * Anything NOT in this table falls back to status-code buckets, so a
 * novel backend code can never leak as raw text.
 */
const CODE_MAP: Record<
  string,
  Omit<SafeUserError, "supportReference">
> = {
  /**
   * The server refused to mark an operational condition resolved because its
   * own source still reports it as failing.
   *
   * Given its own entry rather than falling through to the generic 409,
   * because the generic message ("something has changed, try again") is wrong
   * here in a way that matters: nothing has changed, retrying will not help,
   * and there are exactly two things the operator can do instead. Saying them
   * is the difference between a refusal and a dead end.
   */
  CONDITION_STILL_ACTIVE: {
    title: "This condition is still active",
    message:
      "This condition is still active. Complete the remediation or suppress it with a recorded reason.",
    severity: "warning",
  },
  /**
   * The probe could not READ the source, so the server does not know whether
   * the condition is over.
   *
   * A separate entry from the one above, and the separation is the whole
   * point. "Still active" is an assertion; this is an admission, and telling
   * an operator their condition is still failing when the platform simply
   * could not check would be inventing a fact to avoid an awkward sentence.
   *
   * No provider name, no database identifier, no stack. The operator learns
   * exactly two things: nothing was changed, and checking again later is the
   * next step.
   */
  CONDITION_ACTIVITY_UNKNOWN: {
    title: "Condition status could not be verified",
    message:
      "PROOVRA could not confirm that the underlying condition has recovered. No status was changed. Check again after the source becomes available.",
    severity: "warning",
  },
  /**
   * The condition's source declares that nobody may close it directly.
   *
   * Reached only from a stale tab or a direct API call — the queue offers no
   * Resolve control for these — so the message explains the rule rather than
   * suggesting a retry that would be refused identically.
   */
  CONDITION_NOT_DIRECTLY_RESOLVABLE: {
    title: "This condition cannot be resolved here",
    message:
      "This condition is owned by the surface that reported it and closes when that surface recovers. You can still acknowledge it, assign it, or suppress it with a recorded reason.",
    severity: "warning",
  },
  /**
   * A SIGN-IN ATTEMPT FAILED — which is not the same thing as a session
   * expiring, and `UNAUTHORIZED` below says the second one.
   *
   * Both are 401, so before this entry existed a wrong password on the sign-in
   * page fell into the status bucket and told the person their session had
   * expired and they should sign in again. They were signing in. That is the
   * defect this closes.
   *
   * The copy names neither field on purpose. The API answers unknown-email and
   * wrong-password with one identical response so that nobody can use the form
   * to discover which addresses are registered; saying "that email isn't
   * registered" here would hand back exactly what the API refuses to say.
   */
  INVALID_CREDENTIALS: {
    title: "Email or password is incorrect",
    message:
      "Check the email address and password and try again. If you have forgotten your password, you can reset it.",
    severity: "warning",
  },
  UNAUTHORIZED: {
    title: "Please sign in again",
    message: "Your session may have expired. Sign in again to continue — your evidence data has not been changed.",
    severity: "warning",
    actionLabel: "Sign in",
    actionHref: "/login",
  },
  SESSION_EXPIRED: {
    title: "Your session expired",
    message: "For your security you've been signed out. Sign in again to continue.",
    severity: "warning",
    actionLabel: "Sign in",
    actionHref: "/login",
  },
  FORBIDDEN: {
    title: "You don't have access to this area",
    message: "This workspace or feature may require additional permissions. Ask a workspace admin for access, or return to the dashboard.",
    severity: "warning",
  },
  ACCESS_DENIED: {
    title: "You don't have access to this area",
    message: "This workspace or feature may require additional permissions. Ask a workspace admin for access, or return to the dashboard.",
    severity: "warning",
  },
  NOT_FOUND: {
    title: "We couldn't find that",
    message: "The item may have moved or is no longer available. Refresh and try again.",
    severity: "info",
  },
  RATE_LIMITED: {
    title: "Too many requests",
    message: "Please wait a moment and try again.",
    severity: "warning",
  },
  EMAIL_NOT_VERIFIED: {
    title: "Verify your email address",
    message: "Please verify your email address before continuing. Check your inbox for the activation link.",
    severity: "info",
  },
  TEAM_PLAN_REQUIRED: {
    title: "Teams aren't included in your plan",
    message: "Teams are available on Pro, Team, and Enterprise plans.",
    severity: "warning",
    actionLabel: "View billing",
    actionHref: "/billing",
  },
  TEAM_LIMIT_REACHED: {
    title: "Team limit reached",
    message: "Your plan's Team limit has been reached. Upgrade to create another Team.",
    severity: "warning",
    actionLabel: "View billing",
    actionHref: "/billing",
  },
  TEAM_MEMBER_LIMIT_REACHED: {
    title: "This Team is at capacity",
    message: "This Team has reached the member limit for the owner's plan. Free a seat or upgrade to add more members.",
    severity: "warning",
    actionLabel: "View billing",
    actionHref: "/billing",
  },
  TEAM_INVITE_LIMIT_REACHED: {
    title: "Invite limit reached",
    message: "This Team has reached its invitation limit for now. Revoke a pending invite, wait for the window to reset, or upgrade your plan.",
    severity: "warning",
    actionLabel: "View billing",
    actionHref: "/billing",
  },
  TEAM_INVITES_NOT_INCLUDED: {
    title: "Invitations aren't included in the current plan",
    message: "The Team owner's current plan no longer supports this invitation.",
    severity: "warning",
    actionLabel: "View billing",
    actionHref: "/billing",
  },
  SUBSCRIPTION_INACTIVE: {
    title: "Subscription inactive",
    message: "Your subscription is not currently active. Update billing to manage Teams.",
    severity: "warning",
    actionLabel: "View billing",
    actionHref: "/billing",
  },
  STORAGE_LIMIT_REACHED: {
    title: "Storage limit reached",
    message: "Add storage or upgrade your plan to keep preserving evidence. Your existing records remain available.",
    severity: "warning",
    actionLabel: "View plans",
    actionHref: "/billing",
  },
  ENTITLEMENT_REQUIRED: {
    title: "This action isn't available on your plan",
    message: "This capability requires a higher plan or additional permissions. Review plans or ask an admin.",
    severity: "warning",
    actionLabel: "View plans",
    actionHref: "/billing",
  },
  /**
   * The canonical zod rejection from the API's global error handler. It ships a
   * bounded `fields[]` array, which `fieldErrorsFromApiError` unpacks for
   * inline placement; this copy is what a surface shows when it has nowhere to
   * put a per-field message.
   */
  INVALID_INPUT: {
    title: "Please check the highlighted fields",
    message: "Some details need attention before we can continue.",
    severity: "warning",
  },
  VALIDATION_ERROR: {
    title: "Please check the highlighted fields",
    message: "Some details need attention before we can continue.",
    severity: "warning",
  },
  /*
   * The same answer under the other names the API uses for a rejected input.
   * They are aliases, not distinctions, and each was previously answered by
   * the 400 bucket with wording that read like a server fault.
   */
  INVALID_REQUEST: {
    title: "Please check the highlighted fields",
    message: "Some details need attention before we can continue.",
    severity: "warning",
  },
  INVALID_BODY: {
    title: "Please check the highlighted fields",
    message: "Some details need attention before we can continue.",
    severity: "warning",
  },
  INVALID_QUERY: {
    title: "That search couldn't be run",
    message: "Adjust the filters or the search term and try again.",
    severity: "warning",
  },
  INVALID_IDENTIFIER: {
    title: "That reference isn't valid",
    message:
      "The link or identifier is malformed. Open the item from the list rather than from a copied address.",
    severity: "warning",
  },
  INVALID_ORG_ID: {
    title: "That organization reference isn't valid",
    message: "Open the organization from your workspace switcher and try again.",
    severity: "warning",
  },
  INVALID_WORKSPACE_ID: {
    title: "That workspace reference isn't valid",
    message: "Open the workspace from your workspace switcher and try again.",
    severity: "warning",
  },
  /*
   * ---------------------------------------------------------------------
   * BOUNDED DOMAIN REFUSALS
   *
   * Every entry below is a decision the server made deliberately and can
   * explain. Each was previously answered by an HTTP-status bucket — "please
   * review your input and try again" for a record that is simply not finalized
   * yet, which is neither true nor actionable. The copy is derived from the
   * server's semantics; none of it repeats the server's own string, and none
   * of it names a provider, a key, a table or a seed script.
   * ---------------------------------------------------------------------
   */
  INSUFFICIENT_CREDITS: {
    title: "Not enough credits",
    message:
      "This action needs more credits than your workspace has left. Add credits or upgrade to continue — nothing was charged.",
    severity: "warning",
    actionLabel: "View billing",
    actionHref: "/billing",
  },
  EVIDENCE_LOCKED: {
    title: "This record is locked",
    message:
      "The record has been sealed and can no longer be edited. You can still view, verify and export it.",
    severity: "info",
  },
  EVIDENCE_NOT_FINALIZED: {
    title: "This record isn't finalized yet",
    message:
      "Verification becomes available once the record has been finalized. Finish the capture, then try again.",
    severity: "info",
  },
  EVIDENCE_NOT_LOCKED: {
    title: "This record isn't locked",
    message: "That action is only available on a record that has been sealed.",
    severity: "info",
  },
  FINALIZE_BLOCKED_BY_UPLOAD_SESSION: {
    title: "Upload still being verified",
    message:
      "This record can't be finalized until every uploaded file has been checked against its recorded fingerprint. That usually takes a moment — try again shortly.",
    severity: "info",
  },
  EVIDENCE_INTEGRITY_FAILED: {
    title: "This record's fingerprint no longer matches",
    message:
      "The stored material does not match the fingerprint recorded when the record was completed, so it cannot be regenerated. Capture or upload the material again as a new record. The existing record has not been altered.",
    severity: "error",
  },
  VERIFICATION_TEMPORARILY_UNAVAILABLE: {
    title: "Verification is temporarily unavailable",
    message:
      "Please try again in a few minutes. Your evidence data has not been changed.",
    severity: "warning",
  },
  VERIFICATION_POLICY_BLOCKED: {
    title: "Publishing is blocked by workspace policy",
    message:
      "Your workspace's verification policy does not allow this record to be published yet. A workspace admin can review the policy.",
    severity: "warning",
  },
  SIGNING_KEY_MISSING: {
    /*
     * A server-side configuration fault, not something the person can fix. The
     * server's own message tells an operator to re-run a seed script; that
     * sentence must never reach a customer, so this entry exists precisely to
     * replace it.
     */
    title: "This record can't be signed right now",
    message:
      "A signing problem is preventing this action. Your evidence data has not been changed. Please contact support with the reference below.",
    severity: "error",
  },
  FEATURE_DISABLED: {
    title: "This feature is turned off",
    message:
      "This capability is not currently enabled for your workspace. A workspace admin can turn it on.",
    severity: "info",
  },
  STEP_UP_REQUIRED: {
    title: "Confirm your identity to continue",
    message:
      "This action needs a second factor. Confirm your identity and try again — nothing has been changed yet.",
    severity: "warning",
  },
  STEP_UP_ENROLLMENT_REQUIRED: {
    title: "Set up two-factor authentication first",
    message:
      "This action requires two-factor authentication. Add a second factor in Security settings, then try again.",
    severity: "warning",
    actionLabel: "Security settings",
    actionHref: "/settings/security",
  },
  HIGH_RISK_ACTION_BLOCKED: {
    title: "This action was blocked",
    message:
      "Your workspace's security rules blocked this action. Nothing has been changed. A workspace admin can review the rules.",
    severity: "warning",
  },
  GOVERNANCE_BLOCKED: {
    title: "Blocked by workspace governance",
    message:
      "A governance rule in this workspace prevents this action. Nothing has been changed. A workspace admin can review the policy.",
    severity: "warning",
  },
  WORKSPACE_CONTEXT_REQUIRED: {
    title: "Choose a workspace first",
    message: "Select a workspace, then try this action again.",
    severity: "info",
  },
  WORKSPACE_MEMBERSHIP_REQUIRED: {
    title: "You're not a member of this workspace",
    message:
      "Ask a workspace admin to add you, or switch to a workspace you belong to.",
    severity: "warning",
  },
  WORKSPACE_CREATION_NOT_SELF_SERVICE: {
    title: "Workspaces aren't self-service on this plan",
    message:
      "Your organization creates workspaces centrally. Ask an organization admin to set one up.",
    severity: "info",
  },
  STALE_MEMBERSHIP_GENERATION: {
    title: "Your access changed while you were working",
    message:
      "Your membership was updated in another session. Refresh the page to pick up the change — nothing has been changed here.",
    severity: "warning",
  },
  SUBSCRIPTION_NOT_FOUND: {
    title: "No active subscription",
    message: "There's no subscription on this account to change yet.",
    severity: "info",
    actionLabel: "View plans",
    actionHref: "/billing",
  },
  SUBSCRIPTION_ALREADY_ACTIVE: {
    title: "This plan is already active",
    message: "No change was needed — your subscription is already on this plan.",
    severity: "info",
  },
  CHECKOUT_REQUIRED: {
    title: "Finish checkout to continue",
    message: "This change needs to go through checkout before it takes effect.",
    severity: "info",
    actionLabel: "View billing",
    actionHref: "/billing",
  },
  CANCELLATION_REQUIRED: {
    title: "Cancel the current plan first",
    message:
      "This change can't be applied while the current plan is still running. Cancel it first, then try again.",
    severity: "info",
    actionLabel: "View billing",
    actionHref: "/billing",
  },
  PROVIDER_CANCELLATION_FAILED: {
    title: "The cancellation didn't go through",
    message:
      "We couldn't complete the cancellation with the payment provider. Nothing was changed and you have not been charged again. Please try again in a moment.",
    severity: "error",
    actionLabel: "View billing",
    actionHref: "/billing",
  },
  STORAGE_ADDON_NOT_FOUND: {
    title: "Storage add-on not found",
    message: "That storage add-on is no longer on this account.",
    severity: "info",
    actionLabel: "View billing",
    actionHref: "/billing",
  },
  STORAGE_ADDON_NOT_LINKED: {
    title: "Storage add-on isn't linked yet",
    message:
      "This add-on hasn't finished linking to your subscription. Try again shortly, or contact support if it persists.",
    severity: "warning",
    actionLabel: "View billing",
    actionHref: "/billing",
  },
  LEGACY_ONE_TIME_ADDON_NOT_CANCELLABLE: {
    title: "This purchase can't be cancelled",
    message:
      "One-time storage purchases don't renew, so there is nothing to cancel. The storage stays on your account.",
    severity: "info",
  },
  REVIEW_PERMISSION_DENIED: {
    title: "You're not a reviewer on this workspace",
    message:
      "Review actions are limited to members with a reviewer role. Ask a workspace admin if you need it.",
    severity: "warning",
  },
  REVIEW_ACTOR_BLOCKED: {
    title: "Your membership isn't active",
    message:
      "Review actions need an active membership in this workspace. Ask a workspace admin to restore it.",
    severity: "warning",
  },
  CASES_MANAGE_REQUIRED: {
    title: "You can't manage cases here",
    message:
      "Managing cases needs additional permissions in this workspace. Ask a workspace admin for access.",
    severity: "warning",
  },
  CASE_DELETE_DENIED: {
    title: "You can't delete this case",
    message:
      "Deleting a case needs additional permissions in this workspace. Ask a workspace admin, or archive it instead.",
    severity: "warning",
  },
  CASE_RENAME_DENIED: {
    title: "You can't rename this case",
    message:
      "Renaming a case needs additional permissions in this workspace. Ask a workspace admin for access.",
    severity: "warning",
  },
  ILLEGAL_MEMBERSHIP_TRANSITION: {
    title: "That membership change isn't possible",
    message:
      "This member's current state doesn't allow that change. Refresh the members list to see where they are now.",
    severity: "warning",
  },
  INTERNAL_MEMBER: {
    title: "This person is a workspace member",
    message:
      "Their access is managed on the Members page rather than as an external grant.",
    severity: "info",
  },
  OWNERSHIP_TRANSFER_REQUIRED: {
    title: "Transfer ownership first",
    message:
      "You're the owner of this organization. Transfer ownership to someone else, or close the organization, before leaving it.",
    severity: "warning",
  },
  TRANSFER_TARGET_REQUIRED: {
    title: "Re-assign their work first",
    message:
      "This member still owns evidence or cases here. Choose who should take them over, then remove the member.",
    severity: "warning",
  },
  INVALID_TRANSFER_TARGET: {
    title: "Choose a different person",
    message:
      "Ownership can't be transferred to the member being removed. Pick another active member.",
    severity: "warning",
  },
  HIGH_SECURITY_PREREQUISITES_UNMET: {
    title: "High-security mode isn't ready yet",
    message:
      "Some prerequisites for this organization aren't met. Review the outstanding items in Security settings, then activate again.",
    severity: "warning",
  },
  MFA_POLICY_VERSION_CONFLICT: {
    title: "The policy changed while you were editing",
    message:
      "Someone else saved a change to this workspace's two-factor policy. Reload to see the current settings, then reapply yours. Nothing you entered has been saved.",
    severity: "warning",
  },
  POLICY_NOT_PROVISIONED: {
    title: "This policy isn't available yet",
    message:
      "The security policy for this organization is still being set up. Try again in a moment.",
    severity: "warning",
  },
  CAPTURE_SESSION_NOT_EDITABLE: {
    title: "This capture is closed",
    message:
      "The capture session has already been completed, so it can no longer be changed. Start a new capture to add more.",
    severity: "info",
  },
  AI_CHAT_RATE_LIMITED: {
    title: "Too many assistant requests",
    message: "Wait a moment before asking again. Your evidence workflows are unaffected.",
    severity: "warning",
  },
  AI_CHAT_TIMEOUT: {
    title: "The assistant took too long",
    message:
      "No answer came back in time. Try asking again, or ask a shorter question. Your evidence workflows are unaffected.",
    severity: "warning",
  },
  AI_WORKSPACE_POLICY_DENIED: {
    /*
     * The server sends its own policy reason here. It is NOT repeated: a
     * workspace policy string is administrative configuration, and the person
     * being refused needs to know who can change it, not how it is worded.
     */
    title: "The assistant is restricted in this workspace",
    message:
      "Your workspace's AI policy doesn't allow this request. A workspace admin can review the policy.",
    severity: "warning",
  },
  NETWORK_ERROR: {
    title: "Connection problem",
    message: "We couldn't reach the service. Check your connection and try again — your evidence data has not been changed.",
    severity: "error",
  },
};

const GENERIC: Omit<SafeUserError, "supportReference"> = {
  title: "We couldn't complete that action",
  message: "Please try again. Your evidence data has not been changed. If the problem continues, contact support.",
  severity: "error",
};

function fromStatus(status: number): Omit<SafeUserError, "supportReference"> {
  if (status === 401) return CODE_MAP.UNAUTHORIZED;
  if (status === 403) return CODE_MAP.FORBIDDEN;
  if (status === 404) return CODE_MAP.NOT_FOUND;
  if (status === 429) return CODE_MAP.RATE_LIMITED;
  if (status === 408 || status === 0) return CODE_MAP.NETWORK_ERROR;
  if (status >= 500) {
    return {
      title: "The service is temporarily unavailable",
      message: "Please try again in a moment. Your evidence data has not been changed.",
      severity: "error",
    };
  }
  if (status >= 400) {
    return {
      title: "We couldn't complete that action",
      message: "Please review your input and try again.",
      severity: "warning",
    };
  }
  return GENERIC;
}

/**
 * Optional per-call context used ONLY when the error is otherwise
 * unmapped (no known code / status). Lets a call site preserve which
 * action failed ("We couldn't load the billing overview.") while still
 * never leaking a raw backend message and still mapping known codes.
 */
export interface SafeErrorFallback {
  title?: string;
  message?: string;
  severity?: SafeErrorSeverity;
}

/**
 * Convert ANY error into user-safe feedback. Pure + dependency-free so it
 * is safe to import anywhere (client or server).
 */
export function toSafeUserError(
  error: unknown,
  fallback?: SafeErrorFallback,
): SafeUserError {
  const e = (error && typeof error === "object" ? error : {}) as ErrorLike;
  const code = readString(e.code)?.toUpperCase();
  const status = readStatus(e);
  const supportReference = readString(e.requestId);

  let base: Omit<SafeUserError, "supportReference"> | undefined;
  if (code && CODE_MAP[code]) {
    base = CODE_MAP[code];
  } else if (typeof status === "number") {
    base = fromStatus(status);
  } else if (readString(e.name) === "TypeError") {
    // fetch() network failure surfaces as TypeError
    base = CODE_MAP.NETWORK_ERROR;
  } else if (fallback && (fallback.title || fallback.message)) {
    base = {
      title: fallback.title ?? GENERIC.title,
      message: fallback.message ?? GENERIC.message,
      severity: fallback.severity ?? "error",
    };
  } else {
    base = GENERIC;
  }

  return { ...base, supportReference };
}
