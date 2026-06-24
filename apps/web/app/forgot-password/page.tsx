import { redirect } from "next/navigation";

/**
 * FP4 — `/forgot-password` is no longer a standalone UI. The form has
 * moved into a modal inside `/login`; deep links (older emails, stale
 * bookmarks, browser autofill suggestions) land here and are forwarded
 * to the login page with the auto-open flag set.
 *
 * Server-side `redirect()` runs before the page renders, so there's
 * no flash of empty content.
 */
export default function ForgotPasswordRedirectPage(): never {
  redirect("/login?forgot=1");
}
