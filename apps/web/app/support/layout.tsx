/**
 * AUD-0015 — this public segment's content is the page's one `<main>`.
 * The page itself must not render another; see PublicMain in MarketingPage.
 *
 * B2A-F-12 — the page is a client component (it reads the reader's language
 * through `useT()`), and a client page cannot export metadata, so the
 * segment's metadata lives here. It stays English, as every page title does.
 */
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Support · PROOVRA",
  description:
    "Support Operations Center for PROOVRA. Pick the route that matches your request — product, billing, security disclosure, legal and privacy intake, or enterprise evaluation.",
  alternates: { canonical: "/support" },
};

export { PublicMainLayout as default } from "../../components/marketing/page-shell/MarketingPage";
