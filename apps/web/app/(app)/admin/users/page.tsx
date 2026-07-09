"use client";

/**
 * Platform Control Center P1 — Platform Users roster (/admin/users).
 *
 * READ-ONLY roster over the EXISTING identity models, served by
 * GET /v1/admin/users (services/api/src/routes/admin-users.routes.ts).
 *
 * Honesty rules enforced here:
 *   • Every absent value renders as "—" (cells) or "Not measured"
 *     (signals we cannot yet source, e.g. riskStatus). NOTHING is faked.
 *   • `lastLoginAt` is real-or-null: the backend derives it from the
 *     newest `login_completed` analytics event; a user who never logged
 *     in shows "—", never a guessed timestamp.
 *   • Errors flow ONLY through `toSafeUserError` (the sole sanctioned
 *     error-display path). No raw error.message passthrough.
 *   • No legacy chrome (no app-hero / cc-page / btn- classes). Renders
 *     through the shared PageShell + the platform.admin gate inherited
 *     from admin/layout.tsx.
 */

import { useCallback, useEffect, useState } from "react";

import { PageShell, PageHeader, FilterBar, DataTable } from "../../../../components/ui";
import type { DataTableColumn } from "../../../../components/ui";
import { Card } from "../../../../components/ui/Card";
import { Button } from "../../../../components/ui/Button";
import { Badge } from "../../../../components/ui/Badge";
import { EmptyState } from "../../../../components/ui/EmptyState";
import { useToast } from "../../../../components/ui";
import AdminConsoleNav from "../../../../components/admin/AdminConsoleNav";
import { apiFetch } from "../../../../lib/api";
import { toSafeUserError } from "../../../../lib/feedback/toSafeUserError";
import { formatUserDateTime } from "../../../../lib/date";

type PlatformProvider = "GOOGLE" | "APPLE" | "GUEST" | "EMAIL";

type PlatformUserRow = {
  id: string;
  email: string | null;
  name: string | null;
  createdAt: string;
  provider: PlatformProvider;
  platformRole: string | null;
  orgMembershipsCount: number;
  workspaceMembershipsCount: number;
  mfaEnrolled: boolean;
  lastLoginAt: string | null;
  suspended: boolean;
  deactivated: boolean;
  country: string | null;
  timezone: string | null;
  riskStatus: string | null;
};

type UsersResponse = {
  items: PlatformUserRow[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
};

const PAGE_SIZE = 25;

const PROVIDER_LABEL: Record<PlatformProvider, string> = {
  GOOGLE: "Google",
  APPLE: "Apple",
  GUEST: "Guest",
  EMAIL: "Email",
};

function dash(value?: string | null): string {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed.length > 0 ? trimmed : "—";
}

function formatTimestamp(value?: string | null): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return formatUserDateTime(value);
}

function statusLabel(row: PlatformUserRow): {
  label: string;
  tone: "verified" | "risk" | "neutral";
} {
  if (row.deactivated) return { label: "Deactivated", tone: "risk" };
  if (row.suspended) return { label: "Suspended", tone: "risk" };
  return { label: "Active", tone: "verified" };
}

export default function AdminUsersPage() {
  const { addToast } = useToast();

  const [loading, setLoading] = useState(true);
  const [items, setItems] = useState<PlatformUserRow[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(0);

  // Filter inputs. `appliedSearch` is what we actually query with, so
  // typing in the search box does not fire a request on every keystroke.
  const [search, setSearch] = useState("");
  const [appliedSearch, setAppliedSearch] = useState("");
  const [roleFilter, setRoleFilter] = useState("");
  const [providerFilter, setProviderFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState("");

  const loadUsers = useCallback(async () => {
    try {
      setLoading(true);

      const params = new URLSearchParams();
      params.set("page", String(page));
      params.set("pageSize", String(PAGE_SIZE));
      if (appliedSearch.trim()) params.set("search", appliedSearch.trim());
      if (roleFilter) params.set("platformRole", roleFilter);
      if (providerFilter) params.set("provider", providerFilter);
      if (statusFilter) params.set("suspended", statusFilter);

      const data: UsersResponse = await apiFetch(
        `/v1/admin/users?${params.toString()}`
      );

      setItems(Array.isArray(data?.items) ? data.items : []);
      setTotal(typeof data?.total === "number" ? data.total : 0);
      setTotalPages(typeof data?.totalPages === "number" ? data.totalPages : 0);
    } catch (err) {
      const message = toSafeUserError(err, {
        message: "Failed to load platform users",
      }).message;
      addToast(message, "error");
      setItems([]);
      setTotal(0);
      setTotalPages(0);
    } finally {
      setLoading(false);
    }
  }, [page, appliedSearch, roleFilter, providerFilter, statusFilter, addToast]);

  useEffect(() => {
    void loadUsers();
  }, [loadUsers]);

  // Any filter change resets to page 1.
  useEffect(() => {
    setPage(1);
  }, [appliedSearch, roleFilter, providerFilter, statusFilter]);

  const columns: DataTableColumn<PlatformUserRow>[] = [
    {
      key: "email",
      header: "Email",
      render: (row) => dash(row.email),
    },
    {
      key: "name",
      header: "Name",
      render: (row) => dash(row.name),
    },
    {
      key: "provider",
      header: "Provider (IdP)",
      render: (row) => PROVIDER_LABEL[row.provider] ?? dash(row.provider),
    },
    {
      key: "platformRole",
      header: "Platform role",
      render: (row) =>
        row.platformRole ? (
          <Badge tone="governance">Admin</Badge>
        ) : (
          <span style={{ color: "var(--ink-muted, #94a3b8)" }}>—</span>
        ),
    },
    {
      key: "orgs",
      header: "Orgs",
      align: "right",
      render: (row) => row.orgMembershipsCount,
    },
    {
      key: "workspaces",
      header: "Workspaces",
      align: "right",
      render: (row) => row.workspaceMembershipsCount,
    },
    {
      key: "mfa",
      header: "MFA",
      render: (row) =>
        row.mfaEnrolled ? (
          <Badge tone="verified">Enrolled</Badge>
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
      render: (row) => formatTimestamp(row.lastLoginAt),
    },
    {
      key: "status",
      header: "Status",
      render: (row) => {
        const { label, tone } = statusLabel(row);
        return <Badge tone={tone}>{label}</Badge>;
      },
    },
  ];

  const rangeStart = total === 0 ? 0 : (page - 1) * PAGE_SIZE + 1;
  const rangeEnd = Math.min(page * PAGE_SIZE, total);

  return (
    <PageShell
      header={
        <PageHeader
          eyebrow="Platform Control Center"
          title="Users"
          subtitle="Read-only roster of every platform user, sourced directly from the identity models. Fields that cannot yet be measured are shown honestly rather than filled in."
        />
      }
    >
      <AdminConsoleNav />

      <Card>
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <FilterBar
            actions={
              <Button
                variant="secondary"
                size="sm"
                onClick={() => void loadUsers()}
                disabled={loading}
              >
                {loading ? "Refreshing…" : "Refresh"}
              </Button>
            }
          >
            <form
              onSubmit={(e) => {
                e.preventDefault();
                setAppliedSearch(search);
              }}
              style={{ display: "contents" }}
            >
              <FilterBar.Search
                label="Search users by email or name"
                value={search}
                onChange={setSearch}
                onBlur={() => setAppliedSearch(search)}
                placeholder="Search email or name…"
              />
            </form>

            <FilterBar.Select
              label="Platform role"
              value={roleFilter}
              onChange={setRoleFilter}
              options={[
                { value: "", label: "All roles" },
                { value: "admin", label: "Platform admin" },
              ]}
            />

            <FilterBar.Select
              label="Provider"
              value={providerFilter}
              onChange={setProviderFilter}
              options={[
                { value: "", label: "All providers" },
                { value: "GOOGLE", label: "Google" },
                { value: "APPLE", label: "Apple" },
                { value: "EMAIL", label: "Email" },
                { value: "GUEST", label: "Guest" },
              ]}
            />

            <FilterBar.Select
              label="Status"
              value={statusFilter}
              onChange={setStatusFilter}
              options={[
                { value: "", label: "All statuses" },
                { value: "true", label: "Suspended / deactivated" },
                { value: "false", label: "Active only" },
              ]}
            />
          </FilterBar>

          <DataTable<PlatformUserRow>
            ariaLabel="Platform users"
            columns={columns}
            rows={items}
            getRowId={(row) => row.id}
            loading={loading}
            emptyState={
              <EmptyState
                title="No users found"
                purpose="No platform users match the current filters. Adjust the search or filters above."
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
              color: "var(--ink-secondary, #475569)",
            }}
          >
            <span>
              {total === 0
                ? "No users"
                : `Showing ${rangeStart}–${rangeEnd} of ${total} user${
                    total === 1 ? "" : "s"
                  }`}
            </span>

            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                disabled={loading || page <= 1}
              >
                Previous
              </Button>
              <span style={{ minWidth: 90, textAlign: "center" }}>
                Page {totalPages === 0 ? 0 : page} of {totalPages}
              </span>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => setPage((p) => (totalPages ? Math.min(totalPages, p + 1) : p))}
                disabled={loading || totalPages === 0 || page >= totalPages}
              >
                Next
              </Button>
            </div>
          </div>
        </div>
      </Card>
    </PageShell>
  );
}
