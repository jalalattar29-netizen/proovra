"use client";

import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { AppSidebarV2 } from "./AppSidebarV2";
import { AppTopbarV2, type AppShellUserV2 } from "./AppTopbarV2";
import { AppFooterV2 } from "./AppFooterV2";
import { usePathname } from "next/navigation";

type AppShellV2Props = {
  children: ReactNode;
  user: AppShellUserV2 | null;
  onLogout: () => void;
  isPlatformAdmin?: boolean;
};

export function AppShellV2({
  children,
  user,
  onLogout,
  isPlatformAdmin = false,
}: AppShellV2Props) {
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);

  useEffect(() => {
    document.body.classList.toggle("app-mobile-sidebar-open", mobileSidebarOpen);

    return () => {
      document.body.classList.remove("app-mobile-sidebar-open");
    };
  }, [mobileSidebarOpen]);

  const pathname = usePathname();

useEffect(() => {
  setMobileSidebarOpen(false);
}, [pathname]);

  return (
    <div className="app-shell-v2">
      <AppTopbarV2
        user={user}
        onLogout={onLogout}
        isPlatformAdmin={isPlatformAdmin}
        mobileSidebarOpen={mobileSidebarOpen}
        onToggleMobileSidebar={() => setMobileSidebarOpen((prev) => !prev)}
      />

      {/*
         Phase 32.6.4 — sidebar resolves its own workspace role via
         `useActiveWorkspaceId`. We deliberately do NOT pass `role`
         or `workspaceProfile` here: the parent shell does not have
         access to per-workspace role data (AppShellUserV2 only
         carries account-level fields). The sidebar's internal
         resolver is the canonical path. Role-gated nav items
         (Retention / Destruction / Teams / Billing / Policy) were
         previously hidden from everyone because the predicate
         fail-closed on a null role; the sidebar fix wires it.
      */}
      <div className="app-shell-v2-main">
        <div className="app-shell-v2-desktop-sidebar">
          <AppSidebarV2 isPlatformAdmin={isPlatformAdmin} />
        </div>

        <div className="app-shell-v2-content-wrap">
          <main className="app-shell-v2-content">{children}</main>
          <AppFooterV2 />
        </div>
      </div>

      <div
        className={`app-shell-v2-mobile-overlay ${
          mobileSidebarOpen ? "is-open" : ""
        }`}
        onClick={() => setMobileSidebarOpen(false)}
      />

      <div
        className={`app-shell-v2-mobile-drawer ${
          mobileSidebarOpen ? "is-open" : ""
        }`}
      >
        <AppSidebarV2 isPlatformAdmin={isPlatformAdmin} />
      </div>
    </div>
  );
}