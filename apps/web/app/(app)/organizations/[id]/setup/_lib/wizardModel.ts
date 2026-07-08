/**
 * Enterprise onboarding wizard — PURE model.
 *
 * This module is the single source of truth for:
 *
 *   - the ordered set of wizard steps (id, title, whether skippable),
 *   - the checklist criteria and how each one is DERIVED from the same
 *     reads the wizard already performs (no new server state),
 *   - the multi-step state-machine transitions (next / back / bounds).
 *
 * It is intentionally UI-free and dependency-free so it can be unit
 * tested under node:test without rendering React, and so the wizard
 * page and the reusable SetupChecklist derive completion from ONE place.
 *
 * ARCHITECTURE NOTE — this is a THIN ORCHESTRATION layer. Every step
 * reuses an endpoint that already exists (see `endpoint` below); the
 * wizard never persists new server state. "Completion" is derived from
 * the reads, never stored.
 */

// ---------------------------------------------------------------------------
// Step catalogue.
// ---------------------------------------------------------------------------

export type WizardStepId =
  | "company"
  | "workspace"
  | "branding"
  | "administrator"
  | "invite"
  | "billing"
  | "security"
  | "retention"
  | "legalHolds"
  | "evidenceDefaults"
  | "firstCapture"
  | "finish";

export type WizardStep = {
  id: WizardStepId;
  /** 1-based number shown in the progress indicator. */
  index: number;
  title: string;
  /** One-line operator-facing description. */
  subtitle: string;
  /** Optional steps can be skipped without blocking Finish. */
  skippable: boolean;
  /**
   * The EXISTING endpoint this step reuses. `null` for informational /
   * link-only steps that write nothing. Used by the contract test to
   * prove no new endpoint was invented.
   */
  endpoint: string | null;
};

/**
 * The ordered wizard steps. Order is load-bearing (drives Next/Back and
 * the progress indicator). Every `endpoint` here is reused verbatim from
 * an existing surface — do NOT invent new endpoints.
 */
export const WIZARD_STEPS: ReadonlyArray<WizardStep> = [
  {
    id: "company",
    index: 1,
    title: "Company information",
    subtitle: "Organization name, legal name, legal email, and timezone.",
    skippable: false,
    endpoint: "PATCH /v1/orgs/:id",
  },
  {
    id: "workspace",
    index: 2,
    title: "Workspace information",
    subtitle: "Name the primary workspace where evidence and cases live.",
    skippable: true,
    endpoint: "PATCH /v1/teams/:id",
  },
  {
    id: "branding",
    index: 3,
    title: "Branding",
    subtitle: "Add a logo URL that appears on reports and verification pages.",
    skippable: true,
    endpoint: "PATCH /v1/orgs/:id",
  },
  {
    id: "administrator",
    index: 4,
    title: "Primary administrator",
    subtitle: "Confirm the organization owner. Already set — nothing to change.",
    skippable: false,
    endpoint: null,
  },
  {
    id: "invite",
    index: 5,
    title: "Invite employees",
    subtitle: "Send organization invites. Add as many people as you like.",
    skippable: true,
    endpoint: "POST /v1/orgs/:id/invites",
  },
  {
    id: "billing",
    index: 6,
    title: "Billing confirmation",
    subtitle: "Review the plan and seats provisioned for your organization.",
    skippable: false,
    endpoint: "GET /v1/billing/overview",
  },
  {
    id: "security",
    index: 7,
    title: "Security baseline",
    subtitle: "Choose an MFA policy and review SSO / SCIM readiness.",
    skippable: true,
    endpoint: "PUT /v1/identity-security/mfa-policy",
  },
  {
    id: "retention",
    index: 8,
    title: "Retention defaults",
    subtitle: "Pick a default retention window for preserved evidence.",
    skippable: true,
    endpoint: "POST /v1/lifecycle/retention/policies",
  },
  {
    id: "legalHolds",
    index: 9,
    title: "Legal-hold defaults",
    subtitle: "Optionally place an organization-wide legal hold now.",
    skippable: true,
    endpoint: "POST /v1/lifecycle/legal-holds",
  },
  {
    id: "evidenceDefaults",
    index: 10,
    title: "Evidence defaults",
    subtitle: "How capture and preservation behave. Managed per workspace.",
    skippable: true,
    endpoint: null,
  },
  {
    id: "firstCapture",
    index: 11,
    title: "First capture",
    subtitle: "Record your organization's first piece of signed evidence.",
    skippable: true,
    endpoint: null,
  },
  {
    id: "finish",
    index: 12,
    title: "You're enterprise ready",
    subtitle: "Setup complete. Go to your workspace to start working.",
    skippable: false,
    endpoint: null,
  },
];

export const TOTAL_STEPS = WIZARD_STEPS.length;

export function getStep(index: number): WizardStep | undefined {
  return WIZARD_STEPS[index];
}

// ---------------------------------------------------------------------------
// State machine.
// ---------------------------------------------------------------------------

export type WizardMachineState = {
  /** 0-based index into WIZARD_STEPS. */
  stepIndex: number;
  /** Step ids the operator has explicitly skipped. */
  skipped: ReadonlySet<WizardStepId>;
};

export function initialWizardState(): WizardMachineState {
  return { stepIndex: 0, skipped: new Set() };
}

export function canGoNext(state: WizardMachineState): boolean {
  return state.stepIndex < TOTAL_STEPS - 1;
}

export function canGoBack(state: WizardMachineState): boolean {
  return state.stepIndex > 0;
}

export function isLastStep(state: WizardMachineState): boolean {
  return state.stepIndex === TOTAL_STEPS - 1;
}

export function goNext(state: WizardMachineState): WizardMachineState {
  return canGoNext(state)
    ? { ...state, stepIndex: state.stepIndex + 1 }
    : state;
}

export function goBack(state: WizardMachineState): WizardMachineState {
  return canGoBack(state)
    ? { ...state, stepIndex: state.stepIndex - 1 }
    : state;
}

export function goToStep(
  state: WizardMachineState,
  index: number,
): WizardMachineState {
  if (index < 0 || index >= TOTAL_STEPS) return state;
  return { ...state, stepIndex: index };
}

/**
 * Skip is only allowed on skippable steps; skipping advances to the next
 * step and records the skip so the progress indicator can show it.
 */
export function skipStep(state: WizardMachineState): WizardMachineState {
  const step = WIZARD_STEPS[state.stepIndex];
  if (!step || !step.skippable) return state;
  const skipped = new Set(state.skipped);
  skipped.add(step.id);
  return goNext({ ...state, skipped });
}

// ---------------------------------------------------------------------------
// Checklist derivation.
// ---------------------------------------------------------------------------

/**
 * Minimal projections of the reads the wizard already performs. Shapes
 * mirror the existing wire responses so the derivation stays honest.
 */
export type ChecklistInputs = {
  org: {
    legalName: string | null;
    legalEmail: string | null;
    timezone: string | null;
  } | null;
  /** Non-owner member count. Owner is always present, so ">= 1" means at
   * least one additional person exists on the org. */
  memberCount: number | null;
  /** Pending org invites (accepted invites promote to members). */
  pendingInviteCount: number | null;
  /** MFA policy level for the primary workspace; "OFF" counts as unset. */
  mfaPolicyLevel: string | null;
  /** Number of retention policies defined in the primary workspace. */
  retentionPolicyCount: number | null;
  /** Number of evidence records captured in the primary workspace. */
  evidenceCount: number | null;
};

export type ChecklistCriterionId =
  | "companyProfile"
  | "employeeInvited"
  | "mfaChosen"
  | "retentionSet"
  | "firstEvidence";

export type ChecklistCriterion = {
  id: ChecklistCriterionId;
  label: string;
  /** true = done, false = not done, null = still loading / unknown. */
  done: boolean | null;
  /** The wizard step id this criterion maps to, for deep-linking. */
  stepId: WizardStepId;
};

export function deriveChecklist(
  inputs: ChecklistInputs,
): ReadonlyArray<ChecklistCriterion> {
  const companyProfile: boolean | null =
    inputs.org === null
      ? null
      : Boolean(
          inputs.org.legalName &&
            inputs.org.legalEmail &&
            inputs.org.timezone,
        );

  // "≥ 1 employee invited" is satisfied by either a pending invite OR an
  // accepted one (member beyond the sole owner). Either read alone can be
  // unknown; we only report `false` once both are known.
  const memberKnown = inputs.memberCount !== null;
  const inviteKnown = inputs.pendingInviteCount !== null;
  const extraMembers = (inputs.memberCount ?? 0) > 1;
  const pending = (inputs.pendingInviteCount ?? 0) > 0;
  const employeeInvited: boolean | null =
    !memberKnown && !inviteKnown
      ? null
      : extraMembers || pending;

  const mfaChosen: boolean | null =
    inputs.mfaPolicyLevel === null
      ? null
      : inputs.mfaPolicyLevel !== "OFF";

  const retentionSet: boolean | null =
    inputs.retentionPolicyCount === null
      ? null
      : inputs.retentionPolicyCount > 0;

  const firstEvidence: boolean | null =
    inputs.evidenceCount === null ? null : inputs.evidenceCount > 0;

  return [
    {
      id: "companyProfile",
      label: "Company profile completed",
      done: companyProfile,
      stepId: "company",
    },
    {
      id: "employeeInvited",
      label: "At least one employee invited",
      done: employeeInvited,
      stepId: "invite",
    },
    {
      id: "mfaChosen",
      label: "MFA policy chosen",
      done: mfaChosen,
      stepId: "security",
    },
    {
      id: "retentionSet",
      label: "Retention default set",
      done: retentionSet,
      stepId: "retention",
    },
    {
      id: "firstEvidence",
      label: "First evidence captured",
      done: firstEvidence,
      stepId: "firstCapture",
    },
  ];
}

/** Count of completed checklist criteria (nulls are not complete). */
export function checklistProgress(
  criteria: ReadonlyArray<ChecklistCriterion>,
): { done: number; total: number } {
  return {
    done: criteria.filter((c) => c.done === true).length,
    total: criteria.length,
  };
}
