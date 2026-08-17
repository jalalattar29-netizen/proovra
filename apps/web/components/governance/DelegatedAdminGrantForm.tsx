"use client";

/**
 * PHASE 13 — POST /v1/governance/delegated-admin.
 *
 * This is NOT the same capability as the identity console's
 * `POST /v1/identity/members/:id/delegated-admin`: that one writes
 * `memberDelegatedAdminScope`, a per-member scope row. This route writes
 * `delegatedAdminGrant`, the tiered model that `hasDelegatedTier` reads and
 * that every `requireDelegatedTier` preHandler in the governance platform
 * gates on. Until now the console could only REVOKE those grants — nothing in
 * the product could issue one, so the tier ladder could never be bootstrapped
 * beyond the implicit workspace-owner grant.
 *
 * Authorisation: the handler calls `hasDelegatedTier(ORG_ADMIN, organizationId)`
 * itself (there is no preHandler), and answers 403 DELEGATED_ADMIN_REQUIRED.
 *
 * Server-side shape rules mirrored here so the operator is told before the
 * request rather than by a 409:
 *   DEPARTMENT_ADMIN requires a departmentId.
 *   WORKSPACE_ADMIN  requires a workspaceId.
 */

import { useCallback, useId, useMemo, useState } from "react";

import {
  DELEGATED_ADMIN_TIERS,
  type DelegatedAdminTier,
} from "@proovra/shared";

import { apiFetch } from "../../lib/api";
import { useTeamId } from "../../lib/platform-context";
import { Button } from "../ui/Button";
import { Card } from "../ui/Card";
import {
  GovernanceActionStatus,
  GovernanceSelectField,
  GovernanceTextField,
  governanceFieldGridStyle,
  governanceFieldRowStyle,
} from "./GovernanceFormField";
import {
  memberLabel,
  toIsoInstant,
  useDelegatedTierAccess,
  useGovernanceAction,
  useGovernanceOrganization,
  useWorkspaceMembers,
} from "./governance-action-state";

export function DelegatedAdminGrantForm({
  onGranted,
}: {
  onGranted: () => Promise<void> | void;
}) {
  const uid = useId();
  const teamId = useTeamId();
  const { busy, outcome, reset, run } = useGovernanceAction();
  const org = useGovernanceOrganization();
  const tiers = useDelegatedTierAccess();
  const roster = useWorkspaceMembers();

  const [granteeUserId, setGranteeUserId] = useState("");
  const [tier, setTier] = useState<DelegatedAdminTier>("REVIEWER_LEAD");
  const [departmentId, setDepartmentId] = useState("");
  const [expiresAt, setExpiresAt] = useState("");
  const [errors, setErrors] = useState<Record<string, string | null>>({});

  const permitted = tiers.hasTier("ORG_ADMIN", {
    organizationId: org.organizationId,
  });
  const contextReady = !org.loading && org.organizationId !== null;
  const canSubmit = permitted && contextReady && !busy;

  const memberOptions = useMemo(
    () => [
      {
        value: "",
        label: roster.members.length ? "Select a member…" : "No members available",
      },
      ...roster.members.map((m) => ({ value: m.userId, label: memberLabel(m) })),
    ],
    [roster.members],
  );

  const validate = useCallback((): Record<string, string | null> | null => {
    const next: Record<string, string | null> = {};
    if (!granteeUserId) {
      next[`${uid}-grantee`] = "Choose the member who will receive the grant.";
    }
    if (!(DELEGATED_ADMIN_TIERS as ReadonlyArray<string>).includes(tier)) {
      next[`${uid}-tier`] = "Choose a delegated-admin tier.";
    }
    if (tier === "DEPARTMENT_ADMIN" && !departmentId) {
      next[`${uid}-department`] =
        "A DEPARTMENT_ADMIN grant must name the department it applies to.";
    }
    if (tier === "WORKSPACE_ADMIN" && !teamId) {
      next[`${uid}-tier`] =
        "A WORKSPACE_ADMIN grant needs an active workspace. Switch to the workspace first.";
    }
    if (expiresAt.trim() && toIsoInstant(expiresAt) === null) {
      next[`${uid}-expires`] = "Enter a valid expiry date and time, or leave it blank.";
    }
    return Object.keys(next).length > 0 ? next : null;
  }, [granteeUserId, tier, departmentId, teamId, expiresAt, uid]);

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
          await apiFetch("/v1/governance/delegated-admin", {
            method: "POST",
            body: JSON.stringify({
              organizationId,
              departmentId: departmentId ? departmentId : null,
              workspaceId: tier === "WORKSPACE_ADMIN" ? teamId : null,
              granteeUserId,
              tier,
              expiresAtUtc: toIsoInstant(expiresAt),
            }),
          });
          setGranteeUserId("");
          setDepartmentId("");
          setExpiresAt("");
          await onGranted();
        },
        {
          success: "Grant issued. It is listed below as ACTIVE.",
          fallback: "Could not issue that delegated-admin grant.",
        },
      );
    },
    [
      canSubmit,
      validate,
      org.organizationId,
      run,
      departmentId,
      tier,
      teamId,
      granteeUserId,
      expiresAt,
      onGranted,
    ],
  );

  return (
    <Card
      variant="admin"
      title="Grant delegated administration"
      subtitle="Issues a tiered grant against this organization. Tiers are enforced server-side on every governance route."
      data-delegated-admin-grant-form
    >
      <form onSubmit={submit} noValidate>
        <div style={governanceFieldGridStyle}>
          <GovernanceSelectField
            id={`${uid}-grantee`}
            label="Grantee"
            value={granteeUserId}
            onChange={(v) => {
              setGranteeUserId(v);
              reset();
            }}
            options={memberOptions}
            error={errors[`${uid}-grantee`]}
            hint={
              roster.failed
                ? "The member roster could not be read in this workspace."
                : "Only active members of this workspace can hold a grant."
            }
            disabled={!permitted || busy}
            testAttr="data-delegated-admin-grantee"
          />
          <GovernanceSelectField
            id={`${uid}-tier`}
            label="Tier"
            value={tier}
            onChange={(v) => {
              setTier(v as DelegatedAdminTier);
              reset();
            }}
            options={DELEGATED_ADMIN_TIERS.map((t) => ({ value: t, label: t }))}
            error={errors[`${uid}-tier`]}
            hint="GLOBAL_ADMIN and ORG_ADMIN inherit the tiers below them; REVIEWER_LEAD, SECURITY_OFFICER and COMPLIANCE_OFFICER are cross-cutting and match only themselves."
            disabled={!permitted || busy}
            testAttr="data-delegated-admin-tier"
          />
          <GovernanceSelectField
            id={`${uid}-department`}
            label={
              tier === "DEPARTMENT_ADMIN" ? "Department" : "Department (optional)"
            }
            value={departmentId}
            onChange={(v) => {
              setDepartmentId(v);
              reset();
            }}
            options={[
              { value: "", label: "Whole organization" },
              ...org.departments.map((d) => ({ value: d.id, label: d.name })),
            ]}
            error={errors[`${uid}-department`]}
            hint="Required for a DEPARTMENT_ADMIN grant; otherwise narrows an otherwise organization-wide grant."
            disabled={!permitted || busy}
            testAttr="data-delegated-admin-department"
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
            hint="An expired grant stops satisfying the tier check without anyone having to revoke it."
            disabled={!permitted || busy}
            testAttr="data-delegated-admin-expires"
          />
        </div>

        <div style={governanceFieldRowStyle}>
          <Button
            type="submit"
            variant="enterprise"
            loading={busy}
            disabled={!canSubmit}
            data-delegated-admin-grant-submit
          >
            {busy ? "Granting…" : "Issue grant"}
          </Button>
          {!tiers.ready ? (
            <span style={noteStyle}>Checking your governance tier…</span>
          ) : !permitted ? (
            <span style={noteStyle} data-delegated-admin-grant-blocked="tier">
              Issuing a delegated-admin grant needs the ORG_ADMIN tier (or
              higher) in this organization.
            </span>
          ) : org.loading ? (
            <span style={noteStyle}>Resolving this workspace&apos;s organization…</span>
          ) : !contextReady ? (
            <span style={noteStyle} data-delegated-admin-grant-blocked="organization">
              This workspace is not bound to a governance organization, so there
              is nothing to delegate administration of.
            </span>
          ) : null}
        </div>

        <GovernanceActionStatus
          busy={busy}
          outcome={outcome}
          busyLabel="Issuing the delegated-admin grant…"
          testAttr="data-delegated-admin-grant-status"
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
