"use client";

/**
 * Section-scoped error boundary for /evidence-lifecycle/*.
 *
 * Previously, any uncaught error inside the subtree (a render crash in
 * one of the seven lifecycle pages, an unhandled rejection turned into
 * an Error during commit, a thrown Zod issue inside a child component)
 * bubbled to apps/web/app/error.tsx — the GLOBAL root boundary — which
 * shows a generic "Something went wrong" page. That is exactly what
 * users saw on /evidence-lifecycle/retention.
 *
 * This boundary contains the failure to the lifecycle subtree:
 *
 *   - The shell chrome (sidebar, topbar) keeps rendering.
 *   - The user sees a clear, actionable panel naming the section.
 *   - A Retry button calls reset() to remount the segment.
 *   - The error is reported to Sentry with a `web_evidence_lifecycle`
 *     feature tag so the next failure is searchable in one query.
 *
 * NO duplicate lifecycle system. NO new routes. NO data fetches here.
 * Pure error-display primitive.
 */

import { useEffect } from "react";
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
    <main
      data-evidence-lifecycle-error
      style={{
        padding: 20,
        maxWidth: 900,
        margin: "0 auto",
        fontFamily: "Inter, system-ui, sans-serif",
        color: "#0f172a",
      }}
    >
      <header style={{ marginBottom: 12 }}>
        <h1 style={{ fontSize: 22, marginTop: 0 }}>Lifecycle Operations</h1>
        <p style={{ color: "#475569", fontSize: 13, marginTop: 0 }}>
          A section in this console could not be displayed.
        </p>
      </header>

      <section
        role="alert"
        data-evidence-lifecycle-error-panel
        style={{
          background: "#fef2f2",
          border: "1px solid #fecaca",
          borderRadius: 10,
          padding: 14,
          color: "#7f1d1d",
        }}
      >
        <strong style={{ display: "block", fontSize: 14, marginBottom: 4 }}>
          This part of Lifecycle Operations did not load.
        </strong>
        <div style={{ fontSize: 13, marginBottom: 10 }}>
          The page hit an unexpected client-side error. Your data is safe —
          nothing in this console performs automatic mutations on load. You can
          retry this section, or jump back to the lifecycle home.
        </div>
        {error.digest ? (
          <div
            style={{
              fontSize: 11,
              color: "#991b1b",
              fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
              marginBottom: 10,
            }}
          >
            Trace ref: <code>{error.digest}</code>
          </div>
        ) : null}
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button
            type="button"
            data-evidence-lifecycle-error-retry
            onClick={() => reset()}
            style={{
              padding: "6px 12px",
              border: "1px solid #7f1d1d",
              background: "#7f1d1d",
              color: "#fff",
              fontWeight: 600,
              fontSize: 12,
              borderRadius: 8,
              cursor: "pointer",
            }}
          >
            Retry this section
          </button>
          <a
            href="/evidence-lifecycle"
            style={{
              padding: "6px 12px",
              border: "1px solid #cbd5e1",
              background: "#fff",
              color: "#0f172a",
              fontWeight: 600,
              fontSize: 12,
              borderRadius: 8,
              textDecoration: "none",
            }}
          >
            Back to Lifecycle home
          </a>
          <a
            href="/governance/lifecycle"
            style={{
              padding: "6px 12px",
              border: "1px solid #cbd5e1",
              background: "#fff",
              color: "#4338ca",
              fontWeight: 600,
              fontSize: 12,
              borderRadius: 8,
              textDecoration: "none",
            }}
          >
            Open Governance Posture (read-only)
          </a>
        </div>
      </section>
    </main>
  );
}
