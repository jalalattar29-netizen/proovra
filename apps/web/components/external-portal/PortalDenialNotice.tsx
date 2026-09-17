"use client";

/**
 * D58 — the external reviewer portal's one denial notice.
 *
 * The portal's API answers refusals with a bounded `denial` code
 * (EXTERNAL_PORTAL_DENIAL_REASONS). The signed-in pages and the invitation
 * landing page used to print that code as the message — a reviewer whose
 * session an operator had ended read "SESSION_ENDED". Every portal page now
 * renders this notice instead: product copy, the code only as a data
 * attribute, and the way forward where there is one.
 *
 * Recovery:
 *   - "reauthenticate" (SESSION_ENDED, INACTIVITY_TIMEOUT): the caller
 *     forgets the ended session and exchanges the invitation token again
 *     (POST /v1/portal/auth), which opens a fresh session. An MFA grant is
 *     answered with MFA_REQUIRED and a freshly emailed code, which the
 *     caller hands to `PortalMfaCodeStep`.
 *   - "retry" (SESSION_UNAVAILABLE, RATE_LIMITED): nothing is wrong with
 *     the invitation; try the same request again later.
 *   - "none": the invitation itself no longer opens the portal.
 */

import React from "react";

import { Button } from "../ui/Button";

export type PortalDenialRecovery = "reauthenticate" | "retry" | "none";

export type PortalDenialCopy = {
  title: string;
  body: string;
  recovery: PortalDenialRecovery;
};

const NEW_INVITATION =
  "Ask the person who invited you for a new invitation.";

export function portalDenialCopy(denial: string | null): PortalDenialCopy {
  switch (denial) {
    case "SESSION_ENDED":
      return {
        title: "Your portal session has ended",
        body:
          "You were signed out, or the workspace that invited you ended this session. Sign in again with your invitation to continue. If your invitation needs a sign-in code, we will email you a new one.",
        recovery: "reauthenticate",
      };
    case "INACTIVITY_TIMEOUT":
      return {
        title: "Your portal session timed out",
        body:
          "You were inactive for too long, so the session was closed. Sign in again with your invitation to continue.",
        recovery: "reauthenticate",
      };
    case "SESSION_UNAVAILABLE":
      return {
        title: "The portal is temporarily unavailable",
        body:
          "We couldn't confirm your session just now, so the portal stays closed. Nothing about your invitation has changed. Try again in a few minutes.",
        recovery: "retry",
      };
    case "RATE_LIMITED":
      return {
        title: "Too many attempts",
        body: "Too many requests were made with this invitation. Wait a few minutes, then try again.",
        recovery: "retry",
      };
    case "TOKEN_EXPIRED":
      return {
        title: "This invitation has expired",
        body: NEW_INVITATION,
        recovery: "none",
      };
    case "TOKEN_REVOKED":
    case "INVITE_ALREADY_REVOKED":
      return {
        title: "This invitation was withdrawn",
        body: "Ask the person who invited you if you still need access.",
        recovery: "none",
      };
    case "NOT_PERMITTED":
      return {
        title: "Your invitation does not allow this",
        body: "Ask the person who invited you if you need more access.",
        recovery: "none",
      };
    case "OUT_OF_SCOPE":
    case "WORKFLOW_NOT_FOUND":
      return {
        title: "This review is not available",
        body: "It is not part of your invitation, or it is no longer open for review.",
        recovery: "none",
      };
    case "POLICY_REJECTED":
      return {
        title: "Sign-in was refused",
        body:
          "Your organization's sign-in policy did not accept this sign-in. You can still open the portal with your invitation link, or ask the person who invited you.",
        recovery: "none",
      };
    case "SSO_REQUIRES_TOKEN_BOOTSTRAP":
      return {
        title: "Open your invitation link first",
        body: "Single sign-on starts from the invitation link in your email. Open that link, then choose Sign in with SSO.",
        recovery: "none",
      };
    case "INVITE_NOT_FOUND":
    case "TOKEN_INVALID":
    default:
      return {
        title: "We couldn't open the portal with this invitation",
        body: `The invitation link may be incomplete or no longer valid. ${NEW_INVITATION}`,
        recovery: "none",
      };
  }
}

export function PortalDenialNotice({
  denial,
  onReauthenticate,
  onRetry,
  busy = false,
  headingLevel = "h1",
}: {
  denial: string | null;
  /** Forget the ended session and exchange the invitation token again. */
  onReauthenticate?: () => void;
  onRetry?: () => void;
  busy?: boolean;
  headingLevel?: "h1" | "h2";
}) {
  const copy = portalDenialCopy(denial);
  const Heading = headingLevel;
  return (
    <div
      role="alert"
      data-portal-denial-notice
      data-portal-denial-code={denial ?? "UNKNOWN"}
      data-portal-denial-recovery={copy.recovery}
    >
      <Heading style={{ fontSize: headingLevel === "h1" ? 20 : 15, margin: 0 }}>
        {copy.title}
      </Heading>
      <p style={{ marginTop: 8, fontSize: 13, lineHeight: 1.55 }}>{copy.body}</p>
      {copy.recovery === "reauthenticate" && onReauthenticate ? (
        <Button
          variant="primary"
          data-portal-reauthenticate
          loading={busy}
          disabled={busy}
          onClick={onReauthenticate}
        >
          {busy ? "Signing in…" : "Sign in again"}
        </Button>
      ) : null}
      {copy.recovery === "retry" && onRetry ? (
        <Button
          variant="secondary"
          data-portal-retry
          loading={busy}
          disabled={busy}
          onClick={onRetry}
        >
          {busy ? "Trying again…" : "Try again"}
        </Button>
      ) : null}
    </div>
  );
}
