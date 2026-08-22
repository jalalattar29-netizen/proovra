"use client";

/**
 * Intake links — the seven-up KPI grid.
 *
 * Each card is a FILTER, not a slice of a pie: clicking one switches the
 * primary tab and clears the secondary dropdowns so the resulting table always
 * matches what the card promised. The counts are deliberately NOT mutually
 * exclusive (see `KPI_OVERLAP_NOTE` in the vocabulary), and the surface says so
 * in words underneath rather than letting the operator discover it by adding
 * the numbers up.
 *
 * Tone is a rail plus a value colour, never a saturated card fill, and never
 * the only carrier of meaning — every card keeps its text label and an
 * accessible description.
 */

import * as React from "react";

import {
  KPI_ORDER,
  KPI_OVERLAP_NOTE,
  KPI_VOCABULARY,
  type IntakeKpiKey,
} from "../../../../lib/intake-links/vocabulary";
import type { IntakeKpis } from "../../../../lib/intake-links/state-model";
import { intakeTabToTabParam, type TabParam } from "../_lib/filters";

export function KpiGrid({
  kpis,
  currentTab,
  onSelect,
}: {
  kpis: IntakeKpis;
  currentTab: TabParam;
  onSelect: (tab: TabParam) => void;
}) {
  const noteId = React.useId();
  return (
    <div>
      <ul className="ilk-kpis" data-intake-links-kpis aria-describedby={noteId}>
        {KPI_ORDER.map((key: IntakeKpiKey) => {
          const entry = KPI_VOCABULARY[key];
          const tab = intakeTabToTabParam(entry.tab);
          const isCurrent = currentTab === tab;
          const descId = `${noteId}-${key}`;
          return (
            <li key={key}>
              <button
                type="button"
                // The CANONICAL metric card, plus this route's tone hook.
                // `ilk-kpi` now carries only the tone mapping; the card itself
                // is one shared primitive, so Notifications and Intake Links
                // cannot drift into two metric-card designs.
                className="app-metric-card ilk-kpi"
                data-ilk-tone={entry.tone}
                data-intake-links-kpi={key}
                data-intake-links-kpi-tone={entry.tone}
                data-intake-links-kpi-tab={tab}
                data-intake-links-kpi-active={isCurrent ? "true" : "false"}
                aria-pressed={isCurrent}
                aria-describedby={descId}
                onClick={() => onSelect(tab)}
              >
                <span className="app-metric-card__value ilk-kpi__value">
                  {kpis[key]}
                </span>
                <span className="app-metric-card__label ilk-kpi__label">
                  {entry.label}
                </span>
                <span className="app-metric-card__meta ilk-kpi__meta" id={descId}>
                  {entry.explanation}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      <p className="ilk-kpis-note" id={noteId} data-intake-links-kpi-overlap-note>
        {KPI_OVERLAP_NOTE}
      </p>
    </div>
  );
}

export default KpiGrid;
