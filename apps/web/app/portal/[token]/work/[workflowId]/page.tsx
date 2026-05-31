"use client";

/**
 * PROOVRA Phase 2B — Portal review surface.
 *
 * Token-authenticated review surface for an assigned workflow. Renders:
 *   - watermarked evidence frame (read-only iframe; watermark overlay)
 *   - threaded comment panel
 *   - decision panel with bounded verdicts
 *
 * Hard rules:
 *   * Watermark overlay never blocks the bytes underneath
 *     (`pointer-events: none`).
 *   * Decision submission requires bounded rationale for non-APPROVE.
 *   * REVIEW_OPENED activity is emitted on first mount.
 */

import { use, useCallback, useEffect, useState } from "react";
import Link from "next/link";

import { EXTERNAL_DECISION_VERDICTS, type ExternalDecisionVerdict, type ExternalPortalProjection } from "@proovra/shared";

import { WatermarkOverlay } from "../../../../../components/external-portal/WatermarkOverlay";

import {
  authenticate,
  fetchComments,
  fetchPortalDashboard,
  getSessionId,
  markReviewOpened,
  postComment,
  setBearer,
  submitDecision,
  type PortalComment,
} from "../../../../../lib/external-portal/portal-client";

export default function PortalReviewPage({
  params,
}: {
  params: Promise<{ token: string; workflowId: string }>;
}) {
  const { token, workflowId } = use(params);
  const [projection, setProjection] = useState<ExternalPortalProjection | null>(
    null,
  );
  const [comments, setComments] = useState<PortalComment[]>([]);
  const [replyDraft, setReplyDraft] = useState<Record<string, string>>({});
  const [rootDraft, setRootDraft] = useState("");
  const [denial, setDenial] = useState<string | null>(null);
  const [verdictRationale, setVerdictRationale] = useState("");
  const [decisionStatus, setDecisionStatus] = useState<string | null>(null);

  const reauth = useCallback(async () => {
    setBearer(decodeURIComponent(token));
    try {
      await authenticate({
        token: decodeURIComponent(token),
        existingSessionId: getSessionId() ?? undefined,
      });
      return true;
    } catch (err) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      setDenial(((err as any)?.denial ?? "TOKEN_INVALID") as string);
      return false;
    }
  }, [token]);

  const refresh = useCallback(async () => {
    const ok = await reauth();
    if (!ok) return;
    try {
      const proj = await fetchPortalDashboard();
      setProjection(proj);
      const c = await fetchComments(workflowId);
      setComments(c);
    } catch (err) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      setDenial(((err as any)?.denial ?? "TOKEN_INVALID") as string);
    }
  }, [reauth, workflowId]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      await refresh();
      if (cancelled) return;
      try {
        await markReviewOpened(workflowId);
      } catch {
        /* non-fatal */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [refresh, workflowId]);

  const onSubmitDecision = useCallback(
    async (verdict: ExternalDecisionVerdict) => {
      if (
        verdict !== "APPROVE" &&
        (verdictRationale.length === 0 || verdictRationale.length > 600)
      ) {
        setDecisionStatus(
          "Bounded rationale (≤ 600 chars) required for this verdict.",
        );
        return;
      }
      try {
        const res = await submitDecision({
          workflowId,
          verdict,
          rationale:
            verdict === "APPROVE" ? undefined : verdictRationale.slice(0, 600),
        });
        setDecisionStatus(
          `Decision ${verdict} recorded${res.replaced ? " (replaced)" : ""}.`,
        );
        setVerdictRationale("");
        await refresh();
      } catch (err) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        setDecisionStatus(`Refused: ${((err as any)?.denial ?? "RATE_LIMITED")}`);
      }
    },
    [workflowId, verdictRationale, refresh],
  );

  if (denial) {
    return (
      <main style={{ padding: 40, textAlign: "center" }}>
        <h1 style={{ fontSize: 20 }}>Portal access denied</h1>
        <code>{denial}</code>
      </main>
    );
  }
  if (!projection) {
    return <main style={{ padding: 40, textAlign: "center" }}>Loading…</main>;
  }

  const watermark = projection.watermark.signedToken;

  return (
    <main
      data-portal-review-surface
      data-portal-workflow-id={workflowId}
      data-portal-watermark-policy={projection.watermark.policy}
      style={{
        maxWidth: 1280,
        margin: "0 auto",
        padding: "16px 18px",
        fontFamily: "Inter, system-ui, sans-serif",
        color: "#0f172a",
      }}
    >
      <header style={{ display: "flex", gap: 10, alignItems: "center", marginBottom: 10 }}>
        <Link
          href={`/portal/${encodeURIComponent(token)}`}
          data-portal-back
          style={{ fontSize: 12, color: "#0f172a", textDecoration: "underline" }}
        >
          ← Back to dashboard
        </Link>
        <span style={{ flex: 1 }} />
        <small style={{ color: "#475569" }}>
          Reviewer: {projection.reviewer.email} · Role:{" "}
          {projection.reviewer.role}
        </small>
      </header>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1fr 380px",
          gap: 14,
        }}
      >
        <section
          data-portal-evidence-frame
          style={{
            position: "relative",
            background: "#fafafa",
            border: "1px solid rgba(15, 23, 42, 0.08)",
            borderRadius: 12,
            padding: 8,
            minHeight: 420,
            overflow: "hidden",
          }}
        >
          <iframe
            data-portal-evidence-iframe
            title="Evidence preview"
            src={`/evidence/${projection.assigned.find((a) => a.workflowId === workflowId)?.evidenceId ?? ""}?embed=1`}
            style={{
              width: "100%",
              height: 480,
              border: "1px solid rgba(15, 23, 42, 0.08)",
              borderRadius: 8,
              background: "#fff",
            }}
          />
          <WatermarkOverlay watermark={watermark} />
        </section>

        <aside style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <DecisionPanel
            capabilities={projection.reviewer.capabilities}
            rationale={verdictRationale}
            onRationale={setVerdictRationale}
            onDecide={onSubmitDecision}
            status={decisionStatus}
          />
          <CommentsPanel
            comments={comments}
            rootDraft={rootDraft}
            onRootDraft={setRootDraft}
            replyDraft={replyDraft}
            onReplyDraft={(id, v) =>
              setReplyDraft((d) => ({ ...d, [id]: v }))
            }
            onPostRoot={async () => {
              const body = rootDraft.trim();
              if (!body) return;
              await postComment({ workflowId, body });
              setRootDraft("");
              await refresh();
            }}
            onPostReply={async (parentId) => {
              const body = (replyDraft[parentId] ?? "").trim();
              if (!body) return;
              await postComment({
                workflowId,
                body,
                parentCommentId: parentId,
              });
              setReplyDraft((d) => ({ ...d, [parentId]: "" }));
              await refresh();
            }}
          />
        </aside>
      </div>
    </main>
  );
}

function DecisionPanel({
  capabilities,
  rationale,
  onRationale,
  onDecide,
  status,
}: {
  capabilities: ReadonlyArray<string>;
  rationale: string;
  onRationale: (v: string) => void;
  onDecide: (v: ExternalDecisionVerdict) => Promise<void>;
  status: string | null;
}) {
  const canDecide = capabilities.includes("portal.decide");
  return (
    <section
      data-portal-decision-panel
      style={{
        background: "#fff",
        border: "1px solid rgba(15, 23, 42, 0.08)",
        borderRadius: 12,
        padding: 12,
      }}
    >
      <h3 style={{ fontSize: 13, marginTop: 0 }}>Decision</h3>
      {!canDecide ? (
        <p style={{ color: "#475569", fontSize: 12 }}>
          Your role is read-only for decisions. You may still annotate
          and comment when permitted.
        </p>
      ) : (
        <>
          <textarea
            data-portal-decision-rationale
            rows={3}
            value={rationale}
            onChange={(e) => onRationale(e.target.value)}
            placeholder="Bounded rationale (≤ 600 chars). Required for non-APPROVE verdicts."
            style={{
              width: "100%",
              padding: 6,
              fontSize: 12,
              border: "1px solid #cbd5e1",
              borderRadius: 6,
              boxSizing: "border-box",
            }}
          />
          <div style={{ display: "flex", gap: 6, marginTop: 8, flexWrap: "wrap" }}>
            {EXTERNAL_DECISION_VERDICTS.map((v) => (
              <button
                key={v}
                type="button"
                data-portal-decision-btn={v}
                onClick={() => onDecide(v as ExternalDecisionVerdict)}
                style={{
                  padding: "4px 10px",
                  borderRadius: 8,
                  border: "1px solid #0f172a",
                  background:
                    v === "APPROVE"
                      ? "#16a34a"
                      : v === "REJECT"
                      ? "#dc2626"
                      : "#0f172a",
                  color: "#fafafa",
                  fontSize: 11,
                  fontWeight: 600,
                  cursor: "pointer",
                }}
              >
                {v}
              </button>
            ))}
          </div>
          {status ? (
            <small
              data-portal-decision-status
              style={{ color: "#475569", display: "block", marginTop: 6 }}
            >
              {status}
            </small>
          ) : null}
        </>
      )}
    </section>
  );
}

function CommentsPanel({
  comments,
  rootDraft,
  onRootDraft,
  replyDraft,
  onReplyDraft,
  onPostRoot,
  onPostReply,
}: {
  comments: PortalComment[];
  rootDraft: string;
  onRootDraft: (v: string) => void;
  replyDraft: Record<string, string>;
  onReplyDraft: (id: string, v: string) => void;
  onPostRoot: () => Promise<void>;
  onPostReply: (id: string) => Promise<void>;
}) {
  const roots = comments.filter((c) => c.parentCommentId === null);
  const repliesByRoot = comments.reduce<Record<string, PortalComment[]>>(
    (acc, c) => {
      if (c.parentCommentId !== null) {
        (acc[c.parentCommentId] = acc[c.parentCommentId] || []).push(c);
      }
      return acc;
    },
    {},
  );
  return (
    <section
      data-portal-comments-panel
      style={{
        background: "#fff",
        border: "1px solid rgba(15, 23, 42, 0.08)",
        borderRadius: 12,
        padding: 12,
      }}
    >
      <h3 style={{ fontSize: 13, marginTop: 0 }}>Review communication</h3>
      <div style={{ display: "flex", gap: 6, marginBottom: 10 }}>
        <input
          data-portal-root-comment-input
          type="text"
          value={rootDraft}
          onChange={(e) => onRootDraft(e.target.value)}
          placeholder="Add a comment to the workflow…"
          style={{
            flex: 1,
            padding: "5px 7px",
            border: "1px solid #cbd5e1",
            borderRadius: 6,
            fontSize: 12,
          }}
        />
        <button
          type="button"
          data-portal-root-comment-submit
          onClick={() => void onPostRoot()}
          style={btnPrimary}
        >
          Post
        </button>
      </div>
      {roots.length === 0 ? (
        <small style={{ color: "#475569", fontSize: 12 }}>
          No comments yet.
        </small>
      ) : (
        roots.map((r) => (
          <div
            key={r.id}
            data-portal-comment-thread={r.id}
            style={{
              padding: 8,
              border: "1px solid rgba(15, 23, 42, 0.08)",
              borderRadius: 8,
              marginBottom: 8,
            }}
          >
            <small style={{ color: "#64748b", fontSize: 11 }}>
              {r.authorDisplay ?? r.authorEmail} ·{" "}
              {new Date(r.createdAt).toLocaleString()}
            </small>
            <div style={{ fontSize: 13, marginTop: 2 }}>{r.body}</div>
            {(repliesByRoot[r.id] ?? []).map((rep) => (
              <div
                key={rep.id}
                data-portal-comment-reply={rep.id}
                style={{
                  marginTop: 6,
                  paddingLeft: 8,
                  borderLeft: "2px solid #e2e8f0",
                  fontSize: 12,
                }}
              >
                <small style={{ color: "#64748b", fontSize: 11 }}>
                  {rep.authorDisplay ?? rep.authorEmail}
                </small>{" "}
                {rep.body}
              </div>
            ))}
            <div style={{ display: "flex", gap: 6, marginTop: 6 }}>
              <input
                data-portal-comment-reply-input={r.id}
                type="text"
                value={replyDraft[r.id] ?? ""}
                onChange={(e) => onReplyDraft(r.id, e.target.value)}
                placeholder="Reply…"
                style={{
                  flex: 1,
                  padding: "4px 6px",
                  border: "1px solid #cbd5e1",
                  borderRadius: 6,
                  fontSize: 12,
                }}
              />
              <button
                type="button"
                data-portal-comment-reply-submit={r.id}
                onClick={() => void onPostReply(r.id)}
                style={btnPrimary}
              >
                Reply
              </button>
            </div>
          </div>
        ))
      )}
    </section>
  );
}

const btnPrimary = {
  background: "#0f172a",
  color: "#fafafa",
  border: "none",
  borderRadius: 6,
  fontSize: 11,
  padding: "5px 10px",
  fontWeight: 600,
  cursor: "pointer",
} as const;
