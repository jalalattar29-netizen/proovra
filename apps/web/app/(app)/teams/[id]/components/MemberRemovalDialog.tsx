"use client";

/**
 * Phase 2.2 — Team member offboarding dialog.
 *
 * Replaces the bare `window.confirm("Remove this member from the team?")`
 * (read-only audit P0) with a real dialog that:
 *
 *   1. Calls `GET /v1/teams/:id/members/:memberId/removal-impact` to
 *      surface EXACTLY which records the member owns (so the operator
 *      knows what they are about to re-assign).
 *   2. If `impact.requiresTransfer` is true, blocks "Remove" until a
 *      transfer target is picked. If no eligible ADMIN+ members exist,
 *      the dialog explains the gap rather than silently failing with
 *      a 409 toast after the click.
 *   3. Calls `DELETE /v1/teams/:id/members/:memberId` with
 *      `transferToUserId` so the backend transactionally re-assigns
 *      ownership atomically with the removal (Phase 2.1 backend).
 *
 * Hard rules (re-stated from Phase 2.1 backend):
 *   - Never orphan owned evidence or cases.
 *   - Never reveal the email of a non-ADMIN+ member to a non-ADMIN+
 *     requester (the impact endpoint is ADMIN+ gated, so eligible
 *     emails are safe to surface here — but we still treat them as
 *     workspace-internal and do not log them).
 *   - Never call DELETE without an explicit operator click.
 *   - Backend is authoritative: even if a stale UI passes a bad
 *     transferToUserId, the DELETE returns 400 INVALID_TRANSFER_TARGET
 *     and we surface that.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { Modal } from "../../../../../components/cases-experience/matter-modals/Modal";
import { Button } from "../../../../../components/ui";
import { apiFetch } from "../../../../../lib/api";
import { captureException } from "../../../../../lib/sentry";

type RemovalImpactResponse = {
  member: {
    memberId: string;
    userId: string;
    role: string;
  };
  impact: {
    ownedEvidence: number;
    ownedCases: number;
    openAssignments: number;
    requiresTransfer: boolean;
  };
  eligibleTransferTargets: Array<{
    memberId: string;
    userId: string;
    email: string | null;
    displayName: string | null;
    role: string;
  }>;
};

export type MemberRemovalDialogProps = {
  open: boolean;
  teamId: string;
  member: {
    /**
     * `TeamMember.id` (the row PK), NOT `userId`. The Fastify routes
     * `/v1/teams/:id/members/:memberId(/removal-impact)` look up by
     * `TeamMember.id`. Passing `userId` here would return 404.
     */
    memberId: string;
    userId: string;
    label: string;
    role: string;
  } | null;
  onCancel: () => void;
  /**
   * Called after the DELETE succeeds. The parent should refresh its
   * local member list and surface a success toast — this component
   * does NOT mutate parent state.
   */
  onRemoved: (args: { transferToUserId: string | null }) => void;
};

export function MemberRemovalDialog({
  open,
  teamId,
  member,
  onCancel,
  onRemoved,
}: MemberRemovalDialogProps) {
  const [loading, setLoading] = useState(false);
  const [impact, setImpact] = useState<RemovalImpactResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [transferToUserId, setTransferToUserId] = useState<string>("");
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  // Reset state every time the dialog opens for a new member. Without
  // this, switching from member A to member B without unmounting would
  // briefly render A's impact under B's name.
  useEffect(() => {
    if (!open) return;
    setImpact(null);
    setLoadError(null);
    setTransferToUserId("");
    setSubmitError(null);
  }, [open, member?.memberId]);

  useEffect(() => {
    if (!open || !teamId || !member?.memberId) return;
    let cancelled = false;

    const load = async () => {
      setLoading(true);
      setLoadError(null);
      try {
        const data = (await apiFetch(
          `/v1/teams/${teamId}/members/${member.memberId}/removal-impact`,
        )) as RemovalImpactResponse;
        if (cancelled) return;
        setImpact(data);
      } catch (err) {
        if (cancelled) return;
        const e = err as { statusCode?: number; message?: string };
        captureException(err, {
          feature: "team_member_remove_impact",
          teamId,
          memberId: member.memberId,
        });
        if (e.statusCode === 403) {
          setLoadError(
            "You don't have permission to view this member's removal impact.",
          );
        } else if (e.statusCode === 404) {
          setLoadError(
            "This member is no longer in the team — refresh the page.",
          );
        } else {
          setLoadError(
            e.message ?? "Failed to load removal impact. Try again.",
          );
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void load();

    return () => {
      cancelled = true;
    };
  }, [open, teamId, member?.memberId]);

  const requiresTransfer = impact?.impact.requiresTransfer === true;
  const hasEligibleTargets =
    (impact?.eligibleTransferTargets?.length ?? 0) > 0;

  // Submit is allowed when:
  //   - impact has loaded
  //   - if transfer is required, a target is selected
  //   - we're not already submitting
  const canSubmit = useMemo(() => {
    if (!impact || submitting) return false;
    if (requiresTransfer) {
      if (!hasEligibleTargets) return false;
      if (!transferToUserId) return false;
    }
    return true;
  }, [impact, submitting, requiresTransfer, hasEligibleTargets, transferToUserId]);

  const handleConfirm = useCallback(async () => {
    if (!teamId || !member?.memberId || !canSubmit) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const body =
        requiresTransfer && transferToUserId
          ? { transferToUserId }
          : undefined;
      await apiFetch(`/v1/teams/${teamId}/members/${member.memberId}`, {
        method: "DELETE",
        ...(body
          ? {
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(body),
            }
          : {}),
      });
      onRemoved({ transferToUserId: transferToUserId || null });
    } catch (err) {
      const e = err as {
        statusCode?: number;
        code?: string;
        message?: string;
      };
      captureException(err, {
        feature: "team_member_remove",
        teamId,
        memberId: member.memberId,
      });
      // Backend is authoritative — surface its codes verbatim so the
      // operator sees what the server told us, not a generic toast.
      if (e.code === "TRANSFER_TARGET_REQUIRED") {
        setSubmitError(
          "This member still owns active records. Pick a transfer target above before removing.",
        );
      } else if (e.code === "INVALID_TRANSFER_TARGET") {
        setSubmitError(
          "That transfer target isn't eligible anymore — refresh and try again.",
        );
      } else if (e.statusCode === 403) {
        setSubmitError(
          "You don't have permission to remove members from this team.",
        );
      } else {
        setSubmitError(e.message ?? "Failed to remove member.");
      }
    } finally {
      setSubmitting(false);
    }
  }, [
    teamId,
    member?.memberId,
    canSubmit,
    requiresTransfer,
    transferToUserId,
    onRemoved,
  ]);

  if (!member) return null;

  return (
    <Modal
      open={open}
      onClose={() => {
        if (!submitting) onCancel();
      }}
      title={`Remove ${member.label}`}
      description={`Confirm removal of ${member.label} from this team. Their owned records may need to be transferred first.`}
      testid="team-member-removal"
      dismissDisabled={submitting}
      footer={
        <>
          <Button
            variant="secondary"
            onClick={onCancel}
            disabled={submitting}
            data-member-removal-cancel
          >
            Cancel
          </Button>
          <Button
            onClick={() => void handleConfirm()}
            disabled={!canSubmit}
            data-member-removal-confirm
          >
            {submitting ? "Removing…" : "Remove member"}
          </Button>
        </>
      }
    >
      <div data-member-removal-body>
        <p
          style={{
            margin: "0 0 12px",
            fontSize: 14,
          }}
        >
          You're about to remove{" "}
          <strong data-member-removal-target>{member.label}</strong> (
          <code style={{ opacity: 0.85 }}>{member.role}</code>) from the team.
        </p>

        {loading ? (
          <p
            style={{ margin: 0, opacity: 0.75, fontSize: 13 }}
            data-member-removal-loading
          >
            Checking what they own in this team…
          </p>
        ) : null}

        {loadError ? (
          <p
            style={{
              margin: 0,
              padding: "10px 12px",
              background: "rgba(220, 70, 70, 0.08)",
              border: "1px solid rgba(220, 70, 70, 0.25)",
              borderRadius: 8,
              fontSize: 13,
            }}
            data-member-removal-load-error
          >
            {loadError}
          </p>
        ) : null}

        {!loading && !loadError && impact ? (
          <>
            <div
              data-member-removal-impact
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
                gap: 8,
                margin: "0 0 14px",
              }}
            >
              <ImpactStat
                label="Evidence owned"
                value={impact.impact.ownedEvidence}
                testid="member-removal-impact-evidence"
                tone={impact.impact.ownedEvidence > 0 ? "warn" : "neutral"}
              />
              <ImpactStat
                label="Cases owned"
                value={impact.impact.ownedCases}
                testid="member-removal-impact-cases"
                tone={impact.impact.ownedCases > 0 ? "warn" : "neutral"}
              />
              <ImpactStat
                label="Open assignments"
                value={impact.impact.openAssignments}
                testid="member-removal-impact-assignments"
                tone="neutral"
              />
            </div>

            {requiresTransfer ? (
              hasEligibleTargets ? (
                <div data-member-removal-transfer-section>
                  <label
                    htmlFor="member-removal-transfer-target"
                    style={{
                      display: "block",
                      fontSize: 13,
                      fontWeight: 600,
                      marginBottom: 6,
                    }}
                  >
                    Transfer ownership to
                  </label>
                  <select
                    id="member-removal-transfer-target"
                    data-member-removal-transfer-select
                    value={transferToUserId}
                    onChange={(e) => setTransferToUserId(e.target.value)}
                    disabled={submitting}
                    style={{
                      width: "100%",
                      padding: "10px 12px",
                      background: "rgba(255,255,255,0.04)",
                      border: "1px solid rgba(255,255,255,0.12)",
                      borderRadius: 8,
                      color: "inherit",
                      fontSize: 13,
                    }}
                  >
                    <option value="" disabled>
                      Choose an admin to receive these records…
                    </option>
                    {impact.eligibleTransferTargets.map((t) => {
                      const label =
                        t.displayName?.trim() ||
                        t.email ||
                        `User ${t.userId.slice(0, 8)}`;
                      return (
                        <option
                          key={t.userId}
                          value={t.userId}
                          data-member-removal-transfer-option={t.userId}
                        >
                          {label} ({t.role})
                        </option>
                      );
                    })}
                  </select>
                  <p
                    style={{
                      margin: "8px 0 0",
                      fontSize: 12,
                      opacity: 0.7,
                    }}
                  >
                    Only ADMIN-or-OWNER members are eligible. Ownership
                    transfer happens atomically with the removal — no
                    record will be orphaned.
                  </p>
                </div>
              ) : (
                <div
                  data-member-removal-no-targets
                  style={{
                    padding: "10px 12px",
                    background: "rgba(214,184,157,0.08)",
                    border: "1px solid rgba(214,184,157,0.25)",
                    borderRadius: 8,
                    fontSize: 13,
                  }}
                >
                  <strong>Removal blocked — no eligible transfer target.</strong>
                  <p style={{ margin: "6px 0 0" }}>
                    This member owns active records but the team has no
                    other ADMIN or OWNER to receive them. Promote another
                    member to ADMIN first, then re-open this dialog.
                  </p>
                </div>
              )
            ) : (
              <p
                style={{
                  margin: 0,
                  fontSize: 13,
                  opacity: 0.85,
                }}
                data-member-removal-no-transfer
              >
                This member doesn't own any active evidence or cases in
                this team. Removing them won't transfer any ownership.
              </p>
            )}

            {submitError ? (
              <p
                style={{
                  margin: "12px 0 0",
                  padding: "10px 12px",
                  background: "rgba(220, 70, 70, 0.08)",
                  border: "1px solid rgba(220, 70, 70, 0.25)",
                  borderRadius: 8,
                  fontSize: 13,
                }}
                data-member-removal-submit-error
              >
                {submitError}
              </p>
            ) : null}
          </>
        ) : null}
      </div>
    </Modal>
  );
}

function ImpactStat({
  label,
  value,
  testid,
  tone,
}: {
  label: string;
  value: number;
  testid: string;
  tone: "neutral" | "warn";
}) {
  const palette =
    tone === "warn"
      ? {
          border: "1px solid rgba(214,184,157,0.30)",
          background: "rgba(214,184,157,0.10)",
        }
      : {
          border: "1px solid rgba(255,255,255,0.08)",
          background: "rgba(255,255,255,0.02)",
        };
  return (
    <div
      data-testid={testid}
      style={{
        ...palette,
        padding: "10px 12px",
        borderRadius: 8,
      }}
    >
      <div
        style={{
          fontSize: 11,
          opacity: 0.7,
          textTransform: "uppercase",
          letterSpacing: 0.5,
        }}
      >
        {label}
      </div>
      <div
        style={{
          marginTop: 4,
          fontSize: 18,
          fontWeight: 700,
          fontVariantNumeric: "tabular-nums",
        }}
        data-impact-value
      >
        {value}
      </div>
    </div>
  );
}
