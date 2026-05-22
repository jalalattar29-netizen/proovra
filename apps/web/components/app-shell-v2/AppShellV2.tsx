"use client";

import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { AppSidebarV2 } from "./AppSidebarV2";
import { AppTopbarV2 } from "./AppTopbarV2";
import { AppFooterV2 } from "./AppFooterV2";
import { usePathname } from "next/navigation";
import {
  usePlatformContext,
  WorkspaceRecoveryPanel,
} from "../../lib/platform-context";

type AppShellV2Props = {
  children: ReactNode;
  onLogout: () => void;
};

/**
 * Phase 32.8 Foundation — Shell no longer accepts user/isPlatformAdmin
 * props. Both descend from the canonical PlatformContextProvider via
 * usePlatformContext().
 *
 * The topbar reads workspace/user/isPlatformAdmin from context.
 * The sidebar reads the pre-filtered navigation tree from context.
 * No prop drilling.
 */
export function AppShellV2({ children, onLogout }: AppShellV2Props) {
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const ctx = usePlatformContext();

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

  // Phase EMERGENCY-RECOVERY — when the canonical envelope returns
  // structured `recoveryActions`, swap the page content for the
  // recovery panel so a normal user never lands in a broken shell.
  // The topbar + sidebar still render so the user can navigate to
  // public pages (Pricing, Help) and the workspace switcher.
  const recoveryActions = ctx.envelope?.recoveryActions ?? [];
  const needsRecovery = recoveryActions.length > 0;

  return (
    <div className="app-shell-v2">
      <AppTopbarV2
        onLogout={onLogout}
        mobileSidebarOpen={mobileSidebarOpen}
        onToggleMobileSidebar={() => setMobileSidebarOpen((prev) => !prev)}
      />

      <div className="app-shell-v2-main">
        <div className="app-shell-v2-desktop-sidebar">
          <AppSidebarV2 />
        </div>

        <div className="app-shell-v2-content-wrap">
          <main className="app-shell-v2-content">
            {needsRecovery ? <WorkspaceRecoveryPanel /> : children}
          </main>
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
        <AppSidebarV2 />
      </div>
    </div>
  );
}
