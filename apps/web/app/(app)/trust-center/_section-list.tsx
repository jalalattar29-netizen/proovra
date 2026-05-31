"use client";

/**
 * Phase 4A — Reusable Trust Center section list. Driven by `kind`
 * (METHODOLOGY / AI_DISCLOSURE / SECURITY). Same shape as the
 * landing page but filtered to one kind.
 */

import { useCallback, useEffect, useState } from "react";

import type {
  TrustArticleKind,
  TrustArticleProjection,
} from "@proovra/shared";

import { apiFetch } from "../../../lib/api";
import { DriftBadge } from "./_drift-badge";

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
  const [articles, setArticles] = useState<ReadonlyArray<TrustArticleProjection>>([]);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    setBusy(true);
    try {
      const res = await apiFetch(`/v1/trust/articles?kind=${kind}`, {
        method: "GET",
      });
      setArticles(
        (res?.articles ?? []) as ReadonlyArray<TrustArticleProjection>,
      );
    } catch {
      setArticles([]);
    } finally {
      setBusy(false);
    }
  }, [kind]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

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
          <a href="/trust-center" style={{ fontSize: 12 }}>
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
          {busy ? "Loading…" : "Refresh"}
        </button>
      </div>

      {articles.length === 0 ? (
        <p style={{ color: "#475569", fontSize: 12 }}>
          No published articles for this kind. Use the Trust Center landing's
          "Re-seed defaults" action.
        </p>
      ) : (
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
                <small style={{ fontSize: 11, color: "#475569", display: "block", marginTop: 6 }}>
                  References:{" "}
                  {a.implementationReferences.map((r) => (
                    <code key={r} style={{ marginRight: 6 }}>
                      {r}
                    </code>
                  ))}
                </small>
              ) : null}
            </article>
          ))}
        </div>
      )}
    </div>
  );
}
