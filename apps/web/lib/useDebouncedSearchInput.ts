"use client";

import * as React from "react";

/**
 * A search box that types at the speed of the keyboard, not the speed of the
 * thing it filters.
 *
 * WHY THIS EXISTS
 * ---------------------------------------------------------------------------
 * Intake Links and Operations both bound their search input's `value` directly
 * to the APPLIED filter state, and both applied that state by writing the URL.
 * So every keystroke was a `router.replace()` — an App Router navigation with
 * an RSC round trip — and on Operations the URL is also what the incident fetch
 * is keyed on, so every character additionally issued
 * `GET /v1/ops/incidents`. The character only appeared once all of that had
 * come back and re-rendered the page. That is the lag.
 *
 * The two concerns are separated here rather than in each page, because they
 * had the same defect and a patch in each is two things to keep in step:
 *
 *   value     what the user has typed. Local state, updated synchronously, so
 *             the input is never waiting on anything.
 *   commit    the applied query. Debounced, so the URL write and whatever it
 *             triggers happen once the typing settles.
 *
 * 250ms matches the debounce already used by the Reports and Cases indexes;
 * it is the repository's existing convention, not a new number.
 *
 * EXTERNAL CHANGES STILL WIN. `applied` is watched, so "Clear filters", a saved
 * view, or a back/forward navigation replaces what is in the box. Without that
 * the input would keep showing a query the page is no longer running — the
 * mirror image of the bug it fixes.
 */
export function useDebouncedSearchInput(
  applied: string,
  commit: (next: string) => void,
  delayMs = 250,
): {
  value: string;
  onChange: (next: string) => void;
} {
  const [value, setValue] = React.useState(applied);

  // The latest committer, read (not depended on) by the timer below — an
  // inline `onChange={(e) => onChange({ q: e.target.value })}` is a new
  // function every render, and depending on it would restart the debounce on
  // every unrelated re-render and never fire.
  const commitRef = React.useRef(commit);
  commitRef.current = commit;

  // What we last sent. Guards both directions: it stops the debounce from
  // re-committing a value that already round-tripped, and it tells the sync
  // below whether an incoming `applied` is our own echo or a real external
  // change.
  const lastCommitted = React.useRef(applied);

  React.useEffect(() => {
    if (applied !== lastCommitted.current) {
      lastCommitted.current = applied;
      setValue(applied);
    }
  }, [applied]);

  React.useEffect(() => {
    if (value === lastCommitted.current) return;
    const timer = setTimeout(() => {
      lastCommitted.current = value;
      commitRef.current(value);
    }, delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);

  return { value, onChange: setValue };
}
