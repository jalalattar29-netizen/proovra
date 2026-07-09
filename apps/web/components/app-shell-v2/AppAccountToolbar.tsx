"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Bell,
  Camera,
  ChevronDown,
  CreditCard,
  HelpCircle,
  LogOut,
  Menu,
  Search,
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

return { name: "Personal Space", scopeLine: "Personal • Owner" };
}

// Cross-surface duplicates: hrefs that appear in the sidebar admin group
// for org-context users, plus routes that clutter the menu once the user
// already has the workspace switcher in the header. When
// `canSeeOrganizations` is true these get stripped from the account menu
// so the menu reads clean (Profile / Workspace / Billing / Preferences /
// Notifications / Help / Sign out). Personal-only users KEEP them because
// their sidebar does not surface the admin group and they still need
// billing + pricing paths from the menu.
const CROSS_SURFACE_SIDEBAR_HREFS: ReadonlySet<string> = new Set([
  "/billing",
  "/workspaces",
  "/pricing",
]);

// Dispatches Cmd+K (or Ctrl+K on non-mac) so the CommandPalette listener
// picks it up. The palette owns its own state; this trigger stays stateless.
function openCommandPalette() {
  if (typeof window === "undefined") return;
  const isMac =
    typeof navigator !== "undefined" &&
    /Mac|iPod|iPhone|iPad/.test(navigator.platform);
  const event = new KeyboardEvent("keydown", {
    key: "k",
    code: "KeyK",
    metaKey: isMac,
    ctrlKey: !isMac,
    bubbles: true,
  });
  window.dispatchEvent(event);
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
  // If a provider avatar URL fails to load (Google may 403 due to
  // referrer, network hiccup, expired signed URL) we fall through to
  // the initials block. The set stores the src that failed so a later
  // re-render with the same URL doesn't retry indefinitely.
  const [brokenAvatarUrls, setBrokenAvatarUrls] = useState<Set<string>>(
    () => new Set(),
  );

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

  // Dedupe account menu items: by href (defensive) + cross-surface removal
  // of items that appear in the sidebar for org-context users.
  const accountMenuItems = useMemo(() => {
    const raw = envelope?.navigation.accountMenu.items ?? [];
    const seenHrefs = new Set<string>();
    const out: typeof raw[number][] = [];
    for (const item of raw) {
      if (seenHrefs.has(item.href)) continue;
      // Strip cross-surface duplicates only when the user has org
      // context (the sidebar admin group surfaces the same href).
      if (canSeeOrganizations && CROSS_SURFACE_SIDEBAR_HREFS.has(item.href)) {
        continue;
      }
      seenHrefs.add(item.href);
      out.push(item);
    }
    return out;
  }, [envelope?.navigation.accountMenu.items, canSeeOrganizations]);

  const handleSearchClick = useCallback(() => {
    openCommandPalette();
  }, []);

  const isMac =
    typeof navigator !== "undefined" &&
    /Mac|iPod|iPhone|iPad/.test(navigator.platform);

  return (
    <div className="app-account-toolbar" data-app-account-toolbar>
      <div className="app-account-toolbar-inner">
        <div className="app-header-zone-left">
          <button
            type="button"
            className="app-account-toolbar-mobile-menu"
            onClick={onToggleMobileSidebar}
            aria-label={mobileSidebarOpen ? "Close navigation" : "Open navigation"}
          >
            {mobileSidebarOpen ? <X size={20} /> : <Menu size={20} />}
          </button>

          {/* Phase HEADER-CLEAN — the global header no longer renders
              page titles or breadcrumbs. Each page owns its own identity
              (e.g. the Home greeting). The header stays clean: search,
              workspace, notifications, language, profile. */}
        </div>

        <div className="app-header-zone-center">
          <button
            type="button"
            className="app-header-search"
            onClick={handleSearchClick}
            aria-label="Open command palette (search)"
            data-app-header-search
          >
            <Search size={16} strokeWidth={1.9} />
            <span className="app-header-search-text">
              Search or jump to…
            </span>
            <kbd className="app-header-search-kbd" aria-hidden="true">
              {isMac ? "⌘" : "Ctrl"}
              <span>K</span>
            </kbd>
          </button>
        </div>

        <div className="app-header-zone-right">
          <Link
            href="/capture"
            className="app-header-primary-action"
            data-app-header-primary-action
          >
            <Camera size={16} strokeWidth={2} />
            <span>New Evidence</span>
          </Link>

          <span className="app-header-divider" aria-hidden="true" />

          <div
            className="app-topbar-v2-runtime"
            data-app-topbar-runtime
            aria-label="System status"
          >
            <GlobalRuntimeIndicator teamId={runtimeTeamId} />
          </div>

          <InboxIndicator />

          <div className="app-topbar-v2-language" aria-label="Language">
            <LanguageSwitcher />
          </div>

          <span className="app-header-divider" aria-hidden="true" />

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
              {activeSpace?.type === "PERSONAL" ? (
                <UserCircle size={16} strokeWidth={1.9} />
              ) : (
                <Users size={16} strokeWidth={1.9} />
              )}
            </span>

            <div className="app-topbar-v2-workspace-copy">
              <strong data-workspace-name>{workspaceName}</strong>
              <span data-workspace-scope-line>{scopeLine}</span>
            </div>

            {/* Chevron only when there is actually more than one space to
                switch to — a solo Personal-only user sees a context label,
                not a switcher affordance that implies choices they lack. */}
            {totalSwitchable > 1 ? (
              <ChevronDown size={14} strokeWidth={1.9} />
            ) : null}
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
            {envelope?.user.avatarUrl &&
            !brokenAvatarUrls.has(envelope.user.avatarUrl) ? (
              <img
                src={envelope.user.avatarUrl}
                alt={`${getUserDisplayName(envelope)} avatar`}
                className="app-topbar-v2-avatar"
                referrerPolicy="no-referrer"
                onError={() => {
                  const url = envelope?.user.avatarUrl;
                  if (!url) return;
                  setBrokenAvatarUrls((prev) => {
                    if (prev.has(url)) return prev;
                    const next = new Set(prev);
                    next.add(url);
                    return next;
                  });
                }}
              />
            ) : (
              <div
                className="app-topbar-v2-avatar-fallback"
                aria-label={`${getUserDisplayName(envelope)} avatar (initials fallback)`}
              >
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
                {activeSpace ? (
                  <span
                    data-account-menu-header-workspace
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 6,
                      marginTop: 4,
                      fontSize: 11,
                      color: "var(--content-ink-muted)",
                      textTransform: "uppercase",
                      letterSpacing: "0.06em",
                      fontWeight: 700,
                    }}
                  >
                    <Users size={11} strokeWidth={2} />
                    {workspaceName}
                  </span>
                ) : null}
              </div>

              {accountMenuItems.map((item) => (
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
