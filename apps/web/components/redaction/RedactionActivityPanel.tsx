"use client";

/**
 * Batch J — redaction project activity timeline.
 *
 *   GET /v1/redaction/projects/:id/activity  (redaction.view)
 *     200 { activity: [{ id, code, versionId, actorUserId, payload, occurredAtUtc }] }
 *
 * The server returns the bounded, append-only activity log newest first. The
 * project projection does not carry it, so the project page promised an
 * activity timeline it never rendered. This panel is read-only; the page bumps
 * `revision` after each of its own mutations so the timeline is reread from
 * the server rather than patched locally.
 *
 * A failed or refused read is stated as such — never rendered as "no
 * activity".
 */

import { useEffect, useId, useState } from "react";

import { identifierLabel } from "@proovra/shared";

import { apiFetch } from "../../lib/api";
import { formatUserDateTime } from "../../lib/date";
import { toSafeUserError } from "../../lib/feedback/toSafeUserError";
import { useTenantGuard } from "../../lib/platform-context";
import { Button } from "../ui/Button";

export type RedactionActivityRow = {
  id: string;
  code: string;
  versionId: string | null;
  actorUserId: string | null;
  occurredAtUtc: string;
};

type ActivityState =
  | { kind: "loading" }
  | { kind: "ready"; rows: RedactionActivityRow[] }
  | { kind: "denied" }
  | { kind: "failed"; message: string };

function statusOf(err: unknown): number {
  const s = (err as { statusCode?: unknown } | null)?.statusCode;
  return typeof s === "number" ? s : 0;
}

export function RedactionActivityPanel({
  projectId,
  versions,
  selectedVersionId,
  revision,
}: {
  projectId: string;
  versions: ReadonlyArray<{ id: string; versionOrdinal: number }>;
  selectedVersionId: string | null;
  revision: number;
}) {
  const guard = useTenantGuard();
  const filterId = useId();
  const [state, setState] = useState<ActivityState>({ kind: "loading" });
  const [onlySelected, setOnlySelected] = useState(false);
  const [localRevision, setLocalRevision] = useState(0);

  useEffect(() => {
    let current = true;
    const stamp = guard.stamp();
    setState({ kind: "loading" });
    apiFetch(
      `/v1/redaction/projects/${encodeURIComponent(projectId)}/activity`,
      { method: "GET" },
    )
      .then((res: { activity?: RedactionActivityRow[] } | null) => {
        if (!current || guard.isStale(stamp)) return;
        setState({ kind: "ready", rows: Array.isArray(res?.activity) ? res.activity : [] });
      })
      .catch((err: unknown) => {
        if (!current || guard.isStale(stamp)) return;
        const status = statusOf(err);
        if (status === 403 || status === 404) {
          setState({ kind: "denied" });
          return;
        }
        setState({
          kind: "failed",
          message: toSafeUserError(err, {
            message: "The activity timeline could not be loaded. Refresh to try again.",
          }).message,
        });
      });
    return () => {
      current = false;
    };
  }, [guard, projectId, revision, localRevision]);

  const ordinalById = new Map(versions.map((v) => [v.id, v.versionOrdinal]));
  const selectedOrdinal = selectedVersionId ? ordinalById.get(selectedVersionId) : undefined;
  const rows =
    state.kind === "ready"
      ? onlySelected && selectedVersionId
        ? state.rows.filter((r) => r.versionId === selectedVersionId)
        : state.rows
      : [];

  return (
    <section
      data-redaction-activity-panel
      aria-labelledby={`${filterId}-heading`}
      style={{
        background: "var(--surface)",
        border: "1px solid var(--border)",
        borderRadius: 10,
        padding: 10,
        marginTop: 14,
        minWidth: 0,
        overflowWrap: "anywhere",
      }}
    >
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
        <h2 id={`${filterId}-heading`} style={{ fontSize: 14, margin: 0 }}>
          Activity timeline
        </h2>
        <span style={{ flex: "1 1 auto" }} />
        <label htmlFor={filterId} style={{ fontSize: 12, display: "inline-flex", gap: 6, alignItems: "center" }}>
          <input
            id={filterId}
            type="checkbox"
            checked={onlySelected}
            disabled={!selectedVersionId}
            onChange={(e) => setOnlySelected(e.target.checked)}
            data-redaction-activity-filter
          />
          {selectedOrdinal !== undefined
            ? `Only version v${selectedOrdinal}`
            : "Only the selected version"}
        </label>
        <Button
          size="sm"
          onClick={() => setLocalRevision((v) => v + 1)}
          loading={state.kind === "loading"}
          data-redaction-activity-refresh
        >
          Refresh activity
        </Button>
      </div>

      {state.kind === "loading" ? (
        <p role="status" data-redaction-activity-loading style={{ fontSize: 12 }}>
          Loading activity…
        </p>
      ) : null}
      {state.kind === "denied" ? (
        <p role="alert" data-redaction-activity-denied style={{ fontSize: 12 }}>
          You do not have access to this project&apos;s activity in the current workspace.
        </p>
      ) : null}
      {state.kind === "failed" ? (
        <p role="alert" data-redaction-activity-error style={{ fontSize: 12 }}>
          {state.message}
        </p>
      ) : null}
      {state.kind === "ready" && rows.length === 0 ? (
        <p data-redaction-activity-empty style={{ fontSize: 12 }}>
          {onlySelected && state.rows.length > 0
            ? "No activity is recorded for this version yet."
            : "No activity is recorded for this project yet."}
        </p>
      ) : null}
      {state.kind === "ready" && rows.length > 0 ? (
        <ol
          data-redaction-activity-list
          style={{ margin: "8px 0 0", paddingInlineStart: 18, display: "grid", gap: 6, fontSize: 12 }}
        >
          {rows.map((row) => {
            const ordinal = row.versionId ? ordinalById.get(row.versionId) : undefined;
            return (
              <li key={row.id} data-redaction-activity-row={row.code}>
                <strong>{identifierLabel(row.code)}</strong>
                {" · "}
                {row.versionId
                  ? ordinal !== undefined
                    ? `Version v${ordinal}`
                    : "An earlier version"
                  : "Project"}
                {" · "}
                <time dateTime={row.occurredAtUtc}>{formatUserDateTime(row.occurredAtUtc)}</time>
                <div style={{ fontSize: 11 }}>
                  {row.actorUserId ? (
                    <>
                      Recorded by user <code data-identifier>{row.actorUserId}</code>
                    </>
                  ) : (
                    "Recorded by the system"
                  )}
                </div>
              </li>
            );
          })}
        </ol>
      ) : null}
    </section>
  );
}
