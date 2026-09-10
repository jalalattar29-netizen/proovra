/**
 * The workspace invitation CONTRACT — one vocabulary, shared by the API that
 * decides and the public page that renders.
 *
 * =============================================================================
 * WHY THIS EXISTS
 * =============================================================================
 * `services/api/src/services/identity/workspace-invitation.service.ts` is the
 * invitation authority, and it already refuses with stable codes — its own
 * comment says "Every refusal is a typed code the accept page can render."
 *
 * The public page at `/invite/[token]` was not rendering them. It classified
 * outcomes by SUBSTRING MATCH over the human-readable message:
 *
 *     if (message.includes("already accepted")) …
 *     else if (message.includes("expired")) …
 *     else if (message.includes("Forbidden")) …
 *
 * So the page's behaviour depended on copy, and rewording a sentence in the
 * service silently reclassified a state in the browser. The authenticated
 * collaboration-team accept page had already been fixed to classify "by STABLE
 * backend codes only — never by regex over the error message"; the public one
 * had not.
 *
 * Putting the code union HERE rather than in either side means neither can
 * drift from the other, and a code added to the service without a presentation
 * decision is a compile error in the resolver rather than a silent fallthrough
 * to a generic error page.
 *
 * NOTHING here decides anything. No status is derived, no expiry is compared,
 * no membership is inferred. `invitationStatus()` in the service remains the
 * single status authority; this module only names what it can say.
 */

// =============================================================================
// TOKEN SHAPE
// =============================================================================

/**
 * The prefix the service mints (`mintToken`), kept here so a client can reject
 * an obviously malformed token WITHOUT a network request.
 *
 * That is a privacy property, not an optimisation: a page that posts every
 * random string to the API turns the invitation endpoint into an oracle that
 * anybody can address, and it makes a typo indistinguishable from a real
 * lookup in the rate-limit budget. Prefixed so a value found in a log or a
 * support ticket is immediately identifiable as a workspace invitation token
 * that needs revoking.
 */
export const WORKSPACE_INVITE_TOKEN_PREFIX = "wsit_v1_" as const;

/**
 * True iff `token` could be a workspace invitation token.
 *
 * Shape only. A well-formed token is not a valid one — only the server knows
 * that — so this is used to skip a pointless request, never to grant anything.
 *
 * The body is 32 random bytes as base64url (43 chars, unpadded). The range is
 * deliberately loose at both ends so an encoding change in the minter does not
 * make live invitations unopenable before anyone notices.
 */
export function isWellFormedWorkspaceInviteToken(
  token: string | null | undefined,
): boolean {
  if (!token || typeof token !== "string") return false;
  if (!token.startsWith(WORKSPACE_INVITE_TOKEN_PREFIX)) return false;
  const body = token.slice(WORKSPACE_INVITE_TOKEN_PREFIX.length);
  return /^[A-Za-z0-9_-]{32,86}$/.test(body);
}

// =============================================================================
// WHAT A LOOKUP CAN SAY
// =============================================================================

/**
 * The four states `invitationStatus()` distinguishes, plus the two the
 * WORKSPACE can be in independently of the invitation.
 *
 * `NOT_ACCEPTING_MEMBERS` is not an invitation state at all — the invitation
 * is fine and the workspace is closed or its organization is not ACTIVE. It is
 * listed here because the recipient has to be told the truth about why they
 * cannot join, and "expired" would be a lie.
 */
export const WORKSPACE_INVITATION_LOOKUP_STATES = [
  "PENDING",
  "ACCEPTED",
  "REVOKED",
  "EXPIRED",
  "NOT_ACCEPTING_MEMBERS",
] as const;

export type WorkspaceInvitationLookupState =
  (typeof WORKSPACE_INVITATION_LOOKUP_STATES)[number];

/**
 * The BOUNDED projection a lookup returns.
 *
 * Every field is either a display string the recipient already knows from the
 * email that carried the token, or a status. There is deliberately no
 * `workspaceId`, no `organizationId`, no `inviteId`, no `userId`, no
 * `tokenHash` and no inviter identity: an internal id in a public response is
 * an enumeration surface, and none of them tells the recipient anything about
 * the decision they are being asked to make.
 *
 * `context` is present ONLY for `PENDING`. A recipient looking at a live
 * invitation needs to know which workspace and which role they are accepting;
 * one that is spent, revoked or expired does not need the workspace named
 * again, and not naming it keeps a leaked or brute-forced token from
 * describing an organization that never chose to be described.
 */
export type WorkspaceInvitationLookup = {
  state: WorkspaceInvitationLookupState;
  context: WorkspaceInvitationContext | null;
};

export type WorkspaceInvitationContext = {
  /** The workspace's display name. Never an id. */
  workspaceName: string;
  /**
   * The organization that owns the workspace, when the workspace is backed by
   * a customer organization and its name differs from the workspace's own.
   * `null` for a personal or owned workspace — those have no second name, and
   * inventing one would be inventing organization data.
   */
  organizationName: string | null;
  /** The role being offered, as the enum the API already publishes. */
  role: string;
  /**
   * The invited address, MASKED (`j••••@example.com`).
   *
   * The recipient needs to recognise which mailbox this invitation belongs to
   * — that is the whole content of the wrong-account state — and masking lets
   * them do that without the full address being readable by anyone who comes
   * to hold the link.
   */
  invitedEmailMasked: string;
  /** ISO-8601 UTC. Rendered in the reader's zone by the page. */
  expiresAtUtc: string;
};

/**
 * Mask a local part while leaving it recognisable.
 *
 * `jalal@example.com` → `j••••@example.com`. The domain is kept whole: it is
 * usually the organization's own domain, which the recipient already knows,
 * and hiding it would make the state useless for its purpose.
 *
 * A local part of one character is emitted as a single bullet rather than
 * itself, so a one-letter mailbox is not disclosed exactly by a function whose
 * job is to withhold it.
 */
export function maskInvitedEmail(email: string): string {
  const trimmed = String(email ?? "").trim();
  const at = trimmed.lastIndexOf("@");
  if (at <= 0) return "•••";
  const local = trimmed.slice(0, at);
  const domain = trimmed.slice(at + 1);
  if (!domain) return "•••";
  const head = local.length > 1 ? local.slice(0, 1) : "";
  return `${head}${"•".repeat(Math.max(3, Math.min(local.length - head.length, 6)))}@${domain}`;
}

// =============================================================================
// WHAT AN ACCEPT CAN REFUSE
// =============================================================================

/**
 * Every refusal `acceptWorkspaceInvitation` can throw, as the code it carries.
 *
 * Read off the service rather than invented: `INVITE_NOT_FOUND` (404),
 * `INVITE_REVOKED` (410), `INVITE_EXPIRED` (410),
 * `WORKSPACE_NOT_ACCEPTING_MEMBERS` (409), `INVITE_EMAIL_MISMATCH` (403),
 * `WORKSPACE_MEMBERS_NOT_INCLUDED` (402), `WORKSPACE_SEAT_LIMIT_REACHED`
 * (409), `INVITE_ALREADY_USED` (409), `WORKSPACE_SEAT_CONTENTION` (409).
 *
 * The union is exhaustive on purpose. The resolver switches over it without a
 * `default`, so adding a refusal to the service and forgetting to decide what
 * the recipient sees does not compile.
 */
export const WORKSPACE_INVITATION_REFUSAL_CODES = [
  "INVITE_NOT_FOUND",
  "INVITE_REVOKED",
  "INVITE_EXPIRED",
  "INVITE_ALREADY_USED",
  "INVITE_EMAIL_MISMATCH",
  "WORKSPACE_NOT_ACCEPTING_MEMBERS",
  "WORKSPACE_MEMBERS_NOT_INCLUDED",
  "WORKSPACE_SEAT_LIMIT_REACHED",
  "WORKSPACE_SEAT_CONTENTION",
] as const;

export type WorkspaceInvitationRefusalCode =
  (typeof WORKSPACE_INVITATION_REFUSAL_CODES)[number];

export function isWorkspaceInvitationRefusalCode(
  value: unknown,
): value is WorkspaceInvitationRefusalCode {
  return (
    typeof value === "string" &&
    (WORKSPACE_INVITATION_REFUSAL_CODES as readonly string[]).includes(value)
  );
}

/**
 * The subset a recipient can do something about by trying again.
 *
 * `WORKSPACE_SEAT_CONTENTION` is the only genuinely transient one: the service
 * throws it after twenty-five failed attempts to take the per-workspace
 * advisory lock, which is sustained contention rather than a decision about
 * this invitation. Everything else is a settled answer, and offering a retry
 * on a settled answer is a button that cannot work.
 */
export const WORKSPACE_INVITATION_RETRYABLE_CODES: ReadonlySet<WorkspaceInvitationRefusalCode> =
  new Set<WorkspaceInvitationRefusalCode>(["WORKSPACE_SEAT_CONTENTION"]);
