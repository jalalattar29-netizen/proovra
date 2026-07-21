"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Bell,
  Building2,
  ChevronDown,
  CreditCard,
  HelpCircle,
  LogOut,
  Menu,
  Plus,
  Search,
  Settings,
  ShieldCheck,
  UserCircle,
  X,
  type LucideProps,
} from "lucide-react";
import type { ForwardRefExoticComponent, RefAttributes } from "react";

import { LanguageSwitcher } from "../language-switcher";
import { NotificationBell } from "./NotificationBell";
import { GlobalRuntimeIndicator } from "../operational";
import { usePlatformContext } from "../../lib/platform-context";
import {
  resolveAccountMenu,
  type AccountMenuIconKey,
} from "../../lib/navigation/accountMenu";

type LucideIcon = ForwardRefExoticComponent<
  Omit<LucideProps, "ref"> & RefAttributes<SVGSVGElement>
>;

const ACCOUNT_MENU_ICONS: Record<AccountMenuIconKey, LucideIcon> = {
  settings: Settings,
  security: ShieldCheck,
  notifications: Bell,
  billing: CreditCard,
  organization: Building2,
  help: HelpCircle,
};

function AccountMenuIcon({ iconKey }: { iconKey: AccountMenuIconKey }) {
  const Icon = ACCOUNT_MENU_ICONS[iconKey] ?? Settings;
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
  // If a provider avatar URL fails to load (Google may 403 due to
  // referrer, network hiccup, expired signed URL) we fall through to
  // the initials block. The set stores the src that failed so a later
  // re-render with the same URL doesn't retry indefinitely.
  const [brokenAvatarUrls, setBrokenAvatarUrls] = useState<Set<string>>(
    () => new Set(),
  );

  const accountRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      if (!accountRef.current?.contains(event.target as Node)) {
        setAccountOpen(false);
      }
    };

    document.addEventListener("pointerdown", onPointerDown);

    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, []);

  useEffect(() => {
    setAccountOpen(false);
  }, [pathname]);

  const isPlatformAdmin = envelope?.platform.isPlatformAdmin === true;

  const runtimeTeamId =
    envelope?.activeSpace?.type === "ORGANIZATION"
      ? envelope.activeSpace.id
      : null;

  const { name: workspaceName } = getWorkspaceLabels(envelope, state);
  const activeSpace = envelope?.activeSpace ?? null;

  // ---------------------------------------------------------------------------
  // The single canonical resolver decides EVERY account-menu item (links,
  // switcher options, org-settings visibility, support). The component below
  // is a pure renderer — it holds no visibility logic of its own.
  // ---------------------------------------------------------------------------
  const menu = useMemo(
    () =>
      resolveAccountMenu({
        capabilities: envelope?.capabilities ?? {},
        isPlatformAdmin: envelope?.platform.isPlatformAdmin === true,
        activeSpace: envelope?.activeSpace
          ? { type: envelope.activeSpace.type, id: envelope.activeSpace.id }
          : null,
        personalSpace: envelope?.personalSpace
          ? {
              id: envelope.personalSpace.id,
              status: envelope.personalSpace.status,
            }
          : null,
        organizations: envelope?.organizations ?? [],
        accountPlan: envelope?.account?.accountPlan ?? null,
      }),
    [
      envelope?.capabilities,
      envelope?.platform.isPlatformAdmin,
      envelope?.activeSpace,
      envelope?.personalSpace,
      envelope?.organizations,
      envelope?.account?.accountPlan,
    ],
  );

  const handleSearchClick = useCallback(() => {
    openCommandPalette();
  }, []);

  const handleSwitchWorkspace = useCallback(
    (workspaceId: string) => {
      setAccountOpen(false);
      void switchWorkspace(workspaceId);
    },
    [switchWorkspace],
  );

  const isMac =
    typeof navigator !== "undefined" &&
    /Mac|iPod|iPhone|iPad/.test(navigator.platform);

  const showSwitcher = menu.workspaces.total > 0;

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
              notifications, language, account. */}
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
            href="/cases"
            className="app-header-primary-action"
            data-app-header-primary-action
          >
            <Plus size={16} strokeWidth={2} />
            <span>New Case</span>
          </Link>

          <span className="app-header-divider" aria-hidden="true" />

          {/* System-status indicator is an operator surface that only has
              meaning for a team/organization runtime. In a Personal
              Workspace `runtimeTeamId` is null and GlobalRuntimeIndicator
              renders nothing — so we skip the whole wrapper here to avoid
              an empty, label-less, non-interactive element (and its gap)
              in the header. It stays fully intact for Organization / Team /
              Enterprise / Admin workspaces where it has a real status. */}
          {runtimeTeamId ? (
            <div
              className="app-topbar-v2-runtime"
              data-app-topbar-runtime
              aria-label="System status"
            >
              <GlobalRuntimeIndicator teamId={runtimeTeamId} />
            </div>
          ) : null}

          <NotificationBell />

          <div className="app-topbar-v2-language" aria-label="Language">
            <LanguageSwitcher />
          </div>

          <span className="app-header-divider" aria-hidden="true" />

          {/* ------------------------------------------------------------------
              CANONICAL ACCOUNT MENU — one control. Account management only,
              plus the in-place Workspace Switcher (Section 2). There is NO
              separate workspace-switcher control; switching happens here.
             ------------------------------------------------------------------ */}
          <div
            className="app-topbar-v2-account"
            data-app-topbar-account
            ref={accountRef}
          >
            <button
              type="button"
              className={`app-topbar-v2-user ${accountOpen ? "is-open" : ""}`}
              onClick={() => setAccountOpen((prev) => !prev)}
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
                data-platform-state={state.name}
              >
                {/* Header — identity + active-workspace badge. */}
                <div className="app-topbar-v2-account-menu-header">
                  <strong>{getUserDisplayName(envelope)}</strong>
                  <span>{envelope?.user.email ?? "Signed in account"}</span>
                  {activeSpace ? (
                    <span
                      data-account-menu-header-workspace
                      className="app-topbar-v2-account-menu-workspace-badge"
                    >
                      {activeSpace.type === "PERSONAL" ? (
                        <UserCircle size={11} strokeWidth={2} />
                      ) : (
                        <Building2 size={11} strokeWidth={2} />
                      )}
                      {workspaceName}
                    </span>
                  ) : null}
                </div>

                {/* Section 1 — account management. */}
                {menu.account.length > 0 ? (
                  <div
                    className="app-topbar-v2-account-menu-section"
                    data-account-menu-section="account"
                  >
                    {menu.account.map((item) => (
                      <Link
                        key={item.id}
                        href={item.href}
                        role="menuitem"
                        onClick={() => setAccountOpen(false)}
                        data-account-menu-item={item.id}
                      >
                        <AccountMenuIcon iconKey={item.iconKey} />
                        {item.label}
                      </Link>
                    ))}
                  </div>
                ) : null}

                {/* Section 2 — Workspace Switcher (in-place; never navigates
                    to a Teams/Workspaces admin page). */}
                {showSwitcher ? (
                  <div
                    className="app-topbar-v2-account-menu-section app-topbar-v2-account-menu-switcher"
                    data-account-menu-section="workspaces"
                    data-account-menu-switcher
                  >
                    <div className="app-topbar-v2-account-menu-section-label">
                      Workspaces
                    </div>

                    {menu.workspaces.personal ? (
                      <div data-workspace-menu-group="PERSONAL">
                        <button
                          type="button"
                          role="menuitem"
                          onClick={() =>
                            handleSwitchWorkspace(menu.workspaces.personal!.id)
                          }
                          className={
                            menu.workspaces.personal.active
                              ? "app-topbar-v2-account-menu-workspace is-active"
                              : "app-topbar-v2-account-menu-workspace"
                          }
                          data-account-menu-workspace={menu.workspaces.personal.id}
                          aria-current={
                            menu.workspaces.personal.active ? "true" : undefined
                          }
                        >
                          <UserCircle size={14} strokeWidth={1.9} />
                          <span style={{ flex: 1 }}>
                            {menu.workspaces.personal.label}
                          </span>
                          <small data-workspace-scope-chip="PERSONAL">
                            Personal
                          </small>
                        </button>
                      </div>
                    ) : null}

                    {menu.workspaces.organizations.length > 0 ? (
                      <div data-workspace-menu-group="ORGANIZATIONS">
                        {menu.workspaces.organizations.map((org) => (
                          <button
                            key={org.id}
                            type="button"
                            role="menuitem"
                            onClick={() => handleSwitchWorkspace(org.id)}
                            className={
                              org.active
                                ? "app-topbar-v2-account-menu-workspace is-active"
                                : "app-topbar-v2-account-menu-workspace"
                            }
                            data-account-menu-workspace={org.id}
                            aria-current={org.active ? "true" : undefined}
                          >
                            <Building2 size={14} strokeWidth={1.9} />
                            <span style={{ flex: 1 }}>{org.label}</span>
                            <small data-workspace-scope-chip="ORGANIZATION">
                              Organization
                            </small>
                          </button>
                        ))}
                      </div>
                    ) : null}
                  </div>
                ) : null}

                {/* Organization management — member-gated, route-gated. */}
                {menu.organization.length > 0 ? (
                  <div
                    className="app-topbar-v2-account-menu-section"
                    data-account-menu-section="organization"
                  >
                    {menu.organization.map((item) => (
                      <Link
                        key={item.id}
                        href={item.href}
                        role="menuitem"
                        onClick={() => setAccountOpen(false)}
                        data-account-menu-item={item.id}
                      >
                        <AccountMenuIcon iconKey={item.iconKey} />
                        {item.label}
                      </Link>
                    ))}
                  </div>
                ) : null}

                {/* Support — public, new tab. */}
                <div
                  className="app-topbar-v2-account-menu-section"
                  data-account-menu-section="support"
                >
                  {menu.support.map((item) => (
                    <a
                      key={item.id}
                      href={item.href}
                      role="menuitem"
                      target={item.external ? "_blank" : undefined}
                      rel={item.external ? "noopener noreferrer" : undefined}
                      onClick={() => setAccountOpen(false)}
                      data-account-menu-item={item.id}
                      aria-label={
                        item.external
                          ? `${item.label} — opens in a new tab`
                          : undefined
                      }
                    >
                      <AccountMenuIcon iconKey={item.iconKey} />
                      {item.label}
                      {item.external ? (
                        <span aria-hidden="true" style={{ marginLeft: "auto" }}>
                          ↗
                        </span>
                      ) : null}
                    </a>
                  ))}
                </div>

                {/* Sign out — a control, not a navigation link. */}
                <div
                  className="app-topbar-v2-account-menu-section"
                  data-account-menu-section="session"
                >
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
              </div>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}
