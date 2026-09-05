"use client";

/**
 * Platform Control Center — Customers / Organizations roster.
 *
 * READ-ONLY platform-admin surface. Wrapped in the admin console layout
 * (which inherits the `platform.admin` PageRouteGate from admin/layout.tsx
 * — no conflicting gate is added here). Every field comes from the
 * /v1/admin/organizations endpoint; null fields render "—" / "Not
 * measured". Errors surface via toSafeUserError. No app-hero/cc-page/btn-
 * classes.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";

import {
  PageShell,
  PageHeader,
  FilterBar,
  DataTable,
  useToast,
} from "../../../../components/ui";
import type { DataTableColumn } from "../../../../components/ui";
import { Badge } from "../../../../components/ui/Badge";
import { EmptyState } from "../../../../components/ui/EmptyState";
import { Button } from "../../../../components/ui/Button";
import { apiFetch } from "../../../../lib/api";
import { toSafeUserError } from "../../../../lib/feedback/toSafeUserError";
import { formatUserDateTime } from "../../../../lib/date";
// PHASE 6 §7 — carry the list state onto the detail URL so the return link
// can put the operator back on the page they filtered, not on page one of
// everything. Only the OWNING collection does this: a link from Billing to
// a customer should return to Billing, not to the customer directory.
import { detailHrefWithReturn } from "../../../../lib/navigation/adminReturnState";

type OnboardingHealth = "HEALTHY" | "ATTENTION" | "BLOCKED" | "UNKNOWN";

type LifecycleStage =
  | "LEAD"
  | "DEMO_REQUESTED"
  | "CONTACT_SALES"
  | "PROVISIONED"
  | "ONBOARDING"
  | "ACTIVE"
  | "AT_RISK"
  | "SUSPENDED"
  | "CANCELLED"
  | "ARCHIVED"
  | "UNKNOWN";

type OrgListItem = {
  id: string;
  name: string;
  createdAt: string;
  status: string;
  plan: string | null;
  /** ADM-003 — TRUE only for an ACTIVE EnterpriseContract, never a plan string. */
  enterprise: boolean;
  contract: {
    status: string;
    seatCount: number | null;
    endsAtUtc: string | null;
  } | null;
  workspaceCount: number;
  seats: { included: number; used: number };
  ownerEmail: string | null;
  verifiedDomainsCount: number;
  ssoConfigured: boolean;
  scimConfigured: boolean;
  onboardingStatus: OnboardingHealth;
  lastActivityAt: string | null;
  lifecycleStage: LifecycleStage;
  lifecycleReasons: string[];
};

type ListResponse = {
  items: OrgListItem[];
  page: number;
  limit: number;
  total: number;
  totalPages: number;
};

const HEALTH_TONE: Record<
  OnboardingHealth,
  "verified" | "pending" | "risk" | "neutral"
> = {
  HEALTHY: "verified",
  ATTENTION: "pending",
  BLOCKED: "risk",
  UNKNOWN: "neutral",
};

const LIFECYCLE_TONE: Record<
  LifecycleStage,
  "verified" | "pending" | "risk" | "neutral" | "info" | "governance"
> = {
  ACTIVE: "verified",
  ONBOARDING: "info",
  PROVISIONED: "info",
  LEAD: "neutral",
  DEMO_REQUESTED: "neutral",
  CONTACT_SALES: "neutral",
  AT_RISK: "pending",
  SUSPENDED: "risk",
  CANCELLED: "risk",
  ARCHIVED: "neutral",
  UNKNOWN: "neutral",
};

const LIFECYCLE_LABEL: Record<LifecycleStage, string> = {
  LEAD: "Lead",
  DEMO_REQUESTED: "Demo requested",
  CONTACT_SALES: "Contact sales",
  PROVISIONED: "Provisioned",
  ONBOARDING: "Onboarding",
  ACTIVE: "Active",
  AT_RISK: "At risk",
  SUSPENDED: "Suspended",
  CANCELLED: "Cancelled",
  ARCHIVED: "Archived",
  UNKNOWN: "Unknown",
};

function dash(value: string | null | undefined) {
  return value && value.trim() ? value : "—";
}

export default function AdminOrganizationsPage() {
  const router = useRouter();
  const { addToast } = useToast();

  const [items, setItems] = useState<OrgListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [totalPages, setTotalPages] = useState(1);

  // ADM-017 — the Overview links here with a filter already chosen
  // (`?status=SUSPENDED`, `?health=BLOCKED`, `?enterprise=true`). Seeding the
  // filter state FROM the URL is what makes those tiles real drill-downs: a
  // link that lands on an unfiltered page 1 shows a different population than
  // the number that was clicked, which is worse than no link at all.
  const params = useSearchParams();
  const [search, setSearch] = useState(params.get("search") ?? "");
  const [planFilter, setPlanFilter] = useState(params.get("plan") ?? "");
  const [statusFilter, setStatusFilter] = useState(params.get("status") ?? "");
  const [healthFilter, setHealthFilter] = useState(params.get("health") ?? "");
  const [enterpriseFilter, setEnterpriseFilter] = useState(
    params.get("enterprise") ?? "",
  );

  const load = useCallback(
    async (targetPage: number) => {
      try {
        setLoading(true);
        const qs = new URLSearchParams();
        qs.set("page", String(targetPage));
        qs.set("limit", "20");
        if (search.trim()) qs.set("search", search.trim());
        if (planFilter) qs.set("plan", planFilter);
        if (statusFilter) qs.set("status", statusFilter);
        if (healthFilter) qs.set("health", healthFilter);
        // Enterprise is a CONTRACT fact, resolved server-side against the
        // contract table — never a `billingPlan` string (ADM-003).
        if (enterpriseFilter) qs.set("enterprise", enterpriseFilter);

        const data: ListResponse = await apiFetch(
          `/v1/admin/customers?${qs.toString()}`,
        );
        setItems(Array.isArray(data?.items) ? data.items : []);
        setPage(data?.page ?? targetPage);
        setTotal(data?.total ?? 0);
        setTotalPages(data?.totalPages ?? 1);
      } catch (err) {
        const message = toSafeUserError(err, {
          message: "We couldn't load the organizations roster.",
        }).message;
        addToast(message, "error");
      } finally {
        setLoading(false);
      }
    },
    [addToast, search, planFilter, statusFilter, healthFilter, enterpriseFilter],
  );

  useEffect(() => {
    void load(1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [planFilter, statusFilter, healthFilter, enterpriseFilter]);

  const columns = useMemo<DataTableColumn<OrgListItem>[]>(
    () => [
      {
        key: "name",
        header: "Organization",
        render: (row) => (
          <div style={{ minWidth: 0 }}>
            <div style={{ fontWeight: 650 }}>{dash(row.name)}</div>
            <div
              style={{
                fontSize: 12,
                color: "var(--ink-muted)",
                marginTop: 2,
              }}
            >
              Created {formatUserDateTime(row.createdAt)}
            </div>
          </div>
        ),
      },
      {
        key: "lifecycleStage",
        header: "Lifecycle",
        render: (row) => (
          <Badge
            tone={LIFECYCLE_TONE[row.lifecycleStage] ?? "neutral"}
            dot
            title={
              row.lifecycleReasons && row.lifecycleReasons.length > 0
                ? row.lifecycleReasons.join(" ")
                : undefined
            }
          >
            {LIFECYCLE_LABEL[row.lifecycleStage] ?? row.lifecycleStage}
          </Badge>
        ),
      },
      {
        key: "plan",
        header: "Workspace plan",
        render: (row) =>
          row.plan ? (
            <Badge tone={row.enterprise ? "governance" : "info"}>
              {row.plan}
            </Badge>
          ) : (
            <span style={{ color: "var(--ink-muted)" }}>—</span>
          ),
      },
      {
        // ADM-003 / ADM-015 — the CONTRACT, which is what actually decides
        // whether somebody is an enterprise customer. The Plan column beside it
        // is the workspace projection and is labelled as such.
        key: "contract",
        header: "Enterprise contract",
        render: (row) =>
          row.contract ? (
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
              <Badge tone={row.contract.status === "ACTIVE" ? "verified" : "risk"}>
                {row.contract.status}
              </Badge>
              {row.contract.seatCount ? (
                <Badge tone="neutral" subtle>
                  {row.contract.seatCount} seats
                </Badge>
              ) : null}
            </div>
          ) : (
            <span style={{ color: "var(--ink-muted)" }}>None</span>
          ),
      },
      {
        key: "workspaceCount",
        header: "Workspaces",
        align: "right",
        render: (row) => row.workspaceCount,
      },
      {
        key: "seats",
        header: "Seats",
        align: "right",
        render: (row) => `${row.seats.used} / ${row.seats.included}`,
      },
      {
        key: "ownerEmail",
        header: "Owner",
        render: (row) =>
          row.ownerEmail ? (
            row.ownerEmail
          ) : (
            <span style={{ color: "var(--ink-muted)" }}>
              Not measured
            </span>
          ),
      },
      {
        key: "verifiedDomainsCount",
        header: "Domains",
        align: "right",
        render: (row) => row.verifiedDomainsCount,
      },
      {
        key: "identity",
        header: "SSO / SCIM",
        render: (row) => (
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            <Badge tone={row.ssoConfigured ? "verified" : "neutral"} subtle>
              {row.ssoConfigured ? "SSO" : "No SSO"}
            </Badge>
            <Badge tone={row.scimConfigured ? "verified" : "neutral"} subtle>
              {row.scimConfigured ? "SCIM" : "No SCIM"}
            </Badge>
          </div>
        ),
      },
      {
        key: "onboardingStatus",
        header: "Health",
        render: (row) => (
          <Badge tone={HEALTH_TONE[row.onboardingStatus]} dot>
            {row.onboardingStatus}
          </Badge>
        ),
      },
    ],
    [],
  );

  const clearFilters = () => {
    setSearch("");
    setPlanFilter("");
    setStatusFilter("");
    setHealthFilter("");
  };

  return (
    <PageShell
      width="full"
      header={
        <PageHeader
          eyebrow="Platform Control Center"
          title="Customers"
          subtitle="Read-only roster of every customer organization: plan, workspaces, seat usage, owner, domain verification, SSO/SCIM posture, and onboarding health. Aggregated from live records — nothing here is fabricated."
        />
      }
        >

      <FilterBar
        actions={
          <>
            <Button variant="secondary" size="sm" onClick={() => void load(page)}>
              Refresh
            </Button>
            <Button variant="ghost" size="sm" onClick={clearFilters}>
              Clear
            </Button>
          </>
        }
      >
        <FilterBar.Search
          label="Search organizations"
          value={search}
          onChange={setSearch}
          placeholder="Search by name or owner email…"
          onKeyDown={(e) => {
            if (e.key === "Enter") void load(1);
          }}
        />
        <FilterBar.Select
          label="Plan"
          value={planFilter}
          onChange={setPlanFilter}
          options={[
            { value: "", label: "All plans" },
            { value: "FREE", label: "Free" },
            { value: "PAYG", label: "Pay as you go" },
            { value: "PRO", label: "Pro" },
            { value: "TEAM", label: "Team plan" },
            { value: "ENTERPRISE", label: "Enterprise" },
          ]}
        />
        <FilterBar.Select
          label="Status"
          value={statusFilter}
          onChange={setStatusFilter}
          options={[
            { value: "", label: "All statuses" },
            { value: "ACTIVE", label: "Active" },
            { value: "SUSPENDED", label: "Suspended" },
            { value: "ARCHIVED", label: "Archived" },
          ]}
        />
        <FilterBar.Select
          label="Health"
          value={healthFilter}
          onChange={setHealthFilter}
          options={[
            { value: "", label: "All health" },
            { value: "HEALTHY", label: "Healthy" },
            { value: "ATTENTION", label: "Attention" },
            { value: "BLOCKED", label: "Blocked" },
            { value: "UNKNOWN", label: "Unknown" },
          ]}
        />
        <FilterBar.Select
          label="Enterprise"
          value={enterpriseFilter}
          onChange={setEnterpriseFilter}
          options={[
            { value: "", label: "All customers" },
            { value: "true", label: "Has active contract" },
            { value: "false", label: "No active contract" },
          ]}
        />
      </FilterBar>

      <DataTable
        ariaLabel="Customer organizations"
        columns={columns}
        rows={items}
        getRowId={(row) => row.id}
        loading={loading}
        onRowClick={(row) =>
          router.push(
            detailHrefWithReturn(
              `/admin/customers/${encodeURIComponent(row.id)}`,
              params?.toString() ?? null,
            ),
          )
        }
        emptyState={
          <EmptyState variant="inline"
            title="No customers yet"
            purpose="Customer organizations appear here once they exist. This roster is read-only and reflects live records."
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
        }}
      >
        <div>
          {/* "page 1 of 0" is what an unguarded totalPages prints on an
              empty result, and it reads as a broken pager rather than an
              empty list. With no rows there is no pagination to describe, so
              the count stands alone. */}
          {total === 0
            ? "No organizations match these filters"
            : `${total} organization${total === 1 ? "" : "s"} · page ${page} of ${Math.max(1, totalPages)}`}
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <Button
            variant="secondary"
            size="sm"
            disabled={loading || page <= 1}
            onClick={() => void load(page - 1)}
          >
            Previous
          </Button>
          <Button
            variant="secondary"
            size="sm"
            disabled={loading || page >= totalPages}
            onClick={() => void load(page + 1)}
          >
            Next
          </Button>
        </div>
      </div>
    </PageShell>
  );
}
