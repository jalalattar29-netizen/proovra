"use client";

/**
 * PHASE 12 VERTICAL C — Evidence delivery history.
 *
 * Consumes GET /v1/integrations/webhooks/deliveries, which had no product
 * consumer: the durable record of every evidence package this workspace
 * handed to an outside recipient, and what happened to it afterwards.
 *
 * Why this exists as its own surface: the Exchange console could only show
 * deliveries it had recorded in the CURRENT browser session, so the moment an
 * operator reloaded, the answer to "did the other side ever open it?"
 * disappeared. This section reads the server projection, so it survives
 * reloads and shows deliveries recorded by anyone in the workspace.
 *
 * Safety properties, all enforced by the server and simply RENDERED here:
 *
 *   * Tenancy is a database predicate; nothing is filtered in the browser.
 *   * The `state` on each row is derived SERVER-SIDE. "Authorized" (a
 *     recipient was recorded) and "completed" (the package was actually
 *     downloaded) are DIFFERENT states and this surface never collapses one
 *     into the other.
 *   * No signing secret, signature header, provider credential, or signed
 *     URL is part of the projection — nothing here can leak one, and nothing
 *     is written to storage or logs.
 *   * Pagination is deterministic and cursor-based; the cursor is an opaque
 *     row id held in component state only for the duration of the view.
 */

import { useCallback, useEffect, useState } from "react";

import { apiFetch } from "../../../../lib/api";
import { formatUserDateTime } from "../../../../lib/date";
import { toSafeUserError } from "../../../../lib/feedback/toSafeUserError";
import { useTenantGuard } from "../../../../lib/platform-context";
import { Button } from "../../../../components/ui/Button";
import { Card } from "../../../../components/ui/Card";
import { Badge } from "../../../../components/ui/Badge";
import { EmptyState } from "../../../../components/ui/EmptyState";
import {
  DataTable,
  type DataTableColumn,
} from "../../../../components/ui/DataTable";

type DeliveryState = "RECORDED" | "DOWNLOADED" | "VERIFIED";

type DeliveryRow = {
  id: string;
  packageId: string;
  recipientEmail: string | null;
  recipientOrgSlug: string | null;
  channel: string | null;
  deliveredAtUtc: string;
  downloadedAtUtc: string | null;
  verifiedAtUtc: string | null;
  state: DeliveryState;
};

type Phase =
  | { kind: "loading" }
  | { kind: "ready"; rows: DeliveryRow[]; nextCursor: string | null }
  | { kind: "denied"; title: string; detail: string }
  | { kind: "error"; detail: string };

const STATE_COPY: Record<
  DeliveryState,
  { label: string; tone: "neutral" | "governance" | "verified" }
> = {
  RECORDED: { label: "Sent, not opened", tone: "neutral" },
  DOWNLOADED: { label: "Opened by recipient", tone: "governance" },
  VERIFIED: { label: "Verified by recipient", tone: "verified" },
};

const mutedStyle = {
  fontSize: 12.5,
  lineHeight: 1.55,
  color: "var(--ink-secondary, #475569)",
} as const;

export function EvidenceDeliveryHistorySection() {
  const { stamp, isStale } = useTenantGuard();
  const [phase, setPhase] = useState<Phase>({ kind: "loading" });
  const [loadingMore, setLoadingMore] = useState(false);

  const load = useCallback(
    async (cursor: string | null, append: boolean) => {
      const captured = stamp();
      if (append) setLoadingMore(true);
      else setPhase({ kind: "loading" });
      try {
        const qs = new URLSearchParams({ limit: "50" });
        if (cursor) qs.set("cursor", cursor);
        const res = (await apiFetch(
          `/v1/integrations/webhooks/deliveries?${qs.toString()}`,
          { method: "GET" },
        )) as { deliveries?: DeliveryRow[]; nextCursor?: string | null };
        if (isStale(captured)) return;
        const incoming = res.deliveries ?? [];
        setPhase((prev) =>
          append && prev.kind === "ready"
            ? {
                kind: "ready",
                rows: [...prev.rows, ...incoming],
                nextCursor: res.nextCursor ?? null,
              }
            : {
                kind: "ready",
                rows: incoming,
                nextCursor: res.nextCursor ?? null,
              },
        );
      } catch (err) {
        if (isStale(captured)) return;
        const e = (err ?? {}) as { statusCode?: number; status?: number; code?: unknown };
        const status = e.statusCode ?? e.status;
        const code = typeof e.code === "string" ? e.code.toLowerCase() : "";
        if (
          status === 403 ||
          status === 404 ||
          code === "forbidden" ||
          code === "not_found" ||
          code === "permission_denied"
        ) {
          setPhase({
            kind: "denied",
            title: "You can't see delivery history",
            detail:
              "Delivery history names the outside recipients of evidence packages, so it needs integration administration in this workspace. Nothing was loaded.",
          });
          return;
        }
        setPhase({
          kind: "error",
          detail: toSafeUserError(err, {
            message: "Could not load delivery history.",
          }).message,
        });
      } finally {
        if (append) setLoadingMore(false);
      }
    },
    [stamp, isStale],
  );

  useEffect(() => {
    void load(null, false);
  }, [load]);

  const columns: DataTableColumn<DeliveryRow>[] = [
    {
      key: "recipient",
      header: "Recipient",
      render: (d) => (
        <div style={{ fontSize: 12.5 }}>
          <div style={{ fontWeight: 600 }}>
            {d.recipientEmail ?? d.recipientOrgSlug ?? "Unnamed recipient"}
          </div>
          <div style={mutedStyle}>
            {d.channel ? d.channel.toLowerCase().replace(/_/g, " ") : "signed link"}
          </div>
        </div>
      ),
    },
    {
      key: "state",
      header: "What happened",
      render: (d) => {
        const copy = STATE_COPY[d.state] ?? STATE_COPY.RECORDED;
        return (
          <span data-delivery-state={d.state}>
            <Badge tone={copy.tone} subtle>
              {copy.label}
            </Badge>
          </span>
        );
      },
    },
    {
      key: "sent",
      header: "Sent",
      render: (d) => (
        <span style={mutedStyle}>{formatUserDateTime(d.deliveredAtUtc)}</span>
      ),
    },
    {
      key: "opened",
      header: "Opened",
      render: (d) => (
        <span style={mutedStyle}>
          {d.downloadedAtUtc ? formatUserDateTime(d.downloadedAtUtc) : "Not yet"}
        </span>
      ),
    },
    {
      key: "verified",
      header: "Verified",
      render: (d) => (
        <span style={mutedStyle}>
          {d.verifiedAtUtc ? formatUserDateTime(d.verifiedAtUtc) : "Not yet"}
        </span>
      ),
    },
  ];

  return (
    <Card
      variant="admin"
      padding="comfortable"
      title="Evidence delivery history"
      data-testid="integrations-delivery-history"
    >
      <p style={{ ...mutedStyle, marginTop: 0, maxWidth: 720 }}>
        Every evidence package this workspace handed to an outside recipient,
        and whether they actually opened and verified it. Sending is recorded
        separately from opening — a package that was sent but never opened
        never reads as delivered.
      </p>

      {phase.kind === "loading" ? (
        <p style={mutedStyle} data-testid="integrations-delivery-history-loading">
          Reading delivery history…
        </p>
      ) : null}

      {phase.kind === "denied" ? (
        <Card
          variant="status"
          tone="risk"
          padding="comfortable"
          data-testid="integrations-delivery-history-denied"
        >
          <strong style={{ fontSize: 14 }}>{phase.title}</strong>
          <p style={{ ...mutedStyle, marginTop: 6, marginBottom: 0, maxWidth: 620 }}>
            {phase.detail}
          </p>
        </Card>
      ) : null}

      {phase.kind === "error" ? (
        <Card
          variant="status"
          tone="risk"
          padding="comfortable"
          data-testid="integrations-delivery-history-error"
        >
          <strong style={{ fontSize: 14 }}>That didn&apos;t load</strong>
          <p style={{ ...mutedStyle, marginTop: 6, marginBottom: 10 }}>{phase.detail}</p>
          <Button variant="secondary" size="sm" onClick={() => void load(null, false)}>
            Try again
          </Button>
        </Card>
      ) : null}

      {phase.kind === "ready" ? (
        <>
          <DataTable
            columns={columns}
            rows={phase.rows}
            getRowId={(d) => d.id}
            density="compact"
            ariaLabel="Evidence delivery history"
            emptyState={
              <EmptyState
                compact
                title="No packages have been delivered yet"
                purpose="When you share an evidence package with someone outside the workspace, the delivery and what the recipient did with it appear here."
              />
            }
          />
          <div style={{ display: "flex", gap: 8, marginTop: 10, flexWrap: "wrap" }}>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => void load(null, false)}
            >
              Refresh
            </Button>
            {phase.nextCursor ? (
              <Button
                variant="secondary"
                size="sm"
                loading={loadingMore}
                disabled={loadingMore}
                onClick={() => void load(phase.nextCursor, true)}
                data-testid="integrations-delivery-history-more"
              >
                Show older
              </Button>
            ) : null}
          </div>
        </>
      ) : null}
    </Card>
  );
}
