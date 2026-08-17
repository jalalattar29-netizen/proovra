"use client";

/**
 * PHASE 13 — POST /v1/governance/access-reviews/campaigns.
 *
 * `createCampaign` had exactly one caller (the route) and no worker or cron
 * ever writes `accessReviewCampaign`. The console could OPEN and CLOSE a
 * campaign and decide its items — but the only way to bring a campaign into
 * existence was a REST client, so the empty state was unreachable from the
 * product.
 *
 * Authorisation: SECURITY_OFFICER or COMPLIANCE_OFFICER. Both are
 * cross-cutting tiers — the workspace owner does NOT implicitly hold them, so
 * an owner without an explicit grant correctly sees a disabled control.
 */

import { useCallback, useId, useMemo, useState } from "react";

import {
  ACCESS_REVIEW_CAMPAIGN_KINDS,
  type AccessReviewCampaignKind,
} from "@proovra/shared";

import { apiFetch } from "../../lib/api";
import { Button } from "../ui/Button";
import { Card } from "../ui/Card";
import { EmptyState } from "../ui/EmptyState";
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

type CampaignItem = { subjectUserId: string; grantRef: string };

const MAX_ITEMS = 500;

export function AccessReviewCampaignForm({
  onCreated,
}: {
  onCreated: () => Promise<void> | void;
}) {
  const uid = useId();
  const { busy, outcome, reset, run } = useGovernanceAction();
  const org = useGovernanceOrganization();
  const tiers = useDelegatedTierAccess();
  const roster = useWorkspaceMembers();

  const [name, setName] = useState("");
  const [kind, setKind] = useState<AccessReviewCampaignKind>(
    ACCESS_REVIEW_CAMPAIGN_KINDS[0],
  );
  const [departmentId, setDepartmentId] = useState("");
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const [items, setItems] = useState<ReadonlyArray<CampaignItem>>([]);
  const [subjectDraft, setSubjectDraft] = useState("");
  const [grantRefDraft, setGrantRefDraft] = useState("");
  const [errors, setErrors] = useState<Record<string, string | null>>({});

  const permitted = tiers.hasAnyTier(["SECURITY_OFFICER", "COMPLIANCE_OFFICER"]);
  const canSubmit = permitted && !busy;

  const memberOptions = useMemo(
    () => [
      { value: "", label: roster.members.length ? "Select a member…" : "No members available" },
      ...roster.members.map((m) => ({ value: m.userId, label: memberLabel(m) })),
    ],
    [roster.members],
  );

  const addItem = useCallback(() => {
    const subject = subjectDraft.trim();
    const grantRef = grantRefDraft.trim();
    const next: Record<string, string | null> = {};
    if (!subject) next[`${uid}-subject`] = "Choose the member whose access is being reviewed.";
    if (!grantRef) {
      next[`${uid}-grantref`] = "A grant reference is required, e.g. delegated_admin:<id>.";
    } else if (grantRef.length > 200) {
      next[`${uid}-grantref`] = "The grant reference must be 200 characters or fewer.";
    }
    if (items.length >= MAX_ITEMS) {
      next[`${uid}-grantref`] = `A campaign carries at most ${MAX_ITEMS} items.`;
    }
    if (Object.keys(next).length > 0) {
      setErrors((prev) => ({ ...prev, ...next }));
      return;
    }
    setErrors((prev) => ({ ...prev, [`${uid}-subject`]: null, [`${uid}-grantref`]: null }));
    setItems((prev) => [...prev, { subjectUserId: subject, grantRef }]);
    setSubjectDraft("");
    setGrantRefDraft("");
    reset();
  }, [subjectDraft, grantRefDraft, items.length, uid, reset]);

  const removeItem = useCallback((index: number) => {
    setItems((prev) => prev.filter((_, i) => i !== index));
  }, []);

  const validate = useCallback((): Record<string, string | null> | null => {
    const next: Record<string, string | null> = {};
    const trimmedName = name.trim();
    if (!trimmedName) {
      next[`${uid}-name`] = "A campaign name is required.";
    } else if (trimmedName.length > 200) {
      next[`${uid}-name`] = "The campaign name must be 200 characters or fewer.";
    }
    if (!(ACCESS_REVIEW_CAMPAIGN_KINDS as ReadonlyArray<string>).includes(kind)) {
      next[`${uid}-kind`] = "Choose a campaign kind.";
    }
    const startIso = toIsoInstant(start);
    const endIso = toIsoInstant(end);
    if (!startIso) next[`${uid}-start`] = "A scheduled start is required.";
    if (!endIso) {
      next[`${uid}-end`] = "A scheduled end is required.";
    } else if (startIso && new Date(endIso).getTime() <= new Date(startIso).getTime()) {
      next[`${uid}-end`] = "The scheduled end must be after the scheduled start.";
    }
    return Object.keys(next).length > 0 ? next : null;
  }, [name, kind, start, end, uid]);

  const submit = useCallback(
    async (event: React.FormEvent) => {
      event.preventDefault();
      if (!canSubmit) return;
      const invalid = validate();
      setErrors((prev) => ({ ...prev, ...(invalid ?? {}) }));
      if (invalid) return;
      const startIso = toIsoInstant(start);
      const endIso = toIsoInstant(end);
      if (!startIso || !endIso) return;
      await run(
        async () => {
          await apiFetch("/v1/governance/access-reviews/campaigns", {
            method: "POST",
            body: JSON.stringify({
              kind,
              name: name.trim(),
              organizationId: org.organizationId,
              departmentId: departmentId ? departmentId : null,
              workspaceId: null,
              scheduledStartUtc: startIso,
              scheduledEndUtc: endIso,
              items,
            }),
          });
          setName("");
          setDepartmentId("");
          setStart("");
          setEnd("");
          setItems([]);
          await onCreated();
        },
        {
          success:
            "Campaign created as DRAFT. Open it from the table below to start collecting decisions.",
          fallback: "Could not open that access-review campaign.",
        },
      );
    },
    [
      canSubmit,
      validate,
      start,
      end,
      run,
      kind,
      name,
      org.organizationId,
      departmentId,
      items,
      onCreated,
    ],
  );

  return (
    <Card
      variant="admin"
      title="Open an access-review campaign"
      subtitle="A campaign collects the grants to be certified, and the reviewer decisions taken on them. It is created as DRAFT."
      data-access-review-campaign-form
    >
      <form onSubmit={submit} noValidate>
        <div style={governanceFieldGridStyle}>
          <GovernanceTextField
            id={`${uid}-name`}
            label="Campaign name"
            value={name}
            onChange={(v) => {
              setName(v);
              reset();
            }}
            error={errors[`${uid}-name`]}
            hint="How reviewers will recognise this campaign, e.g. “Q3 delegated-admin certification”."
            maxLength={200}
            disabled={!permitted || busy}
            testAttr="data-access-review-campaign-name"
          />
          <GovernanceSelectField
            id={`${uid}-kind`}
            label="Campaign kind"
            value={kind}
            onChange={(v) => {
              setKind(v as AccessReviewCampaignKind);
              reset();
            }}
            options={ACCESS_REVIEW_CAMPAIGN_KINDS.map((k) => ({ value: k, label: k }))}
            error={errors[`${uid}-kind`]}
            disabled={!permitted || busy}
            testAttr="data-access-review-campaign-kind"
          />
          <GovernanceTextField
            id={`${uid}-start`}
            label="Scheduled start"
            type="datetime-local"
            value={start}
            onChange={(v) => {
              setStart(v);
              reset();
            }}
            error={errors[`${uid}-start`]}
            disabled={!permitted || busy}
            testAttr="data-access-review-campaign-start"
          />
          <GovernanceTextField
            id={`${uid}-end`}
            label="Scheduled end"
            type="datetime-local"
            value={end}
            onChange={(v) => {
              setEnd(v);
              reset();
            }}
            error={errors[`${uid}-end`]}
            disabled={!permitted || busy}
            testAttr="data-access-review-campaign-end"
          />
          <GovernanceSelectField
            id={`${uid}-department`}
            label="Department (optional)"
            value={departmentId}
            onChange={(v) => {
              setDepartmentId(v);
              reset();
            }}
            options={[
              { value: "", label: "Whole organization" },
              ...org.departments.map((d) => ({ value: d.id, label: d.name })),
            ]}
            hint="Narrows the campaign to one department. The organization itself is derived server-side."
            disabled={!permitted || busy}
            testAttr="data-access-review-campaign-department"
          />
        </div>

        {/* Items — the grants this campaign certifies. Optional at creation:
            a DRAFT campaign with no items is legitimate, and the server caps
            the list at 500. */}
        <fieldset style={fieldsetStyle} disabled={!permitted || busy}>
          <legend style={legendStyle}>Grants to review ({items.length})</legend>
          <div style={governanceFieldGridStyle}>
            <GovernanceSelectField
              id={`${uid}-subject`}
              label="Subject"
              value={subjectDraft}
              onChange={(v) => setSubjectDraft(v)}
              options={memberOptions}
              error={errors[`${uid}-subject`]}
              hint={
                roster.failed
                  ? "The member roster could not be read in this workspace."
                  : "The member whose access is being certified."
              }
              testAttr="data-access-review-item-subject"
            />
            <GovernanceTextField
              id={`${uid}-grantref`}
              label="Grant reference"
              value={grantRefDraft}
              onChange={(v) => setGrantRefDraft(v)}
              error={errors[`${uid}-grantref`]}
              hint="Bounded reference to the grant under review, e.g. delegated_admin:<id>."
              placeholder="delegated_admin:…"
              maxLength={200}
              testAttr="data-access-review-item-grantref"
            />
          </div>
          <div style={governanceFieldRowStyle}>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={addItem}
              data-access-review-item-add
            >
              Add grant to campaign
            </Button>
          </div>
          {items.length === 0 ? (
            <div data-access-review-items-empty>
              <EmptyState
                compact
                framed
                title="No grants attached yet"
                purpose="A campaign can be created empty and have its grants attached before it is opened."
              />
            </div>
          ) : (
            <ul style={itemListStyle} data-access-review-items-list>
              {items.map((item, index) => (
                <li key={`${item.subjectUserId}-${item.grantRef}-${index}`} style={itemRowStyle}>
                  <code style={{ fontSize: 12 }}>
                    {item.subjectUserId.slice(0, 8)}… · {item.grantRef}
                  </code>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => removeItem(index)}
                    data-access-review-item-remove={String(index)}
                  >
                    Remove
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </fieldset>

        <div style={governanceFieldRowStyle}>
          <Button
            type="submit"
            variant="enterprise"
            loading={busy}
            disabled={!canSubmit}
            data-access-review-campaign-submit
          >
            {busy ? "Creating…" : "Create campaign"}
          </Button>
          {!tiers.ready ? (
            <span style={noteStyle}>Checking your governance tier…</span>
          ) : !permitted ? (
            <span style={noteStyle} data-access-review-campaign-blocked="tier">
              Opening an access-review campaign needs the SECURITY_OFFICER or
              COMPLIANCE_OFFICER delegated-admin tier. These are cross-cutting
              tiers — being the workspace owner does not grant them.
            </span>
          ) : null}
        </div>

        <GovernanceActionStatus
          busy={busy}
          outcome={outcome}
          busyLabel="Creating the access-review campaign…"
          testAttr="data-access-review-campaign-status"
        />
      </form>
    </Card>
  );
}

const fieldsetStyle: React.CSSProperties = {
  marginTop: 16,
  padding: 12,
  border: "1px solid #e2e8f0",
  borderRadius: 10,
};
const legendStyle: React.CSSProperties = {
  fontSize: 12,
  fontWeight: 700,
  color: "#334155",
  padding: "0 6px",
};
const itemListStyle: React.CSSProperties = {
  listStyle: "none",
  margin: "10px 0 0",
  padding: 0,
};
const itemRowStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 8,
  padding: "6px 0",
  borderBottom: "1px solid #f1f5f9",
};
const noteStyle: React.CSSProperties = {
  fontSize: 12,
  color: "#64748b",
  maxWidth: 520,
};
