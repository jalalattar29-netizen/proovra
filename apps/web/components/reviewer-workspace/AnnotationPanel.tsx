"use client";

/**
 * PROOVRA Phase 2A Closure — Inline annotation panel.
 *
 * Right-pane surface that lists annotations for the active evidence,
 * groups replies under their roots, and supports:
 *
 *   - inline reply (single textarea, one click to post)
 *   - resolve / bulk-resolve
 *   - selection set for bulk operations
 *
 * Workspace-anchored read via `/v1/reviewer/evidence/:id/annotations`.
 * No deep links to a separate annotation page.
 */

import { useMemo, useState } from "react";

import { apiFetch } from "../../lib/api";
import type { ReviewerAnnotationSummary } from "../../lib/reviewer-workspace/annotation-types";

export type AnnotationPanelProps = {
  evidenceId: string;
  annotations: ReadonlyArray<ReviewerAnnotationSummary>;
  onChange: () => void;
};

type Thread = {
  root: ReviewerAnnotationSummary;
  replies: ReviewerAnnotationSummary[];
};

export function AnnotationPanel({
  evidenceId,
  annotations,
  onChange,
}: AnnotationPanelProps) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [replyDraft, setReplyDraft] = useState<Record<string, string>>({});
  const [banner, setBanner] = useState<string | null>(null);

  const threads = useMemo<Thread[]>(() => {
    const map = new Map<string, Thread>();
    for (const a of annotations) {
      if (a.parentAnnotationId === null) {
        map.set(a.id, { root: a, replies: [] });
      }
    }
    for (const a of annotations) {
      if (a.parentAnnotationId !== null) {
        const t = map.get(a.parentAnnotationId);
        if (t) t.replies.push(a);
      }
    }
    return Array.from(map.values()).sort(
      (x, y) => +new Date(y.root.createdAt) - +new Date(x.root.createdAt),
    );
  }, [annotations]);

  async function postReply(rootId: string) {
    const body = (replyDraft[rootId] ?? "").trim();
    if (!body) return;
    try {
      await apiFetch(`/v1/reviewer/annotations/${rootId}/reply`, {
        method: "POST",
        body: JSON.stringify({ body }),
      });
      setReplyDraft((d) => ({ ...d, [rootId]: "" }));
      onChange();
    } catch (e) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      setBanner(`Reply refused: ${((e as any)?.body?.denial ?? "unknown")}`);
    }
  }

  async function resolve(id: string) {
    try {
      await apiFetch(`/v1/reviewer/annotations/${id}/resolve`, {
        method: "POST",
        body: "{}",
      });
      onChange();
    } catch (e) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      setBanner(`Resolve refused: ${((e as any)?.body?.denial ?? "unknown")}`);
    }
  }

  async function bulkResolve() {
    const ids = Array.from(selected);
    if (ids.length === 0) return;
    try {
      const res = await apiFetch(
        `/v1/reviewer/annotations/bulk-resolve`,
        {
          method: "POST",
          body: JSON.stringify({ annotationIds: ids }),
        },
      );
      setBanner(`Resolved ${res?.resolved ?? 0} of ${ids.length}.`);
      setSelected(new Set());
      onChange();
    } catch (e) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      setBanner(`Bulk refused: ${((e as any)?.body?.denial ?? "unknown")}`);
    }
  }

  function toggleSelect(id: string) {
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  return (
    <section
      data-annotation-panel
      data-annotation-evidence-id={evidenceId}
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 8,
        background: "rgba(15, 23, 42, 0.03)",
        border: "1px solid rgba(15, 23, 42, 0.08)",
        borderRadius: 12,
        padding: "10px 12px",
        minWidth: 320,
        maxHeight: "100%",
        overflowY: "auto",
      }}
    >
      <header
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
        }}
      >
        <strong style={{ fontSize: 12 }}>Annotations</strong>
        <small style={{ color: "#475569" }}>{threads.length} threads</small>
        <span style={{ flex: 1 }} />
        {selected.size > 0 ? (
          <button
            type="button"
            data-annotation-bulk-resolve
            onClick={bulkResolve}
            style={primaryBtn}
          >
            Resolve {selected.size}
          </button>
        ) : null}
      </header>

      {banner ? (
        <div
          data-annotation-banner
          style={{
            padding: "5px 8px",
            background: "rgba(239, 68, 68, 0.08)",
            border: "1px solid rgba(239, 68, 68, 0.32)",
            borderRadius: 6,
            color: "#7f1d1d",
            fontSize: 11,
          }}
        >
          {banner}
        </div>
      ) : null}

      {threads.length === 0 ? (
        <div
          data-annotation-empty
          style={{ color: "#475569", fontSize: 12, padding: "8px 4px" }}
        >
          No annotations yet. Use the viewer toolbar to add one.
        </div>
      ) : (
        threads.map((t) => (
          <div
            key={t.root.id}
            data-annotation-thread={t.root.id}
            data-annotation-resolved={t.root.resolvedAtUtc ? "true" : "false"}
            style={{
              background: "#fff",
              borderRadius: 8,
              padding: "8px 10px",
              border: t.root.resolvedAtUtc
                ? "1px solid rgba(34, 197, 94, 0.4)"
                : "1px solid rgba(15, 23, 42, 0.08)",
              fontSize: 12,
              display: "flex",
              flexDirection: "column",
              gap: 6,
            }}
          >
            <div style={{ display: "flex", gap: 6 }}>
              <input
                type="checkbox"
                data-annotation-select={t.root.id}
                checked={selected.has(t.root.id)}
                onChange={() => toggleSelect(t.root.id)}
              />
              <code style={{ fontSize: 10, color: "#64748b" }}>
                {t.root.annotationType}
              </code>
              {t.root.pageNumber !== null ? (
                <code style={{ fontSize: 10, color: "#64748b" }}>
                  p.{t.root.pageNumber}
                </code>
              ) : null}
              {t.root.mediaTimestampMs !== null ? (
                <code style={{ fontSize: 10, color: "#64748b" }}>
                  {Math.floor(t.root.mediaTimestampMs / 1000)}s
                </code>
              ) : null}
              <span style={{ flex: 1 }} />
              {!t.root.resolvedAtUtc ? (
                <button
                  type="button"
                  data-annotation-resolve={t.root.id}
                  onClick={() => resolve(t.root.id)}
                  style={ghostBtn}
                >
                  Resolve
                </button>
              ) : (
                <small style={{ color: "#16a34a" }}>Resolved</small>
              )}
            </div>
            <div>{t.root.body ?? <em style={{ color: "#94a3b8" }}>(no body)</em>}</div>
            {t.replies.length > 0 ? (
              <div
                data-annotation-replies
                style={{
                  borderLeft: "2px solid #e2e8f0",
                  paddingLeft: 8,
                  display: "flex",
                  flexDirection: "column",
                  gap: 4,
                }}
              >
                {t.replies.map((r) => (
                  <div key={r.id} data-annotation-reply={r.id}>
                    <small style={{ color: "#64748b" }}>
                      {new Date(r.createdAt).toLocaleTimeString()}
                    </small>{" "}
                    {r.body}
                  </div>
                ))}
              </div>
            ) : null}
            <div style={{ display: "flex", gap: 6 }}>
              <input
                type="text"
                data-annotation-reply-input={t.root.id}
                value={replyDraft[t.root.id] ?? ""}
                onChange={(e) =>
                  setReplyDraft((d) => ({ ...d, [t.root.id]: e.target.value }))
                }
                placeholder="Reply…"
                style={{
                  flex: 1,
                  fontSize: 12,
                  padding: "4px 6px",
                  border: "1px solid #cbd5e1",
                  borderRadius: 6,
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    void postReply(t.root.id);
                  }
                }}
              />
              <button
                type="button"
                data-annotation-reply-submit={t.root.id}
                onClick={() => void postReply(t.root.id)}
                style={primaryBtn}
              >
                Send
              </button>
            </div>
          </div>
        ))
      )}
    </section>
  );
}

const primaryBtn = {
  background: "#0f172a",
  color: "#fafafa",
  border: "none",
  borderRadius: 6,
  fontSize: 11,
  padding: "4px 10px",
  fontWeight: 600,
  cursor: "pointer",
} as const;

const ghostBtn = {
  background: "transparent",
  border: "1px solid #cbd5e1",
  color: "#0f172a",
  fontSize: 11,
  padding: "2px 8px",
  borderRadius: 6,
  cursor: "pointer",
} as const;
