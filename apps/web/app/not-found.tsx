"use client";

import { usePathname } from "next/navigation";

import { ProovraSystemState } from "../components/feedback/ProovraSystemState";

/**
 * The root 404 — and it is NOT only reached by signed-out visitors.
 *
 * ===========================================================================
 * THE ASSUMPTION THAT WAS WRONG
 * ===========================================================================
 * This file used to say it was "rendered for unknown URLs outside the
 * authenticated (app) group (which has its own in-shell boundary)". That is
 * true for every route that raises `notFound()` from inside the group — but
 * not for a route with `dynamicParams = false`. There, an unknown param is a
 * ROUTING-level 404, and a routing 404 resolves against THIS boundary,
 * skipping every segment boundary beneath it.
 *
 * So opening `/admin/platform/runbooks/no-such-runbook` as a signed-in
 * platform admin rendered the public marketing 404 and offered them a "Sign
 * in" button. `(app)/not-found.tsx` exists specifically to prevent that; its
 * comment promises recovery stays in-app "so the user never appears signed
 * out". It could not keep that promise for a route it never sees.
 *
 * Adding a `not-found.tsx` inside the dynamic segment does NOT fix it — that
 * was tried and the marketing page still rendered, which is what established
 * the routing-level behaviour above rather than assuming it.
 *
 * ===========================================================================
 * WHY THE PATH DECIDES, RATHER THAN THE SESSION
 * ===========================================================================
 * The honest question here is "where was the reader?", not "who are they?".
 * A 404 boundary has no session, and reaching for one would mean an auth
 * check on a page whose entire job is to render fast and say one thing.
 *
 * The pathname answers the question that matters: somebody who typed an
 * `/admin/*` URL wants back into the console, and offering them "Sign in" is
 * wrong whether or not they happen to hold a session. Somebody on `/pricng`
 * wants the marketing site. Neither needs to be identified to be helped.
 */

/** Route prefixes that belong to the signed-in product. */
const APP_PREFIXES = ["/admin", "/home", "/evidence", "/cases", "/reports", "/settings"];

export default function NotFound() {
  const pathname = usePathname() ?? "";
  const inConsole = pathname.startsWith("/admin");
  const inApp = APP_PREFIXES.some(
    (p) => pathname === p || pathname.startsWith(`${p}/`),
  );

  if (inConsole) {
    return (
      <ProovraSystemState
        kind="not-found"
        context="authenticated"
        testId="admin-not-found"
        message="No console page matches that address. It may have been renamed, or the link may be older than the current build. Your session is unaffected."
        actions={[
          { label: "Admin overview", href: "/admin", variant: "primary" },
          {
            label: "All runbooks",
            href: "/admin/platform/runbooks",
            variant: "secondary",
          },
        ]}
      />
    );
  }

  if (inApp) {
    return (
      <ProovraSystemState
        kind="not-found"
        context="authenticated"
        testId="app-routing-not-found"
        message="That address does not match a page. It may have moved or been renamed. Your session and evidence data are unaffected."
        actions={[
          { label: "Return to dashboard", href: "/home", variant: "primary" },
        ]}
      />
    );
  }

  return (
    <ProovraSystemState
      kind="not-found"
      context="public"
      testId="public-not-found"
      actions={[
        { label: "Go to homepage", href: "/", variant: "primary" },
        { label: "Sign in", href: "/login", variant: "secondary" },
        { label: "Contact support", href: "/support", variant: "text" },
      ]}
    />
  );
}
