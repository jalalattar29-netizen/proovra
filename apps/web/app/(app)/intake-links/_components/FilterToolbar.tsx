"use client";

/**
 * Intake links — search + filter toolbar.
 *
 * Four canonical `AppListbox` controls and one canonical search field. There
 * is no native `<select>` on this surface: a native option list renders the OS
 * popup, which cannot be styled, cannot be positioned out of a clipping
 * ancestor, and cannot be audited for keyboard behaviour.
 *
 * Every listbox carries a visible label id (`aria-labelledby`) so its
 * accessible name is the same words the operator reads.
 */

import { useDebouncedSearchInput } from "../../../../lib/useDebouncedSearchInput";
import * as React from "react";

import { AppListbox } from "../../../../components/app-primitives/AppListbox";
import {
  CHANNEL_LABEL,
  CHANNEL_WIRE_VALUES,
  DELIVERY_FILTER_LABEL,
  DELIVERY_FILTER_WIRE_VALUES,
  LINK_STATE_VOCABULARY,
  SORT_LABEL,
  SORT_WIRE_VALUES,
  type SortWireValue,
  type ChannelWireValue,
  type DeliveryFilterWireValue,
} from "../../../../lib/intake-links/vocabulary";
import {
  LIFECYCLE_FILTER_VALUES,
  type FilterState,
  type LifecycleFilterValue,
} from "../_lib/filters";
import { IconSearch } from "./icons";

const ANY = "__any__";

export function FilterToolbar({
  filters,
  onChange,
  onClear,
  showClear,
  resultSummary,
  pageSummary,
}: {
  filters: FilterState;
  onChange: (patch: Partial<FilterState>) => void;
  onClear: () => void;
  showClear: boolean;
  resultSummary: string;
  pageSummary: string | null;
}) {
  const ids = React.useId();
  const labelId = (k: string) => `${ids}-${k}`;

  const channelOptions = [
    { value: ANY, label: "Any channel" },
    ...CHANNEL_WIRE_VALUES.map((c) => ({
      value: c as string,
      label: CHANNEL_LABEL[c],
    })),
  ];

  // LABELS ONLY.
  //
  // The four lifecycle labels are self-evident ("Active", "Archived",
  // "Link disabled", "Expired"), so a sentence under each one made a
  // four-option filter three times taller than the three beside it and buried
  // the value the operator was looking for. The explanations still exist — the
  // KPI cards, the row chip titles and the disable confirmation all render them
  // where a consequence actually needs stating.
  const lifecycleOptions = [
    { value: ANY, label: "Any lifecycle" },
    ...LIFECYCLE_FILTER_VALUES.map((l) => ({
      value: l as string,
      label: LINK_STATE_VOCABULARY[l].label,
    })),
  ];

  const deliveryOptions = [
    { value: ANY, label: "Any delivery state" },
    ...DELIVERY_FILTER_WIRE_VALUES.map((d) => ({
      value: d as string,
      label: DELIVERY_FILTER_LABEL[d],
    })),
  ];

  const sortOptions = SORT_WIRE_VALUES.map((s) => ({
    value: s as string,
    label: SORT_LABEL[s],
  }));

  // The input types locally; the URL write (and, on Operations, the incident
  // fetch keyed on it) is debounced. See useDebouncedSearchInput.
  const search = useDebouncedSearchInput(filters.q, (q) => onChange({ q }));

  return (
    <div className="app-section-stack">
      <div className="ilk-toolbar" data-intake-links-controls>
        <div className="app-search-field ilk-toolbar__search">
          <span className="app-search-icon">
            <IconSearch size={16} />
          </span>
          <input
            type="search"
            className="app-search-input"
            value={search.value}
            onChange={(e) => search.onChange(e.target.value)}
            placeholder="Search by request, recipient, or link id"
            aria-label="Search intake links"
            data-intake-links-search
          />
        </div>

        <div className="ilk-toolbar__filter">
          <span className="app-visually-hidden" id={labelId("channel")}>
            Filter by delivery channel
          </span>
          <AppListbox
            value={filters.channel || ANY}
            options={channelOptions}
            ariaLabelledby={labelId("channel")}
            onChange={(v) =>
              onChange({ channel: v === ANY ? "" : (v as ChannelWireValue) })
            }
            className="ilk-listbox"
          />
        </div>

        <div className="ilk-toolbar__filter">
          <span className="app-visually-hidden" id={labelId("lifecycle")}>
            Filter by lifecycle
          </span>
          <AppListbox
            value={filters.lifecycle || ANY}
            options={lifecycleOptions}
            ariaLabelledby={labelId("lifecycle")}
            onChange={(v) =>
              onChange({
                lifecycle: v === ANY ? "" : (v as LifecycleFilterValue),
              })
            }
            className="ilk-listbox"
          />
        </div>

        <div className="ilk-toolbar__filter">
          <span className="app-visually-hidden" id={labelId("delivery")}>
            Filter by delivery state
          </span>
          <AppListbox
            value={filters.delivery || ANY}
            options={deliveryOptions}
            ariaLabelledby={labelId("delivery")}
            onChange={(v) =>
              onChange({
                delivery: v === ANY ? "" : (v as DeliveryFilterWireValue),
              })
            }
            className="ilk-listbox"
          />
        </div>

        <div className="ilk-toolbar__filter">
          <span className="app-visually-hidden" id={labelId("sort")}>
            Sort intake links
          </span>
          <AppListbox
            value={filters.sort}
            options={sortOptions}
            ariaLabelledby={labelId("sort")}
            onChange={(v) => onChange({ sort: v as SortWireValue })}
            renderValue={(opt) => `Sort: ${opt?.label ?? ""}`}
            className="ilk-listbox"
          />
        </div>

        {showClear ? (
          <button
            type="button"
            className="app-secondary-action"
            onClick={onClear}
            data-intake-links-clear
          >
            Clear filters
          </button>
        ) : null}
      </div>

      <p className="ilk-resultbar" data-intake-links-meta>
        <span className="ilk-resultbar__count">{resultSummary}</span>
        {pageSummary ? <span>{pageSummary}</span> : null}
      </p>
    </div>
  );
}

export default FilterToolbar;
