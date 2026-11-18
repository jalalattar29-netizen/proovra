import { userFacingErrorFor } from "@proovra/shared";

/** PURE — the shared registry's sentence for a refusal billing resolves, or null. */
export function sharedCommercialCopy(code: string | null | undefined): string | null {
  const entry = userFacingErrorFor(code);
  return entry && entry.actionHref === "/billing" ? entry.message : null;
}

/**
 * Truthful capture-denial copy.
 *
 * Direct Web Capture is PLAN-BLIND. It creates evidence through the canonical
 * server session and inherits the ordinary evidence-creation eligibility gate —
 * there is NO capture-specific plan, capability or entitlement. So a server
 * refusal must be surfaced as what it actually is (an evidence-record quota, a
 * credit balance, a storage cap, or a subscription / entitlement gate on the
 * workspace's plan), never as "Direct Web Capture isn't available on this
 * workspace's plan", which was false.
 *
 * The `/v1/capture/direct-sessions*` routes answer these refusals with
 * `{ denial: <bounded code> }` and no human message (see
 * services/api/src/routes/capture-trust.routes.ts `sendDirectCaptureError`), so
 * the human sentence is produced here. The wording mirrors the canonical web
 * copy in apps/web/lib/feedback/toSafeUserError.ts (condensed for the popup) so
 * the two surfaces say the same true thing.
 *
 * Returns `null` for codes that are not an evidence-creation/commercial refusal
 * (auth, anti-enumeration, unexpected faults); the caller falls back to its
 * generic error line for those.
 *
 * B4-F-100 — a commercial refusal this list does not name (a code the shared
 * registry `userFacingErrorFor` routes to billing, e.g. a new plan state) is
 * said in the shared registry's words instead of the generic "Nothing was
 * saved. Please try again".
 */
export function denialToMessage(denial: string | null | undefined): string | null {
  if (!denial) return null;
  switch (denial) {
    // -- Evidence-record allowance (the ordinary commercial outcome) ----------
    case "FREE_LIMIT_REACHED":
      return "This account has used every evidence record the Free plan includes. Your existing records remain available — add evidence credits or upgrade to record more.";
    case "EVIDENCE_RECORD_LIMIT_REACHED":
      return "This workspace has used every evidence record its plan includes. Your existing records remain available — add evidence credits or upgrade to record more.";
    case "EVIDENCE_RECORD_MONTHLY_LIMIT_REACHED":
      return "This workspace has used every evidence record its plan includes for the last 30 days. Your existing records remain available — add evidence credits or upgrade to record more.";

    // B4-F-100 — a LAPSED paid plan falls back to the Free allowance (shared copy).
    case "PLAN_LAPSED_ALLOWANCE_EXHAUSTED":
      return (
        sharedCommercialCopy(denial) ??
        "Your paid plan has lapsed, so the Free allowance applies and it is used up. Your existing records remain available — renew your plan or use an evidence credit to add more."
      );

    // -- Credit balance -------------------------------------------------------
    case "INSUFFICIENT_CREDITS":
    case "INSUFFICIENT_EVIDENCE_CREDITS":
    case "CREDIT_REQUIRED_NONE_AVAILABLE":
      return "Recording new evidence on this account uses credits, and there are none left. Your existing records remain available — add credits to continue.";

    // -- Storage --------------------------------------------------------------
    case "STORAGE_LIMIT_REACHED":
      return "This workspace has reached its storage limit. Your existing records remain available — add storage or upgrade to keep recording evidence.";

    // -- Subscription state ---------------------------------------------------
    case "SUBSCRIPTION_INACTIVE":
      return "This workspace's subscription isn't active. Manage billing in PROOVRA to record new evidence.";

    // -- Generic evidence-creation entitlement --------------------------------
    // NOT a capture plan: these say the workspace's plan does not include
    // recording new evidence, which is the capability capture inherits.
    case "TEAM_PLAN_REQUIRED":
    case "ENTITLEMENT_REQUIRED":
    case "UPGRADE_REQUIRED":
      return "Recording new evidence isn't included on this workspace's plan. Review plans in PROOVRA or ask an admin.";

    // -- Terms (A1-06) --------------------------------------------------------
    // The server refuses every write until the current terms are accepted;
    // the refusal comes before anything is recorded.
    case "LEGAL_REACCEPT_REQUIRED":
      return "PROOVRA's terms were updated. Open PROOVRA and accept the current terms, then capture again. This capture was not saved.";

    // -- Personal space (B4-F-100) --------------------------------------------
    // A managed (organization) identity has no personal space; capturing
    // into it is refused before anything is recorded. Trying again cannot
    // change that — choosing one of the organization's workspaces does.
    case "MANAGED_IDENTITY_NO_PERSONAL_SPACE":
    case "PERSONAL_SPACE_UNAVAILABLE":
      return "Your organization manages this account, so it has no personal space to keep records in. Choose one of your organization's workspaces, then capture again. This capture was not saved.";

    // -- Capture window (B4-F-103) --------------------------------------------
    // The server checks the capture times against its own clock. The
    // extension now states them on the server's clock; if it is still
    // refused, the computer's clock is the likely cause.
    case "WEB_MANIFEST_INVALID":
    case "CAPTURE_WINDOW_INVALID":
      return "PROOVRA could not accept this capture's details, so nothing was saved. Check that your computer's date, time and time zone are set correctly, then capture again.";

    // -- Organization contract (PRO-PWXZ-01) ----------------------------------
    // The organization's contract is withheld or does not configure this:
    // the organization's administrator resolves it, not a retry or a plan.
    case "ENTERPRISE_CONTRACT_REQUIRED":
      return "This organization's contract does not allow new records here right now. Ask your organization administrator. Nothing was saved.";

    // -- Organization sign-in policy (PRO-X1-02) -------------------------------
    // The workspace's organization requires its own sign-in method (for
    // example SSO); the extension's token came from another one. The token
    // still works for every other workspace.
    case "REAUTHENTICATION_REQUIRED":
      return "This workspace's organization requires its own sign-in method (for example SSO). Sign in to PROOVRA that way, then sign in to the extension again. Nothing was saved.";

    // -- Workspace access (PRO-X1-08) -----------------------------------------
    // The canonical authorization refusal: the account was removed, suspended,
    // its access window ended, it was demoted, or the workspace is gone. The
    // server does not say which (anti-enumeration); the popup does not guess.
    case "not_found":
    case "permission_denied":
    case "unauthenticated":
      return "You no longer have access to record evidence in this workspace, or it no longer exists. Nothing was saved. Choose another workspace.";
    case "authorization_unavailable":
      return "PROOVRA could not confirm your access to this workspace just now. Nothing was saved. Try again in a moment.";

    // -- Rate limiting --------------------------------------------------------
    case "RATE_LIMITED":
      return "Too many capture attempts just now. Wait a moment and try again.";

    // -- Seal (F-04) ----------------------------------------------------------
    // The stored files changed while the seal was being signed; nothing was
    // sealed or charged (shared copy: EVIDENCE_COMPLETION_INPUTS_CHANGED).
    case "EVIDENCE_COMPLETION_INPUTS_CHANGED":
      return "The capture's files changed while it was being sealed, so nothing was sealed and nothing was charged. Capture again.";

    default:
      return sharedCommercialCopy(denial);
  }
}
