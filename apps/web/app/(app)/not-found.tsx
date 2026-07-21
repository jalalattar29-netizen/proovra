"use client";

import { useRouter } from "next/navigation";

import { ProovraSystemState } from "../../components/feedback/ProovraSystemState";

/**
 * Authenticated not-found boundary. Any `notFound()` raised inside the
 * `(app)` route group resolves HERE, so it renders INSIDE the App Shell
 * (sidebar + app header + workspace context stay mounted via the
 * `(app)/layout.tsx`). Recovery actions stay in-app — never the public
 * marketing site — so the user never appears signed out.
 */
export default function AppNotFound() {
  const router = useRouter();

  return (
    <ProovraSystemState
      kind="not-found"
      context="authenticated"
      testId="app-not-found"
      message="The page may have moved or been renamed, or you may not have access to it in this workspace. Your session and evidence data are unaffected."
      actions={[
        { label: "Return to dashboard", href: "/home", variant: "primary" },
        { label: "Go back", onClick: () => router.back(), variant: "secondary" },
        {
          label: "Contact support",
          href: "/support",
          variant: "text",
          external: true,
        },
      ]}
    />
  );
}
