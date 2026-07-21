"use client";

import { useEffect } from "react";

import { ProovraSystemState } from "../../components/feedback/ProovraSystemState";
import { captureException } from "../../lib/sentry";

/**
 * Authenticated error boundary for the `(app)` route group. Any uncaught
 * render error inside an operator surface (that isn't caught by a nested
 * section boundary) resolves HERE, so it renders INSIDE the App Shell —
 * sidebar + app header + workspace context stay mounted. Recovery stays
 * in-app; the raw message/stack is never shown (only the opaque digest,
 * via ProovraSupportReference).
 */
export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    captureException(error, { feature: "web_app_error" });
  }, [error]);

  return (
    <ProovraSystemState
      kind="server-error"
      context="authenticated"
      testId="app-error"
      supportReference={error.digest}
      actions={[
        { label: "Try again", onClick: () => reset(), variant: "primary" },
        { label: "Return to dashboard", href: "/home", variant: "secondary" },
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
