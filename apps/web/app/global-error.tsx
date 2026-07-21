"use client";

import { useEffect } from "react";

import { ProovraSystemState } from "../components/feedback/ProovraSystemState";
import { captureException } from "../lib/sentry";

/**
 * Global error boundary — catches failures in the root layout ITSELF.
 * Next.js renders this INSTEAD of the root layout, so it must provide its
 * own <html>/<body> and cannot rely on app CSS. `ProovraSystemState` is
 * fully self-styled (inline), so it renders correctly with no stylesheet.
 * Kept intentionally self-contained + robust so a layout crash never
 * recursively fails (no MarketingHeader/Footer here).
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    captureException(error, { feature: "web_root_global_error" });
  }, [error]);

  return (
    <html lang="en">
      <body style={{ margin: 0, background: "#F7F8FC" }}>
        <ProovraSystemState
          kind="server-error"
          context="public"
          testId="global-error"
          minHeight="100vh"
          title="We couldn't load PROOVRA"
          message="An unexpected error interrupted the app. Your evidence data has not been changed. Try again, or contact support if this keeps happening."
          supportReference={error.digest}
          actions={[
            { label: "Try again", onClick: () => reset(), variant: "primary" },
            { label: "Go to homepage", href: "/", variant: "secondary" },
            { label: "Contact support", href: "/support", variant: "text" },
          ]}
        />
      </body>
    </html>
  );
}
