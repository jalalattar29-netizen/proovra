"use client";

/**
 * ONE PAGE AT A TIME, WITH A WAY BACK.
 *
 * =============================================================================
 * WHY THIS EXISTS
 * =============================================================================
 * Five admin tables asked the server for their cap — 100, 200 rows — and
 * rendered all of it. The sessions console measured nine screens tall on a
 * desktop and ten on a phone, and the cause was not styling: it was eighty-six
 * rows in one table. The server now pages those lists with a keyset cursor
 * (services/api/src/services/pagination/keyset-cursor.ts), and this is the
 * client half: the state that walks it and the control that drives it.
 *
 * =============================================================================
 * THE CURSOR IS OPAQUE
 * =============================================================================
 * The page never parses a cursor. It keeps the one the server handed it for
 * the NEXT page and a stack of the ones it used to reach the current page, so
 * "Previous" replays an earlier request rather than asking the server to walk
 * backwards — which a keyset cursor cannot do.
 *
 * =============================================================================
 * A CURSOR BELONGS TO ONE QUERY
 * =============================================================================
 * A cursor names a position in ONE ordered set. Change the filter, or the
 * workspace, and it names nothing. The hook takes a `scopeKey` — the caller's
 * filters and workspace joined into a string — and resets itself in the same
 * render the key changes, so the request effect that follows sees the new
 * filter AND page one together. Resetting in an effect instead would let one
 * request go out with the new filter and the old cursor, a page of the wrong
 * set, before the reset caught up.
 *
 * =============================================================================
 * TRUTHFULLY DISABLED
 * =============================================================================
 * "Next" is enabled only when the server said `hasMore`. Not when the page is
 * full — a collection whose size is exactly the page size would then offer a
 * Next that returns nothing, and an operator who presses it learns to distrust
 * the control. "Previous" is enabled only when there is a page to go back to.
 */

import { useCallback, useState, type CSSProperties } from "react";

import { Button } from "./Button";

export type CursorPagerState = {
  /** The cursor the CURRENT page was requested with; `null` on page one. */
  cursor: string | null;
  /** One-based, for display. */
  page: number;
  hasPrevious: boolean;
  /** Advance to the page the server named. A `null` cursor is a no-op. */
  next: (nextCursor: string | null) => void;
  previous: () => void;
  /** Back to page one. The scope key does this on its own; this is for a caller that must. */
  reset: () => void;
};

type Walk = {
  scope: string;
  cursor: string | null;
  /** The cursors of the pages BEFORE the current one, oldest first. */
  history: Array<string | null>;
};

export function useCursorPager(scopeKey: string): CursorPagerState {
  const [walk, setWalk] = useState<Walk>({
    scope: scopeKey,
    cursor: null,
    history: [],
  });

  // Derived-state reset, during render: React re-runs this component with
  // the new state before anything below it renders or any effect fires.
  if (walk.scope !== scopeKey) {
    setWalk({ scope: scopeKey, cursor: null, history: [] });
  }
  const current: Walk =
    walk.scope === scopeKey ? walk : { scope: scopeKey, cursor: null, history: [] };

  const next = useCallback(
    (nextCursor: string | null) => {
      if (!nextCursor) return;
      setWalk((w) => ({
        scope: scopeKey,
        cursor: nextCursor,
        history: [...(w.scope === scopeKey ? w.history : []), w.scope === scopeKey ? w.cursor : null],
      }));
    },
    [scopeKey],
  );

  const previous = useCallback(() => {
    setWalk((w) => {
      if (w.scope !== scopeKey || w.history.length === 0) return w;
      return {
        scope: scopeKey,
        cursor: w.history[w.history.length - 1] ?? null,
        history: w.history.slice(0, -1),
      };
    });
  }, [scopeKey]);

  const reset = useCallback(() => {
    setWalk({ scope: scopeKey, cursor: null, history: [] });
  }, [scopeKey]);

  return {
    cursor: current.cursor,
    page: current.history.length + 1,
    hasPrevious: current.history.length > 0,
    next,
    previous,
    reset,
  };
}

export type CursorPagerProps = {
  pager: CursorPagerState;
  /** The server's `nextCursor` for the page currently shown. */
  nextCursor: string | null;
  /** The server's `hasMore` for the page currently shown. */
  hasMore: boolean;
  /** A page request is in flight — both controls wait for it. */
  loading?: boolean;
  style?: CSSProperties;
  "data-testid"?: string;
};

const rowStyle: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 8,
  fontSize: 13,
  color: "var(--ink-secondary, #475569)",
};

export function CursorPager({
  pager,
  nextCursor,
  hasMore,
  loading = false,
  style,
  "data-testid": testId,
}: CursorPagerProps) {
  const canNext = hasMore && nextCursor !== null && !loading;
  const canPrevious = pager.hasPrevious && !loading;
  return (
    <div
      style={{ ...rowStyle, ...style }}
      data-testid={testId}
      data-ui-cursor-pager
      data-page={pager.page}
    >
      <Button
        variant="secondary"
        size="sm"
        onClick={pager.previous}
        disabled={!canPrevious}
        data-testid={testId ? `${testId}-previous` : undefined}
      >
        Previous
      </Button>
      <span style={{ minWidth: 56, textAlign: "center" }} aria-live="polite">
        Page {pager.page}
      </span>
      <Button
        variant="secondary"
        size="sm"
        onClick={() => pager.next(nextCursor)}
        disabled={!canNext}
        data-testid={testId ? `${testId}-next` : undefined}
      >
        Next
      </Button>
    </div>
  );
}

export default CursorPager;
