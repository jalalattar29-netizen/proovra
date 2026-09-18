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

    // -- Credit balance -------------------------------------------------------
    case "INSUFFICIENT_CREDITS":
    case "INSUFFICIENT_EVIDENCE_CREDITS":
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

    // -- Rate limiting --------------------------------------------------------
    case "RATE_LIMITED":
      return "Too many capture attempts just now. Wait a moment and try again.";

    default:
      return null;
  }
}
