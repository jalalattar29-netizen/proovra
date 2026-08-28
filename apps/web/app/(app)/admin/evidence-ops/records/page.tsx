"use client";

/**
 * PLATFORM ADMIN — Evidence health drill-down (ADM-029, ADM-019).
 *
 * THE PAGE THAT DID NOT EXIST
 * ---------------------------------------------------------------------------
 * Every evidence-health figure was a terminal scalar: "TSA failures: 34" with
 * no way to learn whose evidence had failed. And global search, on finding a
 * piece of evidence, sent the operator to `/admin/evidence-ops` — a page of
 * global counters that had discarded the record id entirely.
 *
 * This surface answers both: `?signal=…` enumerates a failure population,
 * `?evidenceId=…` resolves one record, and every row names the workspace and
 * customer it belongs to.
 *
 * WHAT IS NOT HERE, DELIBERATELY
 * ---------------------------------------------------------------------------
 * Evidence content. No file, no storage key, no hash, no signature, no internal
 * notes — the API's projection excludes them and this page could not render
 * them if it tried. Platform-operations visibility and evidence-content
 * authorization are separate grants, and a platform-admin gate does not merge
 * them.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";

import {
  PageShell,
  PageHeader,
  FilterBar,
  DataTable,
  useToast,
  type DataTableColumn,
} from "../../../../../components/ui";
import { Badge, type BadgeTone } from "../../../../../components/ui/Badge";
import { Button } from "../../../../../components/ui/Button";
import { Card } from "../../../../../components/ui/Card";
import { EmptyState } from "../../../../../components/ui/EmptyState";
import { apiFetch } from "../../../../../lib/api";
import { formatUserDateTime } from "../../../../../lib/date";
import { toSafeUserError } from "../../../../../lib/feedback/toSafeUserError";

type RecordRow = {
  id: string;
  title: string | null;
  type: string;
  status: string;
  verificationStatus: string | null;
  tsaStatus: string | null;
  otsStatus: string | null;
  createdAt: string;
  workspace: {
    id: string;
    name: string;
    kind: string;
    lifecycle: "LIVE" | "CLOSED";
  } | null;
  customer: { id: string; name: string } | null;
  ownerEmail: string | null;
};

type Response = {
  signal: string | null;
  label: string;
  items: RecordRow[];
  page: number;
  limit: number;
  total: number;
  totalPages: number;
};

const SIGNALS = [
  { value: "TSA_FAILED", label: "Timestamp (TSA) failures" },
  { value: "OTS_FAILED", label: "OpenTimestamps anchoring failures" },
  { value: "HASH_MISMATCH", label: "Hash mismatch" },
  { value: "VERIFICATION_FAILED", label: "Verification failed" },
  { value: "SIGNED_NO_REPORT", label: "Signed, no report" },
  { value: "REPORTED_NO_PACKAGE", label: "Reported, no package" },
] as const;

const PAGE_SIZE = 50;

const STATUS_TONE: Record<string, BadgeTone> = {
  FAILED: "risk",
  CONFIRMED: "verified",
  PENDING: "pending",
};

export default function AdminEvidenceRecordsPage() {
  const { addToast } = useToast();
  const router = useRouter();
  const params = useSearchParams();

  const evidenceId = params.get("evidenceId") ?? "";
  const [signal, setSignal] = useState(params.get("signal") ?? "TSA_FAILED");
  const [teamId, setTeamId] = useState(params.get("teamId") ?? "");

  const [loading, setLoading] = useState(true);
  const [data, setData] = useState<Response | null>(null);
  const [page, setPage] = useState(1);

  const load = useCallback(
    async (targetPage: number) => {
      setLoading(true);
      try {
        const qs = new URLSearchParams();
        qs.set("page", String(targetPage));
        qs.set("limit", String(PAGE_SIZE));
        // A direct record lookup is not a signal query — sending both would ask
        // "this record, but only if it also has that failure", which is not what
        // a search click means.
        if (evidenceId) qs.set("evidenceId", evidenceId);
        else if (signal) qs.set("signal", signal);
        if (teamId) qs.set("teamId", teamId);

        const res = (await apiFetch(
          `/v1/admin/evidence-health/records?${qs.toString()}`,
        )) as Response;
        setData(res ?? null);
        setPage(res?.page ?? targetPage);

        if (!evidenceId) {
          const shareable = new URLSearchParams();
          shareable.set("signal", signal);
          if (teamId) shareable.set("teamId", teamId);
          router.replace(`/admin/evidence-ops/records?${shareable.toString()}`, {
            scroll: false,
          });
        }
      } catch (err) {
        addToast(
          toSafeUserError(err, {
            message: "We couldn't load the affected records.",
          }).message,
          "error",
        );
        setData(null);
      } finally {
        setLoading(false);
      }
    },
    [addToast, evidenceId, signal, teamId, router],
  );

  useEffect(() => {
    void load(1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signal, teamId, evidenceId]);

  const columns = useMemo<DataTableColumn<RecordRow>[]>(
    () => [
      {
        key: "record",
        header: "Record",
        render: (r) => (
          <div style={{ minWidth: 0 }}>
            <div style={{ fontWeight: 620 }}>{r.title ?? "(untitled)"}</div>
            <div
              style={{
                fontSize: 11.5,
                fontFamily: "monospace",
                color: "var(--ink-muted, #94a3b8)",
                marginTop: 2,
              }}
            >
              {r.id}
            </div>
          </div>
        ),
      },
      { key: "type", header: "Type", render: (r) => r.type },
      {
        key: "status",
        header: "Pipeline status",
        render: (r) => <Badge tone="info" subtle>{r.status}</Badge>,
      },
      {
        key: "preservation",
        header: "Preservation",
        render: (r) => (
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            {r.tsaStatus ? (
              <Badge tone={STATUS_TONE[r.tsaStatus] ?? "neutral"} subtle>
                TSA {r.tsaStatus}
              </Badge>
            ) : null}
            {r.otsStatus ? (
              <Badge tone={STATUS_TONE[r.otsStatus] ?? "neutral"} subtle>
                OTS {r.otsStatus}
              </Badge>
            ) : null}
            {r.verificationStatus ? (
              <Badge tone={STATUS_TONE[r.verificationStatus] ?? "neutral"} subtle>
                Verify {r.verificationStatus}
              </Badge>
            ) : null}
          </div>
        ),
      },
      {
        key: "workspace",
        header: "Workspace",
        render: (r) =>
          r.workspace ? (
            <div style={{ minWidth: 0 }}>
              <Link href={`/admin/workspaces/${encodeURIComponent(r.workspace.id)}`}>
                {r.workspace.name}
              </Link>
              <div style={{ fontSize: 12, color: "var(--ink-muted, #94a3b8)", marginTop: 2 }}>
                {r.customer ? (
                  <Link href={`/admin/customers/${encodeURIComponent(r.customer.id)}`}>
                    {r.customer.name}
                  </Link>
                ) : (
                  "Self-service"
                )}
                {r.workspace.lifecycle === "CLOSED" ? " · closed" : ""}
              </div>
            </div>
          ) : (
            <span style={{ color: "var(--ink-muted, #94a3b8)" }}>—</span>
          ),
      },
      {
        key: "owner",
        header: "Owner",
        render: (r) => (
          <span style={{ fontSize: 12.5 }}>{r.ownerEmail ?? "—"}</span>
        ),
      },
      {
        key: "createdAt",
        header: "Created",
        nowrap: true,
        render: (r) => formatUserDateTime(r.createdAt),
      },
    ],
    [],
  );

  const total = data?.total ?? 0;
  const rangeStart = total === 0 ? 0 : (page - 1) * PAGE_SIZE + 1;
  const rangeEnd = Math.min(page * PAGE_SIZE, total);

  return (
    <PageShell
      width="full"
      header={
        <PageHeader
          eyebrow="Evidence health"
          title={evidenceId ? "Record lookup" : (data?.label ?? "Affected records")}
          subtitle={
            evidenceId
              ? "One evidence record, resolved by id. Operational metadata only — no file, no storage key, no hash and no signature is shown here or returned by the API."
              : "The evidence records behind one health signal, with the workspace and customer each belongs to. Operational metadata only — no evidence content."
          }
          secondaryActions={
            <>
              <Link href="/admin/evidence-ops" style={{ textDecoration: "none" }}>
                <Button variant="ghost">← Evidence health</Button>
              </Link>
              <Button variant="secondary" onClick={() => void load(page)} disabled={loading}>
                Refresh
              </Button>
            </>
          }
        />
      }
    >

      {!evidenceId ? (
        <FilterBar>
          <FilterBar.Select
            label="Failure signal"
            value={signal}
            onChange={setSignal}
            options={SIGNALS.map((s) => ({ value: s.value, label: s.label }))}
          />
          <FilterBar.Search
            label="Workspace ID"
            value={teamId}
            onChange={setTeamId}
            placeholder="Narrow to one workspace…"
          />
        </FilterBar>
      ) : null}

      <Card>
        <DataTable<RecordRow>
          ariaLabel="Affected evidence records"
          columns={columns}
          rows={data?.items ?? []}
          getRowId={(r) => r.id}
          loading={loading}
          emptyState={
            <EmptyState
              title={evidenceId ? "Record not found" : "No affected records"}
              purpose={
                evidenceId
                  ? "No live evidence record matches that id. It may have been deleted."
                  : "No live evidence record currently carries this failure signal. An empty table here means zero, not unmeasured."
              }
            />
          }
        />

        {!evidenceId ? (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 12,
              flexWrap: "wrap",
              fontSize: 13,
              color: "var(--ink-secondary, #475569)",
              marginTop: 16,
            }}
          >
            <span>
              {total === 0
                ? "No records"
                : `Showing ${rangeStart}–${rangeEnd} of ${total} record${total === 1 ? "" : "s"}`}
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
        ) : null}
      </Card>
    </PageShell>
  );
}
