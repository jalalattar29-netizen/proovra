"use client";

/**
 * The operator's side of a customer's contract: stating sold terms, recovering a
 * pending owner, scheduling or withdrawing a termination, and an entitlement
 * exception. Each is one API route, platform admin plus a fresh step-up, and this
 * panel decides nothing: it asks, then reloads what the server says.
 */
import { AppListbox } from "../../../../../components/app-primitives/AppListbox";
import { useState } from "react";
import { ENTITLEMENT_KEYS, identifierLabel } from "@proovra/shared";

import { Card } from "../../../../../components/ui/Card";
import { Button } from "../../../../../components/ui/Button";
import { useToast } from "../../../../../components/ui";
import { useConfirmAction } from "../../../../../components/ui/ConfirmActionModal";
import { StepUpModal, useStepUpAction } from "../../../../../components/identity-security/StepUpModal";
import { apiFetch } from "../../../../../lib/api";
import { toSafeUserError } from "../../../../../lib/feedback/toSafeUserError";

export type CustomerContract = {
  status: string;
  seatCount: number | null;
  storageGb: number | null;
  evidenceRecordsPerMonth: number | null;
  aiOperationsPerMonth: number | null;
  collaborationTeamsMax: number | null;
  collaborationTeamMembersMax: number | null;
  legalHoldEnabled: boolean | null;
  reviewerOperationsEnabled: boolean | null;
  endsAtUtc: string | null;
  region: string | null;
  planVersion: string | null;
  externalContractRef: string | null;
};

type TermKey =
  | "seatCount"
  | "storageGb"
  | "evidenceRecordsPerMonth"
  | "aiOperationsPerMonth"
  | "collaborationTeamsMax"
  | "collaborationTeamMembersMax";

const NUMBER_TERMS: ReadonlyArray<{ key: TermKey; label: string; silent: string }> = [
  { key: "seatCount", label: "Seats", silent: "Admits nobody new until stated" },
  { key: "storageGb", label: "Storage (GB)", silent: "Catalogue default" },
  { key: "evidenceRecordsPerMonth", label: "Evidence records / month", silent: "Catalogue default" },
  { key: "aiOperationsPerMonth", label: "AI operations / month", silent: "Catalogue default" },
  { key: "collaborationTeamsMax", label: "Collaboration Teams", silent: "Catalogue default (1000)" },
  { key: "collaborationTeamMembersMax", label: "Members per Collaboration Team", silent: "Catalogue default (500)" },
];

const labelStyle = { display: "flex", flexDirection: "column", gap: 4, fontSize: 13 } as const;
const gridStyle = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
  gap: 12,
  marginBottom: 12,
} as const;

export function CustomerContractPanel({
  organizationId,
  organizationName,
  teamId,
  contract,
  lifecycleState,
  pendingOwnerInvite,
  workspaces,
  onChanged,
}: {
  organizationId: string;
  organizationName: string;
  teamId: string | null;
  contract: CustomerContract | null;
  lifecycleState: string;
  pendingOwnerInvite: { email: string; expiresAtUtc: string; expired: boolean } | null;
  workspaces: ReadonlyArray<{ id: string; name: string }>;
  onChanged: () => Promise<void>;
}) {
  const { addToast } = useToast();
  const { confirm } = useConfirmAction();
  const stepUp = useStepUpAction({ teamId });
  const [busy, setBusy] = useState(false);
  const [numbers, setNumbers] = useState<Record<TermKey, string>>(() =>
    Object.fromEntries(
      NUMBER_TERMS.map(({ key }) => [key, contract?.[key] === null || contract?.[key] === undefined ? "" : String(contract[key])]),
    ) as Record<TermKey, string>,
  );
  const [legalHold, setLegalHold] = useState(contract?.legalHoldEnabled === true);
  const [reviewerOps, setReviewerOps] = useState(contract?.reviewerOperationsEnabled !== false);
  const [endsAt, setEndsAt] = useState(contract?.endsAtUtc?.slice(0, 10) ?? "");
  const [externalRef, setExternalRef] = useState(contract?.externalContractRef ?? "");
  const [terminationReason, setTerminationReason] = useState("");
  const [terminationDate, setTerminationDate] = useState("");
  const [ownerEmail, setOwnerEmail] = useState("");
  const [reissuedUrl, setReissuedUrl] = useState<string | null>(null);
  const [grantWorkspace, setGrantWorkspace] = useState(workspaces[0]?.id ?? "");
  const [grantKey, setGrantKey] = useState<string>(ENTITLEMENT_KEYS[0]);
  const [grantValue, setGrantValue] = useState("true");

  const run = async (label: string, action: (headers: Record<string, string>) => Promise<unknown>) => {
    if (busy || !teamId) return null;
    setBusy(true);
    try {
      const result = await stepUp.runStepUpAction(async (headers) =>
        action({ "content-type": "application/json", ...(headers ?? {}) }),
      );
      await onChanged();
      addToast(label, "success");
      return result;
    } catch (err) {
      if ((err as { code?: string })?.code === "STEP_UP_CANCEL") {
        addToast("Step-up cancelled. Nothing was changed.", "error");
        return null;
      }
      addToast(toSafeUserError(err, { message: "That did not go through." }).message, "error");
      return null;
    } finally {
      setBusy(false);
    }
  };

  const saveTerms = () => {
    const terms: Record<string, unknown> = {
      legalHoldEnabled: legalHold,
      reviewerOperationsEnabled: reviewerOps,
      endsAtUtc: endsAt ? new Date(`${endsAt}T00:00:00Z`).toISOString() : null,
      externalContractRef: externalRef.trim() || null,
    };
    for (const { key } of NUMBER_TERMS) {
      const raw = numbers[key].trim();
      if (key === "seatCount") {
        if (raw) terms[key] = Number(raw);
      } else {
        terms[key] = raw ? Number(raw) : null;
      }
    }
    return run("Contract terms saved.", (headers) =>
      apiFetch(`/v1/admin/orgs/${encodeURIComponent(organizationId)}/contract`, {
        method: "PATCH",
        headers,
        body: JSON.stringify({ teamId, ...terms }),
      }),
    );
  };

  const reissue = async () => {
    const result = (await run("A new owner invitation was sent.", (headers) =>
      apiFetch(`/v1/admin/orgs/${encodeURIComponent(organizationId)}/owner-invite/reissue`, {
        method: "POST",
        headers,
        body: JSON.stringify({ teamId, ...(ownerEmail.trim() ? { ownerEmail: ownerEmail.trim() } : {}) }),
      }),
    )) as { inviteUrl?: string } | null;
    if (result?.inviteUrl) setReissuedUrl(new URL(result.inviteUrl, window.location.origin).toString());
  };

  const terminate = async () => {
    const reason = terminationReason.trim();
    if (!reason) {
      addToast("State the reason. It stays with operators and is not shown to the customer.", "error");
      return;
    }
    const when = terminationDate ? new Date(`${terminationDate}T00:00:00Z`) : null;
    const ok = await confirm({
      title: `Terminate the contract of ${organizationName}?`,
      description: `The contract grants nothing from now on, and owners and administrators are emailed. ${
        when ? `Closure runs on ${terminationDate}` : "With no date, closure runs in 30 days, the window in which the owner can export the organization's data"
      }, unless a legal hold is in force, in which case it waits. Evidence is never deleted.`,
      confirmLabel: "Schedule termination",
      tone: "danger",
      requireConfirmText: "TERMINATE",
      testId: "customer-terminate",
    });
    if (!ok) return;
    await run("Termination scheduled.", (headers) =>
      apiFetch(`/v1/admin/orgs/${encodeURIComponent(organizationId)}/terminate`, {
        method: "POST",
        headers,
        body: JSON.stringify({ teamId, reason, ...(when ? { effectiveAtUtc: when.toISOString() } : {}) }),
      }),
    );
    setTerminationReason("");
  };

  const withdraw = () =>
    run("Termination withdrawn. Resume the customer to reinstate the contract.", (headers) =>
      apiFetch(`/v1/admin/orgs/${encodeURIComponent(organizationId)}/terminate/cancel`, {
        method: "POST",
        headers,
        body: JSON.stringify({ teamId }),
      }),
    );

  const grantException = () => {
    const isFeature = grantKey.startsWith("FEATURE_");
    return run("Entitlement exception recorded.", (headers) =>
      apiFetch("/v1/packaging/entitlements/grant", {
        method: "POST",
        headers,
        body: JSON.stringify({
          teamId,
          targetWorkspaceId: grantWorkspace,
          key: grantKey,
          kind: isFeature ? "FEATURE" : grantKey.startsWith("QUOTA_") ? "QUOTA" : "LIMIT",
          value: isFeature ? grantValue === "true" : Number(grantValue),
          source: "CUSTOM",
        }),
      }),
    );
  };

  const terminated = contract?.status === "TERMINATED";

  return (
    <Card
      title="Contract terms and lifecycle"
      subtitle="What was sold, stated here rather than in the database. Every change needs a fresh step-up and is written to the audit log."
      data-testid="customer-contract-panel"
    >
      {!contract ? (
        <p className="adm-help">This organization has no contract.</p>
      ) : terminated ? (
        <p className="adm-help" data-testid="customer-contract-final">
          This contract is terminated. That is final, and its terms can no longer change.
        </p>
      ) : (
        <>
          <div style={gridStyle}>
            {NUMBER_TERMS.map(({ key, label, silent }) => (
              <label key={key} style={labelStyle}>
                <span>{label}</span>
                <input
                  className="input"
                  type="number"
                  min={1}
                  value={numbers[key]}
                  onChange={(e) => setNumbers((prev) => ({ ...prev, [key]: e.target.value }))}
                  placeholder={silent}
                  data-testid={`contract-term-${key}`}
                />
              </label>
            ))}
            <label style={labelStyle}>
              <span>Term ends</span>
              <input className="input" type="date" value={endsAt} onChange={(e) => setEndsAt(e.target.value)} data-testid="contract-term-endsAt" />
            </label>
            <label style={labelStyle}>
              <span>Contract reference</span>
              <input className="input" value={externalRef} maxLength={200} onChange={(e) => setExternalRef(e.target.value)} data-testid="contract-term-reference" />
            </label>
          </div>
          <div style={{ display: "flex", gap: 16, flexWrap: "wrap", marginBottom: 12, fontSize: 13 }}>
            <label>
              <input type="checkbox" checked={legalHold} onChange={(e) => setLegalHold(e.target.checked)} data-testid="contract-term-legalHold" />{" "}
              Legal Hold sold
            </label>
            <label>
              <input type="checkbox" checked={reviewerOps} onChange={(e) => setReviewerOps(e.target.checked)} data-testid="contract-term-reviewerOps" />{" "}
              Reviewer operations included
            </label>
          </div>
          <Button size="sm" onClick={() => void saveTerms()} disabled={busy || !teamId} data-testid="contract-terms-save">
            Save contract terms
          </Button>

          {pendingOwnerInvite ? (
            <div style={{ marginTop: 20 }} data-testid="customer-pending-owner">
              <strong style={{ fontSize: 14 }}>Waiting for the owner</strong>
              <p className="adm-help">
                Invited {pendingOwnerInvite.email}.{" "}
                {pendingOwnerInvite.expired ? "That invitation has expired." : "It has not been accepted yet."}{" "}
                Reissuing revokes it and sends a new link.
              </p>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                <input
                  className="input"
                  type="email"
                  value={ownerEmail}
                  onChange={(e) => setOwnerEmail(e.target.value)}
                  placeholder="New address, if the first was wrong"
                  data-testid="customer-reissue-email"
                />
                <Button size="sm" variant="secondary" onClick={() => void reissue()} disabled={busy || !teamId} data-testid="customer-reissue-owner">
                  Reissue owner invitation
                </Button>
              </div>
              {reissuedUrl ? (
                <p className="adm-help adm-mono" data-testid="customer-reissued-url">{reissuedUrl}</p>
              ) : null}
            </div>
          ) : null}

          <div style={{ marginTop: 20 }}>
            <strong style={{ fontSize: 14 }}>Termination</strong>
            {lifecycleState === "TERMINATING" ? (
              <div style={{ marginTop: 8 }}>
                <p className="adm-help">A termination is scheduled, and the contract grants nothing while it stands.</p>
                <Button size="sm" variant="secondary" onClick={() => void withdraw()} disabled={busy || !teamId} data-testid="customer-terminate-cancel">
                  Withdraw termination
                </Button>
              </div>
            ) : (
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", marginTop: 8 }}>
                <input
                  className="input"
                  value={terminationReason}
                  maxLength={400}
                  onChange={(e) => setTerminationReason(e.target.value)}
                  placeholder="Reason (operators only)"
                  data-testid="customer-terminate-reason"
                />
                <input className="input" type="date" value={terminationDate} onChange={(e) => setTerminationDate(e.target.value)} aria-label="Effective date" data-testid="customer-terminate-date" />
                <Button size="sm" variant="destructive" onClick={() => void terminate()} disabled={busy || !teamId} data-testid="customer-terminate">
                  Schedule termination
                </Button>
              </div>
            )}
          </div>

          {workspaces.length > 0 ? (
            <div style={{ marginTop: 20 }}>
              <strong style={{ fontSize: 14 }}>Entitlement exception</strong>
              <p className="adm-help">
                What the contract sold is active with no action here. This records an exception to it for one workspace.
              </p>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                <AppListbox
                  value={grantWorkspace}
                  options={[
                    ...workspaces.map((w) => ({ value: w.id, label: w.name })),
                  ]}
                  onChange={(next) => setGrantWorkspace(next)}
                  ariaLabel={"Workspace"}
                  triggerProps={{ "data-testid": "customer-grant-workspace" }}
                />
                <AppListbox
                  value={grantKey}
                  options={[
                    ...ENTITLEMENT_KEYS.map((k) => ({ value: k, label: identifierLabel(k) })),
                  ]}
                  onChange={(next) => setGrantKey(next)}
                  ariaLabel={"Entitlement"}
                  triggerProps={{ "data-testid": "customer-grant-key" }}
                />
                <input className="input" value={grantValue} onChange={(e) => setGrantValue(e.target.value)} aria-label="Value" data-testid="customer-grant-value" />
                <Button size="sm" variant="secondary" onClick={() => void grantException()} disabled={busy || !teamId} data-testid="customer-grant-submit">
                  Record exception
                </Button>
              </div>
            </div>
          ) : null}
        </>
      )}
      <StepUpModal control={stepUp} />
    </Card>
  );
}
