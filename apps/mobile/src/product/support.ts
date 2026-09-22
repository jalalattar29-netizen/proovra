/**
 * SUPPORT — the routes a user takes when something needs a human.
 *
 * Ports `apps/web/app/support/page.tsx`, which the AUTHENTICATED app sends
 * users to from five call sites: `app/(app)/error.tsx`, `not-found.tsx`,
 * Search and billing. It is a public page in the web's tree, but it is a real
 * in-app destination — which is why it is in the Native scope at all, and why
 * a phone user hitting an error had nowhere to go until now.
 *
 * ===========================================================================
 * WHERE THE CONTENT COMES FROM
 * ===========================================================================
 * The four routes and their contact addresses are the web page's, restated
 * here because they are UI copy over a fixed set of destinations, not content
 * with a canonical source. Everything that DOES have a canonical source is
 * taken from it: the Security policy, the DPA, Subprocessors, Verification
 * Methodology and the Support Policy are legal documents served by
 * `GET /v1/legal/:slug`, so this module names slugs and the reader renders the
 * real text. None of that text is duplicated here.
 *
 * The Trust Center destination is the IN-APP one. The web's card points at the
 * public `/trust` page; native has the same material in-product, and sending a
 * user out to a browser from a support screen is precisely the handoff this
 * conversion removed.
 *
 * Pure: no React, no react-native, no fetch.
 */

export const SUPPORT_EMAIL = "support@proovra.com";
export const BILLING_EMAIL = "billing@proovra.com";
export const SECURITY_EMAIL = "security@proovra.com";

export type SupportDestination =
  | { kind: "email"; address: string }
  | { kind: "legal"; slug: string }
  | { kind: "route"; path: string };

export interface SupportRoute {
  key: string;
  label: string;
  title: string;
  body: string;
  cta: string;
  destination: SupportDestination;
}

/**
 * The four routes the web offers, in its order.
 *
 * Security and Legal point at documents rather than an inbox on purpose: the
 * web does the same, because a responsible-disclosure report sent before
 * reading the policy is a report that usually has to be sent again.
 */
export const SUPPORT_ROUTES: ReadonlyArray<SupportRoute> = [
  {
    key: "product",
    label: "Product",
    title: "Product support",
    body: "For questions about capture, evidence records, verification pages, reports, account workflows, and general product usage.",
    cta: `Email ${SUPPORT_EMAIL}`,
    destination: { kind: "email", address: SUPPORT_EMAIL },
  },
  {
    key: "billing",
    label: "Billing",
    title: "Account and billing",
    body: "For login, subscription, payment, invoice, refund, and plan questions.",
    cta: `Email ${BILLING_EMAIL}`,
    destination: { kind: "email", address: BILLING_EMAIL },
  },
  {
    key: "security",
    label: "Security",
    title: "Security and responsible disclosure",
    body: "For vulnerability reports, suspected compromise, security concerns, and responsible-disclosure intake.",
    cta: "Open Security policy",
    destination: { kind: "legal", slug: "security" },
  },
  {
    key: "legal",
    label: "Legal & privacy",
    title: "Legal and privacy requests",
    body: "For law-enforcement, data-subject, privacy, copyright, abuse, and other legally sensitive requests.",
    cta: "Open Trust Center",
    // The IN-APP Trust Center, not the public marketing page.
    destination: { kind: "route", path: "/(stack)/trust-center" },
  },
];

/**
 * The reference documents the web lists beside the routes.
 *
 * Named by SLUG, never by text: every one of these is a legal document the
 * canonical corpus already serves, and a second copy of a DPA or a security
 * overview is the drift the legal delivery exists to prevent.
 */
export const SUPPORT_REFERENCES: ReadonlyArray<{ label: string; slug: string }> = [
  { label: "Support Policy", slug: "support" },
  { label: "Data Processing Agreement", slug: "dpa" },
  { label: "Security & Responsible Disclosure", slug: "security" },
  { label: "Subprocessors", slug: "subprocessors" },
  { label: "Verification Methodology", slug: "verification-methodology" },
];

/** A `mailto:` a device can actually open. */
export function mailtoUrl(address: string, subject?: string): string {
  const base = `mailto:${address}`;
  return subject ? `${base}?subject=${encodeURIComponent(subject)}` : base;
}

/** The in-app path a destination resolves to, or null for an email. */
export function destinationPath(destination: SupportDestination): string | null {
  switch (destination.kind) {
    case "legal":
      return `/legal/${destination.slug}`;
    case "route":
      return destination.path;
    case "email":
      return null;
  }
}
