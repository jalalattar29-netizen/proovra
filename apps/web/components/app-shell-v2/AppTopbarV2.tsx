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
import { usePlatformContext } from "../../lib/platform-context";

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

  const { workspace } = envelope;
  const scope = workspace.scope;

  const name =
    workspace.name ??
    (scope === "PERSONAL"
      ? "Personal workspace"
      : scope === "TEAM"
        ? "Team workspace"
        : "Active workspace");

  // Role is the verbatim envelope value. If null, the scope line
  // reports "Role unavailable" — NEVER substitute "Member".
  const role = workspace.membership.role;
  const scopeLine =
    scope === "PERSONAL"
      ? role
        ? `Personal • ${role}`
        : "Personal"
      : scope === "TEAM"
        ? role
          ? `Team • ${role}`
          : "Team • Role unavailable"
        : role ?? "Role unavailable";

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
  const runtimeTeamId =
    envelope?.workspace.status === "active" && envelope.workspace.scope === "TEAM"
      ? envelope.workspace.id
      : null;

  const { name: workspaceName, scopeLine } = getWorkspaceLabels(envelope, state);
  const availableWorkspaces = envelope?.availableWorkspaces ?? [];

  return (
    <header className="app-topbar-v2">
      <div className="app-topbar-v2-bg" />

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
              <ChevronDown size={14} strokeWidth={1.9} />
            </button>

            {workspaceOpen ? (
              <div
                className="app-topbar-v2-workspace-menu"
                role="menu"
                data-app-topbar-workspace-menu
              >
                <div className="app-topbar-v2-workspace-menu-header">
                  <strong>Switch workspace</strong>
                  <span data-workspace-menu-count>
                    {availableWorkspaces.length <= 1
                      ? "Only this workspace"
                      : `${availableWorkspaces.length} workspaces`}
                  </span>
                </div>
                {availableWorkspaces.length <= 1 ? (
                  <div
                    className="app-topbar-v2-workspace-menu-empty"
                    data-workspace-menu-empty
                  >
                    You only have access to this workspace. Create or join a
                    team workspace to switch from here.
                  </div>
                ) : (
                  <>
                    {(["PERSONAL", "TEAM"] as const).map((groupScope) => {
                      const items = availableWorkspaces.filter(
                        (w) => w.scope === groupScope,
                      );
                      if (items.length === 0) return null;
                      return (
                        <div
                          key={groupScope}
                          className="app-topbar-v2-workspace-menu-group"
                          data-workspace-menu-group={groupScope}
                        >
                          <div
                            className="app-topbar-v2-workspace-menu-group-label"
                            data-workspace-menu-group-label
                          >
                            {groupScope === "PERSONAL"
                              ? "Personal workspace"
                              : "Team workspaces"}
                          </div>
                          {items.map((w) => {
                            const isActive =
                              groupScope === "PERSONAL"
                                ? envelope?.workspace.scope === "PERSONAL"
                                : w.id === envelope?.workspace.id;
                            const targetWorkspaceId =
                              groupScope === "PERSONAL" ? null : w.id;
                            return (
                              <button
                                key={w.id}
                                type="button"
                                role="menuitem"
                                onClick={() => {
                                  setWorkspaceOpen(false);
                                  void switchWorkspace(targetWorkspaceId);
                                }}
                                data-workspace-option={w.id}
                                aria-current={isActive ? "true" : undefined}
                                className={
                                  isActive
                                    ? "app-topbar-v2-workspace-menu-item is-active"
                                    : "app-topbar-v2-workspace-menu-item"
                                }
                                style={{
                                  display: "flex",
                                  alignItems: "center",
                                  gap: 8,
                                  width: "100%",
                                  border: "none",
                                  background: "transparent",
                                  cursor: "pointer",
                                  padding: "8px 12px",
                                  textAlign: "left",
                                }}
                              >
                                <Users size={14} strokeWidth={1.9} />
                                <div
                                  style={{
                                    flex: 1,
                                    display: "flex",
                                    flexDirection: "column",
                                    gap: 2,
                                    minWidth: 0,
                                  }}
                                >
                                  <span
                                    data-workspace-option-name
                                    style={{
                                      overflow: "hidden",
                                      textOverflow: "ellipsis",
                                      whiteSpace: "nowrap",
                                    }}
                                  >
                                    {w.name ??
                                      (w.scope === "PERSONAL"
                                        ? "Personal workspace"
                                        : "Team workspace")}
                                  </span>
                                  {w.role ? (
                                    <small
                                      data-workspace-option-role
                                      style={{ opacity: 0.7 }}
                                    >
                                      {w.role}
                                    </small>
                                  ) : null}
                                </div>
                                <small data-workspace-scope-chip={w.scope}>
                                  {w.scope === "PERSONAL" ? "Personal" : "Team"}
                                </small>
                              </button>
                            );
                          })}
                        </div>
                      );
                    })}
                  </>
                )}
                <div className="app-topbar-v2-workspace-menu-footer">
                  <Link
                    href="/teams"
                    role="menuitem"
                    onClick={() => setWorkspaceOpen(false)}
                  >
                    Manage teams →
                  </Link>
                </div>
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
    </header>
  );
}
