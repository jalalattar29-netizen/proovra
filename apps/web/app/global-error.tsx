"use client";

import { useEffect } from "react";

import { ProovraErrorState } from "../components/feedback/ProovraErrorState";
import { captureException } from "../lib/sentry";

/**
 * Branded GLOBAL error boundary — catches failures in the root layout
 * itself. Next.js renders this INSTEAD of the root layout, so it must
 * provide its own <html>/<body> and cannot rely on app CSS. The
 * ProovraErrorState surface is fully self-styled (inline). This replaces
 * the unbranded Next.js default error screen.
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
        <ProovraErrorState
          severity="error"
          title="We couldn't load PROOVRA"
          message="An unexpected error interrupted the app. Your evidence data has not been changed. Try again, or contact support if this keeps happening."
          supportReference={error.digest}
          minHeight="100vh"
          actions={[
            { label: "Try again", onClick: reset, variant: "primary" },
            { label: "Back to home", href: "/", variant: "secondary" },
            { label: "Contact support", href: "/support", variant: "secondary" },
          ]}
        />
      </body>
    </html>
  );
}
