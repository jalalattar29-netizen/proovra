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
import { ProovraSystemState } from "../feedback/ProovraSystemState";

/** Only a same-origin path is carried to the sign-in page. */
export function signInReturnPath(pathname: string | null, search = ""): string {
  const path = pathname && pathname.startsWith("/") && !pathname.startsWith("//") ? pathname : "/home";
  const query = search && search.startsWith("?") ? search : "";
  return `${path}${query}`;
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
  const { state } = usePlatformContext();
  if (!active) return <>{children}</>;
  if (state.name === "FAILED" && state.errorCode === "AUTH_REQUIRED") {
    const search = typeof window === "undefined" ? "" : window.location.search;
    return <SignedOutAppState pathname={pathname} search={search} />;
  }
  if (state.name === "IDLE" || state.name === "LOADING_CONTEXT") {
    return <div className="min-h-screen bg-[#f3f5f7]" data-signed-out-app-resolving />;
  }
  return <>{children}</>;
}
