"use client";

/**
 * Section-scoped error boundary for /evidence-lifecycle/*.
 *
 * Contains a render failure to the lifecycle subtree: the App Shell
 * (sidebar, header) keeps rendering, the operator sees the canonical
 * system-state surface (retry + in-app recovery + trace reference), and
 * the error is reported to Sentry with a `web_evidence_lifecycle` tag.
 *
 * (2026-07-21) Migrated off the bespoke red panel onto the canonical
 * `ProovraSystemState`. NO duplicate lifecycle system. NO data fetches.
 */

import { useEffect } from "react";

import { ProovraSystemState } from "../../../components/feedback/ProovraSystemState";
import { captureException } from "../../../lib/sentry";

export default function EvidenceLifecycleSegmentError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    captureException(error, {
      feature: "web_evidence_lifecycle",
      route: "/evidence-lifecycle",
      digest: error.digest ?? null,
    });
  }, [error]);

  return (
    <ProovraSystemState
      kind="server-error"
      context="authenticated"
      presentation="contained"
      testId="evidence-lifecycle-error"
      title="Lifecycle Operations couldn't load this section"
      message="The page hit an unexpected client-side error. Your data is safe — nothing in this console performs automatic mutations on load. Retry this section, or return to the lifecycle home."
      supportReference={error.digest}
      actions={[
        { label: "Retry this section", onClick: () => reset(), variant: "primary" },
        { label: "Back to Lifecycle home", href: "/evidence-lifecycle", variant: "secondary" },
        {
          label: "Open Governance Posture",
          href: "/governance/lifecycle",
          variant: "text",
        },
      ]}
    />
  );
}
