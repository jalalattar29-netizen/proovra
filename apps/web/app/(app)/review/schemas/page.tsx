"use client";

/**
 * PROOVRA Phase 2A — Coding Schemas admin surface.
 *
 * Workspace-anchored list of coding schemas with seed-defaults action.
 * Detail editing + new-schema authoring are linked from here; the
 * primary surface focuses on quick discovery + the one-click default
 * seed so reviewers can be productive within seconds of opening the
 * workspace.
 */

import { useCallback, useEffect, useState } from "react";

import { PageRouteGate } from "../../../../components/navigation/PageRouteGate";
import { OperationalEmptyState } from "../../../../components/operational";
import { apiFetch } from "../../../../lib/api";
import { useActiveSpaceId } from "../../../../lib/platform-context";
import {
  seedDefaultSchemas,
  type CodingSchemaRow,
} from "../../../../lib/reviewer-workspace/reviewer-api";
import { PageShell, PageHeader } from "../../../../components/ui/PageShell";
import { Card } from "../../../../components/ui/Card";
import { Button } from "../../../../components/ui/Button";
import { Badge } from "../../../../components/ui/Badge";
import { DataTable } from "../../../../components/ui/DataTable";

export default function CodingSchemasPage() {
  return (
    <PageRouteGate routeId="workspace.coding_schemas">
      <SchemasShell />
    </PageRouteGate>
  );
}

function SchemasShell() {
  const teamId = useActiveSpaceId();
  const [schemas, setSchemas] = useState<CodingSchemaRow[] | null>(null);
  const [seeding, setSeeding] = useState(false);
  const [banner, setBanner] = useState<{
    tone: "success" | "degraded" | "error";
    text: string;
  } | null>(null);

  // `isStale` lets the effect discard a response that arrived after the
  // workspace changed (or the page unmounted) — the previous workspace's
  // schemas must never paint under the newly selected one.
  const refresh = useCallback(async (isStale?: () => boolean) => {
    if (!teamId) {
      setSchemas([]);
      return;
    }
    try {
      const res = await apiFetch(
        `/v1/coding/schemas?teamId=${encodeURIComponent(teamId)}`,
        { method: "GET" },
      );
      if (isStale?.()) return;
      setSchemas((res?.schemas ?? []) as CodingSchemaRow[]);
    } catch {
      if (isStale?.()) return;
      setSchemas([]);
      setBanner({
        tone: "error",
        text: "Schema list could not be loaded. Try again or verify workspace access.",
      });
    }
  }, [teamId]);

  useEffect(() => {
    let cancelled = false;
    void refresh(() => cancelled);
    return () => {
      cancelled = true;
    };
  }, [refresh]);

  const onSeed = useCallback(async () => {
    if (!teamId) {
      setBanner({
        tone: "error",
        text: "Select a workspace before seeding schemas.",
      });
      return;
    }
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
      setSeeding(false);
    }
  }, [refresh, teamId]);

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
          {banner.text}
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
          <span>{schemas?.length ?? 0} visible in this workspace.</span>
          <span>
            Reviewer Workspace coding fields appear only when an active workflow
            is bound to one of these schemas.
          </span>
        </div>
      </Card>

      <div data-coding-schemas-table-wrap>
        <DataTable
          ariaLabel="Coding schemas"
          loading={schemas === null}
          rows={schemas ?? []}
          getRowId={(s) => s.id}
          columns={[
            {
              key: "label",
              header: "Label",
              render: (s) => (
                <div data-coding-schema-row={s.id}>
                  <strong>{s.label}</strong>
                  <div style={{ color: "var(--ink-muted, #64748b)", fontSize: 11 }}>
                    {s.slug}
                  </div>
                </div>
              ),
            },
            { key: "category", header: "Category", render: (s) => s.category },
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
                <Badge tone="neutral" subtle>
                  {s.status}
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
    </PageShell>
  );
}
