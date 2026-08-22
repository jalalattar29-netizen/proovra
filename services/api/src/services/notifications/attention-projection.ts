/**
 * THE PROJECTION SPLIT (Attention Architecture, Phase 1.3).
 *
 * A domain event is not a notification, and it is not a piece of operational
 * work. It is an event, and BOTH of those are projections of it:
 *
 *   DOMAIN EVENT
 *         |
 *         +-- personal notification         one row per addressed recipient
 *         |
 *         +-- shared operational condition  at most one row per workspace
 *
 * The two projections have different identity, different cardinality,
 * different owners and different lifecycles. This module is where that is
 * stated once, in executable form, so no surface has to re-derive it — and so
 * the invariant that keeps them apart can be TESTED rather than promised.
 *
 * WHY THIS EXISTS AS A MODULE AND NOT A COMMENT
 * ---------------------------------------------
 * The failure it prevents is subtle and expensive. Two admins share a
 * workspace. Both are notified about an unresolved integrity failure. Admin A
 * archives their notification because they have read it. If the notification
 * and the work are the same row, one of two things happens: the work vanishes
 * for the workspace (A silently decided for B), or B's message vanishes too (A
 * silently decided for B again). Both are wrong, both are invisible in
 * testing unless somebody writes the two-admin scenario down, and both are
 * unrecoverable in production because the archived state looks exactly like a
 * legitimately handled one.
 *
 * `attention-arch-two-admin-invariant.test.ts` drives this module directly.
 */

import {
  classifyCategory,
  producesOperationalCondition,
  producesPersonalNotification,
  type ConditionAuthority,
} from "./notification-classification.js";
import {
  derivePersonalAttentionState,
  type PersonalAttentionAction,
  type PersonalAttentionState,
  type PersistedAttentionColumns,
} from "./personal-attention-state.js";

/**
 * The shared lifecycle. Identical to `IncidentStatus` in the schema plus the
 * REOPENED transition Operations already performs by moving a RESOLVED row
 * back to OPEN — named here because the Operations HISTORY has to be able to
 * say "this reopened" and a status enum that cannot say so forces the history
 * to be inferred.
 */
export type SharedConditionStatus =
  | "OPEN"
  | "ACKNOWLEDGED"
  | "RESOLVED"
  | "SUPPRESSED"
  | "REOPENED";

/** Shared, per-workspace, adjudicated by capability. Never per-user. */
export type SharedOperationalCondition = {
  /** Stable identity. NEVER derived from a personal notification's itemKey. */
  fingerprint: string;
  workspaceId: string | null;
  status: SharedConditionStatus;
  /** Which system owns "is this resolved?". */
  authority: ConditionAuthority;
  occurrenceCount: number;
};

/** Personal, per-recipient, archivable. One per addressed user. */
export type PersonalNotificationProjection = {
  recipientUserId: string;
  itemKey: string;
  category: string;
  scope: "ACCOUNT" | "WORKSPACE" | "ORGANIZATION";
  state: PersonalAttentionState;
};

export type DomainEventInput = {
  category: string;
  /** Stable identity of the underlying domain row (evidence id, mention id…). */
  sourceId: string;
  workspaceId: string | null;
  /** Every user this event is addressed to, per the addressing policy. */
  addressedRecipientUserIds: readonly string[];
  /**
   * Persisted per-user attention columns, keyed by recipient user id. Absent
   * entries mean "no state row yet", which derives to UNREAD + ACTIVE.
   */
  recipientState?: Readonly<
    Record<string, PersistedAttentionColumns | undefined>
  >;
  now: Date;
};

export type AttentionProjection = {
  personalNotifications: PersonalNotificationProjection[];
  /**
   * Null when the category produces no shared work. Present as a DESCRIPTOR —
   * this module computes identity and eligibility, never lifecycle. The status
   * a caller passes in is echoed; the status a caller does not pass defaults
   * to OPEN because a freshly observed condition is by definition unresolved.
   */
  sharedCondition: SharedOperationalCondition | null;
};

/**
 * Shared condition identity.
 *
 * `<category>:<sourceId>` and nothing else. Not the filename, not the failure
 * reason, not the provider, not the workspace, not the day. Those are
 * ATTRIBUTES of a failure and several genuinely distinct failures share them;
 * using any of them as identity silently collapses independent records into
 * one, which for evidence integrity is data loss disguised as tidiness.
 */
export function sharedConditionFingerprint(
  category: string,
  sourceId: string,
): string {
  return `${category}:${sourceId}`;
}

/**
 * Project one domain event onto both channels.
 *
 * Note what does NOT happen here: the personal projections do not consult the
 * shared condition's status, and the shared condition does not consult any
 * recipient's state. Neither can, because neither is passed the other. The
 * separation is structural, not disciplinary.
 */
export function projectDomainEvent(
  input: DomainEventInput,
): AttentionProjection {
  const classification = classifyCategory(input.category);
  const scope = classification?.scope ?? "WORKSPACE";

  const personalNotifications: PersonalNotificationProjection[] =
    producesPersonalNotification(input.category)
      ? input.addressedRecipientUserIds.map((recipientUserId) => ({
          recipientUserId,
          itemKey: `${input.category}:${input.sourceId}`,
          category: input.category,
          scope,
          state: derivePersonalAttentionState(
            input.recipientState?.[recipientUserId] ?? null,
            input.now,
          ),
        }))
      : [];

  const sharedCondition: SharedOperationalCondition | null =
    producesOperationalCondition(input.category)
      ? {
          fingerprint: sharedConditionFingerprint(
            input.category,
            input.sourceId,
          ),
          workspaceId: input.workspaceId,
          status: "OPEN",
          authority: classification?.conditionAuthority ?? "operations",
          occurrenceCount: 1,
        }
      : null;

  return { personalNotifications, sharedCondition };
}

/**
 * THE INVARIANT, EXECUTABLE.
 *
 * Given a shared condition and a personal action, return the shared condition
 * AFTER the action. The implementation is the identity function, and that is
 * the entire point: there is no branch, no action name, and no caller-supplied
 * flag that can make a personal action mutate shared truth. A future edit that
 * tried to add one would have to change this function's body, which the
 * two-admin suite asserts against for every action name in the product.
 */
export function sharedConditionAfterPersonalAction(
  condition: SharedOperationalCondition,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- named to
  // document that the action is deliberately not consulted.
  _action: PersonalAttentionAction,
): SharedOperationalCondition {
  return condition;
}

/**
 * And the converse: adjudicating shared work does not read, write, or reset
 * anybody's personal attention state. An operator acknowledging a condition
 * has not read your mail for you.
 */
export function personalStateAfterSharedAdjudication(
  state: PersonalAttentionState,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- see above.
  _newStatus: SharedConditionStatus,
): PersonalAttentionState {
  return state;
}
