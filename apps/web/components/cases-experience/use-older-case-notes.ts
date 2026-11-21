"use client";

/**
 * PRO-K1-07 — "Load older notes" for both case pages.
 *
 * Starts from the matter workspace's newest page and its
 * `caseCommentsNextCursor`, then follows GET /v1/cases/:id/comments?cursor=
 * one page at a time. The server applies the note read rule on every page; this
 * hook only appends what it is given (de-duplicated by id) and forgets the
 * older pages whenever the workspace reloads, so a reload never shows a stale
 * mix.
 */
import { useCallback, useEffect, useMemo, useState } from "react";

import { apiFetch } from "../../lib/api";
import { toSafeUserError } from "../../lib/feedback/toSafeUserError";
import { caseNotesPage, type CaseNotesPage } from "./case-notes-page";

export type CaseNoteItem = {
  id: string;
  authorUserId: string;
  body: string;
  visibility: string;
  createdAt: string;
  resolvedAtUtc: string | null;
  resolvedByUserId?: string | null;
};

type Section<T extends CaseNoteItem> = {
  caseComments: ReadonlyArray<T>;
  caseCommentsTotal?: number;
  caseCommentsTruncated?: boolean;
  caseCommentsNextCursor?: string | null;
};

export function useOlderCaseNotes<T extends CaseNoteItem>(
  caseId: string,
  section: Section<T> | null | undefined,
): {
  notes: ReadonlyArray<T>;
  page: CaseNotesPage;
  loadOlder: () => Promise<void>;
  loading: boolean;
  error: string | null;
} {
  const first = useMemo<ReadonlyArray<T>>(() => section?.caseComments ?? [], [section]);
  const [older, setOlder] = useState<T[]>([]);
  const [cursor, setCursor] = useState<string | null>(section?.caseCommentsNextCursor ?? null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setOlder([]);
    setCursor(section?.caseCommentsNextCursor ?? null);
    setError(null);
  }, [caseId, section]);

  const notes = useMemo(() => {
    const seen = new Set(first.map((n) => n.id));
    return [...first, ...older.filter((n) => !seen.has(n.id))];
  }, [first, older]);

  const loadOlder = useCallback(async () => {
    if (!cursor || loading) return;
    setLoading(true);
    setError(null);
    try {
      const body = (await apiFetch(
        `/v1/cases/${encodeURIComponent(caseId)}/comments?cursor=${encodeURIComponent(cursor)}`,
      )) as { comments?: T[]; nextCursor?: string | null };
      const incoming = Array.isArray(body.comments) ? body.comments : [];
      setOlder((prev) => {
        const seen = new Set(prev.map((n) => n.id));
        return [...prev, ...incoming.filter((n) => !seen.has(n.id))];
      });
      setCursor(typeof body.nextCursor === "string" ? body.nextCursor : null);
    } catch (err) {
      setError(toSafeUserError(err, { message: "Could not load older notes." }).message);
    } finally {
      setLoading(false);
    }
  }, [caseId, cursor, loading]);

  const page = section
    ? caseNotesPage(section, "caseCommentsNextCursor" in section ? { shown: notes.length, canLoadOlder: cursor !== null } : undefined)
    : caseNotesPage(null);
  return { notes, page, loadOlder, loading, error };
}
