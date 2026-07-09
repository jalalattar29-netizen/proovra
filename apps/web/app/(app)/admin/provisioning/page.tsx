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

import { useCallback, useState } from "react";

import { apiFetch } from "../../../../lib/api";
import { useToast } from "../../../../components/ui";
import { notifyApiError } from "../../../../lib/feedback/notify";
import { toSafeUserError } from "../../../../lib/feedback/toSafeUserError";
import { useTeamId } from "../../../../lib/platform-context";
import {
  StepUpModal,
  useStepUpAction,
} from "../../../../components/identity-security/StepUpModal";
import { PageRouteGate } from "../../../../components/navigation/PageRouteGate";
import AdminConsoleNav from "../../../../components/admin/AdminConsoleNav";
import { PageShell, PageHeader } from "../../../../components/ui/PageShell";
import { Card } from "../../../../components/ui/Card";
import { Button } from "../../../../components/ui/Button";
import {
  errorBoxStyle,
  inputStyle,
  mutedStyle,
  monoStyle,
  sectionTitleStyle,
  subtitleStyle,
  successBoxStyle,
  TOKENS,
} from "../identity/ui-tokens";

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
// (`/invite/{token}`), so the operator can copy a link that works when
// pasted straight to the customer.
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
  const teamId = useTeamId();

  return (
    <PageShell
      data-testid="admin-provisioning"
      header={
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <AdminConsoleNav />
          <PageHeader
            eyebrow="Platform admin"
            title="Provision enterprise customer"
            subtitle="Activate an enterprise customer end-to-end — no manual database edits. Create the organization and its enterprise workspace (or invite the owner), then grant the ENTERPRISE plan. Every action requires a fresh step-up approval and is written to the platform audit log."
          />
        </div>
      }
    >
      {!teamId ? (
        <Card variant="admin" padding="comfortable">
          <p style={mutedStyle}>
            Switch to your admin workspace to continue — step-up approvals are
            minted against the workspace you are currently in.
          </p>
        </Card>
      ) : (
        <>
          <ProvisionPanel teamId={teamId} />
          <GrantPlanPanel teamId={teamId} />
        </>
      )}
    </PageShell>
  );
}

// ---------------------------------------------------------------------------
// Panel 1 — Provision a NEW enterprise customer.
// ---------------------------------------------------------------------------

function ProvisionPanel({ teamId }: { teamId: string }) {
  const { addToast } = useToast();
  const stepUp = useStepUpAction({ teamId });

  const [organizationName, setOrganizationName] = useState("");
  const [ownerEmail, setOwnerEmail] = useState("");
  const [seats, setSeats] = useState("");
  const [workspaceName, setWorkspaceName] = useState("");
  const [busy, setBusy] = useState(false);
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

    setBusy(true);
    try {
      const res = (await stepUp.runStepUpAction(async (headers) => {
        return (await apiFetch("/v1/admin/enterprise/provision", {
          method: "POST",
          headers: { "Content-Type": "application/json", ...(headers ?? {}) },
          body: JSON.stringify({
            teamId,
            organizationName: name,
            ownerEmail: email,
            ...(seatsValue !== undefined ? { seats: seatsValue } : {}),
            ...(workspace ? { workspaceName: workspace } : {}),
          }),
        })) as ProvisionResult;
      })) as ProvisionResult;

      setResult(res);
      addToast(
        isProvisioned(res)
          ? "Enterprise workspace created."
          : "Owner invited — copy the invite URL below.",
        "success",
      );
    } catch (err) {
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
      variant="admin"
      padding="comfortable"
      data-section="provision-new-customer"
    >
      <h3 style={sectionTitleStyle}>Provision a new enterprise customer</h3>
      <p style={{ ...subtitleStyle, marginTop: 4, marginBottom: 12 }}>
        Creates the organization. If the owner already has an account, an
        enterprise workspace is created and they can sign in immediately. If
        not, the owner is invited — copy the invite URL, and once they accept,
        return here to grant the plan on the new organization.
      </p>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))",
          gap: 12,
          maxWidth: 720,
        }}
      >
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

      <div style={{ display: "flex", gap: 8, marginTop: 14 }}>
        <Button
          variant="enterprise"
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
            <strong>Owner invited.</strong> Send this invite URL to the owner.
            After they accept, come back and use “Grant enterprise to an
            existing organization” below with organization id{" "}
            <span style={monoStyle}>{result.organizationId}</span> to activate
            the plan.
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

function GrantPlanPanel({ teamId }: { teamId: string }) {
  const { addToast } = useToast();
  const stepUp = useStepUpAction({ teamId });

  const [orgId, setOrgId] = useState("");
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

    setBusy(true);
    try {
      const res = (await stepUp.runStepUpAction(async (headers) => {
        return (await apiFetch(
          `/v1/admin/orgs/${encodeURIComponent(id)}/plan`,
          {
            method: "PATCH",
            headers: {
              "Content-Type": "application/json",
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

      setResult(res);
      addToast("ENTERPRISE plan granted.", "success");
    } catch (err) {
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
  }, [teamId, orgId, seats, stepUp, addToast]);

  return (
    <Card
      variant="admin"
      padding="comfortable"
      data-section="grant-existing-org"
    >
      <h3 style={sectionTitleStyle}>
        Grant enterprise to an existing organization
      </h3>
      <p style={{ ...subtitleStyle, marginTop: 4, marginBottom: 12 }}>
        Sets every workspace in the organization to the ENTERPRISE plan. Use
        this after an invited owner accepts, or for any existing organization
        that needs the plan applied.
      </p>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))",
          gap: 12,
          maxWidth: 720,
        }}
      >
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

      <div style={{ display: "flex", gap: 8, marginTop: 14 }}>
        <Button
          variant="enterprise"
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

const labelStyle = {
  display: "flex",
  flexDirection: "column",
  gap: 4,
  fontSize: 12,
  color: TOKENS.inkMuted,
} as const;
