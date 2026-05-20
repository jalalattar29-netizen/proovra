"use client";

/**
 * Phase 24 — Enterprise Evidence Discovery console.
 *
 * Three-column operator surface:
 *   left   — filter rail (document types, evidence types, workflow / review
 *            states, lifecycle flags, date range, sort) + saved views.
 *   center — dense result list with cursor pagination; selecting a row
 *            opens the inspector.
 *   right  — inspector panel for the selected row (pointers, badges,
 *            related evidence, save-as-view affordance).
 *
 * Wording invariant: operator-safe phrases only. The badge labels are
 * sourced from the shared catalog; we never compose freeform legal /
 * forensic claims in the UI. Search query strings are never echoed back
 * verbatim outside the input box.
 */

import { useCallback, useEffect, useMemo, useState } from "react";

import { apiFetch } from "../../../lib/api";

// -----------------------------------------------------------------------------
// Wire-level types — kept loose so we don't drag the API SDK in here.
// -----------------------------------------------------------------------------

type DocumentType =
  | "EVIDENCE"
  | "WORKFLOW"
  | "WORKFLOW_STEP"
  | "REVIEW_EVENT"
  | "AUDIT_EVENT"
  | "COMMUNICATION"
  | "CASE_TIMELINE"
  | "INCIDENT";

type EvidenceType = "PHOTO" | "VIDEO" | "AUDIO" | "DOCUMENT";

type SortMode =
  | "UPDATED_DESC"
  | "UPDATED_ASC"
  | "CREATED_DESC"
  | "CREATED_ASC"
  | "RELEVANCE_DESC";

type SavedViewVisibility = "PRIVATE" | "TEAM";

type ResultRow = {
  documentId: string;
  documentType: DocumentType;
  title: string;
  subtitle: string | null;
  summary: string | null;
  evidenceId: string | null;
  workflowInstanceId: string | null;
  workflowStepInstanceId: string | null;
  caseId: string | null;
  reviewState: string | null;
  workflowState: string | null;
  exportState: string | null;
  retentionState: string | null;
  legalHoldState: string | null;
  contributorScoped: boolean;
  reviewerRestricted: boolean;
  badges: ReadonlyArray<string>;
  updatedAtUtc: string;
};

type SearchResponse = {
  rows: ResultRow[];
  nextCursor: string | null;
  totalReturned: number;
  filteredByGovernance: number;
  filteredByVisibility: number;
};

type SavedView = {
  id: string;
  name: string;
  description: string | null;
  visibility: SavedViewVisibility;
  pinned: boolean;
  createdByUserId: string;
  createdAt: string;
  updatedAt: string;
  lastUsedAtUtc: string | null;
  query: FilterState;
};

type Relationship = {
  relationshipId: string;
  sourceEvidenceId: string;
  targetEvidenceId: string;
  relationshipType: string;
  note: string | null;
  createdByUserId: string | null;
  createdAt: string;
};

// -----------------------------------------------------------------------------
// Filter state — mirrors the SearchFilterSchema on the wire.
// -----------------------------------------------------------------------------

type FilterState = {
  teamId: string;
  q?: string;
  documentTypes?: DocumentType[];
  evidenceTypes?: EvidenceType[];
  workflowStatuses?: string[];
  reviewStatuses?: string[];
  onLegalHold?: boolean;
  exportRestricted?: boolean;
  incidentLinked?: boolean;
  workflowLinked?: boolean;
  contributorScoped?: boolean;
  updatedSinceUtc?: string;
  updatedUntilUtc?: string;
  sort?: SortMode;
  cursor?: string;
  limit?: number;
};

const DOCUMENT_TYPES: DocumentType[] = [
  "EVIDENCE",
  "WORKFLOW",
  "WORKFLOW_STEP",
  "REVIEW_EVENT",
  "AUDIT_EVENT",
  "COMMUNICATION",
  "CASE_TIMELINE",
  "INCIDENT",
];

const EVIDENCE_TYPES: EvidenceType[] = ["PHOTO", "VIDEO", "AUDIO", "DOCUMENT"];

const SORT_MODES: { value: SortMode; label: string }[] = [
  { value: "UPDATED_DESC", label: "Most recent first" },
  { value: "UPDATED_ASC", label: "Oldest first" },
  { value: "CREATED_DESC", label: "Newest by creation" },
  { value: "CREATED_ASC", label: "Earliest by creation" },
  { value: "RELEVANCE_DESC", label: "Relevance" },
];

const DEFAULT_LIMIT = 25;

// -----------------------------------------------------------------------------
// Page component
// -----------------------------------------------------------------------------

export default function SearchPage() {
  const [teamId, setTeamId] = useState<string | null>(null);
  const [filter, setFilter] = useState<FilterState | null>(null);
  const [results, setResults] = useState<SearchResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<ResultRow | null>(null);
  const [relationships, setRelationships] = useState<Relationship[] | null>(
    null
  );
  const [savedViews, setSavedViews] = useState<SavedView[] | null>(null);
  const [savingView, setSavingView] = useState(false);
  const [qDraft, setQDraft] = useState("");

  // Resolve workspace.
  useEffect(() => {
    let cancelled = false;
    apiFetch("/v1/users/me", { method: "GET" })
      .then((r: { user?: { currentWorkspaceId?: string | null } }) => {
        if (cancelled) return;
        const id = r?.user?.currentWorkspaceId ?? null;
        setTeamId(id);
        if (id) setFilter({ teamId: id, sort: "UPDATED_DESC", limit: DEFAULT_LIMIT });
      })
      .catch(() => {
        if (!cancelled) setTeamId(null);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Saved views.
  useEffect(() => {
    if (!teamId) return;
    let cancelled = false;
    apiFetch(`/v1/search/saved-views?teamId=${encodeURIComponent(teamId)}`, {
      method: "GET",
    })
      .then((r: { views: SavedView[] }) => {
        if (cancelled) return;
        setSavedViews(r.views ?? []);
      })
      .catch(() => {
        if (!cancelled) setSavedViews([]);
      });
    return () => {
      cancelled = true;
    };
  }, [teamId]);

  // Run query on filter change.
  useEffect(() => {
    if (!filter) return;
    let cancelled = false;
    setLoading(true);
    runSearch(filter)
      .then((r) => {
        if (cancelled) return;
        setResults(r);
        setError(null);
        if (!r.rows.find((x) => x.documentId === selected?.documentId)) {
          setSelected(r.rows[0] ?? null);
        }
      })
      .catch((err: { message?: string }) => {
        if (cancelled) return;
        setError(err?.message ?? "Search failed.");
        setResults({
          rows: [],
          nextCursor: null,
          totalReturned: 0,
          filteredByGovernance: 0,
          filteredByVisibility: 0,
        });
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filter]);

  // Relationships for the selected evidence row.
  useEffect(() => {
    if (!teamId || !selected?.evidenceId) {
      setRelationships(null);
      return;
    }
    let cancelled = false;
    apiFetch(
      `/v1/search/relationships/${encodeURIComponent(
        selected.evidenceId
      )}?teamId=${encodeURIComponent(teamId)}`,
      { method: "GET" }
    )
      .then((r: { relationships: Relationship[] }) => {
        if (cancelled) return;
        setRelationships(r.relationships ?? []);
      })
      .catch(() => {
        if (!cancelled) setRelationships([]);
      });
    return () => {
      cancelled = true;
    };
  }, [teamId, selected?.evidenceId]);

  const updateFilter = useCallback(
    (patch: Partial<FilterState>) => {
      setFilter((prev) =>
        prev ? { ...prev, ...patch, cursor: undefined } : prev
      );
    },
    []
  );

  const toggleArray = useCallback(
    <T,>(arr: T[] | undefined, value: T): T[] | undefined => {
      const set = new Set(arr ?? []);
      if (set.has(value)) set.delete(value);
      else set.add(value);
      const next = Array.from(set);
      return next.length === 0 ? undefined : next;
    },
    []
  );

  const submitQuery = useCallback(
    (e: React.FormEvent<HTMLFormElement>) => {
      e.preventDefault();
      const trimmed = qDraft.trim().slice(0, 200);
      updateFilter({ q: trimmed.length > 0 ? trimmed : undefined });
    },
    [qDraft, updateFilter]
  );

  const loadMore = useCallback(() => {
    if (!filter || !results?.nextCursor) return;
    setLoading(true);
    runSearch({ ...filter, cursor: results.nextCursor })
      .then((r) => {
        setResults((prev) =>
          prev
            ? {
                rows: [...prev.rows, ...r.rows],
                nextCursor: r.nextCursor,
                totalReturned: prev.totalReturned + r.totalReturned,
                filteredByGovernance:
                  prev.filteredByGovernance + r.filteredByGovernance,
                filteredByVisibility:
                  prev.filteredByVisibility + r.filteredByVisibility,
              }
            : r
        );
      })
      .catch((err: { message?: string }) =>
        setError(err?.message ?? "Search failed.")
      )
      .finally(() => setLoading(false));
  }, [filter, results?.nextCursor]);

  const applySavedView = useCallback((view: SavedView) => {
    setFilter({ ...view.query, cursor: undefined });
    setQDraft(view.query.q ?? "");
  }, []);

  const saveCurrentView = useCallback(async () => {
    if (!teamId || !filter) return;
    const name = window.prompt("Name this view (operator label)");
    if (!name || name.trim().length === 0) return;
    setSavingView(true);
    try {
      const res = await apiFetch("/v1/search/saved-views", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          teamId,
          name: name.trim().slice(0, 120),
          visibility: "PRIVATE",
          query: filter,
        }),
      });
      if (res?.view) {
        setSavedViews((prev) => (prev ? [res.view, ...prev] : [res.view]));
      }
    } catch (err) {
      setError(
        (err as { message?: string })?.message ?? "Could not save view."
      );
    } finally {
      setSavingView(false);
    }
  }, [teamId, filter]);

  const deleteSavedView = useCallback(
    async (id: string) => {
      if (!teamId) return;
      if (!window.confirm("Delete this saved view?")) return;
      try {
        await apiFetch(
          `/v1/search/saved-views/${encodeURIComponent(
            id
          )}?teamId=${encodeURIComponent(teamId)}`,
          { method: "DELETE" }
        );
        setSavedViews((prev) =>
          prev ? prev.filter((v) => v.id !== id) : prev
        );
      } catch (err) {
        setError(
          (err as { message?: string })?.message ?? "Could not delete view."
        );
      }
    },
    [teamId]
  );

  const filterSummary = useMemo(() => {
    if (!filter) return null;
    const parts: string[] = [];
    if (filter.q) parts.push(`"${filter.q}"`);
    if (filter.documentTypes?.length)
      parts.push(`${filter.documentTypes.length} types`);
    if (filter.workflowLinked) parts.push("workflow-linked");
    if (filter.onLegalHold) parts.push("legal-hold");
    if (filter.exportRestricted) parts.push("export-restricted");
    return parts.length > 0 ? parts.join(" · ") : "all rows";
  }, [filter]);

  if (!teamId || !filter) {
    return (
      <main style={loadingScreenStyle}>
        <p style={mutedStyle}>Switch to a workspace to use Evidence Discovery.</p>
      </main>
    );
  }

  return (
    <main style={pageStyle}>
      <header style={headerStyle}>
        <div>
          <h1 style={titleStyle}>Evidence Discovery</h1>
          <p style={subtitleStyle}>
            Operator search across evidence, workflows, audit events, and
            communications. Results respect visibility and governance rules.
          </p>
        </div>
        <form onSubmit={submitQuery} style={searchFormStyle}>
          <input
            value={qDraft}
            onChange={(e) => setQDraft(e.target.value)}
            placeholder="Search titles, subtitles, OCR text…"
            style={searchInputStyle}
            maxLength={200}
            aria-label="Search query"
          />
          <button type="submit" style={searchButtonStyle}>
            Search
          </button>
        </form>
      </header>

      {error ? <div style={errorBoxStyle}>{error}</div> : null}

      <div style={threeColStyle}>
        {/* ----------------------------- LEFT ----------------------------- */}
        <aside style={leftRailStyle}>
          <FilterSection label="Sort">
            <select
              value={filter.sort ?? "UPDATED_DESC"}
              onChange={(e) =>
                updateFilter({ sort: e.target.value as SortMode })
              }
              style={selectStyle}
            >
              {SORT_MODES.map((m) => (
                <option key={m.value} value={m.value}>
                  {m.label}
                </option>
              ))}
            </select>
          </FilterSection>

          <FilterSection label="Document type">
            <div style={chipGroupStyle}>
              {DOCUMENT_TYPES.map((t) => {
                const active = filter.documentTypes?.includes(t) ?? false;
                return (
                  <button
                    key={t}
                    type="button"
                    onClick={() =>
                      updateFilter({
                        documentTypes: toggleArray(filter.documentTypes, t),
                      })
                    }
                    style={chipButtonStyle(active)}
                  >
                    {t.toLowerCase().replace("_", " ")}
                  </button>
                );
              })}
            </div>
          </FilterSection>

          <FilterSection label="Evidence kind">
            <div style={chipGroupStyle}>
              {EVIDENCE_TYPES.map((t) => {
                const active = filter.evidenceTypes?.includes(t) ?? false;
                return (
                  <button
                    key={t}
                    type="button"
                    onClick={() =>
                      updateFilter({
                        evidenceTypes: toggleArray(filter.evidenceTypes, t),
                      })
                    }
                    style={chipButtonStyle(active)}
                  >
                    {t.toLowerCase()}
                  </button>
                );
              })}
            </div>
          </FilterSection>

          <FilterSection label="Lifecycle">
            <Toggle
              label="Workflow-linked only"
              value={filter.workflowLinked ?? false}
              onChange={(v) =>
                updateFilter({ workflowLinked: v ? true : undefined })
              }
            />
            <Toggle
              label="On legal hold"
              value={filter.onLegalHold ?? false}
              onChange={(v) =>
                updateFilter({ onLegalHold: v ? true : undefined })
              }
            />
            <Toggle
              label="Export-restricted"
              value={filter.exportRestricted ?? false}
              onChange={(v) =>
                updateFilter({ exportRestricted: v ? true : undefined })
              }
            />
            <Toggle
              label="Incident-linked"
              value={filter.incidentLinked ?? false}
              onChange={(v) =>
                updateFilter({ incidentLinked: v ? true : undefined })
              }
            />
            <Toggle
              label="Contributor-scoped"
              value={filter.contributorScoped ?? false}
              onChange={(v) =>
                updateFilter({ contributorScoped: v ? true : undefined })
              }
            />
          </FilterSection>

          <FilterSection label="Updated">
            <label style={fieldLabelStyle}>
              Since
              <input
                type="datetime-local"
                value={filter.updatedSinceUtc?.slice(0, 16) ?? ""}
                onChange={(e) =>
                  updateFilter({
                    updatedSinceUtc: e.target.value
                      ? new Date(e.target.value).toISOString()
                      : undefined,
                  })
                }
                style={inputStyle}
              />
            </label>
            <label style={fieldLabelStyle}>
              Until
              <input
                type="datetime-local"
                value={filter.updatedUntilUtc?.slice(0, 16) ?? ""}
                onChange={(e) =>
                  updateFilter({
                    updatedUntilUtc: e.target.value
                      ? new Date(e.target.value).toISOString()
                      : undefined,
                  })
                }
                style={inputStyle}
              />
            </label>
          </FilterSection>

          <FilterSection label="Saved views">
            <button
              type="button"
              onClick={saveCurrentView}
              disabled={savingView}
              style={primaryButtonStyle}
            >
              {savingView ? "Saving…" : "Save current view"}
            </button>
            {savedViews === null ? (
              <p style={mutedStyle}>Loading…</p>
            ) : savedViews.length === 0 ? (
              <p style={mutedStyle}>No saved views yet.</p>
            ) : (
              <ul style={savedViewListStyle}>
                {savedViews.map((v) => (
                  <li key={v.id} style={savedViewRowStyle}>
                    <button
                      type="button"
                      onClick={() => applySavedView(v)}
                      style={savedViewApplyStyle}
                      title={v.description ?? ""}
                    >
                      {v.pinned ? "★ " : ""}
                      {v.name}
                      <span style={savedViewVisibilityStyle}>
                        {v.visibility.toLowerCase()}
                      </span>
                    </button>
                    <button
                      type="button"
                      onClick={() => deleteSavedView(v.id)}
                      style={iconButtonStyle}
                      aria-label="Delete saved view"
                    >
                      ×
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </FilterSection>
        </aside>

        {/* ----------------------------- CENTER ----------------------------- */}
        <section style={centerColStyle}>
          <div style={resultsHeaderStyle}>
            <div style={mutedStyle}>
              {loading
                ? "Searching…"
                : `${results?.totalReturned ?? 0} result${
                    (results?.totalReturned ?? 0) === 1 ? "" : "s"
                  } · ${filterSummary}`}
            </div>
            <div style={mutedStyle}>
              {results?.filteredByVisibility
                ? `${results.filteredByVisibility} visibility-restricted`
                : null}
              {results?.filteredByGovernance
                ? ` · ${results.filteredByGovernance} governance-restricted`
                : null}
            </div>
          </div>
          {!results || results.rows.length === 0 ? (
            <div style={emptyStateStyle}>
              {loading ? "Searching…" : "No matches for this query."}
            </div>
          ) : (
            <ul style={resultListStyle}>
              {results.rows.map((row) => (
                <li
                  key={row.documentId}
                  style={resultRowStyle(selected?.documentId === row.documentId)}
                  onClick={() => setSelected(row)}
                >
                  <div style={resultRowHeaderStyle}>
                    <span style={docTypeChipStyle(row.documentType)}>
                      {row.documentType.toLowerCase().replace("_", " ")}
                    </span>
                    <span style={resultTitleStyle}>{row.title}</span>
                  </div>
                  {row.subtitle ? (
                    <div style={resultSubtitleStyle}>{row.subtitle}</div>
                  ) : null}
                  {row.summary ? (
                    <div style={resultSummaryStyle}>{row.summary}</div>
                  ) : null}
                  <div style={resultMetaStyle}>
                    {row.badges.length > 0 ? (
                      <div style={badgeRowStyle}>
                        {row.badges.map((b) => (
                          <span key={b} style={badgeChipStyle(b)}>
                            {b}
                          </span>
                        ))}
                      </div>
                    ) : null}
                    <span style={mutedStyle}>
                      updated {formatDateTime(row.updatedAtUtc)}
                    </span>
                  </div>
                </li>
              ))}
            </ul>
          )}
          {results?.nextCursor ? (
            <button
              type="button"
              onClick={loadMore}
              disabled={loading}
              style={loadMoreButtonStyle}
            >
              {loading ? "Loading…" : "Load more"}
            </button>
          ) : null}
        </section>

        {/* ----------------------------- RIGHT ----------------------------- */}
        <aside style={rightRailStyle}>
          {!selected ? (
            <div style={emptyStateStyle}>
              Select a result to inspect pointers and related evidence.
            </div>
          ) : (
            <Inspector
              row={selected}
              relationships={relationships}
              teamId={teamId}
            />
          )}
        </aside>
      </div>
    </main>
  );
}

// -----------------------------------------------------------------------------
// Inspector
// -----------------------------------------------------------------------------

function Inspector({
  row,
  relationships,
  teamId,
}: {
  row: ResultRow;
  relationships: Relationship[] | null;
  teamId: string;
}) {
  return (
    <div>
      <div style={inspectorHeaderStyle}>
        <div style={docTypeChipStyle(row.documentType)}>
          {row.documentType.toLowerCase().replace("_", " ")}
        </div>
        <h2 style={inspectorTitleStyle}>{row.title}</h2>
        {row.subtitle ? (
          <p style={inspectorSubtitleStyle}>{row.subtitle}</p>
        ) : null}
      </div>

      {row.badges.length > 0 ? (
        <Section label="Signals">
          <div style={badgeRowStyle}>
            {row.badges.map((b) => (
              <span key={b} style={badgeChipStyle(b)}>
                {b}
              </span>
            ))}
          </div>
        </Section>
      ) : null}

      <Section label="Pointers">
        <KeyVal label="Document" value={row.documentId} mono />
        {row.evidenceId ? (
          <KeyVal
            label="Evidence"
            value={
              <a
                href={`/evidence/${row.evidenceId}`}
                style={pointerLinkStyle}
              >
                {row.evidenceId}
              </a>
            }
            mono
          />
        ) : null}
        {row.workflowInstanceId ? (
          <KeyVal
            label="Workflow"
            value={
              <a
                href={`/workflows/${row.workflowInstanceId}`}
                style={pointerLinkStyle}
              >
                {row.workflowInstanceId}
              </a>
            }
            mono
          />
        ) : null}
        {row.workflowStepInstanceId ? (
          <KeyVal
            label="Workflow step"
            value={row.workflowStepInstanceId}
            mono
          />
        ) : null}
        {row.caseId ? (
          <KeyVal
            label="Case"
            value={
              <a href={`/cases/${row.caseId}`} style={pointerLinkStyle}>
                {row.caseId}
              </a>
            }
            mono
          />
        ) : null}
      </Section>

      {(row.evidenceId || row.caseId) ? (
        <Section label="Investigation pivots">
          {row.caseId ? (
            <KeyVal
              label="Case graph"
              value={
                <a
                  href={`/investigation/cases/${row.caseId}/graph`}
                  style={pointerLinkStyle}
                >
                  Open case graph
                </a>
              }
            />
          ) : null}
          {row.evidenceId ? (
            <KeyVal
              label="Timeline"
              value={
                <a
                  href={`/investigation/timeline?evidenceId=${encodeURIComponent(
                    row.evidenceId
                  )}`}
                  style={pointerLinkStyle}
                >
                  Open timeline view
                </a>
              }
            />
          ) : null}
          {row.evidenceId ? (
            <KeyVal
              label="Duplicates"
              value={
                <a
                  href={`/investigation/duplicates?evidenceId=${encodeURIComponent(
                    row.evidenceId
                  )}`}
                  style={pointerLinkStyle}
                >
                  Review duplicates and similars
                </a>
              }
            />
          ) : null}
        </Section>
      ) : null}

      <Section label="Lifecycle">
        <KeyVal label="Review" value={row.reviewState ?? "—"} />
        <KeyVal label="Workflow" value={row.workflowState ?? "—"} />
        <KeyVal label="Export" value={row.exportState ?? "—"} />
        <KeyVal label="Retention" value={row.retentionState ?? "—"} />
        <KeyVal label="Legal hold" value={row.legalHoldState ?? "—"} />
        <KeyVal label="Updated" value={formatDateTime(row.updatedAtUtc)} />
      </Section>

      {row.summary ? (
        <Section label="Summary">
          <p style={summaryProseStyle}>{row.summary}</p>
        </Section>
      ) : null}

      {row.evidenceId ? (
        <Section label="Related evidence">
          {relationships === null ? (
            <p style={mutedStyle}>Loading…</p>
          ) : relationships.length === 0 ? (
            <p style={mutedStyle}>No related evidence.</p>
          ) : (
            <ul style={relationshipListStyle}>
              {relationships.map((r) => {
                const otherId =
                  r.sourceEvidenceId === row.evidenceId
                    ? r.targetEvidenceId
                    : r.sourceEvidenceId;
                return (
                  <li key={r.relationshipId} style={relationshipRowStyle}>
                    <span style={relTypeChipStyle}>{r.relationshipType}</span>
                    <a
                      href={`/evidence/${otherId}?teamId=${encodeURIComponent(
                        teamId
                      )}`}
                      style={pointerLinkStyle}
                    >
                      {otherId.slice(0, 12)}…
                    </a>
                    {r.note ? (
                      <span style={mutedStyle} title={r.note}>
                        {r.note.slice(0, 60)}
                      </span>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          )}
        </Section>
      ) : null}
    </div>
  );
}

// -----------------------------------------------------------------------------
// Small components
// -----------------------------------------------------------------------------

function FilterSection({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div style={filterSectionStyle}>
      <div style={filterLabelStyle}>{label}</div>
      <div style={filterBodyStyle}>{children}</div>
    </div>
  );
}

function Section({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div style={sectionStyle}>
      <div style={sectionLabelStyle}>{label}</div>
      <div>{children}</div>
    </div>
  );
}

function Toggle({
  label,
  value,
  onChange,
}: {
  label: string;
  value: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label style={toggleRowStyle}>
      <input
        type="checkbox"
        checked={value}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span>{label}</span>
    </label>
  );
}

function KeyVal({
  label,
  value,
  mono,
}: {
  label: string;
  value: React.ReactNode;
  mono?: boolean;
}) {
  return (
    <div style={keyValRowStyle}>
      <span style={keyValLabelStyle}>{label}</span>
      <span style={mono ? keyValMonoStyle : keyValValueStyle}>{value}</span>
    </div>
  );
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

async function runSearch(filter: FilterState): Promise<SearchResponse> {
  const qs = new URLSearchParams();
  qs.set("teamId", filter.teamId);
  if (filter.q) qs.set("q", filter.q);
  if (filter.documentTypes?.length)
    qs.set("documentTypes", filter.documentTypes.join(","));
  if (filter.evidenceTypes?.length)
    qs.set("evidenceTypes", filter.evidenceTypes.join(","));
  if (filter.workflowStatuses?.length)
    qs.set("workflowStatuses", filter.workflowStatuses.join(","));
  if (filter.reviewStatuses?.length)
    qs.set("reviewStatuses", filter.reviewStatuses.join(","));
  if (filter.onLegalHold !== undefined)
    qs.set("onLegalHold", String(filter.onLegalHold));
  if (filter.exportRestricted !== undefined)
    qs.set("exportRestricted", String(filter.exportRestricted));
  if (filter.incidentLinked !== undefined)
    qs.set("incidentLinked", String(filter.incidentLinked));
  if (filter.workflowLinked !== undefined)
    qs.set("workflowLinked", String(filter.workflowLinked));
  if (filter.contributorScoped !== undefined)
    qs.set("contributorScoped", String(filter.contributorScoped));
  if (filter.updatedSinceUtc) qs.set("updatedSinceUtc", filter.updatedSinceUtc);
  if (filter.updatedUntilUtc) qs.set("updatedUntilUtc", filter.updatedUntilUtc);
  if (filter.sort) qs.set("sort", filter.sort);
  if (filter.cursor) qs.set("cursor", filter.cursor);
  if (filter.limit) qs.set("limit", String(filter.limit));
  const r = await apiFetch(`/v1/search?${qs.toString()}`, { method: "GET" });
  return r as SearchResponse;
}

function formatDateTime(iso: string): string {
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

// -----------------------------------------------------------------------------
// Styles — restrained, dense, operational. No gradients.
// -----------------------------------------------------------------------------

const pageStyle: React.CSSProperties = {
  padding: "20px 24px 40px",
  fontFamily:
    "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
  color: "#0f172a",
  background: "#f8fafc",
  minHeight: "100vh",
};

const loadingScreenStyle: React.CSSProperties = {
  ...pageStyle,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
};

const headerStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "flex-end",
  justifyContent: "space-between",
  gap: 24,
  paddingBottom: 16,
  borderBottom: "1px solid #e2e8f0",
  flexWrap: "wrap",
};

const titleStyle: React.CSSProperties = {
  fontSize: 22,
  fontWeight: 700,
  margin: 0,
  letterSpacing: -0.2,
};

const subtitleStyle: React.CSSProperties = {
  fontSize: 13,
  color: "#64748b",
  margin: "4px 0 0",
  maxWidth: 640,
};

const searchFormStyle: React.CSSProperties = {
  display: "flex",
  gap: 8,
  alignItems: "center",
  minWidth: 320,
};

const searchInputStyle: React.CSSProperties = {
  flex: 1,
  padding: "8px 12px",
  border: "1px solid #cbd5e1",
  borderRadius: 6,
  fontSize: 13,
  background: "#fff",
  color: "#0f172a",
  minWidth: 240,
};

const searchButtonStyle: React.CSSProperties = {
  padding: "8px 16px",
  fontSize: 13,
  fontWeight: 600,
  background: "#1e293b",
  color: "#fff",
  border: "1px solid #1e293b",
  borderRadius: 6,
  cursor: "pointer",
};

const errorBoxStyle: React.CSSProperties = {
  marginTop: 12,
  padding: 10,
  background: "#fef2f2",
  color: "#7f1d1d",
  border: "1px solid #fecaca",
  borderRadius: 6,
  fontSize: 13,
};

const threeColStyle: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "260px 1fr 360px",
  gap: 16,
  marginTop: 16,
  alignItems: "flex-start",
};

const leftRailStyle: React.CSSProperties = {
  background: "#fff",
  border: "1px solid #e2e8f0",
  borderRadius: 8,
  padding: 12,
  position: "sticky",
  top: 16,
  maxHeight: "calc(100vh - 32px)",
  overflowY: "auto",
};

const centerColStyle: React.CSSProperties = {
  background: "#fff",
  border: "1px solid #e2e8f0",
  borderRadius: 8,
  padding: 12,
  minHeight: 400,
};

const rightRailStyle: React.CSSProperties = {
  background: "#fff",
  border: "1px solid #e2e8f0",
  borderRadius: 8,
  padding: 16,
  position: "sticky",
  top: 16,
  maxHeight: "calc(100vh - 32px)",
  overflowY: "auto",
};

const filterSectionStyle: React.CSSProperties = {
  borderBottom: "1px solid #f1f5f9",
  padding: "10px 4px 12px",
};
const filterLabelStyle: React.CSSProperties = {
  fontSize: 11,
  fontWeight: 700,
  textTransform: "uppercase",
  color: "#475569",
  letterSpacing: 0.5,
  marginBottom: 8,
};
const filterBodyStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 6,
};

const chipGroupStyle: React.CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  gap: 4,
};

function chipButtonStyle(active: boolean): React.CSSProperties {
  return {
    padding: "3px 8px",
    fontSize: 11,
    fontWeight: 500,
    borderRadius: 999,
    border: "1px solid",
    background: active ? "#1e293b" : "#fff",
    color: active ? "#fff" : "#334155",
    borderColor: active ? "#1e293b" : "#cbd5e1",
    cursor: "pointer",
  };
}

const selectStyle: React.CSSProperties = {
  padding: "6px 8px",
  border: "1px solid #cbd5e1",
  borderRadius: 6,
  fontSize: 12,
  background: "#fff",
  color: "#0f172a",
};

const toggleRowStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 6,
  fontSize: 12,
  color: "#334155",
  cursor: "pointer",
};

const fieldLabelStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  fontSize: 11,
  color: "#475569",
  gap: 4,
};

const inputStyle: React.CSSProperties = {
  padding: "5px 8px",
  border: "1px solid #cbd5e1",
  borderRadius: 6,
  fontSize: 12,
  background: "#fff",
  color: "#0f172a",
};

const primaryButtonStyle: React.CSSProperties = {
  padding: "6px 10px",
  fontSize: 12,
  fontWeight: 600,
  border: "1px solid #1e293b",
  background: "#1e293b",
  color: "#fff",
  borderRadius: 6,
  cursor: "pointer",
};

const savedViewListStyle: React.CSSProperties = {
  listStyle: "none",
  padding: 0,
  margin: 0,
  display: "flex",
  flexDirection: "column",
  gap: 4,
};
const savedViewRowStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 4,
};
const savedViewApplyStyle: React.CSSProperties = {
  flex: 1,
  textAlign: "left",
  padding: "5px 8px",
  border: "1px solid #e2e8f0",
  borderRadius: 6,
  background: "#f8fafc",
  fontSize: 12,
  color: "#0f172a",
  cursor: "pointer",
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  gap: 6,
};
const savedViewVisibilityStyle: React.CSSProperties = {
  fontSize: 10,
  color: "#64748b",
  textTransform: "uppercase",
};
const iconButtonStyle: React.CSSProperties = {
  padding: "2px 8px",
  border: "1px solid #e2e8f0",
  background: "#fff",
  color: "#64748b",
  borderRadius: 6,
  cursor: "pointer",
  fontSize: 14,
  lineHeight: 1,
};

const resultsHeaderStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  padding: "4px 4px 10px",
  borderBottom: "1px solid #f1f5f9",
  flexWrap: "wrap",
  gap: 8,
};

const emptyStateStyle: React.CSSProperties = {
  padding: 40,
  textAlign: "center",
  color: "#94a3b8",
  fontSize: 13,
};

const resultListStyle: React.CSSProperties = {
  listStyle: "none",
  padding: 0,
  margin: 0,
};

function resultRowStyle(active: boolean): React.CSSProperties {
  return {
    padding: "10px 12px",
    borderBottom: "1px solid #f1f5f9",
    cursor: "pointer",
    background: active ? "#f1f5f9" : "transparent",
    borderLeft: active ? "3px solid #1e293b" : "3px solid transparent",
  };
}
const resultRowHeaderStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  flexWrap: "wrap",
};
const resultTitleStyle: React.CSSProperties = {
  fontSize: 13,
  fontWeight: 600,
  color: "#0f172a",
};
const resultSubtitleStyle: React.CSSProperties = {
  fontSize: 12,
  color: "#475569",
  marginTop: 2,
};
const resultSummaryStyle: React.CSSProperties = {
  fontSize: 12,
  color: "#64748b",
  marginTop: 4,
  display: "-webkit-box",
  WebkitLineClamp: 2,
  WebkitBoxOrient: "vertical",
  overflow: "hidden",
};
const resultMetaStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  marginTop: 6,
  flexWrap: "wrap",
  gap: 6,
};
const badgeRowStyle: React.CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  gap: 4,
};

function docTypeChipStyle(type: DocumentType): React.CSSProperties {
  const palette: Record<DocumentType, { bg: string; fg: string; border: string }> = {
    EVIDENCE: { bg: "#eff6ff", fg: "#1e40af", border: "#bfdbfe" },
    WORKFLOW: { bg: "#ecfeff", fg: "#155e75", border: "#a5f3fc" },
    WORKFLOW_STEP: { bg: "#ecfdf5", fg: "#065f46", border: "#a7f3d0" },
    REVIEW_EVENT: { bg: "#fef3c7", fg: "#78350f", border: "#fde68a" },
    AUDIT_EVENT: { bg: "#f5f3ff", fg: "#5b21b6", border: "#ddd6fe" },
    COMMUNICATION: { bg: "#fff7ed", fg: "#9a3412", border: "#fed7aa" },
    CASE_TIMELINE: { bg: "#f0f9ff", fg: "#0c4a6e", border: "#bae6fd" },
    INCIDENT: { bg: "#fef2f2", fg: "#991b1b", border: "#fecaca" },
  };
  const p = palette[type];
  return {
    padding: "2px 8px",
    fontSize: 10,
    fontWeight: 600,
    borderRadius: 4,
    background: p.bg,
    color: p.fg,
    border: `1px solid ${p.border}`,
    textTransform: "uppercase",
    letterSpacing: 0.3,
    display: "inline-block",
    whiteSpace: "nowrap",
  };
}

function badgeChipStyle(badge: string): React.CSSProperties {
  const map: Record<string, { bg: string; fg: string; border: string }> = {
    "legal-hold": { bg: "#fef2f2", fg: "#991b1b", border: "#fecaca" },
    "export-restricted": { bg: "#fef3c7", fg: "#78350f", border: "#fde68a" },
    "visibility-restricted": {
      bg: "#f5f3ff",
      fg: "#5b21b6",
      border: "#ddd6fe",
    },
    "contributor-scoped": { bg: "#ecfdf5", fg: "#065f46", border: "#a7f3d0" },
    "workflow-linked": { bg: "#eff6ff", fg: "#1e40af", border: "#bfdbfe" },
    "review-linked": { bg: "#fef3c7", fg: "#78350f", border: "#fde68a" },
    "governance-restricted": {
      bg: "#fef2f2",
      fg: "#991b1b",
      border: "#fecaca",
    },
    "incident-linked": { bg: "#fef2f2", fg: "#991b1b", border: "#fecaca" },
    "communication-linked": { bg: "#fff7ed", fg: "#9a3412", border: "#fed7aa" },
    "integrity record": { bg: "#f0f9ff", fg: "#0c4a6e", border: "#bae6fd" },
    "matched metadata": { bg: "#f1f5f9", fg: "#334155", border: "#e2e8f0" },
    "related evidence": { bg: "#f1f5f9", fg: "#334155", border: "#e2e8f0" },
  };
  const p = map[badge] ?? {
    bg: "#f1f5f9",
    fg: "#334155",
    border: "#e2e8f0",
  };
  return {
    padding: "2px 6px",
    fontSize: 10,
    fontWeight: 500,
    borderRadius: 999,
    background: p.bg,
    color: p.fg,
    border: `1px solid ${p.border}`,
    whiteSpace: "nowrap",
  };
}

const loadMoreButtonStyle: React.CSSProperties = {
  marginTop: 12,
  padding: "8px 16px",
  width: "100%",
  fontSize: 13,
  fontWeight: 500,
  border: "1px solid #cbd5e1",
  background: "#fff",
  color: "#334155",
  borderRadius: 6,
  cursor: "pointer",
};

const inspectorHeaderStyle: React.CSSProperties = {
  paddingBottom: 12,
  borderBottom: "1px solid #f1f5f9",
  marginBottom: 8,
};
const inspectorTitleStyle: React.CSSProperties = {
  fontSize: 16,
  fontWeight: 700,
  margin: "6px 0 0",
  color: "#0f172a",
  wordBreak: "break-word",
};
const inspectorSubtitleStyle: React.CSSProperties = {
  fontSize: 12,
  color: "#475569",
  margin: "4px 0 0",
};

const sectionStyle: React.CSSProperties = {
  padding: "10px 0",
  borderBottom: "1px solid #f8fafc",
};
const sectionLabelStyle: React.CSSProperties = {
  fontSize: 11,
  fontWeight: 700,
  textTransform: "uppercase",
  color: "#475569",
  letterSpacing: 0.5,
  marginBottom: 6,
};

const keyValRowStyle: React.CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "baseline",
  gap: 8,
  padding: "2px 0",
  fontSize: 12,
};
const keyValLabelStyle: React.CSSProperties = {
  color: "#64748b",
  fontSize: 11,
  textTransform: "uppercase",
  letterSpacing: 0.3,
  whiteSpace: "nowrap",
};
const keyValValueStyle: React.CSSProperties = {
  color: "#0f172a",
  textAlign: "right",
  fontSize: 12,
  wordBreak: "break-word",
};
const keyValMonoStyle: React.CSSProperties = {
  ...keyValValueStyle,
  fontFamily:
    "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
  fontSize: 11,
};

const pointerLinkStyle: React.CSSProperties = {
  color: "#1e40af",
  textDecoration: "none",
};

const summaryProseStyle: React.CSSProperties = {
  fontSize: 12,
  lineHeight: 1.5,
  color: "#334155",
  margin: 0,
  whiteSpace: "pre-wrap",
};

const relationshipListStyle: React.CSSProperties = {
  listStyle: "none",
  padding: 0,
  margin: 0,
  display: "flex",
  flexDirection: "column",
  gap: 4,
};
const relationshipRowStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 6,
  padding: "4px 0",
  fontSize: 12,
  borderBottom: "1px solid #f8fafc",
};
const relTypeChipStyle: React.CSSProperties = {
  padding: "2px 6px",
  fontSize: 10,
  fontWeight: 600,
  borderRadius: 4,
  background: "#f1f5f9",
  color: "#334155",
  border: "1px solid #e2e8f0",
  whiteSpace: "nowrap",
};

const mutedStyle: React.CSSProperties = {
  fontSize: 12,
  color: "#64748b",
};
