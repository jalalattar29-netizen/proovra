"use client";

/**
 * Section-scoped error boundary for /investigation.
 *
 * Previously, any uncaught error inside the investigation subtree — most
 * notably the IndexingProgressGrid crash that read totals.ocrAvailable /
 * .ocrIndexed / .transcriptAvailable / .transcriptIndexed without guards
 * when the API returned a partial indexingTotals object — bubbled all the
 * way to apps/web/app/error.tsx (the GLOBAL root boundary) and the user
 * saw the generic "Something went wrong" page with no context.
 *
 * This boundary contains the failure to the investigation subtree:
 *
 *   - The shell chrome (sidebar, topbar) keeps rendering.
 *   - The user sees a clear, actionable panel naming the section.
 *   - A Retry button calls reset() to remount the segment.
 *   - The error is reported to Sentry with a `web_investigation_segment`
 *     feature tag so the next failure is searchable in one query.
 *
 * Privacy notes:
 *   - We never render error.message or error.stack to the DOM (could leak
 *     PII captured by an upstream throw, or expose internal field paths).
 *   - We never echo back URL query parameters — the operator's search
 *     terms can be sensitive in an investigation context.
 *   - We only surface error.digest (Next.js-generated opaque id) for
 *     cross-referencing with server logs.
 *
 * NO data fetches here. NO duplicate investigation system. NO new routes.
 * Pure error-display primitive — see evidence-lifecycle/error.tsx for the
 * pattern this file mirrors.
 */

import { useEffect } from "react";
import { captureException } from "../../../lib/sentry";

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // Tag with feature + route so the SRE team can pivot from a Sentry
    // alert straight to this boundary without grepping the codebase.
    captureException(error, {
      feature: "web_investigation_segment",
      route: "/investigation",
      digest: error.digest ?? null,
    });
  }, [error]);

  return (
    <main
      data-investigation-error
      style={{
        padding: 20,
        maxWidth: 900,
        margin: "0 auto",
        fontFamily: "Inter, system-ui, sans-serif",
        color: "#0f172a",
      }}
    >
      <header style={{ marginBottom: 12 }}>
        <h1 style={{ fontSize: 22, marginTop: 0 }}>Investigation</h1>
        <p style={{ color: "#475569", fontSize: 13, marginTop: 0 }}>
          We couldn&apos;t load the investigation surface. The rest of the
          app is still usable.
        </p>
      </header>

      <section
        role="alert"
        data-investigation-error-panel
        style={{
          background: "#fef2f2",
          border: "1px solid #fecaca",
          borderRadius: 10,
          padding: 14,
          color: "#7f1d1d",
        }}
      >
        <strong style={{ display: "block", fontSize: 14, marginBottom: 4 }}>
          This part of Investigation did not load.
        </strong>
        <div style={{ fontSize: 13, marginBottom: 10 }}>
          The page hit an unexpected client-side error. Your data is safe —
          nothing in this console performs automatic mutations on load. You
          can retry this section, or jump back to other surfaces.
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
            data-investigation-error-retry
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
            href="/investigation"
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
            Reload Investigation home
          </a>
          <a
            href="/search"
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
            Open Search
          </a>
        </div>
      </section>
    </main>
  );
}
