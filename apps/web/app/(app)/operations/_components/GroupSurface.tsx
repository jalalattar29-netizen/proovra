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
 * them. This does. One row per SOURCE, carrying the quantity an operator acts
 * on — how many real things are behind it, in that source's own unit — and a
 * way into the individual records underneath.
 *
 * The title is COUNT-FREE and comes from the source contract, so it says what
 * the row IS and never goes out of date. The numbers live beside it, labelled,
 * where they can be refreshed.
 *
 * ---------------------------------------------------------------------------
 * WHAT IT IS NOT
 * ---------------------------------------------------------------------------
 * Not a second queue, not an Enterprise mode, and not a plan fork. Personal,
 * Team, Organization and Enterprise all render this; a group of one reads
 * exactly like the row it replaces, because the label does not change with the
 * member count. The flat list is still one toggle away, and the drill-down
 * reaches every individual condition, because a grouped view that HID records
 * would be the same defect with better manners.
 */

import * as React from "react";

import { AppStatusBadge } from "../../../../components/app-primitives/AppStatusBadge";
import { AppStatusText } from "../../../../components/app-primitives/AppStatusText";
import { describeDuration, describeRelativeTime } from "../../../../lib/relative-time";
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

/**
 * WHAT THE AFFECTED COUNT IS CALLED, IN THIS SOURCE'S OWN UNIT.
 *
 * ---------------------------------------------------------------------------
 * WHY IT IS NOT ALWAYS "AFFECTED RECORDS"
 * ---------------------------------------------------------------------------
 * The renderer used to hard-code "records" and take the unit only as a
 * fallback that never fired, because the SERVER hard-coded it too. So the
 * retry-storm group — whose members are recurring CONDITIONS, and whose
 * threshold is stated in conditions — read "36 affected records" about
 * thirty-six things that are not records. An operator who went looking for
 * thirty-six affected evidence records would have found none.
 *
 * "Repeatedly observed" is the exact meaning of that source's count: those
 * conditions are the ones whose occurrence counts crossed the storm
 * threshold, which is a different fact from being affected by anything.
 */
function describeAffected(count: number, unit: string | null): string {
  const n = formatCount(count);
  if (unit === "conditions") return `${n} repeatedly observed conditions`;
  if (unit === "workflows") return `${n} affected workflows`;
  if (unit === "items") return `${n} affected items`;
  return `${n} affected records`;
}

/**
 * The sentence an AGE-based group leads with.
 *
 * Its metric is an elapsed span, not a population, and it used to be rendered
 * by the same code path as a backlog — so a sampler fifteen hours behind was
 * described as "902 affected records", after having been described in its own
 * title as "(902m)". Neither is a thing an operator can read at a glance.
 */
function describeAge(group: IncidentGroup): string | null {
  if (group.durationSeconds == null) return null;
  const span = describeDuration(group.durationSeconds);
  if (span === "—") return null;
  return group.sourceId === "platform.telemetry_stale"
    ? `Last telemetry sample ${span} ago`
    : `Last observed ${span} ago`;
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
        const age = describeAge(g);
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
              {/*
                TWO COLUMNS, NOT THREE ITEMS IN A ROW.

                The severity and the title are ONE thing — what this group is —
                so they share the first column and the status owns the second.
                It was three flex siblings with `margin-inline-start: auto` on
                the status, which reads as correct and was not: the parent
                button is a column flex with `align-items: flex-start`, so this
                head shrink-wrapped to its content and the auto margin had no
                free space to absorb. Measured, the status began 8px after the
                title's right edge and the head's own right edge was the
                status's — the row was 457px of content in a 1,120px row.

                A grid cannot express that mistake. The second track is sized to
                the status and the first takes everything else, so the status
                lands on the same x whether the title is two words or two
                hundred characters.
              */}
              <span className="opsw-group__head">
                <span className="opsw-group__lead">
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

                <AppStatusText
                  tone={status.tone}
                  className="opsw-group__status"
                  data-ops-group-status={g.statusPosture}
                >
                  {status.label}
                </AppStatusText>
              </span>

              <span className="opsw-group__meta">
                <span className="opsw-group__source">
                  {categoryLabel(g.category)}
                </span>

                {/*
                  ONE QUANTITY IN THE ROW, AND IT IS THE ONE THAT MEANS
                  SOMETHING.

                  A group can carry three numbers — conditions, affected
                  things, observations — and this row used to print the first
                  two side by side under labels that were nearly identical.
                  For the integrity groups they are the SAME number ("34
                  conditions · 34 affected records"), so the row spent its
                  width saying one fact twice; for an aggregate group they were
                  1 and 26, which looks like a contradiction until you have
                  read both labels carefully.

                  The row leads with the quantity an operator acts on: how many
                  real things are behind this. The condition count appears here
                  only when there IS no affected count to give, and is always
                  available in the Inspector.
                */}
                {age != null ? (
                  <>
                    <span aria-hidden="true">·</span>
                    <span
                      className="opsw-group__age"
                      data-ops-group-duration={g.durationSeconds ?? undefined}
                      title={
                        g.lastObservedAtUtc
                          ? formatUserDateTime(g.lastObservedAtUtc)
                          : undefined
                      }
                    >
                      {age}
                    </span>
                  </>
                ) : g.affectedRecordCount != null ? (
                  <>
                    <span aria-hidden="true">·</span>
                    <span
                      className="opsw-group__affected"
                      data-ops-group-affected={g.affectedRecordCount}
                      data-ops-group-affected-unit={g.affectedUnit ?? "records"}
                    >
                      {describeAffected(g.affectedRecordCount, g.affectedUnit)}
                    </span>
                  </>
                ) : (
                  <>
                    <span aria-hidden="true">·</span>
                    <span
                      className="opsw-group__conditions"
                      data-ops-group-conditions={g.conditionCount}
                    >
                      {g.conditionCount === 1
                        ? "1 condition"
                        : `${formatCount(g.conditionCount)} conditions`}
                    </span>
                  </>
                )}

                {/*
                  THE THRESHOLD, SEPARATELY.

                  "26 affected records" is not actionable without the number it
                  is being compared against, and that number used to exist only
                  inside the condition's own summary paragraph.
                */}
                {g.metric && g.metric.contract === "AGGREGATE_THRESHOLD" ? (
                  <>
                    <span aria-hidden="true">·</span>
                    <span
                      className="opsw-group__threshold"
                      data-ops-group-threshold={g.metric.thresholdValue}
                    >
                      threshold {g.metric.thresholdValue.toLocaleString("en-US")}
                    </span>
                  </>
                ) : null}

                {/*
                  A METRIC WHOSE LAST OBSERVATION FAILED SAYS SO. Presenting
                  the previous values as current is the quiet version of a
                  false all-clear.
                */}
                {g.metric?.stale ? (
                  <>
                    <span aria-hidden="true">·</span>
                    <span
                      className="opsw-group__stale"
                      data-ops-group-metric-stale="true"
                    >
                      last confirmed {describeRelativeTime(g.metric.observedAtUtc)}
                    </span>
                  </>
                ) : null}

                <span aria-hidden="true">·</span>
                {/*
                  STATUS IS COLOURED TEXT, NOT A SECOND CAPSULE.

                  The row already carries one filled capsule — the severity,
                  which is what an operator triages by. A second capsule beside
                  it made every row two competing chips of colour with nothing
                  for the eye to land on, and the one that mattered was not
                  obviously the one on the left. The same primitive the flat
                  table uses: same tones, same words, no box.
                */}
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
