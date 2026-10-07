import type { Metadata } from "next";
import type { ReactNode } from "react";

/**
 * PROOVRA's public package record. A package id is not a secret, but the page
 * describes one issued package and has no business in a search index.
 */
export const metadata: Metadata = {
  title: "Package record · PROOVRA",
  robots: { index: false, follow: false, nocache: true, googleBot: { index: false, follow: false, noarchive: true } },
};

export default function VerifyPackageLayout({ children }: { children: ReactNode }) {
  return children;
}
