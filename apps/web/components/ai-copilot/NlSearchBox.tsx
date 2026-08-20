"use client";

/**
 * Phase F1 (UI) — Enterprise natural-language search box.
 * Deterministic NL→filter translation server-side; results are links into
 * existing authorized surfaces. Unsupported filters are refused honestly.
 *
 * REDESIGN/SEARCH — this component is rendered by exactly one surface, the
 * /search console, so it is part of that console's presentation and is
 * described by `search.css` (`.search-nl*`) alongside it. Its own fourteen
 * inline style objects are deleted; the one class it named that nothing
 * declared (`.app-link`) is replaced by a rule that actually exists.
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
    <section
      className="app-panel app-panel__body search-nl"
      aria-label="Ask in plain language"
      data-search-nl
    >
      <div className="search-nl__head">
        <h2 className="search-nl__title">Ask in plain language</h2>
        {/* The translation is deterministic and the ranking is advisory — the
            same statement the console's own header makes. */}
        <span className="app-chip">Deterministic filters · Advisory</span>
      </div>
      <form
        onSubmit={(e) => { e.preventDefault(); void run(query); }}
        className="search-nl__form"
      >
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder='e.g. "Find TSA pending" or "Show pending reviews"'
          aria-label="Natural language search"
          maxLength={300}
          className="app-form-input"
        />
        <button className="app-primary-action" type="submit" disabled={state.kind === "loading"} aria-busy={state.kind === "loading"}>
          {state.kind === "loading" ? "Searching…" : "Search"}
        </button>
      </form>
      <div className="search-nl__examples">
        {EXAMPLES.map((e) => (
          <button
            key={e}
            type="button"
            className="app-secondary-action search-nl__example"
            onClick={() => { setQuery(e); void run(e); }}
          >
            {e}
          </button>
        ))}
      </div>
      {state.kind === "error" ? (
        <div className="app-alert app-alert--warn" role="alert">
          Search is unavailable right now. Standard search below remains fully
          functional.
        </div>
      ) : null}
      <div aria-live="polite">
        {state.kind === "done" ? <Results res={state.res} /> : null}
      </div>
    </section>
  );
}

function Results({ res }: { res: NlResponse }) {
  // A refusal is the server declining to translate the question, not a
  // failure to find records. Both are stated in the server's own bounded words.
  if (res.kind === "REFUSED" || res.kind === "UNSUPPORTED_FILTER") {
    return <div className="app-alert">{res.message}</div>;
  }
  if (res.rows.length === 0) {
    return <div className="app-alert">No matching records.</div>;
  }
  return (
    <div className="search-nl">
      <p className="search-nl__meta">
        {res.kind === "STATE_QUERY" ? `Operational filter applied · ${res.total} total` : `Text search · ${res.total} shown`}
      </p>
      <ul className="search-nl__list">
        {res.rows.map((r) => (
          <li key={`${r.route}:${r.id}`} className="search-nl__row">
            <span className="app-chip">{r.badge}</span>
            <Link href={r.route} className="search-nl__link">{r.title}</Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
