import type { CSSProperties, ReactNode } from "react";
import { MarketingHeader } from "../MarketingHeader";
import { EnterpriseFooter } from "../EnterpriseFooter";

/**
 * THE PUBLIC PAGES' ONE `<main>` (AUD-0015).
 *
 * Twenty-one public routes — the marketing pages, the legal documents, the
 * verify demo and the sign-in callback — rendered no main landmark at all:
 * each page composes `MarketingHeader`, its content and `EnterpriseFooter`
 * itself, usually with the header nested inside its own hero, so there was no
 * page-level element to hang the landmark on and no shared layout above them.
 *
 * The landmark is therefore given at the LAYOUT level: each of those route
 * segments has a `layout.tsx` that is `PublicMainLayout` and nothing else, so
 * a page cannot forget it and a new page under the segment inherits it. The
 * pages themselves render no `<main>`; `main-landmark-ownership.test.mjs`
 * keeps `<main>` out of every other component, and the public-main render
 * test pins that each wired segment ends up with exactly one.
 *
 * `id="main-content"` with `tabIndex={-1}` mirrors the app shell's
 * `#app-main-content`: a focus TARGET for an in-page skip link, never a
 * permanent tab stop.
 */
export const PUBLIC_MAIN_ID = "main-content";

export function PublicMain({
  children,
  className,
  style,
}: {
  children: ReactNode;
  className?: string;
  style?: CSSProperties;
}) {
  return (
    <main
      id={PUBLIC_MAIN_ID}
      tabIndex={-1}
      data-public-main
      className={className}
      style={style}
    >
      {children}
    </main>
  );
}

/** The whole of every public segment's `layout.tsx`. */
export function PublicMainLayout({ children }: { children: ReactNode }) {
  return <PublicMain>{children}</PublicMain>;
}

export function MarketingPage({ children }: { children: ReactNode }) {
  return (
    <PublicMain
      className="min-h-screen w-full bg-[var(--proovra-page-bg)] text-[#0F172A]"
      style={{ fontFamily: "var(--font-jakarta), Inter, system-ui, sans-serif" }}
    >
      <MarketingHeader />
      {children}
      <EnterpriseFooter />
    </PublicMain>
  );
}
