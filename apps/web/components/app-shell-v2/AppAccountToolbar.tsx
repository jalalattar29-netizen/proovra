"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
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
  Users,
  X,
  type LucideProps,
} from "lucide-react";
import type { ForwardRefExoticComponent, RefAttributes } from "react";

import { LanguageSwitcher } from "../language-switcher";
import { NotificationBell } from "./NotificationBell";
import { GlobalRuntimeIndicator } from "../operational";
import { usePlatformContext } from "../../lib/platform-context";
// P3 domain remediation (2026-07-21) — tenant-boundary switch safety.
import { getDirtyWorkLabels } from "../../lib/platform-context/dirtyWorkRegistry";
import {
  resolveAccountMenu,
  type AccountMenuIconKey,
  type AccountMenuWorkspaceOption,
} from "../../lib/navigation/accountMenu";

// Record-scoped routes that may not exist / not be authorized in the target
// workspace. After a successful switch we land on the safe default instead
// of leaving a stale cross-tenant record on screen.
const RECORD_SCOPED_ROUTE = /^\/(evidence|cases|reports|organizations|collaboration-teams|teams|intake-links|workflows)\/[^/]+/;

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
  const router = useRouter();
  const ctx = usePlatformContext();
  const { envelope, state, switchWorkspace } = ctx;

  const [accountOpen, setAccountOpen] = useState(false);
  // P4 — the persistent context chip's switcher panel.
  const [switcherOpen, setSwitcherOpen] = useState(false);
  // P3 — a switch blocked by the dirty-work guard awaiting explicit
  // confirmation inside the panel (repo rule: no raw browser confirm dialog).
  const [pendingSwitch, setPendingSwitch] = useState<{
    workspaceId: string;
    dirtyLabels: string[];
  } | null>(null);
  // If a provider avatar URL fails to load (Google may 403 due to
  // referrer, network hiccup, expired signed URL) we fall through to
  // the initials block. The set stores the src that failed so a later
  // re-render with the same URL doesn't retry indefinitely.
  const [brokenAvatarUrls, setBrokenAvatarUrls] = useState<Set<string>>(
    () => new Set(),
  );

  const accountRef = useRef<HTMLDivElement | null>(null);
  const switcherRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      if (!accountRef.current?.contains(event.target as Node)) {
        setAccountOpen(false);
      }
      if (!switcherRef.current?.contains(event.target as Node)) {
        setSwitcherOpen(false);
      }
    };

    document.addEventListener("pointerdown", onPointerDown);

    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, []);

  useEffect(() => {
    setAccountOpen(false);
    setSwitcherOpen(false);
  }, [pathname]);

  const isPlatformAdmin = envelope?.platform.isPlatformAdmin === true;

  const runtimeTeamId =
    envelope?.activeSpace?.type === "ORGANIZATION"
      ? envelope.activeSpace.id
      : null;

  const { name: workspaceName, scopeLine } = getWorkspaceLabels(
    envelope,
    state,
  );
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
        // P3 — server-authorized grouped options (Personal / Your
        // workspaces / Organizations).
        contextOptions: envelope?.contextOptions ?? null,
        // PHASE 10 §13.2 STEP 6 (2026-07-23) — hides the Personal Space
        // switcher entry for a managed enterprise identity (client-hiding
        // signal only; the server independently denies the switch).
        personalSpaceAllowed: envelope?.personalSpaceAllowed,
      }),
    [
      envelope?.capabilities,
      envelope?.platform.isPlatformAdmin,
      envelope?.activeSpace,
      envelope?.personalSpace,
      envelope?.organizations,
      envelope?.account?.accountPlan,
      envelope?.contextOptions,
      envelope?.personalSpaceAllowed,
    ],
  );

  const handleSearchClick = useCallback(() => {
    openCommandPalette();
  }, []);

  // P3 — the actual switch mutation + safe landing (invoked only after the
  // dirty-work guard has been satisfied).
  const performSwitch = useCallback(
    (workspaceId: string) => {
      setAccountOpen(false);
      setSwitcherOpen(false);
      setPendingSwitch(null);
      void switchWorkspace(workspaceId).then(() => {
        // SAFE LANDING: a record-scoped route may not exist / not be
        // authorized in the target workspace — never leave a stale
        // cross-tenant record visible. Land on the workspace home.
        if (RECORD_SCOPED_ROUTE.test(window.location.pathname)) {
          router.push("/home");
        }
      });
    },
    [switchWorkspace, router],
  );

  const handleSwitchWorkspace = useCallback(
    (workspaceId: string) => {
      // P3 — tenant-boundary transition safety. DIRTY-WORK GUARD: unsaved
      // workspace-scoped work must never silently carry into another
      // workspace. When dirty state exists, the panel renders an explicit
      // in-panel confirmation naming the work (no raw browser confirm dialog —
      // repo accessibility rule); cancel aborts the switch.
      const dirty = getDirtyWorkLabels();
      if (dirty.length > 0) {
        setPendingSwitch({ workspaceId, dirtyLabels: dirty });
        setSwitcherOpen(true);
        return;
      }
      performSwitch(workspaceId);
    },
    [performSwitch],
  );

  const openSwitcher = useCallback(() => {
    setAccountOpen(false);
    setPendingSwitch(null);
    setSwitcherOpen((prev) => !prev);
  }, []);

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
              P4 — PERSISTENT ACTIVE-CONTEXT CHIP. For an evidence platform
              the operating tenant must be unmistakable BEFORE custody-
              sensitive actions — always visible, never hidden inside the
              avatar menu. Opens the ONE canonical switcher panel (Personal /
              Your workspaces / Organizations), server-authorized options
              only. The account menu's "Switch workspace" action opens this
              same panel — one resolver, one panel, two triggers.
             ------------------------------------------------------------------ */}
          <div
            className="app-topbar-v2-workspace"
            data-app-context-chip
            data-platform-state={state.name}
            ref={switcherRef}
          >
            <button
              type="button"
              className={`app-topbar-v2-workspace-button ${
                switcherOpen ? "is-open" : ""
              }`}
              onClick={openSwitcher}
              aria-haspopup="menu"
              aria-expanded={switcherOpen}
              aria-label={`Active workspace: ${workspaceName}. Open workspace switcher.`}
            >
              <span className="app-topbar-v2-workspace-icon" aria-hidden="true">
                {activeSpace?.type === "PERSONAL" ? (
                  <UserCircle size={16} strokeWidth={1.9} />
                ) : (
                  <Building2 size={16} strokeWidth={1.9} />
                )}
              </span>
              <div className="app-topbar-v2-workspace-copy">
                <strong data-context-chip-name>{workspaceName}</strong>
                <span data-context-chip-scope-line>{scopeLine}</span>
              </div>
              {menu.workspaces.total > 1 ? (
                <ChevronDown size={14} strokeWidth={1.9} />
              ) : null}
            </button>

            {switcherOpen ? (
              <div
                className="app-topbar-v2-workspace-menu"
                role="menu"
                data-app-context-switcher
              >
                <div className="app-topbar-v2-workspace-menu-header">
                  <strong>Switch workspace</strong>
                  <span data-context-switcher-count>
                    {menu.workspaces.total <= 1
                      ? "Only Personal Space"
                      : `${menu.workspaces.total} workspaces`}
                  </span>
                </div>

                {/* P3 — dirty-work confirmation (in-panel, accessible; the
                    repo bans raw browser confirm dialogs). Names the unsaved work
                    that would be left behind in the CURRENT workspace. */}
                {pendingSwitch ? (
                  <div
                    className="app-topbar-v2-workspace-menu-degraded"
                    role="alertdialog"
                    aria-label="Unsaved work warning"
                    data-context-switch-confirm
                  >
                    <strong>Unsaved work in {workspaceName}</strong>
                    {pendingSwitch.dirtyLabels.map((label) => (
                      <div key={label}>• {label}</div>
                    ))}
                    <div style={{ marginTop: 6, display: "flex", gap: 8 }}>
                      <button
                        type="button"
                        onClick={() => performSwitch(pendingSwitch.workspaceId)}
                        data-context-switch-confirm-proceed
                      >
                        Switch anyway
                      </button>
                      <button
                        type="button"
                        onClick={() => setPendingSwitch(null)}
                        data-context-switch-confirm-cancel
                      >
                        Stay here
                      </button>
                    </div>
                  </div>
                ) : null}

                {/* EMPTY STATE — a context menu that resolves to no personal
                    space, no owned workspace and no organization must say so
                    rather than open a blank panel. Restored here (the shared
                    shell authority) rather than at any one route. */}
                {!menu.workspaces.personal &&
                menu.workspaces.owned.length === 0 &&
                menu.workspaces.organizations.length === 0 ? (
                  <div
                    className="app-topbar-v2-workspace-menu-empty"
                    data-context-group="EMPTY"
                    role="status"
                  >
                    No workspaces are available for this account yet.
                  </div>
                ) : null}

                {menu.workspaces.personal ? (
                  <div
                    className="app-topbar-v2-workspace-menu-group"
                    data-context-group="PERSONAL"
                  >
                    <div className="app-topbar-v2-workspace-menu-group-label">
                      Personal
                    </div>
                    <SwitcherOption
                      option={menu.workspaces.personal}
                      icon={<UserCircle size={14} strokeWidth={1.9} />}
                      chip="Personal"
                      onSelect={handleSwitchWorkspace}
                    />
                  </div>
                ) : null}

                {menu.workspaces.owned.length > 0 ? (
                  <div
                    className="app-topbar-v2-workspace-menu-group"
                    data-context-group="OWNED"
                  >
                    <div className="app-topbar-v2-workspace-menu-group-label">
                      Your workspaces
                    </div>
                    {menu.workspaces.owned.map((w) => (
                      <SwitcherOption
                        key={w.id}
                        option={w}
                        icon={<Users size={14} strokeWidth={1.9} />}
                        chip="Workspace"
                        onSelect={handleSwitchWorkspace}
                      />
                    ))}
                  </div>
                ) : null}

                {menu.workspaces.organizations.map((group) => (
                  <div
                    key={group.organizationId}
                    className="app-topbar-v2-workspace-menu-group"
                    data-context-group="ORGANIZATION"
                    data-context-organization={group.organizationId}
                  >
                    <div className="app-topbar-v2-workspace-menu-group-label">
                      {group.organizationName ?? "Organizations"}
                    </div>
                    {group.workspaces.map((w) => (
                      <SwitcherOption
                        key={w.id}
                        option={w}
                        icon={<Building2 size={14} strokeWidth={1.9} />}
                        chip="Organization"
                        onSelect={handleSwitchWorkspace}
                      />
                    ))}
                  </div>
                ))}
              </div>
            ) : null}
          </div>

          {/* ------------------------------------------------------------------
              CANONICAL ACCOUNT MENU — account management only. Context
              switching lives in the persistent chip; the menu links to it.
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

                {/* Switch workspace — opens the SAME canonical switcher
                    panel the persistent context chip owns (one resolver,
                    one panel, two triggers — never a second implementation). */}
                {showSwitcher ? (
                  <div
                    className="app-topbar-v2-account-menu-section"
                    data-account-menu-section="workspaces"
                  >
                    <button
                      type="button"
                      role="menuitem"
                      onClick={openSwitcher}
                      data-account-menu-item="switch-workspace"
                    >
                      <Users size={16} strokeWidth={1.9} />
                      Switch workspace
                    </button>
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

/**
 * P4 — one canonical switcher-option renderer shared by every group in the
 * context-switcher panel (Personal / Your workspaces / Organizations).
 */
function SwitcherOption({
  option,
  icon,
  chip,
  onSelect,
}: {
  option: AccountMenuWorkspaceOption;
  icon: React.ReactNode;
  chip: string;
  onSelect: (workspaceId: string) => void;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={() => onSelect(option.id)}
      className={
        option.active
          ? "app-topbar-v2-workspace-menu-item is-active"
          : "app-topbar-v2-workspace-menu-item"
      }
      data-context-option={option.id}
      data-context-option-kind={option.kind}
      aria-current={option.active ? "true" : undefined}
    >
      {icon}
      <span style={{ flex: 1 }}>{option.label}</span>
      <small data-workspace-scope-chip={option.kind}>{chip}</small>
    </button>
  );
}
