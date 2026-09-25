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

const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" ? (v as Record<string, unknown>) : {};
const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);
const rows = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

export type WorkspaceRole = "OWNER" | "ADMIN" | "MEMBER" | "VIEWER";

export interface SettingsOverview {
  isPersonal: boolean;
  /** "Personal Space", or the organization's name. */
  workspaceName: string;
  /** The viewer's role in the ACTIVE organization; null in a personal space. */
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
  /** Settings › Roles & permissions — ORGANIZATION + SETTINGS_VIEW (settingsNavigation.ts). */
  canViewRoles: boolean;
  /** Membership administration — ORGANIZATION + SETTINGS_MANAGE (settingsUiContext.showOrgAdminLinks). */
  canManageMembers: boolean;
  /** AI & assistance — hidden only for a personal plan whose allowance is 0. */
  showAiSettings: boolean;
  /** Reviewer criteria — only where reviewer operations are commercially included. */
  showReviewerCriteria: boolean;
  /** The role the Roles pane marks as "Your role" (activeSpace.roleLabel; OWNER in a personal space). */
  matrixRole: string | null;
}

const ROLE_WORDS: Record<WorkspaceRole, string> = {
  OWNER: "Owner",
  ADMIN: "Admin",
  MEMBER: "Member",
  VIEWER: "Viewer",
};

function planLabel(plan: string | null): string {
  return (plan ?? "FREE").toUpperCase();
}

function asRole(v: unknown): WorkspaceRole | null {
  return v === "OWNER" || v === "ADMIN" || v === "MEMBER" || v === "VIEWER" ? v : null;
}

export function projectSettingsOverview(envelope: unknown): SettingsOverview {
  const env = obj(envelope);
  const active = obj(env.activeSpace);
  const caps = obj(env.capabilities);
  const flags = obj(env.flags);
  const planFeatures = obj(env.planFeatures);
  const isOrg = active.type === "ORGANIZATION";
  const activeId = str(active.id);

  const org = isOrg
    ? (rows(env.organizations)
        .map(obj)
        .find((o) => str(o.id) === activeId && o.membershipStatus === "ACTIVE") ?? null)
    : null;
  const orgName =
    str(org?.displayName) ?? str(org?.name) ?? str(active.displayName) ?? "your organization";
  const role = asRole(org?.role);

  const canManageBilling = caps.BILLING_MANAGE === true;
  const isEnterprise = flags.isEnterpriseWorkspace === true;

  const billing: SettingsOverview["billing"] = isOrg
    ? {
        contextType: isEnterprise ? "enterprise-contract" : "organization",
        // The ACTIVE space's plan. (The web passes `personalSpace.plan` as its
        // "workspacePlan" here — page.tsx — which names the member's personal
        // plan inside an organization; that is a web defect, not copied.)
        displayPlan: planLabel(str(active.plan) ?? str(org?.plan)),
        scopeLabel: isEnterprise ? "Organization agreement" : "Organization plan",
        // An enterprise contract is sales-managed: no self-service billing action.
        canOpenBilling: canManageBilling && !isEnterprise,
        managedByOrgName: orgName,
      }
    : {
        contextType: "personal",
        displayPlan: planLabel(str(obj(env.account).accountPlan) ?? str(obj(env.personalSpace).plan)),
        scopeLabel: "Personal plan",
        canOpenBilling: canManageBilling,
        managedByOrgName: null,
      };

  const allowance = planFeatures.aiAssistanceMonthlyOperations;
  const isPlatformAdmin = obj(env.platform).isPlatformAdmin === true;

  return {
    isPersonal: !isOrg,
    workspaceName: isOrg ? orgName : "Personal Space",
    role,
    roleLabel: role ? ROLE_WORDS[role] : null,
    billing,
    canViewRoles: isOrg && caps.SETTINGS_VIEW === true,
    canManageMembers: isOrg && caps.SETTINGS_MANAGE === true,
    showAiSettings: !(!isOrg && allowance === 0),
    showReviewerCriteria: isPlatformAdmin || planFeatures.reviewerOperationsIncluded === true,
    matrixRole: isOrg ? str(active.roleLabel) : "OWNER",
  };
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
