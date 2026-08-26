"use client";

/**
 * Operations workbench — THE GROUPED QUEUE.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS
 * ---------------------------------------------------------------------------
 * A workspace with five thousand records whose timestamping failed had five
 * thousand top-level rows. Every one of them said the same sentence, carried
 * the same severity and needed the same fix, and no operator could find
 * anything else in the queue — the one genuinely different condition sat at
 * position 3,847.
 *
 * The server has computed these groups for a release and nothing rendered
 * them. This does. One row per SOURCE, carrying the two numbers that are
 * actually different — how many conditions, and how many records they stand
 * for — and a way into the individual records underneath.
 *
 * ---------------------------------------------------------------------------
 * WHAT IT IS NOT
 * ---------------------------------------------------------------------------
 * Not a second queue, not an Enterprise mode, and not a plan fork. Personal,
 * Team, Organization and Enterprise all render this; a group of one shows its
 * own condition's title and reads exactly like the row it replaces. The flat
 * list is still one toggle away, and the drill-down reaches every individual
 * condition, because a grouped view that HID records would be the same defect
 * with better manners.
 */

import * as React from "react";

import { AppStatusBadge } from "../../../../components/app-primitives/AppStatusBadge";
import { describeRelativeTime } from "../../../../lib/relative-time";
import { formatUserDateTime } from "../../../../lib/date";
import type {
  IncidentGroup,
  IncidentSeverity,
  IncidentStatus,
} from "../_lib/types";
import { SEVERITY_VOCABULARY, STATUS_VOCABULARY, categoryLabel } from "../_lib/vocabulary";

/**
 * A bounded rendering of a count.
 *
 * The same cap the individual rows use, and for the same reason: an exact
 * five-figure number is wrong by the time it is read and makes every row a
 * different width. The exact figure is in the Inspector.
 */
const DISPLAY_CAP = 2000;

function formatCount(value: number): string {
  if (value > DISPLAY_CAP) return `${DISPLAY_CAP.toLocaleString("en-US")}+`;
  return value.toLocaleString("en-US");
}

export function GroupSurface({
  groups,
  openGroupKey,
  onOpen,
}: {
  groups: ReadonlyArray<IncidentGroup>;
  /** The group currently in the inspector, highlighted in the list. */
  openGroupKey: string | null;
  onOpen: (groupKey: string) => void;
}) {
  return (
    <ul className="opsw-groups" data-ops-groups>
      {groups.map((g) => {
        const severity =
          SEVERITY_VOCABULARY[g.severity as IncidentSeverity] ?? SEVERITY_VOCABULARY.INFO;
        const status =
          STATUS_VOCABULARY[g.statusPosture as IncidentStatus] ?? STATUS_VOCABULARY.OPEN;
        return (
          <li
            key={g.groupKey}
            className="opsw-group"
            data-ops-group={g.groupKey}
            data-ops-group-source={g.sourceId}
            data-ops-group-open={g.groupKey === openGroupKey ? "true" : "false"}
          >
            <button
              type="button"
              className="opsw-group__open"
              onClick={() => onOpen(g.groupKey)}
              data-ops-group-open-button={g.groupKey}
            >
              <span className="opsw-group__head">
                <AppStatusBadge
                  tone={severity.tone}
                  fill="solid"
                  data-ops-group-severity={g.severity}
                >
                  {severity.label}
                </AppStatusBadge>
                <span className="app-table__primary opsw-group__title">
                  {g.title}
                </span>
              </span>

              <span className="opsw-group__meta">
                <span className="opsw-group__source">
                  {categoryLabel(g.category)}
                </span>

                {/*
                  THE TWO NUMBERS, SAID DIFFERENTLY.

                  `conditionCount` is how many incidents are in the group.
                  `affectedRecordCount` is how many real records they stand
                  for. For per-record integrity groups they agree; for an
                  aggregate group they are 1 and 26. Rendering either under the
                  other's name is how a queue lies, so both are labelled.
                */}
                <span aria-hidden="true">·</span>
                <span
                  className="opsw-group__conditions"
                  data-ops-group-conditions={g.conditionCount}
                >
                  {g.conditionCount === 1
                    ? "1 condition"
                    : `${formatCount(g.conditionCount)} conditions`}
                </span>

                {g.affectedRecordCount != null ? (
                  <>
                    <span aria-hidden="true">·</span>
                    <span
                      className="opsw-group__affected"
                      data-ops-group-affected={g.affectedRecordCount}
                    >
                      {formatCount(g.affectedRecordCount)} affected{" "}
                      {g.metric?.unit ?? "records"}
                    </span>
                  </>
                ) : null}

                <span aria-hidden="true">·</span>
                <AppStatusBadge
                  tone={status.tone}
                  data-ops-group-status={g.statusPosture}
                >
                  {status.label}
                </AppStatusBadge>

                {g.assignedCount > 0 ? (
                  <>
                    <span aria-hidden="true">·</span>
                    <span className="opsw-group__owned">
                      {g.assignedCount} owned
                    </span>
                  </>
                ) : null}

                <span aria-hidden="true">·</span>
                <span
                  className="opsw-group__activity"
                  title={formatUserDateTime(g.latestActivityAtUtc)}
                >
                  last seen {describeRelativeTime(g.latestActivityAtUtc)}
                </span>
              </span>

              {/*
                The failure-class breakdown, when the source has one. Purely
                DESCRIPTIVE — "of these 34, 30 are provider timeouts" — and it
                asserts nothing about why. A record whose reason nobody could
                classify is counted as unclassified rather than guessed into a
                bucket.
              */}
              {g.failureGroups.length > 1 ? (
                <span className="opsw-group__classes">
                  {g.failureGroups.map((f) => (
                    <span key={f.failureClass} className="opsw-group__class">
                      {f.count} {f.label.toLowerCase()}
                    </span>
                  ))}
                </span>
              ) : null}
            </button>
          </li>
        );
      })}
    </ul>
  );
}

export default GroupSurface;
