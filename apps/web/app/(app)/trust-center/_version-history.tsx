"use client";

/**
 * Read-only version history for Trust Center records.
 *
 *   GET /v1/trust/articles/:id/versions       (every article upsert writes one)
 *   GET /v1/trust/subprocessors/:id/versions  (every registry change writes one,
 *                                              with a required change summary)
 *
 * Both surfaces promised versioning ("Version N", "Every entry is versioned")
 * and offered no way to see an earlier version. The history is fetched when
 * it is opened, shown newest first, and never mutates anything. A failed
 * read is reported as a failure with a retry, never as "no history".
 */

import { useEffect, useId, useState, type ReactNode } from "react";

import {
  identifierLabel,
  type TrustArticleVersionProjection,
} from "@proovra/shared";

import { Button } from "../../../components/ui/Button";
import { apiFetch } from "../../../lib/api";
import { formatUserDate } from "../../../lib/date";
import { toSafeUserError } from "../../../lib/feedback/toSafeUserError";

type Load<T> =
  | { status: "loading" }
  | { status: "ready"; value: T }
  | { status: "failed"; message: string };

function readFailure(err: unknown, fallback: string): string {
  const status = (err as { statusCode?: number })?.statusCode;
  if (status === 403 || status === 404) {
    return "You do not have access to this record's version history in the current workspace.";
  }
  return toSafeUserError(err, { message: fallback }).message;
}

/** Fetches `url` while `open`; `revision` forces a reread. */
function useVersions<T>(url: string, open: boolean, revision: number, key: string, fallback: string) {
  const [state, setState] = useState<Load<T[]>>({ status: "loading" });
  useEffect(() => {
    if (!open) return;
    let current = true;
    setState({ status: "loading" });
    apiFetch(url, { method: "GET" })
      .then((res) => {
        if (!current) return;
        const rows = ((res as Record<string, unknown> | null)?.[key] ?? []) as T[];
        setState({ status: "ready", value: Array.isArray(rows) ? rows : [] });
      })
      .catch((err) => {
        if (current) setState({ status: "failed", message: readFailure(err, fallback) });
      });
    return () => {
      current = false;
    };
  }, [url, open, revision, key, fallback]);
  return state;
}

function newestFirst<T extends { version: number }>(rows: T[]): T[] {
  return [...rows].sort((a, b) => b.version - a.version);
}

function StateView<T>({
  state,
  retry,
  retryLabel,
  children,
}: {
  state: Load<T[]>;
  retry: () => void;
  retryLabel: string;
  children: (rows: T[]) => ReactNode;
}) {
  if (state.status === "loading") return <p role="status">Loading version history…</p>;
  if (state.status === "failed") {
    return (
      <div role="alert" style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
        <span>{state.message}</span>
        <Button size="sm" variant="secondary" onClick={retry}>
          {retryLabel}
        </Button>
      </div>
    );
  }
  return <>{children(state.value)}</>;
}

// ---------------------------------------------------------------------------
// Articles
// ---------------------------------------------------------------------------

export function ArticleVersionHistory({ articleId, title }: { articleId: string; title: string }) {
  const [open, setOpen] = useState(false);
  const [revision, setRevision] = useState(0);
  const [reading, setReading] = useState<string | null>(null);
  const panelId = useId();
  const state = useVersions<TrustArticleVersionProjection>(
    `/v1/trust/articles/${encodeURIComponent(articleId)}/versions`,
    open,
    revision,
    "versions",
    "The version history could not be loaded.",
  );

  return (
    <div data-trust-article-history={articleId}>
      <Button
        size="sm"
        variant="secondary"
        aria-expanded={open}
        aria-controls={panelId}
        aria-label={`Version history for ${title}`}
        onClick={() => setOpen((v) => !v)}
      >
        {open ? "Hide version history" : "Version history"}
      </Button>
      <div id={panelId} hidden={!open} style={{ marginTop: 8, overflowWrap: "anywhere" }}>
        {open ? (
          <StateView state={state} retry={() => setRevision((v) => v + 1)} retryLabel="Retry version history">
            {(rows) =>
              rows.length === 0 ? (
                <p>No earlier versions are recorded for this section.</p>
              ) : (
                <>
                  {rows.length === 1 ? <p>Only one version is recorded — this is the original text.</p> : null}
                  <ol aria-label={`Versions of ${title}`} style={{ display: "grid", gap: 10, paddingInlineStart: 20 }}>
                    {newestFirst(rows).map((v) => (
                      <li key={v.id} data-trust-article-version-row={v.version}>
                        <strong>Version {v.version}</strong> · {identifierLabel(v.state)} ·{" "}
                        {v.publishedAtUtc
                          ? `Published ${formatUserDate(v.publishedAtUtc)}`
                          : `Saved ${formatUserDate(v.createdAtUtc)}`}
                        {v.summary ? <div>{v.summary}</div> : null}
                        <Button
                          size="sm"
                          variant="ghost"
                          aria-expanded={reading === v.id}
                          aria-controls={`${panelId}-${v.version}`}
                          onClick={() => setReading(reading === v.id ? null : v.id)}
                        >
                          {reading === v.id ? `Hide version ${v.version}` : `Read version ${v.version}`}
                        </Button>
                        <div id={`${panelId}-${v.version}`} hidden={reading !== v.id}>
                          {reading === v.id ? (
                            <blockquote aria-label={`Text of version ${v.version}`} style={{ whiteSpace: "pre-line", margin: "8px 0" }}>
                              {v.title ? <strong>{v.title}</strong> : null}
                              <div>{v.body}</div>
                            </blockquote>
                          ) : null}
                        </div>
                      </li>
                    ))}
                  </ol>
                </>
              )
            }
          </StateView>
        ) : null}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Subprocessors
// ---------------------------------------------------------------------------

/** The server returns the stored version rows; `snapshot` is the registry entry as it stood. */
type SubprocessorVersionRow = {
  id: string;
  version: number;
  changeSummary?: string | null;
  changeNote?: string | null;
  effectiveAtUtc?: string | null;
  effectiveAt?: string | null;
  createdAt?: string | null;
  snapshot?: {
    state?: string;
    region?: string;
    dataCategories?: string[];
    effectiveAtUtc?: string;
  } | null;
};

export function SubprocessorVersionHistory({
  subprocessorId,
  name,
  panelId,
  open,
}: {
  subprocessorId: string;
  name: string;
  panelId: string;
  open: boolean;
}) {
  const [revision, setRevision] = useState(0);
  const state = useVersions<SubprocessorVersionRow>(
    `/v1/trust/subprocessors/${encodeURIComponent(subprocessorId)}/versions`,
    open,
    revision,
    "versions",
    "The change history could not be loaded.",
  );
  if (!open) return null;
  return (
    <div id={panelId} data-subprocessor-history={subprocessorId} style={{ overflowWrap: "anywhere" }}>
      <StateView state={state} retry={() => setRevision((v) => v + 1)} retryLabel="Retry change history">
        {(rows) =>
          rows.length === 0 ? (
            <p>No change history is recorded for {name}.</p>
          ) : (
            <ol aria-label={`Change history for ${name}`} style={{ display: "grid", gap: 10, paddingInlineStart: 20 }}>
              {newestFirst(rows).map((v) => {
                const effective = v.snapshot?.effectiveAtUtc ?? v.effectiveAtUtc ?? v.effectiveAt ?? null;
                const categories = v.snapshot?.dataCategories ?? [];
                return (
                  <li key={v.id} data-subprocessor-version-row={v.version}>
                    <strong>Version {v.version}</strong>
                    {v.snapshot?.state ? ` · ${identifierLabel(v.snapshot.state)}` : ""}
                    {effective ? ` · Effective ${formatUserDate(effective)}` : ""}
                    <div>{v.changeSummary || v.changeNote || "No change summary was recorded."}</div>
                    <small>
                      {v.snapshot?.region ? `Region: ${v.snapshot.region}` : "Region not recorded"}
                      {" · Data categories: "}
                      {categories.length > 0 ? categories.map((c) => identifierLabel(c)).join(", ") : "not recorded"}
                    </small>
                  </li>
                );
              })}
            </ol>
          )
        }
      </StateView>
    </div>
  );
}
