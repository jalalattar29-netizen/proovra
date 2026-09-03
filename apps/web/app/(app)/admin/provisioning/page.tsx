"use client";

/**
 * Phase 2 — Platform-admin "Provision Enterprise Customer" UI.
 *
 * The end-to-end activation surface for an enterprise customer. An
 * operator activates a customer entirely from this page — NO manual DB
 * edits. It drives the two already-built, already-tested keystone
 * endpoints:
 *
 *   POST  /v1/admin/enterprise/provision  — create a new enterprise
 *           customer. Two success shapes:
 *             * provisioned:true   → owner already had an account, so an
 *               enterprise workspace was created and they can sign in.
 *             * pendingOwner:true  → owner was invited; the admin copies
 *               the invite URL, the owner accepts, then the admin returns
 *               here and grants the plan on the resulting org.
 *   PATCH /v1/admin/orgs/:id/plan          — grant ENTERPRISE to an
 *           EXISTING org (the "second step" after a pending-owner accepts,
 *           or any pre-existing org that needs the plan).
 *
 * Hard rules:
 *   * Reuses the EXISTING step-up flow (`useStepUpAction` + `StepUpModal`)
 *     — the step-up challenge header is injected by the hook's retry, not
 *     by this page. No parallel step-up implementation.
 *   * `teamId` is the ADMIN's own active workspace id (the scope the
 *     step-up challenge is minted against), read from platform-context.
 *   * Errors flow through `toSafeUserError` / `notifyApiError` — the only
 *     sanctioned error-display path. No raw `error.message` passthrough.
 *   * Gated to platform-admin: `/admin/*` inherits the `platform.admin`
 *     PageRouteGate from admin/layout.tsx; this page adds its own
 *     `platform.provisioning` gate belt-and-braces. Backend RBAC
 *     (requirePlatformAdmin) remains the authoritative boundary.
 */

import { useCallback, useState, useRef } from "react";

import { apiFetch } from "../../../../lib/api";
import { useToast } from "../../../../components/ui";
import { notifyApiError } from "../../../../lib/feedback/notify";
import { toSafeUserError } from "../../../../lib/feedback/toSafeUserError";
import {
  useActiveWorkspaceId,
  useTenantGuard,
} from "../../../../lib/platform-context";
import {
  StepUpModal,
  useStepUpAction,
} from "../../../../components/identity-security/StepUpModal";
import { PageRouteGate } from "../../../../components/navigation/PageRouteGate";
import { useConfirmAction } from "../../../../components/ui/ConfirmActionModal";
import {
  PageShell,
  PageHeader,
  PageSection,
} from "../../../../components/ui/PageShell";
import { Card } from "../../../../components/ui/Card";
import { Button } from "../../../../components/ui/Button";
import { Badge } from "../../../../components/ui/Badge";
import { InvitationGovernanceSection } from "./_sections/InvitationGovernanceSection";

// ---------------------------------------------------------------------------
// Response shapes (match services/api/src/services/enterprise-provisioning.service.ts)
// ---------------------------------------------------------------------------

type ProvisionProvisionedResult = {
  organizationId: string;
  workspaceId: string;
  ownerUserId: string;
  provisioned: true;
};

type ProvisionPendingResult = {
  organizationId: string;
  ownerInviteToken: string;
  inviteUrl: string;
  /** Macro-Wave A2 — durable email-delivery state of the owner invite
   *  (safe projection: never a token/URL). */
  ownerInviteDelivery?: {
    deliveryId: string;
    status: "PENDING" | "SENT" | "FAILED" | "CANCELLED";
    attempts: number;
    lastError: string | null;
  } | null;
  provisioned: false;
  pendingOwner: true;
};

type ProvisionResult = ProvisionProvisionedResult | ProvisionPendingResult;

type GrantPlanResult = {
  organizationId: string;
  plan: string;
  seats: number;
  workspacesUpdated: number;
};

function isProvisioned(r: ProvisionResult): r is ProvisionProvisionedResult {
  return r.provisioned === true;
}

// Build the absolute invite URL from the relative path the API returns
// (the canonical `/org-invites/{token}/accept` accept route), so the
// operator can copy a link that works when pasted straight to the customer.
function absoluteInviteUrl(relative: string): string {
  if (typeof window === "undefined") return relative;
  try {
    return new URL(relative, window.location.origin).toString();
  } catch {
    return relative;
  }
}

// ---------------------------------------------------------------------------
// Page shell — platform-admin gated.
// ---------------------------------------------------------------------------

export default function AdminProvisioningPage() {
  return (
    <PageRouteGate routeId="platform.provisioning">
      <AdminProvisioningInner />
    </PageRouteGate>
  );
}

function AdminProvisioningInner() {
  // Phase 7C — Platform Admin provisions enterprise customers from their
  // OWN context (Personal Space is fine). `useActiveWorkspaceId` returns the
  // active workspace id INCLUDING personal, so step-up is minted against a
  // real workspace the admin belongs to. The product model has no separate
  // admin-only tenant, so we never ask the operator to switch into one.
  const teamId = useActiveWorkspaceId();

  // PHASE 12B — the provisioning TARGET flows from the server's own result into
  // the downstream panels, so the operator never has to copy an organization id
  // by hand to finish the journey (grant the plan, govern the invitations).
  const [targetOrganizationId, setTargetOrganizationId] = useState("");

  return (
    <PageShell
      data-testid="admin-provisioning"
      header={
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <PageHeader
            eyebrow="Platform admin"
            title="Provision enterprise customer"
            subtitle="Activate an enterprise customer end-to-end — no manual database edits. Create the organization and its enterprise workspace (or invite the owner), then grant the ENTERPRISE plan. Every action requires a fresh step-up approval and is written to the platform audit log."
          />
        </div>
      }
    >
      {!teamId ? (
        <Card variant="summary" padding="comfortable">
          <p style={mutedStyle} data-testid="admin-provisioning-loading">
            Preparing your platform-admin context…
          </p>
        </Card>
      ) : (
        <>
          <PageSection
            title="Provision new enterprise customer"
            description="Stand up a brand-new organization and its enterprise workspace, or invite an owner who doesn't have an account yet."
          >
            <ProvisionPanel
              teamId={teamId}
              onOrganizationProvisioned={setTargetOrganizationId}
            />
          </PageSection>

          <PageSection
            title="Grant enterprise to an existing organization"
            description="Apply the ENTERPRISE plan to every workspace in an organization that already exists."
          >
            <GrantPlanPanel
              teamId={teamId}
              organizationId={targetOrganizationId}
              onOrganizationIdChange={setTargetOrganizationId}
            />
          </PageSection>

          <PageSection
            title="Invitations for this organization"
            description="Durable delivery state for every pending invitation, with resend (which rotates the link) and revoke."
          >
            <InvitationGovernanceSection
              organizationId={targetOrganizationId}
              onOrganizationIdChange={setTargetOrganizationId}
            />
          </PageSection>

          <PageSection
            title="Recent provisioning events"
            description="Every provision and plan grant is written to the platform audit log."
          >
            <RecentEventsCard />
          </PageSection>
        </>
      )}
    </PageShell>
  );
}

// ---------------------------------------------------------------------------
// Premium local styles — the provisioning console's own presentation layer.
// (No product logic; the identity ui-tokens were the older, denser look.)
// ---------------------------------------------------------------------------

const labelStyle = {
  display: "flex",
  flexDirection: "column",
  gap: 6,
  fontSize: 13,
  fontWeight: 600,
  color: "var(--ink-primary, #0f172a)",
} as const;

const inputStyle = {
  padding: "10px 12px",
  border: "1px solid var(--border-default, rgba(15,23,42,0.14))",
  borderRadius: 10,
  fontSize: 14,
  fontWeight: 400,
  background: "var(--surface-card, #ffffff)",
  color: "var(--ink-primary, #0f172a)",
  width: "100%",
  outline: "none",
} as const;

const mutedStyle = {
  fontSize: 12.5,
  lineHeight: 1.55,
  color: "var(--ink-secondary, #475569)",
} as const;

const monoStyle = {
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
  fontSize: 12,
  color: "var(--ink-primary, #0f172a)",
} as const;

const errorBoxStyle = {
  marginTop: 14,
  padding: "12px 14px",
  background: "var(--status-risk-bg, #fef2f2)",
  color: "var(--status-risk-fg, #991b1b)",
  border: "1px solid var(--status-risk-border, #fecaca)",
  borderRadius: 10,
  fontSize: 13,
  lineHeight: 1.5,
} as const;

const successBoxStyle = {
  marginTop: 14,
  padding: "12px 14px",
  background: "var(--status-verified-bg, #ecfdf5)",
  color: "var(--status-verified-fg, #065f46)",
  border: "1px solid var(--status-verified-border, #a7f3d0)",
  borderRadius: 10,
  fontSize: 13,
  lineHeight: 1.55,
} as const;

const fieldGridStyle = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))",
  gap: 16,
  maxWidth: 760,
} as const;

// ---------------------------------------------------------------------------
// Section 3 — Recent provisioning events (honest audit-log link).
//
// No dedicated provisioning-events read endpoint exists that this page may
// call without adding data-fetching, so we point the operator at the
// platform audit log — where every provision + plan grant is recorded —
// rather than fabricate an events list.
// ---------------------------------------------------------------------------

function RecentEventsCard() {
  return (
    <Card variant="summary" padding="comfortable" data-section="recent-events">
      <div
        style={{
          display: "flex",
          alignItems: "flex-start",
          justifyContent: "space-between",
          gap: 16,
          flexWrap: "wrap",
        }}
      >
        <div style={{ minWidth: 0 }}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              marginBottom: 6,
            }}
          >
            <strong style={{ fontSize: 14, color: "var(--ink-primary, #0f172a)" }}>
              Recorded in the platform audit log
            </strong>
            <Badge tone="governance" subtle>
              Tamper-evident
            </Badge>
          </div>
          <p style={{ ...mutedStyle, margin: 0, maxWidth: 560 }}>
            Each enterprise provision and plan grant is written to the platform
            audit log with the operator, timestamp and outcome. Open the audit
            log to review recent provisioning activity.
          </p>
        </div>
        <a
          href="/admin/audit"
          style={{ textDecoration: "none", flexShrink: 0 }}
          data-testid="recent-events-audit-link"
        >
          <Button variant="secondary">Open audit log</Button>
        </a>
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Panel 1 — Provision a NEW enterprise customer.
// ---------------------------------------------------------------------------

function ProvisionPanel({
  teamId,
  onOrganizationProvisioned,
}: {
  teamId: string;
  onOrganizationProvisioned: (organizationId: string) => void;
}) {
  const { addToast } = useToast();
  const { confirm } = useConfirmAction();
  const stepUp = useStepUpAction({ teamId });
  const { stamp, isStale } = useTenantGuard();

  const [organizationName, setOrganizationName] = useState("");
  const [ownerEmail, setOwnerEmail] = useState("");
  const [seats, setSeats] = useState("");
  const [workspaceName, setWorkspaceName] = useState("");
  const [busy, setBusy] = useState(false);
  // Stable per-intent idempotency key (12B 2B) — survives retries of the same
  // submission; reset when the inputs change.
  const idempotencyRef = useRef<{ sig: string; key: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ProvisionResult | null>(null);
  const [copied, setCopied] = useState(false);

  const submit = useCallback(async () => {
    setError(null);
    setResult(null);
    setCopied(false);

    const name = organizationName.trim();
    const email = ownerEmail.trim();
    if (!name) {
      setError("Company / organization name is required.");
      return;
    }
    if (!email) {
      setError("Owner email is required.");
      return;
    }

    // Optional numeric seats — only send when the operator typed a value.
    let seatsValue: number | undefined;
    if (seats.trim().length > 0) {
      const parsed = Number(seats.trim());
      if (!Number.isInteger(parsed) || parsed < 1) {
        setError("Seats must be a whole number of 1 or more.");
        return;
      }
      seatsValue = parsed;
    }

    const workspace = workspaceName.trim();

    // PHASE 12B WAVE 2B — the API REQUIRES idempotencyKey (min 8): the same
    // submission (identical inputs) retries with the SAME key so a retry can
    // never provision a duplicate Organization/Workspace/owner/seat set; any
    // input change mints a fresh key (a new intent).
    const intentSig = JSON.stringify({ teamId, name, email, seatsValue, workspace });
    if (!idempotencyRef.current || idempotencyRef.current.sig !== intentSig) {
      idempotencyRef.current = { sig: intentSig, key: crypto.randomUUID() };
    }
    const idempotencyKey = idempotencyRef.current.key;

    /**
     * Creates a customer: an Organization, its enterprise workspace, an owner
     * seat and an invitation email. That is a business commitment made in the
     * customer's name, so the operator confirms exactly what will exist
     * before the step-up challenge starts.
     */
    const ok = await confirm({
      title: "Provision this enterprise customer?",
      description: `Creates the organization "${name}" on the ENTERPRISE plan${
        seatsValue !== undefined ? ` with ${seatsValue} seat${seatsValue === 1 ? "" : "s"}` : ""
      }${workspace ? `, with a workspace named "${workspace}"` : ""}, and invites ${email} as its owner by email. The invitation is external and cannot be recalled; a duplicate submission with the same details is replayed, not repeated.`,
      confirmLabel: "Provision customer",
      tone: "warning",
      testId: "provisioning-provision",
    });
    if (!ok) return;

    setBusy(true);
    const captured = stamp();
    try {
      const res = (await stepUp.runStepUpAction(async (headers) => {
        return (await apiFetch("/v1/admin/enterprise/provision", {
          method: "POST",
          headers: { "content-type": "application/json", ...(headers ?? {}) },
          body: JSON.stringify({
            idempotencyKey,
            teamId,
            organizationName: name,
            ownerEmail: email,
            ...(seatsValue !== undefined ? { seats: seatsValue } : {}),
            ...(workspace ? { workspaceName: workspace } : {}),
          }),
        })) as ProvisionResult;
      })) as ProvisionResult;
      if (isStale(captured)) return;

      setResult(res);
      if (res.organizationId) onOrganizationProvisioned(res.organizationId);
      addToast(
        isProvisioned(res)
          ? "Enterprise workspace created."
          : "Owner invited — the invitation email is on its way.",
        "success",
      );
    } catch (err) {
      if (isStale(captured)) return;
      const code = (err as { code?: string })?.code;
      if (code === "STEP_UP_CANCEL") {
        setError("Step-up cancelled — nothing was provisioned.");
      } else {
        notifyApiError(addToast, err, {
          message: "We couldn't provision this customer.",
        });
        setError(
          toSafeUserError(err, {
            message: "We couldn't provision this customer.",
          }).message,
        );
      }
    } finally {
      setBusy(false);
    }
  }, [
    teamId,
    organizationName,
    ownerEmail,
    seats,
    workspaceName,
    stepUp,
    addToast,
    confirm,
    onOrganizationProvisioned,
    stamp,
    isStale,
  ]);

  const copyInvite = useCallback(async (url: string) => {
    try {
      if (typeof navigator !== "undefined" && navigator.clipboard) {
        await navigator.clipboard.writeText(url);
        setCopied(true);
      }
    } catch {
      setCopied(false);
    }
  }, []);

  return (
    <Card
      variant="summary"
      padding="comfortable"
      data-section="provision-new-customer"
    >
      <p style={{ ...mutedStyle, marginTop: 0, marginBottom: 18, maxWidth: 640 }}>
        Creates the organization. If the owner already has an account, an
        enterprise workspace is created and they can sign in immediately. If
        not, the owner is invited — copy the invite URL, and once they accept,
        return here to grant the plan on the new organization.
      </p>

      <div style={fieldGridStyle}>
        <label style={labelStyle}>
          <span>Company / organization name</span>
          <input
            style={inputStyle}
            value={organizationName}
            onChange={(e) => setOrganizationName(e.target.value)}
            placeholder="Acme Corporation"
            data-testid="provision-org-name"
          />
        </label>

        <label style={labelStyle}>
          <span>Owner email</span>
          <input
            style={inputStyle}
            type="email"
            value={ownerEmail}
            onChange={(e) => setOwnerEmail(e.target.value)}
            placeholder="owner@acme.com"
            data-testid="provision-owner-email"
          />
        </label>

        <label style={labelStyle}>
          <span>Seats (optional)</span>
          <input
            style={inputStyle}
            type="number"
            min={1}
            value={seats}
            onChange={(e) => setSeats(e.target.value)}
            placeholder="e.g. 25"
            data-testid="provision-seats"
          />
        </label>

        <label style={labelStyle}>
          <span>Workspace name (optional)</span>
          <input
            style={inputStyle}
            value={workspaceName}
            onChange={(e) => setWorkspaceName(e.target.value)}
            placeholder="Defaults to the organization name"
            data-testid="provision-workspace-name"
          />
        </label>
      </div>

      <div style={{ display: "flex", gap: 8, marginTop: 18 }}>
        <Button
          variant="primary"
          disabled={busy}
          loading={busy}
          onClick={submit}
          data-testid="provision-submit"
        >
          {busy ? "Provisioning…" : "Provision customer"}
        </Button>
      </div>

      {error ? (
        <div style={errorBoxStyle} data-testid="provision-error">
          {error}
        </div>
      ) : null}

      {result ? (
        isProvisioned(result) ? (
          <div style={successBoxStyle} data-testid="provision-success-created">
            <strong>Enterprise workspace created.</strong> The owner{" "}
            <span style={monoStyle}>{ownerEmail.trim()}</span> can sign in now.
            <div style={{ marginTop: 8, ...mutedStyle }}>
              Organization id:{" "}
              <span style={monoStyle}>{result.organizationId}</span>
              <br />
              Workspace id: <span style={monoStyle}>{result.workspaceId}</span>
              <br />
              Owner user id:{" "}
              <span style={monoStyle}>{result.ownerUserId}</span>
            </div>
          </div>
        ) : (
          <div style={successBoxStyle} data-testid="provision-success-pending">
            <strong>Owner invited.</strong>{" "}
            {result.ownerInviteDelivery?.status === "SENT"
              ? "The invitation email was sent to the owner automatically."
              : result.ownerInviteDelivery?.status === "FAILED"
                ? "The invitation email could not be sent — share the invite URL below with the owner directly."
                : "The invitation email is queued for delivery — you can also share the invite URL below directly."}{" "}
            After they accept, come back and use “Grant enterprise to an
            existing organization” below with organization id{" "}
            <span style={monoStyle}>{result.organizationId}</span> to activate
            the plan.
            {result.ownerInviteDelivery ? (
              <div
                data-testid="provision-invite-delivery"
                data-delivery-status={result.ownerInviteDelivery.status}
                style={{ marginTop: 6, ...mutedStyle }}
              >
                Email delivery: {result.ownerInviteDelivery.status.toLowerCase()}
              </div>
            ) : null}
            <div
              style={{
                marginTop: 10,
                display: "flex",
                gap: 8,
                alignItems: "center",
                flexWrap: "wrap",
              }}
            >
              <input
                readOnly
                style={{ ...inputStyle, maxWidth: 480 }}
                value={absoluteInviteUrl(result.inviteUrl)}
                data-testid="provision-invite-url"
                onFocus={(e) => e.currentTarget.select()}
              />
              <Button
                variant="ghost"
                onClick={() =>
                  copyInvite(absoluteInviteUrl(result.inviteUrl))
                }
                data-testid="provision-invite-copy"
              >
                {copied ? "Copied" : "Copy invite URL"}
              </Button>
            </div>
          </div>
        )
      ) : null}

      <StepUpModal control={stepUp} />
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Panel 2 — Grant ENTERPRISE to an EXISTING organization.
// ---------------------------------------------------------------------------

function GrantPlanPanel({
  teamId,
  organizationId,
  onOrganizationIdChange,
}: {
  teamId: string;
  organizationId: string;
  onOrganizationIdChange: (next: string) => void;
}) {
  const { addToast } = useToast();
  const { confirm } = useConfirmAction();
  const stepUp = useStepUpAction({ teamId });
  const { stamp, isStale } = useTenantGuard();

  // The target id is shared with the provisioning + invitation panels so the
  // journey never depends on the operator copying it by hand.
  const orgId = organizationId;
  const setOrgId = onOrganizationIdChange;
  const [seats, setSeats] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<GrantPlanResult | null>(null);

  const submit = useCallback(async () => {
    setError(null);
    setResult(null);

    const id = orgId.trim();
    if (!id) {
      setError("Organization id is required.");
      return;
    }

    let seatsValue: number | undefined;
    if (seats.trim().length > 0) {
      const parsed = Number(seats.trim());
      if (!Number.isInteger(parsed) || parsed < 1) {
        setError("Seats must be a whole number of 1 or more.");
        return;
      }
      seatsValue = parsed;
    }

    // A plan grant changes what the customer is billed for and what every
    // workspace in the organization may do. Named before the step-up starts.
    const ok = await confirm({
      title: "Grant the ENTERPRISE plan to this organization?",
      description: `Applies the ENTERPRISE plan${
        seatsValue !== undefined ? ` with ${seatsValue} seat${seatsValue === 1 ? "" : "s"}` : ""
      } to every workspace in organization ${id}. Entitlements change immediately for all of its members and the grant is written to the platform audit log.`,
      confirmLabel: "Grant ENTERPRISE",
      tone: "warning",
      testId: "provisioning-grant-plan",
    });
    if (!ok) return;

    setBusy(true);
    const captured = stamp();
    try {
      const res = (await stepUp.runStepUpAction(async (headers) => {
        return (await apiFetch(
          `/v1/admin/orgs/${encodeURIComponent(id)}/plan`,
          {
            method: "PATCH",
            headers: {
              "content-type": "application/json",
              ...(headers ?? {}),
            },
            body: JSON.stringify({
              teamId,
              plan: "ENTERPRISE",
              ...(seatsValue !== undefined ? { seats: seatsValue } : {}),
            }),
          },
        )) as GrantPlanResult;
      })) as GrantPlanResult;
      if (isStale(captured)) return;

      setResult(res);
      addToast("ENTERPRISE plan granted.", "success");
    } catch (err) {
      if (isStale(captured)) return;
      const code = (err as { code?: string })?.code;
      if (code === "STEP_UP_CANCEL") {
        setError("Step-up cancelled — the plan was not changed.");
      } else {
        notifyApiError(addToast, err, {
          message: "We couldn't grant the plan.",
        });
        setError(
          toSafeUserError(err, {
            message: "We couldn't grant the plan.",
          }).message,
        );
      }
    } finally {
      setBusy(false);
    }
  }, [teamId, orgId, seats, stepUp, addToast, confirm, stamp, isStale]);

  return (
    <Card
      variant="summary"
      padding="comfortable"
      data-section="grant-existing-org"
    >
      <p style={{ ...mutedStyle, marginTop: 0, marginBottom: 18, maxWidth: 640 }}>
        Sets every workspace in the organization to the ENTERPRISE plan. Use
        this after an invited owner accepts, or for any existing organization
        that needs the plan applied.
      </p>

      <div style={fieldGridStyle}>
        <label style={labelStyle}>
          <span>Organization id</span>
          <input
            style={inputStyle}
            value={orgId}
            onChange={(e) => setOrgId(e.target.value)}
            placeholder="00000000-0000-0000-0000-000000000000"
            data-testid="grant-org-id"
          />
        </label>

        <label style={labelStyle}>
          <span>Seats (optional)</span>
          <input
            style={inputStyle}
            type="number"
            min={1}
            value={seats}
            onChange={(e) => setSeats(e.target.value)}
            placeholder="e.g. 25"
            data-testid="grant-seats"
          />
        </label>
      </div>

      <div style={{ display: "flex", gap: 8, marginTop: 18 }}>
        <Button
          variant="primary"
          disabled={busy}
          loading={busy}
          onClick={submit}
          data-testid="grant-submit"
        >
          {busy ? "Granting…" : "Grant ENTERPRISE"}
        </Button>
      </div>

      {error ? (
        <div style={errorBoxStyle} data-testid="grant-error">
          {error}
        </div>
      ) : null}

      {result ? (
        <div style={successBoxStyle} data-testid="grant-success">
          <strong>ENTERPRISE granted.</strong> Updated{" "}
          {result.workspacesUpdated} workspace
          {result.workspacesUpdated === 1 ? "" : "s"} with{" "}
          {result.seats} seat{result.seats === 1 ? "" : "s"}.
          <div style={{ marginTop: 8, ...mutedStyle }}>
            Organization id:{" "}
            <span style={monoStyle}>{result.organizationId}</span>
          </div>
        </div>
      ) : null}

      <StepUpModal control={stepUp} />
    </Card>
  );
}
