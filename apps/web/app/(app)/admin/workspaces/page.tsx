"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";

import {
  PageShell,
  PageHeader,
  FilterBar,
  DataTable,
  useToast,
  type DataTableColumn,
} from "../../../../components/ui";
import { Badge, type BadgeTone } from "../../../../components/ui/Badge";
import { Button } from "../../../../components/ui/Button";
import { Card } from "../../../../components/ui/Card";
import { EmptyState } from "../../../../components/ui/EmptyState";
import { apiFetch } from "../../../../lib/api";
import { formatUserDate } from "../../../../lib/date";
import { toSafeUserError } from "../../../../lib/feedback/toSafeUserError";
// PHASE 6 §7 — carry the list state onto the detail URL so the return link
// can put the operator back on the page they filtered, not on page one of
// everything. Only the OWNING collection does this: a link from Billing to
// a customer should return to Billing, not to the customer directory.
import { detailHrefWithReturn } from "../../../../lib/navigation/adminReturnState";

/**
 * PLATFORM ADMIN — THE WORKSPACE DIRECTORY (ADM-027).
 *
 * The workspace is the platform's central commercial and tenancy object and it
 * had no admin surface at all: no roster, no detail, no way to get from
 * "Workspaces: 12" to the twelve records. This is that surface.
 *
 * Every filter is a URL parameter and every URL parameter is read back
 * (ADM-017's other half — the console used to EMIT deep links that its own
 * destinations ignored). So the Overview's "Personal: 8" tile can link to
 * `?lifecycle=LIVE&kind=PERSONAL` and land on exactly those eight.
 */

type WorkspaceRow = {
  id: string;
  name: string;
  kind: "PERSONAL" | "OWNED" | "ORGANIZATION";
  lifecycle: "LIVE" | "CLOSED";
  closedAtUtc: string | null;
  createdAt: string;
  organization: { id: string; name: string; kind: string } | null;
  owner: { userId: string; email: string | null } | null;
  billingOwner: { userId: string; email: string | null } | null;
  raw: { billingPlan: string; billingStatus: string; includedSeats: number };
  seatsUsed: number;
  evidenceCount: number;
  openIncidents: number;
};

type ListResponse = {
  items: WorkspaceRow[];
  page: number;
  limit: number;
  total: number;
  totalPages: number;
};

const KIND_TONE: Record<WorkspaceRow["kind"], BadgeTone> = {
  PERSONAL: "neutral",
  OWNED: "info",
  ORGANIZATION: "governance",
};

const KIND_LABEL: Record<WorkspaceRow["kind"], string> = {
  PERSONAL: "Personal",
  OWNED: "Owned",
  ORGANIZATION: "Organization",
};

const BILLING_TONE: Record<string, BadgeTone> = {
  ACTIVE: "verified",
  TRIALING: "info",
  PAST_DUE: "pending",
  CANCELED: "risk",
  INACTIVE: "neutral",
};

const PAGE_SIZE = 25;

export default function AdminWorkspacesPage() {
  const { addToast } = useToast();
  const router = useRouter();
  const params = useSearchParams();

  // Every filter is seeded FROM the URL so an inbound deep link works, and
  // written BACK to it so a filtered view is shareable.
  const [search, setSearch] = useState(params.get("search") ?? "");
  const [applied, setApplied] = useState(params.get("search") ?? "");
  const [kind, setKind] = useState(params.get("kind") ?? "");
  const [lifecycle, setLifecycle] = useState(params.get("lifecycle") ?? "LIVE");
  const [plan, setPlan] = useState(params.get("plan") ?? "");
  const [customersOnly, setCustomersOnly] = useState(
    params.get("customersOnly") === "true",
  );

  const [loading, setLoading] = useState(true);
  const [data, setData] = useState<ListResponse | null>(null);
  const [page, setPage] = useState(1);

  const load = useCallback(
    async (targetPage: number) => {
      setLoading(true);
      try {
        const qs = new URLSearchParams();
        qs.set("page", String(targetPage));
        qs.set("limit", String(PAGE_SIZE));
        if (applied.trim()) qs.set("search", applied.trim());
        if (kind) qs.set("kind", kind);
        if (lifecycle) qs.set("lifecycle", lifecycle);
        if (plan) qs.set("plan", plan);
        if (customersOnly) qs.set("customersOnly", "true");

        const res = (await apiFetch(
          `/v1/admin/workspaces?${qs.toString()}`,
        )) as ListResponse;
        setData(res ?? null);
        setPage(res?.page ?? targetPage);

        // Reflect the view in the address bar so it can be shared and returned to.
        const shareable = new URLSearchParams(qs);
        shareable.delete("page");
        shareable.delete("limit");
        router.replace(
          shareable.toString()
            ? `/admin/workspaces?${shareable.toString()}`
            : "/admin/workspaces",
          { scroll: false },
        );
      } catch (err) {
        addToast(
          toSafeUserError(err, { message: "We couldn't load the workspace directory." })
            .message,
          "error",
        );
        setData(null);
      } finally {
        setLoading(false);
      }
    },
    [addToast, applied, kind, lifecycle, plan, customersOnly, router],
  );

  useEffect(() => {
    void load(1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [applied, kind, lifecycle, plan, customersOnly]);

  const columns = useMemo<DataTableColumn<WorkspaceRow>[]>(
    () => [
      {
        key: "name",
        header: "Workspace",
        render: (r) => (
          <div style={{ minWidth: 0 }}>
            <div style={{ fontWeight: 650 }}>{r.name}</div>
            {/* A DATE, NOT A TIMESTAMP TO THE SECOND.
                This read `Created 05 Sept 2026, 13:54:05 Europe/Berlin` under
                every workspace name, wrapping to two lines and making each row
                three lines tall — in a table an operator SCANS. Nobody finds a
                workspace by the second it was created; the precise stamp is on
                the workspace detail page. */}
            <div className="adm-help" style={{ marginTop: 2 }}>
              Created {formatUserDate(r.createdAt)}
            </div>
          </div>
        ),
      },
      {
        key: "kind",
        header: "Kind",
        render: (r) => <Badge tone={KIND_TONE[r.kind]}>{KIND_LABEL[r.kind]}</Badge>,
      },
      {
        key: "lifecycle",
        header: "Lifecycle",
        render: (r) =>
          r.lifecycle === "LIVE" ? (
            <Badge tone="verified" dot>
              Live
            </Badge>
          ) : (
            <Badge tone="neutral" dot title={r.closedAtUtc ?? undefined}>
              Closed
            </Badge>
          ),
      },
      {
        key: "customer",
        header: "Customer",
        render: (r) =>
          // Only a CUSTOMER organization is a customer. A SYSTEM container is the
          // workspace's own bootstrap row and is shown as what it is.
          r.organization && r.organization.kind === "CUSTOMER" ? (
            <a
              href={`/admin/customers/${encodeURIComponent(r.organization.id)}`}
              style={{ color: "var(--accent-600)" }}
            >
              {r.organization.name}
            </a>
          ) : (
            <span style={{ color: "var(--ink-muted)", fontSize: 12 }}>
              Self-service
            </span>
          ),
      },
      {
        key: "owner",
        header: "Owner",
        render: (r) =>
          r.owner?.email ? (
            <a
              href={`/admin/users/${encodeURIComponent(r.owner.userId)}`}
              style={{ color: "var(--accent-600)", fontSize: 12.5 }}
            >
              {r.owner.email}
            </a>
          ) : (
            <span style={{ color: "var(--ink-muted)" }}>—</span>
          ),
      },
      {
        key: "plan",
        header: "Stored plan",
        /* ONE PHRASE, NOT TWO STACKED BADGES.
           A plan and its subscription status are one fact about billing, and
           rendering them as two badges wrapped to two lines on every row. The
           status is the one that can be wrong, so it carries the tone; the
           plan is the noun it qualifies. */
        render: (r) => (
          <Badge tone={BILLING_TONE[r.raw.billingStatus] ?? "neutral"} subtle>
            {r.raw.billingPlan} · {r.raw.billingStatus.toLowerCase()}
          </Badge>
        ),
      },
      {
        key: "seats",
        header: "Seats",
        align: "right",
        render: (r) => (
          <span title="Active members only — suspended and revoked members do not consume a seat">
            {r.seatsUsed}
            {r.raw.includedSeats > 0 ? ` / ${r.raw.includedSeats}` : ""}
          </span>
        ),
      },
      {
        key: "evidence",
        header: "Evidence",
        align: "right",
        render: (r) => r.evidenceCount,
      },
      {
        key: "incidents",
        header: "Open incidents",
        align: "right",
        render: (r) =>
          r.openIncidents > 0 ? (
            <a
              href={`/admin/operations?teamId=${encodeURIComponent(r.id)}`}
              style={{ color: "var(--risk-strong)", fontWeight: 700 }}
            >
              {r.openIncidents}
            </a>
          ) : (
            <span style={{ color: "var(--ink-muted)" }}>0</span>
          ),
      },
    ],
    [],
  );

  const clear = () => {
    setSearch("");
    setApplied("");
    setKind("");
    setLifecycle("LIVE");
    setPlan("");
    setCustomersOnly(false);
  };

  const total = data?.total ?? 0;
  const rangeStart = total === 0 ? 0 : (page - 1) * PAGE_SIZE + 1;
  const rangeEnd = Math.min(page * PAGE_SIZE, total);

  return (
    <PageShell
      width="full"
      header={
        <PageHeader
          eyebrow="Platform control center"
          title="Workspaces"
          subtitle="Every workspace on the platform, by kind and lifecycle. A closed workspace is excluded from the live view by default and remains findable under Closed — closure revokes access without touching billing, so the two are reported separately."
        />
      }
      >

      <FilterBar
        actions={
          <>
            <Button variant="secondary" size="sm" onClick={() => void load(page)}>
              Refresh
            </Button>
            <Button variant="ghost" size="sm" onClick={clear}>
              Clear
            </Button>
          </>
        }
      >
        <form
          onSubmit={(e) => {
            e.preventDefault();
            setApplied(search);
          }}
          style={{ display: "contents" }}
        >
          <FilterBar.Search
            label="Search workspaces"
            value={search}
            onChange={setSearch}
            onBlur={() => setApplied(search)}
            placeholder="Workspace, customer or owner email…"
          />
        </form>

        <FilterBar.Select
          label="Kind"
          value={kind}
          onChange={setKind}
          options={[
            { value: "", label: "All kinds" },
            { value: "PERSONAL", label: "Personal" },
            { value: "OWNED", label: "Owned" },
            { value: "ORGANIZATION", label: "Organization" },
          ]}
        />

        <FilterBar.Select
          label="Lifecycle"
          value={lifecycle}
          onChange={setLifecycle}
          options={[
            { value: "LIVE", label: "Live" },
            { value: "CLOSED", label: "Closed" },
            { value: "ALL", label: "All" },
          ]}
        />

        <FilterBar.Select
          label="Stored plan"
          value={plan}
          onChange={setPlan}
          options={[
            { value: "", label: "All plans" },
            { value: "FREE", label: "Free" },
            { value: "PAYG", label: "Pay-as-you-go" },
            { value: "PRO", label: "Pro" },
            { value: "TEAM", label: "Team plan" },
            { value: "ENTERPRISE", label: "Enterprise" },
          ]}
        />

        <FilterBar.Select
          label="Ownership"
          value={customersOnly ? "true" : ""}
          onChange={(v) => setCustomersOnly(v === "true")}
          options={[
            { value: "", label: "All workspaces" },
            { value: "true", label: "Customer-owned only" },
          ]}
        />
      </FilterBar>

      <Card>
        <DataTable<WorkspaceRow>
          ariaLabel="Platform workspaces"
          columns={columns}
          rows={data?.items ?? []}
          getRowId={(r) => r.id}
          loading={loading}
          onRowClick={(r) => router.push(
            detailHrefWithReturn(
              `/admin/workspaces/${encodeURIComponent(r.id)}`,
              params?.toString() ?? null,
            ),
          )}
          emptyState={
            <EmptyState variant="inline"
              title="No workspaces match"
              purpose="No workspace matches the current filters. Adjust the search or filters above — the Lifecycle filter defaults to Live, so closed workspaces are hidden unless you ask for them."
            />
          }
        />

        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 12,
            flexWrap: "wrap",
            fontSize: 13,
            color: "var(--ink-secondary)",
            marginTop: 16,
          }}
        >
          <span>
            {total === 0
              ? "No workspaces"
              : `Showing ${rangeStart}–${rangeEnd} of ${total} workspace${total === 1 ? "" : "s"}`}
          </span>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => void load(page - 1)}
              disabled={loading || page <= 1}
            >
              Previous
            </Button>
            <span style={{ minWidth: 90, textAlign: "center" }}>
              Page {data?.totalPages === 0 ? 0 : page} of {data?.totalPages ?? 0}
            </span>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => void load(page + 1)}
              disabled={loading || page >= (data?.totalPages ?? 0)}
            >
              Next
            </Button>
          </div>
        </div>
      </Card>
    </PageShell>
  );
}
