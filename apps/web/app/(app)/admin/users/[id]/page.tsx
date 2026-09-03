"use client";

/**
 * PLATFORM ADMIN — Person detail (ADM-028, ADM-031).
 *
 * The page an operator needs to answer, about one human being: who are they,
 * what do they pay for, what commercial access do they have RIGHT NOW, which
 * workspaces do they own or belong to, and is there a closure or export request
 * outstanding for them.
 *
 * The commercial block is `resolveCommercialContext` verbatim. It is shown
 * beside the stored entitlement tier rather than instead of it, because in the
 * grace window the two legitimately disagree and that disagreement is
 * information: "PRO by entitlement, PAST_DUE at the provider, still inside the
 * 7-day grace" is three facts, and collapsing them into one word loses the one
 * the operator needs.
 */

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
import { formatMoney } from "../../../../../components/admin/AdminMetric";
import { apiFetch } from "../../../../../lib/api";
import { formatUserDateTime } from "../../../../../lib/date";
import { toSafeUserError } from "../../../../../lib/feedback/toSafeUserError";

type Detail = {
  id: string;
  email: string | null;
  name: string | null;
  createdAt: string;
  provider: string;
  platformRole: string | null;
  accountTier: string | null;
  subscriptions: Array<{
    id: string;
    provider: string;
    plan: string;
    status: string;
    cancelAtPeriodEnd: boolean;
    currentPeriodEnd: string | null;
  }>;
  pendingCancellation: boolean;
  hasLiveSubscription: boolean;
  personalWorkspaceId: string | null;
  ownedWorkspaceCount: number;
  workspaceMembershipsCount: number;
  orgMembershipsCount: number;
  mfaEnrolled: boolean;
  lastLoginAt: string | null;
  memberships: { active: number; suspended: number; revoked: number };
  country: string | null;
  timezone: string | null;
  riskStatus: null;
  commercial: {
    plan: string;
    lifecycleState: string;
    paidActive: boolean;
    mutationsAllowed: boolean;
    graceEndsAtUtc: string | null;
    billingOwnerUserId: string | null;
  } | null;
  commercialUnavailableReason: string | null;
  workspaces: Array<{
    id: string;
    name: string;
    kind: string;
    lifecycle: "LIVE" | "CLOSED";
    role: string | null;
    memberStatus: string | null;
    isOwner: boolean;
  }>;
  organizations: Array<{
    id: string;
    name: string;
    kind: string;
    role: string;
    status: string;
  }>;
  payments: Array<{
    id: string;
    provider: string;
    amountCents: number;
    currency: string;
    status: string;
    createdAt: string;
  }>;
  lifecycleRequests: {
    closure: Array<{ id: string; status: string; requestedAtUtc: string }>;
    dataExport: Array<{ id: string; status: string; requestedAtUtc: string }>;
  };
  evidenceCount: number;
};

const LIFECYCLE_TONE: Record<string, BadgeTone> = {
  ACTIVE: "verified",
  GRACE: "pending",
  PAST_DUE_EXPIRED: "risk",
  CANCELLED: "risk",
  INACTIVE: "neutral",
};

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
        gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))",
        gap: 18,
      }}
    >
      {children}
    </div>
  );
}

export default function AdminPersonDetailPage() {
  const params = useParams<{ id: string }>();
  const id = typeof params?.id === "string" ? params.id : "";
  const { addToast } = useToast();

  const [loading, setLoading] = useState(true);
  const [detail, setDetail] = useState<Detail | null>(null);
  // "Does not exist" and "could not be read" are different facts: one is
  // terminal and the other is retryable, and a page that shows one message
  // for both teaches operators to retry a 404.
  const [notFound, setNotFound] = useState(false);

  const load = useCallback(async () => {
    if (!id) return;
    setLoading(true);
    setNotFound(false);
    try {
      const data = (await apiFetch(
        `/v1/admin/users/${encodeURIComponent(id)}`,
      )) as Detail;
      setDetail(data ?? null);
    } catch (err) {
      if ((err as { statusCode?: number })?.statusCode === 404) {
        setNotFound(true);
        setDetail(null);
        return;
      }
      addToast(
        toSafeUserError(err, { message: "We couldn't load this person." }).message,
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

  const workspaceColumns: DataTableColumn<Detail["workspaces"][number]>[] = [
    {
      key: "name",
      header: "Workspace",
      render: (w) => (
        <Link href={`/admin/workspaces/${encodeURIComponent(w.id)}`}>{w.name}</Link>
      ),
    },
    { key: "kind", header: "Kind", render: (w) => <Badge tone="info" subtle>{w.kind}</Badge> },
    {
      key: "lifecycle",
      header: "Lifecycle",
      render: (w) => (
        <Badge tone={w.lifecycle === "LIVE" ? "verified" : "neutral"} dot>
          {w.lifecycle === "LIVE" ? "Live" : "Closed"}
        </Badge>
      ),
    },
    {
      key: "role",
      header: "Role",
      render: (w) => (
        <span>
          {w.role ?? "—"}
          {w.isOwner ? " (owner)" : ""}
        </span>
      ),
    },
    {
      key: "memberStatus",
      header: "Membership",
      render: (w) => (
        <Badge
          tone={
            w.memberStatus === "ACTIVE"
              ? "verified"
              : w.memberStatus === "SUSPENDED"
                ? "pending"
                : "risk"
          }
          subtle
        >
          {w.memberStatus ?? "—"}
        </Badge>
      ),
    },
  ];

  const paymentColumns: DataTableColumn<Detail["payments"][number]>[] = [
    {
      key: "createdAt",
      header: "When",
      nowrap: true,
      render: (p) => formatUserDateTime(p.createdAt),
    },
    { key: "provider", header: "Provider", render: (p) => p.provider },
    {
      key: "amount",
      header: "Amount",
      nowrap: true,
      render: (p) => (
        <span style={{ fontWeight: 600 }}>{formatMoney(p.amountCents, p.currency)}</span>
      ),
    },
    {
      key: "status",
      header: "Status",
      render: (p) => (
        <Badge
          tone={
            p.status === "SUCCEEDED" ? "verified" : p.status === "FAILED" ? "risk" : "neutral"
          }
        >
          {p.status}
        </Badge>
      ),
    },
  ];

  return (
    <PageShell
      width="full"
      header={
        <PageHeader
          eyebrow="Person"
          title={detail?.email ?? detail?.name ?? "Person"}
          subtitle={
            detail
              ? `${detail.provider} · joined ${formatUserDateTime(detail.createdAt)}`
              : undefined
          }
          secondaryActions={
            <>
              <Link href="/admin/users" style={{ textDecoration: "none" }}>
                <Button variant="ghost">← All people</Button>
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
      ) : notFound ? (
        <EmptyState
          title="Person not found"
          purpose="No account exists with this id. It may have been removed, or the link is wrong — the people roster is the place to find the one you meant."
        />
      ) : !detail ? (
        <EmptyState
          title="Person unavailable"
          purpose="This person could not be loaded right now. The account may still exist — reload to try the read again."
        />
      ) : (
        <>
          <PageSection title="Identity">
            <Card>
              <FieldGrid>
                <Field label="User ID">
                  <span style={{ fontFamily: "monospace", fontSize: 12 }}>{detail.id}</span>
                </Field>
                <Field label="Email">{detail.email ?? "—"}</Field>
                <Field label="Name">{detail.name ?? "—"}</Field>
                <Field label="Sign-in provider">{detail.provider}</Field>
                <Field label="Platform role">
                  {detail.platformRole ? (
                    <Badge tone="governance">Platform admin</Badge>
                  ) : (
                    "—"
                  )}
                </Field>
                <Field label="MFA">
                  {detail.mfaEnrolled ? (
                    <Badge tone="verified" subtle>
                      Enrolled
                    </Badge>
                  ) : (
                    <Badge tone="neutral" subtle>
                      None
                    </Badge>
                  )}
                </Field>
                <Field label="Last login">
                  {detail.lastLoginAt ? formatUserDateTime(detail.lastLoginAt) : "—"}
                </Field>
                <Field label="Country / timezone">
                  {[detail.country, detail.timezone].filter(Boolean).join(" · ") || "—"}
                </Field>
                <Field label="Risk">
                  <span style={{ color: "var(--ink-muted, #94a3b8)" }}>
                    Not measured — no per-user risk model exists
                  </span>
                </Field>
              </FieldGrid>
            </Card>
          </PageSection>

          <PageSection
            title="Commercial"
            description="The canonical account verdict, beside the stored entitlement tier. In the grace window these legitimately differ — that difference is the answer to 'do they still have access?'."
          >
            <Card>
              <FieldGrid>
                <Field label="Stored entitlement tier">
                  {detail.accountTier ? (
                    <Badge tone="info">{detail.accountTier}</Badge>
                  ) : (
                    "None"
                  )}
                </Field>
                {detail.commercial ? (
                  <>
                    <Field label="Effective plan">
                      <Badge tone="governance">{detail.commercial.plan}</Badge>
                    </Field>
                    <Field label="Commercial lifecycle">
                      <Badge
                        tone={LIFECYCLE_TONE[detail.commercial.lifecycleState] ?? "neutral"}
                      >
                        {detail.commercial.lifecycleState}
                      </Badge>
                      {detail.commercial.graceEndsAtUtc ? (
                        <div
                          style={{
                            fontSize: 12,
                            marginTop: 4,
                            color: "var(--ink-secondary)",
                          }}
                        >
                          Grace ends {formatUserDateTime(detail.commercial.graceEndsAtUtc)}
                        </div>
                      ) : null}
                    </Field>
                    <Field label="Paid access">
                      {detail.commercial.paidActive ? "Active" : "Not active"}
                    </Field>
                  </>
                ) : (
                  <Field label="Effective plan">
                    <span style={{ color: "var(--risk-strong, #a4243b)", fontSize: 13 }}>
                      {detail.commercialUnavailableReason ?? "Could not resolve."}
                    </span>
                  </Field>
                )}
                <Field label="Personal workspace">
                  {detail.personalWorkspaceId ? (
                    <Link
                      href={`/admin/workspaces/${encodeURIComponent(detail.personalWorkspaceId)}`}
                    >
                      Open personal space
                    </Link>
                  ) : (
                    "—"
                  )}
                </Field>
                <Field label="Evidence records">{detail.evidenceCount}</Field>
              </FieldGrid>

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
                    marginBottom: 10,
                  }}
                >
                  Provider subscriptions
                </div>
                {detail.subscriptions.length === 0 ? (
                  <span style={{ fontSize: 13, color: "var(--ink-muted, #94a3b8)" }}>
                    No provider subscription on this account.
                  </span>
                ) : (
                  <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                    {detail.subscriptions.map((s) => (
                      <div
                        key={s.id}
                        style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}
                      >
                        <Badge tone={s.status === "ACTIVE" ? "verified" : "neutral"}>
                          {s.provider} {s.plan} · {s.status}
                        </Badge>
                        {s.cancelAtPeriodEnd ? (
                          <Badge tone="pending">Cancels at period end</Badge>
                        ) : null}
                        {s.currentPeriodEnd ? (
                          <span style={{ fontSize: 12, color: "var(--ink-secondary)" }}>
                            period ends {formatUserDateTime(s.currentPeriodEnd)}
                          </span>
                        ) : null}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </Card>
          </PageSection>

          <PageSection title="Workspaces">
            <Card>
              <DataTable
                ariaLabel="Person workspaces"
                columns={workspaceColumns}
                rows={detail.workspaces}
                getRowId={(w) => w.id}
                emptyState={
                  <EmptyState
                    title="No workspace memberships"
                    purpose="This person belongs to no workspace."
                  />
                }
              />
            </Card>
          </PageSection>

          {detail.organizations.length > 0 ? (
            <PageSection title="Organization memberships">
              <Card>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 10 }}>
                  {detail.organizations.map((o) => (
                    <span key={o.id}>
                      {o.kind === "CUSTOMER" ? (
                        <Link href={`/admin/customers/${encodeURIComponent(o.id)}`}>
                          <Badge tone="governance" subtle>
                            {o.name} · {o.role} · {o.status}
                          </Badge>
                        </Link>
                      ) : (
                        <Badge
                          tone="neutral"
                          subtle
                          title="Internal bootstrap container, not a customer organization"
                        >
                          {o.name} · container
                        </Badge>
                      )}
                    </span>
                  ))}
                </div>
              </Card>
            </PageSection>
          ) : null}

          <PageSection title="Payments">
            <Card>
              <DataTable
                ariaLabel="Person payments"
                columns={paymentColumns}
                rows={detail.payments}
                getRowId={(p) => p.id}
                emptyState={
                  <EmptyState
                    title="No payments"
                    purpose="No payment has been recorded for this account."
                  />
                }
              />
            </Card>
          </PageSection>

          <PageSection
            title="Account lifecycle requests"
            description="Closure and data-export requests. Read-only here — both are driven by their own state machines with cooling-off windows and blocker preflights, and an admin surface must not write their status directly."
          >
            <Card>
              {detail.lifecycleRequests.closure.length === 0 &&
              detail.lifecycleRequests.dataExport.length === 0 ? (
                <EmptyState
                  title="No lifecycle requests"
                  purpose="This person has requested neither account closure nor a data export."
                />
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                  {detail.lifecycleRequests.closure.map((c) => (
                    <div key={c.id} style={{ display: "flex", gap: 10, alignItems: "center" }}>
                      <Badge tone="risk" subtle>
                        Account closure
                      </Badge>
                      <Badge tone="neutral">{c.status}</Badge>
                      <span style={{ fontSize: 12, color: "var(--ink-secondary)" }}>
                        requested {formatUserDateTime(c.requestedAtUtc)}
                      </span>
                    </div>
                  ))}
                  {detail.lifecycleRequests.dataExport.map((e) => (
                    <div key={e.id} style={{ display: "flex", gap: 10, alignItems: "center" }}>
                      <Badge tone="info" subtle>
                        Data export
                      </Badge>
                      <Badge tone="neutral">{e.status}</Badge>
                      <span style={{ fontSize: 12, color: "var(--ink-secondary)" }}>
                        requested {formatUserDateTime(e.requestedAtUtc)}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </Card>
          </PageSection>
        </>
      )}
    </PageShell>
  );
}
