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
 * TEAM-SPEC R4 (2026-11-23) — Issue and Revoke follow the API's own answer:
 * the grants list projects `viewerCanIssue` (response) and `viewerCanRevoke`
 * (per grant) from the one predicate the issue/revoke doors enforce (OWNER or
 * ADMIN). An API that predates the fields falls back to the active role from
 * the envelope (OWNER/ADMIN). Issue/revoke act on the ACTIVE workspace, so a
 * record that belongs to another workspace says so instead of claiming a role
 * gap. The /review/external console applies the same permissions.
 */

import { useCallback, useEffect, useState } from "react";

import { identifierLabel } from "@proovra/shared";

import { apiFetch } from "../../lib/api";
import { formatUserDateTime } from "../../lib/date";
import { toSafeUserError } from "../../lib/feedback/toSafeUserError";
import { usePlanFeature } from "../../lib/platform-context/useServerProjectionGates";
import { useOptionalPlatformContext } from "../../lib/platform-context/PlatformContextProvider";
import { AppListbox } from "../app-primitives/AppListbox";
import { StepUpModal, useStepUpAction } from "../identity-security/StepUpModal";
import { useConfirmAction } from "../ui/ConfirmActionModal";
import { CanonicalActionButton } from "./CanonicalActionButton";
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
  /** TEAM-SPEC §2.11 — the API's answer: this viewer could revoke this grant now. */
  viewerCanRevoke?: boolean;
};

/**
 * TEAM-SPEC R4 — the active workspace and the viewer's role in it, from the
 * envelope. Used only as the FALLBACK for an API that does not yet project
 * `viewerCanIssue` / `viewerCanRevoke`, and to tell a record of another
 * workspace apart from a role refusal.
 */
export function useExternalReviewViewer(): {
  activeWorkspaceId: string | null;
  roleAllowsManage: boolean | null;
} {
  const ctx = useOptionalPlatformContext();
  const envelope = ctx?.envelope ?? null;
  if (!envelope) return { activeWorkspaceId: null, roleAllowsManage: null };
  const active = envelope.activeSpace ?? null;
  const activeWorkspaceId =
    envelope.contextOptions?.activeContext?.workspaceId ?? active?.id ?? null;
  const role = active?.roleLabel ?? null;
  const roleAllowsManage =
    role === null ? null : role === "Owner" || role === "OWNER" || role === "ADMIN";
  return { activeWorkspaceId, roleAllowsManage };
}

/** Copy shared with the /review/external console. */
export const EXTERNAL_REVIEW_MANAGE_EXPLANATION =
  "Issuing and revoking invitations needs an owner or admin of this workspace.";
export const EXTERNAL_REVIEW_OTHER_WORKSPACE =
  "This belongs to a workspace other than the one you're working in. Switch to that workspace to manage its external review invitations.";

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

  const viewer = useExternalReviewViewer();
  const [grants, setGrants] = useState<GrantRow[] | null>(null);
  const [listState, setListState] = useState<
    "loading" | "ready" | "refused" | "failed" | "no_workspace"
  >("loading");
  /** The list's `viewerCanIssue`; undefined = not projected (older API) or not loaded. */
  const [listCanIssue, setListCanIssue] = useState<boolean | undefined>(undefined);
  /** The list's `viewerActions.sameWorkspace`, when projected. */
  const [listSameWorkspace, setListSameWorkspace] = useState<boolean | undefined>(undefined);
  const [email, setEmail] = useState("");
  const [days, setDays] = useState<number>(7);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ tone: "ok" | "warn"; text: string } | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<Feedback | "unavailable" | null>(null);

  const load = useCallback(async () => {
    if (!teamId) {
      // No owning workspace is known for this record — not a role refusal.
      setListState("no_workspace");
      return;
    }
    try {
      const param = subject.kind === "EVIDENCE" ? "evidenceId" : "caseId";
      const res = await apiFetch(
        `/v1/external-review/grants?teamId=${encodeURIComponent(teamId)}&${param}=${encodeURIComponent(subjectId)}`,
        { method: "GET" },
      );
      setGrants((Array.isArray(res?.grants) ? res.grants : []) as GrantRow[]);
      setListCanIssue(typeof res?.viewerCanIssue === "boolean" ? res.viewerCanIssue : undefined);
      // `sameWorkspace: false` with no `workspaceId` means "no manage context
      // at all" (e.g. a Viewer), not "another workspace" — ignore it then.
      const va = res?.viewerActions as { sameWorkspace?: unknown; workspaceId?: unknown } | undefined;
      setListSameWorkspace(
        typeof va?.sameWorkspace === "boolean" && (va.sameWorkspace || typeof va.workspaceId === "string")
          ? va.sameWorkspace
          : undefined,
      );
      setListState("ready");
    } catch (err) {
      const status = (err as { statusCode?: number })?.statusCode ?? 0;
      setGrants(null);
      setListCanIssue(undefined);
      setListSameWorkspace(undefined);
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
  if ((listState === "refused" || listState === "no_workspace") && included !== true) return null;

  // TEAM-SPEC R4 — is this record in the workspace the viewer is acting in?
  // The server's `sameWorkspace` wins; otherwise compare ids when both known.
  const otherWorkspace =
    listState === "no_workspace" ||
    listSameWorkspace === false ||
    (listSameWorkspace === undefined &&
      teamId !== null &&
      viewer.activeWorkspaceId !== null &&
      teamId !== viewer.activeWorkspaceId);
  // Issue: the list's answer; an older API → the active role. Unknown while
  // the list loads, so no form flashes in and out.
  const canIssue: boolean | null = otherWorkspace
    ? false
    : listState === "loading"
      ? null
      : listCanIssue !== undefined
        ? listCanIssue
        : viewer.roleAllowsManage;
  const canRevoke = (g: GrantRow): boolean =>
    !otherWorkspace &&
    LIVE_STATES.has(g.state) &&
    (typeof g.viewerCanRevoke === "boolean" ? g.viewerCanRevoke : viewer.roleAllowsManage === true);

  // TEAM-UI-SPEC §1 — an `app-panel` card; muted copy is `app-field-help`.
  const muted = { margin: 0 } as const;
  return (
    <section
      data-external-review-panel={subject.kind}
      aria-label="External review"
      className="app-panel"
      style={{
        padding: 12,
        display: "grid",
        gap: 8,
        minWidth: 0,
      }}
    >
      <h3 className="app-panel__title">External review</h3>
      <p className="app-field-help" style={muted}>
        Invite someone outside the workspace to review this {subject.kind === "EVIDENCE" ? "record" : "case"}. They
        receive an emailed link to a reviewer portal and the disclosure package, never the original files.
      </p>

      {included === true && otherWorkspace ? (
        <p data-external-review-other-workspace className="app-field-help" style={muted}>
          {listState === "no_workspace"
            ? "This isn't in a workspace you're working in, so external review can't be managed here."
            : EXTERNAL_REVIEW_OTHER_WORKSPACE}
        </p>
      ) : included === true && canIssue === false ? (
        <p data-external-review-issue-not-permitted className="app-field-help" style={muted}>
          {EXTERNAL_REVIEW_MANAGE_EXPLANATION}
        </p>
      ) : included === true && canIssue === null ? null : included === true ? (
        <form
          data-external-review-issue
          onSubmit={(e) => {
            e.preventDefault();
            void onIssue();
          }}
          style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "end" }}
        >
          <label className="app-field-label" style={{ display: "grid", gap: 4, flex: "1 1 220px", minWidth: 0 }}>
            Reviewer email
            <input
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              data-external-review-email
              className="app-input"
            />
          </label>
          <label className="app-field-label" style={{ display: "grid", gap: 4, minWidth: 0 }}>
            Access ends after
            <AppListbox
              value={String(days)}
              options={EXPIRY_DAYS.map((d) => ({ value: String(d), label: `${d} days` }))}
              onChange={(next) => setDays(Number(next))}
              ariaLabel="Access ends after"
              triggerProps={{ "data-external-review-days": "" }}
            />
          </label>
          {/* TEAM-UI-SPEC §1 — issuing the invitation is this panel's one
              primary action. */}
          <CanonicalActionButton
            type="submit"
            variant="primary"
            data-external-review-send
            busy={busy}
            disabled={email.trim().length === 0}
            disabledReason="Enter the reviewer's email address."
          >
            {busy ? "Sending…" : "Send invitation"}
          </CanonicalActionButton>
        </form>
      ) : included === false ? (
        <p data-external-review-not-included className="app-field-help" style={muted}>
          External Review is not included on this workspace&apos;s plan, so no new invitation can be sent.
          Invitations already issued stay listed below and an owner or admin can still revoke them.
        </p>
      ) : null}

      {notice ? (
        <p
          role={notice.tone === "warn" ? "alert" : "status"}
          data-external-review-notice={notice.tone}
          className={notice.tone === "warn" ? "app-field-error" : "app-field-help"}
          style={muted}
        >
          {notice.text}
        </p>
      ) : null}

      {listState === "loading" ? (
        <p role="status" className="app-field-help" style={muted}>Loading invitations…</p>
      ) : listState === "failed" ? (
        <div role="alert" style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
          <p className="app-field-error" style={muted}>The invitations could not be loaded.</p>
          <button type="button" className="app-secondary-action" onClick={() => void load()}>
            Try again
          </button>
        </div>
      ) : listState === "no_workspace" ? null : listState === "refused" ? (
        <p data-external-review-list-refused className="app-field-help" style={muted}>
          {otherWorkspace
            ? "Open this record's workspace to see its external review invitations."
            : "Your role doesn't include viewing this workspace's external review invitations — an owner or admin manages them."}
        </p>
      ) : (grants ?? []).length === 0 ? (
        <p data-external-review-empty className="app-field-help" style={muted}>
          No one outside the workspace has been invited to review this yet.
        </p>
      ) : (
        <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 6 }}>
          {(grants ?? []).map((g) => (
            <li
              key={g.id}
              data-external-review-grant={g.id}
              data-external-review-grant-state={g.state}
              style={{ borderTop: "1px solid var(--border-subtle, rgba(15, 23, 42, 0.06))", paddingTop: 8, minWidth: 0 }}
            >
              <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
                <span className="app-table__primary" style={{ overflowWrap: "anywhere", minWidth: 0 }}>
                  {g.reviewerDisplayName || g.reviewerEmail}
                </span>
                <span className={LIVE_STATES.has(g.state) ? "app-chip app-chip--ok" : "app-chip"}>{identifierLabel(g.state)}</span>
                <span className="app-table__muted">
                  {LIVE_STATES.has(g.state) ? "Access ends" : "Access ended"} {formatUserDateTime(g.expiresAtUtc)}
                </span>
                <span style={{ flex: 1 }} />
                {/* TEAM-UI-SPEC §1 — feedback is navigation (ghost), Renew is
                    ordinary (secondary), Revoke is irreversible: a `--danger`
                    entry that opens the danger confirm. */}
                <button type="button" className="app-ghost-action" onClick={() => void onInspect(g)} aria-expanded={openId === g.id}>
                  {openId === g.id ? "Hide feedback" : "Reviewer feedback"}
                </button>
                {g.viewerCanRenew === true ? (
                  <button type="button" className="app-secondary-action" onClick={() => void onRenew(g)} data-external-review-renew={g.id}>
                    Renew
                  </button>
                ) : null}
                {canRevoke(g) ? (
                  <button
                    type="button"
                    className="app-secondary-action app-secondary-action--danger"
                    onClick={() => void onRevoke(g)}
                    data-external-review-revoke={g.id}
                  >
                    Revoke
                  </button>
                ) : null}
              </div>
              {openId === g.id ? (
                <div data-external-review-feedback style={{ marginTop: 6, display: "grid", gap: 4, overflowWrap: "anywhere" }}>
                  {feedback === null ? (
                    <span role="status" className="app-field-help">Loading…</span>
                  ) : feedback === "unavailable" ? (
                    <span className="app-field-error">Reviewer feedback could not be loaded.</span>
                  ) : feedback.decisions.length === 0 && feedback.comments.length === 0 ? (
                    <span className="app-field-help">The reviewer has not commented or decided yet.</span>
                  ) : (
                    <>
                      {feedback.decisions.map((d) => (
                        <div key={d.id}>
                          <strong>Decision: {identifierLabel(d.verdict)}</strong>{" "}
                          <span className="app-table__muted">{formatUserDateTime(d.submittedAtUtc)}</span>
                          {d.rationale ? <p style={{ margin: "2px 0 0", whiteSpace: "pre-wrap" }}>{d.rationale}</p> : null}
                        </div>
                      ))}
                      {feedback.comments.map((c) => (
                        <div key={c.id}>
                          <span className="app-table__muted">
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
