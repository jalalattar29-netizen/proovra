"use client";

/**
 * PHASE 12 — VERTICAL B (OPERATIONS_INTELLIGENCE).
 *
 * SIU saved views + intake templates + the worklist they actually drive.
 *
 * Saved views were previously CRUD with no consumer: an operator could
 * create one, rename it, and delete it, and nothing ever ran it. This
 * panel closes that loop — selecting a view issues a SERVER-executed
 * query (`GET /v1/siu/worklist?viewId=…`) and renders the claims it
 * matches. The filter is never re-derived in the browser.
 *
 * Wires:
 *   GET    /v1/siu/intake-templates      — bounded template catalog
 *   GET    /v1/siu/saved-views           — presets + durable custom rows
 *   GET    /v1/siu/saved-views/custom    — custom rows only (ownership)
 *   POST   /v1/siu/saved-views           — create
 *   PATCH  /v1/siu/saved-views/:id       — rename / re-scope
 *   DELETE /v1/siu/saved-views/:id       — remove (confirmed)
 *   POST   /v1/siu/saved-views/:id/use   — mark used + return the worklist
 *   GET    /v1/siu/worklist              — run a view
 *
 * Hard rules:
 *   * Bounded copy. NEVER claims fraud, authenticity, or admissibility.
 *   * The worklist projection carries NO claimant PII — revealing that
 *     stays behind the dedicated step-up-gated route on the case panel.
 *   * Loading / empty / DENIAL / error are four distinct states. A
 *     permission denial never renders as "0 claims".
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";

import { apiFetch } from "../../../../lib/api";
import { toSafeUserError } from "../../../../lib/feedback/toSafeUserError";
import { useTenantGuard } from "../../../../lib/platform-context";
import { useConfirmAction } from "../../../../components/ui/ConfirmActionModal";

// ---------------------------------------------------------------------------
// Server projection types
// ---------------------------------------------------------------------------

type SavedViewSource = "preset" | "custom";

type ResolvedView = {
  id: string;
  name: string;
  description: string | null;
  source: SavedViewSource;
  filter: Record<string, unknown>;
  sort: { key: string; direction: "asc" | "desc" };
};

type WorklistRow = {
  caseId: string;
  profileId: string;
  claimType: string;
  investigationStatus: string;
  claimNumber: string | null;
  incidentDateUtc: string | null;
  assignedAdjusterUserId: string | null;
  assignedSiuReviewerUserId: string | null;
  intakeTemplateId: string | null;
  missingRequiredItemCount: number;
  openWarningIndicatorCount: number;
  openFollowUpCount: number;
  exportCount: number;
  updatedAtUtc: string;
};

type IntakeTemplate = {
  id: string;
  name: string;
  claimType: string;
  description: string;
  itemCount: number;
  requiredItemCount: number;
};

/**
 * The MANAGEMENT projection of a durable saved view, from
 * `GET /v1/siu/saved-views/custom`.
 *
 * `GET /v1/siu/saved-views` returns the EXECUTABLE projection (id, name,
 * filter, sort, source) — everything needed to RUN a view and nothing more.
 * It deliberately carries no visibility or ownership, so it cannot answer
 * "may I edit this one?". `/custom` returns the durable rows with their
 * management metadata, which is what the manage affordances below are gated
 * on: a `team`-visible view authored by a colleague is runnable by everyone
 * but is not this operator's to rename or delete, and the server enforces
 * exactly that. Reading ownership from here instead of inferring it from
 * `source === "custom"` is what stops the UI offering a control the server
 * will refuse.
 */
type ManagedView = {
  id: string;
  name: string;
  visibility: "private" | "team" | "organization";
  createdByUserId: string;
  updatedByUserId: string | null;
  lastUsedAtUtc: string | null;
  updatedAtUtc: string;
};

type PanelState =
  | { kind: "loading" }
  | {
      kind: "ready";
      views: ResolvedView[];
      templates: IntakeTemplate[];
      /** Durable rows the caller may manage, keyed by view id. */
      managed: Record<string, ManagedView>;
    }
  | { kind: "denied"; reason: string }
  | { kind: "error"; message: string };

type WorklistState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "ready"; rows: WorklistRow[]; total: number; truncated: boolean }
  | { kind: "denied"; reason: string }
  | { kind: "error"; message: string };

/**
 * Bounded, human-readable rendering of the closed filter vocabulary.
 * Mirrors `SiuSavedViewFilterSchema` — nothing outside this map can be
 * expressed by a saved view, so nothing outside it needs copy.
 */
const FILTER_COPY: Record<string, string> = {
  investigationStatus: "Investigation status",
  requireMissingChecklistItems: "Has missing required evidence",
  requireWarningIndicators: "Has an open warning indicator",
  requireOpenFollowUps: "Has an open follow-up",
  requireRecentExport: "Exported in the last 30 days",
  assignedAdjusterUserId: "Assigned adjuster",
  assignedSiuReviewerUserId: "Assigned SIU reviewer",
  claimType: "Claim type",
};

function describeFilter(filter: Record<string, unknown>): string {
  const parts = Object.entries(filter)
    .filter(([, v]) => v !== undefined && v !== null && v !== false)
    .map(([k, v]) => {
      const label = FILTER_COPY[k] ?? k;
      if (v === true) return label;
      if (Array.isArray(v)) return `${label}: ${v.join(", ")}`;
      return `${label}: ${String(v)}`;
    });
  return parts.length > 0 ? parts.join(" · ") : "No filter — every claim profile";
}

function isDenial(err: unknown): string | null {
  const e = err as {
    statusCode?: number;
    code?: string;
    body?: { error?: { code?: string } };
  };
  const code = e?.body?.error?.code ?? e?.code;
  if (code === "member_inactive") {
    return "Your membership in this workspace is not active, so the SIU worklist is unavailable.";
  }
  if (code === "permission_denied" || e?.statusCode === 403) {
    return "You do not have permission to view the SIU worklist in this workspace.";
  }
  return null;
}

// ---------------------------------------------------------------------------
// Panel
// ---------------------------------------------------------------------------

export function SiuWorklistPanel({ teamId }: { teamId: string | null }) {
  const guard = useTenantGuard();
  const { confirm } = useConfirmAction();

  const [state, setState] = useState<PanelState>({ kind: "loading" });
  const [worklist, setWorklist] = useState<WorklistState>({ kind: "idle" });
  const [activeViewId, setActiveViewId] = useState<string>("");
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<{
    tone: "success" | "error" | "info";
    message: string;
  } | null>(null);
  const [draftName, setDraftName] = useState("");
  const [draftStatus, setDraftStatus] = useState("");
  const [draftMissing, setDraftMissing] = useState(false);
  const [draftWarnings, setDraftWarnings] = useState(false);

  const loadCatalog = useCallback(async () => {
    if (!teamId) return;
    const stamp = guard.stamp();
    try {
      const [viewRes, templateRes, customRes] = await Promise.all([
        apiFetch(`/v1/siu/saved-views?teamId=${encodeURIComponent(teamId)}`, {
          method: "GET",
        }) as Promise<{ views: ResolvedView[] }>,
        apiFetch(
          `/v1/siu/intake-templates?teamId=${encodeURIComponent(teamId)}`,
          { method: "GET" },
        ) as Promise<{ templates: IntakeTemplate[] }>,
        // Management metadata for the durable rows — see `ManagedView`. The
        // executable list above cannot answer "may I edit this one?".
        apiFetch(
          `/v1/siu/saved-views/custom?teamId=${encodeURIComponent(teamId)}`,
          { method: "GET" },
        ) as Promise<{ views: ManagedView[] }>,
      ]);
      if (guard.isStale(stamp)) return;
      const managed: Record<string, ManagedView> = {};
      for (const row of customRes.views ?? []) managed[row.id] = row;
      setState({
        kind: "ready",
        views: viewRes.views ?? [],
        templates: templateRes.templates ?? [],
        managed,
      });
    } catch (err) {
      if (guard.isStale(stamp)) return;
      const denial = isDenial(err);
      if (denial) {
        setState({ kind: "denied", reason: denial });
        return;
      }
      setState({
        kind: "error",
        message: toSafeUserError(err, {
          message: "Unable to load SIU saved views.",
        }).message,
      });
    }
  }, [guard, teamId]);

  useEffect(() => {
    if (!teamId) return;
    // A Workspace change resets the whole surface, not just the catalog. The
    // applied view id and the rows it produced belong to the PREVIOUS
    // workspace; leaving either on screen would show one workspace's results
    // under another workspace's heading until the operator happened to re-run
    // something. Selection and results are cleared here; the in-flight guard
    // below separately discards any response that lands after the switch.
    setState({ kind: "loading" });
    setWorklist({ kind: "idle" });
    setActiveViewId("");
    setNotice(null);
    void loadCatalog();
  }, [teamId, loadCatalog]);

  // -------------------------------------------------------------------------
  // Running a view — the whole point of the feature.
  // -------------------------------------------------------------------------
  const runView = useCallback(
    async (viewId: string) => {
      if (!teamId) return;
      setActiveViewId(viewId);
      setWorklist({ kind: "loading" });
      const stamp = guard.stamp();
      try {
        const qs = new URLSearchParams({ teamId });
        if (viewId) qs.set("viewId", viewId);
        const res = (await apiFetch(`/v1/siu/worklist?${qs.toString()}`, {
          method: "GET",
        })) as { rows: WorklistRow[]; total: number; truncated: boolean };
        if (guard.isStale(stamp)) return;
        setWorklist({
          kind: "ready",
          rows: res.rows ?? [],
          total: res.total ?? 0,
          truncated: res.truncated ?? false,
        });
      } catch (err) {
        if (guard.isStale(stamp)) return;
        const denial = isDenial(err);
        if (denial) {
          setWorklist({ kind: "denied", reason: denial });
          return;
        }
        setWorklist({
          kind: "error",
          message: toSafeUserError(err, {
            message: "Unable to run this saved view.",
          }).message,
        });
      }
    },
    [guard, teamId],
  );

  /**
   * `use` is not bookkeeping: the server marks the view used AND returns
   * the worklist it resolves to, so the operator sees the effect.
   */
  const markUsedAndRun = useCallback(
    async (view: ResolvedView) => {
      if (!teamId) return;
      if (view.source === "preset") {
        await runView(view.id);
        return;
      }
      setBusy(`use:${view.id}`);
      setNotice(null);
      const stamp = guard.stamp();
      try {
        const res = (await apiFetch(
          `/v1/siu/saved-views/${encodeURIComponent(view.id)}/use`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ teamId }),
          },
        )) as {
          worklist: { rows: WorklistRow[]; total: number; truncated: boolean } | null;
        };
        if (guard.isStale(stamp)) return;
        setActiveViewId(view.id);
        if (res.worklist) {
          setWorklist({
            kind: "ready",
            rows: res.worklist.rows ?? [],
            total: res.worklist.total ?? 0,
            truncated: res.worklist.truncated ?? false,
          });
        } else {
          await runView(view.id);
        }
      } catch (err) {
        if (guard.isStale(stamp)) return;
        setNotice({
          tone: "error",
          message: toSafeUserError(err, {
            message: "Unable to apply this saved view.",
          }).message,
        });
      } finally {
        setBusy(null);
      }
    },
    [guard, runView, teamId],
  );

  const createView = useCallback(async () => {
    if (!teamId) return;
    const name = draftName.trim();
    if (!name) {
      setNotice({ tone: "error", message: "Give the view a name first." });
      return;
    }
    const filter: Record<string, unknown> = {};
    if (draftStatus) filter.investigationStatus = [draftStatus];
    if (draftMissing) filter.requireMissingChecklistItems = true;
    if (draftWarnings) filter.requireWarningIndicators = true;

    setBusy("create");
    setNotice(null);
    const stamp = guard.stamp();
    try {
      const res = (await apiFetch(`/v1/siu/saved-views`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          teamId,
          name,
          filter,
          sort: { key: "updatedAtUtc", direction: "desc" },
          visibility: "team",
        }),
      })) as { view: { id: string } };
      if (guard.isStale(stamp)) return;
      setDraftName("");
      setNotice({ tone: "success", message: `Saved view "${name}" created.` });
      await loadCatalog();
      await runView(res.view.id);
    } catch (err) {
      if (guard.isStale(stamp)) return;
      setNotice({
        tone: "error",
        message: toSafeUserError(err, {
          message: "Unable to create that saved view.",
        }).message,
      });
    } finally {
      setBusy(null);
    }
  }, [
    draftMissing,
    draftName,
    draftStatus,
    draftWarnings,
    guard,
    loadCatalog,
    runView,
    teamId,
  ]);

  const renameView = useCallback(
    async (view: ResolvedView, nextName: string) => {
      if (!teamId || !nextName.trim()) return;
      setBusy(`rename:${view.id}`);
      setNotice(null);
      const stamp = guard.stamp();
      try {
        await apiFetch(
          `/v1/siu/saved-views/${encodeURIComponent(view.id)}?teamId=${encodeURIComponent(teamId)}`,
          {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name: nextName.trim() }),
          },
        );
        if (guard.isStale(stamp)) return;
        setNotice({ tone: "success", message: "Saved view renamed." });
        await loadCatalog();
      } catch (err) {
        if (guard.isStale(stamp)) return;
        setNotice({
          tone: "error",
          message: toSafeUserError(err, {
            message: "Unable to rename that saved view.",
          }).message,
        });
      } finally {
        setBusy(null);
      }
    },
    [guard, loadCatalog, teamId],
  );

  const deleteView = useCallback(
    async (view: ResolvedView) => {
      if (!teamId) return;
      const ok = await confirm({
        title: `Delete "${view.name}"?`,
        description:
          "The saved view is removed for everyone it was shared with. Claim profiles and evidence are not affected.",
        confirmLabel: "Delete view",
        tone: "danger",
      });
      if (!ok) return;
      setBusy(`delete:${view.id}`);
      setNotice(null);
      const stamp = guard.stamp();
      try {
        await apiFetch(
          `/v1/siu/saved-views/${encodeURIComponent(view.id)}?teamId=${encodeURIComponent(teamId)}`,
          { method: "DELETE" },
        );
        if (guard.isStale(stamp)) return;
        if (activeViewId === view.id) {
          setActiveViewId("");
          setWorklist({ kind: "idle" });
        }
        setNotice({ tone: "success", message: "Saved view deleted." });
        await loadCatalog();
      } catch (err) {
        if (guard.isStale(stamp)) return;
        setNotice({
          tone: "error",
          message: toSafeUserError(err, {
            message: "Unable to delete that saved view.",
          }).message,
        });
      } finally {
        setBusy(null);
      }
    },
    [activeViewId, confirm, guard, loadCatalog, teamId],
  );

  const activeView = useMemo(
    () =>
      state.kind === "ready"
        ? (state.views.find((v) => v.id === activeViewId) ?? null)
        : null,
    [activeViewId, state],
  );

  if (!teamId) return null;

  return (
    <section data-testid="siu-worklist-panel" style={panelStyle}>
      <header style={{ marginBottom: 12 }}>
        <h2 style={{ margin: 0, fontSize: 18 }}>SIU worklist</h2>
        <p style={{ margin: "4px 0 0", color: "#475569", fontSize: 13 }}>
          Saved views run a bounded query over this workspace&apos;s claim
          profiles. Counts below are real database results — they are
          operational signals only and do not determine fraud, authorship, or
          legal admissibility.
        </p>
      </header>

      {state.kind === "loading" ? (
        <p style={mutedText} data-testid="siu-worklist-loading">
          Loading saved views…
        </p>
      ) : null}

      {state.kind === "denied" ? (
        <div style={denialBox} data-testid="siu-worklist-denied">
          <strong>Access restricted</strong>
          <p style={{ margin: "4px 0 0" }}>{state.reason}</p>
        </div>
      ) : null}

      {state.kind === "error" ? (
        <div style={errBox} data-testid="siu-worklist-error">
          <p style={{ margin: 0 }}>{state.message}</p>
          <button type="button" onClick={() => void loadCatalog()} style={ghostBtn}>
            Try again
          </button>
        </div>
      ) : null}

      {notice ? (
        <p
          style={notice.tone === "error" ? errBox : mutedText}
          data-testid="siu-worklist-notice"
          data-tone={notice.tone}
        >
          {notice.message}
        </p>
      ) : null}

      {state.kind === "ready" ? (
        <>
          {/* Saved views */}
          <h3 style={h3}>Saved views</h3>
          {/* Changing or clearing the applied view is part of the workflow,
              not an afterthought: without it an operator who runs a narrow
              view has no way back to the honest full worklist. Clearing runs
              the SAME server query with no viewId, so "no view applied" is a
              real server result rather than a blanked-out screen. */}
          <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 8 }}>
            <span style={mutedText} data-testid="siu-active-view-label">
              {activeView
                ? `Applied view: ${activeView.name}`
                : "No view applied — showing every claim profile"}
            </span>
            <button
              type="button"
              style={ghostBtn}
              disabled={!activeViewId || worklist.kind === "loading"}
              onClick={() => void runView("")}
              data-testid="siu-clear-view"
            >
              Clear applied view
            </button>
            <button
              type="button"
              style={ghostBtn}
              disabled={worklist.kind === "loading"}
              onClick={() => void runView(activeViewId)}
              data-testid="siu-refresh-worklist"
            >
              Refresh results
            </button>
          </div>
          <ul style={listReset} data-testid="siu-saved-views">
            {state.views.map((view) => (
              <li
                key={`${view.source}:${view.id}`}
                style={viewRow(view.id === activeViewId)}
                data-testid="siu-saved-view"
                data-view-id={view.id}
                data-view-source={view.source}
                data-view-active={view.id === activeViewId ? "true" : "false"}
              >
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 600 }}>
                    {view.name}{" "}
                    <span style={sourceChip}>{view.source}</span>
                    {state.managed[view.id] ? (
                      <span style={sourceChip} data-testid="siu-saved-view-visibility">
                        {state.managed[view.id].visibility}
                      </span>
                    ) : null}
                  </div>
                  <div style={mutedText}>{describeFilter(view.filter)}</div>
                </div>
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                  <button
                    type="button"
                    style={primaryBtn}
                    disabled={busy === `use:${view.id}`}
                    onClick={() => void markUsedAndRun(view)}
                    data-testid="siu-saved-view-run"
                  >
                    {busy === `use:${view.id}` ? "Running…" : "Run view"}
                  </button>
                  {/* Manage controls appear only for a durable row the SERVER
                      returned as this operator's to manage. Inferring it from
                      `source === "custom"` would offer Rename/Delete on a
                      colleague's private view, which the server refuses — an
                      offer the product cannot honour. */}
                  {state.managed[view.id] ? (
                    <>
                      <button
                        type="button"
                        style={ghostBtn}
                        disabled={busy === `rename:${view.id}`}
                        onClick={() => {
                          const next = window.prompt(
                            "New name for this view",
                            view.name,
                          );
                          if (next) void renameView(view, next);
                        }}
                        data-testid="siu-saved-view-rename"
                      >
                        Rename
                      </button>
                      <button
                        type="button"
                        style={ghostBtn}
                        disabled={busy === `delete:${view.id}`}
                        onClick={() => void deleteView(view)}
                        data-testid="siu-saved-view-delete"
                      >
                        Delete
                      </button>
                    </>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>

          {/* Create */}
          <h3 style={h3}>Create a view</h3>
          <div
            style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}
            data-testid="siu-saved-view-create"
          >
            <input
              style={inputStyle}
              placeholder="View name"
              data-testid="siu-draft-name"
              value={draftName}
              onChange={(e) => setDraftName(e.target.value)}
              aria-label="Saved view name"
            />
            <select
              style={inputStyle}
              value={draftStatus}
              onChange={(e) => setDraftStatus(e.target.value)}
              aria-label="Investigation status filter"
            >
              <option value="">Any investigation status</option>
              {[
                "intake",
                "collecting",
                "review",
                "follow_up",
                "export_ready",
                "exported",
                "closed",
              ].map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
            <label style={mutedText}>
              <input
                type="checkbox"
                data-testid="siu-draft-missing"
                checked={draftMissing}
                onChange={(e) => setDraftMissing(e.target.checked)}
              />{" "}
              Missing required evidence
            </label>
            <label style={mutedText}>
              <input
                type="checkbox"
                data-testid="siu-draft-warnings"
                checked={draftWarnings}
                onChange={(e) => setDraftWarnings(e.target.checked)}
              />{" "}
              Open warning indicator
            </label>
            <button
              type="button"
              style={primaryBtn}
              disabled={busy === "create"}
              data-testid="siu-create-view"
              onClick={() => void createView()}
            >
              {busy === "create" ? "Saving…" : "Save view"}
            </button>
          </div>

          {/* Worklist */}
          <h3 style={h3}>
            {activeView ? `Results · ${activeView.name}` : "Results"}
          </h3>
          {worklist.kind === "idle" ? (
            <p style={mutedText} data-testid="siu-worklist-idle">
              Run a saved view to see the claim profiles it matches.
            </p>
          ) : null}
          {worklist.kind === "loading" ? (
            <p style={mutedText}>Running the view…</p>
          ) : null}
          {worklist.kind === "denied" ? (
            <div style={denialBox} data-testid="siu-worklist-results-denied">
              <strong>Access restricted</strong>
              <p style={{ margin: "4px 0 0" }}>{worklist.reason}</p>
            </div>
          ) : null}
          {worklist.kind === "error" ? (
            <div style={errBox}>{worklist.message}</div>
          ) : null}
          {worklist.kind === "ready" && worklist.rows.length === 0 ? (
            <p style={mutedText} data-testid="siu-worklist-empty">
              No claim profile in this workspace matches this view. That is a
              real zero result, not a failed or blocked read.
            </p>
          ) : null}
          {worklist.kind === "ready" && worklist.rows.length > 0 ? (
            <>
              <p style={mutedText} data-testid="siu-worklist-total">
                {worklist.total} matching claim profile
                {worklist.total === 1 ? "" : "s"}
                {worklist.truncated
                  ? ` · showing the first ${worklist.rows.length}`
                  : ""}
              </p>
              <table style={tableStyle} data-testid="siu-worklist-table">
                <thead>
                  <tr>
                    <th style={th}>Claim</th>
                    <th style={th}>Status</th>
                    <th style={th}>Missing required</th>
                    <th style={th}>Warnings</th>
                    <th style={th}>Open follow-ups</th>
                    <th style={th}>Exports</th>
                  </tr>
                </thead>
                <tbody>
                  {worklist.rows.map((row) => (
                    <tr key={row.profileId} data-case-id={row.caseId}>
                      <td style={td}>
                        <Link href={`/cases/${row.caseId}`}>
                          {row.claimNumber ?? `Case ${row.caseId.slice(0, 8)}…`}
                        </Link>
                        <div style={mutedText}>{row.claimType}</div>
                      </td>
                      <td style={td}>
                        <code>{row.investigationStatus}</code>
                      </td>
                      <td style={td}>{row.missingRequiredItemCount}</td>
                      <td style={td}>{row.openWarningIndicatorCount}</td>
                      <td style={td}>{row.openFollowUpCount}</td>
                      <td style={td}>{row.exportCount}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          ) : null}

          {/* Intake templates */}
          <h3 style={h3}>Intake templates</h3>
          {state.templates.length === 0 ? (
            <p style={mutedText}>No intake templates are published.</p>
          ) : (
            <table style={tableStyle} data-testid="siu-intake-templates">
              <thead>
                <tr>
                  <th style={th}>Template</th>
                  <th style={th}>Claim type</th>
                  <th style={th}>Items</th>
                  <th style={th}>Required</th>
                </tr>
              </thead>
              <tbody>
                {state.templates.map((t) => (
                  <tr key={t.id} data-template-id={t.id}>
                    <td style={td}>
                      <div style={{ fontWeight: 600 }}>{t.name}</div>
                      <div style={mutedText}>{t.description}</div>
                    </td>
                    <td style={td}>
                      <code>{t.claimType}</code>
                    </td>
                    <td style={td}>{t.itemCount}</td>
                    <td style={td}>{t.requiredItemCount}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      ) : null}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Styles — matched to the sibling SiuPanel so the two read as one surface.
// ---------------------------------------------------------------------------

const panelStyle: React.CSSProperties = {
  border: "1px solid #e2e8f0",
  borderRadius: 10,
  padding: 16,
  background: "#fff",
  marginTop: 16,
};
const mutedText: React.CSSProperties = { fontSize: 13, color: "#64748b" };
const h3: React.CSSProperties = { fontSize: 14, margin: "16px 0 8px" };
const listReset: React.CSSProperties = {
  listStyle: "none",
  margin: 0,
  padding: 0,
  display: "flex",
  flexDirection: "column",
  gap: 8,
};
const viewRow = (active: boolean): React.CSSProperties => ({
  display: "flex",
  gap: 12,
  alignItems: "center",
  padding: 10,
  border: `1px solid ${active ? "#6366f1" : "#e2e8f0"}`,
  borderRadius: 8,
  background: active ? "#eef2ff" : "#fff",
});
const sourceChip: React.CSSProperties = {
  fontSize: 11,
  padding: "1px 6px",
  borderRadius: 999,
  background: "#f1f5f9",
  color: "#475569",
  marginLeft: 6,
};
const tableStyle: React.CSSProperties = {
  width: "100%",
  borderCollapse: "collapse",
  fontSize: 13,
};
const th: React.CSSProperties = {
  textAlign: "left",
  padding: "6px 8px",
  color: "#475569",
  borderBottom: "1px solid #e2e8f0",
  fontWeight: 600,
};
const td: React.CSSProperties = {
  padding: "6px 8px",
  borderBottom: "1px solid #f1f5f9",
  verticalAlign: "top",
};
const inputStyle: React.CSSProperties = {
  padding: "6px 10px",
  border: "1px solid #cbd5e1",
  borderRadius: 6,
  fontSize: 13,
};
const primaryBtn: React.CSSProperties = {
  padding: "6px 12px",
  borderRadius: 6,
  border: "1px solid #4f46e5",
  background: "#4f46e5",
  color: "#fff",
  fontSize: 13,
  cursor: "pointer",
};
const ghostBtn: React.CSSProperties = {
  padding: "6px 12px",
  borderRadius: 6,
  border: "1px solid #cbd5e1",
  background: "#fff",
  color: "#0f172a",
  fontSize: 13,
  cursor: "pointer",
};
const errBox: React.CSSProperties = {
  padding: 10,
  background: "#fef2f2",
  border: "1px solid #fecaca",
  color: "#7f1d1d",
  borderRadius: 8,
  fontSize: 13,
};
const denialBox: React.CSSProperties = {
  padding: 10,
  background: "#fffbeb",
  border: "1px solid #fde68a",
  color: "#78350f",
  borderRadius: 8,
  fontSize: 13,
};
