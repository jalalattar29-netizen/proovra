/**
 * Operations workbench — ONE row model, two renderers.
 *
 * The wide table and the narrow cards both read the result of `buildRowModel`.
 * Neither computes a label, a tone, a relative time or an action-eligibility
 * of its own, because the moment they do, the two widths start disagreeing:
 * the table says a condition is Acknowledged and the card still offers
 * Acknowledge, and only one of the two is ever noticed.
 */

import type { AppTone } from "../../../../components/app-primitives/AppStatusBadge";
import { describeDuration } from "../../../../lib/relative-time";

import type { Incident, OperationsCapabilities, SlaPosture } from "./types";
import {
  SEVERITY_VOCABULARY,
  STATUS_VOCABULARY,
  categoryLabel,
  slaBreachRecord,
  slaExplanation,
  slaLabel,
  slaTone,
} from "./vocabulary";

export type OwnerDisplay =
  | { kind: "unassigned" }
  | { kind: "self"; label: string }
  | { kind: "other"; label: string };

export type OperationsRowModel = {
  id: string;
  title: string;
  summary: string;

  severityLabel: string;
  severityTone: AppTone;
  severityExplanation: string;
  /** The raw token, for the `data-*` contract hooks a probe reads. */
  severityValue: string;

  statusLabel: string;
  statusTone: AppTone;
  statusExplanation: string;
  statusValue: string;

  categoryLabel: string;
  categoryValue: string;

  /** "Evidence record", "Delivery job" — what the condition is ABOUT. */
  affectedLabel: string | null;
  /** The in-product destination for that record, when one exists. */
  affectedHref: string | null;

  firstSeenAtUtc: string;
  lastSeenAtUtc: string;
  /**
   * HOW MANY TIMES THE CONDITION WAS OBSERVED.
   *
   * NOT how many records it affects. The two used to be rendered as if they
   * were interchangeable, and on an aggregate condition they are as far apart
   * as numbers get: 4 observations of a backlog of 26.
   */
  occurrenceCount: number;

  /**
   * THE CURRENT AGGREGATE VALUE, already formatted, or null.
   *
   * Bounded for display — a five-figure Enterprise backlog renders as a floor
   * rather than an exact number that will be wrong by the time it is read —
   * with the exact value still available in the Inspector and the API.
   */
  metric: {
    /** e.g. "26 affected records" — the value AND what it counts. */
    label: string;
    /** e.g. "threshold 20" */
    thresholdLabel: string;
    /**
     * The EXACT values, unbounded.
     *
     * The queue row renders `label`, which is capped; the inspector renders
     * these, because that is where somebody has stopped to look at one
     * condition and the last three digits might matter to them.
     */
    currentValue: number;
    thresholdValue: number;
    criticalThresholdValue: number | null;
    previousValue: number | null;
    delta: number | null;
    unit: string;
    observedAtUtc: string;
    /**
     * True when the last observation FAILED and these are the previous values.
     * The row SAYS SO rather than presenting them as current, because a number
     * that is quietly out of date is worse than one that admits it.
     */
    stale: boolean;
    truncated: boolean;
  } | null;

  /**
   * WHY THIS ROW HAS NO RESOLVE CONTROL, when it has none.
   *
   * Rendered as plain guidance rather than as a disabled button. A disabled
   * control invites the reader to look for the permission that would enable
   * it; there is no such permission here, and saying so is shorter and true.
   * Null when Resolve IS offered.
   */
  resolutionNote: string | null;

  owner: OwnerDisplay;
  /**
   * The raw id, alongside the display.
   *
   * The assignment control needs the VALUE to preselect; the row needs the
   * LABEL to render. Deriving one from the other at the call site is how a
   * picker ends up preselecting a truncated id it cannot match.
   */
  assignedOperatorUserId: string | null;
  /**
   * SLA POSTURE, resolved by the server against the workspace's own policy.
   *
   * Carried through verbatim rather than recomputed: a threshold in the
   * browser would be a second SLA authority, and the two would disagree the
   * first time a workspace edited its policy. Null when the server sent none,
   * in which case the surface makes no claim about lateness.
   */
  sla: {
    label: string;
    tone: AppTone;
    explanation: string;
    posture: SlaPosture;
    dueAtUtc: string | null;
    /** The latched breach record, when the posture no longer shows it. */
    breachRecord: string | null;
    /** True when the SERVER classed this posture as needing attention. */
    needsAttention: boolean;
  } | null;

  /** Which mutations may be offered for THIS row, in THIS state. */
  canAcknowledge: boolean;
  canResolve: boolean;
  canSuppress: boolean;
  canAssign: boolean;
};

/**
 * Where a condition's affected record lives.
 *
 * Only Evidence has a stable tenant destination today. A job id and a provider
 * name are operator context, not navigable resources, and rendering them as
 * links would be three affordances that cannot do what they say.
 */
function affectedFor(i: Incident): {
  label: string | null;
  href: string | null;
} {
  if (i.relatedEvidenceId) {
    return {
      label: "Evidence record",
      href: `/evidence/${encodeURIComponent(i.relatedEvidenceId)}`,
    };
  }
  if (i.relatedJobId) return { label: "Background job", href: null };
  if (i.relatedProvider) return { label: i.relatedProvider, href: null };
  return { label: null, href: null };
}

/**
 * A bounded rendering of the current value.
 *
 * Enterprise workspaces carry five-figure backlogs, and a queue row is not the
 * place for an exact five-figure number: it is wrong by the time it is read,
 * it makes every row a different width, and nobody acts on the last three
 * digits. Above the cap the value is presented as a floor and the exact figure
 * stays in the Inspector and the API.
 */
const METRIC_DISPLAY_CAP = 2000;

function formatMetricValue(value: number): string {
  if (value > METRIC_DISPLAY_CAP) {
    return `${METRIC_DISPLAY_CAP.toLocaleString("en-US")}+`;
  }
  return value.toLocaleString("en-US");
}

/**
 * AN AGE IS NOT A POPULATION, ON THIS SURFACE EITHER.
 *
 * The two AGE_THRESHOLD sources measure in whole MINUTES, and this row model
 * used to hand every metric to one formatter — so a telemetry sampler fifteen
 * hours behind read "902 affected minutes", beside a threshold of "15". Both
 * numbers were true, neither was legible, and "affected" was the wrong word
 * for an elapsed time in the first place.
 *
 * The source's own `metricContract` decides. Absent — an older server — falls
 * through to the counted rendering, which is what every source but two is.
 */
function isAgeMetric(i: Incident): boolean {
  return i.lifecycle?.metricContract === "AGE_THRESHOLD" &&
    i.metric?.unit === "minutes";
}

function metricFor(i: Incident): OperationsRowModel["metric"] {
  const m = i.metric;
  if (!m) return null;
  const age = isAgeMetric(i);
  return {
    // "affected" is doing real work in this string. It names the quantity, so
    // it cannot be misread as an observation count or a group member count —
    // the three numbers this surface used to render identically.
    label: age
      ? `last sample ${describeDuration(m.currentValue * 60)} ago`
      : `${formatMetricValue(m.currentValue)} affected ${m.unit}`,
    thresholdLabel: age
      ? `window ${describeDuration(m.thresholdValue * 60)}`
      : `threshold ${m.thresholdValue.toLocaleString("en-US")}`,
    currentValue: m.currentValue,
    thresholdValue: m.thresholdValue,
    criticalThresholdValue: m.criticalThresholdValue,
    previousValue: m.previousValue,
    delta: m.delta,
    unit: m.unit,
    observedAtUtc: m.observedAtUtc,
    stale: m.stale === true,
    truncated: m.truncated === true,
  };
}

/**
 * What to say instead of a Resolve control.
 *
 * Derived from the SOURCE contract the server projected, so the sentence and
 * the missing button have the same cause. Nothing here is inferred from a
 * category, a severity or a capability.
 */
function resolutionNoteFor(i: Incident): string | null {
  const authority = i.lifecycle?.resolutionAuthority;
  if (authority === "SOURCE_TRUTH") {
    return "This condition closes itself when its source recovers. It cannot be marked resolved by hand.";
  }
  if (authority === "NO_DIRECT_RESOLUTION") {
    return "This condition is owned by a surface outside this workspace. It cannot be marked resolved here.";
  }
  return null;
}

function ownerFor(
  i: Incident,
  viewerUserId: string | null,
  operatorLabels: ReadonlyMap<string, string>,
): OwnerDisplay {
  if (!i.assignedOperatorUserId) return { kind: "unassigned" };
  if (viewerUserId && i.assignedOperatorUserId === viewerUserId) {
    return { kind: "self", label: "You" };
  }
  // A resolved display name when the workspace could supply one, and a short
  // id when it could not. The short id is deliberately still shown: "assigned
  // to somebody whose name I cannot load" is a materially different state from
  // "unassigned", and collapsing the two would make a stuck condition look
  // like an available one.
  const known = operatorLabels.get(i.assignedOperatorUserId);
  return {
    kind: "other",
    label: known ?? i.assignedOperatorUserId.slice(0, 8),
  };
}

export function buildRowModel(
  i: Incident,
  ctx: {
    capabilities: OperationsCapabilities;
    viewerUserId: string | null;
    operatorLabels: ReadonlyMap<string, string>;
    now: number;
    /**
     * The postures the SERVER classed as needing attention, sent with the
     * page. Passed in rather than hard-coded so the emphasis this surface
     * applies is the server's judgement, not a duplicate of it.
     */
    slaAttentionPostures?: ReadonlyArray<SlaPosture>;
  },
): OperationsRowModel {
  const severity = SEVERITY_VOCABULARY[i.severity] ?? SEVERITY_VOCABULARY.INFO;
  const status = STATUS_VOCABULARY[i.status] ?? STATUS_VOCABULARY.OPEN;
  const affected = affectedFor(i);

  const isOpen = i.status === "OPEN";
  const isUnresolved = isOpen || i.status === "ACKNOWLEDGED";

  return {
    id: i.id,
    title: i.title,
    summary: i.safeSummary,

    severityLabel: severity.label,
    severityTone: severity.tone,
    severityExplanation: severity.explanation,
    severityValue: i.severity,

    statusLabel: status.label,
    statusTone: status.tone,
    statusExplanation: status.explanation,
    statusValue: i.status,

    categoryLabel: categoryLabel(i.category),
    categoryValue: i.category,

    affectedLabel: affected.label,
    affectedHref: affected.href,

    firstSeenAtUtc: i.firstSeenAtUtc,
    lastSeenAtUtc: i.lastSeenAtUtc,
    occurrenceCount: i.occurrenceCount,
    metric: metricFor(i),
    resolutionNote: resolutionNoteFor(i),

    owner: ownerFor(i, ctx.viewerUserId, ctx.operatorLabels),
    assignedOperatorUserId: i.assignedOperatorUserId,
    sla: i.sla
      ? {
          label: slaLabel(i.sla.posture),
          tone: slaTone(i.sla.posture),
          explanation: slaExplanation(i.sla),
          posture: i.sla.posture,
          dueAtUtc: i.sla.dueAtUtc,
          breachRecord: slaBreachRecord(i.sla),
          // Membership is decided by the SERVER's list, not by a set repeated
          // here — so the queue's emphasis, the filter and any future alert
          // all agree by construction.
          needsAttention: (ctx.slaAttentionPostures ?? []).includes(
            i.sla.posture,
          ),
        }
      : null,

    // STATE, then permission. An operator who may acknowledge still gets no
    // Acknowledge button on a condition that is already acknowledged: the
    // server would refuse it, and a control whose only outcome is a 409 is a
    // control that teaches people to distrust the surface.
    canAcknowledge: ctx.capabilities.canAcknowledge && isOpen,
    // -------------------------------------------------------------------
    // SOURCE CONTRACT, THEN STATE, THEN PERMISSION.
    //
    // The contract leads because it is the only one of the three the browser
    // cannot know on its own — and because it was the missing one. Resolve
    // used to be offered on every unresolved condition to any capability
    // holder, including the SOURCE_TRUTH conditions the server refuses and
    // the platform conditions nobody can truthfully close. Every one of those
    // buttons could only ever produce a 409.
    //
    // Absent lifecycle means an older server, and it reads as NO. That is the
    // fail-closed direction: a Resolve control that should not be there is a
    // worse error than one briefly missing.
    // -------------------------------------------------------------------
    canResolve:
      i.lifecycle?.manualResolution === true &&
      ctx.capabilities.canResolve &&
      isUnresolved,
    canSuppress: ctx.capabilities.canSuppress && isUnresolved,
    canAssign: ctx.capabilities.canAssign && isUnresolved,
  };
}
