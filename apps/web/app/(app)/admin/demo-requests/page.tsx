"use client";

import { useEffect, useMemo, useState } from "react";
import {
  Card,
  Button,
  Input,
  Select,
  Skeleton,
  useToast,
} from "../../../../components/ui";
import DashboardShell from "../../../../components/dashboard/DashboardShell";
import { dashboardStyles } from "../../../../components/dashboard/styles";
import { apiFetch } from "../../../../lib/api";

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

type Summary = {
  NEW: number;
  REVIEWED: number;
  CONTACTED: number;
  QUALIFIED: number;
  REJECTED: number;
  ARCHIVED: number;
};

type DemoRequestListItem = {
  id: string;
  fullName: string;
  workEmail: string;
  organization: string | null;
  jobTitle: string | null;
  country: string | null;
  teamSize: string | null;
  source: string | null;
  sourcePath: string | null;

  status: DemoStatus;
  priority: DemoPriority;

  leadQuality: DemoLeadQuality | null;
  leadTrack: DemoLeadTrack | null;
  recommendedAction: DemoRecommendedAction | null;

  routingTarget: DemoRoutingTarget | null;
  routingReason: string | null;

  followUpStatus: DemoFollowUpStatus;
  followUpStep: number;
  nextFollowUpAt: string | null;
  lastFollowUpSentAt: string | null;

  spamScore: number;
  isSpam: boolean;

  emailSentAt: string | null;
  autoReplySentAt: string | null;

  reviewedAt: string | null;
  reviewedByUserId: string | null;

  createdAt: string;
  updatedAt: string;
};

type DemoRequestDetails = {
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

function pillTone(kind: "green" | "gold" | "red" | "neutral" | "blue") {
  if (kind === "green") {
    return {
      border: "1px solid rgba(79,112,107,0.16)",
      background:
        "linear-gradient(180deg, rgba(191,232,223,0.18) 0%, rgba(255,255,255,0.44) 100%)",
      color: "#2d5b59",
    } as const;
  }

  if (kind === "gold") {
    return {
      border: "1px solid rgba(183,157,132,0.20)",
      background:
        "linear-gradient(180deg, rgba(214,184,157,0.14) 0%, rgba(255,255,255,0.44) 100%)",
      color: "#8a6e57",
    } as const;
  }

  if (kind === "red") {
    return {
      border: "1px solid rgba(194,78,78,0.20)",
      background:
        "linear-gradient(180deg, rgba(164,84,84,0.14) 0%, rgba(255,255,255,0.44) 100%)",
      color: "#965757",
    } as const;
  }

  if (kind === "blue") {
    return {
      border: "1px solid rgba(74,109,169,0.18)",
      background:
        "linear-gradient(180deg, rgba(123,162,226,0.14) 0%, rgba(255,255,255,0.44) 100%)",
      color: "#47638b",
    } as const;
  }

  return {
    border: "1px solid rgba(79,112,107,0.10)",
    background:
      "linear-gradient(180deg, rgba(250,251,249,0.82) 0%, rgba(241,244,241,0.96) 100%)",
    color: "#54676b",
  } as const;
}

function statusTone(status: DemoStatus) {
  switch (status) {
    case "QUALIFIED":
      return pillTone("green");
    case "CONTACTED":
    case "REVIEWED":
      return pillTone("gold");
    case "REJECTED":
    case "ARCHIVED":
      return pillTone("red");
    default:
      return pillTone("neutral");
  }
}

function priorityTone(priority: DemoPriority) {
  switch (priority) {
    case "HIGH":
      return pillTone("red");
    case "LOW":
      return pillTone("neutral");
    default:
      return pillTone("gold");
  }
}

function followUpTone(status: DemoFollowUpStatus) {
  switch (status) {
    case "ACTIVE":
      return pillTone("green");
    case "PAUSED":
      return pillTone("gold");
    case "COMPLETED":
    case "REPLIED":
      return pillTone("blue");
    case "STOPPED":
      return pillTone("red");
    default:
      return pillTone("neutral");
  }
}

function routeTone(target?: DemoRoutingTarget | null) {
  if (target === "ENTERPRISE_DESK") return pillTone("red");
  if (target === "AUTO_BOOKING") return pillTone("green");
  if (target === "MANUAL_SALES") return pillTone("gold");
  return pillTone("neutral");
}

export default function AdminDemoRequestsPage() {
  const { addToast } = useToast();

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [sendingFollowUp, setSendingFollowUp] = useState(false);
  const [routing, setRouting] = useState(false);
  const [runningDue, setRunningDue] = useState(false);

  const [items, setItems] = useState<DemoRequestListItem[]>([]);
  const [summary, setSummary] = useState<Summary>({
    NEW: 0,
    REVIEWED: 0,
    CONTACTED: 0,
    QUALIFIED: 0,
    REJECTED: 0,
    ARCHIVED: 0,
  });

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [details, setDetails] = useState<DemoRequestDetails | null>(null);

  const [statusFilter, setStatusFilter] = useState("");
  const [priorityFilter, setPriorityFilter] = useState("");
  const [spamFilter, setSpamFilter] = useState("");
  const [leadTrackFilter, setLeadTrackFilter] = useState("");
  const [followUpStatusFilter, setFollowUpStatusFilter] = useState("");
  const [search, setSearch] = useState("");

  const [editStatus, setEditStatus] = useState("");
  const [editPriority, setEditPriority] = useState("");
  const [editFollowUpStatus, setEditFollowUpStatus] = useState("");
  const [editNotes, setEditNotes] = useState("");
  const [editNextFollowUpAt, setEditNextFollowUpAt] = useState("");

  const [routeTarget, setRouteTarget] = useState("");
  const [routeReason, setRouteReason] = useState("");

  async function loadList() {
    try {
      setLoading(true);

      const params = new URLSearchParams();
      params.set("limit", "50");
      if (statusFilter) params.set("status", statusFilter);
      if (priorityFilter) params.set("priority", priorityFilter);
      if (spamFilter) params.set("isSpam", spamFilter);
      if (leadTrackFilter) params.set("leadTrack", leadTrackFilter);
      if (followUpStatusFilter) {
        params.set("followUpStatus", followUpStatusFilter);
      }
      if (search.trim()) params.set("search", search.trim());

      const data = await apiFetch(`/v1/admin/demo-requests?${params.toString()}`);

      setItems(Array.isArray(data?.items) ? data.items : []);
      setSummary(
        data?.summary ?? {
          NEW: 0,
          REVIEWED: 0,
          CONTACTED: 0,
          QUALIFIED: 0,
          REJECTED: 0,
          ARCHIVED: 0,
        }
      );
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to load demo requests";
      addToast(message, "error");
    } finally {
      setLoading(false);
    }
  }

  async function loadDetails(id: string) {
    try {
      const data = await apiFetch(`/v1/admin/demo-requests/${id}`);
      const next = (data?.item ?? null) as DemoRequestDetails | null;

      setDetails(next);
      setSelectedId(id);

      if (next) {
        setEditStatus(next.status);
        setEditPriority(next.priority);
        setEditFollowUpStatus(next.followUpStatus);
        setEditNotes(next.notes ?? "");
        setEditNextFollowUpAt(
          next.nextFollowUpAt ? next.nextFollowUpAt.slice(0, 16) : ""
        );
        setRouteTarget(next.routingTarget ?? "");
        setRouteReason(next.routingReason ?? "");
      }
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to load demo request";
      addToast(message, "error");
    }
  }

  async function saveCurrent() {
    if (!selectedId) return;

    try {
      setSaving(true);

      await apiFetch(`/v1/admin/demo-requests/${selectedId}`, {
        method: "PATCH",
        body: JSON.stringify({
          status: editStatus || undefined,
          priority: editPriority || undefined,
          followUpStatus: editFollowUpStatus || undefined,
          notes: editNotes,
          nextFollowUpAt: editNextFollowUpAt
            ? new Date(editNextFollowUpAt).toISOString()
            : null,
        }),
      });

      addToast("Demo request updated.", "success");
      await Promise.all([loadList(), loadDetails(selectedId)]);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to update demo request";
      addToast(message, "error");
    } finally {
      setSaving(false);
    }
  }

  async function saveRouting() {
    if (!selectedId || !routeTarget) return;

    try {
      setRouting(true);

      await apiFetch(`/v1/admin/demo-requests/${selectedId}/route`, {
        method: "POST",
        body: JSON.stringify({
          routingTarget: routeTarget,
          routingReason: routeReason.trim() || null,
        }),
      });

      addToast("Routing updated.", "success");
      await Promise.all([loadList(), loadDetails(selectedId)]);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to update routing";
      addToast(message, "error");
    } finally {
      setRouting(false);
    }
  }

  async function sendFollowUp(step?: 1 | 2 | 3) {
    if (!selectedId) return;

    try {
      setSendingFollowUp(true);

      await apiFetch(`/v1/admin/demo-requests/${selectedId}/follow-up/send`, {
        method: "POST",
        body: JSON.stringify(step ? { step } : {}),
      });

      addToast(
        step ? `Follow-up step ${step} sent.` : "Next follow-up sent.",
        "success"
      );

      await Promise.all([loadList(), loadDetails(selectedId)]);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to send follow-up";
      addToast(message, "error");
    } finally {
      setSendingFollowUp(false);
    }
  }

  async function runDueFollowUps() {
    try {
      setRunningDue(true);

      const data = await apiFetch(`/v1/admin/demo-requests/follow-up/run`, {
        method: "POST",
        body: JSON.stringify({ limit: 25 }),
      });

      const result = data?.result;
      addToast(
        `Processed ${result?.processed ?? 0}, sent ${result?.sent ?? 0}, failed ${result?.failed ?? 0}.`,
        result?.failed ? "error" : "success"
      );

      await loadList();
      if (selectedId) {
        await loadDetails(selectedId);
      }
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to run due follow-ups";
      addToast(message, "error");
    } finally {
      setRunningDue(false);
    }
  }

  useEffect(() => {
    void loadList();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [statusFilter, priorityFilter, spamFilter, leadTrackFilter, followUpStatusFilter]);

  const statPillBase = useMemo(
    () =>
      ({
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        minHeight: 32,
        padding: "6px 12px",
        borderRadius: 999,
        fontSize: 11,
        fontWeight: 800,
        letterSpacing: "0.12em",
        textTransform: "uppercase",
        maxWidth: "100%",
        textAlign: "center",
        overflowWrap: "anywhere",
        wordBreak: "break-word",
      }) as const,
    []
  );

  const activeFollowUps = items.filter((x) => x.followUpStatus === "ACTIVE").length;
  const spamCount = items.filter((x) => x.isSpam).length;
  const enterpriseCount = items.filter((x) => x.leadTrack === "ENTERPRISE").length;

  return (
    <DashboardShell
      eyebrow="Demo Requests"
      title="Inbound demo pipeline and"
      highlight="request review."
      description={
        <>
          Review inbound demo requests, inspect source and spam context, route
          qualified leads, and manage follow-up execution from one controlled
          admin surface.
        </>
      }
      action={
        <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
          <Button
            className="app-responsive-btn rounded-[999px] border px-6 py-3 text-[0.95rem] font-semibold"
            style={dashboardStyles.secondaryButton}
            onClick={() => void loadList()}
          >
            Refresh
          </Button>
          <Button
            className="app-responsive-btn rounded-[999px] border px-6 py-3 text-[0.95rem] font-semibold"
            style={dashboardStyles.primaryButton}
            onClick={() => void runDueFollowUps()}
            disabled={runningDue}
          >
            {runningDue ? "Running..." : "Run Due Follow-ups"}
          </Button>
        </div>
      }
    >
      <style jsx global>{`
        .admin-demo-requests-page {
          display: grid;
          gap: 18px;
        }

        .admin-demo-requests-page .grid-4 {
          display: grid;
          grid-template-columns: repeat(4, minmax(0, 1fr));
          gap: 18px;
        }

        .admin-demo-requests-page .grid-2 {
          display: grid;
          grid-template-columns: minmax(0, 1.05fr) minmax(0, 0.95fr);
          gap: 18px;
          align-items: start;
        }

        .admin-demo-requests-page .card-shell {
          position: relative;
          overflow: hidden;
          border-radius: 30px;
          border: 1px solid rgba(79, 112, 107, 0.16);
          background: transparent;
          box-shadow:
            0 18px 38px rgba(0, 0, 0, 0.08),
            inset 0 1px 0 rgba(255, 255, 255, 0.48);
        }

        .admin-demo-requests-page .card-overlay {
          position: absolute;
          inset: 0;
          background: linear-gradient(
            180deg,
            rgba(255, 255, 255, 0.24) 0%,
            rgba(248, 249, 246, 0.34) 42%,
            rgba(239, 241, 238, 0.42) 100%
          );
        }

        .admin-demo-requests-page .card-shine {
          position: absolute;
          inset: 0;
          background: radial-gradient(
            circle at 16% 12%,
            rgba(255, 255, 255, 0.34),
            transparent 28%
          );
          opacity: 0.9;
        }

        .admin-demo-requests-page .card-inner {
          position: relative;
          z-index: 10;
          padding: 24px;
          min-width: 0;
        }

        .admin-demo-requests-page .section-title {
          font-size: 1.08rem;
          font-weight: 700;
          letter-spacing: -0.02em;
          color: #21353a;
        }

        .admin-demo-requests-page .section-copy {
          margin-top: 8px;
          color: #5d6d71;
          line-height: 1.7;
          font-size: 0.94rem;
        }

        .admin-demo-requests-page .summary-label {
          font-size: 0.78rem;
          font-weight: 700;
          letter-spacing: 0.12em;
          text-transform: uppercase;
          color: #708085;
        }

        .admin-demo-requests-page .summary-value {
          margin-top: 10px;
          font-size: 2rem;
          line-height: 1;
          font-weight: 800;
          letter-spacing: -0.05em;
          color: #21353a;
        }

        .admin-demo-requests-page .summary-note {
          margin-top: 10px;
          font-size: 0.84rem;
          color: #6b7b7f;
          line-height: 1.6;
        }

        .admin-demo-requests-page .filters-grid {
          display: grid;
          grid-template-columns: repeat(3, minmax(0, 1fr));
          gap: 12px;
          margin-top: 18px;
        }

        .admin-demo-requests-page .request-list {
          display: grid;
          gap: 12px;
          margin-top: 18px;
        }

        .admin-demo-requests-page .request-row {
          border: 1px solid rgba(79, 112, 107, 0.10);
          background: linear-gradient(
            180deg,
            rgba(255, 255, 255, 0.58) 0%,
            rgba(243, 245, 242, 0.90) 100%
          );
          border-radius: 22px;
          padding: 16px;
          box-shadow:
            inset 0 1px 0 rgba(255,255,255,0.42),
            0 12px 26px rgba(0,0,0,0.06);
          cursor: pointer;
        }

        .admin-demo-requests-page .request-row.active {
          border-color: rgba(79,112,107,0.28);
          box-shadow:
            inset 0 1px 0 rgba(255,255,255,0.42),
            0 16px 32px rgba(0,0,0,0.08);
        }

        .admin-demo-requests-page .row-top {
          display: flex;
          justify-content: space-between;
          align-items: flex-start;
          gap: 16px;
          flex-wrap: wrap;
        }

        .admin-demo-requests-page .row-title {
          font-size: 1rem;
          font-weight: 800;
          color: #21353a;
          letter-spacing: -0.02em;
        }

        .admin-demo-requests-page .row-sub {
          margin-top: 6px;
          font-size: 0.84rem;
          color: #6f7f84;
          line-height: 1.65;
        }

        .admin-demo-requests-page .pill-row {
          display: flex;
          gap: 8px;
          flex-wrap: wrap;
          margin-top: 10px;
        }

        .admin-demo-requests-page .detail-grid {
          display: grid;
          gap: 14px;
          margin-top: 18px;
        }

        .admin-demo-requests-page .soft-box {
          border: 1px solid rgba(79,112,107,0.10);
          background: linear-gradient(
            180deg,
            rgba(255,255,255,0.58) 0%,
            rgba(243,245,242,0.90) 100%
          );
          border-radius: 20px;
          padding: 16px;
          box-shadow:
            inset 0 1px 0 rgba(255,255,255,0.42),
            0 12px 26px rgba(0,0,0,0.06);
        }

        .admin-demo-requests-page .meta-label {
          font-size: 0.76rem;
          font-weight: 700;
          letter-spacing: 0.12em;
          text-transform: uppercase;
          color: #738287;
        }

        .admin-demo-requests-page .meta-value {
          margin-top: 6px;
          font-size: 0.92rem;
          line-height: 1.7;
          color: #31464a;
          word-break: break-word;
        }

        .admin-demo-requests-page textarea,
        .admin-demo-requests-page input[type="datetime-local"] {
          width: 100%;
        }

        @media (max-width: 1180px) {
          .admin-demo-requests-page .grid-4 {
            grid-template-columns: repeat(2, minmax(0, 1fr));
          }

          .admin-demo-requests-page .grid-2 {
            grid-template-columns: 1fr;
          }
        }

        @media (max-width: 860px) {
          .admin-demo-requests-page .filters-grid {
            grid-template-columns: 1fr;
          }
        }

        @media (max-width: 640px) {
          .admin-demo-requests-page .grid-4 {
            grid-template-columns: 1fr;
          }
        }
      `}</style>

      <div className="admin-demo-requests-page">
        <div className="grid-4">
          {[
            {
              label: "New",
              value: summary.NEW,
              accent: "#2d5b59",
              note: "Fresh inbound requests",
            },
            {
              label: "Active Follow-up",
              value: activeFollowUps,
              accent: "#8a6e57",
              note: "Requests still in automated follow-up",
            },
            {
              label: "Enterprise Track",
              value: enterpriseCount,
              accent: "#4d6f60",
              note: "High-touch enterprise pipeline",
            },
            {
              label: "Spam Flagged",
              value: spamCount,
              accent: "#9a5757",
              note: "Requests currently marked as spam",
            },
          ].map((item) => (
            <Card
              key={item.label}
              className="card-shell"
              style={dashboardStyles.outerCard}
            >
              <div className="absolute inset-0">
                <img
                  src="/images/panel-silver.webp.png"
                  alt=""
                  className="h-full w-full object-cover object-center"
                />
              </div>
              <div className="card-overlay" />
              <div className="card-shine" />
              <div className="card-inner">
                <div className="summary-label">{item.label}</div>
                <div className="summary-value" style={{ color: item.accent }}>
                  {item.value}
                </div>
                <div className="summary-note">{item.note}</div>
              </div>
            </Card>
          ))}
        </div>

        <div className="grid-2">
          <Card className="card-shell" style={dashboardStyles.outerCard}>
            <div className="absolute inset-0">
              <img
                src="/images/panel-silver.webp.png"
                alt=""
                className="h-full w-full object-cover object-center"
              />
            </div>
            <div className="card-overlay" />
            <div className="card-shine" />
            <div className="card-inner">
              <div className="section-title">Inbound Requests</div>
              <div className="section-copy">
                Filter and review inbound requests by status, priority, lead
                track, follow-up state, spam state, and general search.
              </div>

              <div className="filters-grid">
                <Select
                  value={statusFilter}
                  onChange={setStatusFilter}
                  options={[
                    { value: "NEW", label: "New" },
                    { value: "REVIEWED", label: "Reviewed" },
                    { value: "CONTACTED", label: "Contacted" },
                    { value: "QUALIFIED", label: "Qualified" },
                    { value: "REJECTED", label: "Rejected" },
                    { value: "ARCHIVED", label: "Archived" },
                  ]}
                />

                <Select
                  value={priorityFilter}
                  onChange={setPriorityFilter}
                  options={[
                    { value: "LOW", label: "Low" },
                    { value: "NORMAL", label: "Normal" },
                    { value: "HIGH", label: "High" },
                  ]}
                />

                <Select
                  value={leadTrackFilter}
                  onChange={setLeadTrackFilter}
                  options={[
                    { value: "DISCOVERY", label: "Discovery" },
                    { value: "SALES", label: "Sales" },
                    { value: "ENTERPRISE", label: "Enterprise" },
                  ]}
                />

                <Select
                  value={followUpStatusFilter}
                  onChange={setFollowUpStatusFilter}
                  options={[
                    { value: "ACTIVE", label: "Follow-up Active" },
                    { value: "PAUSED", label: "Follow-up Paused" },
                    { value: "COMPLETED", label: "Follow-up Completed" },
                    { value: "REPLIED", label: "Follow-up Replied" },
                    { value: "STOPPED", label: "Follow-up Stopped" },
                  ]}
                />

                <Select
                  value={spamFilter}
                  onChange={setSpamFilter}
                  options={[
                    { value: "true", label: "Spam only" },
                    { value: "false", label: "Non-spam only" },
                  ]}
                />

                <Input
                  value={search}
                  onChange={setSearch}
                  placeholder="Search name, email, org, path, use case..."
                />
              </div>

              <div
                style={{ marginTop: 12, display: "flex", gap: 12, flexWrap: "wrap" }}
              >
                <Button
                  className="app-responsive-btn rounded-[999px] border px-5 py-2.5 text-[0.88rem] font-semibold"
                  style={dashboardStyles.primaryButton}
                  onClick={() => void loadList()}
                >
                  Search
                </Button>

                <Button
                  className="app-responsive-btn rounded-[999px] border px-5 py-2.5 text-[0.88rem] font-semibold"
                  style={dashboardStyles.secondaryButton}
                  onClick={() => {
                    setStatusFilter("");
                    setPriorityFilter("");
                    setSpamFilter("");
                    setLeadTrackFilter("");
                    setFollowUpStatusFilter("");
                    setSearch("");
                    void loadList();
                  }}
                >
                  Clear Filters
                </Button>
              </div>

              {loading ? (
                <div style={{ display: "grid", gap: 12, marginTop: 18 }}>
                  <Skeleton width="100%" height="110px" />
                  <Skeleton width="100%" height="110px" />
                  <Skeleton width="100%" height="110px" />
                </div>
              ) : items.length === 0 ? (
                <div style={{ marginTop: 18, color: "#6f7f84" }}>
                  No demo requests found.
                </div>
              ) : (
                <div className="request-list">
                  {items.map((item) => (
                    <div
                      key={item.id}
                      className={`request-row ${selectedId === item.id ? "active" : ""}`}
                      onClick={() => void loadDetails(item.id)}
                    >
                      <div className="row-top">
                        <div style={{ minWidth: 0, flex: 1 }}>
                          <div className="row-title">{item.fullName}</div>

                          <div className="row-sub">
                            {item.workEmail} · {item.organization ?? "No organization"} ·{" "}
                            {item.country ?? "No country"}
                          </div>

                          <div className="row-sub">
                            Team size: {item.teamSize ?? "—"} · Source:{" "}
                            {item.source ?? "—"} · Track:{" "}
                            {titleCaseToken(item.leadTrack)}
                          </div>

                          <div className="pill-row">
                            <span style={{ ...statPillBase, ...statusTone(item.status) }}>
                              {item.status}
                            </span>

                            <span style={{ ...statPillBase, ...priorityTone(item.priority) }}>
                              {item.priority}
                            </span>

                            <span
                              style={{
                                ...statPillBase,
                                ...(item.isSpam ? pillTone("red") : pillTone("green")),
                              }}
                            >
                              {item.isSpam
                                ? `Spam ${item.spamScore}`
                                : `Clean ${item.spamScore}`}
                            </span>

                            <span
                              style={{
                                ...statPillBase,
                                ...followUpTone(item.followUpStatus),
                              }}
                            >
                              {item.followUpStatus} · S{item.followUpStep}
                            </span>

                            {item.routingTarget ? (
                              <span
                                style={{
                                  ...statPillBase,
                                  ...routeTone(item.routingTarget),
                                }}
                              >
                                {titleCaseToken(item.routingTarget)}
                              </span>
                            ) : null}
                          </div>

                          <div className="row-sub">
                            Next follow-up: {formatTimestamp(item.nextFollowUpAt)} · Last sent:{" "}
                            {formatTimestamp(item.lastFollowUpSentAt)}
                          </div>
                        </div>

                        <div
                          style={{ fontSize: 12, color: "#738287", whiteSpace: "nowrap" }}
                        >
                          {formatTimestamp(item.createdAt)}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </Card>

          <Card className="card-shell" style={dashboardStyles.outerCard}>
            <div className="absolute inset-0">
              <img
                src="/images/panel-silver.webp.png"
                alt=""
                className="h-full w-full object-cover object-center"
              />
            </div>
            <div className="card-overlay" />
            <div className="card-shine" />
            <div className="card-inner">
              <div className="section-title">Request Details</div>
              <div className="section-copy">
                Inspect request content, qualification, routing, follow-up state,
                spam signals, and internal review controls.
              </div>

              {!details ? (
                <div style={{ marginTop: 18, color: "#6f7f84" }}>
                  Select a request from the list to inspect and update it.
                </div>
              ) : (
                <div className="detail-grid">
                  <div className="soft-box">
                    <div className="meta-label">Identity</div>
                    <div className="meta-value">
                      <strong>{details.fullName}</strong>
                      <br />
                      {details.workEmail}
                      <br />
                      {details.organization ?? "No organization"} ·{" "}
                      {details.jobTitle ?? "No title"} · {details.country ?? "No country"}
                    </div>
                  </div>

                  <div className="soft-box">
                    <div className="meta-label">Qualification</div>
                    <div className="meta-value">
                      Lead quality: {titleCaseToken(details.leadQuality)}
                      <br />
                      Lead track: {titleCaseToken(details.leadTrack)}
                      <br />
                      Recommended action: {titleCaseToken(details.recommendedAction)}
                      <br />
                      Priority: {details.priority}
                      <br />
                      SLA:{" "}
                      {details.responseSlaHours != null
                        ? `${details.responseSlaHours}h`
                        : "—"}
                      <br />
                      Qualification score:{" "}
                      {details.qualificationScore != null
                        ? details.qualificationScore
                        : "—"}
                    </div>

                    <pre
                      style={{
                        marginTop: 12,
                        marginBottom: 0,
                        whiteSpace: "pre-wrap",
                        wordBreak: "break-word",
                        fontSize: 11,
                        lineHeight: 1.5,
                        color: "#55656a",
                        background: "rgba(255,255,255,0.55)",
                        border: "1px solid rgba(79,112,107,0.08)",
                        borderRadius: 14,
                        padding: 12,
                      }}
                    >
                      {prettyJson(details.qualificationReasons)}
                    </pre>
                  </div>

                  <div className="soft-box">
                    <div className="meta-label">Request</div>
                    <div className="meta-value">
                      <strong>Use case</strong>
                      <div style={{ marginTop: 8, whiteSpace: "pre-wrap" }}>
                        {details.useCase}
                      </div>

                      <div style={{ marginTop: 14 }}>
                        <strong>Message</strong>
                      </div>
                      <div style={{ marginTop: 8, whiteSpace: "pre-wrap" }}>
                        {details.message ?? "—"}
                      </div>
                    </div>
                  </div>

                  <div className="soft-box">
                    <div className="meta-label">Source & Tracking</div>
                    <div className="meta-value">
                      Source: {details.source ?? "—"}
                      <br />
                      Path: {details.sourcePath ?? "—"}
                      <br />
                      Referrer: {details.referrer ?? "—"}
                      <br />
                      UTM source: {details.utmSource ?? "—"}
                      <br />
                      UTM medium: {details.utmMedium ?? "—"}
                      <br />
                      UTM campaign: {details.utmCampaign ?? "—"}
                      <br />
                      UTM term: {details.utmTerm ?? "—"}
                      <br />
                      UTM content: {details.utmContent ?? "—"}
                    </div>
                  </div>

                  <div className="soft-box">
                    <div className="meta-label">Delivery & Spam</div>
                    <div className="meta-value">
                      Email sent: {formatTimestamp(details.emailSentAt)}
                      <br />
                      Auto reply: {formatTimestamp(details.autoReplySentAt)}
                      <br />
                      Webhook sent: {formatTimestamp(details.webhookSentAt)}
                      <br />
                      Spam flag: {details.isSpam ? "Yes" : "No"} ({details.spamScore})
                    </div>

                    <pre
                      style={{
                        marginTop: 12,
                        marginBottom: 0,
                        whiteSpace: "pre-wrap",
                        wordBreak: "break-word",
                        fontSize: 11,
                        lineHeight: 1.5,
                        color: "#55656a",
                        background: "rgba(255,255,255,0.55)",
                        border: "1px solid rgba(79,112,107,0.08)",
                        borderRadius: 14,
                        padding: 12,
                      }}
                    >
                      {prettyJson(details.spamReasons)}
                    </pre>
                  </div>

                  <div className="soft-box">
                    <div className="meta-label">Routing</div>

                    <div className="meta-value">
                      Current target: {titleCaseToken(details.routingTarget)}
                      <br />
                      Current reason: {details.routingReason ?? "—"}
                      <br />
                      Routed at: {formatTimestamp(details.routedAt)}
                      <br />
                      Routed by: {details.routedByUserId ?? "—"}
                    </div>

                    <div style={{ display: "grid", gap: 12, marginTop: 14 }}>
                      <Select
                        value={routeTarget}
                        onChange={setRouteTarget}
                        options={[
                          { value: "AUTO_RESOURCES", label: "Auto Resources" },
                          { value: "AUTO_BOOKING", label: "Auto Booking" },
                          { value: "MANUAL_SALES", label: "Manual Sales" },
                          { value: "ENTERPRISE_DESK", label: "Enterprise Desk" },
                        ]}
                      />

                      <Input
                        value={routeReason}
                        onChange={setRouteReason}
                        placeholder="Routing reason..."
                      />

                      <Button
                        className="app-responsive-btn rounded-[999px] border px-6 py-3 text-[0.95rem] font-semibold"
                        style={dashboardStyles.secondaryButton}
                        onClick={() => void saveRouting()}
                        disabled={routing || !routeTarget}
                      >
                        {routing ? "Saving route..." : "Save routing"}
                      </Button>
                    </div>
                  </div>

                  <div className="soft-box">
                    <div className="meta-label">Follow-up</div>

                    <div className="meta-value">
                      Follow-up status: {details.followUpStatus}
                      <br />
                      Step: {details.followUpStep}
                      <br />
                      Next scheduled: {formatTimestamp(details.nextFollowUpAt)}
                      <br />
                      Last sent: {formatTimestamp(details.lastFollowUpSentAt)}
                      <br />
                      Template key: {details.lastFollowUpTemplateKey ?? "—"}
                      <br />
                      Stopped at: {formatTimestamp(details.followUpStoppedAt)}
                    </div>

                    <div style={{ display: "grid", gap: 12, marginTop: 14 }}>
                      <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                        <Button
                          className="app-responsive-btn rounded-[999px] border px-5 py-3 text-[0.9rem] font-semibold"
                          style={dashboardStyles.secondaryButton}
                          onClick={() => void sendFollowUp()}
                          disabled={sendingFollowUp}
                        >
                          {sendingFollowUp ? "Sending..." : "Send Next"}
                        </Button>

                        <Button
                          className="app-responsive-btn rounded-[999px] border px-5 py-3 text-[0.9rem] font-semibold"
                          style={dashboardStyles.secondaryButton}
                          onClick={() => void sendFollowUp(1)}
                          disabled={sendingFollowUp}
                        >
                          Send Step 1
                        </Button>

                        <Button
                          className="app-responsive-btn rounded-[999px] border px-5 py-3 text-[0.9rem] font-semibold"
                          style={dashboardStyles.secondaryButton}
                          onClick={() => void sendFollowUp(2)}
                          disabled={sendingFollowUp}
                        >
                          Send Step 2
                        </Button>

                        <Button
                          className="app-responsive-btn rounded-[999px] border px-5 py-3 text-[0.9rem] font-semibold"
                          style={dashboardStyles.secondaryButton}
                          onClick={() => void sendFollowUp(3)}
                          disabled={sendingFollowUp}
                        >
                          Send Step 3
                        </Button>
                      </div>
                    </div>
                  </div>

                  <div className="soft-box">
                    <div className="meta-label">Review Controls</div>

                    <div style={{ display: "grid", gap: 12, marginTop: 14 }}>
                      <Select
                        value={editStatus}
                        onChange={setEditStatus}
                        options={[
                          { value: "NEW", label: "New" },
                          { value: "REVIEWED", label: "Reviewed" },
                          { value: "CONTACTED", label: "Contacted" },
                          { value: "QUALIFIED", label: "Qualified" },
                          { value: "REJECTED", label: "Rejected" },
                          { value: "ARCHIVED", label: "Archived" },
                        ]}
                      />

                      <Select
                        value={editPriority}
                        onChange={setEditPriority}
                        options={[
                          { value: "LOW", label: "Low" },
                          { value: "NORMAL", label: "Normal" },
                          { value: "HIGH", label: "High" },
                        ]}
                      />

                      <Select
                        value={editFollowUpStatus}
                        onChange={setEditFollowUpStatus}
                        options={[
                          { value: "ACTIVE", label: "Active" },
                          { value: "PAUSED", label: "Paused" },
                          { value: "COMPLETED", label: "Completed" },
                          { value: "REPLIED", label: "Replied" },
                          { value: "STOPPED", label: "Stopped" },
                        ]}
                      />

                      <input
                        className="input"
                        type="datetime-local"
                        value={editNextFollowUpAt}
                        onChange={(e) => setEditNextFollowUpAt(e.target.value)}
                      />

                      <textarea
                        className="input min-h-[140px] resize-y"
                        value={editNotes}
                        onChange={(e) => setEditNotes(e.target.value)}
                        placeholder="Internal review notes..."
                      />

                      <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
                        <Button
                          className="app-responsive-btn rounded-[999px] border px-6 py-3 text-[0.95rem] font-semibold"
                          style={dashboardStyles.primaryButton}
                          onClick={() => void saveCurrent()}
                          disabled={saving}
                        >
                          {saving ? "Saving..." : "Save changes"}
                        </Button>

                        <Button
                          className="app-responsive-btn rounded-[999px] border px-6 py-3 text-[0.95rem] font-semibold"
                          style={dashboardStyles.secondaryButton}
                          onClick={() => {
                            setEditStatus("CONTACTED");
                            setEditPriority(details.priority);
                            setEditFollowUpStatus(details.followUpStatus);
                            setEditNotes(details.notes ?? "");
                          }}
                        >
                          Set Contacted
                        </Button>

                        <Button
                          className="app-responsive-btn rounded-[999px] border px-6 py-3 text-[0.95rem] font-semibold"
                          style={dashboardStyles.secondaryButton}
                          onClick={() => {
                            setEditStatus("QUALIFIED");
                            setEditPriority("HIGH");
                          }}
                        >
                          Mark Qualified
                        </Button>
                      </div>
                    </div>

                    <div className="meta-value" style={{ marginTop: 14 }}>
                      Reviewed at: {formatTimestamp(details.reviewedAt)}
                      <br />
                      Reviewed by: {details.reviewedByUserId ?? "—"}
                      <br />
                      IP: {details.ipAddress ?? "—"}
                      <br />
                      User agent: {details.userAgent ?? "—"}
                    </div>
                  </div>
                </div>
              )}
            </div>
          </Card>
        </div>
      </div>
    </DashboardShell>
  );
}