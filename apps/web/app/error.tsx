"use client";

import { useEffect } from "react";

import { ProovraSystemState } from "../components/feedback/ProovraSystemState";
import { captureException } from "../lib/sentry";

/**
 * Root error boundary — catches failures in public/root segments (the
 * authenticated `(app)` group has its own in-shell boundary). Reassures
 * that data is unchanged, offers retry + a safe public escape, and
 * surfaces the trace id only as a copyable support reference (never a
 * raw message/stack).
 */
export default function RootError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    captureException(error, { feature: "web_root_error" });
  }, [error]);

  return (
    <ProovraSystemState
      kind="server-error"
      context="public"
      testId="root-error"
      supportReference={error.digest}
      actions={[
        { label: "Try again", onClick: () => reset(), variant: "primary" },
        { label: "Go to homepage", href: "/", variant: "secondary" },
        { label: "Contact support", href: "/support", variant: "text" },
      ]}
    />
  );
}
