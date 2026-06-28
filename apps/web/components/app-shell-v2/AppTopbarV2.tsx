"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Bell,
  ChevronDown,
  CreditCard,
  HelpCircle,
  LogOut,
  Menu,
  X,
  Settings,
  ShieldCheck,
  UserCircle,
  Users,
  type LucideProps,
} from "lucide-react";
import type { ForwardRefExoticComponent, RefAttributes } from "react";
import { LanguageSwitcher } from "../language-switcher";
import { GlobalRuntimeIndicator } from "../operational";
import { InboxIndicator } from "./InboxIndicator";
import {
  usePlatformContext,
  workflowFromPersona,
} from "../../lib/platform-context";
// Phase IA-surface-tier-pricing — Organizations are ENTERPRISE_ONLY.
// FREE/PAYG/PRO/TEAM users must NOT see the Organizations group, the
// "Create / Join / Manage organization" actions, or the empty-state
// hint in the workspace switcher. Self-serve users manage
// collaboration through /teams only.
import { canAccessSurface } from "../../lib/surface/access";
import { useSurfaceUserContext } from "../../lib/surface/useSurfaceUserContext";

/**
 * Phase 32.8 Foundation — Canonical enterprise topbar.
 *
 * EVERY field rendered by this component comes from the canonical
 * PlatformContextEnvelope via `usePlatformContext()`. No more
 * `/v1/users/me` or `/v1/teams` fetches. No more hardcoded "Member"
 * fallback. No more raw workspace UUID leaks.
 *
 * Hard rules — enforced by F-6 grep tests:
 *
 *   1. NO `apiFetch(...)` call in this file.
 *   2. NO `useActiveWorkspaceId` import (the legacy hook is now a
 *      thin alias and is forbidden from new shell components).
 *   3. NO literal `"Member"` / `"Owner"` role fallback. The role
 *      string is read verbatim from `envelope.workspace.membership.role`
 *      or rendered as `null` / role-unavailable.
 *   4. NO local platformRole derivation. We read
 *      `envelope.platform.isPlatformAdmin`.
 *   5. Workspace switching uses `ctx.switchWorkspace(id)`, which
 *      drives the atomic state machine in the provider.
 */

type LucideIcon = ForwardRefExoticComponent<
  Omit<LucideProps, "ref"> & RefAttributes<SVGSVGElement>
>;

const ACCOUNT_MENU_ICONS: Record<string, LucideIcon> = {
  profile: UserCircle,
  notifications: Bell,
  settings: Settings,
  billing: CreditCard,
  teams: Users,
  support: HelpCircle,
};

function AccountMenuIcon({ iconKey }: { iconKey: string }) {
  const Icon = ACCOUNT_MENU_ICONS[iconKey] ?? UserCircle;
  return <Icon size={16} strokeWidth={1.9} />;
}

function getUserDisplayName(envelope: ReturnType<typeof usePlatformContext>["envelope"]) {
  const user = envelope?.user;
  const fullName = [user?.firstName, user?.lastName]
    .filter(Boolean)
    .join(" ")
    .trim();
  return fullName || user?.displayName || user?.email || "Account";
}

function getInitials(envelope: ReturnType<typeof usePlatformContext>["envelope"]) {
  const name = getUserDisplayName(envelope);
  const parts = name.split(/[.\s@_-]+/).filter(Boolean);
  return (
    parts
      .slice(0, 2)
      .map((part) => part[0]?.toUpperCase())
      .join("") || "P"
  );
}

/**
 * Canonical workspace label. NEVER displays the raw workspace UUID.
 *
 *   - If the workspace has a name, use it.
 *   - Otherwise use the bounded scope label ("Personal workspace" /
 *     "Team workspace").
 *   - While loading, render a quiet placeholder — not "Member".
 */
function getWorkspaceLabels(
  envelope: ReturnType<typeof usePlatformContext>["envelope"],
  state: ReturnType<typeof usePlatformContext>["state"],
): { name: string; scopeLine: string } {
  if (!envelope) {
    if (state.name === "LOADING_CONTEXT") {
      return { name: "Loading workspace…", scopeLine: "Resolving" };
    }
    if (state.name === "FAILED") {
      return { name: "Workspace unavailable", scopeLine: "Tap to retry" };
    }
    return { name: "Workspace", scopeLine: "Loading" };
  }

  // ENTERPRISE TENANT MODEL — prefer the canonical `activeSpace` field. The
  // legacy `workspace` field stays as a fallback for older envelopes during
  // the additive-migration window.
  const active = envelope.activeSpace;
  if (active) {
    if (active.type === "PERSONAL") {
      return { name: "Personal Space", scopeLine: "Personal • Owner" };
    }
    const roleLabel = active.roleLabel;
    return {
      name: active.displayName ?? "Organization workspace",
      scopeLine: roleLabel
        ? `Organization • ${roleLabel}`
        : "Organization • Role unavailable",
    };
  }

  // Fallback to the deprecated `workspace` shape.
  const { workspace } = envelope;
  const scope = workspace.scope;
  const name =
    workspace.name ??
    (scope === "PERSONAL" ? "Personal Space" : "Organization workspace");
  const role = workspace.membership.role;
  const scopeLine =
    scope === "PERSONAL"
      ? "Personal • Owner"
      : role
        ? `Organization • ${role}`
        : "Organization • Role unavailable";
  return { name, scopeLine };
}

export function AppTopbarV2({
  onLogout,
  mobileSidebarOpen = false,
  onToggleMobileSidebar,
}: {
  onLogout: () => void;
  mobileSidebarOpen?: boolean;
  onToggleMobileSidebar?: () => void;
}) {
  const pathname = usePathname();
  const ctx = usePlatformContext();
  const { envelope, state, switchWorkspace } = ctx;

  const [accountOpen, setAccountOpen] = useState(false);
  const [workspaceOpen, setWorkspaceOpen] = useState(false);
  const accountRef = useRef<HTMLDivElement | null>(null);
  const workspaceRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      if (!accountRef.current?.contains(event.target as Node)) {
        setAccountOpen(false);
      }
      if (!workspaceRef.current?.contains(event.target as Node)) {
        setWorkspaceOpen(false);
      }
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, []);

  // Close both menus on route change so we don't leak state across navigation.
  useEffect(() => {
    setAccountOpen(false);
    setWorkspaceOpen(false);
  }, [pathname]);

  const isPlatformAdmin = envelope?.platform.isPlatformAdmin === true;
  // Phase IA-surface-tier-pricing — gate the org switcher actions on
  // ENTERPRISE-tier eligibility. The same predicate that hides
  // /organizations from the sidebar hides the Organizations group +
  // Create / Join / Manage organization actions from the topbar
  // switcher. Self-serve plans see only their personal workspace +
  // /teams.
  const surfaceUserCtx = useSurfaceUserContext();
  const canSeeOrganizations = canAccessSurface(
    surfaceUserCtx,
    "/organizations",
  );
  const runtimeTeamId =
    envelope?.workspace.status === "active" && envelope.workspace.scope === "TEAM"
      ? envelope.workspace.id
      : null;

  const { name: workspaceName, scopeLine } = getWorkspaceLabels(envelope, state);
  // ENTERPRISE TENANT MODEL — render the switcher from the canonical
  // sections. The legacy `availableWorkspaces` is no longer the source of
  // truth; the new fields are.
  const personalSpace = envelope?.personalSpace ?? null;
  const organizations = envelope?.organizations ?? [];
  const activeSpace = envelope?.activeSpace ?? null;
  const totalSwitchable =
    (personalSpace?.id ? 1 : 0) + organizations.length;

  return (
<div className="app-floating-account-bar">
      <div className="app-topbar-v2-inner">
        <button
          type="button"
          className="app-topbar-v2-mobile-menu"
          onClick={onToggleMobileSidebar}
          aria-label={mobileSidebarOpen ? "Close navigation" : "Open navigation"}
        >
          {mobileSidebarOpen ? <X size={22} /> : <Menu size={22} />}
        </button>

        <Link
          href="/home"
          className="app-topbar-v2-brand"
          aria-label="PROOVRA home"
        >
          <span className="app-topbar-v2-brand-icon-wrap">
            <img
              src="/brand/icon-512.png?v=2"
              alt=""
              className="app-topbar-v2-brand-icon"
            />
          </span>
          <span className="app-topbar-v2-brand-name">PROO✓RA</span>
        </Link>

        <div className="app-topbar-v2-actions">
          <div
            className="app-topbar-v2-runtime"
            data-app-topbar-runtime
            style={{ display: "inline-flex", alignItems: "center" }}
          >
            <GlobalRuntimeIndicator teamId={runtimeTeamId} />
          </div>
          {/* Phase C2 — bounded inbox / mention indicator. Polls
              /v1/me/inbox/summary on a slow interval and deep-links to
              the canonical inbox surface. Workspace-scoped server-side. */}
          <InboxIndicator />
          <div className="app-topbar-v2-language">
            <LanguageSwitcher />
          </div>

          {/* WORKSPACE chip — workspace context only. */}
          <div
            className="app-topbar-v2-workspace"
            data-app-topbar-workspace
            data-platform-state={state.name}
            ref={workspaceRef}
          >
            <button
              type="button"
              className={`app-topbar-v2-workspace-button ${
                workspaceOpen ? "is-open" : ""
              }`}
              onClick={() => {
                setWorkspaceOpen((prev) => !prev);
                setAccountOpen(false);
              }}
              aria-haspopup="menu"
              aria-expanded={workspaceOpen}
              data-workspace-id={envelope?.workspace.id ?? ""}
              data-workspace-scope={envelope?.workspace.scope ?? ""}
            >
              <span
                className="app-topbar-v2-workspace-icon"
                aria-hidden="true"
              >
                <Users size={16} strokeWidth={1.9} />
              </span>
              <div className="app-topbar-v2-workspace-copy">
                <strong data-workspace-name>{workspaceName}</strong>
                <span data-workspace-scope-line>{scopeLine}</span>
              </div>
              {/* Phase 38.3 — workflow chip. Internal persona enum mapped
                  to a workflow-oriented label. UX-only; never gates features. */}
              {envelope?.personaProfile?.primaryProfile &&
              envelope.personaProfile.primaryProfile !== "INDIVIDUAL" ? (
                (() => {
                  const wf = workflowFromPersona(
                    envelope.personaProfile.primaryProfile,
                  );
                  return (
                    <span
                      data-app-topbar-persona={envelope.personaProfile.primaryProfile}
                      data-app-topbar-workflow={wf.code}
                      title={`Workflow profile: ${wf.label}`}
                      style={{
                        marginLeft: 8,
                        padding: "2px 8px",
                        fontSize: 10,
                        fontWeight: 600,
                        letterSpacing: 0.4,
                        borderRadius: 999,
                        background: "#eef2ff",
                        color: "#3730a3",
                        border: "1px solid #c7d2fe",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {wf.label}
                    </span>
                  );
                })()
              ) : null}
              <ChevronDown size={14} strokeWidth={1.9} />
            </button>

            {workspaceOpen ? (
              <div
                className="app-topbar-v2-workspace-menu"
                role="menu"
                data-app-topbar-workspace-menu
              >
                <div className="app-topbar-v2-workspace-menu-header">
                  <strong>Switch space</strong>
                  <span data-workspace-menu-count>
                    {totalSwitchable <= 1
                      ? "Only Personal Space"
                      : `${totalSwitchable} spaces`}
                  </span>
                </div>
                {/* Phase G0 (B0.3) — workspace switcher explainer. The
                    enterprise tenant model is intentionally minimal:
                    a Workspace is the operational unit; an
                    Organization is the optional governance overlay.
                    The block is suppressed for solo personal-only
                    accounts to avoid org-shaped noise. */}
                {organizations.length > 0 || personalSpace?.id ? (
<div
  className="app-topbar-v2-workspace-menu-help"
  data-workspace-menu-help
>
<strong>
                        Workspace vs Organization
                    </strong>
                    Workspace = where evidence work happens.
                    {organizations.length > 0
                      ? " Organization = governance over one or more Workspaces."
                      : ""}{" "}
                    <Link
                      href="/about/trust"
                      data-workspace-menu-help-link
                      onClick={() => setWorkspaceOpen(false)}
                    >
                      Learn more
                    </Link>
                  </div>
                ) : null}
                {/* Phase G0 (B0.3) — degraded-context recovery banner.
                    When the platform-context provider is in FAILED
                    state, surface an explicit recovery action inside
                    the switcher rather than a silently-blank shell. */}
                {state.name === "FAILED" ? (
                  <div
                    className="app-topbar-v2-workspace-menu-degraded"
                    data-workspace-menu-degraded
                    role="alert"
                    style={{
                      padding: "8px 12px",
                      background: "#fef2f2",
                      borderBottom: "1px solid #fecaca",
                      fontSize: 12,
                      color: "#7f1d1d",
                    }}
                  >
                    <strong style={{ display: "block" }}>
                      Workspace context unavailable
                    </strong>
                    Reload the page or contact support if the issue
                    persists.
                  </div>
                ) : null}

                {/* ENTERPRISE TENANT MODEL — Personal Space group.
                    Exactly one entry. Never labeled TEAM. Never under
                    Organizations. */}
                {personalSpace?.id ? (
                  <div
                    className="app-topbar-v2-workspace-menu-group"
                    data-workspace-menu-group="PERSONAL"
                  >
                    <div
                      className="app-topbar-v2-workspace-menu-group-label"
                      data-workspace-menu-group-label
                    >
                      Personal
                    </div>
                    {(() => {
                      const isActive = activeSpace?.type === "PERSONAL";
                      return (
                        <button
                          key={personalSpace.id}
                          type="button"
                          role="menuitem"
                          onClick={() => {
                            setWorkspaceOpen(false);
                            // Switch to personal by passing the real
                            // personal Team id. Provider state machine
                            // handles the transition.
                            void switchWorkspace(personalSpace.id);
                          }}
                          data-workspace-option={personalSpace.id}
                          data-personal-space-option
                          aria-current={isActive ? "true" : undefined}
                          className={
                            isActive
                              ? "app-topbar-v2-workspace-menu-item is-active"
                              : "app-topbar-v2-workspace-menu-item"
                          }
                        >
                          <UserCircle size={14} strokeWidth={1.9} />
<div className="app-topbar-v2-workspace-menu-item-copy">
                              <span data-workspace-option-name>Personal Space</span>
<small>Owner</small>
                          </div>
                          <small data-workspace-scope-chip="PERSONAL">
                            Personal
                          </small>
                        </button>
                      );
                    })()}
                  </div>
                ) : null}

                {/* ENTERPRISE TENANT MODEL — Organizations group.
                    Strictly excludes isPersonal=true rows.
                    Phase IA-surface-tier-pricing — gated on ENTERPRISE
                    eligibility (canSeeOrganizations). Self-serve plans
                    never render this block, so an org left over from a
                    historical enterprise downgrade does not surface. */}
                {canSeeOrganizations && organizations.length > 0 ? (
                  <div
                    className="app-topbar-v2-workspace-menu-group"
                    data-workspace-menu-group="ORGANIZATIONS"
                  >
                    <div
                      className="app-topbar-v2-workspace-menu-group-label"
                      data-workspace-menu-group-label
                    >
                      Organizations
                    </div>
                    {organizations.map((org) => {
                      const isActive =
                        activeSpace?.type === "ORGANIZATION" &&
                        activeSpace.id === org.id;
                      return (
                        <button
                          key={org.id}
                          type="button"
                          role="menuitem"
                          onClick={() => {
                            setWorkspaceOpen(false);
                            void switchWorkspace(org.id);
                          }}
                          data-workspace-option={org.id}
                          data-organization-option
                          aria-current={isActive ? "true" : undefined}
                          className={
                            isActive
                              ? "app-topbar-v2-workspace-menu-item is-active"
                              : "app-topbar-v2-workspace-menu-item"
                          }
                        >
                          <Users size={14} strokeWidth={1.9} />
<div className="app-topbar-v2-workspace-menu-item-copy">
                              <span
                              data-workspace-option-name
                              style={{
                                overflow: "hidden",
                                textOverflow: "ellipsis",
                                whiteSpace: "nowrap",
                              }}
                            >
                              {org.displayName ??
                                org.name ??
                                "Organization workspace"}
                            </span>
                            {org.role ? (
<small>{org.role}</small>
                            ) : null}
                          </div>
                          <small data-workspace-scope-chip="TEAM">
                            Organization
                          </small>
                        </button>
                      );
                    })}
                  </div>
                ) : null}

                {/* Phase IA-surface-tier-pricing — empty-state hint
                    visible only when Organizations are reachable for
                    this user (ENTERPRISE tier). Self-serve users do
                    not see the "no organizations" copy because
                    organizations are not part of their plan. */}
                {canSeeOrganizations && organizations.length === 0 ? (
                  <div
                    className="app-topbar-v2-workspace-menu-empty"
                    data-workspace-menu-empty
                  >
                    You don't have any organizations yet.
                  </div>
                ) : null}

                {/* ENTERPRISE TENANT MODEL — Actions section.
                    Phase IA-surface-tier-pricing — gated. FREE/PAYG/PRO/
                    TEAM users do NOT see the Create / Join / Manage
                    organization actions because Organizations are
                    ENTERPRISE_ONLY per the pricing page. */}
                {canSeeOrganizations ? (
                <div
                  className="app-topbar-v2-workspace-menu-group"
                  data-workspace-menu-group="ACTIONS"
                >
                  <div
                    className="app-topbar-v2-workspace-menu-group-label"
                    data-workspace-menu-group-label
                  >
                    Actions
                  </div>
                  <Link
                    href="/workspaces?action=create"
                    role="menuitem"
                    onClick={() => setWorkspaceOpen(false)}
                    data-workspace-action="create_organization"
                    style={{ padding: "8px 12px", display: "block" }}
                  >
                    Create organization
                  </Link>
                  <Link
                    href="/workspaces?action=join"
                    role="menuitem"
                    onClick={() => setWorkspaceOpen(false)}
                    data-workspace-action="join_organization"
                    style={{ padding: "8px 12px", display: "block" }}
                  >
                    Join organization
                  </Link>
                  <Link
                    href="/workspaces"
                    role="menuitem"
                    onClick={() => setWorkspaceOpen(false)}
                    data-workspace-action="manage_organizations"
                    style={{ padding: "8px 12px", display: "block" }}
                  >
                    Manage organizations →
                  </Link>
                </div>
                ) : null}
              </div>
            ) : null}
          </div>

          {/* ACCOUNT chip — account context only. */}
          <div
            className="app-topbar-v2-account"
            data-app-topbar-account
            ref={accountRef}
          >
            <button
              type="button"
              className={`app-topbar-v2-user ${accountOpen ? "is-open" : ""}`}
              onClick={() => {
                setAccountOpen((prev) => !prev);
                setWorkspaceOpen(false);
              }}
              aria-haspopup="menu"
              aria-expanded={accountOpen}
            >
              {envelope?.user.avatarUrl ? (
                <img
                  src={envelope.user.avatarUrl}
                  alt=""
                  className="app-topbar-v2-avatar"
                />
              ) : (
                <div className="app-topbar-v2-avatar-fallback">
                  {getInitials(envelope)}
                </div>
              )}

              <div className="app-topbar-v2-user-copy">
                <strong>{getUserDisplayName(envelope)}</strong>
                <span>
                  {isPlatformAdmin ? (
                    <>
                      <ShieldCheck size={12} strokeWidth={2} />
                      Platform admin
                    </>
                  ) : (
                    "Account"
                  )}
                </span>
              </div>

              <ChevronDown size={16} strokeWidth={1.9} />
            </button>

            {accountOpen ? (
              <div
                className="app-topbar-v2-account-menu"
                role="menu"
                data-app-topbar-account-menu
              >
                <div className="app-topbar-v2-account-menu-header">
                  <strong>{getUserDisplayName(envelope)}</strong>
                  <span>{envelope?.user.email ?? "Signed in account"}</span>
                </div>

                {/* Phase ROUTE-FIX — the account menu reads its items
                    from the canonical envelope's
                    `navigation.accountMenu.items`. Pricing, Billing,
                    Teams (create-entry), and Help & Support are now
                    surfaced here for every authenticated user
                    regardless of workspace scope. */}
                {(envelope?.navigation.accountMenu.items ?? []).map((item) => (
                  <Link
                    key={item.id}
                    href={item.href}
                    role="menuitem"
                    onClick={() => setAccountOpen(false)}
                    data-account-menu-item={item.id}
                    data-account-menu-item-domain={item.domain}
                  >
                    <AccountMenuIcon iconKey={item.iconKey} />
                    {item.label}
                  </Link>
                ))}

                <button
                  type="button"
                  role="menuitem"
                  onClick={onLogout}
                  className="app-user-menu-signout"
                  data-account-menu-item="signout"
                >
                  <LogOut size={16} strokeWidth={1.9} />
                  Sign out
                </button>
              </div>
            ) : null}
          </div>
        </div>
      </div>
</div>
  );
}
