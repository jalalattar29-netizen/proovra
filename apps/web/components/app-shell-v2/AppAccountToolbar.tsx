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
  Settings,
  ShieldCheck,
  UserCircle,
  Users,
  X,
  type LucideProps,
} from "lucide-react";
import type { ForwardRefExoticComponent, RefAttributes } from "react";

import { LanguageSwitcher } from "../language-switcher";
import { InboxIndicator } from "./InboxIndicator";
import { GlobalRuntimeIndicator } from "../operational";
import { usePlatformContext } from "../../lib/platform-context";
import { canAccessSurface } from "../../lib/surface/access";
import { useSurfaceUserContext } from "../../lib/surface/useSurfaceUserContext";

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

function getUserDisplayName(
  envelope: ReturnType<typeof usePlatformContext>["envelope"],
) {
  const user = envelope?.user;
  const fullName = [user?.firstName, user?.lastName]
    .filter(Boolean)
    .join(" ")
    .trim();

  return fullName || user?.displayName || user?.email || "Account";
}

function getInitials(
  envelope: ReturnType<typeof usePlatformContext>["envelope"],
) {
  const name = getUserDisplayName(envelope);
  const parts = name.split(/[.\s@_-]+/).filter(Boolean);

  return (
    parts
      .slice(0, 2)
      .map((part) => part[0]?.toUpperCase())
      .join("") || "P"
  );
}

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

  const active = envelope.activeSpace;

  if (active) {
    if (active.type === "PERSONAL") {
      return { name: "Personal Space", scopeLine: "Personal • Owner" };
    }

    return {
      name: active.displayName ?? "Organization workspace",
      scopeLine: active.roleLabel
        ? `Organization • ${active.roleLabel}`
        : "Organization • Role unavailable",
    };
  }

  const { workspace } = envelope;
  const scope = workspace.scope;

  return {
    name:
      workspace.name ??
      (scope === "PERSONAL" ? "Personal Space" : "Organization workspace"),
    scopeLine:
      scope === "PERSONAL"
        ? "Personal • Owner"
        : workspace.membership.role
          ? `Organization • ${workspace.membership.role}`
          : "Organization • Role unavailable",
  };
}

export function AppAccountToolbar({
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

  useEffect(() => {
    setAccountOpen(false);
    setWorkspaceOpen(false);
  }, [pathname]);

  const surfaceUserCtx = useSurfaceUserContext();
  const canSeeOrganizations = canAccessSurface(surfaceUserCtx, "/organizations");

  const isPlatformAdmin = envelope?.platform.isPlatformAdmin === true;

const runtimeTeamId =
  envelope?.activeSpace?.type === "ORGANIZATION"
    ? envelope.activeSpace.id
    : null;
    
  const { name: workspaceName, scopeLine } = getWorkspaceLabels(envelope, state);

  const personalSpace = envelope?.personalSpace ?? null;
  const organizations = envelope?.organizations ?? [];
  const activeSpace = envelope?.activeSpace ?? null;

  const totalSwitchable =
    (personalSpace?.id ? 1 : 0) +
    (canSeeOrganizations ? organizations.length : 0);

  return (
    <div className="app-account-toolbar" data-app-account-toolbar>
      <div className="app-account-toolbar-inner">
        <button
          type="button"
          className="app-account-toolbar-mobile-menu"
          onClick={onToggleMobileSidebar}
          aria-label={mobileSidebarOpen ? "Close navigation" : "Open navigation"}
        >
          {mobileSidebarOpen ? <X size={21} /> : <Menu size={21} />}
        </button>

        <div
          className="app-account-toolbar-runtime"
          data-app-topbar-runtime
        >
          <GlobalRuntimeIndicator teamId={runtimeTeamId} />
        </div>

        <InboxIndicator />

        <div className="app-topbar-v2-language">
          <LanguageSwitcher />
        </div>

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
          >
            <span className="app-topbar-v2-workspace-icon" aria-hidden="true">
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
                <strong>Switch space</strong>
                <span data-workspace-menu-count>
                  {totalSwitchable <= 1
                    ? "Only Personal Space"
                    : `${totalSwitchable} spaces`}
                </span>
              </div>

              {personalSpace?.id ? (
                <div
                  className="app-topbar-v2-workspace-menu-group"
                  data-workspace-menu-group="PERSONAL"
                >
                  <div className="app-topbar-v2-workspace-menu-group-label">
                    Personal
                  </div>

                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setWorkspaceOpen(false);
                      void switchWorkspace(personalSpace.id);
                    }}
                    className={
                      activeSpace?.type === "PERSONAL"
                        ? "app-topbar-v2-workspace-menu-item is-active"
                        : "app-topbar-v2-workspace-menu-item"
                    }
                  >
                    <UserCircle size={14} strokeWidth={1.9} />

                    <span style={{ flex: 1 }}>Personal Space</span>

                    <small data-workspace-scope-chip="PERSONAL">
                      Personal
                    </small>
                  </button>
                </div>
              ) : null}

              {canSeeOrganizations && organizations.length > 0 ? (
                <div
                  className="app-topbar-v2-workspace-menu-group"
                  data-workspace-menu-group="ORGANIZATIONS"
                >
                  <div className="app-topbar-v2-workspace-menu-group-label">
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
                        className={
                          isActive
                            ? "app-topbar-v2-workspace-menu-item is-active"
                            : "app-topbar-v2-workspace-menu-item"
                        }
                      >
                        <Users size={14} strokeWidth={1.9} />

                        <span style={{ flex: 1 }}>
                          {org.displayName ??
                            org.name ??
                            "Organization workspace"}
                        </span>

                        <small data-workspace-scope-chip="TEAM">
                          Organization
                        </small>
                      </button>
                    );
                  })}
                </div>
              ) : null}

              {canSeeOrganizations ? (
                <div
                  className="app-topbar-v2-workspace-menu-group"
                  data-workspace-menu-group="ACTIONS"
                >
                  <div className="app-topbar-v2-workspace-menu-group-label">
                    Actions
                  </div>

                  <Link
                    href="/workspaces?action=create"
                    role="menuitem"
                    onClick={() => setWorkspaceOpen(false)}
                    className="app-topbar-v2-workspace-menu-item"
                  >
                    Create organization
                  </Link>

                  <Link
                    href="/workspaces?action=join"
                    role="menuitem"
                    onClick={() => setWorkspaceOpen(false)}
                    className="app-topbar-v2-workspace-menu-item"
                  >
                    Join organization
                  </Link>

                  <Link
                    href="/workspaces"
                    role="menuitem"
                    onClick={() => setWorkspaceOpen(false)}
                    className="app-topbar-v2-workspace-menu-item"
                  >
                    Manage organizations →
                  </Link>
                </div>
              ) : null}
            </div>
          ) : null}
        </div>

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
  );
}