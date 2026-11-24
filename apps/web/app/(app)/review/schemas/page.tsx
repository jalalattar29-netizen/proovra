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

import { PLAN_REFUSAL_COPY, isPlanRefusal } from "../../../../lib/feedback/plan-refusal";
import { useCallback, useEffect, useRef, useState } from "react";

import { CODING_SCHEMA_DEFAULT_SLUGS, identifierLabel, type ReviewerCapability } from "@proovra/shared";

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
import { PageShell } from "../../../../components/ui/PageShell";
// TEAM-UI-SPEC (structure) — the one review page header: icon title row, the
// tool name, a "← Review" back link above it, no eyebrow.
import {
  ReviewPageHeader,
  REVIEW_HUB_BACK,
} from "../../../../components/reviewer-experience/ReviewPageHeader";
import { Badge } from "../../../../components/ui/Badge";
import { CanonicalActionButton } from "../../../../components/external-review/CanonicalActionButton";
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
    } catch (err) {
      setBanner({
        tone: "error",
        // PRO-R2-14 — a plan refusal is said as such.
        text: isPlanRefusal(err)
          ? PLAN_REFUSAL_COPY
          : "Schema seed could not be completed. Retry after checking reviewer schema permissions.",
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
  // T-134 (audit PRD-08) — seeding installs only the built-in schemas this
  // workspace does not hold (archived ones count as held). With all six
  // present it would change nothing, so it is not offered as an action.
  const missingDefaults =
    list.kind === "ready"
      ? CODING_SCHEMA_DEFAULT_SLUGS.filter((slug) => !rows.some((r) => r.slug === slug)).length
      : null;
  const seedReason =
    missingDefaults === null
      ? "Loading the schemas in this workspace…"
      : missingDefaults === 0
        ? "All six default schemas are already in this workspace."
        : null;

  return (
    <PageShell
      data-coding-schemas-page
      header={
        <ReviewPageHeader
          back={REVIEW_HUB_BACK}
          title="Coding schemas"
          subtitle="Structured review templates. Reviewers code against published schemas; legacy free-form notes remain available under the generic schema."
          primaryAction={
            // TEAM-UI-SPEC §1 — the one forward (create) action on the page.
            <CanonicalActionButton
              variant="primary"
              onClick={onSeed}
              busy={seeding}
              disabled={seedReason !== null}
              disabledReason={seedReason ?? undefined}
              data-coding-seed-defaults
            >
              {seeding
                ? "Seeding…"
                : missingDefaults !== null && missingDefaults > 0 && missingDefaults < CODING_SCHEMA_DEFAULT_SLUGS.length
                  ? `Add ${missingDefaults} missing default schema${missingDefaults === 1 ? "" : "s"}`
                  : "Seed 6 default schemas"}
            </CanonicalActionButton>
          }
        />
      }
    >
      {banner ? (
        <section className="app-panel" data-coding-seed-banner data-banner-tone={banner.tone}>
          <div className="app-panel__body">
            <p
              role={banner.tone === "error" ? "alert" : "status"}
              className={banner.tone === "error" ? "app-field-error" : undefined}
              style={{ margin: 0 }}
            >
              {banner.text}
            </p>
          </div>
        </section>
      ) : null}

      <section className="app-panel">
        <div className="app-panel__head">
          <h2 className="app-panel__title">Workspace-scoped schemas</h2>
        </div>
        <div className="app-panel__body app-field-help" style={{ display: "grid", gap: 4, margin: 0 }}>
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
      </section>

      {list.kind === "failed" ? (
        <section className="app-panel" data-coding-schemas-error>
          <div className="app-panel__body" style={{ display: "flex", flexWrap: "wrap", gap: 10, alignItems: "center" }}>
            <p role="alert" className="app-field-error" style={{ margin: 0, flex: "1 1 220px", minWidth: 0 }}>{list.message}</p>
            <CanonicalActionButton variant="secondary" onClick={() => void refresh()}>
              Retry
            </CanonicalActionButton>
          </div>
        </section>
      ) : list.kind === "loading" ? (
        <p role="status" className="app-field-help" data-coding-schemas-loading>Loading schemas…</p>
      ) : rows.length === 0 ? (
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
      ) : (
        // TEAM-UI-SPEC §4 — the shared responsive cutover (`.app-table[data-responsive]`):
        // each schema collapses to a labelled card at ≤ 720 px, nothing clips at 320 px.
        <div data-coding-schemas-table-wrap className="app-table-surface app-table-surface--scroll">
          <table className="app-table" data-responsive="" aria-label="Coding schemas">
            <thead>
              <tr>
                <th scope="col">Label</th>
                <th scope="col">Category</th>
                <th scope="col">Version</th>
                <th scope="col">Status</th>
                <th scope="col" style={{ textAlign: "right" }}>Fields</th>
                <th scope="col">Actions</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((s) => {
                const reason =
                  archivingId && archivingId !== s.id
                      ? "Another schema is being archived."
                      : authorReason;
                return (
                  <tr key={s.id}>
                    <td data-label="Label">
                      <div data-coding-schema-row={s.id} className="app-table__identity">
                        <span className="app-table__primary">{s.label}</span>
                        <span className="app-table__muted">
                          <code data-identifier>{s.slug}</code>
                        </span>
                      </div>
                    </td>
                    <td data-label="Category">{identifierLabel(s.category)}</td>
                    <td data-label="Version" style={{ whiteSpace: "nowrap" }}>{`v${s.version}`}</td>
                    <td data-label="Status">
                      <Badge tone={s.status === "ARCHIVED" ? "neutral" : "verified"} subtle>
                        {identifierLabel(s.status)}
                      </Badge>
                    </td>
                    <td data-label="Fields" style={{ textAlign: "right" }}>
                      {(s as unknown as { _count?: { fields: number } })._count?.fields ?? "—"}
                    </td>
                    <td data-label="">
                      {/* TEAM-UI-SPEC §1 — Archive is irreversible: a
                          `--danger` entry point that opens the danger confirm. */}
                      {/* T-134 — an archived schema offers no Archive. */}
                      {s.status === "ARCHIVED" ? (
                        <span className="app-table__muted" data-coding-schema-archived={s.id}>
                          Archived
                        </span>
                      ) : (
                      <CanonicalActionButton
                        variant="danger-entry"
                        busy={archivingId === s.id}
                        disabled={Boolean(reason)}
                        disabledReason={reason}
                        aria-label={`Archive ${s.label}`}
                        onClick={() => void onArchive(s)}
                        data-coding-schema-archive={s.id}
                      >
                        Archive
                      </CanonicalActionButton>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </PageShell>
  );
}
