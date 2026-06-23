"use client";

/**
 * Phase 4A — Reusable Trust Center section list. Driven by `kind`
 * (METHODOLOGY / AI_DISCLOSURE / SECURITY). Same shape as the
 * landing page but filtered to one kind.
 *
 * Phase 4A enterprise polish:
 *  - 4-phase load state (loading / loaded / empty / error) — mirrors
 *    status/page.tsx so the page never sticks on "Loading…" after a
 *    failed request and the empty / error paths are honestly visible
 *    to the user with bounded vocabulary (no env names / stack
 *    traces).
 *  - Implementation references collapsed under a <details> summary
 *    so long reference lists no longer dominate the card visually.
 */

import { useCallback, useEffect, useState } from "react";

import type {
  TrustArticleKind,
  TrustArticleProjection,
} from "@proovra/shared";

import { apiFetch } from "../../../../lib/api";
import { DriftBadge } from "./_drift-badge";

type LoadState =
  | { phase: "loading" }
  | { phase: "loaded"; articles: ReadonlyArray<TrustArticleProjection> }
  | { phase: "empty" }
  | { phase: "degraded"; reason: string }
  | { phase: "error"; message: string };

type TrustArticleListResponse = {
  articles?: ReadonlyArray<TrustArticleProjection> | null;
  degraded?: boolean;
  reason?: string | null;
};

function degradedMessage(reason: string) {
  switch (reason) {
    case "SCHEMA_NOT_READY":
      return "This Trust Center section is temporarily degraded because the required backend schema is not ready yet.";
    case "DB_UNAVAILABLE":
      return "This Trust Center section is temporarily degraded because the database is unavailable.";
    case "ARTICLE_AUTO_SEED_FAILED":
      return "This Trust Center section is temporarily degraded because the canonical seed content could not be prepared.";
    case "ARTICLE_READ_FAILED":
    default:
      return "This Trust Center section is temporarily degraded because trust content could not be loaded safely.";
  }
}

export function TrustCenterSectionList({
  kind,
  title,
  description,
  anchor,
}: {
  kind: TrustArticleKind;
  title: string;
  description: string;
  anchor: string;
}) {
  const [state, setState] = useState<LoadState>({ phase: "loading" });
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    setBusy(true);
    setState({ phase: "loading" });
    try {
      const res = (await apiFetch(`/v1/trust/articles?kind=${kind}`, {
        method: "GET",
      })) as TrustArticleListResponse | null;
      if (res?.degraded) {
        setState({
          phase: "degraded",
          reason: String(res.reason ?? "ARTICLE_READ_FAILED"),
        });
        return;
      }
      const list = (res?.articles ?? []) as ReadonlyArray<
        TrustArticleProjection
      >;
      if (list.length === 0) {
        setState({ phase: "empty" });
      } else {
        setState({ phase: "loaded", articles: list });
      }
    } catch {
      // Bounded operator-facing message. We never expose internal
      // error codes / env names / stack traces here. The Retry
      // button below lets the user re-attempt the load.
      setState({
        phase: "error",
        message:
          "Trust Center articles could not be loaded. Press Retry to try again.",
      });
    } finally {
      setBusy(false);
    }
  }, [kind]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const articles = state.phase === "loaded" ? state.articles : [];

  return (
    <div
      data-trust-center-page={anchor}
      style={{
        padding: 20,
        maxWidth: 1320,
        margin: "0 auto",
        color: "#0f172a",
        fontFamily: "Inter, system-ui, sans-serif",
      }}
    >
      <header style={{ marginBottom: 14 }}>
        <h1 style={{ fontSize: 22, marginTop: 0 }}>{title}</h1>
        <p style={{ color: "#475569", fontSize: 13, marginTop: 0 }}>
          {description}
        </p>
        <p style={{ marginTop: 6 }}>
          <a href="/trust-hub" style={{ fontSize: 12 }}>
            ← Back to Trust Center
          </a>
        </p>
      </header>

      <div style={{ marginBottom: 12 }}>
        <button
          type="button"
          data-trust-center-page-refresh={anchor}
          onClick={() => void refresh()}
          disabled={busy}
          style={{
            padding: "6px 12px",
            border: "1px solid #0f172a",
            background: "#0f172a",
            color: "#fafafa",
            fontWeight: 600,
            fontSize: 12,
            borderRadius: 8,
            cursor: "pointer",
          }}
        >
          {busy
            ? "Loading…"
            : state.phase === "error"
              ? "Retry"
              : "Refresh"}
        </button>
      </div>

      {state.phase === "loading" ? (
        <p
          data-trust-center-page-phase="loading"
          style={{ color: "#475569", fontSize: 12 }}
        >
          Loading articles…
        </p>
      ) : null}

      {state.phase === "error" ? (
        <div
          data-trust-center-page-phase="error"
          style={{
            padding: 12,
            background: "rgba(185, 28, 28, 0.06)",
            border: "1px solid rgba(185, 28, 28, 0.20)",
            borderRadius: 8,
            color: "#7f1d1d",
            fontSize: 12,
          }}
        >
          {state.message}
        </div>
      ) : null}

      {state.phase === "degraded" ? (
        <div
          data-trust-center-page-phase="degraded"
          data-trust-center-page-reason={state.reason}
          style={{
            padding: 12,
            background: "rgba(148, 163, 184, 0.10)",
            border: "1px solid rgba(148, 163, 184, 0.28)",
            borderRadius: 8,
            color: "#334155",
            fontSize: 12,
            display: "grid",
            gap: 6,
          }}
        >
          <div>{degradedMessage(state.reason)}</div>
          <div>
            Reason: <code>{state.reason}</code>
          </div>
        </div>
      ) : null}

      {state.phase === "empty" ? (
        <p
          data-trust-center-page-phase="empty"
          style={{ color: "#475569", fontSize: 12 }}
        >
          This Trust Center section is not published for the active workspace
          yet.
        </p>
      ) : null}

      {state.phase === "loaded" ? (
        <div style={{ display: "grid", gap: 10 }}>
          {articles.map((a) => (
            <article
              key={a.id}
              data-trust-center-page-section={a.section}
              data-trust-article-state={a.state}
              data-trust-article-version={a.version}
              style={{
                background: "#fff",
                border: "1px solid rgba(15, 23, 42, 0.08)",
                borderRadius: 10,
                padding: 12,
              }}
            >
              <header
                style={{
                  display: "flex",
                  alignItems: "baseline",
                  justifyContent: "space-between",
                }}
              >
                <strong style={{ fontSize: 15 }}>{a.title}</strong>
                <small style={{ fontSize: 11, color: "#475569" }}>
                  <code>{a.section}</code> · v{a.version} · {a.state}
                  {a.driftState ? <DriftBadge state={a.driftState} /> : null}
                </small>
              </header>
              <p style={{ color: "#334155", fontSize: 13, marginTop: 6 }}>
                {a.summary}
              </p>
              <pre
                style={{
                  margin: "8px 0 0",
                  padding: 8,
                  background: "rgba(15, 23, 42, 0.04)",
                  border: "1px solid rgba(15, 23, 42, 0.06)",
                  borderRadius: 6,
                  fontSize: 11,
                  whiteSpace: "pre-wrap",
                  color: "#0f172a",
                }}
              >
                {a.body}
              </pre>
              {a.implementationReferences.length > 0 ? (
                <details
                  data-trust-center-page-references={a.section}
                  style={{ marginTop: 8 }}
                >
                  <summary
                    style={{
                      fontSize: 11,
                      color: "#475569",
                      cursor: "pointer",
                      fontWeight: 600,
                    }}
                  >
                    Implementation references ·{" "}
                    {a.implementationReferences.length}
                  </summary>
                  <div
                    style={{
                      marginTop: 6,
                      fontSize: 11,
                      color: "#475569",
                      lineHeight: 1.6,
                    }}
                  >
                    {a.implementationReferences.map((r) => (
                      <code
                        key={r}
                        style={{
                          marginRight: 6,
                          padding: "1px 4px",
                          background: "rgba(15, 23, 42, 0.04)",
                          borderRadius: 4,
                          display: "inline-block",
                        }}
                      >
                        {r}
                      </code>
                    ))}
                  </div>
                </details>
              ) : null}
            </article>
          ))}
        </div>
      ) : null}
    </div>
  );
}
