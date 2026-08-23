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

import type { Incident, OperationsCapabilities, SlaPosture } from "./types";
import {
  SEVERITY_VOCABULARY,
  STATUS_VOCABULARY,
  categoryLabel,
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
  occurrenceCount: number;

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
   * True when this condition is OPEN and has gone unattended past the age the
   * canonical summary counts as overdue. Derived from the SAME threshold the
   * server uses, so the row and the Overdue card cannot disagree.
   */
  overdue: boolean;

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
    /** True when the SERVER classed this posture as needing attention. */
    needsAttention: boolean;
  } | null;

  /** Which mutations may be offered for THIS row, in THIS state. */
  canAcknowledge: boolean;
  canResolve: boolean;
  canSuppress: boolean;
  canAssign: boolean;
};

/** Mirrors UNATTENDED_OVERDUE_HOURS in the canonical summary service. */
const OVERDUE_MS = 48 * 60 * 60 * 1000;

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

    owner: ownerFor(i, ctx.viewerUserId, ctx.operatorLabels),
    assignedOperatorUserId: i.assignedOperatorUserId,
    overdue:
      isOpen && ctx.now - new Date(i.firstSeenAtUtc).getTime() >= OVERDUE_MS,

    sla: i.sla
      ? {
          label: slaLabel(i.sla.posture),
          tone: slaTone(i.sla.posture),
          explanation: slaExplanation(i.sla),
          posture: i.sla.posture,
          dueAtUtc: i.sla.dueAtUtc,
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
    canResolve: ctx.capabilities.canResolve && isUnresolved,
    canSuppress: ctx.capabilities.canSuppress && isUnresolved,
    canAssign: ctx.capabilities.canAssign && isUnresolved,
  };
}
