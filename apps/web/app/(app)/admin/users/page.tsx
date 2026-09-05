"use client";

/**
 * PLATFORM ADMIN — People (ADM-028, ADM-016, ADM-017).
 *
 * WHAT CHANGED
 * ---------------------------------------------------------------------------
 * This roster was a well-built view of the WRONG dimension: identity and
 * security only, with no plan, no subscription, no workspace and no detail
 * route. The console could show a PRO count and could not name a single PRO
 * customer.
 *
 * Three things are new and each closes a specific finding:
 *   • commercial columns and filters — "list our PRO users" is `?tier=PRO`;
 *   • pending cancellation is its own visible state, not an ordinary ACTIVE;
 *   • rows open a real detail page, and `?search=` from global search is
 *     actually READ (it used to be emitted and ignored, so the deep link landed
 *     on an unfiltered page 1 that might not contain the person searched for).
 *
 * The security posture is unchanged: the API's column allow-list still excludes
 * every password hash, MFA secret and token, and `riskStatus` stays honestly
 * null because no per-user risk model exists.
 */

import { useCallback, useEffect, useState } from "react";
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
import { LifecycleRequestQueue } from "./_sections/LifecycleRequestQueue";
import { apiFetch } from "../../../../lib/api";
import { formatUserDate, formatUserDateTime } from "../../../../lib/date";
import { toSafeUserError } from "../../../../lib/feedback/toSafeUserError";
// PHASE 6 §7 — carry the list state onto the detail URL so the return link
// can put the operator back on the page they filtered, not on page one of
// everything. Only the OWNING collection does this: a link from Billing to
// a customer should return to Billing, not to the customer directory.
import { detailHrefWithReturn } from "../../../../lib/navigation/adminReturnState";
import { useUrlFilterSync } from "../../../../lib/use-url-filter-sync";

type PersonRow = {
  id: string;
  email: string | null;
  name: string | null;
  createdAt: string;
  provider: string;
  platformRole: string | null;
  accountTier: string | null;
  subscriptions: Array<{
    id: string;
    provider: string;
    plan: string;
    status: string;
    cancelAtPeriodEnd: boolean;
    currentPeriodEnd: string | null;
  }>;
  pendingCancellation: boolean;
  hasLiveSubscription: boolean;
  personalWorkspaceId: string | null;
  ownedWorkspaceCount: number;
  workspaceMembershipsCount: number;
  orgMembershipsCount: number;
  mfaEnrolled: boolean;
  lastLoginAt: string | null;
  memberships: { active: number; suspended: number; revoked: number };
  country: string | null;
  timezone: string | null;
  riskStatus: null;
};

type Response = {
  items: PersonRow[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
};

const PAGE_SIZE = 25;

const TIER_TONE: Record<string, BadgeTone> = {
  FREE: "neutral",
  PAYG: "info",
  PRO: "verified",
  TEAM: "governance",
  ENTERPRISE: "governance",
};

function dash(v?: string | null): string {
  const t = typeof v === "string" ? v.trim() : "";
  return t.length > 0 ? t : "—";
}

export default function AdminPeoplePage() {
  const { addToast } = useToast();
  const router = useRouter();
  const params = useSearchParams();

  const [search, setSearch] = useState(params.get("search") ?? "");
  const [applied, setApplied] = useState(params.get("search") ?? "");
  const [tier, setTier] = useState(params.get("tier") ?? "");
  const [provider, setProvider] = useState(params.get("provider") ?? "");
  const [subscriptionStatus, setSubscriptionStatus] = useState(
    params.get("subscriptionStatus") ?? "",
  );
  const [pendingCancellation, setPendingCancellation] = useState(
    params.get("pendingCancellation") === "true",
  );
  const [platformRole, setPlatformRole] = useState(params.get("platformRole") ?? "");

  const [loading, setLoading] = useState(true);
  const [data, setData] = useState<Response | null>(null);
  const [page, setPage] = useState(1);

  const load = useCallback(
    async (targetPage: number) => {
      setLoading(true);
      try {
        const qs = new URLSearchParams();
        qs.set("page", String(targetPage));
        qs.set("pageSize", String(PAGE_SIZE));
        if (applied.trim()) qs.set("search", applied.trim());
        if (tier) qs.set("tier", tier);
        if (provider) qs.set("provider", provider);
        if (subscriptionStatus) qs.set("subscriptionStatus", subscriptionStatus);
        if (pendingCancellation) qs.set("pendingCancellation", "true");
        if (platformRole) qs.set("platformRole", platformRole);

        const res = (await apiFetch(`/v1/admin/users?${qs.toString()}`)) as Response;
        setData(res ?? null);
        setPage(res?.page ?? targetPage);
      } catch (err) {
        addToast(
          toSafeUserError(err, { message: "Failed to load platform people" }).message,
          "error",
        );
        setData(null);
      } finally {
        setLoading(false);
      }
    },
    [
      addToast,
      applied,
      tier,
      provider,
      subscriptionStatus,
      pendingCancellation,
      platformRole,
    ],
  );

  // The shareable URL follows the FILTERS, not the response — see
  // `lib/use-url-filter-sync.ts` for the click this used to cancel.
  useUrlFilterSync("/admin/users", {
    search: applied.trim(),
    tier,
    provider,
    subscriptionStatus,
    pendingCancellation,
    platformRole,
  });

  useEffect(() => {
    void load(1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [applied, tier, provider, subscriptionStatus, pendingCancellation, platformRole]);

  const columns: DataTableColumn<PersonRow>[] = [
    {
      key: "email",
      header: "Person",
      render: (r) => (
        <div style={{ minWidth: 0 }}>
          <div style={{ fontWeight: 620 }}>{dash(r.email)}</div>
          {/* A DATE, NOT A STAMP TO THE SECOND. This read
              `joined 05 Sept 2026, 11:19:54 Europe/Berlin` under every
              address, wrapped to two lines, and made every row in the roster
              three lines tall. LAST LOGIN keeps its full precision, because
              there the seconds are the point. */}
          <div className="adm-help" style={{ marginTop: 2 }}>
            {dash(r.name)} · joined {formatUserDate(r.createdAt)}
          </div>
        </div>
      ),
    },
    {
      key: "tier",
      header: "Account tier",
      render: (r) =>
        r.accountTier ? (
          <Badge tone={TIER_TONE[r.accountTier] ?? "neutral"}>{r.accountTier}</Badge>
        ) : (
          <span style={{ color: "var(--ink-muted)" }}>None</span>
        ),
    },
    {
      key: "subscription",
      header: "Subscription",
      render: (r) => {
        if (r.subscriptions.length === 0) {
          return <span style={{ color: "var(--ink-muted)" }}>—</span>;
        }
        const live = r.subscriptions.filter(
          (s) => s.status === "ACTIVE" || s.status === "TRIALING",
        );
        const shown = live.length > 0 ? live : r.subscriptions.slice(0, 1);
        return (
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            {shown.map((s) => (
              <Badge
                key={s.id}
                tone={s.status === "ACTIVE" ? "verified" : "neutral"}
                subtle
              >
                {s.provider} {s.plan} · {s.status}
              </Badge>
            ))}
            {r.pendingCancellation ? (
              <Badge tone="pending" title="Active, but will not renew">
                Cancels at period end
              </Badge>
            ) : null}
          </div>
        );
      },
    },
    {
      key: "workspaces",
      header: "Workspaces",
      align: "right",
      render: (r) => (
        <span title={`${r.ownedWorkspaceCount} owned · ${r.orgMembershipsCount} org memberships`}>
          {r.workspaceMembershipsCount}
        </span>
      ),
    },
    {
      key: "memberships",
      header: "Membership states",
      render: (r) => (
        // ADM-028 — these are MEMBERSHIP states. They were previously rendered
        // as "Account suspended" / "Deactivated", which the data never
        // supported: `User` models no account-level disable at all.
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", fontSize: 12 }}>
          <Badge tone="verified" subtle>
            {r.memberships.active} active
          </Badge>
          {r.memberships.suspended > 0 ? (
            <Badge tone="pending" subtle>
              {r.memberships.suspended} suspended
            </Badge>
          ) : null}
          {r.memberships.revoked > 0 ? (
            <Badge tone="risk" subtle>
              {r.memberships.revoked} revoked
            </Badge>
          ) : null}
        </div>
      ),
    },
    {
      key: "platformRole",
      header: "Platform role",
      render: (r) =>
        r.platformRole ? (
          <Badge tone="governance">Admin</Badge>
        ) : (
          <span style={{ color: "var(--ink-muted)" }}>—</span>
        ),
    },
    {
      key: "mfa",
      header: "MFA",
      render: (r) =>
        r.mfaEnrolled ? (
          <Badge tone="verified" subtle>
            Enrolled
          </Badge>
        ) : (
          <Badge tone="neutral" subtle>
            None
          </Badge>
        ),
    },
    {
      key: "lastLoginAt",
      header: "Last login",
      nowrap: true,
      render: (r) => (r.lastLoginAt ? formatUserDateTime(r.lastLoginAt) : "—"),
    },
  ];

  const clear = () => {
    setSearch("");
    setApplied("");
    setTier("");
    setProvider("");
    setSubscriptionStatus("");
    setPendingCancellation(false);
    setPlatformRole("");
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
          title="People"
          subtitle="Every person on the platform, with the commercial context that answers 'what do they pay for?'. Membership states are shown as memberships — this platform models no account-level disable, so nothing here claims one."
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
            label="Search people by email or name"
            value={search}
            onChange={setSearch}
            onBlur={() => setApplied(search)}
            placeholder="Email or name…"
          />
        </form>

        <FilterBar.Select
          label="Account tier"
          value={tier}
          onChange={setTier}
          options={[
            { value: "", label: "All tiers" },
            { value: "FREE", label: "Free" },
            { value: "PAYG", label: "Pay-as-you-go" },
            { value: "PRO", label: "Pro" },
            { value: "TEAM", label: "Team plan" },
            { value: "ENTERPRISE", label: "Enterprise" },
          ]}
        />

        <FilterBar.Select
          label="Subscription status"
          value={subscriptionStatus}
          onChange={setSubscriptionStatus}
          options={[
            { value: "", label: "Any subscription" },
            { value: "ACTIVE", label: "Active" },
            { value: "TRIALING", label: "Trialing" },
            { value: "PAST_DUE", label: "Past due" },
            { value: "CANCELED", label: "Canceled" },
          ]}
        />

        <FilterBar.Select
          label="Cancellation"
          value={pendingCancellation ? "true" : ""}
          onChange={(v) => setPendingCancellation(v === "true")}
          options={[
            { value: "", label: "Any cancellation state" },
            { value: "true", label: "Pending cancellation" },
          ]}
        />

        <FilterBar.Select
          label="Provider"
          value={provider}
          onChange={setProvider}
          options={[
            { value: "", label: "All providers" },
            { value: "EMAIL", label: "Email" },
            { value: "GOOGLE", label: "Google" },
            { value: "APPLE", label: "Apple" },
            { value: "GUEST", label: "Guest" },
          ]}
        />

        <FilterBar.Select
          label="Platform role"
          value={platformRole}
          onChange={setPlatformRole}
          options={[
            { value: "", label: "All roles" },
            { value: "admin", label: "Platform admin" },
          ]}
        />
      </FilterBar>

      <Card>
        <DataTable<PersonRow>
          ariaLabel="Platform people"
          columns={columns}
          rows={data?.items ?? []}
          getRowId={(r) => r.id}
          loading={loading}
          onRowClick={(r) => router.push(
            detailHrefWithReturn(
              `/admin/users/${encodeURIComponent(r.id)}`,
              params?.toString() ?? null,
            ),
          )}
          emptyState={
            <EmptyState variant="inline"
              title="No people found"
              purpose="No platform user matches the current filters. Adjust the search or filters above."
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
              ? "No people"
              : `Showing ${rangeStart}–${rangeEnd} of ${total} person${total === 1 ? "" : "s"}`}
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

      <LifecycleRequestQueue />
    </PageShell>
  );
}
