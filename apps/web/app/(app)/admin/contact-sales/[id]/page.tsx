"use client";

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
  Card,
  Button,
  Skeleton,
  useToast,
} from "../../../../../components/ui";
import DashboardShell from "../../../../../components/dashboard/DashboardShell";
import AdminConsoleNav from "../../../../../components/admin/AdminConsoleNav";
import { apiFetch, ApiError } from "../../../../../lib/api";

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
  return Number.isNaN(d.getTime()) ? value : d.toLocaleString();
}

const STATUS_TONE: Record<Status, string> = {
  NEW: "#1d4ed8",
  REVIEWED: "#0e7490",
  CONTACTED: "#7c3aed",
  QUALIFIED: "#0f9b6c",
  REJECTED: "#9c2626",
  ARCHIVED: "#475569",
};

const PRIORITY_TONE: Record<Priority, string> = {
  LOW: "#475569",
  NORMAL: "#1d4ed8",
  HIGH: "#9d174d",
};

function StatusPill({ value }: { value: Status }) {
  return (
    <span
      className="inline-flex items-center rounded-full border px-2.5 py-0.5 text-[11px] font-semibold uppercase tracking-[0.12em]"
      style={{
        borderColor: `${STATUS_TONE[value]}33`,
        background: `${STATUS_TONE[value]}10`,
        color: STATUS_TONE[value],
      }}
    >
      {value}
    </span>
  );
}

function PriorityPill({ value }: { value: Priority }) {
  return (
    <span
      className="inline-flex items-center rounded-full border px-2.5 py-0.5 text-[11px] font-semibold uppercase tracking-[0.12em]"
      style={{
        borderColor: `${PRIORITY_TONE[value]}33`,
        background: `${PRIORITY_TONE[value]}10`,
        color: PRIORITY_TONE[value],
      }}
    >
      {value}
    </span>
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
      <div className="text-[11px] font-semibold uppercase tracking-[0.16em] text-[#64748B]">
        {label}
      </div>
      <div className="mt-1 text-[#0F172A]">
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
        message: err instanceof Error ? err.message : "Failed to load record",
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
        err instanceof Error ? err.message : "Failed to update",
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
    <DashboardShell
      eyebrow="Contact Sales"
      title="Inquiry detail"
      description={
        <>
          One-record view of a contact-sales inquiry submitted via the public
          form. Status updates flow through the same admin API as the list
          view.
        </>
      }
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
        <AdminConsoleNav />

        <div className="flex flex-wrap items-center justify-between gap-3">
          <Link
            href="/admin/contact-sales"
            className="inline-flex items-center gap-2 rounded-full border border-[#E2E8F0] bg-white px-4 py-2 text-[13px] font-semibold text-[#0F172A] transition hover:bg-[#F8FAFC]"
          >
            <span aria-hidden>←</span> Back to list
          </Link>

          <div className="inline-flex items-center gap-2 rounded-full border border-[#E2E8F0] bg-white px-3 py-1.5 text-[12px] text-[#475569]">
            <span className="font-semibold uppercase tracking-[0.14em] text-[#64748B]">
              Record ID
            </span>
            <code className="font-mono text-[12px] text-[#0F172A]">{id}</code>
            <button
              type="button"
              onClick={() => void copyId()}
              className="rounded-md border border-[#E2E8F0] px-2 py-0.5 text-[11px] font-semibold text-[#475569] hover:bg-[#F8FAFC] hover:text-[#0F172A]"
              aria-label="Copy record ID"
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
              Record not found
            </div>
            <p className="mt-2 text-[13.5px] text-[#475569]">
              The contact-sales inquiry you’re looking for has been removed or
              the link is incorrect. Use the list page to find the current
              record.
            </p>
            <div className="mt-4">
              <Link
                href="/admin/contact-sales"
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
            <p className="mt-2 text-[13.5px] text-[#475569]">
              {state.message}
            </p>
            <div className="mt-4">
              <Button variant="secondary" onClick={() => void load()}>
                Retry
              </Button>
            </div>
          </Card>
        )}

        {state.kind === "ok" && (
          <Card className="p-6">
            <div className="flex items-center justify-between gap-3">
              <h2 className="text-[1.15rem] font-semibold tracking-[-0.01em] text-[#0F172A]">
                {state.details.fullName} · {state.details.organization}
              </h2>
              <div className="flex flex-wrap gap-2">
                <StatusPill value={state.details.status} />
                <PriorityPill value={state.details.priority} />
                {state.details.isSpam ? (
                  <span className="inline-flex items-center rounded-full border border-[#FCA5A5] bg-[#FEF2F2] px-2.5 py-0.5 text-[11px] font-semibold uppercase tracking-[0.12em] text-[#9C1C1C]">
                    Spam
                  </span>
                ) : null}
              </div>
            </div>

            <div className="mt-5 grid gap-6 lg:grid-cols-[1fr_320px]">
              <div className="space-y-4 text-[14px] text-[#0F172A]">
                <div>
                  <div className="text-[11px] font-semibold uppercase tracking-[0.16em] text-[#64748B]">
                    Email
                  </div>
                  <div className="mt-1">
                    <a
                      href={`mailto:${state.details.workEmail}`}
                      className="text-[#2563EB] hover:underline"
                    >
                      {state.details.workEmail}
                    </a>
                  </div>
                </div>

                <div className="grid gap-3 sm:grid-cols-2">
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
                  <div className="text-[11px] font-semibold uppercase tracking-[0.16em] text-[#64748B]">
                    Current challenge
                  </div>
                  <p className="mt-2 whitespace-pre-wrap rounded-lg border border-[#E2E8F0] bg-[#F8FAFC] p-3 text-[13.5px] leading-[1.6] text-[#0F172A]">
                    {state.details.currentChallenge}
                  </p>
                </div>

                {state.details.additionalDetails ? (
                  <div>
                    <div className="text-[11px] font-semibold uppercase tracking-[0.16em] text-[#64748B]">
                      Additional details
                    </div>
                    <p className="mt-2 whitespace-pre-wrap rounded-lg border border-[#E2E8F0] bg-[#F8FAFC] p-3 text-[13.5px] leading-[1.6] text-[#0F172A]">
                      {state.details.additionalDetails}
                    </p>
                  </div>
                ) : null}
              </div>

              <aside className="space-y-3 text-[12.5px] text-[#475569]">
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
                <Field
                  label="UTM source"
                  value={state.details.utmSource}
                />
                <Field
                  label="UTM medium"
                  value={state.details.utmMedium}
                />
                <Field
                  label="UTM campaign"
                  value={state.details.utmCampaign}
                />
                <Field label="Referrer" value={state.details.referrer} />
                <Field label="Source path" value={state.details.sourcePath} />

                <div className="border-t border-[#E2E8F0] pt-3">
                  <div className="text-[11px] font-semibold uppercase tracking-[0.16em] text-[#64748B]">
                    Set status
                  </div>
                  <div className="mt-2 flex flex-wrap gap-2">
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
      </div>
    </DashboardShell>
  );
}
