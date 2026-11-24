/**
 * SETTINGS OVERVIEW — the native port of the web's Settings landing pane.
 *
 *   apps/web/lib/settings/settingsUiContext.ts   (deriveSettingsUiContext)
 *   apps/web/lib/settings/settingsNavigation.ts  (which panes this actor gets)
 *   apps/web/lib/security/useAccountSecuritySummary.ts
 *   apps/web/app/(app)/settings/_sections/SettingsOverview.tsx
 *
 * Every figure comes from the canonical envelope (`GET /v1/platform/context`,
 * already fetched by `usePlatformContext` — Law of One) or from the same three
 * security reads the web summary makes. Authority is always a SERVER
 * projection (`capabilities.*`, `flags.isEnterpriseWorkspace`); plan strings
 * are display labels only, never a decision.
 *
 * Pure: no React, no fetch.
 */
import { describeUserAgent } from "./account-security";
import { asWorkspaceRole, planWordOf, resolveWorkspaceScope, WORKSPACE_ROLE_WORDS, type WorkspaceRole } from "./workspace-scope";

const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" ? (v as Record<string, unknown>) : {};
const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);
const rows = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

export type { WorkspaceRole };

export interface SettingsOverview {
  isPersonal: boolean;
  /** "Personal Workspace", the organization's name, a shared workspace's name, or "Your Team workspace". */
  workspaceName: string;
  /** "Organization", "Shared with you", "Team workspace" or "Personal space". */
  typeLabel: string;
  /** The viewer's role in the ACTIVE workspace; null in a solo personal space. */
  role: WorkspaceRole | null;
  roleLabel: string | null;
  billing: {
    contextType: "personal" | "organization" | "enterprise-contract";
    displayPlan: string;
    scopeLabel: string;
    /** True when the viewer may open billing for this context. */
    canOpenBilling: boolean;
    managedByOrgName: string | null;
  };
  /** Settings › Roles & permissions — (ORGANIZATION or a plan that sells collaboration) + SETTINGS_VIEW (T-110). */
  canViewRoles: boolean;
  /** Membership administration — ORGANIZATION + SETTINGS_MANAGE (settingsUiContext.showOrgAdminLinks). */
  canManageMembers: boolean;
  /** AI & assistance — hidden only for a personal plan whose allowance is 0. */
  showAiSettings: boolean;
  /** Reviewer criteria — only where reviewer operations are commercially included. */
  showReviewerCriteria: boolean;
  /** The role the Roles pane marks as "Your role" (the viewer's own role; OWNER only in their own space). */
  matrixRole: string | null;
}

/** An unknown plan is unknown — never shown as FREE (members ledger M15). */
function planLabel(plan: string | null): string {
  return plan ? plan.toUpperCase() : "—";
}

export function projectSettingsOverview(envelope: unknown): SettingsOverview {
  const env = obj(envelope);
  const active = obj(env.activeSpace);
  const caps = obj(env.capabilities);
  const flags = obj(env.flags);
  const planFeatures = obj(env.planFeatures);
  // T-109/T-110/T-111/T-116 — the one native workspace rule (workspace-scope.ts).
  // Team is a personal-workspace tier: nothing below keys a Team feature on
  // the ORGANIZATION kind.
  const scope = resolveWorkspaceScope(envelope);
  const isOrg = scope.kind === "ORGANIZATION";
  const isShared = scope.kind === "SHARED_PERSONAL";
  const activeId = str(active.id);

  const org = isOrg
    ? (rows(env.organizations)
        .map(obj)
        .find((o) => str(o.id) === activeId && o.membershipStatus === "ACTIVE") ?? null)
    : null;
  const orgName =
    str(org?.displayName) ?? str(org?.name) ?? str(active.displayName) ?? "your organization";
  // The viewer's OWN role: the org row's in an organization; the server's
  // `activeSpace.roleLabel` in a workspace shared with them (never Owner);
  // Owner in their own workspace once the plan sells collaboration (a solo
  // personal space on a plan without members has no roles to speak of).
  const role: WorkspaceRole | null = isOrg
    ? asWorkspaceRole(org?.role)
    : isShared
      ? scope.role
      : scope.collaborationIncluded
        ? "OWNER"
        : null;

  const canManageBilling = caps.BILLING_MANAGE === true;
  const isEnterprise = flags.isEnterpriseWorkspace === true;

  let billing: SettingsOverview["billing"];
  if (isOrg) {
    billing = {
      contextType: isEnterprise ? "enterprise-contract" : "organization",
      // The ACTIVE space's plan. (The web passes `personalSpace.plan` as its
      // "workspacePlan" here — page.tsx — which names the member's personal
      // plan inside an organization; that is a web defect, not copied.)
      displayPlan: planLabel(str(active.plan) ?? str(org?.plan)),
      scopeLabel: isEnterprise ? "Organization agreement" : "Organization plan",
      // An enterprise contract is sales-managed: no self-service billing action.
      canOpenBilling: canManageBilling && !isEnterprise,
      managedByOrgName: orgName,
    };
  } else if (isShared) {
    // T-111 — a member of someone else's workspace works under THAT
    // workspace's plan, which its owner pays; their own account plan is not it.
    billing = {
      contextType: "personal",
      displayPlan: planLabel(str(active.plan)),
      scopeLabel: "Workspace plan",
      canOpenBilling: canManageBilling,
      managedByOrgName: scope.name,
    };
  } else {
    const plan = str(obj(env.account).accountPlan) ?? str(obj(env.personalSpace).plan);
    const word = planWordOf(plan);
    billing = {
      contextType: "personal",
      displayPlan: planLabel(plan),
      // T-116 — a plan that sells collaboration is the plan of the owner's
      // workspace (members work under it), not a "Personal plan".
      scopeLabel: scope.collaborationIncluded && word ? `${word} plan on your workspace` : "Personal plan",
      canOpenBilling: canManageBilling,
      managedByOrgName: null,
    };
  }

  const allowance = planFeatures.aiAssistanceMonthlyOperations;
  const isPlatformAdmin = obj(env.platform).isPlatformAdmin === true;

  const collaborating = scope.kind === "OWN_COLLABORATIVE";
  return {
    isPersonal: !isOrg,
    workspaceName: isOrg ? orgName : (isShared || collaborating) && scope.name ? scope.name : "Personal Workspace",
    typeLabel: isOrg
      ? "Organization"
      : isShared
        ? "Shared with you"
        : collaborating
          ? `${scope.planWord ?? "Shared"} workspace`
          : "Personal space",
    role,
    roleLabel: role ? WORKSPACE_ROLE_WORDS[role] : null,
    billing,
    // T-110 — the Roles pane follows the plan feature, not the ORGANIZATION
    // kind: a Team workspace has members and therefore roles.
    canViewRoles: (isOrg || scope.collaborationIncluded) && caps.SETTINGS_VIEW === true,
    // M15 — a Personal Workspace on a plan with Collaboration Teams has
    // members too; its owner manages them exactly as the web shows.
    canManageMembers:
      caps.SETTINGS_MANAGE === true && (isOrg || planFeatures.teamCollaborationIncluded === true),
    showAiSettings: !(!isOrg && allowance === 0),
    // B2B-F-12 (Free-user audit 0ea0) — the web's gate: REVIEWER_OPS_VIEW (the API
    // gates every reviewer-criteria endpoint on review.queue.read), not a plan flag.
    showReviewerCriteria: isPlatformAdmin || caps.REVIEWER_OPS_VIEW === true,
    // T-111 — the column the Roles pane marks "Your role" is the viewer's
    // real role: OWNER only in their own workspace.
    matrixRole: isOrg ? str(active.roleLabel) : isShared ? scope.role : "OWNER",
  };
}

/* ------------------------------------------------ billing attention (PRO-N1-13) */

/**
 * PRO-N1-13 — the person's OWN paid plan needs attention, from the envelope's
 * `account.billingSignal` (the API's canonical lifecycle verdict). Null when
 * there is nothing to say, or on an API that predates the field. The same words
 * as the web shell banner (BillingAttentionBanner.tsx).
 */
export interface BillingAttention {
  state: "PAST_DUE" | "PAST_DUE_EXPIRED" | "LAPSED" | "CANCELLING";
  title: string;
  /** ISO date the sentence refers to (grace end / plan end), when known. */
  dateIso: string | null;
}

export function accountBillingAttention(envelope: unknown): BillingAttention | null {
  const signal = obj(obj(obj(envelope).account).billingSignal);
  const state = signal.state;
  if (state === "PAST_DUE") return { state, title: "Payment overdue", dateIso: str(signal.graceEndsAtUtc) };
  if (state === "PAST_DUE_EXPIRED") return { state, title: "Paid plan paused: payment overdue", dateIso: null };
  if (state === "LAPSED") return { state, title: "Paid plan needs attention", dateIso: null };
  if (state === "CANCELLING") return { state, title: "Your plan is set to end", dateIso: str(signal.endsAtUtc) };
  return null;
}

/** The sentence under the title; `formatDate` is the screen's own date formatter. */
export function billingAttentionLine(a: BillingAttention, formatDate: (iso: string) => string): string {
  switch (a.state) {
    case "PAST_DUE":
      return a.dateIso
        ? `We could not take your last payment. Your paid plan continues until ${formatDate(a.dateIso)} while it is retried; update your payment details on the web to keep it.`
        : "We could not take your last payment. Update your payment details on the web to keep your paid plan.";
    case "PAST_DUE_EXPIRED":
      return "Your last payment was not received and the grace period has ended, so paid actions are paused. Your records stay readable.";
    case "LAPSED":
      return "Your paid plan is no longer active, so paid actions are paused. Your records stay readable.";
    case "CANCELLING":
      return a.dateIso
        ? `Your subscription was cancelled and ends on ${formatDate(a.dateIso)}.`
        : "Your subscription was cancelled and ends at the end of the paid period.";
  }
}

/* ------------------------------------------------ security summary (web) */

export interface RecentSignIn {
  id: string;
  device: string;
  lastSeenAtIso: string;
  isCurrent: boolean;
}

export interface AccountSecuritySummary {
  /** null while loading or when the read failed. */
  mfaConfigured: boolean | null;
  loginMethods: string | null;
  activeSessions: number | null;
  /** The three most recently active sessions, newest first. */
  recentSignIns: RecentSignIn[];
}

export const EMPTY_SECURITY_SUMMARY: AccountSecuritySummary = {
  mfaConfigured: null,
  loginMethods: null,
  activeSessions: null,
  recentSignIns: [],
};

/**
 * `GET /v1/identity-security/my-sessions` → the recent list the web builds:
 * rows with a `lastSeenAtUtc`, newest first, three of them.
 */
export function recentSignInsFrom(payload: unknown): RecentSignIn[] {
  return rows(obj(payload).sessions)
    .map(obj)
    .filter((r) => typeof r.lastSeenAtUtc === "string")
    .sort((a, b) => ((a.lastSeenAtUtc as string) < (b.lastSeenAtUtc as string) ? 1 : -1))
    .slice(0, 3)
    .map((r, i) => ({
      id: str(r.id) ?? `session-${i}`,
      device: describeUserAgent(str(r.uaPreview)),
      lastSeenAtIso: r.lastSeenAtUtc as string,
      isCurrent: r.isCurrent === true,
    }));
}

export function sessionCountFrom(payload: unknown): number | null {
  const s = obj(payload).sessions;
  return Array.isArray(s) ? s.length : null;
}

/** `GET /v1/identity/mfa/factors` → `{ hasMfa }`. */
export function mfaConfiguredFrom(payload: unknown): boolean | null {
  const o = obj(payload);
  return Object.keys(o).length === 0 ? null : o.hasMfa === true;
}

/* ------------------------------------------------ preferences (web) */

/** The device's IANA timezone, or null when the runtime cannot resolve one. */
export function detectDeviceTimezone(): string | null {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return typeof tz === "string" && tz.trim().length > 0 ? tz.trim() : null;
  } catch {
    return null;
  }
}

/** Every IANA zone this runtime knows, or [] when it cannot list them. */
export function supportedTimezones(): string[] {
  try {
    const values = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.("timeZone");
    if (Array.isArray(values) && values.length > 0) return values;
  } catch {
    /* fall through */
  }
  return [];
}

/** "Berlin — Europe/Berlin", as the web's picker labels a zone. */
export function timezoneLabel(tz: string): string {
  const city = tz.split("/").pop()?.replace(/_/g, " ").trim();
  return city && city !== tz ? `${city} — ${tz}` : tz;
}

/** `GET/PATCH /v1/users/me` → `{ user: { timezone } }` (users.routes.ts pickMe). */
export function accountTimezoneFrom(payload: unknown): string | null {
  const tz = str(obj(obj(payload).user).timezone);
  return tz && tz.trim().length > 0 ? tz.trim() : null;
}
