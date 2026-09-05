"use client";
import { toSafeUserError } from "../../../../lib/feedback/toSafeUserError";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import {
  PageShell,
  PageHeader,
  PageSection,
  FilterBar,
  Skeleton,
  useToast,
} from "../../../../components/ui";
import { Card } from "../../../../components/ui/Card";
import { Badge } from "../../../../components/ui/Badge";
import type { BadgeTone } from "../../../../components/ui/Badge";
import { Button, buttonSurfaceStyle } from "../../../../components/ui/Button";
import { EmptyState } from "../../../../components/ui/EmptyState";
import { apiFetch } from "../../../../lib/api";
import { formatUserDateTime } from "../../../../lib/date";
import { useConfirmAction } from "../../../../components/ui/ConfirmActionModal";
import { describeClient } from "../../../../lib/ui/describeClient";
// PHASE 6 §7 — carry the list state onto the detail URL so the return link
// puts the operator back on the queue they filtered.
import { detailHrefWithReturn } from "../../../../lib/navigation/adminReturnState";
import {
  classifyStatusRefusal,
  commercialStatusActions,
  describeRefusal,
  statusActionConfirmation,
} from "../../../../lib/admin/commercialStatusActions";

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

function followUpTone(status: DemoFollowUpStatus): BadgeTone {
  switch (status) {
    case "ACTIVE":
      return "verified";
    case "PAUSED":
      return "pending";
    case "COMPLETED":
    case "REPLIED":
      return "info";
    case "STOPPED":
      return "risk";
    default:
      return "neutral";
  }
}

function routeTone(target?: DemoRoutingTarget | null): BadgeTone {
  if (target === "ENTERPRISE_DESK") return "governance";
  if (target === "AUTO_BOOKING") return "verified";
  if (target === "MANUAL_SALES") return "pending";
  return "neutral";
}

/** Small labelled metric block used inside the detail panel. */
function MetaBlock({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <Card variant="admin" padding="comfortable">
      <div
        style={{
          fontSize: 11,
          fontWeight: 700,
          letterSpacing: "0.12em",
          textTransform: "uppercase",
          color: "var(--ink-muted)",
        }}
      >
        {label}
      </div>
      <div
        style={{
          marginTop: 10,
          fontSize: 13.5,
          lineHeight: 1.7,
          color: "var(--ink-primary)",
          wordBreak: "break-word",
        }}
      >
        {children}
      </div>
    </Card>
  );
}

function JsonBlock({ value }: { value: unknown }) {
  return (
    <pre
      style={{
        marginTop: 12,
        marginBottom: 0,
        whiteSpace: "pre-wrap",
        wordBreak: "break-word",
        fontSize: 11.5,
        lineHeight: 1.5,
        color: "var(--ink-secondary)",
        background: "var(--surface-muted)",
        border: "1px solid var(--border-subtle)",
        borderRadius: 10,
        padding: 12,
      }}
    >
      {prettyJson(value)}
    </pre>
  );
}

export default function AdminDemoRequestsPage() {
  const { addToast } = useToast();
  const { confirm } = useConfirmAction();
  // ADM-026 — the detail page's back-link carries `?id=`. The list never read
  // it, so "back to the list" silently dropped the record the operator had
  // been looking at and returned an unselected page. A link whose parameter
  // nothing consumes is an inert link, not a navigation.
  const params = useSearchParams();

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

  const [selectedId, setSelectedId] = useState<string | null>(
    params.get("id"),
  );
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

  // The free-text search is applied ONLY when the operator asks for it (Enter,
  // the Search button, or Clear). Keeping it in a ref — rather than in the
  // callback's dependency list — preserves that contract: the list must not
  // re-fetch on every keystroke. The filters below DO auto-reload, so they are
  // real dependencies.
  const searchRef = useRef(search);
  searchRef.current = search;

  const loadList = useCallback(async (searchOverride?: string) => {
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
      const q = (searchOverride ?? searchRef.current).trim();
      if (q) params.set("search", q);

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
        toSafeUserError(err, { message: "Failed to load demo requests" }).message;
      addToast(message, "error");
    } finally {
      setLoading(false);
    }
  }, [statusFilter, priorityFilter, spamFilter, leadTrackFilter, followUpStatusFilter, addToast]);

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
        toSafeUserError(err, { message: "Failed to load demo request" }).message;
      addToast(message, "error");
    }
  }

  /**
   * Save the edit form — and, when the status is moving, treat it as the
   * transition it is.
   *
   * The status select offers every value, so the shared transition table
   * decides here whether the move is allowed at all (refused locally with a
   * sentence rather than a 409), whether it is consequential enough to ask
   * first (closing, rejecting, qualifying, reopening; or stopping follow-up),
   * and the request carries the status the operator saw so a colleague's
   * concurrent change is refused as stale and the record reloaded.
   */
  async function saveCurrent() {
    if (!selectedId || !details || saving) return;
    const from = details.status;
    const to = editStatus && editStatus !== from ? (editStatus as DemoStatus) : null;
    const subject = {
      id: details.id,
      fullName: details.fullName,
      organization: details.organization ?? "no organization given",
      noun: "demo request",
    };
    if (to) {
      const rule = commercialStatusActions(from).find((r) => r.to === to);
      if (!rule) {
        addToast(
          `A demo request cannot move from ${from} to ${to}. Choose one of: ${commercialStatusActions(from)
            .map((r) => r.to)
            .join(", ")}.`,
          "error",
        );
        return;
      }
      const ask = statusActionConfirmation(rule, subject);
      if (ask && !(await confirm(ask))) return;
    } else if (
      editFollowUpStatus === "STOPPED" &&
      details.followUpStatus !== "STOPPED"
    ) {
      const ok = await confirm({
        title: "Stop automated follow-up?",
        description: `No further follow-up emails will be sent to ${details.workEmail} for this demo request. Applies to: ${details.fullName} · ${subject.organization}.`,
        confirmLabel: "Stop follow-up",
        tone: "warning",
        testId: "demo-request-stop-follow-up",
      });
      if (!ok) return;
    }

    try {
      setSaving(true);

      await apiFetch(`/v1/admin/demo-requests/${selectedId}`, {
        method: "PATCH",
        body: JSON.stringify({
          status: to ?? undefined,
          expectedStatus: from,
          priority: editPriority || undefined,
          followUpStatus: editFollowUpStatus || undefined,
          notes: editNotes,
          nextFollowUpAt: editNextFollowUpAt
            ? new Date(editNextFollowUpAt).toISOString()
            : null,
        }),
      });

      await Promise.all([loadList(), loadDetails(selectedId)]);
      addToast("Demo request updated.", "success");
    } catch (err) {
      const refusal = classifyStatusRefusal(err);
      if (refusal) {
        addToast(describeRefusal(refusal, "demo request"), "error");
        await Promise.all([loadList(), loadDetails(selectedId)]);
        return;
      }
      const message =
        toSafeUserError(err, { message: "Failed to update demo request" }).message;
      addToast(message, "error");
    } finally {
      setSaving(false);
    }
  }

  async function saveRouting() {
    if (!selectedId || !routeTarget || !details || routing) return;
    const ok = await confirm({
      title: "Change where this demo request is routed?",
      description: `${details.fullName} · ${details.organization ?? "no organization given"} moves to the ${routeTarget.replace(/_/g, " ").toLowerCase()} track${
        routeReason.trim() ? ` (${routeReason.trim()})` : ""
      }. The team working that track sees it from now on; the previous routing is kept in the audit record.`,
      confirmLabel: "Change routing",
      tone: "warning",
      testId: "demo-request-route",
    });
    if (!ok) return;

    try {
      setRouting(true);

      await apiFetch(`/v1/admin/demo-requests/${selectedId}/route`, {
        method: "POST",
        body: JSON.stringify({
          routingTarget: routeTarget,
          routingReason: routeReason.trim() || null,
        }),
      });

      await Promise.all([loadList(), loadDetails(selectedId)]);
      addToast("Routing updated.", "success");
    } catch (err) {
      const message =
        toSafeUserError(err, { message: "Failed to update routing" }).message;
      addToast(message, "error");
    } finally {
      setRouting(false);
    }
  }

  /**
   * Sends an email to the requester. External, not undoable, and a second
   * click sends a second email — so it asks first, names the recipient, and
   * says which step goes out.
   */
  async function sendFollowUp(step?: 1 | 2 | 3) {
    if (!selectedId || !details || sendingFollowUp) return;
    const ok = await confirm({
      title: step ? `Send follow-up step ${step} now?` : "Send the next follow-up now?",
      description: `An email is sent to ${details.workEmail} (${details.fullName} · ${
        details.organization ?? "no organization given"
      }). It cannot be recalled, and the follow-up schedule advances from this step.`,
      confirmLabel: "Send email",
      tone: "warning",
      testId: "demo-request-follow-up-send",
    });
    if (!ok) return;

    try {
      setSendingFollowUp(true);

      await apiFetch(`/v1/admin/demo-requests/${selectedId}/follow-up/send`, {
        method: "POST",
        body: JSON.stringify(step ? { step } : {}),
      });

      await Promise.all([loadList(), loadDetails(selectedId)]);
      addToast(
        step ? `Follow-up step ${step} sent.` : "Next follow-up sent.",
        "success"
      );
    } catch (err) {
      const message =
        toSafeUserError(err, { message: "Failed to send follow-up" }).message;
      addToast(message, "error");
    } finally {
      setSendingFollowUp(false);
    }
  }

  /**
   * A batch of external emails. Asks first and states the bound, because
   * "run" reads like a refresh and is not one.
   */
  async function runDueFollowUps() {
    if (runningDue) return;
    const ok = await confirm({
      title: "Send every due follow-up now?",
      description:
        "Up to 25 demo requests whose next follow-up is due receive their scheduled email immediately. Each email is external and cannot be recalled; requests that are paused, stopped or replied are skipped.",
      confirmLabel: "Send due follow-ups",
      tone: "warning",
      testId: "demo-request-follow-up-run",
    });
    if (!ok) return;
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
        toSafeUserError(err, { message: "Failed to run due follow-ups" }).message;
      addToast(message, "error");
    } finally {
      setRunningDue(false);
    }
  }

  useEffect(() => {
    void loadList();
  }, [loadList]);

  // A seeded selection must actually OPEN. Runs once for the id the URL
  // arrived with; later selections load through the click handler.
  const seededIdRef = useRef<string | null>(null);
  useEffect(() => {
    const incoming = params.get("id");
    if (!incoming || seededIdRef.current === incoming) return;
    seededIdRef.current = incoming;
    void loadDetails(incoming);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params]);

  const activeFollowUps = items.filter((x) => x.followUpStatus === "ACTIVE").length;
  const spamCount = items.filter((x) => x.isSpam).length;
  const enterpriseCount = items.filter((x) => x.leadTrack === "ENTERPRISE").length;

  const summaryTiles: {
    label: string;
    value: number;
    note: string;
  }[] = [
    {
      label: "New",
      value: summary.NEW,
      note: "Fresh inbound requests",
    },
    {
      label: "Active Follow-up",
      value: activeFollowUps,
      note: "Requests still in automated follow-up",
    },
    {
      label: "Enterprise Track",
      value: enterpriseCount,
      note: "High-touch enterprise pipeline",
    },
    {
      label: "Spam Flagged",
      value: spamCount,
      note: "Requests currently marked as spam",
    },
  ];

  return (
    <PageShell
      width="full"
      header={
        <PageHeader
          eyebrow="Platform admin"
          title="Demo Requests"
          subtitle="Review inbound demo requests, inspect source and spam context, route qualified leads, and manage follow-up execution from one controlled admin surface."
          secondaryActions={
            <Button variant="secondary" onClick={() => void loadList()}>
              Refresh
            </Button>
          }
          primaryAction={
            <Button
              variant="primary"
              onClick={() => void runDueFollowUps()}
              disabled={runningDue}
            >
              {runningDue ? "Running..." : "Run Due Follow-ups"}
            </Button>
          }
        />
      }
      >

      <div
        style={{
          display: "grid",
          gap: 16,
          gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))",
        }}
      >
        {summaryTiles.map((tile) => (
          <Card key={tile.label} padding="comfortable" style={{ minWidth: 0 }}>
            <div
              style={{
                fontSize: 11,
                fontWeight: 700,
                letterSpacing: "0.12em",
                textTransform: "uppercase",
                color: "var(--ink-muted)",
              }}
            >
              {tile.label}
            </div>
            <div
              style={{
                marginTop: 12,
                display: "flex",
                alignItems: "center",
                gap: 10,
              }}
            >
              <span
                style={{
                  fontSize: 30,
                  fontWeight: 750,
                  letterSpacing: "-0.02em",
                  color: "var(--ink-primary)",
                }}
              >
                {new Intl.NumberFormat().format(tile.value)}
              </span>
              {/* THE BADGE SAID THE EYEBROW AGAIN.
                  Each card printed its label twice, eight pixels apart —
                  "NEW" above, "New" in a coloured capsule beside the number —
                  on all four cards. And the capsule tinted a COUNT by its
                  category rather than by anything measured, so "SPAM FLAGGED
                  0" wore red: a zero in the colour of the thing it counts,
                  which is the fault the posture strip on /admin/security
                  documents at length.

                  What is left is the shape every other summary card in the
                  console uses — eyebrow, number, note — so a reader moving
                  between /admin/operations and here meets one card, not two. */}
            </div>
            <div style={{ marginTop: 8, fontSize: 12.5, color: "var(--ink-muted)" }}>
              {tile.note}
            </div>
          </Card>
        ))}
      </div>

      <div
        style={{
          display: "grid",
          gap: 18,
          gridTemplateColumns: "minmax(0, 1.05fr) minmax(0, 0.95fr)",
          alignItems: "start",
        }}
        className="admin-demo-requests-grid"
      >
        <PageSection
          title="Inbound Requests"
          description="Filter and review inbound requests by status, priority, lead track, follow-up state, spam state, and general search."
        >
          {/* THE RESET APPEARS ONCE THERE IS SOMETHING TO RESET.
              "Clear Filters" was in the actions slot, so it rendered on a
              page where nothing was filtered — a control that usually does
              nothing, beside a Search button that always does something. It
              now uses `FilterBar`'s `filtered`/`onReset`, the same rule as
              every other console filter bar. Search STAYS an explicit
              action: this bar carries a free-text query, and re-requesting on
              every keystroke is a different and worse behaviour. */}
          <FilterBar
            filtered={Boolean(
              statusFilter ||
                priorityFilter ||
                spamFilter ||
                leadTrackFilter ||
                followUpStatusFilter ||
                search.trim(),
            )}
            resetLabel="Clear filters"
            onReset={() => {
              setStatusFilter("");
              setPriorityFilter("");
              setSpamFilter("");
              setLeadTrackFilter("");
              setFollowUpStatusFilter("");
              setSearch("");
              // Pass the cleared value explicitly: setSearch is asynchronous, so
              // reading it back here would still send the OLD query.
              void loadList("");
            }}
            actions={
              <Button variant="primary" size="sm" onClick={() => void loadList()}>
                Search
              </Button>
            }
            >
            <FilterBar.Search
              label="Search requests"
              value={search}
              onChange={setSearch}
              placeholder="Search name, email, org, path, use case..."
              onKeyDown={(e) => {
                if (e.key === "Enter") void loadList();
              }}
            />
            <FilterBar.Select
              label="Status"
              value={statusFilter}
              onChange={setStatusFilter}
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
            <FilterBar.Select
              label="Priority"
              value={priorityFilter}
              onChange={setPriorityFilter}
              options={[
                { value: "", label: "All priorities" },
                { value: "LOW", label: "Low" },
                { value: "NORMAL", label: "Normal" },
                { value: "HIGH", label: "High" },
              ]}
            />
            <FilterBar.Select
              label="Lead track"
              value={leadTrackFilter}
              onChange={setLeadTrackFilter}
              options={[
                { value: "", label: "All tracks" },
                { value: "DISCOVERY", label: "Discovery" },
                { value: "SALES", label: "Sales" },
                { value: "ENTERPRISE", label: "Enterprise" },
              ]}
            />
            <FilterBar.Select
              label="Follow-up"
              value={followUpStatusFilter}
              onChange={setFollowUpStatusFilter}
              options={[
                { value: "", label: "All follow-up" },
                { value: "ACTIVE", label: "Active" },
                { value: "PAUSED", label: "Paused" },
                { value: "COMPLETED", label: "Completed" },
                { value: "REPLIED", label: "Replied" },
                { value: "STOPPED", label: "Stopped" },
              ]}
            />
            <FilterBar.Select
              label="Spam"
              value={spamFilter}
              onChange={setSpamFilter}
              options={[
                { value: "", label: "All requests" },
                { value: "true", label: "Spam only" },
                { value: "false", label: "Non-spam only" },
              ]}
            />
          </FilterBar>

          {loading ? (
            <div style={{ display: "grid", gap: 12, marginTop: 18 }}>
              <Skeleton width="100%" height="110px" />
              <Skeleton width="100%" height="110px" />
              <Skeleton width="100%" height="110px" />
            </div>
          ) : items.length === 0 ? (
            <div style={{ marginTop: 18 }}>
              <EmptyState variant="inline"
                title="No demo requests found"
                purpose="No inbound demo requests match the current filters. Adjust the filters above or clear them to see every request."
              />
            </div>
          ) : (
            <div style={{ display: "grid", gap: 12, marginTop: 18 }}>
              {items.map((item) => (
                <Card
                  key={item.id}
                  padding="comfortable"
                  style={
                    selectedId === item.id
                      ? { borderColor: "var(--accent-500)" }
                      : undefined
                  }
                >
                  <div
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "flex-start",
                      gap: 16,
                      flexWrap: "wrap",
                    }}
                  >
                    <div style={{ minWidth: 0, flex: 1 }}>
                      {/* The name IS the control for the inline details, so
                          the affordance is visible and the row stops being a
                          button that swallows the link beside it. */}
                      <button
                        type="button"
                        onClick={() => void loadDetails(item.id)}
                        aria-expanded={selectedId === item.id}
                        style={{
                          appearance: "none",
                          background: "none",
                          border: 0,
                          padding: 0,
                          textAlign: "left",
                          cursor: "pointer",
                          // 44px hit box (matrix measured 23px); the negative
                          // block margin hands the growth back to the row so
                          // the list keeps its density.
                          display: "inline-flex",
                          alignItems: "center",
                          minHeight: 44,
                          marginBlock: -12,
                          fontSize: 15,
                          fontWeight: 650,
                          color: "var(--ink-primary)",
                          letterSpacing: "-0.01em",
                          textDecoration: "underline",
                          textDecorationColor: "transparent",
                          textUnderlineOffset: 3,
                        }}
                        onMouseEnter={(e) => {
                          e.currentTarget.style.textDecorationColor =
                            "currentColor";
                        }}
                        onMouseLeave={(e) => {
                          e.currentTarget.style.textDecorationColor =
                            "transparent";
                        }}
                      >
                        {item.fullName}
                      </button>

                      <div
                        style={{
                          marginTop: 6,
                          fontSize: 13,
                          color: "var(--ink-secondary)",
                          lineHeight: 1.6,
                        }}
                      >
                        {item.workEmail} · {item.organization ?? "No organization"} ·{" "}
                        {item.country ?? "No country"}
                      </div>

                      <div
                        style={{
                          marginTop: 4,
                          fontSize: 13,
                          color: "var(--ink-secondary)",
                          lineHeight: 1.6,
                        }}
                      >
                        Workspace size: {item.teamSize ?? "—"} · Source:{" "}
                        {item.source ?? "—"} · Track:{" "}
                        {titleCaseToken(item.leadTrack)}
                      </div>

                      <div
                        style={{
                          display: "flex",
                          gap: 8,
                          flexWrap: "wrap",
                          marginTop: 10,
                        }}
                      >
                        <Badge tone={statusTone(item.status)}>{item.status}</Badge>
                        <Badge tone={priorityTone(item.priority)}>
                          {item.priority}
                        </Badge>
                        {/* THE VERDICT IS THE FACT; THE SCORE IS THE EVIDENCE.
                            These read "Clean 0" and "ACTIVE · S0" — a bare
                            number beside a word that is not a count of it,
                            and a letter-and-digit that means nothing to
                            anyone who has not read the follow-up code. The
                            badge states what it decided; the number that
                            justifies it is on the hover, and the detail pane
                            still prints it in full. */}
                        <Badge
                          tone={item.isSpam ? "risk" : "verified"}
                          dot
                          title={`Spam score ${item.spamScore}`}
                        >
                          {item.isSpam ? "Spam" : "Clean"}
                        </Badge>
                        <Badge
                          tone={followUpTone(item.followUpStatus)}
                          title={`Follow-up step ${item.followUpStep}`}
                        >
                          {item.followUpStatus} · step {item.followUpStep}
                        </Badge>
                        {item.routingTarget ? (
                          <Badge tone={routeTone(item.routingTarget)}>
                            {titleCaseToken(item.routingTarget)}
                          </Badge>
                        ) : null}
                      </div>

                      <div
                        style={{
                          marginTop: 8,
                          fontSize: 12.5,
                          color: "var(--ink-muted)",
                          lineHeight: 1.6,
                        }}
                      >
                        Next follow-up: {formatTimestamp(item.nextFollowUpAt)} · Last
                        sent: {formatTimestamp(item.lastFollowUpSentAt)}
                      </div>
                    </div>

                    <div
                      style={{
                        display: "flex",
                        flexDirection: "column",
                        alignItems: "flex-end",
                        gap: 8,
                        whiteSpace: "nowrap",
                      }}
                    >
                      <div style={{ fontSize: 12, color: "var(--ink-muted)" }}>
                        {formatTimestamp(item.createdAt)}
                      </div>
                      {/* A link styled as a button, not a button inside a
                          link — the second is invalid markup and was the other
                          half of the hydration error. */}
                      <Link
                        href={detailHrefWithReturn(
                                `/admin/demo-requests/${encodeURIComponent(item.id)}`,
                                params?.toString() ?? null,
                              )}
                        style={buttonSurfaceStyle("secondary", "sm")}
                      >
                        Open →
                      </Link>
                    </div>
                  </div>
                </Card>
              ))}
            </div>
          )}
        </PageSection>

        <PageSection
          title="Request Details"
          description="Inspect request content, qualification, routing, follow-up state, spam signals, and internal review controls."
        >
          {!details ? (
            <EmptyState variant="inline"
              title="No request selected"
              purpose="Select a request from the list to inspect and update it."
            />
          ) : (
            <div style={{ display: "grid", gap: 14 }}>
              <MetaBlock label="Identity">
                <strong>{details.fullName}</strong>
                <br />
                {details.workEmail}
                <br />
                {details.organization ?? "No organization"} ·{" "}
                {details.jobTitle ?? "No title"} · {details.country ?? "No country"}
              </MetaBlock>

              <MetaBlock label="Qualification">
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
                <JsonBlock value={details.qualificationReasons} />
              </MetaBlock>

              <MetaBlock label="Request">
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
              </MetaBlock>

              <MetaBlock label="Source & Tracking">
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
              </MetaBlock>

              <MetaBlock label="Delivery & Spam">
                Email sent: {formatTimestamp(details.emailSentAt)}
                <br />
                Auto reply: {formatTimestamp(details.autoReplySentAt)}
                <br />
                Webhook sent: {formatTimestamp(details.webhookSentAt)}
                <br />
                Spam flag: {details.isSpam ? "Yes" : "No"} ({details.spamScore})
                <JsonBlock value={details.spamReasons} />
              </MetaBlock>

              <MetaBlock label="Routing">
                Current target: {titleCaseToken(details.routingTarget)}
                <br />
                Current reason: {details.routingReason ?? "—"}
                <br />
                Routed at: {formatTimestamp(details.routedAt)}
                <br />
                Routed by: {details.routedByUserId ?? "—"}
                <div style={{ display: "grid", gap: 12, marginTop: 14 }}>
                  <FilterBar.Select
                    label="Routing target"
                    value={routeTarget}
                    onChange={setRouteTarget}
                    options={[
                      { value: "", label: "Select target…" },
                      { value: "AUTO_RESOURCES", label: "Auto Resources" },
                      { value: "AUTO_BOOKING", label: "Auto Booking" },
                      { value: "MANUAL_SALES", label: "Manual Sales" },
                      { value: "ENTERPRISE_DESK", label: "Enterprise Desk" },
                    ]}
                  />
                  <FilterBar.Search
                    label="Routing reason"
                    value={routeReason}
                    onChange={setRouteReason}
                    placeholder="Routing reason..."
                  />
                  <div>
                    <Button
                      variant="secondary"
                      onClick={() => void saveRouting()}
                      disabled={routing || !routeTarget}
                    >
                      {routing ? "Saving route..." : "Save routing"}
                    </Button>
                  </div>
                </div>
              </MetaBlock>

              <MetaBlock label="Follow-up">
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
                <div
                  style={{
                    display: "flex",
                    gap: 10,
                    flexWrap: "wrap",
                    marginTop: 14,
                  }}
                >
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => void sendFollowUp()}
                    disabled={sendingFollowUp}
                  >
                    {sendingFollowUp ? "Sending..." : "Send Next"}
                  </Button>
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => void sendFollowUp(1)}
                    disabled={sendingFollowUp}
                  >
                    Send Step 1
                  </Button>
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => void sendFollowUp(2)}
                    disabled={sendingFollowUp}
                  >
                    Send Step 2
                  </Button>
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => void sendFollowUp(3)}
                    disabled={sendingFollowUp}
                  >
                    Send Step 3
                  </Button>
                </div>
              </MetaBlock>

              <MetaBlock label="Review Controls">
                <div style={{ display: "grid", gap: 12 }}>
                  <FilterBar.Select
                    label="Status"
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
                  <FilterBar.Select
                    label="Priority"
                    value={editPriority}
                    onChange={setEditPriority}
                    options={[
                      { value: "LOW", label: "Low" },
                      { value: "NORMAL", label: "Normal" },
                      { value: "HIGH", label: "High" },
                    ]}
                  />
                  <FilterBar.Select
                    label="Follow-up status"
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
                    style={{ width: "100%" }}
                  />

                  <textarea
                    className="input min-h-[140px] resize-y"
                    value={editNotes}
                    onChange={(e) => setEditNotes(e.target.value)}
                    placeholder="Internal review notes..."
                    style={{ width: "100%" }}
                  />

                  <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
                    <Button
                      variant="primary"
                      onClick={() => void saveCurrent()}
                      disabled={saving}
                    >
                      {saving ? "Saving..." : "Save changes"}
                    </Button>
                    <Button
                      variant="secondary"
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
                      variant="secondary"
                      onClick={() => {
                        setEditStatus("QUALIFIED");
                        setEditPriority("HIGH");
                      }}
                    >
                      Mark Qualified
                    </Button>
                  </div>
                </div>

                <div style={{ marginTop: 14, color: "var(--ink-secondary)" }}>
                  Reviewed at: {formatTimestamp(details.reviewedAt)}
                  <br />
                  Reviewed by: {details.reviewedByUserId ?? "—"}
                  <br />
                  IP: {details.ipAddress ?? "—"}
                  <br />
                  Client: {describeClient(details.userAgent) ?? "Unrecognised client"}
                </div>
              </MetaBlock>
            </div>
          )}
        </PageSection>
      </div>

      <style jsx global>{`
        @media (max-width: 1180px) {
          .admin-demo-requests-grid {
            grid-template-columns: 1fr !important;
          }
        }
      `}</style>
    </PageShell>
  );
}
