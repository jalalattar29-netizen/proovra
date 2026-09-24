/**
 * USER-FACING ERROR COPY — the ONE dictionary both clients read.
 *
 * A backend code is a fact about what the server refused. This is what the
 * PRODUCT says about it: what happened, whether the person's work is safe, and
 * what they can do next. It lives here, beside the acquisition vocabulary and
 * the legal versions, because the web app and the native app must not answer
 * the same refusal differently.
 *
 * WHY IT MOVED. The web held all of this and the native app held none of it.
 * Native classified by HTTP status alone, so a plan limit, a legal hold, an
 * organization-lifecycle refusal and a real permission problem all read "You
 * don't have access to this.", and every 409 — which is the shape of most
 * product refusals — read "Something went wrong. Please try again." about
 * something retrying could never fix.
 *
 * RULES THIS TABLE KEEPS
 *   * Never a raw backend string, a stack, a SQL fragment or an enum name.
 *   * Never an explanation the server did not establish. Where a refusal is
 *     deliberately opaque (anti-enumeration), the copy stays opaque.
 *   * A sentence a person can act on, or an honest statement that there is
 *     nothing to do.
 *
 * `action` is a WEB route. The native client ignores it and navigates its
 * own way; a field one client does not use is honest, where a second copy of
 * the sentences would not be.
 *
 * Codes are matched case-insensitively by the clients. Anything absent falls
 * through to that client's status buckets, so a novel code can never reach a
 * user as raw text.
 */

export type UserFacingErrorSeverity = "error" | "warning" | "info";

export interface UserFacingError {
  title: string;
  message: string;
  severity: UserFacingErrorSeverity;
  /** Web route label/destination. Native ignores both. */
  actionLabel?: string;
  actionHref?: string;
}

export const USER_FACING_ERRORS: Record<string, UserFacingError> = {
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
  /**
   * BATCH C — bounded domain refusals. Each was a bare `throw` answering 500
   * and paging critical; each now has a code and a sentence that says what to
   * do instead.
   */
  EVIDENCE_RELATIONSHIP_SELF_LINK: {
    title: "Choose a different record",
    message: "A record can't be linked to itself. Enter a different evidence record ID.",
    severity: "warning",
  },
  STEP_UP_WORKSPACE_REQUIRED: {
    title: "Join a workspace first",
    message:
      "Changing a verified domain needs a step-up confirmation, which is made in a workspace. Join a workspace in this organization, then try again.",
    severity: "warning",
  },
  LEGAL_POLICY_VERSION_NOT_CURRENT: {
    title: "Our policies were updated",
    message:
      "The policy versions on this page are no longer current. Reload the page and review the current versions before accepting.",
    severity: "warning",
  },
  CERTIFICATION_ALREADY_ATTESTED: {
    title: "Already signed",
    message: "This declaration was signed in the meantime. Reload the declarations; request a new one to sign again.",
    severity: "warning",
  },
  CERTIFICATION_STATEMENT_MISSING: {
    title: "No statement to sign",
    message: "A declaration needs the statement the signer will sign. Write the statement and try again.",
    severity: "warning",
  },
  CERTIFICATION_STATEMENT_CHANGED: {
    title: "The statement is not the one requested",
    message: "The statement shown is not the one recorded on the request. Reload the declarations and read the statement again before signing.",
    severity: "warning",
  },
  EXPORT_SNAPSHOT_CURSOR_INVALID: {
    title: "The list has changed",
    message: "This page of snapshots no longer matches your filters. Reload the list to start again from the first page.",
    severity: "warning",
  },
  PAYMENTS_UNAVAILABLE: {
    title: "Payments unavailable",
    message:
      "Payments are temporarily unavailable, and nothing was charged. Please try again later, or contact support if this continues.",
    severity: "warning",
  },
  WEBHOOK_ENDPOINT_URL_INVALID: {
    title: "Check the endpoint address",
    message: "The endpoint address must be a public https:// URL.",
    severity: "warning",
  },
  WEBHOOK_ENDPOINT_EVENTS_INVALID: {
    title: "Check the selected events",
    message: "Choose at least one event, and no more than the allowed number, for this endpoint.",
    severity: "warning",
  },
  WEBHOOK_ENDPOINT_EVENT_UNKNOWN: {
    title: "Unknown event",
    message: "One of the selected events is not available for webhooks. Remove it and try again.",
    severity: "warning",
  },
  SCIM_TOKEN_ROTATE_CONFLICT: {
    title: "The token changed",
    message: "This provisioning token was changed while it was being rotated. Refresh the list and try again.",
    severity: "warning",
  },
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
   * PV-OPS-001 — the fourth refusal the resolve path can give. An
   * operator-decided condition whose source requires a written conclusion was
   * posted without one. It used to fall through to the generic 409 sentence,
   * which told the operator to "review your input" without saying what input.
   */
  RESOLUTION_NOTE_REQUIRED: {
    title: "Add a conclusion to resolve this",
    message:
      "Resolving this condition is an operator decision and must record why. Write a short conclusion and resolve again. Nothing was changed.",
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
  /*
   * The legal corpus is PUBLIC, so this is not anti-enumeration: every slug it
   * serves is linked from the marketing site and the app. A 404 means exactly
   * what it says, and the recovery — follow a current link — is something only
   * this sentence can tell the reader.
   */
  LEGAL_DOCUMENT_NOT_FOUND: {
    title: "That document is not available",
    message:
      "This link may be out of date. Open the legal pages from the app or the website to reach the current version.",
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
  /*
   * A COLLABORATION TEAM'S LIFECYCLE REFUSAL.
   *
   * Every member, work, invitation, comment, guest and access-review mutation
   * on an archived team answers 409 with this code. The reason is always the
   * same sentence, so it is written here rather than trusted from the wire —
   * and it says what to DO, because "archived" alone leaves the operator
   * looking for a control they cannot find.
   */
  COLLABORATION_TEAM_ARCHIVED: {
    title: "This team is archived",
    message: "Reopen this team before making changes. Its history stays available either way.",
    severity: "warning",
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
  /**
   * THE RECORD ALLOWANCE, AS THE ACCOUNT HOLDER SEES IT.
   *
   * `assertWorkspaceAllowsEvidenceCreation` refuses a new evidence record
   * with one of these three codes and a 409 — the most ordinary commercial
   * outcome the product has. None of them was mapped, so all three fell to
   * the 400-bucket default: "We couldn't complete that action. Please review
   * your input and try again." There is nothing to review. The input was
   * fine, the plan is full, and the one sentence that would have said so was
   * on the wire the whole time.
   *
   * Three entries rather than one alias, because the audiences differ by a
   * word that matters: FREE has a published number worth repeating, PRO is
   * "your current plan", and TEAM's is a rolling 30-day window, so "reached
   * your limit" without "this month" would read as permanent.
   *
   * Every one of them keeps the reassurance. A person who has just been told
   * they cannot add evidence needs to know that what they already recorded is
   * safe before they need to know what to buy.
   */
  EVIDENCE_RECORD_LIMIT_REACHED: {
    title: "Evidence record limit reached",
    message:
      "Your plan includes a set number of evidence records and this workspace has used them all. Your existing records remain available — buy evidence credits or upgrade to add more.",
    severity: "warning",
    actionLabel: "View plans",
    actionHref: "/billing",
  },
  FREE_LIMIT_REACHED: {
    title: "Free record limit reached",
    message:
      "The Free plan includes 3 evidence records and this account has used them all. Your existing records remain available — buy evidence credits or upgrade to add more.",
    severity: "warning",
    actionLabel: "View plans",
    actionHref: "/billing",
  },
  EVIDENCE_RECORD_MONTHLY_LIMIT_REACHED: {
    title: "Monthly record limit reached",
    message:
      "This workspace has used every evidence record its plan includes for the last 30 days. Your existing records remain available — buy evidence credits or upgrade to add more.",
    severity: "warning",
    actionLabel: "View plans",
    actionHref: "/billing",
  },
  /**
   * The wallet is empty on an account whose plan grants no free allowance at
   * all. A 402, and a different sentence from the three above: there is no
   * included allowance to have exhausted, so "you have reached your plan's
   * limit" would describe a limit the customer never had.
   */
  INSUFFICIENT_EVIDENCE_CREDITS: {
    title: "No evidence credits left",
    message:
      "Recording new evidence on this account uses credits, and there are none left. Your existing records remain available — buy more credits to continue.",
    severity: "warning",
    actionLabel: "Buy credits",
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
  /**
   * HTTP 410 — the endpoint was RETIRED, not broken.
   *
   * Twenty-two routes answer 410 with a `*_RETIRED` code (NL_SEARCH_RETIRED,
   * COLLABORATION_TEAM_INVITE_RETIRED, INGEST_RETIRED …). Each already carries
   * a truthful server sentence, and every one of them was being discarded:
   * only `TEAM_CONFLICT` is allowed to show a server message, so a 410 fell
   * into the `status >= 400` bucket and read "We couldn't complete that
   * action — please review your input and try again."
   *
   * That is the exact failure this table was written to end. No input can fix
   * a retired endpoint, and "try again" is a lie about something that will
   * never succeed. `severity: "info"` because nothing went wrong: the caller
   * is simply out of date.
   */
  FEATURE_RETIRED: {
    title: "This feature is no longer available",
    message:
      "It has been retired and replaced. Nothing was changed. If you are using an older version of the app or an integration, update it to the current one.",
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
  /**
   * NOT "this workspace is full" — that is a different fact.
   *
   * Seats are allocated under an advisory lock, so simultaneous acceptances
   * serialise instead of over-allocating. This is what the loser of that
   * contention sees, and the invitation is untouched and still acceptable. The
   * copy has to invite a retry rather than send somebody to an admin for a
   * seat they may not need.
   */
  WORKSPACE_SEAT_CONTENTION: {
    title: "Too many people are joining at once",
    message:
      "Your invitation is still valid. Try accepting it again in a moment.",
    severity: "warning",
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
  CASE_ACCESS_TARGET_NOT_MEMBER: {
    title: "That person isn't an active member of this workspace",
    message:
      "Only active members of the workspace that owns this case can be given access to it.",
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

/**
 * CODES WHOSE SERVER MESSAGE IS THE ANSWER.
 *
 * `USER_FACING_ERRORS` answers "what does this code always mean?", which is
 * the right question for a code with one outcome. Some domain refusals do not
 * have one: `team_conflict` is raised for the last-LEAD invariant on
 * suspend, on remove and on demote, and each carries a different, already
 * user-safe sentence naming the operation and the way out.
 *
 * So for these codes — and only these — the server's own message is rendered.
 * A deliberate, bounded exception, safe because each is a fixed literal in our
 * own domain layer, interpolates nothing, and is never used by the 500
 * handler. Both clients apply the same length bound and the same refusal of
 * the synthetic "HTTP nnn: API error" placeholder.
 */
export const SERVER_MESSAGE_ERROR_CODES: Record<
  string,
  { title: string; severity: UserFacingErrorSeverity }
> = {
  TEAM_CONFLICT: {
    title: "That change isn't possible yet",
    severity: "warning",
  },
};

/** The placeholder a client substitutes when a body carries no message. */
export const SYNTHETIC_ERROR_MESSAGE = /^HTTP \d{3}: API error$/;
export const SERVER_MESSAGE_MAX_LENGTH = 240;

/** Case-insensitive lookup. The clients never index the table directly. */
export function userFacingErrorFor(code: string | null | undefined): UserFacingError | null {
  if (typeof code !== "string" || code.trim() === "") return null;
  return USER_FACING_ERRORS[code.trim().toUpperCase()] ?? null;
}
