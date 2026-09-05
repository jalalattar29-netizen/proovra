"use client";

import type { ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
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
  const drawerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    document.body.classList.toggle("app-mobile-sidebar-open", mobileSidebarOpen);

    return () => {
      document.body.classList.remove("app-mobile-sidebar-open");
    };
  }, [mobileSidebarOpen]);

  /**
   * THE MOBILE DRAWER'S KEYBOARD AND FOCUS BEHAVIOUR.
   *
   * =========================================================================
   * FOUR THINGS WERE MISSING, AND A KEYBOARD SWEEP FOUND ALL FOUR
   * =========================================================================
   * The drawer opened, contained seventeen links, and:
   *
   *   1. FOCUS NEVER ENTERED IT. It opened behind the trigger, so a keyboard
   *      user pressed Enter and then had to Tab forward through the header to
   *      reach a panel that was already open in front of them.
   *   2. ESCAPE DID NOTHING. The only way out was the trigger again.
   *   3. THE BACKGROUND STAYED INTERACTIVE — and scrollable, because
   *      `body.app-mobile-sidebar-open` was toggled by the effect above and
   *      then matched by NO CSS RULE ANYWHERE. The class had been dead since
   *      it was written.
   *   4. WHEN CLOSED, ITS SEVENTEEN LINKS WERE STILL FOCUSABLE. The closed
   *      state is `transform: translateX(-100%)`, which moves a panel off
   *      screen and leaves every control in it in the tab order and in the
   *      accessibility tree.
   *
   * `inert` handles (3) and (4) — it removes a subtree from hit-testing, from
   * the tab order and from the accessibility tree in one attribute, which is
   * exactly the four separate things `aria-hidden` + `tabindex="-1"` +
   * `pointer-events` + a scroll lock were being asked to approximate.
   *
   * Set imperatively rather than as a JSX prop: this is React 18.3, where
   * `inert` is not yet a known boolean DOM property and `inert={false}`
   * serialises to the string "false" — which is a PRESENT attribute and
   * therefore inert. Getting that backwards makes the whole app unusable, so
   * it is `toggleAttribute` against a real boolean.
   */
  useEffect(() => {
    const drawer = drawerRef.current;
    const content = document.querySelector(".app-shell-v2-content-slot");
    const header = document.querySelector(".app-shell-v2-header-slot");

    drawer?.toggleAttribute("inert", !mobileSidebarOpen);
    // Only inert the background while the drawer is open, and only below the
    // breakpoint where the drawer exists at all — above it the drawer is
    // `display: none` and this state is unreachable.
    const backgroundInert = mobileSidebarOpen;
    content?.toggleAttribute("inert", backgroundInert);
    header?.toggleAttribute("inert", backgroundInert);

    if (!mobileSidebarOpen) return;

    // Focus the panel itself, not its first link: a screen reader then reads
    // the navigation's own label before its items, and Tab still lands on the
    // first link next.
    drawer?.focus();

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();

      /*
       * ORDER MATTERS, AND GETTING IT WRONG IS SILENT.
       *
       * The first version called `setMobileSidebarOpen(false)` and then
       * focused the trigger. React batches the state update, so at the moment
       * of the `.focus()` call the header was STILL inert — and focusing
       * inside an inert subtree does nothing at all. It does not throw; focus
       * simply falls to `<body>`, which drops a keyboard user at the top of
       * the document. Measured exactly that: `focusTag: "BODY"`.
       *
       * So the background is un-inerted here, synchronously, before the focus
       * call. The effect cleanup still removes them — this is belt and braces
       * on a failure mode that leaves no trace.
       */
      content?.removeAttribute("inert");
      header?.removeAttribute("inert");
      setMobileSidebarOpen(false);
      // Focus returns to the control that opened it. Leaving focus on a panel
      // that just closed drops the caller back to the top of the document.
      (
        document.querySelector(
          ".app-account-toolbar-mobile-menu",
        ) as HTMLElement | null
      )?.focus();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      content?.removeAttribute("inert");
      header?.removeAttribute("inert");
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
       * SKIP TO CONTENT — the first focusable in the document.
       *
       * WHY IT IS HERE NOW. The Phase 7 keyboard sweep pressed Tab from the
       * top of the document on eight admin routes and measured the first stop
       * INSIDE <main> at press number TWENTY-SIX, on every one of them: the
       * search field, the case button, the status pill, the bell, the language
       * chip, the workspace switcher, the account menu, then twenty-odd
       * sidebar entries, and only then the page. There was no skip link
       * anywhere in the application — a repository-wide search for one found
       * nothing.
       *
       * That is not a small inconvenience. Twenty-six presses to reach the
       * content, repeated on every navigation, is the difference between the
       * console being usable by keyboard and not.
       *
       * It is invisible until focused (see `.app-skip-link`), so nothing about
       * the shell's appearance changes, and it is placed before the sidebar
       * slot in DOM ORDER rather than positioned there visually — which is
       * what makes it the first stop.
       */}
      <a href="#app-main-content" className="app-skip-link">
        Skip to main content
      </a>

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
        <main
          className="app-shell-v2-content"
          id="app-main-content"
          /* -1, not 0: the skip link needs a focus TARGET, and a landmark that
             is a permanent tab stop would add a stop for everybody. */
          tabIndex={-1}
        >
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
        ref={drawerRef}
        id="app-mobile-drawer"
        className={`app-shell-v2-mobile-drawer ${
          mobileSidebarOpen ? "is-open" : ""
        }`}
        /* A dialog, because it is a panel over the page that Escape closes and
           that makes the background inert. Labelled, so the thing focus lands
           on announces what it is. */
        role="dialog"
        aria-modal="true"
        aria-label="Navigation"
        tabIndex={-1}
      >
        <AppSidebarV2 />
      </div>
    </div>
  );
}
