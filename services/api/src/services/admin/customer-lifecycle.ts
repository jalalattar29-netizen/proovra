/**
 * Platform Control Center — Customer Lifecycle derivation.
 *
 * PURE, dependency-light stage derivation. This module imports NOTHING from
 * Prisma, the DB client, or any service — it takes a plain input bag of
 * already-read signals and returns a { stage, reasons } verdict. That keeps
 * it trivially unit-testable AND lets the platform-admin Customers surface
 * AND the platform Overview page share ONE derivation with identical rules.
 *
 * Honesty contract:
 *   - Every stage transition is justified by a human-readable `reason`.
 *   - We NEVER guess "ACTIVE" to fill a gap. When the signals cannot prove a
 *     stage, we return "UNKNOWN" with a reason saying so. A blank/unmodelled
 *     signal is treated as absent, not as evidence.
 *   - The order of the rule checks IS the precedence: hard terminal states
 *     (suspended/archived/cancelled) win over health, which wins over
 *     activity-based states, which win over lead-only states.
 *
 * Real vs. not-modelled:
 *   - REAL signals: Organization.status, Team.billingStatus /
 *     billingCanceledAt / billingActivatedAt / billingPlan, SSO outage flag,
 *     failed-payment presence, first-evidence presence, org/team presence,
 *     lead presence (demo / contact-sales).
 *   - There is no dedicated "lifecycle" column in the schema; the stage is a
 *     COMPUTED rollup of the above. It is never persisted.
 */

export type LifecycleStage =
  | "LEAD"
  | "DEMO_REQUESTED"
  | "CONTACT_SALES"
  | "PROVISIONED"
  | "ONBOARDING"
  | "ACTIVE"
  | "AT_RISK"
  | "SUSPENDED"
  | "CANCELLED"
  | "ARCHIVED"
  | "UNKNOWN";

export const LIFECYCLE_STAGES: readonly LifecycleStage[] = [
  "LEAD",
  "DEMO_REQUESTED",
  "CONTACT_SALES",
  "PROVISIONED",
  "ONBOARDING",
  "ACTIVE",
  "AT_RISK",
  "SUSPENDED",
  "CANCELLED",
  "ARCHIVED",
  "UNKNOWN",
];

/**
 * All signals are OPTIONAL. An absent signal is treated as "not observed"
 * (not as a falsy assertion) so a caller that cannot measure something can
 * simply omit it and receive an honest UNKNOWN rather than a fabricated
 * ACTIVE.
 */
export type LifecycleInput = {
  /**
   * Whether a persisted Organization exists for this record. `false`/absent
   * means we are looking at a pre-account lead (demo / contact-sales) only.
   */
  hasOrganization?: boolean;
  /** Organization.status — "ACTIVE" | "SUSPENDED" | "ARCHIVED". */
  organizationStatus?: string | null;
  /**
   * Whether the org has at least one non-personal workspace (Team). An org
   * with no workspace cannot be ACTIVE.
   */
  hasWorkspace?: boolean;
  /**
   * The most-advanced billing status across the org's workspaces —
   * TeamBillingStatus: "ACTIVE" | "TRIALING" | "PAST_DUE" | "INACTIVE" |
   * "CANCELED". (The live enum has no TRIALING today; it is accepted here so
   * the derivation stays forward-compatible.)
   */
  billingStatus?: string | null;
  /** True when any workspace is on a paid plan (PRO / TEAM / ENTERPRISE / PAYG). */
  onPaidPlan?: boolean;
  /** Team.billingActivatedAt present on any workspace (provisioning completed). */
  billingActivatedAt?: Date | string | null;
  /** Team.billingCanceledAt present on any workspace. */
  billingCanceledAt?: Date | string | null;
  /** True when the org has recorded at least one Evidence record (first activity). */
  hasEvidenceActivity?: boolean;
  /** True when any SsoConnection for the org is in an active outage. */
  ssoOutage?: boolean;
  /** True when the org has a recent FAILED Payment. */
  recentFailedPayment?: boolean;
  /** A pre-account lead exists (DemoRequest). */
  hasDemoRequest?: boolean;
  /** A pre-account lead exists (ContactSalesRequest). */
  hasContactSalesRequest?: boolean;
};

function isPresent(v: Date | string | null | undefined): boolean {
  return v !== null && v !== undefined && v !== "";
}

/**
 * Derive the customer lifecycle stage from already-read signals.
 *
 * Precedence (documented in `reasons`):
 *   1. ARCHIVED   ← Organization.status === "ARCHIVED"
 *   2. SUSPENDED  ← Organization.status === "SUSPENDED"
 *   3. CANCELLED  ← billingStatus CANCELED OR billingCanceledAt present
 *   4. AT_RISK    ← billingStatus PAST_DUE OR SSO outage OR recent failed payment
 *   5. ACTIVE     ← billingStatus ACTIVE AND has evidence activity
 *   6. ONBOARDING ← provisioned/activated but no first evidence yet
 *   7. PROVISIONED← org+workspace on a paid plan, no activity/activation
 *   8. CONTACT_SALES / DEMO_REQUESTED / LEAD ← lead exists, no org
 *   9. UNKNOWN    ← cannot prove anything (never guessed as ACTIVE)
 */
export function deriveCustomerLifecycle(input: LifecycleInput): {
  stage: LifecycleStage;
  reasons: string[];
} {
  const reasons: string[] = [];
  const orgStatus = (input.organizationStatus ?? "").toUpperCase();
  const billing = (input.billingStatus ?? "").toUpperCase();

  // --- 1/2. Terminal org-status states win over everything. ---
  if (input.hasOrganization && orgStatus === "ARCHIVED") {
    reasons.push("Organization.status is ARCHIVED.");
    return { stage: "ARCHIVED", reasons };
  }
  if (input.hasOrganization && orgStatus === "SUSPENDED") {
    reasons.push("Organization.status is SUSPENDED.");
    return { stage: "SUSPENDED", reasons };
  }

  // --- 3. Cancelled billing. ---
  if (billing === "CANCELED" || billing === "CANCELLED") {
    reasons.push("Team.billingStatus is CANCELED.");
    return { stage: "CANCELLED", reasons };
  }
  if (isPresent(input.billingCanceledAt)) {
    reasons.push("Team.billingCanceledAt is set (subscription cancelled).");
    return { stage: "CANCELLED", reasons };
  }

  // --- 4. At-risk signals. ---
  if (billing === "PAST_DUE") {
    reasons.push("Team.billingStatus is PAST_DUE.");
    return { stage: "AT_RISK", reasons };
  }
  if (input.ssoOutage) {
    reasons.push("An SSO connection is in an active outage.");
    return { stage: "AT_RISK", reasons };
  }
  if (input.recentFailedPayment) {
    reasons.push("A recent Payment is in FAILED status.");
    return { stage: "AT_RISK", reasons };
  }

  // --- 5. Active: healthy billing AND real product activity. ---
  if (billing === "ACTIVE" && input.hasEvidenceActivity) {
    reasons.push("Team.billingStatus is ACTIVE and the org has evidence activity.");
    return { stage: "ACTIVE", reasons };
  }

  // --- 6. Onboarding: provisioned/activated but no first evidence yet. ---
  const activated =
    isPresent(input.billingActivatedAt) || billing === "ACTIVE" || billing === "TRIALING";
  if (input.hasOrganization && activated && !input.hasEvidenceActivity) {
    reasons.push(
      "Billing is activated but no first evidence has been captured yet (onboarding).",
    );
    return { stage: "ONBOARDING", reasons };
  }

  // --- 7. Provisioned: org + workspace on a paid plan, no activity/activation. ---
  if (input.hasOrganization && input.hasWorkspace && input.onPaidPlan) {
    reasons.push(
      "Org and workspace exist on a paid plan, but no activation or activity is recorded yet.",
    );
    return { stage: "PROVISIONED", reasons };
  }

  // --- 8. Pre-account leads (no org). ---
  if (!input.hasOrganization) {
    if (input.hasContactSalesRequest) {
      reasons.push("A ContactSalesRequest exists but no organization yet.");
      return { stage: "CONTACT_SALES", reasons };
    }
    if (input.hasDemoRequest) {
      reasons.push("A DemoRequest exists but no organization yet.");
      return { stage: "DEMO_REQUESTED", reasons };
    }
    if (input.hasDemoRequest === false && input.hasContactSalesRequest === false) {
      // Explicitly probed for leads and found none, and no org exists.
      reasons.push("A lead record exists but no organization yet.");
      return { stage: "LEAD", reasons };
    }
  }

  // --- 9. Unknown: we could not prove a stage. NEVER default to ACTIVE. ---
  reasons.push(
    "Insufficient signals to prove a lifecycle stage; not guessing ACTIVE.",
  );
  return { stage: "UNKNOWN", reasons };
}
