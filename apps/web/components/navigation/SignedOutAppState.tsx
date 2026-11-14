"use client";

/**
 * PRO-075 (UI-04) — what a signed-out visitor sees on an app route.
 *
 * The app shell rendered its pages for a visitor with no session. Every data
 * call then answered 401, and the page gates read the missing context as a
 * workspace or permission problem: "Workspace setup required" on /home,
 * /cases and /capture, "Permission required" on /billing and /settings,
 * "Platform administrator only" on /admin/users, and no way to sign in.
 *
 * The truthful state is "sign in": it says nothing about workspaces, plans or
 * roles the visitor does not yet have, and returns them to the same page.
 */
import type { ReactNode } from "react";

import { usePlatformContext } from "../../lib/platform-context";
import { safeReturnPath } from "../../lib/navigation/safe-return-path";
import { ProovraSystemState } from "../feedback/ProovraSystemState";

/** Only a same-origin path is carried to the sign-in page (F-26g rule). */
export function signInReturnPath(pathname: string | null, search = ""): string {
  const path = safeReturnPath(pathname);
  // A refused path falls back to /home, and takes no query with it.
  if (path !== pathname) return path;
  const query = search && search.startsWith("?") ? search : "";
  return safeReturnPath(`${path}${query}`, path);
}

export function signInHref(pathname: string | null, search = ""): string {
  return `/login?next=${encodeURIComponent(signInReturnPath(pathname, search))}`;
}

export function SignedOutAppState({
  pathname,
  search = "",
  presentation = "full-page",
}: {
  pathname: string | null;
  search?: string;
  presentation?: "full-page" | "contained";
}) {
  const returnPath = signInReturnPath(pathname, search);
  return (
    <div data-signed-out-app-state>
      <ProovraSystemState
        kind="forbidden"
        context={presentation === "full-page" ? "public" : "authenticated"}
        presentation={presentation}
        statusLabel="Sign in"
        title="Sign in to continue"
        message="This page is part of your PROOVRA account. Sign in and you will come straight back here."
        actions={[
          {
            label: "Sign in",
            href: signInHref(pathname, search),
            variant: "primary",
            testId: "signed-out-sign-in",
          },
          {
            label: "Create an account",
            href: `/register?returnUrl=${encodeURIComponent(returnPath)}`,
            variant: "secondary",
            testId: "signed-out-register",
          },
        ]}
        testId="signed-out-app-state"
      />
    </div>
  );
}

/**
 * F-18 — the session ended while this page was open (confirmed by the
 * platform context against the server; see PlatformContextProvider).
 *
 * The page stays mounted underneath, so anything typed into it is still there.
 * Three explicit choices, no automatic redirect and no automatic retry:
 *   - sign in here and come straight back to this page (what is unsaved on it
 *     is left behind — the copy says so);
 *   - sign in in a new tab, keeping this one as it is;
 *   - after that, continue here (re-reads the context; the notice stays if the
 *     session is still missing).
 */
export function SessionEndedNotice({
  pathname,
  search = "",
  onContinue,
}: {
  pathname: string | null;
  search?: string;
  onContinue: () => void;
}) {
  const href = signInHref(pathname, search);
  return (
    <div
      role="alertdialog"
      aria-modal="true"
      aria-label="Your session has ended"
      data-session-ended-notice
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 1000,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 16,
        background: "rgba(15, 23, 42, 0.45)",
      }}
    >
      <div
        style={{
          width: "100%",
          maxWidth: 520,
          borderRadius: 16,
          background: "var(--surface-raised, #ffffff)",
          boxShadow: "0 24px 60px rgba(15, 23, 42, 0.25)",
        }}
      >
        <ProovraSystemState
          kind="forbidden"
          context="authenticated"
          presentation="contained"
          statusLabel="Session ended"
          title="Your session has ended"
          message="Sign in again to keep working. Signing in here brings you straight back to this page, but anything not yet saved on it is lost — to keep it, sign in in a new tab and then continue here."
          actions={[
            { label: "Sign in again", href, variant: "primary", testId: "session-ended-sign-in" },
            {
              label: "Sign in in a new tab",
              href,
              external: true,
              variant: "secondary",
              testId: "session-ended-sign-in-new-tab",
            },
            {
              label: "I\u2019ve signed in \u2014 continue here",
              onClick: onContinue,
              variant: "text",
              testId: "session-ended-continue",
            },
          ]}
          testId="session-ended-state"
        />
      </div>
    </div>
  );
}

/**
 * PRO-075: a visitor with no session is offered sign-in, not the app shell.
 *
 * Decided on the platform context's own answer, not on the missing user
 * alone: `fetchMe` also returns null on a network failure, and a signed-in
 * person on a bad connection must keep the app (and its retry states), not be
 * told to sign in. Until the context answers, nothing is shown, so no
 * workspace or permission state flashes first.
 */
export function SignedOutAppGate({
  active,
  pathname,
  children,
}: {
  active: boolean;
  pathname: string | null;
  children: ReactNode;
}) {
  const { state, refresh } = usePlatformContext();
  if (!active) {
    // F-18 — signed in when the page loaded, signed out since.
    if (state.name === "FAILED" && state.errorCode === "AUTH_REQUIRED" && state.previous) {
      const search = typeof window === "undefined" ? "" : window.location.search;
      return (
        <>
          {children}
          <SessionEndedNotice pathname={pathname} search={search} onContinue={() => void refresh()} />
        </>
      );
    }
    return <>{children}</>;
  }
  if (state.name === "FAILED" && state.errorCode === "AUTH_REQUIRED") {
    const search = typeof window === "undefined" ? "" : window.location.search;
    return <SignedOutAppState pathname={pathname} search={search} />;
  }
  if (state.name === "IDLE" || state.name === "LOADING_CONTEXT") {
    return <div className="min-h-screen bg-[#f3f5f7]" data-signed-out-app-resolving />;
  }
  return <>{children}</>;
}
