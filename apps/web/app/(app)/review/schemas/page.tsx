"use client";

/**
 * PROOVRA Phase 2A — Coding Schemas admin surface.
 *
 * Workspace-anchored list of coding schemas with seed-defaults action.
 * Detail editing + new-schema authoring are linked from here; the
 * primary surface focuses on quick discovery + the one-click default
 * seed so reviewers can be productive within seconds of opening the
 * workspace.
 *
 * Batch J — schema authors can retire a schema:
 *   POST /v1/coding/schemas/:id/archive?teamId=  (review.schema.author)
 * An archived schema can no longer be bound to a review; values already
 * coded against it are kept. Whether the caller may archive comes from the
 * server's reviewer projection (GET /v1/reviewer/workspace capabilities),
 * never from a role string here. A failed or refused list read is stated,
 * never shown as "no schemas".
 */

import { useCallback, useEffect, useRef, useState } from "react";

import { identifierLabel, type ReviewerCapability } from "@proovra/shared";

import { PageRouteGate } from "../../../../components/navigation/PageRouteGate";
import { OperationalEmptyState } from "../../../../components/operational";
import { apiFetch } from "../../../../lib/api";
import { toSafeUserError } from "../../../../lib/feedback/toSafeUserError";
import { useActiveSpaceId } from "../../../../lib/platform-context";
import {
  fetchReviewerWorkspace,
  seedDefaultSchemas,
  type CodingSchemaRow,
} from "../../../../lib/reviewer-workspace/reviewer-api";
import { PageShell, PageHeader } from "../../../../components/ui/PageShell";
import { Card } from "../../../../components/ui/Card";
import { Button } from "../../../../components/ui/Button";
import { Badge } from "../../../../components/ui/Badge";
import { DataTable } from "../../../../components/ui/DataTable";
import { useConfirmAction } from "../../../../components/ui/ConfirmActionModal";

type ListState =
  | { kind: "loading" }
  | { kind: "ready"; rows: CodingSchemaRow[] }
  | { kind: "failed"; message: string };

type CapabilityState =
  | { kind: "loading" }
  | { kind: "ready"; capabilities: ReadonlyArray<ReviewerCapability> }
  | { kind: "failed" };

export default function CodingSchemasPage() {
  return (
    <PageRouteGate routeId="workspace.coding_schemas">
      <SchemasShell />
    </PageRouteGate>
  );
}

function SchemasShell() {
  const teamId = useActiveSpaceId();
  // Keyed by workspace so nothing from the previous workspace survives a switch.
  if (!teamId) {
    return (
      <PageShell data-coding-schemas-page>
        <OperationalEmptyState
          title="Select a workspace"
          reason="Choose an active workspace before loading coding schemas."
        />
      </PageShell>
    );
  }
  return <SchemasWorkspace key={teamId} teamId={teamId} />;
}

function statusOf(err: unknown): number {
  const s = (err as { statusCode?: unknown } | null)?.statusCode;
  return typeof s === "number" ? s : 0;
}

function SchemasWorkspace({ teamId }: { teamId: string }) {
  const { confirm } = useConfirmAction();
  const [list, setList] = useState<ListState>({ kind: "loading" });
  const [caps, setCaps] = useState<CapabilityState>({ kind: "loading" });
  const [seeding, setSeeding] = useState(false);
  const [archivingId, setArchivingId] = useState<string | null>(null);
  const [banner, setBanner] = useState<{
    tone: "success" | "degraded" | "error";
    text: string;
  } | null>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const listUrl = `/v1/coding/schemas?teamId=${encodeURIComponent(teamId)}`;

  const refresh = useCallback(async (): Promise<CodingSchemaRow[] | null> => {
    try {
      const res = await apiFetch(listUrl, { method: "GET" });
      const rows = (res?.schemas ?? []) as CodingSchemaRow[];
      if (alive.current) setList({ kind: "ready", rows });
      return rows;
    } catch (err) {
      if (alive.current) {
        setList({
          kind: "failed",
          message:
            statusOf(err) === 403
              ? "You do not have access to coding schemas in this workspace."
              : toSafeUserError(err, {
                  message: "Schema list could not be loaded. Try again or verify workspace access.",
                }).message,
        });
      }
      return null;
    }
  }, [listUrl]);

  useEffect(() => {
    void refresh();
    fetchReviewerWorkspace(teamId)
      .then((ws) => {
        if (!alive.current) return;
        setCaps(ws ? { kind: "ready", capabilities: ws.capabilities } : { kind: "failed" });
      })
      .catch(() => {
        if (alive.current) setCaps({ kind: "failed" });
      });
  }, [refresh, teamId]);

  const canAuthor = caps.kind === "ready" && caps.capabilities.includes("review.schema.author");
  const authorReason =
    caps.kind === "loading"
      ? "Checking your reviewer permissions…"
      : caps.kind === "failed"
        ? "Your reviewer permissions could not be loaded. Refresh the page to try again."
        : !canAuthor
          ? "Only schema authors in this workspace can archive a schema."
          : undefined;

  const onSeed = useCallback(async () => {
    setSeeding(true);
    try {
      const res = await seedDefaultSchemas(teamId);
      if (res.degraded || res.reason === "SCHEMA_NOT_READY") {
        setBanner({
          tone: "degraded",
          text: "Schema seed is degraded: reviewer-workspace schema columns are not ready in this environment yet. No success state is being claimed.",
        });
      } else {
        setBanner({
          tone: "success",
          text: `Seed complete: ${res.created} created, ${res.updated} updated, ${res.existing} already present, ${res.failed} failed.`,
        });
      }
      await refresh();
    } catch {
      setBanner({
        tone: "error",
        text: "Schema seed could not be completed. Retry after checking reviewer schema permissions.",
      });
    } finally {
      if (alive.current) setSeeding(false);
    }
  }, [refresh, teamId]);

  const onArchive = useCallback(
    async (schema: CodingSchemaRow) => {
      if (archivingId || !canAuthor || schema.status === "ARCHIVED") return;
      setArchivingId(schema.id);
      setBanner(null);
      try {
        const ok = await confirm({
          title: `Archive the schema "${schema.label}"?`,
          description:
            "It can no longer be bound to a review workflow. Workflows already bound to it and every value already coded against it are kept.",
          confirmLabel: "Archive schema",
          tone: "danger",
        });
        if (!ok || !alive.current) return;
        try {
          await apiFetch(
            `/v1/coding/schemas/${encodeURIComponent(schema.id)}/archive?teamId=${encodeURIComponent(teamId)}`,
            { method: "POST", body: "{}" },
          );
        } catch (err) {
          if (!alive.current) return;
          const status = statusOf(err);
          setBanner({
            tone: "error",
            text:
              status === 403
                ? "Only schema authors in this workspace can archive a schema."
                : status === 409 || status === 404
                  ? "This schema no longer exists in this workspace. The list has been refreshed."
                  : toSafeUserError(err, {
                      message: "The schema could not be archived. Nothing was changed.",
                    }).message,
          });
          if (status === 409 || status === 404) await refresh();
          return;
        }
        const rows = await refresh();
        if (!alive.current) return;
        const reread = rows?.find((r) => r.id === schema.id);
        setBanner(
          reread?.status === "ARCHIVED"
            ? {
                tone: "success",
                text: `Schema "${schema.label}" archived. The saved list shows it as archived.`,
              }
            : {
                tone: "error",
                text: rows
                  ? "The archive request was sent, but the saved list does not show the schema as archived yet. Refresh before acting on it."
                  : "The archive request was sent, but the schema list could not be reloaded to confirm it. Refresh before acting on it.",
              },
        );
      } finally {
        if (alive.current) setArchivingId(null);
      }
    },
    [archivingId, canAuthor, confirm, refresh, teamId],
  );

  const rows = list.kind === "ready" ? list.rows : [];

  return (
    <PageShell
      data-coding-schemas-page
      header={
        <PageHeader
          eyebrow="Review operations"
          title="Coding schemas"
          subtitle="Structured review templates. Reviewers code against published schemas; legacy free-form notes remain available under the generic schema."
          primaryAction={
            <Button
              variant="primary"
              onClick={onSeed}
              disabled={seeding}
              loading={seeding}
              data-coding-seed-defaults
            >
              {seeding ? "Seeding…" : "Seed 6 default schemas"}
            </Button>
          }
        />
      }
    >
      {banner ? (
        <Card
          variant="status"
          tone={
            banner.tone === "success"
              ? "verified"
              : banner.tone === "degraded"
                ? "pending"
                : "risk"
          }
          data-coding-seed-banner
        >
          <p role={banner.tone === "error" ? "alert" : "status"} style={{ margin: 0 }}>
            {banner.text}
          </p>
        </Card>
      ) : null}

      <Card variant="admin" padding="compact">
        <div
          style={{
            fontSize: 12,
            color: "var(--ink-secondary, #475569)",
            display: "flex",
            gap: 10,
            flexWrap: "wrap",
          }}
        >
          <strong style={{ color: "var(--ink-primary, #0f172a)" }}>
            Workspace-scoped schemas
          </strong>
          <span>
            {list.kind === "ready"
              ? `${rows.length} visible in this workspace.`
              : list.kind === "loading"
                ? "Loading schemas…"
                : "Schema count unavailable."}
          </span>
          <span>
            Reviewer Workspace coding fields appear only when an active workflow
            is bound to one of these schemas. Bind a schema from a review&apos;s page in
            Reviewer operations.
          </span>
        </div>
      </Card>

      {list.kind === "failed" ? (
        <Card variant="status" tone="risk" data-coding-schemas-error>
          <p role="alert" style={{ margin: 0 }}>{list.message}</p>
          <Button size="sm" onClick={() => void refresh()} style={{ marginTop: 8 }}>
            Retry
          </Button>
        </Card>
      ) : (
        <div data-coding-schemas-table-wrap style={{ minWidth: 0, overflowX: "auto" }}>
          <DataTable
            ariaLabel="Coding schemas"
            loading={list.kind === "loading"}
            rows={rows}
            getRowId={(s) => s.id}
            columns={[
              {
                key: "label",
                header: "Label",
                render: (s) => (
                  <div data-coding-schema-row={s.id}>
                    <strong>{s.label}</strong>
                    <div style={{ color: "var(--ink-muted, #64748b)", fontSize: 11 }}>
                      <code data-identifier>{s.slug}</code>
                    </div>
                  </div>
                ),
              },
              { key: "category", header: "Category", render: (s) => identifierLabel(s.category) },
              {
                key: "version",
                header: "Version",
                nowrap: true,
                render: (s) => `v${s.version}`,
              },
              {
                key: "status",
                header: "Status",
                render: (s) => (
                  <Badge tone={s.status === "ARCHIVED" ? "neutral" : "verified"} subtle>
                    {identifierLabel(s.status)}
                  </Badge>
                ),
              },
              {
                key: "fields",
                header: "Fields",
                align: "right",
                render: (s) =>
                  (s as unknown as { _count?: { fields: number } })._count
                    ?.fields ?? "—",
              },
              {
                key: "actions",
                header: "Actions",
                render: (s) => {
                  const reason =
                    s.status === "ARCHIVED"
                      ? "This schema is already archived."
                      : archivingId && archivingId !== s.id
                        ? "Another schema is being archived."
                        : authorReason;
                  return (
                    <Button
                      size="sm"
                      variant="destructive"
                      loading={archivingId === s.id}
                      disabled={Boolean(reason)}
                      disabledReason={reason}
                      aria-label={`Archive ${s.label}`}
                      onClick={() => void onArchive(s)}
                      data-coding-schema-archive={s.id}
                    >
                      Archive
                    </Button>
                  );
                },
              },
            ]}
            emptyState={
              <div data-coding-schemas-empty>
                <OperationalEmptyState
                  kicker="Coding schemas"
                  title="No coding schemas are available in this workspace yet."
                  reason="Reviewer coding appears when a workflow is bound to a published schema. Seed defaults installs the six built-in schemas when the workspace schema contract is ready."
                  actions={[
                    { label: "Open Reviewer Workspace", href: "/review/workspace" },
                    { label: "Open evidence workflows", href: "/evidence" },
                  ]}
                  emptyStateCode="coding_schemas_empty"
                />
              </div>
            }
          />
        </div>
      )}
    </PageShell>
  );
}
