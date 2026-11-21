"use client";

/**
 * PRO-R1-01 / DEC-01 — External Review where a grant has its subject: on the
 * record (and the case). Issue, list, inspect and revoke over the EXISTING
 * invitation / grant routes — no second issuing path:
 *
 *   list     GET  /v1/external-review/grants?teamId=&evidenceId=|caseId=
 *   issue    POST /v1/external-review/invitations/bulk   (one row; e-mails the reviewer)
 *   inspect  GET  /v1/external-review/invitations/:id/feedback
 *   revoke   POST /v1/external-review/invitations/:id/revoke
 *   renew    POST /v1/external-review/grants/:id/renew   (EP-0450; offered only where
 *            the list projects viewerCanRenew; step-up; audited)
 *
 * Role, reach, the plan entitlement, step-up and the grant lifecycle are all
 * decided by those routes; this panel shows what they answer. The plan flag
 * (`planFeatures.externalReviewIncluded`) only decides whether the ISSUE form
 * is offered — invitations a workspace already issued stay listed and
 * revocable after a downgrade (DEC-09).
 *
 * The Enterprise console at /review/external is unchanged and stays where it
 * is (ENT-01); this is the surface a Pro workspace reaches.
 */

import { useCallback, useEffect, useState } from "react";

import { identifierLabel } from "@proovra/shared";

import { apiFetch } from "../../lib/api";
import { formatUserDateTime } from "../../lib/date";
import { toSafeUserError } from "../../lib/feedback/toSafeUserError";
import { usePlanFeature } from "../../lib/platform-context/useServerProjectionGates";
import { AppListbox } from "../app-primitives/AppListbox";
import { StepUpModal, useStepUpAction } from "../identity-security/StepUpModal";
import { useConfirmAction } from "../ui/ConfirmActionModal";
import {
  EXTERNAL_REVIEW_RENEW_DAYS,
  externalReviewRenewRefusal,
  renewExternalReviewGrant,
} from "../../lib/api/external-review-renew";

export type ExternalReviewSubject =
  | { kind: "EVIDENCE"; evidenceId: string }
  | { kind: "CASE"; caseId: string };

type GrantRow = {
  id: string;
  reviewerEmail: string;
  reviewerDisplayName: string | null;
  state: string;
  expiresAtUtc: string;
  acceptedAtUtc: string | null;
  lastAccessedAtUtc: string | null;
  /** EP-0450 — the API's answer: this viewer could renew this grant now. */
  viewerCanRenew?: boolean;
};

type Feedback = {
  decisions: Array<{ id: string; verdict: string; rationale: string | null; submittedAtUtc: string }>;
  comments: Array<{ id: string; body: string; authorDisplay: string | null; createdAt: string }>;
};

const LIVE_STATES = new Set(["INVITED", "ACTIVE"]);
const EXPIRY_DAYS = [3, 7, 14, 30] as const;

function failureText(err: unknown, fallback: string): string {
  const safe = toSafeUserError(err) as { message?: string } | null;
  return (safe?.message && safe.message.trim()) || fallback;
}

export function ExternalReviewSubjectPanel({
  teamId,
  subject,
}: {
  teamId: string | null;
  subject: ExternalReviewSubject;
}) {
  const included = usePlanFeature("externalReviewIncluded");
  const stepUp = useStepUpAction({ teamId });
  const { confirm } = useConfirmAction();
  const subjectId = subject.kind === "EVIDENCE" ? subject.evidenceId : subject.caseId;

  const [grants, setGrants] = useState<GrantRow[] | null>(null);
  const [listState, setListState] = useState<"loading" | "ready" | "refused" | "failed">("loading");
  const [email, setEmail] = useState("");
  const [days, setDays] = useState<number>(7);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ tone: "ok" | "warn"; text: string } | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<Feedback | "unavailable" | null>(null);

  const load = useCallback(async () => {
    if (!teamId) {
      setListState("refused");
      return;
    }
    try {
      const param = subject.kind === "EVIDENCE" ? "evidenceId" : "caseId";
      const res = await apiFetch(
        `/v1/external-review/grants?teamId=${encodeURIComponent(teamId)}&${param}=${encodeURIComponent(subjectId)}`,
        { method: "GET" },
      );
      setGrants((Array.isArray(res?.grants) ? res.grants : []) as GrantRow[]);
      setListState("ready");
    } catch (err) {
      const status = (err as { statusCode?: number })?.statusCode ?? 0;
      setGrants(null);
      setListState(status === 403 || status === 404 ? "refused" : "failed");
    }
  }, [teamId, subject.kind, subjectId]);

  useEffect(() => {
    void load();
  }, [load]);

  const onIssue = useCallback(async () => {
    const address = email.trim();
    if (!address || busy) return;
    setBusy(true);
    setNotice(null);
    try {
      const res = await stepUp.runStepUpAction(async (headers) =>
        apiFetch("/v1/external-review/invitations/bulk", {
          method: "POST",
          headers: { "Content-Type": "application/json", ...(headers ?? {}) },
          body: JSON.stringify({
            expiresAtUtc: new Date(Date.now() + days * 24 * 3600 * 1000).toISOString(),
            defaultScope:
              subject.kind === "EVIDENCE"
                ? { kind: "EVIDENCE", evidenceId: subject.evidenceId }
                : { kind: "CASE", caseId: subject.caseId },
            rows: [{ inviteEmail: address }],
          }),
        }),
      );
      const row = (Array.isArray(res?.rows) ? res.rows[0] : null) as
        | { outcome?: string; grantId?: string | null; denial?: string | null }
        | null;
      if (row?.grantId) {
        setEmail("");
        setNotice({ tone: "ok", text: `Invitation sent to ${address}.` });
      } else {
        setNotice({
          tone: "warn",
          text: `The invitation was not issued${row?.denial ? ` (${identifierLabel(row.denial)})` : ""}.`,
        });
      }
      await load();
    } catch (err) {
      if ((err as { code?: string })?.code !== "STEP_UP_CANCEL") {
        setNotice({ tone: "warn", text: failureText(err, "The invitation could not be issued.") });
      }
    } finally {
      setBusy(false);
    }
  }, [email, busy, days, stepUp, subject, load]);

  const onRevoke = useCallback(
    async (g: GrantRow) => {
      const ok = await confirm({
        title: "Revoke this invitation?",
        description: `${g.reviewerEmail}'s access ends immediately. A revoked invitation cannot be restored; you would issue a new one.`,
        confirmLabel: "Revoke access",
        tone: "danger",
      });
      if (!ok) return;
      setNotice(null);
      try {
        await apiFetch(`/v1/external-review/invitations/${g.id}/revoke`, { method: "POST", body: "{}" });
        setNotice({ tone: "ok", text: `Access revoked for ${g.reviewerEmail}.` });
      } catch (err) {
        setNotice({ tone: "warn", text: failureText(err, "The invitation could not be revoked.") });
      }
      await load();
    },
    [confirm, load],
  );

  // EP-0450 — the explicit, audited renewal, as owner share links renew: one
  // confirmed click for a stated period, a fresh step-up, the route's refusals said.
  const onRenew = useCallback(
    async (g: GrantRow) => {
      if (!teamId) return;
      const ok = await confirm({
        title: `Renew access for ${EXTERNAL_REVIEW_RENEW_DAYS} days?`,
        description: `${g.reviewerEmail} keeps access, which now ends ${EXTERNAL_REVIEW_RENEW_DAYS} days from today. The renewal is recorded in the workspace audit log.`,
        confirmLabel: `Renew for ${EXTERNAL_REVIEW_RENEW_DAYS} days`,
      });
      if (!ok) return;
      setNotice(null);
      try {
        await stepUp.runStepUpAction((headers) => renewExternalReviewGrant(teamId, g.id, headers));
        setNotice({ tone: "ok", text: `Access renewed for ${g.reviewerEmail}.` });
      } catch (err) {
        if ((err as { code?: string })?.code === "STEP_UP_CANCEL") return;
        setNotice({ tone: "warn", text: externalReviewRenewRefusal(err) });
      }
      await load();
    },
    [confirm, load, stepUp, teamId],
  );

  const onInspect = useCallback(
    async (g: GrantRow) => {
      if (openId === g.id) {
        setOpenId(null);
        return;
      }
      setOpenId(g.id);
      setFeedback(null);
      try {
        const f = await apiFetch(`/v1/external-review/invitations/${g.id}/feedback`, { method: "GET" });
        setFeedback({
          decisions: Array.isArray(f?.decisions) ? f.decisions : [],
          comments: Array.isArray(f?.comments) ? f.comments : [],
        });
      } catch {
        setFeedback("unavailable");
      }
    },
    [openId],
  );

  // A viewer the list refuses and whose plan does not include the feature has
  // nothing to do here: no panel rather than a dead control.
  if (listState === "refused" && included !== true) return null;

  const muted = { color: "var(--ink-secondary, #475569)", fontSize: 12 } as const;
  return (
    <section
      data-external-review-panel={subject.kind}
      aria-label="External review"
      style={{
        background: "#fff",
        border: "1px solid rgba(15, 23, 42, 0.08)",
        borderRadius: 10,
        padding: 12,
        display: "grid",
        gap: 8,
      }}
    >
      <strong style={{ fontSize: 13 }}>External review</strong>
      <p style={{ ...muted, margin: 0 }}>
        Invite someone outside the workspace to review this {subject.kind === "EVIDENCE" ? "record" : "case"}. They
        receive an emailed link to a reviewer portal and the disclosure package, never the original files.
      </p>

      {included === true ? (
        <form
          data-external-review-issue
          onSubmit={(e) => {
            e.preventDefault();
            void onIssue();
          }}
          style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "end" }}
        >
          <label style={{ fontSize: 12, display: "grid", gap: 2 }}>
            Reviewer email
            <input
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              data-external-review-email
              style={{ padding: "5px 8px", borderRadius: 6, border: "1px solid #cbd5e1", minWidth: 240 }}
            />
          </label>
          <label style={{ fontSize: 12, display: "grid", gap: 2 }}>
            Access ends after
            <AppListbox
              value={String(days)}
              options={EXPIRY_DAYS.map((d) => ({ value: String(d), label: `${d} days` }))}
              onChange={(next) => setDays(Number(next))}
              ariaLabel="Access ends after"
              triggerProps={{ "data-external-review-days": "" }}
            />
          </label>
          <button type="submit" className="app-secondary-action" disabled={busy || email.trim().length === 0}>
            {busy ? "Sending…" : "Send invitation"}
          </button>
        </form>
      ) : included === false ? (
        <p data-external-review-not-included style={{ ...muted, margin: 0 }}>
          External Review is not included on this workspace&apos;s plan, so no new invitation can be sent.
          Invitations already issued stay listed below and can still be revoked.
        </p>
      ) : null}

      {notice ? (
        <p
          role={notice.tone === "warn" ? "alert" : "status"}
          data-external-review-notice={notice.tone}
          style={{ margin: 0, fontSize: 12.5, color: notice.tone === "warn" ? "var(--status-risk-fg, #991b1b)" : "inherit" }}
        >
          {notice.text}
        </p>
      ) : null}

      {listState === "loading" ? (
        <p style={{ ...muted, margin: 0 }}>Loading invitations…</p>
      ) : listState === "failed" ? (
        <p style={{ ...muted, margin: 0 }}>
          The invitations could not be loaded.{" "}
          <button type="button" className="ui-link" onClick={() => void load()}>
            Try again
          </button>
        </p>
      ) : listState === "refused" ? (
        <p data-external-review-list-refused style={{ ...muted, margin: 0 }}>
          Your role does not include reading this workspace&apos;s external-review invitations.
        </p>
      ) : (grants ?? []).length === 0 ? (
        <p data-external-review-empty style={{ ...muted, margin: 0 }}>
          No one outside the workspace has been invited to review this yet.
        </p>
      ) : (
        <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 6 }}>
          {(grants ?? []).map((g) => (
            <li
              key={g.id}
              data-external-review-grant={g.id}
              data-external-review-grant-state={g.state}
              style={{ border: "1px solid #e2e8f0", borderRadius: 8, padding: 8, fontSize: 12.5 }}
            >
              <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
                <strong>{g.reviewerDisplayName || g.reviewerEmail}</strong>
                <span>{identifierLabel(g.state)}</span>
                <span style={muted}>
                  {LIVE_STATES.has(g.state) ? "Access ends" : "Access ended"} {formatUserDateTime(g.expiresAtUtc)}
                </span>
                <span style={{ flex: 1 }} />
                <button type="button" className="ui-link" onClick={() => void onInspect(g)} aria-expanded={openId === g.id}>
                  {openId === g.id ? "Hide feedback" : "Reviewer feedback"}
                </button>
                {g.viewerCanRenew === true ? (
                  <button type="button" className="ui-link" onClick={() => void onRenew(g)} data-external-review-renew={g.id}>
                    Renew
                  </button>
                ) : null}
                {LIVE_STATES.has(g.state) ? (
                  <button type="button" className="ui-link" onClick={() => void onRevoke(g)} data-external-review-revoke={g.id}>
                    Revoke
                  </button>
                ) : null}
              </div>
              {openId === g.id ? (
                <div data-external-review-feedback style={{ marginTop: 6, display: "grid", gap: 4 }}>
                  {feedback === null ? (
                    <span style={muted}>Loading…</span>
                  ) : feedback === "unavailable" ? (
                    <span style={muted}>Reviewer feedback could not be loaded.</span>
                  ) : feedback.decisions.length === 0 && feedback.comments.length === 0 ? (
                    <span style={muted}>The reviewer has not commented or decided yet.</span>
                  ) : (
                    <>
                      {feedback.decisions.map((d) => (
                        <div key={d.id}>
                          <strong>Decision: {identifierLabel(d.verdict)}</strong>{" "}
                          <span style={muted}>{formatUserDateTime(d.submittedAtUtc)}</span>
                          {d.rationale ? <p style={{ margin: "2px 0 0", whiteSpace: "pre-wrap" }}>{d.rationale}</p> : null}
                        </div>
                      ))}
                      {feedback.comments.map((c) => (
                        <div key={c.id}>
                          <span style={muted}>
                            {c.authorDisplay ?? "Reviewer"} · {formatUserDateTime(c.createdAt)}
                          </span>
                          <p style={{ margin: "2px 0 0", whiteSpace: "pre-wrap" }}>{c.body}</p>
                        </div>
                      ))}
                    </>
                  )}
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      <StepUpModal control={stepUp} />
    </section>
  );
}
