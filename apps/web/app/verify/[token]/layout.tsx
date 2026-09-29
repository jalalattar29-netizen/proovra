import type { Metadata } from "next";
import type { ReactNode } from "react";

/**
 * ET-PKG-13 — a public Verify URL is a capability to the record. Crawlers that
 * see the link must not index, follow or archive it. The middleware also sends
 * `X-Robots-Tag` for these paths; this meta tag covers every environment.
 */
export const metadata: Metadata = {
  robots: { index: false, follow: false, nocache: true, googleBot: { index: false, follow: false, noarchive: true } },
};

export default function VerifyTokenLayout({ children }: { children: ReactNode }) {
  return children;
}
