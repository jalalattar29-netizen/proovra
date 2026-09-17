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

import { use, useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";

import {
  EXTERNAL_DECISION_VERDICTS,
  identifierLabel,
  type ExternalDecisionVerdict,
  type ExternalPortalProjection,
} from "@proovra/shared";

import { WatermarkOverlay } from "../../../../../components/external-portal/WatermarkOverlay";
import { PortalMfaCodeStep } from "../../../../../components/external-portal/PortalMfaCodeStep";
import { PortalDenialNotice } from "../../../../../components/external-portal/PortalDenialNotice";

import {
  authenticate,
  clearSessionId,
  fetchComments,
  fetchDecisions,
  fetchPortalDashboard,
  getSessionId,
  isPortalMfaDenial,
  markReviewOpened,
  postComment,
  readPortalFailure,
  setBearer,
  submitDecision,
  type PortalComment,
  type PortalDecision,
  type PortalMfaDetail,
} from "../../../../../lib/external-portal/portal-client";
import { formatUserDateTime } from "../../../../../lib/date";
import { toSafeUserError } from "../../../../../lib/feedback/toSafeUserError";

/**
 * Batch J — the reviewer's recorded decision, read back from
 * GET /v1/portal/work/:workflowId/decisions (scoped server-side to this
 * reviewer's grant). A reviewer who reloads now sees what they recorded;
 * a submission is announced only once this reread shows it.
 */
type DecisionState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "ready"; decision: PortalDecision | null }
  | { kind: "denied" }
  | { kind: "failed"; message: string };

/**
 * D58 — denials that mean the SESSION is gone (or cannot be checked), not
 * that this one request was refused. Any request on the page can meet them
 * once an operator ends the session, so they replace the page with the
 * portal denial notice and its way back.
 */
const SESSION_LOSS_DENIALS = new Set([
  "SESSION_ENDED",
  "SESSION_UNAVAILABLE",
  "INACTIVITY_TIMEOUT",
]);

function portalStatus(err: unknown): number {
  const s = (err as { status?: unknown } | null)?.status;
  return typeof s === "number" ? s : 0;
}

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
  const [mfaStep, setMfaStep] = useState<{
    denial: string;
    detail: PortalMfaDetail | null;
  } | null>(null);
  const [verdictRationale, setVerdictRationale] = useState("");
  const [decisionStatus, setDecisionStatus] = useState<string | null>(null);
  const [decisionState, setDecisionState] = useState<DecisionState>({ kind: "idle" });
  const [deciding, setDeciding] = useState(false);
  const decisionSeq = useRef(0);

  // D58 — route a lost session (or a lapsed MFA satisfaction) met by ANY
  // request to the page-level handling. Returns true when it took the error.
  const takeSessionLoss = useCallback((err: unknown): boolean => {
    const failure = readPortalFailure(err);
    if (failure.denial && isPortalMfaDenial(failure.denial)) {
      setMfaStep({ denial: failure.denial, detail: failure.mfa });
      return true;
    }
    if (failure.denial && SESSION_LOSS_DENIALS.has(failure.denial)) {
      setDenial(failure.denial);
      return true;
    }
    return false;
  }, []);

  const loadDecision = useCallback(async (): Promise<PortalDecision | null | undefined> => {
    const seq = ++decisionSeq.current;
    setDecisionState((prev) => (prev.kind === "ready" ? prev : { kind: "loading" }));
    try {
      const rows = await fetchDecisions(workflowId);
      const mine = rows.find((d) => d.workflowId === workflowId) ?? null;
      if (seq === decisionSeq.current) setDecisionState({ kind: "ready", decision: mine });
      return mine;
    } catch (err) {
      if (seq === decisionSeq.current && !takeSessionLoss(err)) {
        const status = portalStatus(err);
        setDecisionState(
          status === 403 || status === 404
            ? { kind: "denied" }
            : {
                kind: "failed",
                message: toSafeUserError(err, {
                  message: "Your recorded decision could not be loaded. Refresh to try again.",
                }).message,
              },
        );
      }
      return undefined;
    }
  }, [workflowId, takeSessionLoss]);

  const reauth = useCallback(async () => {
    setBearer(decodeURIComponent(token));
    try {
      await authenticate({
        token: decodeURIComponent(token),
        existingSessionId: getSessionId() ?? undefined,
      });
      return true;
    } catch (err) {
      // D27 — a lapsed MFA satisfaction is answered with the code step.
      const failure = readPortalFailure(err);
      if (failure.denial && isPortalMfaDenial(failure.denial)) {
        setMfaStep({ denial: failure.denial, detail: failure.mfa });
      } else {
        setDenial(failure.denial ?? "TOKEN_INVALID");
      }
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
      const caps = proj.reviewer.capabilities as ReadonlyArray<string>;
      if (caps.includes("portal.decide") || caps.includes("portal.history.read")) {
        void loadDecision();
      }
    } catch (err) {
      // D27 — a lapsed MFA satisfaction is answered with the code step.
      const failure = readPortalFailure(err);
      if (failure.denial && isPortalMfaDenial(failure.denial)) {
        setMfaStep({ denial: failure.denial, detail: failure.mfa });
      } else {
        setDenial(failure.denial ?? "TOKEN_INVALID");
      }
    }
  }, [reauth, workflowId, loadDecision]);

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
      if (deciding) return;
      setDeciding(true);
      setDecisionStatus(null);
      try {
        let replaced = false;
        try {
          const res = await submitDecision({
            workflowId,
            verdict,
            rationale:
              verdict === "APPROVE" ? undefined : verdictRationale.slice(0, 600),
          });
          replaced = res.replaced;
        } catch (err) {
          if (takeSessionLoss(err)) return;
          const status = portalStatus(err);
          setDecisionStatus(
            status === 403
              ? "Your role cannot record a decision on this review."
              : status === 409
                ? "The decision was not accepted. Check the rationale and try again."
                : toSafeUserError(err, {
                    message: "Your decision could not be recorded. Nothing was changed.",
                  }).message,
          );
          return;
        }
        const reread = await loadDecision();
        if (reread && reread.verdict === verdict) {
          setDecisionStatus(
            `Decision recorded: ${identifierLabel(verdict)}${replaced ? ". It replaces your previous decision." : "."}`,
          );
          setVerdictRationale("");
        } else {
          setDecisionStatus(
            reread === undefined
              ? "Your decision was sent, but it could not be reloaded to confirm it. Refresh before deciding again."
              : "Your decision was sent, but the saved record does not show it yet. Refresh before deciding again.",
          );
        }
      } finally {
        setDeciding(false);
      }
    },
    [workflowId, verdictRationale, deciding, loadDecision, takeSessionLoss],
  );

  // D58 — exchange the invitation token again WITHOUT the ended session id:
  // that opens a fresh session (an MFA grant is sent a fresh code and lands
  // on the code step). Drafts on this page are kept.
  const signInAgain = () => {
    clearSessionId();
    setDenial(null);
    void refresh();
  };

  if (mfaStep) {
    return (
      <main
        data-portal-mfa-gate
        style={{ maxWidth: 480, margin: "0 auto", padding: "40px 16px" }}
      >
        <h1 style={{ fontSize: 20, margin: 0 }}>Confirm it is you</h1>
        <PortalMfaCodeStep
          token={decodeURIComponent(token)}
          denial={mfaStep.denial}
          detail={mfaStep.detail}
          existingSessionId={getSessionId()}
          onVerified={() => {
            setMfaStep(null);
            void refresh();
          }}
        />
      </main>
    );
  }

  if (denial) {
    return (
      <main data-portal-denied style={{ maxWidth: 480, margin: "0 auto", padding: 40, textAlign: "center" }}>
        <PortalDenialNotice
          denial={denial}
          onReauthenticate={signInAgain}
          onRetry={() => {
            setDenial(null);
            void refresh();
          }}
        />
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
          {identifierLabel(projection.reviewer.role)}
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
            busy={deciding}
            decision={decisionState}
            onRetry={() => void loadDecision()}
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
              try {
                await postComment({ workflowId, body });
              } catch (err) {
                if (takeSessionLoss(err)) return;
                throw err;
              }
              setRootDraft("");
              await refresh();
            }}
            onPostReply={async (parentId) => {
              const body = (replyDraft[parentId] ?? "").trim();
              if (!body) return;
              try {
                await postComment({
                  workflowId,
                  body,
                  parentCommentId: parentId,
                });
              } catch (err) {
                if (takeSessionLoss(err)) return;
                throw err;
              }
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
  busy,
  decision,
  onRetry,
}: {
  capabilities: ReadonlyArray<string>;
  rationale: string;
  onRationale: (v: string) => void;
  onDecide: (v: ExternalDecisionVerdict) => Promise<void>;
  status: string | null;
  busy: boolean;
  decision: DecisionState;
  onRetry: () => void;
}) {
  const canDecide = capabilities.includes("portal.decide");
  const canReadHistory = canDecide || capabilities.includes("portal.history.read");
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
      <div data-portal-recorded-decision style={{ fontSize: 12, marginBottom: 8, overflowWrap: "anywhere" }}>
        {!canReadHistory ? (
          <p style={{ margin: 0 }}>Your role cannot view recorded decisions for this review.</p>
        ) : decision.kind === "idle" || decision.kind === "loading" ? (
          <p role="status" style={{ margin: 0 }}>Loading your recorded decision…</p>
        ) : decision.kind === "denied" ? (
          <p role="alert" style={{ margin: 0 }}>Your recorded decision is not available for this review.</p>
        ) : decision.kind === "failed" ? (
          <p role="alert" style={{ margin: 0 }}>
            {decision.message}{" "}
            <button type="button" onClick={onRetry} style={btnPrimary}>
              Retry
            </button>
          </p>
        ) : decision.decision ? (
          <dl style={{ margin: 0, display: "grid", gap: 2 }}>
            <dt style={{ fontWeight: 600 }}>Your recorded decision</dt>
            <dd style={{ margin: 0 }}>{identifierLabel(decision.decision.verdict)}</dd>
            <dt style={{ fontWeight: 600 }}>Recorded</dt>
            <dd style={{ margin: 0 }}>
              <time dateTime={decision.decision.submittedAtUtc}>
                {formatUserDateTime(decision.decision.submittedAtUtc)}
              </time>
            </dd>
            <dt style={{ fontWeight: 600 }}>Rationale</dt>
            <dd style={{ margin: 0 }}>{decision.decision.rationale ?? "No rationale recorded."}</dd>
          </dl>
        ) : (
          <p style={{ margin: 0 }}>You have not recorded a decision for this review yet.</p>
        )}
        {canDecide && decision.kind === "ready" && decision.decision ? (
          <p style={{ margin: "4px 0 0" }}>Submitting again replaces this decision.</p>
        ) : null}
      </div>
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
                disabled={busy}
                aria-busy={busy || undefined}
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
                  cursor: busy ? "not-allowed" : "pointer",
                }}
              >
                {identifierLabel(v)}
              </button>
            ))}
          </div>
          {status ? (
            <small
              data-portal-decision-status
              role="status"
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
              {formatUserDateTime(r.createdAt)}
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
