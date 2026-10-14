"use client";

/**
 * Operations workbench — search and filters.
 *
 * ---------------------------------------------------------------------------
 * NO NATIVE SELECTS ON THIS ROUTE
 * ---------------------------------------------------------------------------
 * The production console rendered `FilterBar.Select`, which is a native
 * `<select>`. A native option list opens the OS popup: it cannot be styled to
 * match the surface around it, it cannot be positioned out of a clipping
 * ancestor, and its keyboard behaviour cannot be audited by this repository's
 * tests. That is why Status and Severity looked like controls from a different
 * product than the table beneath them.
 *
 * Every control here is the canonical `AppListbox` on the shared anchored
 * overlay — the same one Intake Links, Evidence, Cases and Search use — so the
 * popup escapes the toolbar's stacking context through a portal and cannot be
 * clipped by the panel it sits in.
 *
 * ---------------------------------------------------------------------------
 * A CONTROL WITH NOTHING TO CHOOSE IS NOT RENDERED
 * ---------------------------------------------------------------------------
 * The Owner filter appears only where ownership is a real axis — a workspace
 * with more than one eligible operator. That is a server-projected count, not
 * a plan name and not the caller's own assign capability: a read-only viewer
 * in a shared workspace needs to filter by owner and will never hold
 * OPERATIONS_ASSIGN.
 */

import { useDebouncedSearchInput } from "../../../../lib/useDebouncedSearchInput";
import * as React from "react";

import { AppListbox } from "../../../../components/app-primitives/AppListbox";
import {
  INCIDENT_CATEGORIES,
  INCIDENT_SEVERITIES,
  INCIDENT_STATUSES,
  type AssignableOperator,
} from "../_lib/types";
import { ANY, type FilterState } from "../_lib/filters";
import { SORT_VALUES, type SortValue } from "../_lib/vocabulary";
import { useOpsCopy } from "../_lib/copy";
import { IconSearch } from "./icons";

export function FilterToolbar({
  filters,
  onChange,
  onClear,
  showClear,
  resultSummary,
  showOwnerFilter,
  operators,
  busy,
  showSort = true,
}: {
  filters: FilterState;
  onChange: (patch: Partial<FilterState>) => void;
  onClear: () => void;
  showClear: boolean;
  resultSummary: React.ReactNode;
  showOwnerFilter: boolean;
  /**
   * Named operators, when the caller may enumerate them. A viewer gets an
   * empty list and still gets Anyone / Me / Unassigned, which is the part of
   * the filter that does not require knowing who anybody is.
   */
  operators: ReadonlyArray<AssignableOperator>;
  busy: boolean;
  /**
   * Whether the sort control applies to what is on screen. The grouped view is
   * ordered by the server's grouping, not by this control, so there it is
   * not rendered at all — a control that changes nothing, or that silently
   * hides the default sections, is worse than none (2026-10-12).
   */
  showSort?: boolean;
}) {
  const ids = React.useId();
  const labelId = (k: string) => `${ids}-${k}`;
  const copy = useOpsCopy();

  /*
   * THE LIFECYCLE FILTER (2026-10-14).
   *
   * "All" is the DEFAULT and is first: every lifecycle state, history
   * included, so nothing is withheld by a filter the operator cannot see —
   * and the result count says "all statuses" beside it. "Unresolved" is the
   * canonical set every KPI counts (open, acknowledged or silenced); each
   * card still opens the list with exactly that predicate. Then the four
   * stored states, in lifecycle order. SUPPRESSED is offered as what it
   * means here: silenced notifications, still monitored.
   *
   * The PRESENTATION (flat list or grouped) is a separate control and never
   * changes which statuses are selected.
   */
  const statusLabel = (s: (typeof INCIDENT_STATUSES)[number]): string =>
    s === "SUPPRESSED" ? copy.statusSilencedOption : copy.status[s].label;
  const LIFECYCLE_ORDER = ["OPEN", "ACKNOWLEDGED", "SUPPRESSED", "RESOLVED"] as const;
  const statusOptions = [
    { value: "ALL", label: copy.statusAll },
    { value: "UNRESOLVED", label: copy.statusUnresolved },
    ...LIFECYCLE_ORDER.filter((s) => (INCIDENT_STATUSES as readonly string[]).includes(s)).map(
      (s) => ({ value: s as string, label: statusLabel(s) }),
    ),
  ];

  const severityOptions = [
    { value: ANY, label: copy.anySeverity },
    // Most severe first: a filter list is scanned, and the value an operator
    // reaches for on a busy queue is Critical.
    ...[...INCIDENT_SEVERITIES].reverse().map((s) => ({
      value: s as string,
      label: copy.severity[s].label,
    })),
  ];

  const categoryOptions = [
    { value: ANY, label: copy.anySource },
    ...INCIDENT_CATEGORIES.map((c) => ({
      value: c as string,
      label: copy.category[c],
    })),
  ];

  const ownerOptions = [
    { value: "any", label: copy.ownerAnyone },
    { value: "me", label: copy.ownerMe },
    { value: "unassigned", label: copy.ownerUnassigned },
    ...operators.map((o) => ({
      value: o.userId,
      label: o.displayName?.trim() || o.email?.trim() || o.userId.slice(0, 8),
      description: o.role,
    })),
  ];

  const sortOptions = SORT_VALUES.map((s) => ({
    value: s as string,
    label: copy.sort[s],
  }));

  // The input types locally; the URL write (and, on Operations, the incident
  // fetch keyed on it) is debounced. See useDebouncedSearchInput.
  const search = useDebouncedSearchInput(filters.q, (q) => onChange({ q }));

  return (
    <div className="app-section-stack">
      <div className="opsw-toolbar" data-ops-controls>
        <div className="app-search-field opsw-toolbar__search">
          <span className="app-search-icon">
            <IconSearch size={16} />
          </span>
          <input
            type="search"
            className="app-search-input"
            value={search.value}
            onChange={(e) => search.onChange(e.target.value)}
            placeholder={copy.filterSearchPlaceholder}
            aria-label={copy.filterSearchLabel}
            data-ops-search
          />
        </div>

        <div className="opsw-toolbar__filter">
          <span className="app-visually-hidden" id={labelId("status")}>
            {copy.filterStatusLabel}
          </span>
          <AppListbox
            value={filters.status || "ALL"}
            options={statusOptions}
            ariaLabelledby={labelId("status")}
            disabled={busy}
            onChange={(v) => onChange({ status: v as FilterState["status"] })}
          />
        </div>

        <div className="opsw-toolbar__filter">
          <span className="app-visually-hidden" id={labelId("severity")}>
            {copy.filterSeverityLabel}
          </span>
          <AppListbox
            value={filters.severity || ANY}
            options={severityOptions}
            ariaLabelledby={labelId("severity")}
            disabled={busy}
            onChange={(v) =>
              onChange({
                severity: v === ANY ? "" : (v as FilterState["severity"]),
              })
            }
          />
        </div>

        <div className="opsw-toolbar__filter">
          <span className="app-visually-hidden" id={labelId("category")}>
            {copy.filterCategoryLabel}
          </span>
          <AppListbox
            value={filters.category || ANY}
            options={categoryOptions}
            ariaLabelledby={labelId("category")}
            disabled={busy}
            onChange={(v) =>
              onChange({
                category: v === ANY ? "" : (v as FilterState["category"]),
              })
            }
          />
        </div>

        {showOwnerFilter ? (
          <div className="opsw-toolbar__filter" data-ops-owner-filter>
            <span className="app-visually-hidden" id={labelId("owner")}>
              {copy.filterOwnerLabel}
            </span>
            <AppListbox
              value={filters.owner}
              options={ownerOptions}
              ariaLabelledby={labelId("owner")}
              disabled={busy}
              onChange={(v) => onChange({ owner: v })}
            />
          </div>
        ) : null}

        {showSort ? (
          <div className="opsw-toolbar__filter opsw-toolbar__filter--sort" data-ops-sort>
            <span className="app-visually-hidden" id={labelId("sort")}>
              {copy.filterSortLabel}
            </span>
            <AppListbox
              value={filters.sort}
              options={sortOptions}
              ariaLabelledby={labelId("sort")}
              disabled={busy}
              onChange={(v) => onChange({ sort: v as SortValue })}
            />
          </div>
        ) : null}
      </div>

      <div className="opsw-resultbar">
        <span className="opsw-resultbar__count" data-ops-result-summary>
          {resultSummary}
        </span>
        {/* SLA POSTURE.
            Rendered from the SAME closed vocabulary the server enumerates, so
            a filter can never ask for a state the projection cannot produce —
            which would return an empty queue that reads as good news. */}
        <div className="opsw-toolbar__filter">
          <span className="app-visually-hidden" id={labelId("sla")}>
            {copy.filterSlaLabel}
          </span>
          <AppListbox
            value={filters.sla}
            onChange={(v) => onChange({ sla: v as FilterState["sla"] })}
            disabled={busy}
            ariaLabelledby={labelId("sla")}
            options={[
              { value: "", label: copy.anyCommitment },
              { value: "BREACHED", label: copy.sla.BREACHED },
              { value: "AT_RISK", label: copy.sla.AT_RISK },
              { value: "ON_TRACK", label: copy.sla.ON_TRACK },
              /* "Owned" (ACKNOWLEDGED) and "Resolved" USED TO SIT HERE, and
                 neither is a time commitment.
                 They are lifecycle states that the SLA projection also reports
                 — ownership belongs to the owner filter, resolution to the
                 Status filter and the Resolved summary card. Offering
                 "Resolved" here was worse than redundant: it asked the
                 lifecycle question on the commitment axis, and combined with
                 an unresolved lifecycle it returned nothing, which reads as
                 "there are none" rather than as a filter asking the wrong
                 axis. This dropdown now offers only states a commitment can
                 actually be in. */
              { value: "UNTRACKED_LEGACY", label: copy.sla.UNTRACKED_LEGACY },
              { value: "NOT_APPLICABLE", label: copy.sla.NOT_APPLICABLE },
            ]}
            data-ops-filter="sla"
          />
        </div>
        {showClear ? (
          <button
            type="button"
            className="app-ghost-action"
            onClick={onClear}
            data-ops-clear-filters
          >
            {copy.clearFilters}
          </button>
        ) : null}
      </div>
    </div>
  );
}

export default FilterToolbar;
