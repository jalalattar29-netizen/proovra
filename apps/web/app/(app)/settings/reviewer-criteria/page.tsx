"use client";
import { formatUserDate } from "../../../../lib/date";

/**
 * Phase P2 — Settings → Reviewer Criteria (management UI).
 * Human-authored, versioned, immutable-after-publish criteria catalog.
 * AI never creates or publishes criteria.
 */
import { useCallback, useEffect, useState } from "react";

import { apiFetch, ApiError } from "../../../../lib/api";
import { useActiveWorkspaceId } from "../../../../lib/platform-context";
import { PageRouteGate } from "../../../../components/navigation/PageRouteGate";

type CriterionRow = { key: string; title: string; required: boolean; reviewGuidance?: string };
type Version = {
  id: string; version: number; title: string; publishedAt: string | null;
  createdAt: string; criteria?: Array<{ key: string; title: string; required: boolean; order: number }>;
};
type CriteriaSet = {
  id: string; name: string; description: string | null; status: string;
  createdAt: string; updatedAt: string;
  versions: Version[];
};

export default function ReviewerCriteriaPage() {
  return (
    <PageRouteGate routeId="workspace.reviewer_criteria">
      <ReviewerCriteriaPageInner />
    </PageRouteGate>
  );
}

function ReviewerCriteriaPageInner() {
  const teamId = useActiveWorkspaceId();
  const [sets, setSets] = useState<CriteriaSet[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [historyId, setHistoryId] = useState<string | null>(null);
  const [editId, setEditId] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!teamId) return;
    try {
      const res = (await apiFetch(`/v1/reviewer-criteria?teamId=${teamId}`)) as { sets: CriteriaSet[] };
      setSets(res.sets);
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError && err.statusCode === 403 ? "You are not a member of this workspace." : "The criteria catalog is unavailable (it may not be provisioned in this environment yet).");
      setSets([]);
    }
  }, [teamId]);
  useEffect(() => { void load(); }, [load]);

  async function act(setId: string, op: "publish" | "duplicate" | "retire") {
    if (!teamId || busy) return;
    setBusy(true);
    try {
      await apiFetch(`/v1/reviewer-criteria/${setId}/${op}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ teamId }),
      });
      await load();
    } catch (err) {
      setError(
        err instanceof ApiError && err.statusCode === 403
          ? "Only workspace owners/admins can manage criteria."
          : err instanceof ApiError && err.statusCode === 409
            ? "That action conflicts with the set's current state (e.g. a draft already exists, or the version is already published)."
            : `The ${op} action failed.`,
      );
    } finally {
      setBusy(false);
    }
  }

  if (!teamId) return <main style={{ padding: 24 }}><p>Select a workspace.</p></main>;
  return (
    <main style={{ padding: 24, maxWidth: 980 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
        <h1 style={{ margin: 0 }}>Reviewer Criteria</h1>
        <button className="app-btn app-btn--primary" onClick={() => setShowCreate((v) => !v)}>
          {showCreate ? "Close" : "New criteria set"}
        </button>
      </div>
      <p style={{ opacity: 0.75, fontSize: 14 }}>
        Human-authored, versioned criteria that guide reviewers. Published versions are
        immutable; the Reviewer Copilot may explain criteria but never authors, edits,
        or publishes them.
      </p>
      {error ? <div className="app-alert app-alert--warn" role="alert">{error}</div> : null}
      {showCreate ? <CreateForm teamId={teamId} onCreated={() => { setShowCreate(false); void load(); }} /> : null}

      {sets === null ? <p style={{ opacity: 0.6 }}>Loading…</p> : null}
      {sets && sets.length === 0 && !error ? (
        <div className="app-card" style={{ marginTop: 16 }}>
          <p style={{ margin: 0, opacity: 0.7 }}>No criteria sets yet. Create the first one to standardize your reviews.</p>
        </div>
      ) : null}
      {sets?.map((s) => (
        <section key={s.id} className="app-card" style={{ marginTop: 12 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
            <div>
              <strong>{s.name}</strong>{" "}
              <span className={`app-chip ${s.status === "PUBLISHED" ? "app-chip--ok" : ""}`}>{s.status.toLowerCase()}</span>
              {s.description ? <div style={{ fontSize: 13, opacity: 0.7 }}>{s.description}</div> : null}
            </div>
            <span style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
              {s.status === "DRAFT" ? (
                <>
                  <button className="app-btn app-btn--ghost" disabled={busy} onClick={() => setEditId(editId === s.id ? null : s.id)}>
                    {editId === s.id ? "Close editor" : "Edit draft"}
                  </button>
                  <button className="app-btn app-btn--primary" disabled={busy} onClick={() => void act(s.id, "publish")}>
                    Publish v{s.versions[0]?.version ?? 1}
                  </button>
                </>
              ) : null}
              {s.status === "PUBLISHED" ? (
                <button className="app-btn app-btn--ghost" disabled={busy} onClick={() => void act(s.id, "duplicate")}>
                  Duplicate as v{(s.versions[0]?.version ?? 1) + 1}
                </button>
              ) : null}
              {s.status !== "RETIRED" ? (
                <button className="app-btn app-btn--ghost" disabled={busy} onClick={() => void act(s.id, "retire")}>
                  Retire
                </button>
              ) : null}
              <button className="app-btn app-btn--ghost" onClick={() => setHistoryId(historyId === s.id ? null : s.id)}>
                {historyId === s.id ? "Hide history" : "History"}
              </button>
            </span>
          </div>
          <div style={{ fontSize: 12, opacity: 0.65, marginTop: 6 }}>
            Latest: v{s.versions[0]?.version ?? 1} — {s.versions[0]?.title ?? ""}
            {s.versions[0]?.publishedAt ? ` · published ${formatUserDate(s.versions[0].publishedAt)} (immutable)` : " · draft (editable until published)"}
            {" · updated "}{formatUserDate(s.updatedAt)}
          </div>
          {editId === s.id && s.status === "DRAFT" ? (
            <DraftEditor teamId={teamId} setId={s.id} onSaved={() => { setEditId(null); void load(); }} />
          ) : null}
          {historyId === s.id ? <VersionHistory teamId={teamId} setId={s.id} /> : null}
        </section>
      ))}
    </main>
  );
}

type VersionUsage = { version: number; runCount: number; reviewCount: number; reviewerCount: number; lastUsedAt: string | null };

/**
 * Consumes GET /v1/reviewer-criteria/:setId — full version history + criteria.
 * Phase F-4 — also shows per-version USAGE (from the Copilot run records) and
 * an on-demand COMPARISON between any two versions.
 */
function VersionHistory({ teamId, setId }: { teamId: string; setId: string }) {
  const [detail, setDetail] = useState<{
    versions: Array<Version & { criteria: Array<{ key: string; title: string; required: boolean }> }>;
  } | null>(null);
  const [usage, setUsage] = useState<VersionUsage[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [compareA, setCompareA] = useState<number | null>(null);
  const [compareB, setCompareB] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = (await apiFetch(`/v1/reviewer-criteria/${setId}?teamId=${teamId}`)) as { set: { versions: Array<Version & { criteria: Array<{ key: string; title: string; required: boolean }> }> } };
        if (!cancelled) setDetail({ versions: res.set.versions });
      } catch {
        if (!cancelled) setFailed(true);
      }
      try {
        const u = (await apiFetch(`/v1/reviewer-criteria/${setId}/usage?teamId=${teamId}`)) as { usageAvailable: boolean; usage: VersionUsage[] };
        if (!cancelled && u.usageAvailable) setUsage(u.usage);
      } catch {
        /* usage is additive — history still renders without it */
      }
    })();
    return () => { cancelled = true; };
  }, [teamId, setId]);

  if (failed) return <div className="app-alert app-alert--warn" style={{ marginTop: 8 }} role="alert">Version history is unavailable.</div>;
  if (!detail) return <p style={{ fontSize: 12, opacity: 0.6, marginTop: 8 }} aria-live="polite">Loading history…</p>;

  const usageFor = (version: number) => usage?.find((u) => u.version === version) ?? null;
  const versionByNumber = (n: number | null) => detail.versions.find((v) => v.version === n) ?? null;
  const vA = versionByNumber(compareA);
  const vB = versionByNumber(compareB);

  return (
    <div style={{ marginTop: 8, borderTop: "1px solid var(--app-border,#eee)", paddingTop: 8 }}>
      {detail.versions.length > 1 ? (
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginBottom: 8, fontSize: 13 }}>
          <span>Compare</span>
          <select aria-label="Compare from version" value={compareA ?? ""} onChange={(e) => setCompareA(e.target.value ? Number(e.target.value) : null)}>
            <option value="">from…</option>
            {detail.versions.map((v) => <option key={v.id} value={v.version}>v{v.version}</option>)}
          </select>
          <select aria-label="Compare to version" value={compareB ?? ""} onChange={(e) => setCompareB(e.target.value ? Number(e.target.value) : null)}>
            <option value="">to…</option>
            {detail.versions.map((v) => <option key={v.id} value={v.version}>v{v.version}</option>)}
          </select>
        </div>
      ) : null}
      {vA && vB && vA.id !== vB.id ? (
        <div className="app-card app-card--muted" style={{ marginBottom: 8 }}>
          <strong style={{ fontSize: 13 }}>v{vA.version} → v{vB.version}</strong>
          {vA.title !== vB.title ? <p style={{ margin: "4px 0 0", fontSize: 12 }}>Title: “{vA.title}” → “{vB.title}”</p> : null}
          <ul style={{ margin: "4px 0 0", paddingLeft: 18, fontSize: 12 }}>
            {diffCriteria(vA.criteria ?? [], vB.criteria ?? []).map((line, i) => <li key={i}>{line}</li>)}
          </ul>
        </div>
      ) : null}
      {detail.versions.map((v) => {
        const u = usageFor(v.version);
        return (
          <div key={v.id} style={{ marginBottom: 8 }}>
            <div style={{ fontSize: 13 }}>
              <strong>v{v.version}</strong> — {v.title}{" "}
              <span className={`app-chip ${v.publishedAt ? "app-chip--ok" : ""}`}>
                {v.publishedAt ? `published ${formatUserDate(v.publishedAt)} · immutable` : "draft"}
              </span>
              <span style={{ opacity: 0.6, marginLeft: 6 }}>created {formatUserDate(v.createdAt)}</span>
            </div>
            {u && u.runCount > 0 ? (
              <div style={{ fontSize: 12, opacity: 0.75, marginTop: 2 }}>
                Used in {u.runCount} Copilot run(s) across {u.reviewCount} review(s) by {u.reviewerCount} reviewer(s)
                {u.lastUsedAt ? ` · last used ${formatUserDate(u.lastUsedAt)}` : ""}
              </div>
            ) : u ? (
              <div style={{ fontSize: 12, opacity: 0.55, marginTop: 2 }}>Not used by any Copilot run yet.</div>
            ) : null}
            <ul style={{ margin: "4px 0 0", paddingLeft: 18, fontSize: 12, opacity: 0.8 }}>
              {v.criteria?.map((c) => (
                <li key={c.key}>{c.title}{c.required ? " (required)" : ""}</li>
              ))}
            </ul>
          </div>
        );
      })}
    </div>
  );
}

type DraftServerState = {
  updatedAt: string;
  latestPublished: boolean;
  title: string;
  rows: CriterionRow[];
};

/** Phase F-4 — key-based criteria diff used by conflict compare + version compare. */
function diffCriteria(
  a: Array<{ key: string; title: string; required: boolean }>,
  b: Array<{ key: string; title: string; required: boolean }>,
): string[] {
  const byKey = (list: typeof a) => new Map(list.map((c) => [c.key, c]));
  const mapA = byKey(a);
  const mapB = byKey(b);
  const out: string[] = [];
  for (const [key, c] of mapB) {
    const prev = mapA.get(key);
    if (!prev) out.push(`Added "${key}" — ${c.title}${c.required ? " (required)" : ""}`);
    else if (prev.title !== c.title || prev.required !== c.required) {
      out.push(`Changed "${key}" — ${prev.title}${prev.required ? " (required)" : ""} → ${c.title}${c.required ? " (required)" : ""}`);
    }
  }
  for (const [key, c] of mapA) {
    if (!mapB.has(key)) out.push(`Removed "${key}" — ${c.title}`);
  }
  return out.length > 0 ? out : ["No criteria differences."];
}

/**
 * Consumes PATCH /v1/reviewer-criteria/:setId/draft — edits the latest DRAFT
 * version in place. Published versions are immutable; the API enforces it
 * (409 published_immutable) and this editor only renders for DRAFT sets.
 *
 * Phase F-4 — optimistic concurrency: the editor holds the set's updatedAt
 * it loaded and sends it as expectedUpdatedAt; a 409 draft_conflict opens a
 * conflict panel (Reload latest / Compare changes / Save as new draft when
 * the other change was a publish).
 */
function DraftEditor({ teamId, setId, onSaved }: { teamId: string; setId: string; onSaved: () => void }) {
  const [title, setTitle] = useState("");
  const [rows, setRows] = useState<CriterionRow[] | null>(null);
  const [baseUpdatedAt, setBaseUpdatedAt] = useState<string | null>(null);
  const [conflict, setConflict] = useState<DraftServerState | null>(null);
  const [showCompare, setShowCompare] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const loadServer = useCallback(async (): Promise<DraftServerState | null> => {
    const res = (await apiFetch(`/v1/reviewer-criteria/${setId}?teamId=${teamId}`)) as {
      set: { updatedAt: string; versions: Array<Omit<Version, "criteria"> & { criteria: Array<{ key: string; title: string; required: boolean; reviewGuidance?: string | null }> }> };
    };
    const latest = res.set.versions[0];
    if (!latest) return null;
    return {
      updatedAt: res.set.updatedAt,
      latestPublished: Boolean(latest.publishedAt),
      title: latest.title,
      rows: latest.criteria.map((c) => ({ key: c.key, title: c.title, required: c.required, reviewGuidance: c.reviewGuidance ?? undefined })),
    };
  }, [teamId, setId]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const server = await loadServer();
        if (!cancelled && server) {
          setTitle(server.title);
          setRows(server.rows);
          setBaseUpdatedAt(server.updatedAt);
        }
      } catch {
        if (!cancelled) setErr("The draft could not be loaded.");
      }
    })();
    return () => { cancelled = true; };
  }, [loadServer]);

  function updateRow(i: number, patch: Partial<CriterionRow>) {
    setRows((prev) => (prev ? prev.map((r, idx) => (idx === i ? { ...r, ...patch } : r)) : prev));
  }

  function criteriaBody() {
    return (rows ?? []).map((r, i) => ({ key: r.key.trim(), title: r.title.trim(), required: r.required, order: i, reviewGuidance: r.reviewGuidance?.trim() || undefined }));
  }

  async function save(expected: string | null) {
    if (busy || !rows || !title.trim() || rows.some((r) => !r.key.trim() || !r.title.trim())) {
      setErr("Version title and every criterion key/title are required.");
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      await apiFetch(`/v1/reviewer-criteria/${setId}/draft`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          teamId, title: title.trim(),
          ...(expected ? { expectedUpdatedAt: expected } : {}),
          criteria: criteriaBody(),
        }),
      });
      setConflict(null);
      onSaved();
    } catch (e) {
      if (e instanceof ApiError && e.statusCode === 409) {
        // Another admin changed the set — load their state for the panel.
        try {
          const server = await loadServer();
          setConflict(server);
          setShowCompare(false);
        } catch {
          setErr("This draft changed on the server and the latest state could not be loaded.");
        }
      } else {
        setErr(
          e instanceof ApiError && e.statusCode === 403
            ? "Only workspace owners/admins can edit criteria."
            : "The draft could not be saved.",
        );
      }
    } finally {
      setBusy(false);
    }
  }

  async function reloadLatest() {
    setBusy(true);
    try {
      const server = await loadServer();
      if (server) {
        setTitle(server.title);
        setRows(server.rows);
        setBaseUpdatedAt(server.updatedAt);
        setConflict(null);
        setShowCompare(false);
      }
    } catch {
      setErr("The latest version could not be loaded.");
    } finally {
      setBusy(false);
    }
  }

  async function saveAsNewDraft() {
    // Only offered when the conflicting change was a PUBLISH: duplicate the
    // published version as v(N+1) and save this editor's content into it.
    if (busy || !conflict?.latestPublished) return;
    setBusy(true);
    setErr(null);
    try {
      await apiFetch(`/v1/reviewer-criteria/${setId}/duplicate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ teamId }),
      });
      await apiFetch(`/v1/reviewer-criteria/${setId}/draft`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ teamId, title: title.trim(), criteria: criteriaBody() }),
      });
      setConflict(null);
      onSaved();
    } catch {
      setErr("Saving as a new draft failed. Reload the latest version and try again.");
    } finally {
      setBusy(false);
    }
  }

  if (err && !rows) return <div className="app-alert app-alert--warn" style={{ marginTop: 8 }}>{err}</div>;
  if (!rows) return <p style={{ fontSize: 12, opacity: 0.6, marginTop: 8 }} aria-live="polite">Loading draft…</p>;
  return (
    <div style={{ marginTop: 8, borderTop: "1px solid var(--app-border,#eee)", paddingTop: 8, display: "grid", gap: 8 }}>
      {err ? <div className="app-alert app-alert--warn" role="alert">{err}</div> : null}
      {conflict ? (
        <div className="app-alert app-alert--warn" role="alert">
          <p style={{ margin: "0 0 6px" }}>
            <strong>Edit conflict:</strong> this criteria set was changed by someone else
            {conflict.latestPublished ? " (the draft was published)" : ""} since you loaded it. Your changes were NOT saved.
          </p>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button className="app-btn app-btn--primary" onClick={() => void reloadLatest()} disabled={busy}>Reload latest version</button>
            <button className="app-btn app-btn--ghost" onClick={() => setShowCompare((v) => !v)} disabled={busy} aria-expanded={showCompare}>
              {showCompare ? "Hide comparison" : "Compare changes"}
            </button>
            {conflict.latestPublished ? (
              <button className="app-btn app-btn--ghost" onClick={() => void saveAsNewDraft()} disabled={busy}>Save as new draft</button>
            ) : (
              <button className="app-btn app-btn--ghost" onClick={() => void save(null)} disabled={busy}>Overwrite with my changes</button>
            )}
          </div>
          {showCompare ? (
            <ul style={{ margin: "8px 0 0", paddingLeft: 18, fontSize: 12 }}>
              {diffCriteria(conflict.rows, rows).map((line, i) => <li key={i}>{line}</li>)}
              <li style={{ opacity: 0.6 }}>(&quot;Added/Changed&quot; = in your editor; &quot;Removed&quot; = only in the server version.)</li>
            </ul>
          ) : null}
        </div>
      ) : null}
      <input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={160} aria-label="Draft version title" />
      {rows.map((r, i) => (
        <div key={i} style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
          <input value={r.key} onChange={(e) => updateRow(i, { key: e.target.value })} placeholder="key" maxLength={60} style={{ width: 140 }} aria-label={`Draft criterion ${i + 1} key`} />
          <input value={r.title} onChange={(e) => updateRow(i, { title: e.target.value })} placeholder="What the reviewer should inspect" maxLength={200} style={{ flex: 1, minWidth: 200 }} aria-label={`Draft criterion ${i + 1} title`} />
          <label style={{ fontSize: 12, display: "flex", gap: 4, alignItems: "center" }}>
            <input type="checkbox" checked={r.required} onChange={(e) => updateRow(i, { required: e.target.checked })} /> required
          </label>
          <button className="app-btn app-btn--ghost" onClick={() => setRows((prev) => (prev ? prev.filter((_, idx) => idx !== i) : prev))} disabled={rows.length === 1} aria-label={`Remove draft criterion ${i + 1}`}>✕</button>
        </div>
      ))}
      <div style={{ display: "flex", gap: 8 }}>
        <button className="app-btn app-btn--ghost" onClick={() => setRows((prev) => (prev ? [...prev, { key: "", title: "", required: false }] : prev))} disabled={rows.length >= 50}>Add criterion</button>
        <button className="app-btn app-btn--primary" onClick={() => void save(baseUpdatedAt)} disabled={busy} aria-busy={busy}>{busy ? "Saving…" : "Save draft"}</button>
      </div>
    </div>
  );
}

function CreateForm({ teamId, onCreated }: { teamId: string; onCreated: () => void }) {
  const [name, setName] = useState("");
  const [title, setTitle] = useState("");
  const [rows, setRows] = useState<CriterionRow[]>([{ key: "completeness", title: "Required context is present", required: true }]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  function updateRow(i: number, patch: Partial<CriterionRow>) {
    setRows((prev) => prev.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  }

  async function submit() {
    if (busy || !name.trim() || !title.trim() || rows.some((r) => !r.key.trim() || !r.title.trim())) {
      setErr("Name, version title, and every criterion key/title are required.");
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      await apiFetch(`/v1/reviewer-criteria`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          teamId, name: name.trim(), title: title.trim(),
          criteria: rows.map((r, i) => ({ key: r.key.trim(), title: r.title.trim(), required: r.required, order: i, reviewGuidance: r.reviewGuidance?.trim() || undefined })),
        }),
      });
      onCreated();
    } catch (e) {
      setErr(e instanceof ApiError && e.statusCode === 403 ? "Only workspace owners/admins can author criteria." : "Could not create the criteria set.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="app-card" style={{ marginTop: 12 }}>
      <strong>New criteria set (draft)</strong>
      {err ? <div className="app-alert app-alert--warn">{err}</div> : null}
      <div style={{ display: "grid", gap: 8, marginTop: 8 }}>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Set name (e.g. Insurance intake review)" maxLength={160} aria-label="Criteria set name" />
        <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Version title (e.g. Baseline v1)" maxLength={160} aria-label="Version title" />
        {rows.map((r, i) => (
          <div key={i} style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
            <input value={r.key} onChange={(e) => updateRow(i, { key: e.target.value })} placeholder="key" maxLength={60} style={{ width: 140 }} aria-label={`Criterion ${i + 1} key`} />
            <input value={r.title} onChange={(e) => updateRow(i, { title: e.target.value })} placeholder="What the reviewer should inspect" maxLength={200} style={{ flex: 1, minWidth: 200 }} aria-label={`Criterion ${i + 1} title`} />
            <label style={{ fontSize: 12, display: "flex", gap: 4, alignItems: "center" }}>
              <input type="checkbox" checked={r.required} onChange={(e) => updateRow(i, { required: e.target.checked })} /> required
            </label>
            <button className="app-btn app-btn--ghost" onClick={() => setRows((prev) => prev.filter((_, idx) => idx !== i))} disabled={rows.length === 1} aria-label={`Remove criterion ${i + 1}`}>✕</button>
          </div>
        ))}
        <div style={{ display: "flex", gap: 8 }}>
          <button className="app-btn app-btn--ghost" onClick={() => setRows((prev) => [...prev, { key: "", title: "", required: false }])} disabled={rows.length >= 50}>Add criterion</button>
          <button className="app-btn app-btn--primary" onClick={() => void submit()} disabled={busy}>{busy ? "Creating…" : "Create draft"}</button>
        </div>
      </div>
    </section>
  );
}
