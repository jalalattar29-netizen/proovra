"use client";

/**
 * Section-scoped error boundary for /investigation.
 *
 * Contains a render failure to the investigation subtree: the App Shell
 * (sidebar, header) keeps rendering, the operator sees the canonical
 * system-state surface, and the error is reported to Sentry with a
 * `web_investigation_segment` tag.
 *
 * Privacy: we never render error.message/stack (could leak PII or
 * internal field paths) and never echo query params (search terms can
 * be sensitive) — only the opaque `error.digest`, via the canonical
 * support-reference.
 *
 * (2026-07-21) Migrated off the bespoke red panel onto the canonical
 * `ProovraSystemState`. NO data fetches. NO duplicate investigation
 * system.
 */

import { useEffect } from "react";

import { ProovraSystemState } from "../../../components/feedback/ProovraSystemState";
import { captureException } from "../../../lib/sentry";

export default function InvestigationSegmentError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    captureException(error, {
      feature: "web_investigation_segment",
      route: "/investigation",
      digest: error.digest ?? null,
    });
  }, [error]);

  return (
    <ProovraSystemState
      kind="server-error"
      context="authenticated"
      presentation="contained"
      testId="investigation-error"
      title="Investigation couldn't load this surface"
      message="The page hit an unexpected client-side error. Your data is safe — nothing in this console performs automatic mutations on load. Retry this section, or jump to another surface."
      supportReference={error.digest}
      actions={[
        { label: "Retry this section", onClick: () => reset(), variant: "primary" },
        { label: "Reload Investigation home", href: "/investigation", variant: "secondary" },
        { label: "Open Search", href: "/search", variant: "text" },
      ]}
    />
  );
}
