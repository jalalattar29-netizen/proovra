"use client";

/**
 * MATRIX-M626 (owner decision I) / closure phase 2 — the record owner's
 * approval of permanent deletion for a legacy record that belongs to no
 * workspace.
 *
 * A sealed record stored without a workspace is never destroyed without its
 * owner's explicit approval (decision I). The API owns every rule:
 *   GET    /v1/evidence/:id/owner-destruction-approval  whether an owner approval
 *          applies here at all, the approval standing for THIS trash cycle,
 *          and whether a live destruction claim refuses a withdrawal;
 *   POST   … {confirm:true}  approve (owner only, step-up, this record, this
 *          trash cycle; tenant-audited);
 *   DELETE …                 withdraw (refused 409 DESTRUCTION_IN_PROGRESS
 *          while destruction is claimed).
 * The panel shows a control only when the GET says one is offered, and says
 * each refusal as the API gives it. Approval is not deletion: trash grace, the
 * eight-year retention, Object Lock and any legal hold still decide — the panel
 * repeats the record's own lifecycle verdicts (legal hold, earliest permanent
 * deletion) from the server projection, never a computation of its own.
 */

import { useCallback, useEffect, useState } from "react";

import { apiFetch } from "../../../../../lib/api";
import { formatUserDateTime } from "../../../../../lib/date";
import { toSafeUserError } from "../../../../../lib/feedback/toSafeUserError";
import { useConfirmAction } from "../../../../../components/ui/ConfirmActionModal";
import {
  StepUpModal,
  isStepUpCancelled,
  useStepUpAction,
} from "../../../../../components/identity-security/StepUpModal";

type ApprovalState =
  | { offered: false; reason?: string }
  | {
      offered: true;
      trashedAtUtc: string;
      approval: { id: string; approvedAtUtc: string } | null;
      destructionInProgress: boolean;
    };

/** The lifecycle verdicts the record projection already carries (read-only). */
export type OwnerApprovalLifecycleFacts = {
  legalHold?: boolean;
  destructionEligibleAtUtc?: string | null;
} | null;

/** The sentence for a refused approve/withdraw, from the API's own code. */
export function ownerDestructionRefusal(err: unknown): string {
  const e = err as { code?: string; statusCode?: number } | null;
  switch (e?.code) {
    case "DESTRUCTION_IN_PROGRESS":
      return "Permanent deletion of this record has already started, so the approval can no longer be withdrawn.";
    case "DESTRUCTION_REVIEW_REQUIRED":
      return "This record belongs to a workspace; its permanent deletion is decided through the workspace's destruction review, not by an owner approval.";
    case "EVIDENCE_NOT_SEALED":
      return "This upload was never completed. It is removed on its own schedule and needs no approval.";
    case "EVIDENCE_NOT_IN_TRASH":
      return "This record is no longer in the trash (it may have been restored). Move it to the trash again to approve its deletion.";
    case "EVIDENCE_ALREADY_DESTROYED":
      return "This record has already been permanently deleted.";
    default:
      break;
  }
  if (e?.statusCode === 404) return "Only the record's owner can approve or withdraw its permanent deletion.";
  return toSafeUserError(err, { message: "The approval could not be changed." }).message;
}

export function OwnerDestructionApprovalPanel({
  evidenceId,
  lifecycle,
}: {
  evidenceId: string;
  lifecycle?: OwnerApprovalLifecycleFacts;
}) {
  // The challenge is minted in the workspace the API names in its
  // STEP_UP_REQUIRED answer (the owner's personal workspace).
  const stepUp = useStepUpAction({ teamId: null });
  const { confirm } = useConfirmAction();
  const [state, setState] = useState<ApprovalState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const read = useCallback(async () => {
    try {
      const res = (await apiFetch(`/v1/evidence/${encodeURIComponent(evidenceId)}/owner-destruction-approval`, {
        method: "GET",
      })) as ApprovalState;
      setState(res && typeof res === "object" ? res : { offered: false });
    } catch {
      // Not the owner (404), or the read failed: no control is offered.
      setState({ offered: false });
    }
  }, [evidenceId]);

  useEffect(() => {
    void read();
  }, [read]);

  if (!state || state.offered !== true) return null;

  const approve = async () => {
    const ok = await confirm({
      title: "Approve permanent deletion of this record?",
      description:
        "This approves deleting this record only, for the time it is in the trash now. It does not delete anything immediately: the trash grace period, the eight-year retention, Object Lock and any legal hold still apply, and the record is deleted only when all of them allow it. Restoring the record cancels the approval. You can withdraw it until deletion starts.",
      confirmLabel: "Approve permanent deletion",
      tone: "danger",
    });
    if (!ok) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await stepUp.runStepUpAction((headers) =>
        apiFetch(`/v1/evidence/${encodeURIComponent(evidenceId)}/owner-destruction-approval`, {
          method: "POST",
          headers: { "content-type": "application/json", ...(headers ?? {}) },
          body: JSON.stringify({ confirm: true }),
        }),
      );
      setNotice("Permanent deletion approved. The record is deleted once retention, grace and any hold allow it.");
    } catch (err) {
      if (!isStepUpCancelled(err)) setError(ownerDestructionRefusal(err));
    } finally {
      setBusy(false);
    }
    await read();
  };

  const withdraw = async () => {
    const ok = await confirm({
      title: "Withdraw your approval?",
      description: "The record stays in the trash and will not be permanently deleted unless you approve again.",
      confirmLabel: "Withdraw approval",
    });
    if (!ok) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await apiFetch(`/v1/evidence/${encodeURIComponent(evidenceId)}/owner-destruction-approval`, { method: "DELETE" });
      setNotice("Approval withdrawn. The record will not be permanently deleted.");
    } catch (err) {
      setError(ownerDestructionRefusal(err));
    } finally {
      setBusy(false);
    }
    await read();
  };

  return (
    <section
      className="evidence-detail-record-banner"
      data-banner-tone="warn"
      aria-label="Permanent deletion approval"
      data-owner-destruction-approval={state.approval ? "approved" : "not-approved"}
    >
      <div className="evidence-detail-record-banner__copy">
        <strong className="evidence-detail-record-banner__title">Permanent deletion needs your approval</strong>
        <span className="evidence-detail-record-banner__body">
          This record belongs to no workspace, so it is never permanently deleted without its owner&rsquo;s approval.
          {state.approval
            ? ` You approved deletion on ${formatUserDateTime(state.approval.approvedAtUtc)} for this time in the trash.`
            : " Nothing is approved."}
        </span>
        {lifecycle?.legalHold ? (
          <span className="evidence-detail-record-banner__body" data-owner-destruction-held>
            A legal hold is on this record. It will not be deleted while the hold lasts, whatever is approved.
          </span>
        ) : null}
        {lifecycle?.destructionEligibleAtUtc ? (
          <span className="evidence-detail-record-banner__body" data-owner-destruction-eligible-at>
            Earliest permanent deletion under retention: {formatUserDateTime(lifecycle.destructionEligibleAtUtc)}.
          </span>
        ) : null}
        {state.approval && state.destructionInProgress ? (
          <span className="evidence-detail-record-banner__body" data-owner-destruction-claimed>
            Permanent deletion has started, so the approval can no longer be withdrawn.
          </span>
        ) : null}
        {notice ? (
          <span className="evidence-detail-record-banner__body" role="status">{notice}</span>
        ) : null}
        {error ? (
          <span className="evidence-detail-record-banner__body" role="alert" data-owner-destruction-error>
            {error}
          </span>
        ) : null}
      </div>
      {!state.approval ? (
        <button
          type="button"
          className="app-secondary-action evidence-detail-destructive-action"
          onClick={() => void approve()}
          disabled={busy}
          data-owner-destruction-approve
        >
          {busy ? "Approving…" : "Approve permanent deletion"}
        </button>
      ) : !state.destructionInProgress ? (
        <button
          type="button"
          className="app-secondary-action"
          onClick={() => void withdraw()}
          disabled={busy}
          data-owner-destruction-withdraw
        >
          {busy ? "Withdrawing…" : "Withdraw approval"}
        </button>
      ) : null}
      <StepUpModal control={stepUp} />
    </section>
  );
}
