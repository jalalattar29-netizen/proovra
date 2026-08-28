"use client";
import { toSafeUserError } from "../../../../../lib/feedback/toSafeUserError";

// Admin detail route for a single contact-sales inquiry.
//
// Matches the styling and behaviour of the list page at
// /admin/contact-sales but renders one record. Reached from the email
// "Open in admin console" CTA (app.proovra.com/admin/contact-sales/<id>)
// and from the list page's per-row "Open" link.
//
// Auth model:
//   - The (app) route group's layout enforces signed-in user.
//   - The backing /v1/admin/contact-sales/:id endpoint is gated by
//     requirePlatformAdmin in admin-contact-sales.routes.ts. Non-admin
//     users get 403 from the API and see an error state here.

import { use, useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  PageShell,
  PageHeader,
  Skeleton,
  useToast,
} from "../../../../../components/ui";
import { Card } from "../../../../../components/ui/Card";
import { Badge } from "../../../../../components/ui/Badge";
import type { BadgeTone } from "../../../../../components/ui/Badge";
import { Button } from "../../../../../components/ui/Button";
import { PageRouteGate } from "../../../../../components/navigation/PageRouteGate";
import { apiFetch, ApiError } from "../../../../../lib/api";
import { formatUserDateTime } from "../../../../../lib/date";

type Status =
  | "NEW"
  | "REVIEWED"
  | "CONTACTED"
  | "QUALIFIED"
  | "REJECTED"
  | "ARCHIVED";

type Priority = "LOW" | "NORMAL" | "HIGH";

type Details = {
  id: string;
  fullName: string;
  workEmail: string;
  organization: string;
  jobTitle: string | null;
  country: string | null;
  teamSize: string | null;
  discussionTopic: string;
  stage: string;
  deploymentTimeline: string | null;
  estimatedUsers: string | null;
  currentChallenge: string;
  additionalDetails: string | null;
  source: string | null;
  sourcePage: string | null;
  sourcePath: string | null;
  referrer: string | null;
  utmSource: string | null;
  utmMedium: string | null;
  utmCampaign: string | null;
  utmTerm: string | null;
  utmContent: string | null;
  status: Status;
  priority: Priority;
  isSpam: boolean;
  emailSentAt: string | null;
  webhookSentAt: string | null;
  reviewedAt: string | null;
  reviewedByUserId: string | null;
  notes: string | null;
  ipAddress: string | null;
  userAgent: string | null;
  createdAt: string;
  updatedAt: string;
};

function formatTimestamp(value?: string | null) {
  if (!value) return "—";
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? value : formatUserDateTime(value);
}

const STATUS_TONE: Record<Status, BadgeTone> = {
  NEW: "info",
  REVIEWED: "info",
  CONTACTED: "governance",
  QUALIFIED: "verified",
  REJECTED: "risk",
  ARCHIVED: "neutral",
};

const STATUS_LABEL: Record<Status, string> = {
  NEW: "New",
  REVIEWED: "Reviewed",
  CONTACTED: "Contacted",
  QUALIFIED: "Qualified",
  REJECTED: "Rejected",
  ARCHIVED: "Archived",
};

const PRIORITY_TONE: Record<Priority, BadgeTone> = {
  LOW: "neutral",
  NORMAL: "info",
  HIGH: "risk",
};

function StatusPill({ value }: { value: Status }) {
  return (
    <Badge tone={STATUS_TONE[value]} dot>
      {STATUS_LABEL[value]}
    </Badge>
  );
}

function PriorityPill({ value }: { value: Priority }) {
  return <Badge tone={PRIORITY_TONE[value]} subtle>{value}</Badge>;
}

function FieldLabel({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        fontSize: 11,
        fontWeight: 700,
        letterSpacing: "0.16em",
        textTransform: "uppercase",
        color: "var(--ink-muted, #64748b)",
      }}
    >
      {children}
    </div>
  );
}

function Field({
  label,
  value,
}: {
  label: string;
  value: string | null | undefined;
}) {
  return (
    <div>
      <FieldLabel>{label}</FieldLabel>
      <div style={{ marginTop: 4, color: "var(--ink-primary, #0f172a)" }}>
        {value && String(value).trim() ? value : "—"}
      </div>
    </div>
  );
}

type LoadState =
  | { kind: "loading" }
  | { kind: "ok"; details: Details }
  | { kind: "notFound" }
  | { kind: "forbidden" }
  | { kind: "error"; message: string };

export default function AdminContactSalesDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const { addToast } = useToast();
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [updating, setUpdating] = useState(false);
  const [copied, setCopied] = useState(false);

  const load = useCallback(async () => {
    setState({ kind: "loading" });
    try {
      const res = (await apiFetch(
        `/v1/admin/contact-sales/${encodeURIComponent(id)}`
      )) as { ok?: boolean; data?: Details };
      if (res && res.data) {
        setState({ kind: "ok", details: res.data });
      } else {
        setState({ kind: "notFound" });
      }
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.statusCode === 404) {
          setState({ kind: "notFound" });
          return;
        }
        if (err.statusCode === 403) {
          setState({ kind: "forbidden" });
          return;
        }
      }
      setState({
        kind: "error",
        message: toSafeUserError(err, { message: "Failed to load record" }).message,
      });
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  async function patchStatus(next: Status) {
    if (state.kind !== "ok") return;
    setUpdating(true);
    try {
      const res = (await apiFetch(
        `/v1/admin/contact-sales/${encodeURIComponent(id)}`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ status: next }),
        }
      )) as { ok: boolean; data: Details };
      if (res.ok && res.data) {
        setState({ kind: "ok", details: res.data });
        addToast(`Status updated to ${next}`, "success");
      }
    } catch (err) {
      addToast(
        toSafeUserError(err, { message: "Failed to update" }).message,
        "error"
      );
    } finally {
      setUpdating(false);
    }
  }

  async function copyId() {
    try {
      await navigator.clipboard.writeText(id);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // clipboard unavailable — fall back to in-place selection
      addToast("Could not copy — your browser blocked clipboard access.", "error");
    }
  }

  return (
    <PageRouteGate routeId="admin.contactSales">
      <PageShell
        width="full"
        header={
          <PageHeader
            eyebrow="Platform admin"
            title="Contact Sales inquiry"
            subtitle="One-record view of a contact-sales inquiry submitted via the public form. Status updates flow through the same admin API as the list view."
            secondaryActions={
              <Link href="/admin/contact-sales" style={{ textDecoration: "none" }}>
                <Button variant="ghost" size="sm">
                  ← Back to list
                </Button>
              </Link>
            }
          />
        }
      >

        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            alignItems: "center",
            justifyContent: "flex-end",
            gap: 8,
          }}
        >
          <div
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 8,
              borderRadius: 999,
              border: "1px solid var(--border-default, #e2e8f0)",
              background: "var(--surface-card, #ffffff)",
              padding: "6px 12px",
              fontSize: 12,
              color: "var(--ink-secondary, #475569)",
            }}
          >
            <span
              style={{
                fontWeight: 600,
                letterSpacing: "0.14em",
                textTransform: "uppercase",
                color: "var(--ink-muted, #64748b)",
              }}
            >
              Record ID
            </span>
            <code
              style={{
                fontFamily:
                  "ui-monospace, SFMono-Regular, Menlo, monospace",
                fontSize: 12,
                color: "var(--ink-primary, #0f172a)",
              }}
            >
              {id}
            </code>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => void copyId()}
              aria-label="Copy record ID"
            >
              {copied ? "Copied" : "Copy"}
            </Button>
          </div>
        </div>

        {state.kind === "loading" && (
          <Card>
            <Skeleton height="20px" />
            <div style={{ marginTop: 12 }}>
              <Skeleton height="14px" />
            </div>
            <div style={{ marginTop: 12 }}>
              <Skeleton height="14px" />
            </div>
          </Card>
        )}

        {state.kind === "notFound" && (
          <Card variant="empty">
            <div style={{ textAlign: "center", padding: "24px 8px" }}>
              <div
                style={{
                  fontSize: 15,
                  fontWeight: 650,
                  color: "var(--ink-primary, #0f172a)",
                }}
              >
                Record not found
              </div>
              <p
                style={{
                  marginTop: 8,
                  fontSize: 13.5,
                  color: "var(--ink-secondary, #475569)",
                }}
              >
                The contact-sales inquiry you’re looking for has been removed or
                the link is incorrect. Use the list page to find the current
                record.
              </p>
              <div style={{ marginTop: 16 }}>
                <Link href="/admin/contact-sales" style={{ textDecoration: "none" }}>
                  <Button variant="primary" size="sm">
                    Open list
                  </Button>
                </Link>
              </div>
            </div>
          </Card>
        )}

        {state.kind === "forbidden" && (
          <Card variant="empty">
            <div style={{ textAlign: "center", padding: "24px 8px" }}>
              <div
                style={{
                  fontSize: 15,
                  fontWeight: 650,
                  color: "var(--ink-primary, #0f172a)",
                }}
              >
                Admin access required
              </div>
              <p
                style={{
                  marginTop: 8,
                  fontSize: 13.5,
                  color: "var(--ink-secondary, #475569)",
                }}
              >
                You don’t have permission to view this record. Contact your
                workspace administrator if you believe this is in error.
              </p>
            </div>
          </Card>
        )}

        {state.kind === "error" && (
          <Card variant="empty">
            <div style={{ textAlign: "center", padding: "24px 8px" }}>
              <div
                style={{
                  fontSize: 15,
                  fontWeight: 650,
                  color: "var(--ink-primary, #0f172a)",
                }}
              >
                Couldn’t load this record
              </div>
              <p
                style={{
                  marginTop: 8,
                  fontSize: 13.5,
                  color: "var(--ink-secondary, #475569)",
                }}
              >
                {state.message}
              </p>
              <div style={{ marginTop: 16 }}>
                <Button variant="secondary" size="sm" onClick={() => void load()}>
                  Retry
                </Button>
              </div>
            </div>
          </Card>
        )}

        {state.kind === "ok" && (
          <Card
            title={`${state.details.fullName} · ${state.details.organization}`}
            headerAction={
              <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                <StatusPill value={state.details.status} />
                <PriorityPill value={state.details.priority} />
                {state.details.isSpam ? <Badge tone="risk">Spam</Badge> : null}
              </div>
            }
          >
            <div
              style={{
                display: "grid",
                gap: 24,
                gridTemplateColumns: "minmax(0, 1fr) 320px",
              }}
            >
              <div
                style={{
                  display: "flex",
                  flexDirection: "column",
                  gap: 16,
                  fontSize: 14,
                  color: "var(--ink-primary, #0f172a)",
                  minWidth: 0,
                }}
              >
                <div>
                  <FieldLabel>Email</FieldLabel>
                  <div style={{ marginTop: 4 }}>
                    <a
                      href={`mailto:${state.details.workEmail}`}
                      style={{ color: "var(--accent-500, #7C3AED)" }}
                    >
                      {state.details.workEmail}
                    </a>
                  </div>
                </div>

                <div
                  style={{
                    display: "grid",
                    gap: 12,
                    gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))",
                  }}
                >
                  <Field label="Job title" value={state.details.jobTitle} />
                  <Field label="Country" value={state.details.country} />
                  <Field label="Workspace size" value={state.details.teamSize} />
                  <Field
                    label="Deployment timeline"
                    value={state.details.deploymentTimeline}
                  />
                  <Field
                    label="Estimated users"
                    value={state.details.estimatedUsers}
                  />
                  <Field label="Topic" value={state.details.discussionTopic} />
                  <Field label="Stage" value={state.details.stage} />
                  <Field label="Source page" value={state.details.sourcePage} />
                </div>

                <div>
                  <FieldLabel>Current challenge</FieldLabel>
                  <p
                    style={{
                      marginTop: 8,
                      whiteSpace: "pre-wrap",
                      borderRadius: 10,
                      border: "1px solid var(--border-default, #e2e8f0)",
                      background: "var(--surface-muted, #f8fafc)",
                      padding: 12,
                      fontSize: 13.5,
                      lineHeight: 1.6,
                      color: "var(--ink-primary, #0f172a)",
                    }}
                  >
                    {state.details.currentChallenge}
                  </p>
                </div>

                {state.details.additionalDetails ? (
                  <div>
                    <FieldLabel>Additional details</FieldLabel>
                    <p
                      style={{
                        marginTop: 8,
                        whiteSpace: "pre-wrap",
                        borderRadius: 10,
                        border: "1px solid var(--border-default, #e2e8f0)",
                        background: "var(--surface-muted, #f8fafc)",
                        padding: 12,
                        fontSize: 13.5,
                        lineHeight: 1.6,
                        color: "var(--ink-primary, #0f172a)",
                      }}
                    >
                      {state.details.additionalDetails}
                    </p>
                  </div>
                ) : null}
              </div>

              <aside
                style={{
                  display: "flex",
                  flexDirection: "column",
                  gap: 12,
                  fontSize: 12.5,
                  color: "var(--ink-secondary, #475569)",
                }}
              >
                <Field
                  label="Submitted"
                  value={formatTimestamp(state.details.createdAt)}
                />
                <Field
                  label="Updated"
                  value={formatTimestamp(state.details.updatedAt)}
                />
                <Field
                  label="Email sent"
                  value={
                    state.details.emailSentAt
                      ? formatTimestamp(state.details.emailSentAt)
                      : "Not sent"
                  }
                />
                <Field
                  label="Webhook sent"
                  value={
                    state.details.webhookSentAt
                      ? formatTimestamp(state.details.webhookSentAt)
                      : "Not sent"
                  }
                />
                <Field
                  label="Reviewed"
                  value={formatTimestamp(state.details.reviewedAt)}
                />
                <Field label="UTM source" value={state.details.utmSource} />
                <Field label="UTM medium" value={state.details.utmMedium} />
                <Field label="UTM campaign" value={state.details.utmCampaign} />
                <Field label="Referrer" value={state.details.referrer} />
                <Field label="Source path" value={state.details.sourcePath} />

                <div
                  style={{
                    borderTop: "1px solid var(--border-default, #e2e8f0)",
                    paddingTop: 12,
                  }}
                >
                  <FieldLabel>Set status</FieldLabel>
                  <div
                    style={{
                      marginTop: 8,
                      display: "flex",
                      flexWrap: "wrap",
                      gap: 8,
                    }}
                  >
                    {(
                      [
                        "REVIEWED",
                        "CONTACTED",
                        "QUALIFIED",
                        "REJECTED",
                        "ARCHIVED",
                      ] as Status[]
                    ).map((s) => (
                      <Button
                        key={s}
                        variant="secondary"
                        size="sm"
                        disabled={updating || state.details.status === s}
                        onClick={() => void patchStatus(s)}
                      >
                        {s}
                      </Button>
                    ))}
                  </div>
                </div>
              </aside>
            </div>
          </Card>
        )}
      </PageShell>
    </PageRouteGate>
  );
}
