"use client";

/**
 * PHASE 13 — the two missing cross-org review controls.
 *
 *   POST /v1/governance/cross-org-review           (invite)
 *   POST /v1/governance/cross-org-review/:id/accept
 *
 * The console already listed grants and could already DECLINE and REVOKE
 * them. It could not create one, and it could not accept one — so an INVITED
 * row was a dead end with exactly one exit, refusal.
 *
 * Authorisation (mirrored client-side only to disable the control):
 *   invite → ORG_ADMIN or REVIEWER_LEAD, plus FEATURE_CROSS_ORG_REVIEW and
 *            FEATURE_GOVERNANCE_PLATFORM entitlements (server-checked; a
 *            denial renders as the bounded entitlement message).
 *   accept → ORG_ADMIN.
 */

import { useCallback, useId, useState } from "react";

import type { CrossOrgReviewGrantProjection } from "@proovra/shared";

import { apiFetch } from "../../lib/api";
import { Button } from "../ui/Button";
import { Card } from "../ui/Card";
import {
  GovernanceActionStatus,
  GovernanceSelectField,
  GovernanceTextArea,
  GovernanceTextField,
  governanceFieldGridStyle,
  governanceFieldRowStyle,
} from "./GovernanceFormField";
import {
  ORG_SLUG_PATTERN,
  isUuid,
  toIsoInstant,
  useDelegatedTierAccess,
  useGovernanceAction,
  useGovernanceOrganization,
} from "./governance-action-state";

type FieldErrors = Record<string, string | null>;

// ---------------------------------------------------------------------------
// Invite — POST /v1/governance/cross-org-review
// ---------------------------------------------------------------------------

export function CrossOrgInviteForm({
  onCreated,
}: {
  /** Refetches the grant list so the new INVITED row is visible at once. */
  onCreated: () => Promise<void> | void;
}) {
  const uid = useId();
  const { busy, outcome, reset, run } = useGovernanceAction();
  const org = useGovernanceOrganization();
  const tiers = useDelegatedTierAccess();

  const [invitedOrgSlug, setInvitedOrgSlug] = useState("");
  const [scope, setScope] = useState("");
  const [expiresAt, setExpiresAt] = useState("");
  const [errors, setErrors] = useState<FieldErrors>({});

  const permitted = tiers.hasAnyTier(["ORG_ADMIN", "REVIEWER_LEAD"], {
    organizationId: org.organizationId,
  });
  const contextReady = !org.loading && org.organizationId !== null;
  const canSubmit = permitted && contextReady && !busy;

  const validate = useCallback((): FieldErrors | null => {
    const next: FieldErrors = {};
    const slug = invitedOrgSlug.trim();
    if (!slug) {
      next[`${uid}-slug`] = "An invited organization slug is required.";
    } else if (!ORG_SLUG_PATTERN.test(slug)) {
      next[`${uid}-slug`] =
        "Use lower-case letters, digits and hyphens only, starting with a letter or digit (max 81 characters).";
    }
    const trimmedScope = scope.trim();
    if (!trimmedScope) {
      next[`${uid}-scope`] = "Describe what the invited organization may review.";
    } else if (trimmedScope.length > 600) {
      next[`${uid}-scope`] = "The scope must be 600 characters or fewer.";
    }
    if (expiresAt.trim() && toIsoInstant(expiresAt) === null) {
      next[`${uid}-expires`] = "Enter a valid expiry date and time, or leave it blank.";
    }
    return Object.keys(next).length > 0 ? next : null;
  }, [invitedOrgSlug, scope, expiresAt, uid]);

  const submit = useCallback(
    async (event: React.FormEvent) => {
      event.preventDefault();
      if (!canSubmit) return;
      const invalid = validate();
      setErrors(invalid ?? {});
      if (invalid) return;
      const organizationId = org.organizationId;
      if (!organizationId) return;
      await run(
        async () => {
          await apiFetch("/v1/governance/cross-org-review", {
            method: "POST",
            body: JSON.stringify({
              invitingOrganizationId: organizationId,
              invitedOrgSlug: invitedOrgSlug.trim(),
              scope: scope.trim(),
              expiresAtUtc: toIsoInstant(expiresAt),
            }),
          });
          setInvitedOrgSlug("");
          setScope("");
          setExpiresAt("");
          await onCreated();
        },
        {
          success:
            "Invitation sent. The grant is listed below as INVITED until the other organization responds.",
          fallback: "Could not invite that organization to a cross-org review.",
        },
      );
    },
    [
      canSubmit,
      validate,
      org.organizationId,
      run,
      invitedOrgSlug,
      scope,
      expiresAt,
      onCreated,
    ],
  );

  return (
    <Card
      variant="admin"
      title="Invite an organization"
      subtitle="Grants another organization a bounded, revocable review relationship with this one."
      data-cross-org-invite-form
    >
      <form onSubmit={submit} noValidate>
        <div style={governanceFieldGridStyle}>
          <GovernanceTextField
            id={`${uid}-slug`}
            label="Invited organization slug"
            value={invitedOrgSlug}
            onChange={(v) => {
              setInvitedOrgSlug(v);
              reset();
            }}
            error={errors[`${uid}-slug`]}
            hint="The public slug of the organization you are inviting."
            placeholder="partner-legal"
            maxLength={81}
            disabled={!permitted || busy}
            testAttr="data-cross-org-invite-slug"
          />
          <GovernanceTextField
            id={`${uid}-expires`}
            label="Expires (optional)"
            type="datetime-local"
            value={expiresAt}
            onChange={(v) => {
              setExpiresAt(v);
              reset();
            }}
            error={errors[`${uid}-expires`]}
            hint="Leave blank for a grant with no scheduled expiry."
            disabled={!permitted || busy}
            testAttr="data-cross-org-invite-expires"
          />
          <GovernanceTextArea
            id={`${uid}-scope`}
            label="Review scope"
            value={scope}
            onChange={(v) => {
              setScope(v);
              reset();
            }}
            error={errors[`${uid}-scope`]}
            hint="Operator-readable description of what the invited organization may review. Max 600 characters."
            maxLength={600}
            disabled={!permitted || busy}
            testAttr="data-cross-org-invite-scope"
          />
        </div>

        <div style={governanceFieldRowStyle}>
          <Button
            type="submit"
            variant="enterprise"
            loading={busy}
            disabled={!canSubmit}
            data-cross-org-invite-submit
          >
            {busy ? "Inviting…" : "Invite organization"}
          </Button>
          {!tiers.ready ? (
            <span style={noteStyle}>Checking your governance tier…</span>
          ) : !permitted ? (
            <span style={noteStyle} data-cross-org-invite-blocked="tier">
              Inviting another organization needs the ORG_ADMIN or REVIEWER_LEAD
              delegated-admin tier in this workspace.
            </span>
          ) : org.loading ? (
            <span style={noteStyle}>Resolving this workspace&apos;s organization…</span>
          ) : !contextReady ? (
            <span style={noteStyle} data-cross-org-invite-blocked="organization">
              This workspace is not bound to a governance organization, so there
              is no inviting organization to send from.
            </span>
          ) : null}
        </div>

        <GovernanceActionStatus
          busy={busy}
          outcome={outcome}
          busyLabel="Sending the cross-org review invitation…"
          testAttr="data-cross-org-invite-status"
        />
      </form>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Accept — POST /v1/governance/cross-org-review/:id/accept
// ---------------------------------------------------------------------------

export function CrossOrgAcceptForm({
  grant,
  onAccepted,
  onCancel,
}: {
  grant: CrossOrgReviewGrantProjection;
  onAccepted: () => Promise<void> | void;
  onCancel: () => void;
}) {
  const uid = useId();
  const { busy, outcome, reset, run } = useGovernanceAction();
  const org = useGovernanceOrganization();
  const tiers = useDelegatedTierAccess();

  const [externalGrantId, setExternalGrantId] = useState("");
  const [errors, setErrors] = useState<FieldErrors>({});

  const permitted = tiers.hasTier("ORG_ADMIN", {
    organizationId: org.organizationId,
  });
  const contextReady = !org.loading && org.organizationId !== null;
  const canSubmit = permitted && contextReady && !busy;

  const submit = useCallback(
    async (event: React.FormEvent) => {
      event.preventDefault();
      if (!canSubmit) return;
      const trimmed = externalGrantId.trim();
      if (trimmed && !isUuid(trimmed)) {
        setErrors({
          [`${uid}-external`]:
            "An external review grant id must be a UUID, or leave the field blank.",
        });
        return;
      }
      setErrors({});
      const organizationId = org.organizationId;
      if (!organizationId) return;
      await run(
        async () => {
          await apiFetch(
            `/v1/governance/cross-org-review/${grant.id}/accept`,
            {
              method: "POST",
              body: JSON.stringify({
                acceptingOrganizationId: organizationId,
                externalReviewGrantId: trimmed ? trimmed : null,
              }),
            },
          );
          setExternalGrantId("");
          await onAccepted();
        },
        {
          success: "Invitation accepted. The grant is now ACCEPTED.",
          fallback: "Could not accept this cross-org review invitation.",
        },
      );
    },
    [canSubmit, externalGrantId, uid, org.organizationId, run, grant.id, onAccepted],
  );

  return (
    <Card
      variant="admin"
      title={`Accept invitation from ${grant.invitedOrgSlug}`}
      subtitle="Accepting binds this organization to the review scope shown in the row. It can still be revoked afterwards."
      data-cross-org-accept-form={grant.id}
    >
      <form onSubmit={submit} noValidate>
        <div style={governanceFieldGridStyle}>
          <GovernanceTextField
            id={`${uid}-external`}
            label="External review grant id (optional)"
            value={externalGrantId}
            onChange={(v) => {
              setExternalGrantId(v);
              reset();
            }}
            error={errors[`${uid}-external`]}
            hint="Binds this acceptance to an existing External Reviewer Portal grant. Leave blank to accept without one."
            placeholder="00000000-0000-0000-0000-000000000000"
            disabled={!permitted || busy}
            testAttr="data-cross-org-accept-external"
          />
          <GovernanceSelectField
            id={`${uid}-scope-readonly`}
            label="Accepting organization"
            value="server"
            onChange={() => undefined}
            options={[
              {
                value: "server",
                label: org.organizationId
                  ? `${org.organizationId.slice(0, 8)}… (derived from this workspace)`
                  : "Not resolved",
              },
            ]}
            disabled
            hint="Derived server-side from your active workspace — never chosen by the browser."
          />
        </div>

        <div style={governanceFieldRowStyle}>
          <Button
            type="submit"
            variant="enterprise"
            loading={busy}
            disabled={!canSubmit}
            data-cross-org-accept-submit={grant.id}
          >
            {busy ? "Accepting…" : "Accept invitation"}
          </Button>
          <Button
            type="button"
            variant="secondary"
            onClick={onCancel}
            disabled={busy}
            data-cross-org-accept-cancel
          >
            Cancel
          </Button>
          {!tiers.ready ? (
            <span style={noteStyle}>Checking your governance tier…</span>
          ) : !permitted ? (
            <span style={noteStyle} data-cross-org-accept-blocked="tier">
              Accepting a cross-org invitation needs the ORG_ADMIN
              delegated-admin tier in this workspace.
            </span>
          ) : !contextReady ? (
            <span style={noteStyle} data-cross-org-accept-blocked="organization">
              This workspace is not bound to a governance organization, so there
              is no accepting organization to answer with.
            </span>
          ) : null}
        </div>

        <GovernanceActionStatus
          busy={busy}
          outcome={outcome}
          busyLabel="Accepting the cross-org review invitation…"
          testAttr="data-cross-org-accept-status"
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
