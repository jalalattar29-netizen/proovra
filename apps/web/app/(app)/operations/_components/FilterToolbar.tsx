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

import * as React from "react";

import { AppListbox } from "../../../../components/app-primitives/AppListbox";
import {
  INCIDENT_CATEGORIES,
  INCIDENT_SEVERITIES,
  INCIDENT_STATUSES,
  type AssignableOperator,
} from "../_lib/types";
import { ANY, type FilterState } from "../_lib/filters";
import {
  CATEGORY_LABEL,
  SEVERITY_VOCABULARY,
  SORT_LABEL,
  SORT_VALUES,
  STATUS_VOCABULARY,
  type SortValue,
} from "../_lib/vocabulary";
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
}) {
  const ids = React.useId();
  const labelId = (k: string) => `${ids}-${k}`;

  const statusOptions = [
    { value: ANY, label: "Any status" },
    ...INCIDENT_STATUSES.map((s) => ({
      value: s as string,
      label: STATUS_VOCABULARY[s].label,
    })),
  ];

  const severityOptions = [
    { value: ANY, label: "Any severity" },
    // Most severe first: a filter list is scanned, and the value an operator
    // reaches for on a busy queue is Critical.
    ...[...INCIDENT_SEVERITIES].reverse().map((s) => ({
      value: s as string,
      label: SEVERITY_VOCABULARY[s].label,
    })),
  ];

  const categoryOptions = [
    { value: ANY, label: "Any source" },
    ...INCIDENT_CATEGORIES.map((c) => ({
      value: c as string,
      label: CATEGORY_LABEL[c],
    })),
  ];

  const ownerOptions = [
    { value: "any", label: "Anyone" },
    { value: "me", label: "Assigned to me" },
    { value: "unassigned", label: "Unassigned" },
    ...operators.map((o) => ({
      value: o.userId,
      label: o.displayName?.trim() || o.email?.trim() || o.userId.slice(0, 8),
      description: o.role,
    })),
  ];

  const sortOptions = SORT_VALUES.map((s) => ({
    value: s as string,
    label: SORT_LABEL[s],
  }));

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
            value={filters.q}
            onChange={(e) => onChange({ q: e.target.value })}
            placeholder="Search conditions"
            aria-label="Search operational conditions"
            data-ops-search
          />
        </div>

        <div className="opsw-toolbar__filter">
          <span className="app-visually-hidden" id={labelId("status")}>
            Filter by lifecycle status
          </span>
          <AppListbox
            value={filters.status || ANY}
            options={statusOptions}
            ariaLabelledby={labelId("status")}
            disabled={busy}
            onChange={(v) =>
              onChange({ status: v === ANY ? "" : (v as FilterState["status"]) })
            }
          />
        </div>

        <div className="opsw-toolbar__filter">
          <span className="app-visually-hidden" id={labelId("severity")}>
            Filter by severity
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
            Filter by the part of the product that produced the condition
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
              Filter by who owns the condition
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

        <div className="opsw-toolbar__filter opsw-toolbar__filter--sort">
          <span className="app-visually-hidden" id={labelId("sort")}>
            Sort conditions
          </span>
          <AppListbox
            value={filters.sort}
            options={sortOptions}
            ariaLabelledby={labelId("sort")}
            disabled={busy}
            onChange={(v) => onChange({ sort: v as SortValue })}
          />
        </div>
      </div>

      <div className="opsw-resultbar">
        <span className="opsw-resultbar__count" data-ops-result-summary>
          {resultSummary}
        </span>
        {showClear ? (
          <button
            type="button"
            className="app-ghost-action"
            onClick={onClear}
            data-ops-clear-filters
          >
            Clear filters
          </button>
        ) : null}
      </div>
    </div>
  );
}

export default FilterToolbar;
