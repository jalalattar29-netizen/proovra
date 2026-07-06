"use client";

import { useEffect } from "react";

import { ProovraErrorState } from "../components/feedback/ProovraErrorState";
import { captureException } from "../lib/sentry";

/**
 * Branded route/page error boundary (PROOVRA Feedback System). Reassures
 * that data is unchanged, offers retry + escape, and surfaces the trace
 * id only as a copyable support reference — never a raw message/stack.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    captureException(error, { feature: "web_global_error" });
  }, [error]);

  return (
    <ProovraErrorState
      severity="error"
      title="We couldn't load this page"
      message="Your evidence data has not been changed. Try again, or head back — and contact support if the problem continues."
      supportReference={error.digest}
      actions={[
        { label: "Try again", onClick: reset, variant: "primary" },
        { label: "Back to home", href: "/", variant: "secondary" },
        { label: "Contact support", href: "/support", variant: "secondary" },
      ]}
    />
  );
}
