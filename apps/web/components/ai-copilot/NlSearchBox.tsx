"use client";

/**
 * Phase F1 (UI) — Enterprise natural-language search box.
 * Deterministic NL→filter translation server-side; results are links into
 * existing authorized surfaces. Unsupported filters are refused honestly.
 */
import { useState } from "react";
import Link from "next/link";

import { apiFetch } from "../../lib/api";
import { useActiveWorkspaceId } from "../../lib/platform-context";

type NlRow = { id: string; title: string; route: string; badge: string };
type NlResponse =
  | { kind: "REFUSED"; message: string }
  | { kind: "UNSUPPORTED_FILTER"; message: string }
  | { kind: "STATE_QUERY"; query: string; rows: NlRow[]; total: number }
  | { kind: "TEXT_SEARCH"; q: string | null; rows: NlRow[]; total: number };

const EXAMPLES = ["Find TSA pending", "Show pending reviews", "Show evidence waiting for report", "Find unsigned packages"];

export function NlSearchBox() {
  const teamId = useActiveWorkspaceId();
  const [query, setQuery] = useState("");
  const [state, setState] = useState<{ kind: "idle" } | { kind: "loading" } | { kind: "done"; res: NlResponse } | { kind: "error" }>({ kind: "idle" });

  async function run(q: string) {
    if (!teamId || !q.trim() || state.kind === "loading") return;
    setState({ kind: "loading" });
    try {
      const res = (await apiFetch(`/v1/ai/search/nl`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ teamId, query: q.trim() }),
      })) as NlResponse;
      setState({ kind: "done", res });
    } catch {
      setState({ kind: "error" });
    }
  }

  if (!teamId) return null;
  return (
    <section className="app-panel app-panel__body" style={{ marginBottom: 16 }} aria-label="Ask in plain language">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
        <h3 style={{ margin: 0 }}>Ask in plain language</h3>
        <span className="app-chip">Deterministic filters · Advisory</span>
      </div>
      <form
        onSubmit={(e) => { e.preventDefault(); void run(query); }}
        style={{ display: "flex", gap: 8, marginTop: 8 }}
      >
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder='e.g. "Find TSA pending" or "Show pending reviews"'
          aria-label="Natural language search"
          maxLength={300}
          style={{ flex: 1, padding: "8px 10px" }}
        />
        <button className="app-primary-action" type="submit" disabled={state.kind === "loading"} aria-busy={state.kind === "loading"}>
          {state.kind === "loading" ? "Searching…" : "Search"}
        </button>
      </form>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 6 }}>
        {EXAMPLES.map((e) => (
          <button key={e} className="app-secondary-action" style={{ fontSize: 12 }} onClick={() => { setQuery(e); void run(e); }}>{e}</button>
        ))}
      </div>
      {state.kind === "error" ? <div className="app-alert app-alert--warn" style={{ marginTop: 10 }} role="alert">Search is unavailable right now. Standard search below remains fully functional.</div> : null}
      <div aria-live="polite">
        {state.kind === "done" ? <Results res={state.res} /> : null}
      </div>
    </section>
  );
}

function Results({ res }: { res: NlResponse }) {
  if (res.kind === "REFUSED" || res.kind === "UNSUPPORTED_FILTER") {
    return <div className="app-alert" style={{ marginTop: 10 }}>{res.message}</div>;
  }
  if (res.rows.length === 0) {
    return <div className="app-alert" style={{ marginTop: 10 }}>No matching records.</div>;
  }
  return (
    <div style={{ marginTop: 10 }}>
      <p style={{ fontSize: 12, opacity: 0.65, margin: "0 0 6px" }}>
        {res.kind === "STATE_QUERY" ? `Operational filter applied · ${res.total} total` : `Text search · ${res.total} shown`}
      </p>
      <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
        {res.rows.map((r) => (
          <li key={`${r.route}:${r.id}`} style={{ display: "flex", gap: 8, alignItems: "center", padding: "4px 0" }}>
            <span className="app-chip">{r.badge}</span>
            <Link href={r.route} className="app-link">{r.title}</Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
