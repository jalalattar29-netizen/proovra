"use client";

/**
 * Platform Control Center — Customers / Organizations detail.
 *
 * READ-ONLY platform-admin detail surface. Inherits the `platform.admin`
 * PageRouteGate from admin/layout.tsx (no conflicting gate added here).
 * Backed by /v1/admin/customers/:id. Every value is a live record or
 * an honest null → "—" / "Not measured" / "Not connected". No secrets, no
 * IdP key material, no SCIM token. No app-hero/cc-page/btn- classes.
 */

import { use, useCallback, useEffect, useState } from "react";
import Link from "next/link";

import { PageShell, PageHeader, DataTable, useToast } from "../../../../../components/ui";
import type { DataTableColumn } from "../../../../../components/ui";
import { Card } from "../../../../../components/ui/Card";
import { Badge } from "../../../../../components/ui/Badge";
import { Button, buttonSurfaceStyle } from "../../../../../components/ui/Button";
import { useConfirmAction } from "../../../../../components/ui/ConfirmActionModal";
import type { BadgeTone } from "../../../../../components/ui/Badge";
import {
  StepUpModal,
  useStepUpAction,
} from "../../../../../components/identity-security/StepUpModal";
import { useActiveWorkspaceId } from "../../../../../lib/platform-context";
import { apiFetch } from "../../../../../lib/api";
import { toSafeUserError } from "../../../../../lib/feedback/toSafeUserError";
import { ResultCount } from "../../../../../components/ui/ResultCount";
import { formatUserDateTime } from "../../../../../lib/date";
import { useAdminEntityCrumb } from "../../../../../components/admin/AdminEntityCrumb";

type OnboardingHealth = "HEALTHY" | "ATTENTION" | "BLOCKED" | "UNKNOWN";

type LifecycleStage =
  | "LEAD"
  | "DEMO_REQUESTED"
  | "CONTACT_SALES"
  | "PROVISIONED"
  | "ONBOARDING"
  | "ACTIVE"
  | "AT_RISK"
  | "SUSPENDED"
  | "CANCELLED"
  | "ARCHIVED"
  | "UNKNOWN";

type DetailWorkspace = {
  id: string;
  name: string;
  memberCount: number;
  caseCount: number | null;
  evidenceCount: number;
  reportCount: number | null;
  packageCount: number | null;
  health: OnboardingHealth;
};

type Detail = {
  lifecycle: {
    stage: LifecycleStage;
    reasons: string[];
  };
  customerSuccess: {
    firstEvidenceAt: string | null;
    firstReportAt: string | null;
    firstPackageAt: string | null;
    lastActivityAt: string | null;
    lastLoginAt: string | null;
    ssoConfigured: boolean;
    scimConfigured: boolean;
    domainVerified: boolean;
    openIncidents: number | null;
    billingIssues: { pastDueWorkspaces: number; failedPayments: number };
    riskStatus: LifecycleStage | null;
    onboardingCompletion: null;
    accountManager: null;
    supportContact: null;
    renewalDate: null;
    supportTickets: null;
    notModelled: string[];
  };
  workspaces: DetailWorkspace[];
  /**
   * ADM-015 — the canonical enterprise contract, from resolveEnterpriseContract.
   * Null when this customer holds none. `legacyDerived` means the row does NOT
   * exist and the projection was synthesised by the compatibility adapter.
   */
  enterpriseContract: {
    status: string;
    activationState: string | null;
    effectiveAtUtc: string | null;
    endsAtUtc: string | null;
    seatCount: number | null;
    storageGb: number | null;
    evidenceRecordsPerMonth: number | null;
    aiOperationsPerMonth: number | null;
    region: string | null;
    planVersion: string | null;
    billingCustomerRef: string | null;
    billingSubscriptionRef: string | null;
    contractOwnerUserId: string | null;
    legacyDerived: boolean;
  } | null;
  overview: {
    id: string;
    name: string;
    legalName: string | null;
    status: string;
    plan: string | null;
    enterprise: boolean;
    createdAt: string;
    onboardingStatus: OnboardingHealth;
    setupCompletion: {
      hasWorkspace: boolean;
      hasOwner: boolean;
      hasVerifiedDomain: boolean;
    };
    owner: { userId: string; email: string | null; displayName: string | null } | null;
    admins: Array<{ userId: string; email: string | null; role: string }>;
    workspaces: Array<{
      id: string;
      name: string;
      billingPlan: string;
      billingStatus: string;
      includedSeats: number;
      usedSeats: number;
      overSeat: boolean;
    }>;
    seats: { included: number; used: number; overSeatWorkspaceCount: number };
  };
  identity: {
    sso: {
      configured: boolean;
      overallHealth: string | null;
      connections: Array<{
        connectionId: string;
        provider: string;
        status: string;
        health: string;
        lastSuccessAtUtc: string | null;
        lastFailureAtUtc: string | null;
        certExpiryBand: string;
        certNotAfterUtc: string | null;
      }>;
    };
    scim: { enabled: boolean; activeTokenCount: number; lastSyncAt: string | null };
    domains: {
      verified: Array<{ domain: string; verifiedAt: string }>;
      pending: Array<{ domain: string }>;
    };
  };
  evidence: {
    evidenceCount: number;
    failedEvidenceCount: number | null;
    reportCount: number | null;
    verificationPackageCount: number | null;
  };
  governance: {
    activeLegalHolds: number | null;
    activeRetentionPolicies: number | null;
    pendingDestructionRequests: number | null;
  };
  billing: {
    billingOwner: { userId: string; email: string | null; displayName: string | null } | null;
    activeSubscriptions: number;
    failedPayments: number;
    planCounts: Record<string, number>;
    statusCounts: Record<string, number>;
  };
  activity: {
    /**
     * The row cap the two lists below were read under.
     *
     * Optional for the same reason as the person detail's `caps`: the field
     * is new, an undeployed API does not send it, and a page that reads it
     * unconditionally crashes instead of degrading.
     */
    cap?: number;
    recentEvents: Array<{
      id: string;
      eventType: string;
      targetType: string;
      actorUserId: string | null;
      createdAt: string;
      metadata: unknown;
    }>;
    provisioningHistory: Array<{
      id: string;
      action: string;
      userId: string | null;
      outcome: string | null;
      createdAt: string;
      metadata: unknown;
    }>;
  };
};

const HEALTH_TONE: Record<OnboardingHealth, BadgeTone> = {
  HEALTHY: "verified",
  ATTENTION: "pending",
  BLOCKED: "risk",
  UNKNOWN: "neutral",
};

const LIFECYCLE_TONE: Record<LifecycleStage, BadgeTone> = {
  ACTIVE: "verified",
  ONBOARDING: "info",
  PROVISIONED: "info",
  LEAD: "neutral",
  DEMO_REQUESTED: "neutral",
  CONTACT_SALES: "neutral",
  AT_RISK: "pending",
  SUSPENDED: "risk",
  CANCELLED: "risk",
  ARCHIVED: "neutral",
  UNKNOWN: "neutral",
};

const LIFECYCLE_LABEL: Record<LifecycleStage, string> = {
  LEAD: "Lead",
  DEMO_REQUESTED: "Demo requested",
  CONTACT_SALES: "Contact sales",
  PROVISIONED: "Provisioned",
  ONBOARDING: "Onboarding",
  ACTIVE: "Active",
  AT_RISK: "At risk",
  SUSPENDED: "Suspended",
  CANCELLED: "Cancelled",
  ARCHIVED: "Archived",
  UNKNOWN: "Unknown",
};

/** Honest render for a not-modelled field. */
function notModelled() {
  return (
    <span style={{ color: "var(--ink-muted)" }}>Not modelled</span>
  );
}

function ssoTone(health: string): BadgeTone {
  switch (health) {
    case "HEALTHY":
      return "verified";
    case "DEGRADED":
      return "pending";
    case "OUTAGE":
      return "risk";
    default:
      return "neutral";
  }
}

function num(value: number | null | undefined) {
  return value == null ? "Not measured" : String(value);
}

function ts(value: string | null | undefined) {
  return value ? formatUserDateTime(value) : "—";
}

/** Small labelled metric line. */
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ minWidth: 0 }}>
      <div
        style={{
          fontSize: 11,
          fontWeight: 700,
          letterSpacing: "0.08em",
          textTransform: "uppercase",
          color: "var(--ink-muted)",
        }}
      >
        {label}
      </div>
      <div
        style={{
          marginTop: 4,
          fontSize: 14,
          color: "var(--ink-primary)",
          wordBreak: "break-word",
        }}
      >
        {children}
      </div>
    </div>
  );
}

function fieldGrid(children: React.ReactNode) {
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))",
        gap: 16,
      }}
    >
      {children}
    </div>
  );
}

export default function AdminOrganizationDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const { addToast } = useToast();
  const { confirm } = useConfirmAction();

  const [detail, setDetail] = useState<Detail | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);

  /**
   * ADM-020 — organization suspend / resume.
   *
   * Both routes were fully implemented, platform-admin gated and audited, and
   * had NO caller anywhere in the product: the only way to suspend a customer
   * was to craft the request by hand. A control plane that can see a customer
   * in trouble and cannot act on it is a dashboard.
   *
   * The button does not decide anything. `suspendOrganization` /
   * `resumeOrganization` remain the single authority for what suspension
   * means and what it cascades to; this only asks them, and the confirm step
   * exists because the effect reaches every member of the organization.
   */
  const [lifecycleBusy, setLifecycleBusy] = useState<null | "suspend" | "resume">(
    null,
  );
  /**
   * The request the API actually accepts.
   *
   * `POST /v1/admin/orgs/:id/suspend` and `/resume` validate
   * `{ teamId, reason? }` and run a step-up challenge bound to that
   * workspace. This page sent `{}` with no step-up handling, so every click
   * answered 400 and the operator saw "The organization was not suspended."
   * — the one lifecycle action on the customer page did not work. The
   * operator's own active workspace is the audit scope, exactly as the
   * provisioning page sends it.
   */
  const teamId = useActiveWorkspaceId();
  const stepUp = useStepUpAction({ teamId });
  const [lifecycleReason, setLifecycleReason] = useState("");

  const runLifecycle = async (leg: "suspend" | "resume") => {
    if (lifecycleBusy !== null) return;
    if (!teamId) {
      addToast(
        "Your workspace context is still loading. Try again in a moment.",
        "error",
      );
      return;
    }
    const name = detail?.overview.name ?? "this organization";
    const ok = await confirm({
      title: leg === "suspend" ? `Suspend ${name}?` : `Resume ${name}?`,
      description:
        leg === "suspend"
          ? `Every member of ${name} (${id.slice(0, 8)}…) loses access immediately and their sessions are revoked. Billing is not cancelled and nothing is deleted. The reason${
              lifecycleReason.trim() ? ` "${lifecycleReason.trim()}"` : ""
            } is written to the platform audit log. Step-up is required.`
          : `${name} (${id.slice(0, 8)}…) returns to ACTIVE and its members can sign in again. Anything the suspension cascaded to is restored by the same authority that suspended it. Step-up is required.`,
      confirmLabel: leg === "suspend" ? "Suspend customer" : "Resume customer",
      tone: leg === "suspend" ? "danger" : "neutral",
      ...(leg === "suspend" ? { requireConfirmText: "SUSPEND" } : {}),
      testId: `customer-${leg}`,
    });
    if (!ok) return;

    setLifecycleBusy(leg);
    try {
      await stepUp.runStepUpAction(async (headers) =>
        apiFetch(`/v1/admin/orgs/${encodeURIComponent(id)}/${leg}`, {
          method: "POST",
          headers: { "content-type": "application/json", ...(headers ?? {}) },
          body: JSON.stringify({
            teamId,
            ...(leg === "suspend" && lifecycleReason.trim()
              ? { reason: lifecycleReason.trim().slice(0, 400) }
              : {}),
          }),
        }),
      );
      // Re-read before announcing: the badge and the button flip from the
      // server's row, never from a guess.
      await load();
      setLifecycleReason("");
      addToast(
        leg === "suspend" ? "Organization suspended." : "Organization resumed.",
        "success",
      );
    } catch (err) {
      if ((err as { code?: string })?.code === "STEP_UP_CANCEL") {
        addToast("Step-up cancelled — the organization was not changed.", "error");
        return;
      }
      addToast(
        toSafeUserError(err, {
          message:
            leg === "suspend"
              ? "The organization was not suspended."
              : "The organization was not resumed.",
        }).message,
        "error",
      );
    } finally {
      setLifecycleBusy(null);
    }
  };

  const load = useCallback(async () => {
    try {
      setLoading(true);
      setNotFound(false);
      const data: Detail = await apiFetch(
        `/v1/admin/customers/${encodeURIComponent(id)}`,
      );
      setDetail(data);
    } catch (err) {
      const safe = toSafeUserError(err, {
        message: "We couldn't load this organization.",
      });
      const status = (err as { statusCode?: number })?.statusCode;
      if (status === 404) {
        setNotFound(true);
      } else {
        addToast(safe.message, "error");
      }
    } finally {
      setLoading(false);
    }
  }, [id, addToast]);

  useEffect(() => {
    void load();
  }, [load]);

  const workspaceColumns: DataTableColumn<DetailWorkspace>[] = [
    {
      key: "name",
      header: "Workspace",
      render: (row) => <span style={{ fontWeight: 600 }}>{row.name}</span>,
    },
    {
      key: "health",
      header: "Health",
      render: (row) => (
        <Badge tone={HEALTH_TONE[row.health]} dot>
          {row.health}
        </Badge>
      ),
    },
    {
      key: "memberCount",
      header: "Members",
      align: "right",
      render: (row) => row.memberCount,
    },
    {
      key: "caseCount",
      header: "Cases",
      align: "right",
      render: (row) => num(row.caseCount),
    },
    {
      key: "evidenceCount",
      header: "Evidence",
      align: "right",
      render: (row) => row.evidenceCount,
    },
    {
      key: "reportCount",
      header: "Reports",
      align: "right",
      render: (row) => num(row.reportCount),
    },
    {
      key: "packageCount",
      header: "Packages",
      align: "right",
      render: (row) => num(row.packageCount),
    },
  ];

  // PHASE 6 §6 — name this record in the breadcrumb. The expression mirrors
  // the page H1, so the crumb and the heading cannot say different things,
  // and it resolves to null while loading or when the record is gone.
  useAdminEntityCrumb(detail?.overview.name ?? null);

  return (
    <PageShell
      width="full"
      header={
        <PageHeader
          eyebrow="Platform Control Center"
          title={detail?.overview.name ?? "Organization"}
          subtitle="Read-only customer detail: overview, identity posture, evidence operations, governance, billing, and provisioning history. Aggregated from live records; unmeasured fields are shown honestly."
          primaryAction={
            detail ? (
              detail.overview.status === "SUSPENDED" ? (
                <Button
                  size="sm"
                  onClick={() => void runLifecycle("resume")}
                  disabled={lifecycleBusy !== null}
                  aria-label={`Resume customer ${detail.overview.name}`}
                  data-testid="customer-resume"
                >
                  {lifecycleBusy === "resume" ? "Resuming…" : "Resume customer"}
                </Button>
              ) : (
                <span style={{ display: "inline-flex", gap: 8, alignItems: "center" }}>
                  <label style={{ fontSize: 12 }}>
                    <span className="app-visually-hidden">Suspension reason</span>
                    <input
                      className="input"
                      value={lifecycleReason}
                      onChange={(e) => setLifecycleReason(e.target.value)}
                      placeholder="Reason (audited)"
                      maxLength={400}
                      style={{ minWidth: 180 }}
                      data-testid="customer-suspend-reason"
                    />
                  </label>
                  <Button
                    size="sm"
                    variant="destructive"
                    onClick={() => void runLifecycle("suspend")}
                    disabled={lifecycleBusy !== null}
                    aria-label={`Suspend customer ${detail.overview.name}`}
                    data-testid="customer-suspend"
                  >
                    {lifecycleBusy === "suspend" ? "Suspending…" : "Suspend customer"}
                  </Button>
                </span>
              )
            ) : null
          }
          secondaryActions={
            <Link
              href="/admin/customers"
              className="ui-button"
              data-variant="ghost"
              data-size="sm"
              style={buttonSurfaceStyle("ghost", "sm")}
            >
              ← Back to roster
            </Link>
          }
        />
      }
      >

      {loading ? (
        <Card>Loading organization…</Card>
      ) : notFound ? (
        <Card variant="empty">
          <div style={{ textAlign: "center", padding: "24px 8px" }}>
            <div style={{ fontWeight: 650, fontSize: 16 }}>
              Organization not found
            </div>
            <div
              style={{
                marginTop: 6,
                color: "var(--ink-secondary)",
                fontSize: 13.5,
              }}
            >
              This organization does not exist or is not visible.
            </div>
          </div>
        </Card>
      ) : !detail ? (
        <Card>No data.</Card>
      ) : (
        <>
          {/* Overview */}
          {/* ADM-015 — contract terms were entirely unreadable from admin.
              Rendered BEFORE the plan projection because the contract is what
              actually governs an enterprise customer. */}
          <Card
            title="Enterprise contract"
            subtitle="The canonical contract authority. The workspace plan below is a projection and does not decide enterprise status."
          >
            {detail.enterpriseContract ? (
              <>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 16 }}>
                  <Badge
                    tone={
                      detail.enterpriseContract.status === "ACTIVE" ? "verified" : "risk"
                    }
                    dot
                  >
                    {detail.enterpriseContract.status}
                  </Badge>
                  {detail.enterpriseContract.activationState ? (
                    <Badge tone="neutral" subtle>
                      {detail.enterpriseContract.activationState}
                    </Badge>
                  ) : null}
                </div>
                {fieldGrid(
                  <>
                    <Field label="Contracted seats">
                      {detail.enterpriseContract.seatCount ?? "Contract-managed"}
                    </Field>
                    <Field label="Contracted storage">
                      {detail.enterpriseContract.storageGb
                        ? `${detail.enterpriseContract.storageGb} GB`
                        : "Contract-managed"}
                    </Field>
                    <Field label="Evidence records / month">
                      {detail.enterpriseContract.evidenceRecordsPerMonth ??
                        "Catalog default"}
                    </Field>
                    <Field label="AI operations / month">
                      {detail.enterpriseContract.aiOperationsPerMonth ?? "Catalog default"}
                    </Field>
                    <Field label="Region">
                      {detail.enterpriseContract.region ?? "—"}
                    </Field>
                    <Field label="Plan version">
                      {detail.enterpriseContract.planVersion ?? "—"}
                    </Field>
                    <Field label="Effective from">
                      {detail.enterpriseContract.effectiveAtUtc
                        ? ts(detail.enterpriseContract.effectiveAtUtc)
                        : "—"}
                    </Field>
                    <Field label="Term ends">
                      {detail.enterpriseContract.endsAtUtc
                        ? ts(detail.enterpriseContract.endsAtUtc)
                        : "—"}
                    </Field>
                    <Field label="Billing customer ref">
                      {detail.enterpriseContract.billingCustomerRef ?? "—"}
                    </Field>
                    <Field label="Billing subscription ref">
                      {detail.enterpriseContract.billingSubscriptionRef ?? "—"}
                    </Field>
                  </>,
                )}
                {detail.enterpriseContract.legacyDerived ? (
                  <div
                    role="note"
                    style={{
                      marginTop: 16,
                      padding: "10px 14px",
                      borderRadius: 8,
                      border: "1px solid var(--warning-border)",
                      background: "var(--warning-surface)",
                      fontSize: 13,
                    }}
                  >
                    <strong>No stored contract row.</strong> This projection was derived
                    from the organization&apos;s status by the compatibility adapter that
                    remains in place until the contract backfill completes. It is a
                    placeholder for a contract, not a contract.
                  </div>
                ) : null}
              </>
            ) : (
              <div style={{ fontSize: 13.5, color: "var(--ink-secondary)" }}>
                This customer holds no enterprise contract. That is the normal state for a
                self-service customer.
              </div>
            )}
          </Card>

          <Card
            title="Overview"
            subtitle="Identity, workspace plan projection, ownership, and setup completion."
          >
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 16 }}>
              <Badge tone={HEALTH_TONE[detail.overview.onboardingStatus]} dot>
                {detail.overview.onboardingStatus}
              </Badge>
              <Badge tone="neutral">{detail.overview.status}</Badge>
              {detail.overview.plan ? (
                <Badge tone={detail.overview.enterprise ? "governance" : "info"}>
                  {detail.overview.plan}
                </Badge>
              ) : (
                <Badge tone="neutral">No plan</Badge>
              )}
            </div>
            {fieldGrid(
              <>
                <Field label="Name">{detail.overview.name}</Field>
                <Field label="Legal name">
                  {detail.overview.legalName ?? "—"}
                </Field>
                <Field label="Created">{ts(detail.overview.createdAt)}</Field>
                <Field label="Owner">
                  {detail.overview.owner?.email ??
                    detail.overview.owner?.userId ??
                    "Not measured"}
                </Field>
                <Field label="Seats (used / included)">
                  {detail.overview.seats.included > 0
                    ? `${detail.overview.seats.used} / ${detail.overview.seats.included}`
                    : `${detail.overview.seats.used} · no allocation`}
                </Field>
                <Field label="Over-seat workspaces">
                  {detail.overview.seats.overSeatWorkspaceCount}
                </Field>
                <Field label="Workspace present">
                  {detail.overview.setupCompletion.hasWorkspace ? "Yes" : "No"}
                </Field>
                <Field label="Owner present">
                  {detail.overview.setupCompletion.hasOwner ? "Yes" : "No"}
                </Field>
                <Field label="Verified domain">
                  {detail.overview.setupCompletion.hasVerifiedDomain
                    ? "Yes"
                    : "No"}
                </Field>
              </>,
            )}

            {detail.overview.admins.length > 0 ? (
              <div style={{ marginTop: 18 }}>
                <div
                  style={{
                    fontSize: 11,
                    fontWeight: 700,
                    letterSpacing: "0.08em",
                    textTransform: "uppercase",
                    color: "var(--ink-muted)",
                    marginBottom: 8,
                  }}
                >
                  Admins
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  {detail.overview.admins.map((a) => (
                    <div key={a.userId} style={{ fontSize: 13.5 }}>
                      {a.email ?? a.userId}{" "}
                      <Badge tone="neutral" subtle>
                        {a.role}
                      </Badge>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}

            {detail.overview.workspaces.length > 0 ? (
              <div style={{ marginTop: 18 }}>
                <div
                  style={{
                    fontSize: 11,
                    fontWeight: 700,
                    letterSpacing: "0.08em",
                    textTransform: "uppercase",
                    color: "var(--ink-muted)",
                    marginBottom: 8,
                  }}
                >
                  Workspaces
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  {detail.overview.workspaces.map((w) => (
                    <div
                      key={w.id}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "space-between",
                        gap: 12,
                        flexWrap: "wrap",
                        fontSize: 13.5,
                        padding: "8px 0",
                        borderTop: "1px solid var(--border-subtle)",
                      }}
                    >
                      <span style={{ fontWeight: 600 }}>{w.name}</span>
                      <span style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                        <Badge tone="info" subtle>
                          {w.billingPlan}
                        </Badge>
                        <Badge tone="neutral" subtle>
                          {w.billingStatus}
                        </Badge>
                        <span style={{ color: "var(--ink-secondary)" }}>
                          {w.includedSeats > 0
                            ? `${w.usedSeats} / ${w.includedSeats} seats`
                            : `${w.usedSeats} seats · no allocation`}
                        </span>
                        {w.overSeat ? <Badge tone="risk" subtle>Over seat</Badge> : null}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}
          </Card>

          {/* Customer Success (item C) */}
          <Card
            title="Customer Success"
            subtitle="Adoption milestones and health signals from live records. Fields with no backing model are shown honestly as 'Not modelled' — never fabricated."
          >
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 16 }}>
              <Badge tone={LIFECYCLE_TONE[detail.lifecycle.stage] ?? "neutral"} dot>
                {LIFECYCLE_LABEL[detail.lifecycle.stage] ?? detail.lifecycle.stage}
              </Badge>
              {detail.customerSuccess.riskStatus ? (
                <Badge tone="risk" subtle>
                  Risk: {LIFECYCLE_LABEL[detail.customerSuccess.riskStatus]}
                </Badge>
              ) : null}
            </div>
            {detail.lifecycle.reasons.length > 0 ? (
              <div
                style={{
                  fontSize: 13,
                  color: "var(--ink-secondary)",
                  marginBottom: 16,
                }}
              >
                {detail.lifecycle.reasons.join(" ")}
              </div>
            ) : null}
            {fieldGrid(
              <>
                <Field label="First evidence">
                  {ts(detail.customerSuccess.firstEvidenceAt)}
                </Field>
                <Field label="First report">
                  {ts(detail.customerSuccess.firstReportAt)}
                </Field>
                <Field label="First package">
                  {ts(detail.customerSuccess.firstPackageAt)}
                </Field>
                <Field label="Last activity">
                  {ts(detail.customerSuccess.lastActivityAt)}
                </Field>
                <Field label="Last login">
                  {ts(detail.customerSuccess.lastLoginAt)}
                </Field>
                <Field label="Open incidents">
                  {num(detail.customerSuccess.openIncidents)}
                </Field>
                <Field label="SSO configured">
                  {detail.customerSuccess.ssoConfigured ? "Yes" : "Not connected"}
                </Field>
                <Field label="SCIM configured">
                  {detail.customerSuccess.scimConfigured ? "Yes" : "Not connected"}
                </Field>
                <Field label="Domain verified">
                  {detail.customerSuccess.domainVerified ? "Yes" : "No"}
                </Field>
                <Field label="Past-due workspaces">
                  {detail.customerSuccess.billingIssues.pastDueWorkspaces}
                </Field>
                <Field label="Failed payments">
                  {detail.customerSuccess.billingIssues.failedPayments}
                </Field>
                <Field label="Onboarding completion">{notModelled()}</Field>
                <Field label="Account manager">{notModelled()}</Field>
                <Field label="Support contact">{notModelled()}</Field>
                <Field label="Renewal date">{notModelled()}</Field>
                <Field label="Support tickets">{notModelled()}</Field>
              </>,
            )}
          </Card>

          {/* Workspaces — Platform Map (item F) */}
          <Card
            title="Workspaces"
            subtitle="Platform map: every workspace under this organization with its member, case, evidence, report, and package counts. Counts are live; a null count means that signal is not measured for the workspace."
          >
            {detail.workspaces.length === 0 ? (
              <div style={{ color: "var(--ink-secondary)", fontSize: 13.5 }}>
                This organization has no workspaces.
              </div>
            ) : (
              <DataTable
                ariaLabel="Organization workspaces platform map"
                columns={workspaceColumns}
                rows={detail.workspaces}
                getRowId={(row) => row.id}
              />
            )}
          </Card>

          {/* Identity */}
          <Card
            title="Identity"
            subtitle="SSO health, SCIM provisioning, and verified domains. No IdP secrets or SCIM tokens are shown."
          >
            {fieldGrid(
              <>
                <Field label="SSO configured">
                  {detail.identity.sso.configured ? "Yes" : "Not connected"}
                </Field>
                <Field label="SSO overall health">
                  {detail.identity.sso.overallHealth ? (
                    <Badge tone={ssoTone(detail.identity.sso.overallHealth)}>
                      {detail.identity.sso.overallHealth}
                    </Badge>
                  ) : (
                    "Not measured"
                  )}
                </Field>
                <Field label="SCIM enabled">
                  {detail.identity.scim.enabled ? "Yes" : "Not connected"}
                </Field>
                <Field label="SCIM active tokens">
                  {detail.identity.scim.activeTokenCount}
                </Field>
                <Field label="SCIM last sync">
                  {ts(detail.identity.scim.lastSyncAt)}
                </Field>
              </>,
            )}

            <div style={{ marginTop: 18 }}>
              <div
                style={{
                  fontSize: 11,
                  fontWeight: 700,
                  letterSpacing: "0.08em",
                  textTransform: "uppercase",
                  color: "var(--ink-muted)",
                  marginBottom: 8,
                }}
              >
                SSO connections
              </div>
              {detail.identity.sso.connections.length === 0 ? (
                <div style={{ color: "var(--ink-secondary)", fontSize: 13.5 }}>
                  Not connected — no SSO connection on any workspace.
                </div>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  {detail.identity.sso.connections.map((c) => (
                    <div
                      key={c.connectionId}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "space-between",
                        gap: 12,
                        flexWrap: "wrap",
                        fontSize: 13.5,
                        padding: "8px 0",
                        borderTop: "1px solid var(--border-subtle)",
                      }}
                    >
                      <span style={{ fontWeight: 600 }}>
                        {c.provider}{" "}
                        <span style={{ color: "var(--ink-muted)", fontWeight: 400 }}>
                          ({c.status})
                        </span>
                      </span>
                      <span style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                        <Badge tone={ssoTone(c.health)}>{c.health}</Badge>
                        <span style={{ color: "var(--ink-secondary)" }}>
                          last ok {ts(c.lastSuccessAtUtc)}
                        </span>
                        <Badge tone="neutral" subtle>
                          cert {c.certExpiryBand}
                        </Badge>
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div style={{ marginTop: 18 }}>
              <div
                style={{
                  fontSize: 11,
                  fontWeight: 700,
                  letterSpacing: "0.08em",
                  textTransform: "uppercase",
                  color: "var(--ink-muted)",
                  marginBottom: 8,
                }}
              >
                Domains
              </div>
              {detail.identity.domains.verified.length === 0 &&
              detail.identity.domains.pending.length === 0 ? (
                <div style={{ color: "var(--ink-secondary)", fontSize: 13.5 }}>
                  No domains claimed.
                </div>
              ) : (
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  {detail.identity.domains.verified.map((d) => (
                    <Badge key={d.domain} tone="verified">
                      {d.domain} · verified
                    </Badge>
                  ))}
                  {detail.identity.domains.pending.map((d) => (
                    <Badge key={d.domain} tone="pending">
                      {d.domain} · pending
                    </Badge>
                  ))}
                </div>
              )}
            </div>
          </Card>

          {/* Evidence operations */}
          <Card
            title="Evidence operations"
            subtitle="Read-only counts. Hashes are never recomputed here."
          >
            {fieldGrid(
              <>
                <Field label="Evidence records">
                  {detail.evidence.evidenceCount}
                </Field>
                <Field label="Failed evidence">
                  {num(detail.evidence.failedEvidenceCount)}
                </Field>
                <Field label="Reports">{num(detail.evidence.reportCount)}</Field>
                <Field label="Verification packages">
                  {num(detail.evidence.verificationPackageCount)}
                </Field>
              </>,
            )}
          </Card>

          {/* Governance */}
          <Card
            title="Governance"
            subtitle="Legal holds, retention, and destruction posture across the org's workspaces."
          >
            {fieldGrid(
              <>
                <Field label="Active legal holds">
                  {num(detail.governance.activeLegalHolds)}
                </Field>
                <Field label="Retention policies">
                  {num(detail.governance.activeRetentionPolicies)}
                </Field>
                <Field label="Pending destruction requests">
                  {num(detail.governance.pendingDestructionRequests)}
                </Field>
              </>,
            )}
          </Card>

          {/* Billing */}
          <Card
            title="Billing"
            subtitle="Subscription + payment posture. No card, Stripe, or payment-instrument data is shown."
          >
            {fieldGrid(
              <>
                <Field label="Billing owner">
                  {detail.billing.billingOwner?.email ??
                    detail.billing.billingOwner?.userId ??
                    "Not measured"}
                </Field>
                <Field label="Active subscriptions">
                  {detail.billing.activeSubscriptions}
                </Field>
                <Field label="Failed payments">
                  {detail.billing.failedPayments}
                </Field>
              </>,
            )}
            <div style={{ marginTop: 16, display: "flex", gap: 8, flexWrap: "wrap" }}>
              {Object.entries(detail.billing.planCounts).map(([plan, count]) => (
                <Badge key={plan} tone="info" subtle>
                  {plan}: {count}
                </Badge>
              ))}
              {Object.entries(detail.billing.statusCounts).map(([status, count]) => (
                <Badge key={status} tone="neutral" subtle>
                  {status}: {count}
                </Badge>
              ))}
            </div>
          </Card>

          {/* Activity + provisioning history */}
          <Card
            title="Activity & provisioning history"
            subtitle="Recent organization audit events and platform provisioning actions."
          >
            <div
              style={{
                fontSize: 11,
                fontWeight: 700,
                letterSpacing: "0.08em",
                textTransform: "uppercase",
                color: "var(--ink-muted)",
                marginBottom: 8,
              }}
            >
              Provisioning history
            </div>
            {/*
              THE CAP, STATED. Both lists on this card are read under a
              server-side `take`, and both were rendered under headings that
              promise a history. An organization with two hundred audit events
              looked like an organization with twenty-five. The cap now travels
              with the rows (see `activity.cap`) so the page can say it rather
              than assume it.
            */}
            <ResultCount
              shown={detail.activity.provisioningHistory.length}
              cap={detail.activity.cap}
              noun="provisioning action"
              data-testid="admin-customer-provisioning-count"
            />
            {detail.activity.provisioningHistory.length === 0 ? (
              <div style={{ color: "var(--ink-secondary)", fontSize: 13.5 }}>
                No provisioning actions recorded for this organization.
              </div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {detail.activity.provisioningHistory.map((p) => (
                  <div
                    key={p.id}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      gap: 12,
                      flexWrap: "wrap",
                      fontSize: 13.5,
                      padding: "8px 0",
                      borderTop: "1px solid var(--border-subtle)",
                    }}
                  >
                    <span>
                      <Badge tone="governance" subtle>
                        {p.action}
                      </Badge>{" "}
                      <span style={{ color: "var(--ink-secondary)" }}>
                        by {p.userId ?? "—"} · {p.outcome ?? "—"}
                      </span>
                    </span>
                    <span style={{ color: "var(--ink-muted)" }}>
                      {ts(p.createdAt)}
                    </span>
                  </div>
                ))}
              </div>
            )}

            <div
              style={{
                fontSize: 11,
                fontWeight: 700,
                letterSpacing: "0.08em",
                textTransform: "uppercase",
                color: "var(--ink-muted)",
                margin: "18px 0 8px",
              }}
            >
              Recent org events
            </div>
            <ResultCount
              shown={detail.activity.recentEvents.length}
              cap={detail.activity.cap}
              noun="organization event"
              data-testid="admin-customer-events-count"
            />
            {detail.activity.recentEvents.length === 0 ? (
              <div style={{ color: "var(--ink-secondary)", fontSize: 13.5 }}>
                No organization audit events recorded.
              </div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {detail.activity.recentEvents.map((e) => (
                  <div
                    key={e.id}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      gap: 12,
                      flexWrap: "wrap",
                      fontSize: 13.5,
                      padding: "8px 0",
                      borderTop: "1px solid var(--border-subtle)",
                    }}
                  >
                    <span>
                      <Badge tone="neutral" subtle>
                        {e.eventType}
                      </Badge>{" "}
                      <span style={{ color: "var(--ink-secondary)" }}>
                        {e.targetType} · actor {e.actorUserId ?? "—"}
                      </span>
                    </span>
                    <span style={{ color: "var(--ink-muted)" }}>
                      {ts(e.createdAt)}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </Card>
        </>
      )}
      <StepUpModal control={stepUp} />
    </PageShell>
  );
}
