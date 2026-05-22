"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Bell,
  ChevronDown,
  LogOut,
  Menu,
  X,
  Settings,
  ShieldCheck,
  UserCircle,
  Users,
} from "lucide-react";
import { LanguageSwitcher } from "../language-switcher";
import { GlobalRuntimeIndicator } from "../operational";
import { useActiveWorkspaceId } from "../../lib/useActiveWorkspaceId";
import { apiFetch } from "../../lib/api";

/**
 * Phase 32.8B — Enterprise topbar (workspace vs account separation).
 *
 * The topbar splits its right-hand region into TWO independent
 * controls:
 *
 *   1. WORKSPACE CHIP — current workspace name, scope (personal vs
 *      team), workspace role. Clicking opens a switcher menu that
 *      lists the user's other workspaces. This region is
 *      WORKSPACE-context only — it does not contain account
 *      controls (profile / settings / sign out) and does not
 *      contain platform-admin shortcuts.
 *
 *   2. ACCOUNT CHIP — user identity (name + avatar + email).
 *      Clicking opens the account dropdown with profile,
 *      notifications, account settings, and sign out. This region
 *      is ACCOUNT-context only — it does not contain workspace
 *      controls.
 *
 * The two regions are visually and behaviourally independent: they
 * each manage their own open/closed state, focus, and click-outside
 * handling.
 *
 * Phase 32.8B no longer renders the deprecated horizontal top-nav
 * (Workspace / Capture / Evidence / Cases / Teams / Reports /
 * Billing / Settings). All primary navigation lives in the
 * sidebar — this matches Phase 32.8A's information architecture
 * and removes the duplicated navigation entries audit finding.
 */

export type AppShellUserV2 = {
  email?: string | null;
  displayName?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  avatarUrl?: string | null;
  platformRole?: string | null;
};

type WorkspaceSummary = {
  id: string;
  name: string;
  role: string | null;
  /** Bounded canonical scope label, derived from team type. */
  scope: "PERSONAL" | "TEAM";
};

type TeamsListResponse = {
  items?: ReadonlyArray<{
    id?: string | null;
    name?: string | null;
    role?: string | null;
    type?: string | null;
    personal?: boolean | null;
  }>;
};

function classifyScope(raw: {
  type?: string | null;
  personal?: boolean | null;
}): "PERSONAL" | "TEAM" {
  if (raw.personal === true) return "PERSONAL";
  if (typeof raw.type === "string" && raw.type.toUpperCase() === "PERSONAL") {
    return "PERSONAL";
  }
  return "TEAM";
}

function getUserDisplayName(user: AppShellUserV2 | null) {
  const fullName = [user?.firstName, user?.lastName]
    .filter(Boolean)
    .join(" ")
    .trim();
  return fullName || user?.displayName || user?.email || "Account";
}

function getInitials(user: AppShellUserV2 | null) {
  const name = getUserDisplayName(user);
  const parts = name.split(/[.\s@_-]+/).filter(Boolean);
  return (
    parts
      .slice(0, 2)
      .map((part) => part[0]?.toUpperCase())
      .join("") || "P"
  );
}

export function AppTopbarV2({
  user,
  onLogout,
  isPlatformAdmin = false,
  mobileSidebarOpen = false,
  onToggleMobileSidebar,
}: {
  user: AppShellUserV2 | null;
  onLogout: () => void;
  isPlatformAdmin?: boolean;
  mobileSidebarOpen?: boolean;
  onToggleMobileSidebar?: () => void;
}) {
  const pathname = usePathname();
  const [accountOpen, setAccountOpen] = useState(false);
  const [workspaceOpen, setWorkspaceOpen] = useState(false);
  const accountRef = useRef<HTMLDivElement | null>(null);
  const workspaceRef = useRef<HTMLDivElement | null>(null);

  // Workspace-context: ID + role come from the canonical hook.
  const workspace = useActiveWorkspaceId();
  const runtimeTeamId =
    workspace.status === "ready" ? workspace.workspaceId : null;

  // Workspace switcher data — populated on mount, refreshed when
  // the active workspace ID changes.
  const [workspaceList, setWorkspaceList] = useState<
    ReadonlyArray<WorkspaceSummary>
  >([]);
  const [activeWorkspaceName, setActiveWorkspaceName] = useState<string | null>(
    null,
  );
  const [activeWorkspaceScope, setActiveWorkspaceScope] = useState<
    "PERSONAL" | "TEAM" | null
  >(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const teams = (await apiFetch("/v1/teams", {
          method: "GET",
        })) as TeamsListResponse;
        if (cancelled) return;
        const list: WorkspaceSummary[] = (teams.items ?? [])
          .filter(
            (t): t is { id: string; name?: string | null; role?: string | null; type?: string | null; personal?: boolean | null } =>
              typeof t.id === "string" && t.id.length > 0,
          )
          .map((t) => ({
            id: t.id,
            name: typeof t.name === "string" && t.name ? t.name : t.id,
            role: typeof t.role === "string" ? t.role : null,
            scope: classifyScope({ type: t.type, personal: t.personal }),
          }));
        setWorkspaceList(list);
        if (runtimeTeamId) {
          const match = list.find((w) => w.id === runtimeTeamId);
          setActiveWorkspaceName(match?.name ?? null);
          setActiveWorkspaceScope(match?.scope ?? null);
        }
      } catch {
        // non-fatal; the chip falls back to the workspace id.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [runtimeTeamId]);

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

  // Close both menus on route change so we don't leak state across
  // navigation.
  useEffect(() => {
    setAccountOpen(false);
    setWorkspaceOpen(false);
  }, [pathname]);

  const workspaceRole =
    workspace.status === "ready" ? workspace.role ?? null : null;

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
              data-workspace-id={runtimeTeamId ?? ""}
            >
              <span
                className="app-topbar-v2-workspace-icon"
                aria-hidden="true"
              >
                <Users size={16} strokeWidth={1.9} />
              </span>
              <div className="app-topbar-v2-workspace-copy">
                <strong data-workspace-name>
                  {activeWorkspaceName ??
                    (workspace.status === "ready"
                      ? workspace.workspaceId
                      : workspace.status === "no-workspace"
                        ? "No workspace"
                        : "Loading workspace…")}
                </strong>
                <span data-workspace-scope-line>
                  {activeWorkspaceScope === "PERSONAL"
                    ? "Personal"
                    : activeWorkspaceScope === "TEAM"
                      ? `Team${workspaceRole ? ` • ${workspaceRole}` : ""}`
                      : workspaceRole
                        ? `Workspace • ${workspaceRole}`
                        : "Workspace"}
                </span>
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
                  <span>
                    {workspaceList.length} available
                  </span>
                </div>
                {workspaceList.length === 0 ? (
                  <div
                    className="app-topbar-v2-workspace-menu-empty"
                    data-workspace-menu-empty
                  >
                    No other workspaces.
                  </div>
                ) : (
                  workspaceList.map((w) => (
                    <Link
                      key={w.id}
                      href={`/teams?activate=${encodeURIComponent(w.id)}`}
                      role="menuitem"
                      onClick={() => setWorkspaceOpen(false)}
                      data-workspace-option={w.id}
                      className={
                        w.id === runtimeTeamId
                          ? "app-topbar-v2-workspace-menu-item is-active"
                          : "app-topbar-v2-workspace-menu-item"
                      }
                    >
                      <Users size={14} strokeWidth={1.9} />
                      <span style={{ flex: 1 }}>{w.name}</span>
                      <small data-workspace-scope-chip={w.scope}>
                        {w.scope === "PERSONAL" ? "Personal" : "Team"}
                      </small>
                    </Link>
                  ))
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

          {/* ACCOUNT chip — account context only. Strictly NO
              workspace controls; strictly NO platform-admin
              shortcuts (those live in the sidebar's
              Administration group). */}
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
              {user?.avatarUrl ? (
                <img
                  src={user.avatarUrl}
                  alt=""
                  className="app-topbar-v2-avatar"
                />
              ) : (
                <div className="app-topbar-v2-avatar-fallback">
                  {getInitials(user)}
                </div>
              )}

              <div className="app-topbar-v2-user-copy">
                <strong>{getUserDisplayName(user)}</strong>
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
                  <strong>{getUserDisplayName(user)}</strong>
                  <span>{user?.email ?? "Signed in account"}</span>
                </div>

                <Link
                  href="/settings"
                  role="menuitem"
                  onClick={() => setAccountOpen(false)}
                  data-account-menu-item="profile"
                >
                  <UserCircle size={16} strokeWidth={1.9} />
                  Profile
                </Link>

                <Link
                  href="/notifications"
                  role="menuitem"
                  onClick={() => setAccountOpen(false)}
                  data-account-menu-item="notifications"
                >
                  <Bell size={16} strokeWidth={1.9} />
                  Notifications
                </Link>

                <Link
                  href="/settings"
                  role="menuitem"
                  onClick={() => setAccountOpen(false)}
                  data-account-menu-item="settings"
                >
                  <Settings size={16} strokeWidth={1.9} />
                  Account settings
                </Link>

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
