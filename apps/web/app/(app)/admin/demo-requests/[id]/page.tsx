"use client";

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
  Card,
  Button,
  Skeleton,
  useToast,
} from "../../../../../components/ui";
import DashboardShell from "../../../../../components/dashboard/DashboardShell";
import AdminConsoleNav from "../../../../../components/admin/AdminConsoleNav";
import { PageRouteGate } from "../../../../../components/navigation/PageRouteGate";
import { apiFetch, ApiError } from "../../../../../lib/api";

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
  return date.toLocaleString();
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
          err instanceof Error ? err.message : "Failed to load demo request",
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

  return (
    <PageRouteGate routeId="admin.demoRequests">
    <DashboardShell
      eyebrow="Demo Requests"
      title="Request detail"
      description={
        <>
          One-record view of an inbound demo request. Routing, follow-up,
          and review controls are managed from the list page; this page is
          a focused inspection surface for the deep-link landing.
        </>
      }
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
        <AdminConsoleNav />

        <div className="flex flex-wrap items-center justify-between gap-3">
          <Link
            href="/admin/demo-requests"
            className="inline-flex items-center gap-2 rounded-full border border-[#E2E8F0] bg-white px-4 py-2 text-[13px] font-semibold text-[#0F172A] transition hover:bg-[#F8FAFC]"
          >
            <span aria-hidden>←</span> Back to list
          </Link>

          <div className="inline-flex items-center gap-2 rounded-full border border-[#E2E8F0] bg-white px-3 py-1.5 text-[12px] text-[#475569]">
            <span className="font-semibold uppercase tracking-[0.14em] text-[#64748B]">
              Request ID
            </span>
            <code className="font-mono text-[12px] text-[#0F172A]">{id}</code>
            <button
              type="button"
              onClick={() => void copyId()}
              className="rounded-md border border-[#E2E8F0] px-2 py-0.5 text-[11px] font-semibold text-[#475569] hover:bg-[#F8FAFC] hover:text-[#0F172A]"
              aria-label="Copy request ID"
            >
              {copied ? "Copied" : "Copy"}
            </button>
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
            <div className="text-[15px] font-semibold text-[#0F172A]">
              Request not found
            </div>
            <p className="mt-2 text-[13.5px] text-[#475569]">
              The demo request you’re looking for has been removed or the
              link is incorrect.
            </p>
            <div className="mt-4">
              <Link
                href="/admin/demo-requests"
                className="inline-flex items-center gap-2 rounded-full bg-[#0F172A] px-5 py-2 text-[13px] font-semibold text-white"
              >
                Open list
              </Link>
            </div>
          </Card>
        )}

        {state.kind === "forbidden" && (
          <Card className="p-8 text-center">
            <div className="text-[15px] font-semibold text-[#0F172A]">
              Admin access required
            </div>
            <p className="mt-2 text-[13.5px] text-[#475569]">
              You don’t have permission to view this record. Contact your
              workspace administrator if you believe this is in error.
            </p>
          </Card>
        )}

        {state.kind === "error" && (
          <Card className="p-8 text-center">
            <div className="text-[15px] font-semibold text-[#0F172A]">
              Couldn’t load this record
            </div>
            <p className="mt-2 text-[13.5px] text-[#475569]">{state.message}</p>
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
                <h2 className="text-[1.15rem] font-semibold tracking-[-0.01em] text-[#0F172A]">
                  {state.details.fullName}
                </h2>
                <p className="mt-1 text-[13.5px] text-[#475569]">
                  {state.details.workEmail} ·{" "}
                  {state.details.organization ?? "No organization"} ·{" "}
                  {state.details.jobTitle ?? "No title"} ·{" "}
                  {state.details.country ?? "No country"}
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                <span className="inline-flex items-center rounded-full border border-[#E2E8F0] bg-[#F8FAFC] px-2.5 py-0.5 text-[11px] font-semibold uppercase tracking-[0.12em] text-[#0F172A]">
                  {state.details.status}
                </span>
                <span className="inline-flex items-center rounded-full border border-[#E2E8F0] bg-[#F8FAFC] px-2.5 py-0.5 text-[11px] font-semibold uppercase tracking-[0.12em] text-[#0F172A]">
                  {state.details.priority}
                </span>
                {state.details.isSpam ? (
                  <span className="inline-flex items-center rounded-full border border-[#FCA5A5] bg-[#FEF2F2] px-2.5 py-0.5 text-[11px] font-semibold uppercase tracking-[0.12em] text-[#9C1C1C]">
                    Spam {state.details.spamScore}
                  </span>
                ) : (
                  <span className="inline-flex items-center rounded-full border border-[#BBF7D0] bg-[#F0FDF4] px-2.5 py-0.5 text-[11px] font-semibold uppercase tracking-[0.12em] text-[#15803D]">
                    Clean {state.details.spamScore}
                  </span>
                )}
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
                <p className="whitespace-pre-wrap rounded-lg border border-[#E2E8F0] bg-[#F8FAFC] p-3 text-[13.5px] leading-[1.6] text-[#0F172A]">
                  {state.details.useCase}
                </p>
              </Box>

              <Box title="Message">
                <p className="whitespace-pre-wrap rounded-lg border border-[#E2E8F0] bg-[#F8FAFC] p-3 text-[13.5px] leading-[1.6] text-[#0F172A]">
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
                <Row label="User agent" value={state.details.userAgent ?? "—"} />
              </Box>
            </div>

            <div className="mt-6 flex flex-wrap gap-3">
              <Link
                href={`/admin/demo-requests?id=${encodeURIComponent(state.details.id)}`}
                className="inline-flex items-center gap-2 rounded-full bg-[#0F172A] px-5 py-2 text-[13px] font-semibold text-white hover:bg-[#1E293B]"
              >
                Open full controls in list view
              </Link>
              <a
                href={`mailto:${state.details.workEmail}`}
                className="inline-flex items-center gap-2 rounded-full border border-[#E2E8F0] bg-white px-5 py-2 text-[13px] font-semibold text-[#0F172A] hover:bg-[#F8FAFC]"
              >
                Reply via email
              </a>
            </div>
          </Card>
        )}
      </div>
    </DashboardShell>
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
    <div className="rounded-xl border border-[#E2E8F0] bg-white p-4">
      <div className="text-[11px] font-semibold uppercase tracking-[0.16em] text-[#64748B]">
        {title}
      </div>
      <div className="mt-3 space-y-2 text-[13.5px] text-[#0F172A]">
        {children}
      </div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-3 border-b border-[#EEF2F6] pb-1.5 last:border-0">
      <span className="text-[12px] font-medium text-[#64748B]">{label}</span>
      <span className="text-right text-[13.5px] text-[#0F172A]">{value}</span>
    </div>
  );
}

function Pre({ title, value }: { title: string; value: string }) {
  return (
    <div>
      <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-[#64748B]">
        {title}
      </div>
      <pre className="mt-1 whitespace-pre-wrap break-words rounded-lg border border-[#E2E8F0] bg-[#F8FAFC] p-2 text-[11.5px] leading-[1.5] text-[#475569]">
        {value}
      </pre>
    </div>
  );
}
