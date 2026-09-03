"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";

import {
  PageShell,
  PageHeader,
  PageSection,
  DataTable,
  Skeleton,
  useToast,
  type DataTableColumn,
} from "../../../../../components/ui";
import { Badge, type BadgeTone } from "../../../../../components/ui/Badge";
import { Button } from "../../../../../components/ui/Button";
import { Card } from "../../../../../components/ui/Card";
import { EmptyState } from "../../../../../components/ui/EmptyState";
import { apiFetch } from "../../../../../lib/api";
import { formatUserDateTime } from "../../../../../lib/date";
import { toSafeUserError } from "../../../../../lib/feedback/toSafeUserError";

/**
 * PLATFORM ADMIN — Workspace detail (ADM-027).
 *
 * The commercial block renders `resolveCommercialContext` VERBATIM — the same
 * authority checkout and the billing UI read. The stored `Team.billing*` columns
 * are shown beside it under "Stored projection", deliberately: when the composed
 * verdict and the stored column disagree, that disagreement is the thing the
 * operator is here to investigate, and hiding one of the two would hide it.
 *
 * No evidence content is rendered anywhere on this page — counts and storage
 * totals only. Platform-operations visibility and evidence-content
 * authorization are separate grants.
 */

type Detail = {
  id: string;
  name: string;
  kind: "PERSONAL" | "OWNED" | "ORGANIZATION";
  lifecycle: "LIVE" | "CLOSED";
  closedAtUtc: string | null;
  createdAt: string;
  workspaceCategory: string | null;
  organization: { id: string; name: string; kind: string; status: string } | null;
  owner: { userId: string; email: string | null; displayName: string | null } | null;
  billingOwner: {
    userId: string;
    email: string | null;
    displayName: string | null;
  } | null;
  commercial: {
    plan: string;
    billingShape: string;
    seats: { consumed: number; limit: number; remaining: number };
    lifecycleState: string;
    paidActive: boolean;
    mutationsAllowed: boolean;
    graceEndsAtUtc: string | null;
    enterpriseContract: {
      status: string;
      seatCount: number | null;
      storageGb: number | null;
      endsAtUtc: string | null;
      region: string | null;
      legacyDerived: boolean;
    } | null;
  } | null;
  commercialUnavailableReason: string | null;
  raw: {
    billingPlan: string;
    billingStatus: string;
    includedSeats: number;
    billingActivatedAt: string | null;
    billingCanceledAt: string | null;
  };
  usage: {
    storageBytesUsed: string;
    storageBytesLimit: string;
    storageUsagePercent: number;
    evidenceCount: number;
    isNearStorageLimit: boolean;
    isStorageLimitReached: boolean;
  } | null;
  members: { active: number; suspended: number; revoked: number };
  incidents: { open: number; acknowledged: number };
  subscriptions: Array<{
    id: string;
    provider: string;
    plan: string;
    status: string;
    cancelAtPeriodEnd: boolean;
    currentPeriodEnd: string | null;
    providerSubRefMasked: string;
  }>;
  storageAddons: Array<{
    id: string;
    addonKey: string;
    status: string;
    billingCycle: string;
    amountCents: number | null;
    currency: string | null;
  }>;
  recentActivity: Array<{
    id: string;
    eventType: string;
    actorUserId: string | null;
    createdAt: string;
  }>;
};

const LIFECYCLE_TONE: Record<string, BadgeTone> = {
  ACTIVE: "verified",
  GRACE: "pending",
  PAST_DUE_EXPIRED: "risk",
  CANCELLED: "risk",
  INACTIVE: "neutral",
};

function formatBytes(raw: string): string {
  const n = Number(raw);
  if (!Number.isFinite(n)) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div
        style={{
          fontSize: 11,
          fontWeight: 700,
          letterSpacing: "0.08em",
          textTransform: "uppercase",
          color: "var(--ink-muted, #64748b)",
        }}
      >
        {label}
      </div>
      <div style={{ marginTop: 4, fontSize: 14, color: "var(--ink-primary, #0f172a)" }}>
        {children}
      </div>
    </div>
  );
}

function FieldGrid({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))",
        gap: 18,
      }}
    >
      {children}
    </div>
  );
}

export default function AdminWorkspaceDetailPage() {
  const params = useParams<{ id: string }>();
  const id = typeof params?.id === "string" ? params.id : "";
  const { addToast } = useToast();

  const [loading, setLoading] = useState(true);
  const [detail, setDetail] = useState<Detail | null>(null);

  const load = useCallback(async () => {
    if (!id) return;
    setLoading(true);
    try {
      const data = (await apiFetch(
        `/v1/admin/workspaces/${encodeURIComponent(id)}`,
      )) as Detail;
      setDetail(data ?? null);
    } catch (err) {
      addToast(
        toSafeUserError(err, { message: "We couldn't load this workspace." }).message,
        "error",
      );
      setDetail(null);
    } finally {
      setLoading(false);
    }
  }, [id, addToast]);

  useEffect(() => {
    void load();
  }, [load]);

  const subscriptionColumns: DataTableColumn<Detail["subscriptions"][number]>[] = [
    { key: "provider", header: "Provider", render: (s) => s.provider },
    { key: "plan", header: "Plan", render: (s) => s.plan },
    {
      key: "status",
      header: "Status",
      render: (s) => (
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          <Badge tone={s.status === "ACTIVE" ? "verified" : "neutral"}>{s.status}</Badge>
          {s.cancelAtPeriodEnd ? (
            <Badge tone="pending" title="Active, but will not renew">
              Cancels at period end
            </Badge>
          ) : null}
        </div>
      ),
    },
    {
      key: "period",
      header: "Period ends",
      nowrap: true,
      render: (s) => (s.currentPeriodEnd ? formatUserDateTime(s.currentPeriodEnd) : "—"),
    },
    {
      key: "ref",
      header: "Provider ref",
      render: (s) => (
        <span style={{ fontFamily: "monospace", fontSize: 12 }}>
          {s.providerSubRefMasked}
        </span>
      ),
    },
  ];

  return (
    <PageShell
      width="full"
      header={
        <PageHeader
          eyebrow="Workspace"
          title={detail?.name ?? "Workspace"}
          subtitle={
            detail
              ? `${detail.kind} workspace · created ${formatUserDateTime(detail.createdAt)}`
              : undefined
          }
          secondaryActions={
            <>
              <Link href="/admin/workspaces" style={{ textDecoration: "none" }}>
                <Button variant="ghost">← All workspaces</Button>
              </Link>
              <Button variant="secondary" onClick={() => void load()} disabled={loading}>
                Refresh
              </Button>
            </>
          }
        />
      }
    >

      {loading ? (
        <Card>
          <Skeleton width="100%" height="220px" />
        </Card>
      ) : !detail ? (
        <EmptyState
          title="Workspace unavailable"
          purpose="This workspace could not be loaded. It may not exist, or the read failed."
        />
      ) : (
        <>
          <PageSection title="Identity">
            <Card>
              <FieldGrid>
                <Field label="Workspace ID">
                  <span style={{ fontFamily: "monospace", fontSize: 12 }}>{detail.id}</span>
                </Field>
                <Field label="Kind">
                  <Badge tone="governance">{detail.kind}</Badge>
                </Field>
                <Field label="Lifecycle">
                  {detail.lifecycle === "LIVE" ? (
                    <Badge tone="verified" dot>
                      Live
                    </Badge>
                  ) : (
                    <Badge tone="neutral" dot>
                      Closed{" "}
                      {detail.closedAtUtc
                        ? `· ${formatUserDateTime(detail.closedAtUtc)}`
                        : ""}
                    </Badge>
                  )}
                </Field>
                <Field label="Customer">
                  {detail.organization && detail.organization.kind === "CUSTOMER" ? (
                    <Link href={`/admin/customers/${encodeURIComponent(detail.organization.id)}`}>
                      {detail.organization.name}
                    </Link>
                  ) : (
                    <span style={{ color: "var(--ink-muted, #94a3b8)" }}>
                      Self-service (no customer organization)
                    </span>
                  )}
                </Field>
                <Field label="Owner">
                  {detail.owner?.email ? (
                    // admin-hit-link: 44px hit box, the fact row keeps its
                    // height (admin-console.css).
                    <Link
                      href={`/admin/users/${encodeURIComponent(detail.owner.userId)}`}
                      className="admin-hit-link"
                    >
                      {detail.owner.email}
                    </Link>
                  ) : (
                    "—"
                  )}
                </Field>
                <Field label="Billing owner">
                  {detail.billingOwner?.email ? (
                    <Link
                      href={`/admin/users/${encodeURIComponent(detail.billingOwner.userId)}`}
                      className="admin-hit-link"
                    >
                      {detail.billingOwner.email}
                    </Link>
                  ) : (
                    <span style={{ color: "var(--ink-muted, #94a3b8)" }}>Not set</span>
                  )}
                </Field>
              </FieldGrid>
            </Card>
          </PageSection>

          <PageSection
            title="Commercial context"
            description="Resolved through the canonical commercial authority — the same one checkout and the billing UI read. The stored workspace columns are shown beneath for comparison."
          >
            <Card>
              {detail.commercial ? (
                <FieldGrid>
                  <Field label="Effective plan">
                    <Badge tone="governance">{detail.commercial.plan}</Badge>
                  </Field>
                  <Field label="Commercial lifecycle">
                    <Badge tone={LIFECYCLE_TONE[detail.commercial.lifecycleState] ?? "neutral"}>
                      {detail.commercial.lifecycleState}
                    </Badge>
                    {detail.commercial.graceEndsAtUtc ? (
                      <div style={{ fontSize: 12, marginTop: 4, color: "var(--ink-secondary)" }}>
                        Grace ends {formatUserDateTime(detail.commercial.graceEndsAtUtc)}
                      </div>
                    ) : null}
                  </Field>
                  <Field label="Paid access">
                    {detail.commercial.paidActive ? "Active" : "Not active"}
                  </Field>
                  <Field label="Seats (active members)">
                    {detail.commercial.seats.consumed}
                    {detail.commercial.seats.limit > 0
                      ? ` / ${detail.commercial.seats.limit}`
                      : ""}
                    {detail.commercial.seats.limit > 0 ? (
                      <span style={{ fontSize: 12, color: "var(--ink-secondary)" }}>
                        {" "}
                        ({detail.commercial.seats.remaining} remaining)
                      </span>
                    ) : null}
                  </Field>
                  <Field label="Billing shape">{detail.commercial.billingShape}</Field>
                </FieldGrid>
              ) : (
                <div style={{ fontSize: 13, color: "var(--risk-strong, #a4243b)" }}>
                  {detail.commercialUnavailableReason ??
                    "The commercial context could not be resolved."}
                </div>
              )}

              {detail.commercial?.enterpriseContract ? (
                <div
                  style={{
                    marginTop: 20,
                    paddingTop: 18,
                    borderTop: "1px solid var(--border-default, #e2e8f0)",
                  }}
                >
                  <div
                    style={{
                      fontSize: 11,
                      fontWeight: 700,
                      letterSpacing: "0.08em",
                      textTransform: "uppercase",
                      color: "var(--ink-muted, #64748b)",
                      marginBottom: 12,
                    }}
                  >
                    Enterprise contract
                  </div>
                  <FieldGrid>
                    <Field label="Status">
                      <Badge
                        tone={
                          detail.commercial.enterpriseContract.status === "ACTIVE"
                            ? "verified"
                            : "risk"
                        }
                      >
                        {detail.commercial.enterpriseContract.status}
                      </Badge>
                    </Field>
                    <Field label="Contracted seats">
                      {detail.commercial.enterpriseContract.seatCount ?? "Contract-managed"}
                    </Field>
                    <Field label="Contracted storage">
                      {detail.commercial.enterpriseContract.storageGb
                        ? `${detail.commercial.enterpriseContract.storageGb} GB`
                        : "Contract-managed"}
                    </Field>
                    <Field label="Region">
                      {detail.commercial.enterpriseContract.region ?? "—"}
                    </Field>
                    <Field label="Term ends">
                      {detail.commercial.enterpriseContract.endsAtUtc
                        ? formatUserDateTime(detail.commercial.enterpriseContract.endsAtUtc)
                        : "—"}
                    </Field>
                  </FieldGrid>
                  {detail.commercial.enterpriseContract.legacyDerived ? (
                    <div
                      role="note"
                      style={{
                        marginTop: 14,
                        padding: "10px 14px",
                        borderRadius: 8,
                        border: "1px solid var(--warning-border, #e0b070)",
                        background: "var(--warning-surface, #fdf6ec)",
                        fontSize: 13,
                      }}
                    >
                      <strong>No stored contract row.</strong> This projection was derived
                      from the organization&apos;s status by the compatibility adapter. It is
                      not a contract — treat it as a placeholder until the contract backfill
                      completes for this customer.
                    </div>
                  ) : null}
                </div>
              ) : null}

              <div
                style={{
                  marginTop: 20,
                  paddingTop: 18,
                  borderTop: "1px solid var(--border-default, #e2e8f0)",
                }}
              >
                <div
                  style={{
                    fontSize: 11,
                    fontWeight: 700,
                    letterSpacing: "0.08em",
                    textTransform: "uppercase",
                    color: "var(--ink-muted, #64748b)",
                    marginBottom: 12,
                  }}
                >
                  Stored projection (Team.billing*)
                </div>
                <FieldGrid>
                  <Field label="Stored plan">{detail.raw.billingPlan}</Field>
                  <Field label="Stored status">{detail.raw.billingStatus}</Field>
                  <Field label="Included seats">{detail.raw.includedSeats}</Field>
                  <Field label="Activated">
                    {detail.raw.billingActivatedAt
                      ? formatUserDateTime(detail.raw.billingActivatedAt)
                      : "—"}
                  </Field>
                  <Field label="Cancelled">
                    {detail.raw.billingCanceledAt
                      ? formatUserDateTime(detail.raw.billingCanceledAt)
                      : "—"}
                  </Field>
                </FieldGrid>
              </div>
            </Card>
          </PageSection>

          <PageSection title="Members, usage and operations">
            <div className="admin-stat-grid">
              <div className="admin-stat">
                <div className="admin-stat-label">Active members (seats)</div>
                <div className="admin-stat-value">{detail.members.active}</div>
                <div className="admin-stat-hint">
                  {detail.members.suspended} suspended · {detail.members.revoked} revoked —
                  neither consumes a seat
                </div>
              </div>
              <div className="admin-stat">
                <div className="admin-stat-label">Evidence records</div>
                <div className="admin-stat-value">
                  {detail.usage ? detail.usage.evidenceCount : "Unknown"}
                </div>
              </div>
              <div className="admin-stat">
                <div className="admin-stat-label">Storage used</div>
                <div className="admin-stat-value" data-state={detail.usage ? "VALUE" : "UNKNOWN"}>
                  {detail.usage ? formatBytes(detail.usage.storageBytesUsed) : "Unknown"}
                </div>
                {detail.usage ? (
                  <div className="admin-stat-hint">
                    of {formatBytes(detail.usage.storageBytesLimit)} ·{" "}
                    {detail.usage.storageUsagePercent}%
                    {detail.usage.isStorageLimitReached ? " · limit reached" : ""}
                  </div>
                ) : null}
              </div>
              <Link
                href={`/admin/operations?teamId=${encodeURIComponent(detail.id)}`}
                className="admin-stat admin-stat--link"
              >
                <div className="admin-stat-label">Open incidents</div>
                <div
                  className="admin-stat-value"
                  data-emphasis={detail.incidents.open > 0 ? "critical" : undefined}
                >
                  {detail.incidents.open}
                </div>
                <div className="admin-stat-hint">
                  {detail.incidents.acknowledged} acknowledged
                </div>
                <div className="admin-stat-drill">View incidents →</div>
              </Link>
            </div>
          </PageSection>

          <PageSection
            title="Provider subscriptions"
            description="Bound to this workspace. Provider references are masked — enough to correlate with a provider dashboard, never the full handle."
          >
            <Card>
              <DataTable
                ariaLabel="Workspace subscriptions"
                columns={subscriptionColumns}
                rows={detail.subscriptions}
                getRowId={(s) => s.id}
                emptyState={
                  <EmptyState
                    title="No provider subscriptions"
                    purpose="This workspace has no subscription bound to it. That is normal for a free or contract-billed workspace."
                  />
                }
              />
            </Card>
          </PageSection>

          {detail.storageAddons.length > 0 ? (
            <PageSection title="Storage add-ons">
              <Card>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 10 }}>
                  {detail.storageAddons.map((a) => (
                    <Badge
                      key={a.id}
                      tone={a.status === "ACTIVE" ? "verified" : "neutral"}
                      subtle
                    >
                      {a.addonKey} · {a.status} · {a.billingCycle}
                    </Badge>
                  ))}
                </div>
              </Card>
            </PageSection>
          ) : null}

          <PageSection title="Recent workspace activity">
            <Card>
              {detail.recentActivity.length === 0 ? (
                <EmptyState
                  title="No recorded activity"
                  purpose="No workspace activity events have been recorded for this workspace."
                />
              ) : (
                <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13.5 }}>
                  {detail.recentActivity.map((a) => (
                    <li key={a.id} style={{ marginBottom: 6 }}>
                      <strong>{a.eventType}</strong>{" "}
                      <span style={{ color: "var(--ink-muted, #94a3b8)" }}>
                        {formatUserDateTime(a.createdAt)}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          </PageSection>
        </>
      )}
    </PageShell>
  );
}
