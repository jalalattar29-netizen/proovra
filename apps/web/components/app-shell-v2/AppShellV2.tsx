"use client";

import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { AppSidebarV2 } from "./AppSidebarV2";
import { AppAccountToolbar } from "./AppAccountToolbar";
import { SupportAccessBanner } from "./SupportAccessBanner";
import { CommandPalette } from "../navigation/CommandPalette";
import { usePathname } from "next/navigation";
import {
  usePlatformContext,
  WorkspaceRecoveryPanel,
  usePersonalSpaceGate,
  PersonalSpaceUnavailablePanel,
} from "../../lib/platform-context";
import { resolveWorkspaceExperience } from "../../lib/workspace-experience";

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

  // PHASE 10 CLOSURE FIX 3 (2026-07-23) — canonical no-Personal client
  // gate. Every (app) route is wrapped by this shell, so mounting the gate
  // here protects capture, evidence, billing, settings, and any deep link
  // alike from ever rendering Personal content once the server-projected
  // `personalSpaceAllowed` flips to false. The hook itself drives the
  // heal-out switchWorkspace attempt; this component only decides what to
  // render. Recovery (envelope assembly failure) takes precedence — a
  // broken envelope can't be gated on a field it may not even have.
  const personalSpaceGateState = usePersonalSpaceGate();
  const personalSpaceBlocked =
    !needsRecovery && personalSpaceGateState === "blocked";

  // R1.5B — workspace experience segmentation. The mode is a
  // presentation-only data attribute (CSS, R5/R6 hooks, tests). It
  // NEVER drives authorization — capabilities remain authoritative.
  const experienceShell = resolveWorkspaceExperience({
    activeSpaceType: ctx.envelope?.activeSpace?.type ?? null,
    capabilities: ctx.envelope?.capabilities ?? {},
  });

  return (
    <div
      className="app-shell-v2"
      data-workspace-experience-mode={experienceShell.mode}
    >
      {/*
       * Milestone A — TRUE 2×2 GRID SHELL
       *
       *   [ sidebar-slot ] [ header-slot ]     col 1 spans 2 rows
       *   [ sidebar-slot ] [ content-slot ]
       *
       * The header lives in column 2 only, so it never spans over the
       * sidebar rail. Page identity (breadcrumb + title) sits in the
       * header's left zone and is geometrically incapable of leaking
       * behind the sidebar. Banners + recovery panels + page content
       * all live inside content-slot so the header height stays a
       * stable constant regardless of which panels are active.
       */}
      <div className="app-shell-v2-sidebar-slot">
        <AppSidebarV2 />
      </div>

      <div className="app-shell-v2-header-slot">
        <AppAccountToolbar
          onLogout={onLogout}
          mobileSidebarOpen={mobileSidebarOpen}
          onToggleMobileSidebar={() => setMobileSidebarOpen((prev) => !prev)}
        />
      </div>

      <div className="app-shell-v2-content-slot">
        <main className="app-shell-v2-content">
          {/*
           * PHASE 10 STEP 5 — persistent support-access banner. Renders
           * only when the envelope reports active support access; a no-op
           * for every ordinary user. Kept above page content so it is
           * visible on every route during a support session.
           */}
          <SupportAccessBanner />
          {needsRecovery ? (
            <WorkspaceRecoveryPanel />
          ) : personalSpaceBlocked ? (
            <PersonalSpaceUnavailablePanel />
          ) : (
            children
          )}
        </main>
      </div>

      {/* Cmd+K palette — self-mounted portal; renders only when open. */}
      <CommandPalette />

      {/* Mobile drawer + overlay — hidden by CSS at desktop widths. */}
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
