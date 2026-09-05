"use client";
import { toSafeUserError } from "../../../../../lib/feedback/toSafeUserError";

// Admin detail route for a single demo request.
//
// Reached from the email "Open in admin console" CTA
// (app.proovra.com/admin/demo-requests/<id>) and from the list page's
// per-row link.
//
// Auth model:
//   - The (app) route group's layout enforces signed-in user.
//   - The backing /v1/admin/demo-requests/:id endpoint is gated by
//     requirePlatformAdmin server-side. Non-admin users get 403 from
//     the API and see a forbidden state here.

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
import { describeClient } from "../../../../../lib/ui/describeClient";
import { useAdminEntityCrumb } from "../../../../../components/admin/AdminEntityCrumb";

type DemoStatus =
  | "NEW"
  | "REVIEWED"
  | "CONTACTED"
  | "QUALIFIED"
  | "REJECTED"
  | "ARCHIVED";

type DemoPriority = "LOW" | "NORMAL" | "HIGH";
type DemoLeadQuality = "LOW" | "MEDIUM" | "HIGH";
type DemoLeadTrack = "DISCOVERY" | "SALES" | "ENTERPRISE";
type DemoRecommendedAction =
  | "reply_with_resources"
  | "offer_demo"
  | "route_enterprise";
type DemoRoutingTarget =
  | "AUTO_RESOURCES"
  | "AUTO_BOOKING"
  | "MANUAL_SALES"
  | "ENTERPRISE_DESK";
type DemoFollowUpStatus =
  | "ACTIVE"
  | "PAUSED"
  | "COMPLETED"
  | "REPLIED"
  | "STOPPED";

type Details = {
  id: string;
  fullName: string;
  workEmail: string;
  organization: string | null;
  jobTitle: string | null;
  country: string | null;
  teamSize: string | null;
  useCase: string;
  message: string | null;

  source: string | null;
  sourcePath: string | null;
  referrer: string | null;
  utmSource: string | null;
  utmMedium: string | null;
  utmCampaign: string | null;
  utmTerm: string | null;
  utmContent: string | null;

  status: DemoStatus;
  priority: DemoPriority;

  leadQuality: DemoLeadQuality | null;
  leadTrack: DemoLeadTrack | null;
  recommendedAction: DemoRecommendedAction | null;

  responseSlaHours: number | null;
  qualificationScore: number | null;
  qualificationReasons: unknown;

  routingTarget: DemoRoutingTarget | null;
  routingReason: string | null;
  routedAt: string | null;
  routedByUserId: string | null;

  followUpStatus: DemoFollowUpStatus;
  followUpStep: number;
  nextFollowUpAt: string | null;
  lastFollowUpSentAt: string | null;
  lastFollowUpTemplateKey: string | null;
  followUpStoppedAt: string | null;

  spamScore: number;
  spamReasons: unknown;
  isSpam: boolean;

  emailSentAt: string | null;
  autoReplySentAt: string | null;
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
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return formatUserDateTime(value);
}

function prettyJson(value: unknown) {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function titleCaseToken(value?: string | null) {
  if (!value) return "—";
  return value
    .replaceAll("_", " ")
    .toLowerCase()
    .replace(/\b\w/g, (m) => m.toUpperCase());
}

function statusTone(status: DemoStatus): BadgeTone {
  switch (status) {
    case "QUALIFIED":
      return "verified";
    case "CONTACTED":
    case "REVIEWED":
      return "pending";
    case "REJECTED":
    case "ARCHIVED":
      return "risk";
    default:
      return "info";
  }
}

function priorityTone(priority: DemoPriority): BadgeTone {
  switch (priority) {
    case "HIGH":
      return "risk";
    case "LOW":
      return "neutral";
    default:
      return "pending";
  }
}

type LoadState =
  | { kind: "loading" }
  | { kind: "ok"; details: Details }
  | { kind: "notFound" }
  | { kind: "forbidden" }
  | { kind: "error"; message: string };

export default function AdminDemoRequestDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const { addToast } = useToast();
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [copied, setCopied] = useState(false);

  const load = useCallback(async () => {
    setState({ kind: "loading" });
    try {
      const res = (await apiFetch(
        `/v1/admin/demo-requests/${encodeURIComponent(id)}`
      )) as { item?: Details | null };
      const item = res?.item ?? null;
      if (item) {
        setState({ kind: "ok", details: item });
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
        message:
          toSafeUserError(err, { message: "Failed to load demo request" }).message,
      });
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  async function copyId() {
    try {
      await navigator.clipboard.writeText(id);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      addToast("Could not copy — your browser blocked clipboard access.", "error");
    }
  }

  const requestTitle =
    state.kind === "ok" ? state.details.fullName : "Request detail";
  const requestSubtitle =
    state.kind === "ok" && state.details.organization
      ? `${state.details.organization} · One-record view of an inbound demo request.`
      : "One-record view of an inbound demo request. Routing, follow-up, and review controls are managed from the list page; this page is a focused inspection surface for the deep-link landing.";

  // PHASE 6 §6 — name this record in the breadcrumb. Null while loading or
  // when the record is gone, so the crumb falls back to the type name
  // rather than going blank or inventing one.
  useAdminEntityCrumb(state.kind === "ok" ? (state.details.organization ?? state.details.fullName ?? null) : null);

  return (
    <PageRouteGate routeId="admin.demoRequests">
    <PageShell
      width="full"
      header={
        <PageHeader
          eyebrow="Platform admin"
          title={requestTitle}
          subtitle={requestSubtitle}
          secondaryActions={
            <Link href="/admin/demo-requests" style={{ textDecoration: "none" }}>
              <Button variant="ghost" size="sm">
                ← Back to list
              </Button>
            </Link>
          }
        />
      }
    >

      <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
        <div className="flex flex-wrap items-center justify-end gap-3">
          <div
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 8,
              borderRadius: 999,
              border: "1px solid var(--border-default, rgba(15,23,42,0.09))",
              background: "var(--surface-card, #ffffff)",
              padding: "6px 12px",
              fontSize: 12,
              color: "var(--ink-secondary, #475569)",
            }}
          >
            <span
              style={{
                fontWeight: 700,
                textTransform: "uppercase",
                letterSpacing: "0.14em",
                color: "var(--ink-muted, #94a3b8)",
              }}
            >
              Request ID
            </span>
            <code
              style={{
                fontFamily: "var(--font-mono, ui-monospace, monospace)",
                fontSize: 12,
                color: "var(--ink-primary, #0f172a)",
              }}
            >
              {id}
            </code>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => void copyId()}
              aria-label="Copy request ID"
            >
              {copied ? "Copied" : "Copy"}
            </Button>
          </div>
        </div>

        {state.kind === "loading" && (
          <Card className="p-6">
            <Skeleton height="20px" />
            <div className="mt-3">
              <Skeleton height="14px" />
            </div>
            <div className="mt-3">
              <Skeleton height="14px" />
            </div>
          </Card>
        )}

        {state.kind === "notFound" && (
          <Card className="p-8 text-center">
            <div className="text-[15px] font-semibold text-[var(--ink-primary)]">
              Request not found
            </div>
            <p className="mt-2 text-[13.5px] text-[var(--ink-secondary)]">
              The demo request you’re looking for has been removed or the
              link is incorrect.
            </p>
            <div className="mt-4">
              <Link
                href="/admin/demo-requests"
                className="inline-flex items-center gap-2 rounded-full bg-[var(--ink-primary)] px-5 py-2 text-[13px] font-semibold text-white"
              >
                Open list
              </Link>
            </div>
          </Card>
        )}

        {state.kind === "forbidden" && (
          <Card className="p-8 text-center">
            <div className="text-[15px] font-semibold text-[var(--ink-primary)]">
              Admin access required
            </div>
            <p className="mt-2 text-[13.5px] text-[var(--ink-secondary)]">
              You don’t have permission to view this record. Contact your
              workspace administrator if you believe this is in error.
            </p>
          </Card>
        )}

        {state.kind === "error" && (
          <Card className="p-8 text-center">
            <div className="text-[15px] font-semibold text-[var(--ink-primary)]">
              Couldn’t load this record
            </div>
            <p className="mt-2 text-[13.5px] text-[var(--ink-secondary)]">{state.message}</p>
            <div className="mt-4">
              <Button variant="secondary" onClick={() => void load()}>
                Retry
              </Button>
            </div>
          </Card>
        )}

        {state.kind === "ok" && (
          <Card className="p-6">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h2 className="text-[1.15rem] font-semibold tracking-[-0.01em] text-[var(--ink-primary)]">
                  {state.details.fullName}
                </h2>
                <p className="mt-1 text-[13.5px] text-[var(--ink-secondary)]">
                  {state.details.workEmail} ·{" "}
                  {state.details.organization ?? "No organization"} ·{" "}
                  {state.details.jobTitle ?? "No title"} ·{" "}
                  {state.details.country ?? "No country"}
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                <Badge tone={statusTone(state.details.status)}>
                  {state.details.status}
                </Badge>
                <Badge tone={priorityTone(state.details.priority)}>
                  {state.details.priority}
                </Badge>
                <Badge tone={state.details.isSpam ? "risk" : "verified"} dot>
                  {state.details.isSpam
                    ? `Spam ${state.details.spamScore}`
                    : `Clean ${state.details.spamScore}`}
                </Badge>
              </div>
            </div>

            <div className="mt-6 grid gap-5 lg:grid-cols-2">
              <Box title="Qualification">
                <Row label="Lead quality" value={titleCaseToken(state.details.leadQuality)} />
                <Row label="Lead track" value={titleCaseToken(state.details.leadTrack)} />
                <Row label="Recommended action" value={titleCaseToken(state.details.recommendedAction)} />
                <Row label="Response SLA" value={state.details.responseSlaHours != null ? `${state.details.responseSlaHours}h` : "—"} />
                <Row label="Qualification score" value={state.details.qualificationScore != null ? String(state.details.qualificationScore) : "—"} />
                <Pre title="Qualification reasons" value={prettyJson(state.details.qualificationReasons)} />
              </Box>

              <Box title="Identity & Source">
                <Row label="Source" value={state.details.source ?? "—"} />
                <Row label="Source path" value={state.details.sourcePath ?? "—"} />
                <Row label="Referrer" value={state.details.referrer ?? "—"} />
                <Row label="UTM source" value={state.details.utmSource ?? "—"} />
                <Row label="UTM medium" value={state.details.utmMedium ?? "—"} />
                <Row label="UTM campaign" value={state.details.utmCampaign ?? "—"} />
                <Row label="UTM term" value={state.details.utmTerm ?? "—"} />
                <Row label="UTM content" value={state.details.utmContent ?? "—"} />
                <Row label="Workspace size" value={state.details.teamSize ?? "—"} />
              </Box>

              <Box title="Use case">
                <p className="whitespace-pre-wrap rounded-lg border border-[var(--border-default)] bg-[var(--surface-header)] p-3 text-[13.5px] leading-[1.6] text-[var(--ink-primary)]">
                  {state.details.useCase}
                </p>
              </Box>

              <Box title="Message">
                <p className="whitespace-pre-wrap rounded-lg border border-[var(--border-default)] bg-[var(--surface-header)] p-3 text-[13.5px] leading-[1.6] text-[var(--ink-primary)]">
                  {state.details.message ?? "—"}
                </p>
              </Box>

              <Box title="Routing">
                <Row label="Target" value={titleCaseToken(state.details.routingTarget)} />
                <Row label="Reason" value={state.details.routingReason ?? "—"} />
                <Row label="Routed at" value={formatTimestamp(state.details.routedAt)} />
                <Row label="Routed by" value={state.details.routedByUserId ?? "—"} />
              </Box>

              <Box title="Follow-up">
                <Row label="Status" value={state.details.followUpStatus} />
                <Row label="Step" value={String(state.details.followUpStep)} />
                <Row label="Next scheduled" value={formatTimestamp(state.details.nextFollowUpAt)} />
                <Row label="Last sent" value={formatTimestamp(state.details.lastFollowUpSentAt)} />
                <Row label="Template key" value={state.details.lastFollowUpTemplateKey ?? "—"} />
                <Row label="Stopped at" value={formatTimestamp(state.details.followUpStoppedAt)} />
              </Box>

              <Box title="Delivery & Spam">
                <Row label="Email sent" value={formatTimestamp(state.details.emailSentAt)} />
                <Row label="Auto reply sent" value={formatTimestamp(state.details.autoReplySentAt)} />
                <Row label="Webhook sent" value={formatTimestamp(state.details.webhookSentAt)} />
                <Row label="Spam flagged" value={state.details.isSpam ? `Yes (${state.details.spamScore})` : `No (${state.details.spamScore})`} />
                <Pre title="Spam reasons" value={prettyJson(state.details.spamReasons)} />
              </Box>

              <Box title="Internal metadata">
                <Row label="Created" value={formatTimestamp(state.details.createdAt)} />
                <Row label="Updated" value={formatTimestamp(state.details.updatedAt)} />
                <Row label="Reviewed at" value={formatTimestamp(state.details.reviewedAt)} />
                <Row label="Reviewed by" value={state.details.reviewedByUserId ?? "—"} />
                <Row label="Notes" value={state.details.notes ?? "—"} />
                <Row label="IP" value={state.details.ipAddress ?? "—"} />
                <Row
                  label="Client"
                  value={describeClient(state.details.userAgent) ?? "Unrecognised client"}
                />
              </Box>
            </div>

            <div className="mt-6 flex flex-wrap gap-3">
              <Link
                href={`/admin/demo-requests?id=${encodeURIComponent(state.details.id)}`}
                className="inline-flex min-h-[44px] items-center gap-2 rounded-full bg-[var(--ink-primary)] px-5 py-2 text-[13px] font-semibold text-white hover:bg-[var(--ink-primary)]"
              >
                Open full controls in list view
              </Link>
              <a
                href={`mailto:${state.details.workEmail}`}
                className="inline-flex min-h-[44px] items-center gap-2 rounded-full border border-[var(--border-default)] bg-white px-5 py-2 text-[13px] font-semibold text-[var(--ink-primary)] hover:bg-[var(--surface-header)]"
              >
                Reply via email
              </a>
            </div>
          </Card>
        )}
      </div>
    </PageShell>
    </PageRouteGate>
  );
}

function Box({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-xl border border-[var(--border-default)] bg-white p-4">
      <div className="text-[11px] font-semibold uppercase tracking-[0.16em] text-[var(--ink-muted)]">
        {title}
      </div>
      <div className="mt-3 space-y-2 text-[13.5px] text-[var(--ink-primary)]">
        {children}
      </div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-3 border-b border-[var(--surface-muted)] pb-1.5 last:border-0">
      <span className="text-[12px] font-medium text-[var(--ink-muted)]">{label}</span>
      <span className="text-right text-[13.5px] text-[var(--ink-primary)]">{value}</span>
    </div>
  );
}

function Pre({ title, value }: { title: string; value: string }) {
  return (
    <div>
      <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-[var(--ink-muted)]">
        {title}
      </div>
      <pre className="mt-1 whitespace-pre-wrap break-words rounded-lg border border-[var(--border-default)] bg-[var(--surface-header)] p-2 text-[11.5px] leading-[1.5] text-[var(--ink-secondary)]">
        {value}
      </pre>
    </div>
  );
}
