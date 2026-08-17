"use client";

/**
 * PHASE 13 — POST /v1/governance/destruction-reviews.
 *
 * The destruction QUEUE on this page reads `DestructionReview` rows and can
 * walk the whole state machine over them. Nothing in the product could put a
 * row INTO that queue: the only writers were the retention sweeper and the
 * reconciliation worker. The parallel `POST /v1/lifecycle/destruction/requests`
 * surface is not a substitute — it writes `DestructionRequest`, a different
 * model this queue never reads.
 *
 * Authorisation: `requireMember(teamId, "evidence.delete")` plus the
 * Enterprise `legalHold` feature gate (402 when the plan excludes it). The
 * permission is mirrored client-side from the canonical shared role matrix so
 * a member who cannot delete evidence sees the control disabled with the
 * reason, rather than a 403 after typing an evidence id.
 *
 * Opening a review is DELIBERATE and consequential, so it is confirmed before
 * the request leaves — the same `useConfirmAction` primitive the queue's
 * APPROVE / EXECUTE transitions already use.
 */

import { useCallback, useId, useState } from "react";

import {
  DESTRUCTION_REVIEW_REASONS,
  mapTeamRoleToCanonical,
  roleHasPermission,
  type DestructionReviewReason,
} from "@proovra/shared";

import { apiFetch } from "../../lib/api";
import { usePlatformContext } from "../../lib/platform-context";
import { Button } from "../ui/Button";
import { Card } from "../ui/Card";
import { useConfirmAction } from "../ui/ConfirmActionModal";
import {
  GovernanceActionStatus,
  GovernanceSelectField,
  GovernanceTextField,
  governanceFieldGridStyle,
  governanceFieldRowStyle,
} from "./GovernanceFormField";
import { isUuid, useGovernanceAction } from "./governance-action-state";

const REASON_LABEL: Record<DestructionReviewReason, string> = {
  retention_expired: "Retention expired",
  manual_review: "Manual review",
  policy_supersede: "Policy supersede",
};

export function DestructionReviewForm({
  teamId,
  onCreated,
}: {
  /** Active workspace, read by the page from `useTeamId()`. */
  teamId: string | null;
  onCreated: () => Promise<void> | void;
}) {
  const uid = useId();
  const { busy, outcome, reset, run } = useGovernanceAction();
  const { confirm } = useConfirmAction();
  const { envelope } = usePlatformContext();

  const [evidenceId, setEvidenceId] = useState("");
  const [reason, setReason] = useState<DestructionReviewReason>("manual_review");
  const [policyId, setPolicyId] = useState("");
  const [policyVersion, setPolicyVersion] = useState("");
  const [errors, setErrors] = useState<Record<string, string | null>>({});

  /**
   * The active space's role, read from the CANONICAL projection.
   *
   * The deprecated legacy workspace field on the envelope is inside a closing
   * deprecation window — the Phase-37.95 and G4.3 guards fail any new consumer
   * of it — and it can disagree with the space the caller is actually operating
   * in, which is the whole reason `activeSpace` exists. A destruction proposal
   * gated on the wrong space's role is exactly the mistake worth avoiding here.
   *
   * This mirror is advisory: the route re-checks `evidence.delete` server-side.
   */
  // A PERSONAL space reports the literal label "Owner"; an ORGANIZATION space
  // reports the WorkspaceRole enum. Normalised here so one permission check
  // covers both, rather than two branches that could drift apart.
  const roleLabel = envelope?.activeSpace?.roleLabel ?? null;
  const role = roleLabel === null ? null : (roleLabel.toUpperCase() as "OWNER" | "ADMIN" | "MEMBER" | "VIEWER");
  const permitted =
    role !== null &&
    roleHasPermission(mapTeamRoleToCanonical(role), "evidence.delete");
  const canSubmit = permitted && teamId !== null && !busy;

  const validate = useCallback((): Record<string, string | null> | null => {
    const next: Record<string, string | null> = {};
    const trimmed = evidenceId.trim();
    if (!trimmed) {
      next[`${uid}-evidence`] = "An evidence id is required.";
    } else if (!isUuid(trimmed)) {
      next[`${uid}-evidence`] =
        "An evidence id is a UUID — copy it from the evidence record's address bar.";
    }
    if (!(DESTRUCTION_REVIEW_REASONS as ReadonlyArray<string>).includes(reason)) {
      next[`${uid}-reason`] = "Choose why this evidence is being proposed for destruction.";
    }
    const trimmedPolicy = policyId.trim();
    if (trimmedPolicy && !isUuid(trimmedPolicy)) {
      next[`${uid}-policy`] = "A retention policy id is a UUID, or leave the field blank.";
    }
    const trimmedVersion = policyVersion.trim();
    if (trimmedVersion) {
      const parsed = Number(trimmedVersion);
      if (!Number.isInteger(parsed) || parsed < 1) {
        next[`${uid}-version`] = "The policy version is a whole number of 1 or more.";
      } else if (!trimmedPolicy) {
        next[`${uid}-policy`] =
          "Name the retention policy this version belongs to, or clear the version.";
      }
    }
    return Object.keys(next).length > 0 ? next : null;
  }, [evidenceId, reason, policyId, policyVersion, uid]);

  const submit = useCallback(
    async (event: React.FormEvent) => {
      event.preventDefault();
      if (!canSubmit || !teamId) return;
      const invalid = validate();
      setErrors(invalid ?? {});
      if (invalid) return;
      const confirmed = await confirm({
        title: "Open a destruction review?",
        description:
          "This queues the evidence for reviewer approval. It does not destroy anything on its own — approval and execution are separate, step-up-gated decisions. Legal holds and immutable retention will refuse the review.",
        confirmLabel: "Open review",
        tone: "warning",
        testId: "destruction-review-create",
      });
      if (!confirmed) return;
      const trimmedPolicy = policyId.trim();
      const trimmedVersion = policyVersion.trim();
      await run(
        async () => {
          await apiFetch("/v1/governance/destruction-reviews", {
            method: "POST",
            body: JSON.stringify({
              teamId,
              evidenceId: evidenceId.trim(),
              reason,
              retentionPolicyId: trimmedPolicy ? trimmedPolicy : null,
              retentionPolicyVersion: trimmedVersion ? Number(trimmedVersion) : null,
            }),
          });
          setEvidenceId("");
          setPolicyId("");
          setPolicyVersion("");
          await onCreated();
        },
        {
          success:
            "Destruction review opened. It is listed in the queue below as PENDING.",
          fallback: "Could not open a destruction review for that evidence.",
        },
      );
    },
    [
      canSubmit,
      teamId,
      validate,
      confirm,
      policyId,
      policyVersion,
      run,
      evidenceId,
      reason,
      onCreated,
    ],
  );

  return (
    <Card
      variant="admin"
      title="Open a destruction review"
      subtitle="Proposes one evidence record for destruction. The review lands in the queue below at PENDING — nothing is destroyed until a reviewer approves and executes it."
      data-destruction-review-form
    >
      <form onSubmit={submit} noValidate>
        <div style={governanceFieldGridStyle}>
          <GovernanceTextField
            id={`${uid}-evidence`}
            label="Evidence id"
            value={evidenceId}
            onChange={(v) => {
              setEvidenceId(v);
              reset();
            }}
            error={errors[`${uid}-evidence`]}
            hint="The UUID of the evidence record, as shown in its URL."
            placeholder="00000000-0000-0000-0000-000000000000"
            disabled={!permitted || busy}
            testAttr="data-destruction-review-evidence"
          />
          <GovernanceSelectField
            id={`${uid}-reason`}
            label="Reason"
            value={reason}
            onChange={(v) => {
              setReason(v as DestructionReviewReason);
              reset();
            }}
            options={DESTRUCTION_REVIEW_REASONS.map((r) => ({
              value: r,
              label: REASON_LABEL[r],
            }))}
            error={errors[`${uid}-reason`]}
            hint="Recorded on the review and carried into the audit trail."
            disabled={!permitted || busy}
            testAttr="data-destruction-review-reason"
          />
          <GovernanceTextField
            id={`${uid}-policy`}
            label="Retention policy id (optional)"
            value={policyId}
            onChange={(v) => {
              setPolicyId(v);
              reset();
            }}
            error={errors[`${uid}-policy`]}
            hint="Links the review to the retention policy that justifies it."
            placeholder="00000000-0000-0000-0000-000000000000"
            disabled={!permitted || busy}
            testAttr="data-destruction-review-policy"
          />
          <GovernanceTextField
            id={`${uid}-version`}
            label="Retention policy version (optional)"
            type="number"
            value={policyVersion}
            onChange={(v) => {
              setPolicyVersion(v);
              reset();
            }}
            error={errors[`${uid}-version`]}
            hint="The version of that policy in force when the review was proposed."
            disabled={!permitted || busy}
            testAttr="data-destruction-review-version"
          />
        </div>

        <div style={governanceFieldRowStyle}>
          <Button
            type="submit"
            variant="destructive"
            loading={busy}
            disabled={!canSubmit}
            data-destruction-review-submit
          >
            {busy ? "Opening…" : "Open destruction review"}
          </Button>
          {!teamId ? (
            <span style={noteStyle} data-destruction-review-blocked="workspace">
              Switch to an organization workspace to open a destruction review.
            </span>
          ) : role === null ? (
            <span style={noteStyle}>Checking your workspace permissions…</span>
          ) : !permitted ? (
            <span style={noteStyle} data-destruction-review-blocked="permission">
              Opening a destruction review needs the evidence-delete permission
              in this workspace. Your role does not carry it.
            </span>
          ) : null}
        </div>

        <GovernanceActionStatus
          busy={busy}
          outcome={outcome}
          busyLabel="Opening the destruction review…"
          testAttr="data-destruction-review-status"
        />
      </form>
    </Card>
  );
}

const noteStyle: React.CSSProperties = {
  fontSize: 12,
  color: "#64748b",
  maxWidth: 520,
};
