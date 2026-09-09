"use client";

import { useEffect, useState } from "react";
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

  /**
   * THE PATH IS NOT KNOWN WHEN THIS IS PRERENDERED, AND PRETENDING OTHERWISE
   * SHIPPED THE EXACT BUG THE DOCBLOCK ABOVE PROMISES TO PREVENT.
   *
   * A routing-level 404 — which is what `dynamicParams = false` produces —
   * is served from `/_not-found`, and Next PRERENDERS that at build time.
   * At prerender `usePathname()` is not the address the reader typed, so the
   * server picked the public branch and shipped "Go to homepage / Sign in" to
   * a signed-in platform admin. The client then hydrated, saw the real
   * `/admin/...` path, and swapped to the console branch — React #418, a text
   * hydration mismatch, on every console 404.
   *
   * Measured directly against a production build before this fix:
   *
   *   GET /admin/platform/runbooks/no-such-runbook-slug
   *     -> 404, and the HTML contained data-testid="public-not-found"
   *
   * `next dev` renders per request, so `usePathname()` was correct there and
   * the whole thing was invisible in development. It took serving a real build
   * to see it.
   *
   * The fix is to stop asserting an audience the server cannot know. Both the
   * server render and the FIRST client render use the neutral branch, so they
   * agree and there is no mismatch; the audience-specific recovery appears the
   * moment the path is actually knowable. The neutral copy is true for every
   * reader and pushes nobody toward a sign-in they may not need.
   */
  const [pathKnown, setPathKnown] = useState(false);
  useEffect(() => setPathKnown(true), []);

  const inConsole = pathKnown && pathname.startsWith("/admin");
  const inApp =
    pathKnown &&
    APP_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`));

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
            label: "Back to Runbooks",
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

  /*
   * THE HONEST STATE FOR "WE DO NOT KNOW WHERE YOU WERE".
   *
   * This is what the prerendered HTML carries, so it must be true for every
   * reader. The public branch below is NOT that: it offers "Sign in" to
   * somebody who may already hold a session, which is the specific wrong
   * advice this whole file exists to stop giving.
   *
   * It says what is certainly true — the address matches no page, nothing was
   * lost — and offers the one link that is right for everyone. The
   * audience-specific recovery replaces it as soon as the path is knowable,
   * which for a real reader is the same frame they see.
   */
  if (!pathKnown) {
    return (
      <ProovraSystemState
        kind="not-found"
        context="public"
        testId="unresolved-not-found"
        message="That address does not match a page. Nothing has been lost — if you were signed in, your session and data are unaffected."
        actions={[{ label: "Contact support", href: "/support", variant: "text" }]}
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
