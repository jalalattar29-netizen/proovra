"use client";

// Minimal read-only admin surface for Contact Sales submissions.
// Mirrors /admin/demo-requests structure but intentionally focused:
// list, view body, update status. No follow-up automation, no
// routing, no auto-reply tools — those land in a later phase.

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  Card,
  Button,
  Input,
  Select,
  Skeleton,
  useToast,
} from "../../../../components/ui";
import DashboardShell from "../../../../components/dashboard/DashboardShell";
import AdminConsoleNav from "../../../../components/admin/AdminConsoleNav";
import { apiFetch } from "../../../../lib/api";

type Status =
  | "NEW"
  | "REVIEWED"
  | "CONTACTED"
  | "QUALIFIED"
  | "REJECTED"
  | "ARCHIVED";

type Priority = "LOW" | "NORMAL" | "HIGH";

type ListItem = {
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
  sourcePage: string | null;
  sourcePath: string | null;
  status: Status;
  priority: Priority;
  isSpam: boolean;
  emailSentAt: string | null;
  reviewedAt: string | null;
  reviewedByUserId: string | null;
  createdAt: string;
  updatedAt: string;
};

type Summary = Record<Status, number>;

type Details = ListItem & {
  currentChallenge: string;
  additionalDetails: string | null;
  source: string | null;
  referrer: string | null;
  utmSource: string | null;
  utmMedium: string | null;
  utmCampaign: string | null;
  utmTerm: string | null;
  utmContent: string | null;
  webhookSentAt: string | null;
  notes: string | null;
  ipAddress: string | null;
  userAgent: string | null;
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

export default function AdminContactSalesPage() {
  const { addToast } = useToast();
  const [loading, setLoading] = useState(true);
  const [items, setItems] = useState<ListItem[]>([]);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [statusFilter, setStatusFilter] = useState<Status | "">("");
  const [search, setSearch] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [details, setDetails] = useState<Details | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [updating, setUpdating] = useState(false);

  const queryString = useMemo(() => {
    const p = new URLSearchParams({ limit: "50" });
    if (statusFilter) p.set("status", statusFilter);
    if (search.trim()) p.set("search", search.trim());
    return p.toString();
  }, [statusFilter, search]);

  async function load() {
    setLoading(true);
    try {
      const res = (await apiFetch(
        `/v1/admin/contact-sales?${queryString}`
      )) as { ok: boolean; data: { items: ListItem[]; summary: Summary } };
      if (res.ok) {
        setItems(res.data.items);
        setSummary(res.data.summary);
      }
    } catch (err) {
      addToast(
        err instanceof Error ? err.message : "Failed to load",
        "error"
      );
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queryString]);

  async function openDetails(id: string) {
    setSelectedId(id);
    setDetailLoading(true);
    try {
      const res = (await apiFetch(
        `/v1/admin/contact-sales/${encodeURIComponent(id)}`
      )) as { ok: boolean; data: Details };
      if (res.ok) setDetails(res.data);
    } catch (err) {
      addToast(
        err instanceof Error ? err.message : "Failed to load record",
        "error"
      );
    } finally {
      setDetailLoading(false);
    }
  }

  async function patchStatus(id: string, next: Status) {
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
      if (res.ok) {
        setDetails(res.data);
        await load();
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

  return (
    <DashboardShell
      eyebrow="Contact Sales"
      title="Contact Sales inquiries"
      description={
        <>
          Submissions from the public <code>/contact-sales</code> form.
          Records persist even when notification email is unavailable, so
          operators can replay any missed delivery from the table below.
        </>
      }
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
        <AdminConsoleNav />

        <Card className="p-6">
          <div className="flex items-center justify-between">
            <div className="sr-only">Filters</div>
          </div>

          {summary ? (
            <div className="mt-4 flex flex-wrap gap-2 text-[12px]">
              {(
                [
                  "NEW",
                  "REVIEWED",
                  "CONTACTED",
                  "QUALIFIED",
                  "REJECTED",
                  "ARCHIVED",
                ] as Status[]
              ).map((s) => (
                <button
                  type="button"
                  key={s}
                  onClick={() => setStatusFilter(statusFilter === s ? "" : s)}
                  className="inline-flex items-center gap-2 rounded-full border px-3 py-1 transition"
                  style={{
                    borderColor: `${STATUS_TONE[s]}33`,
                    background:
                      statusFilter === s
                        ? `${STATUS_TONE[s]}1A`
                        : "transparent",
                    color: STATUS_TONE[s],
                  }}
                >
                  <span className="font-semibold">{s}</span>
                  <span>{summary[s] ?? 0}</span>
                </button>
              ))}
            </div>
          ) : null}

          <div className="mt-4 flex flex-wrap items-end gap-3">
            <Input
              value={search}
              onChange={(v) => setSearch(v)}
              placeholder="Search name, email, organization"
              className="min-w-[260px]"
            />
            <Select
              value={statusFilter}
              onChange={(v) => setStatusFilter(v as Status | "")}
              options={[
                { value: "", label: "All statuses" },
                { value: "NEW", label: "New" },
                { value: "REVIEWED", label: "Reviewed" },
                { value: "CONTACTED", label: "Contacted" },
                { value: "QUALIFIED", label: "Qualified" },
                { value: "REJECTED", label: "Rejected" },
                { value: "ARCHIVED", label: "Archived" },
              ]}
            />
            <Button
              variant="secondary"
              onClick={() => {
                setStatusFilter("");
                setSearch("");
              }}
            >
              Reset
            </Button>
          </div>
        </Card>

        <Card className="mt-5 p-0">
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-left text-[13.5px]">
              <thead className="bg-[#F8FAFC]">
                <tr className="text-[11.5px] font-semibold uppercase tracking-[0.14em] text-[#475569]">
                  <th className="px-5 py-3">Submitted</th>
                  <th className="px-5 py-3">Name</th>
                  <th className="px-5 py-3">Organization</th>
                  <th className="px-5 py-3">Topic</th>
                  <th className="px-5 py-3">Stage</th>
                  <th className="px-5 py-3">Priority</th>
                  <th className="px-5 py-3">Status</th>
                  <th className="px-5 py-3">Email</th>
                  <th className="px-5 py-3" />
                </tr>
              </thead>
              <tbody>
                {loading
                  ? Array.from({ length: 6 }).map((_, i) => (
                      <tr key={i} className="border-t border-[#E2E8F0]">
                        <td className="px-5 py-3" colSpan={9}>
                          <Skeleton height="18px" />
                        </td>
                      </tr>
                    ))
                  : items.length === 0
                    ? (
                        <tr className="border-t border-[#E2E8F0]">
                          <td
                            className="px-5 py-8 text-center text-[#64748B]"
                            colSpan={9}
                          >
                            No contact-sales inquiries match your filters.
                          </td>
                        </tr>
                      )
                    : items.map((it) => (
                        <tr
                          key={it.id}
                          className="border-t border-[#E2E8F0] hover:bg-[#F8FAFC]"
                        >
                          <td className="px-5 py-3 text-[#475569]">
                            {formatTimestamp(it.createdAt)}
                          </td>
                          <td className="px-5 py-3">
                            <div className="font-semibold text-[#0F172A]">
                              {it.fullName}
                            </div>
                            <div className="text-[12px] text-[#475569]">
                              {it.workEmail}
                            </div>
                          </td>
                          <td className="px-5 py-3 text-[#0F172A]">
                            {it.organization}
                          </td>
                          <td className="px-5 py-3 text-[#475569]">
                            {it.discussionTopic}
                          </td>
                          <td className="px-5 py-3 text-[#475569]">
                            {it.stage}
                          </td>
                          <td className="px-5 py-3">
                            <PriorityPill value={it.priority} />
                          </td>
                          <td className="px-5 py-3">
                            <StatusPill value={it.status} />
                          </td>
                          <td className="px-5 py-3 text-[12px] text-[#64748B]">
                            {it.emailSentAt ? "Sent" : "—"}
                          </td>
                          <td className="px-5 py-3 text-right">
                            <div className="inline-flex items-center gap-2">
                              <Button
                                variant="secondary"
                                onClick={() => openDetails(it.id)}
                              >
                                Quick view
                              </Button>
                              <Link
                                href={`/admin/contact-sales/${encodeURIComponent(it.id)}`}
                                className="inline-flex items-center rounded-full border border-[#E2E8F0] bg-white px-3 py-1.5 text-[12px] font-semibold text-[#0F172A] hover:bg-[#F8FAFC]"
                              >
                                Open →
                              </Link>
                            </div>
                          </td>
                        </tr>
                      ))}
              </tbody>
            </table>
          </div>
        </Card>

        {selectedId ? (
          <Card className="mt-5 p-6">
            <div className="flex items-center justify-between">
              <h2 className="text-[1.1rem] font-semibold tracking-[-0.01em] text-[#0F172A]">
                {detailLoading
                  ? "Loading…"
                  : details
                    ? `${details.fullName} · ${details.organization}`
                    : "Record"}
              </h2>
              <Button
                variant="secondary"
                onClick={() => {
                  setSelectedId(null);
                  setDetails(null);
                }}
              >
                Close
              </Button>
            </div>

            {details ? (
              <div className="mt-4 grid gap-6 lg:grid-cols-[1fr_320px]">
                <div className="space-y-4 text-[14px] text-[#0F172A]">
                  <div className="flex flex-wrap gap-2">
                    <StatusPill value={details.status} />
                    <PriorityPill value={details.priority} />
                    {details.isSpam ? (
                      <span className="inline-flex items-center rounded-full border border-[#FCA5A5] bg-[#FEF2F2] px-2.5 py-0.5 text-[11px] font-semibold uppercase tracking-[0.12em] text-[#9C1C1C]">
                        Spam
                      </span>
                    ) : null}
                  </div>

                  <div>
                    <div className="text-[11px] font-semibold uppercase tracking-[0.16em] text-[#64748B]">
                      Email
                    </div>
                    <div className="mt-1 text-[#0F172A]">{details.workEmail}</div>
                  </div>

                  <div className="grid gap-3 sm:grid-cols-2">
                    <Field label="Job title" value={details.jobTitle} />
                    <Field label="Country" value={details.country} />
                    <Field label="Workspace size" value={details.teamSize} />
                    <Field
                      label="Deployment timeline"
                      value={details.deploymentTimeline}
                    />
                    <Field
                      label="Estimated users"
                      value={details.estimatedUsers}
                    />
                    <Field label="Topic" value={details.discussionTopic} />
                    <Field label="Stage" value={details.stage} />
                    <Field label="Source page" value={details.sourcePage} />
                  </div>

                  <div>
                    <div className="text-[11px] font-semibold uppercase tracking-[0.16em] text-[#64748B]">
                      Current challenge
                    </div>
                    <p className="mt-2 whitespace-pre-wrap rounded-lg border border-[#E2E8F0] bg-[#F8FAFC] p-3 text-[13.5px] leading-[1.6] text-[#0F172A]">
                      {details.currentChallenge}
                    </p>
                  </div>

                  {details.additionalDetails ? (
                    <div>
                      <div className="text-[11px] font-semibold uppercase tracking-[0.16em] text-[#64748B]">
                        Additional details
                      </div>
                      <p className="mt-2 whitespace-pre-wrap rounded-lg border border-[#E2E8F0] bg-[#F8FAFC] p-3 text-[13.5px] leading-[1.6] text-[#0F172A]">
                        {details.additionalDetails}
                      </p>
                    </div>
                  ) : null}
                </div>

                <aside className="space-y-3 text-[12.5px] text-[#475569]">
                  <Field
                    label="Submitted"
                    value={formatTimestamp(details.createdAt)}
                  />
                  <Field
                    label="Email sent"
                    value={
                      details.emailSentAt
                        ? formatTimestamp(details.emailSentAt)
                        : "Not sent"
                    }
                  />
                  <Field
                    label="Reviewed"
                    value={formatTimestamp(details.reviewedAt)}
                  />
                  <Field label="UTM source" value={details.utmSource} />
                  <Field label="UTM campaign" value={details.utmCampaign} />
                  <Field label="Referrer" value={details.referrer} />
                  <Field label="Source path" value={details.sourcePath} />

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
                          disabled={updating || details.status === s}
                          onClick={() => patchStatus(details.id, s)}
                        >
                          {s}
                        </Button>
                      ))}
                    </div>
                  </div>
                </aside>
              </div>
            ) : null}
          </Card>
        ) : null}
      </div>
    </DashboardShell>
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
      <div className="mt-1 text-[#0F172A]">{value && value.trim() ? value : "—"}</div>
    </div>
  );
}
