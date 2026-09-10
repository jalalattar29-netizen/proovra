/**
 * THE ONE render authority for the public invitation page.
 *
 * =============================================================================
 * WHY IT IS A PURE MODULE
 * =============================================================================
 * `/invite/[token]` used to decide what to show with a chain of substring
 * matches over the error message, inside the component, inside a `useEffect`
 * that had ALREADY accepted the invitation:
 *
 *     if (message.includes("already accepted")) setState("already_accepted");
 *     else if (message.includes("expired")) setState("expired");
 *     else if (message.includes("Forbidden")) setState("mismatch");
 *     else if (message.includes("Invite not found")) setState("invalid");
 *     else setState("error");
 *
 * Three defects in five lines: the classification depended on copy, the
 * component owned the decision, and there was no state for "valid, here is
 * what you are joining" because the page had no way to ask.
 *
 * This module is the decision, and only the decision. It takes what is known —
 * the token's shape, the lookup outcome, the auth state, and the outcome of an
 * accept attempt if one has been made — and returns exactly one view. It
 * performs no I/O, reads no globals, and renders nothing, so every state in
 * the matrix is reachable in a unit test without a browser.
 *
 * =============================================================================
 * WHAT IT REFUSES TO DO
 * =============================================================================
 * It never derives a status the server did not state. There is no local expiry
 * comparison, no "if the email looks different then it must be a mismatch", no
 * inference of membership. `invitationStatus()` on the server is the status
 * authority and `acceptWorkspaceInvitation` is the acceptance authority; this
 * maps their answers onto presentation and nothing else.
 */

import {
  WORKSPACE_INVITATION_RETRYABLE_CODES,
  isWellFormedWorkspaceInviteToken,
  type WorkspaceInvitationContext,
  type WorkspaceInvitationLookup,
  type WorkspaceInvitationRefusalCode,
} from "@proovra/shared";

// =============================================================================
// INPUTS — what the page can know
// =============================================================================

/** Where the auth provider is, from the page's point of view. */
export type InvitationAuthState =
  | { kind: "resolving" }
  | { kind: "signed-out" }
  | { kind: "signed-in"; email: string | null };

/** What the lookup call has produced so far. */
export type InvitationLookupOutcome =
  | { kind: "pending" }
  | { kind: "resolved"; lookup: WorkspaceInvitationLookup }
  /** The server said this token is not available (404 / unknown). */
  | { kind: "not-available" }
  /** The lookup itself failed — network, 5xx, timeout. NOT a verdict. */
  | { kind: "unreachable" };

/** What an accept attempt has produced, if one has been made. */
export type InvitationAcceptOutcome =
  | { kind: "idle" }
  | { kind: "submitting" }
  | { kind: "accepted"; alreadyMember: boolean; destination: string }
  | { kind: "refused"; code: WorkspaceInvitationRefusalCode }
  /** The accept call failed transiently. The invitation is NOT invalid. */
  | { kind: "unreachable" };

export type ResolveInvitationInput = {
  token: string;
  auth: InvitationAuthState;
  lookup: InvitationLookupOutcome;
  accept: InvitationAcceptOutcome;
};

// =============================================================================
// OUTPUT — exactly one view
// =============================================================================

/**
 * The render states. One per thing that is actually true, which is the whole
 * point: `expired` and `revoked` are different facts and the recipient is owed
 * the difference, while `unknown` deliberately collapses several so that a
 * guessed token learns nothing.
 */
export type InvitationViewKind =
  /** The lookup has not answered yet. Skeleton, never a verdict. */
  | "loading"
  /** Valid, and nobody is signed in. Sign in / create account. */
  | "ready-signed-out"
  /** Valid, signed in. The Accept control lives here. */
  | "ready-signed-in"
  /** Accept is in flight. */
  | "accepting"
  /** Accepted just now. */
  | "accepted"
  /** Already an active member — a success, not an error. */
  | "already-member"
  /** Signed in as the wrong mailbox. The invitation itself is fine. */
  | "wrong-account"
  | "expired"
  | "revoked"
  | "already-used"
  /** Workspace closed, or its organization is not active. */
  | "not-accepting"
  /** Plan does not include members, or every seat is taken. */
  | "capacity"
  /** Unknown, malformed, or otherwise not available. Deliberately opaque. */
  | "unknown"
  /** Lookup or accept could not complete. Retryable, and NOT a verdict. */
  | "unreachable";

/** What the page is allowed to offer. Resolved here, never in the renderer. */
export type InvitationAction =
  | "accept"
  | "retry"
  | "sign-in"
  | "create-account"
  | "switch-account"
  | "open-workspace"
  | "go-home"
  | "go-dashboard";

export type InvitationView = {
  kind: InvitationViewKind;
  /**
   * Context is carried ONLY where the server supplied it, which is only for a
   * live invitation. A terminal state never re-names the workspace.
   */
  context: WorkspaceInvitationContext | null;
  /** The ordered controls. First is primary. */
  actions: InvitationAction[];
  /** Where `open-workspace` goes, when that action is offered. */
  destination: string | null;
  /**
   * True for the states that describe a workspace/plan condition rather than a
   * defect in the invitation — used to pick a status tone without the renderer
   * re-deciding what happened.
   */
  tone: "info" | "success" | "warning" | "error";
};

// =============================================================================
// THE RESOLUTION
// =============================================================================

/**
 * Precedence is deliberate and reads top to bottom:
 *
 *   1. an accept attempt that has produced an answer wins over everything —
 *      it is the most recent truth, and an invitation that expired between
 *      render and click must show expired, not the ready state it was drawn in;
 *   2. then a malformed token, which needs no server at all;
 *   3. then the lookup's own answer;
 *   4. then, for a live invitation, the auth state decides which of the two
 *      actionable states applies.
 */
export function resolveInvitationView(
  input: ResolveInvitationInput,
): InvitationView {
  const { token, auth, lookup, accept } = input;

  // -- 1. The accept attempt, if it has said anything -----------------------

  if (accept.kind === "submitting") {
    return view("accepting", contextOf(lookup), [], null, "info");
  }
  if (accept.kind === "accepted") {
    return accept.alreadyMember
      ? view(
          "already-member",
          contextOf(lookup),
          ["open-workspace"],
          accept.destination,
          "success",
        )
      : view(
          "accepted",
          contextOf(lookup),
          ["open-workspace"],
          accept.destination,
          "success",
        );
  }
  if (accept.kind === "unreachable") {
    // The invitation is not invalid. Say so, and keep the token.
    return view("unreachable", contextOf(lookup), ["retry", "go-home"], null, "warning");
  }
  if (accept.kind === "refused") {
    return fromRefusal(accept.code, auth, contextOf(lookup));
  }

  // -- 2. Shape, before any request ----------------------------------------

  if (!isWellFormedWorkspaceInviteToken(token)) {
    // No lookup is issued for a token that cannot be one. Nothing is disclosed
    // and nothing is spent, and the reader gets the same opaque state a
    // genuinely unknown token gets.
    return view("unknown", null, unknownActions(auth), null, "error");
  }

  // -- 3. The lookup --------------------------------------------------------

  if (lookup.kind === "pending") {
    return view("loading", null, [], null, "info");
  }
  if (lookup.kind === "unreachable") {
    return view("unreachable", null, ["retry", "go-home"], null, "warning");
  }
  if (lookup.kind === "not-available") {
    return view("unknown", null, unknownActions(auth), null, "error");
  }

  const { state, context } = lookup.lookup;

  if (state === "EXPIRED") {
    return view("expired", null, terminalActions(auth), null, "warning");
  }
  if (state === "REVOKED") {
    return view("revoked", null, terminalActions(auth), null, "error");
  }
  if (state === "ACCEPTED") {
    /*
      A SPENT TOKEN, AND WHY IT IS NOT A CLAIM ABOUT MEMBERSHIP.

      The lookup is unauthenticated, so it cannot know whether the person
      reading this is the one who accepted. It therefore does not say "you are
      already a member" — that sentence belongs to the authenticated
      `alreadyMember: true` success shape above, which the server does know.

      Signed in, the recipient is offered Accept: the server answers either
      `alreadyMember` (they are the accepter — a success) or
      `INVITE_ALREADY_USED` / `INVITE_EMAIL_MISMATCH` (they are not). That
      keeps the membership fact on the side that can prove it.
    */
    return auth.kind === "signed-in"
      ? view("already-used", null, ["accept", "go-dashboard"], null, "info")
      : view("already-used", null, terminalActions(auth), null, "info");
  }
  if (state === "NOT_ACCEPTING_MEMBERS") {
    return view("not-accepting", null, terminalActions(auth), null, "warning");
  }

  // -- 4. PENDING: the auth state decides ----------------------------------

  if (auth.kind === "resolving") {
    // Do not flash a sign-in prompt at somebody who is already signed in.
    return view("loading", context, [], null, "info");
  }
  if (auth.kind === "signed-out") {
    return view(
      "ready-signed-out",
      context,
      ["sign-in", "create-account"],
      null,
      "info",
    );
  }

  /*
    THE EMAIL IS NOT COMPARED HERE, AND THAT IS THE POINT.

    The masked address is a display string; matching it against the session's
    email in the browser would be a second, weaker copy of the binding the
    server enforces in `acceptWorkspaceInvitation` (`INVITE_EMAIL_MISMATCH`,
    403). Two authorities for one rule is how they drift.

    So a signed-in reader is always offered Accept, and the wrong-account state
    is reached from the server's refusal — where it is a fact rather than a
    guess about a masked string.
  */
  return view("ready-signed-in", context, ["accept"], null, "info");
}

// =============================================================================
// Refusal → view
// =============================================================================

/**
 * Exhaustive over `WorkspaceInvitationRefusalCode`. No `default` arm: adding a
 * refusal to the service without deciding what the recipient sees is a
 * compile error here, not a silent fall through to "something went wrong".
 */
function fromRefusal(
  code: WorkspaceInvitationRefusalCode,
  auth: InvitationAuthState,
  context: WorkspaceInvitationContext | null,
): InvitationView {
  switch (code) {
    case "INVITE_NOT_FOUND":
      return view("unknown", null, unknownActions(auth), null, "error");
    case "INVITE_EXPIRED":
      return view("expired", null, terminalActions(auth), null, "warning");
    case "INVITE_REVOKED":
      return view("revoked", null, terminalActions(auth), null, "error");
    case "INVITE_ALREADY_USED":
      return view("already-used", null, ["go-dashboard"], null, "info");
    case "INVITE_EMAIL_MISMATCH":
      // The invitation is VALID. Only the session is wrong, and the recipient
      // can fix that themselves.
      return view(
        "wrong-account",
        context,
        ["switch-account", "go-dashboard"],
        null,
        "warning",
      );
    case "WORKSPACE_NOT_ACCEPTING_MEMBERS":
      return view("not-accepting", null, terminalActions(auth), null, "warning");
    case "WORKSPACE_MEMBERS_NOT_INCLUDED":
    case "WORKSPACE_SEAT_LIMIT_REACHED":
      // A commercial condition of the WORKSPACE, not a defect in the link, and
      // not something the invitee can buy their way out of. No retry: the
      // administrator has to act.
      return view("capacity", context, terminalActions(auth), null, "warning");
    case "WORKSPACE_SEAT_CONTENTION":
      // The one genuinely transient refusal — twenty-five failed attempts on
      // the per-workspace lock. Retry is real here, so it is offered.
      return view("unreachable", context, ["retry", "go-dashboard"], null, "warning");
  }
}

// =============================================================================
// helpers
// =============================================================================

function view(
  kind: InvitationViewKind,
  context: WorkspaceInvitationContext | null,
  actions: InvitationAction[],
  destination: string | null,
  tone: InvitationView["tone"],
): InvitationView {
  return { kind, context, actions, destination, tone };
}

function contextOf(lookup: InvitationLookupOutcome): WorkspaceInvitationContext | null {
  return lookup.kind === "resolved" ? lookup.lookup.context : null;
}

/**
 * An unrecoverable link. Sign-in is offered to a signed-out reader because it
 * is the only thing that could plausibly help them (they may hold a newer
 * invitation, or already have access); a signed-in reader is sent to their own
 * dashboard instead of being asked to sign in again.
 */
function unknownActions(auth: InvitationAuthState): InvitationAction[] {
  return auth.kind === "signed-in" ? ["go-dashboard", "go-home"] : ["sign-in", "go-home"];
}

/** Same reasoning as `unknownActions`, for the states that name a real cause. */
function terminalActions(auth: InvitationAuthState): InvitationAction[] {
  return auth.kind === "signed-in" ? ["go-dashboard"] : ["sign-in", "go-home"];
}

/** Is this refusal one the reader can usefully retry? */
export function isRetryableRefusal(code: WorkspaceInvitationRefusalCode): boolean {
  return WORKSPACE_INVITATION_RETRYABLE_CODES.has(code);
}
