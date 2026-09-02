"use client";
import { toSafeUserError } from "../../../../lib/feedback/toSafeUserError";

// Minimal read-only admin surface for Contact Sales submissions.
// Mirrors /admin/demo-requests structure but intentionally focused:
// list, view body, update status. No follow-up automation, no
// routing, no auto-reply tools — those land in a later phase.

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  PageShell,
  PageHeader,
  Input,
  Select,
  Skeleton,
  useToast,
} from "../../../../components/ui";
import { Card } from "../../../../components/ui/Card";
import { Badge } from "../../../../components/ui/Badge";
import type { BadgeTone } from "../../../../components/ui/Badge";
import { Button } from "../../../../components/ui/Button";
import { apiFetch } from "../../../../lib/api";
import { formatUserDateTime } from "../../../../lib/date";
import { ResultCount } from "../../../../components/ui/ResultCount";

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
        toSafeUserError(err, { message: "Failed to load" }).message,
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
        toSafeUserError(err, { message: "Failed to load record" }).message,
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
        toSafeUserError(err, { message: "Failed to update" }).message,
        "error"
      );
    } finally {
      setUpdating(false);
    }
  }

  return (
    <PageShell
      width="full"
      header={
        <PageHeader
          eyebrow="Platform admin"
          title="Contact Sales"
          subtitle="Submissions from the public /contact-sales form. Records persist even when the notification email is unavailable, so operators can replay any missed delivery from the table below."
        />
      }
    >

      <Card>
        {summary ? (
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
            {(
              [
                "NEW",
                "REVIEWED",
                "CONTACTED",
                "QUALIFIED",
                "REJECTED",
                "ARCHIVED",
              ] as Status[]
            ).map((s) => {
                  const active = statusFilter === s;
                  return (
                    <button
                      type="button"
                      key={s}
                      onClick={() => setStatusFilter(active ? "" : s)}
                      style={{
                        appearance: "none",
                        cursor: "pointer",
                        background: active
                          ? "var(--accent-050, #f2f0ff)"
                          : "var(--surface-card, #ffffff)",
                        border: active
                          ? "1px solid var(--accent-500, #7C3AED)"
                          : "1px solid var(--border-default, #e2e8f0)",
                        borderRadius: 999,
                        padding: "5px 12px",
                        display: "inline-flex",
                        alignItems: "center",
                        gap: 8,
                        fontSize: 12,
                        fontWeight: 600,
                        color: "var(--ink-secondary, #475569)",
                        transition: "background 120ms ease, border-color 120ms ease",
                      }}
                    >
                      <span
                        aria-hidden="true"
                        style={{
                          width: 7,
                          height: 7,
                          borderRadius: "50%",
                          background: "var(--accent-500, #7C3AED)",
                          opacity: active ? 1 : 0.45,
                          flexShrink: 0,
                        }}
                      />
                      <span>{STATUS_LABEL[s]}</span>
                      <span style={{ color: "var(--ink-primary, #0f172a)", fontWeight: 700 }}>
                        {summary[s] ?? 0}
                      </span>
                    </button>
                  );
                })}
          </div>
        ) : null}

        <div
          style={{
            marginTop: summary ? 16 : 0,
            display: "flex",
            flexWrap: "wrap",
            alignItems: "flex-end",
            gap: 12,
          }}
        >
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

      <Card padding="none">
        <div style={{ overflowX: "auto" }}>
          <table
            style={{
              width: "100%",
              borderCollapse: "collapse",
              textAlign: "left",
              fontSize: 13.5,
            }}
          >
            <thead style={{ background: "var(--surface-muted, #f8fafc)" }}>
              <tr
                style={{
                  fontSize: 11.5,
                  fontWeight: 600,
                  letterSpacing: "0.14em",
                  textTransform: "uppercase",
                  color: "var(--ink-secondary, #475569)",
                }}
              >
                <th style={{ padding: "12px 20px" }}>Submitted</th>
                <th style={{ padding: "12px 20px" }}>Name</th>
                <th style={{ padding: "12px 20px" }}>Organization</th>
                <th style={{ padding: "12px 20px" }}>Topic</th>
                <th style={{ padding: "12px 20px" }}>Stage</th>
                <th style={{ padding: "12px 20px" }}>Priority</th>
                <th style={{ padding: "12px 20px" }}>Status</th>
                <th style={{ padding: "12px 20px" }}>Email</th>
                <th style={{ padding: "12px 20px" }} />
              </tr>
            </thead>
            <tbody>
              {loading
                ? Array.from({ length: 6 }).map((_, i) => (
                    <tr
                      key={i}
                      style={{ borderTop: "1px solid var(--border-default, #e2e8f0)" }}
                    >
                      <td style={{ padding: "12px 20px" }} colSpan={9}>
                        <Skeleton height="18px" />
                      </td>
                    </tr>
                  ))
                : items.length === 0
                  ? (
                      <tr style={{ borderTop: "1px solid var(--border-default, #e2e8f0)" }}>
                        <td
                          style={{
                            padding: "32px 20px",
                            textAlign: "center",
                            color: "var(--ink-muted, #64748b)",
                          }}
                          colSpan={9}
                        >
                          No contact-sales inquiries match your filters.
                        </td>
                      </tr>
                    )
                  : items.map((it) => (
                      <tr
                        key={it.id}
                        style={{ borderTop: "1px solid var(--border-default, #e2e8f0)" }}
                      >
                        <td
                          style={{
                            padding: "12px 20px",
                            color: "var(--ink-secondary, #475569)",
                          }}
                        >
                          {formatTimestamp(it.createdAt)}
                        </td>
                        <td style={{ padding: "12px 20px" }}>
                          <div
                            style={{
                              fontWeight: 600,
                              color: "var(--ink-primary, #0f172a)",
                            }}
                          >
                            {it.fullName}
                          </div>
                          <div
                            style={{
                              fontSize: 12,
                              color: "var(--ink-secondary, #475569)",
                            }}
                          >
                            {it.workEmail}
                          </div>
                        </td>
                        <td
                          style={{
                            padding: "12px 20px",
                            color: "var(--ink-primary, #0f172a)",
                          }}
                        >
                          {it.organization}
                        </td>
                        <td
                          style={{
                            padding: "12px 20px",
                            color: "var(--ink-secondary, #475569)",
                          }}
                        >
                          {it.discussionTopic}
                        </td>
                        <td
                          style={{
                            padding: "12px 20px",
                            color: "var(--ink-secondary, #475569)",
                          }}
                        >
                          {it.stage}
                        </td>
                        <td style={{ padding: "12px 20px" }}>
                          <PriorityPill value={it.priority} />
                        </td>
                        <td style={{ padding: "12px 20px" }}>
                          <StatusPill value={it.status} />
                        </td>
                        <td
                          style={{
                            padding: "12px 20px",
                            fontSize: 12,
                            color: "var(--ink-muted, #64748b)",
                          }}
                        >
                          {it.emailSentAt ? "Sent" : "—"}
                        </td>
                        <td style={{ padding: "12px 20px", textAlign: "right" }}>
                          <div
                            style={{
                              display: "inline-flex",
                              alignItems: "center",
                              gap: 8,
                            }}
                          >
                            <Button
                              variant="secondary"
                              size="sm"
                              onClick={() => openDetails(it.id)}
                            >
                              Quick view
                            </Button>
                            <Link
                              href={`/admin/contact-sales/${encodeURIComponent(it.id)}`}
                              style={{ textDecoration: "none" }}
                            >
                              <Button variant="ghost" size="sm">
                                Open →
                              </Button>
                            </Link>
                          </div>
                        </td>
                      </tr>
                    ))}
            </tbody>
          </table>
          {/* No server cap on this list, so a plain total is the honest statement. */}
          <ResultCount
            shown={items.length}
            noun="inquiry"
            pluralNoun="inquiries"
            filtered={statusFilter !== ""}
            loading={loading}
            data-testid="admin-contact-sales-count"
          />
        </div>
      </Card>

      {selectedId ? (
        <Card
          title={
            detailLoading
              ? "Loading…"
              : details
                ? `${details.fullName} · ${details.organization}`
                : "Record"
          }
          headerAction={
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                setSelectedId(null);
                setDetails(null);
              }}
            >
              Close
            </Button>
          }
        >
          {details ? (
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
                <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                  <StatusPill value={details.status} />
                  <PriorityPill value={details.priority} />
                  {details.isSpam ? <Badge tone="risk">Spam</Badge> : null}
                </div>

                <div>
                  <FieldLabel>Email</FieldLabel>
                  <div
                    style={{ marginTop: 4, color: "var(--ink-primary, #0f172a)" }}
                  >
                    {details.workEmail}
                  </div>
                </div>

                <div
                  style={{
                    display: "grid",
                    gap: 12,
                    gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))",
                  }}
                >
                  <Field label="Job title" value={details.jobTitle} />
                  <Field label="Country" value={details.country} />
                  <Field label="Workspace size" value={details.teamSize} />
                  <Field
                    label="Deployment timeline"
                    value={details.deploymentTimeline}
                  />
                  <Field label="Estimated users" value={details.estimatedUsers} />
                  <Field label="Topic" value={details.discussionTopic} />
                  <Field label="Stage" value={details.stage} />
                  <Field label="Source page" value={details.sourcePage} />
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
                    {details.currentChallenge}
                  </p>
                </div>

                {details.additionalDetails ? (
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
                      {details.additionalDetails}
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
    </PageShell>
  );
}

function FieldLabel({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        fontSize: 11,
        fontWeight: 700,
        letterSpacing: "0.14em",
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
        {value && value.trim() ? value : "—"}
      </div>
    </div>
  );
}
