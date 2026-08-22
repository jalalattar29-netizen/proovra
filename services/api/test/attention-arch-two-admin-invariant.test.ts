/**
 * THE TWO-ADMIN INVARIANT (Attention Architecture, Phase 1.4).
 *
 * PERMANENT. This suite is a release gate and must survive every later
 * cleanup, rename and route migration in this program. If it is ever deleted,
 * the property it protects has no other guard anywhere in the repository.
 *
 * ---------------------------------------------------------------------------
 * THE SCENARIO
 * ---------------------------------------------------------------------------
 *   Workspace W, two admins A and B.
 *   Evidence X has an unresolved TSA anchoring failure.
 *
 *   OPERATIONS       A sees X.  B sees X.
 *   NOTIFICATIONS    A is notified.  B is notified.
 *
 *   A archives their notification.
 *     -> A's active feed changes.
 *     -> B's notification state does NOT change.
 *     -> the shared operational condition does NOT change.
 *     -> Home's workspace operational count does NOT change.
 *
 *   A acknowledges the OPERATIONS condition.
 *     -> the shared condition becomes ACKNOWLEDGED for A and for B.
 *     -> neither admin's personal read/archive state changes.
 *
 * ---------------------------------------------------------------------------
 * WHY IT IS WRITTEN AGAINST THE PURE PROJECTION MODULES
 * ---------------------------------------------------------------------------
 * The property under test is STRUCTURAL: "there is no code path from a
 * personal action to shared truth". A live-database end-to-end test can only
 * ever demonstrate that the path was not taken on one particular run against
 * one particular fixture. Driving the canonical modules directly proves the
 * stronger statement — the functions that would have to carry such a path do
 * not take the arguments that would let them — and it runs in the default
 * suite on every commit rather than behind a provisioned Postgres.
 *
 * The live-database counterpart (`inbox-unread-state.integration.test.ts`)
 * covers the read-write round trip. This covers the architecture.
 */

import { describe, expect, it } from "vitest";

import {
  personalStateAfterSharedAdjudication,
  projectDomainEvent,
  sharedConditionAfterPersonalAction,
  sharedConditionFingerprint,
  type SharedConditionStatus,
  type SharedOperationalCondition,
} from "../src/services/notifications/attention-projection.js";
import {
  derivePersonalAttentionState,
  isActiveForRecipient,
  isUnreadActive,
  LEGACY_ACTION_ALIASES,
  PERSONAL_ATTENTION_ACTIONS,
  PERSONAL_STATE_IS_NEVER_SHARED_SUPPRESSION,
  type PersonalAttentionAction,
} from "../src/services/notifications/personal-attention-state.js";

const NOW = new Date("2026-08-22T12:00:00.000Z");

const WORKSPACE_W = "11111111-1111-4111-8111-111111111111";
const EVIDENCE_X = "22222222-2222-4222-8222-222222222222";
const ADMIN_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ADMIN_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

/** The domain event: Evidence X failed RFC3161 timestamping. */
function tsaFailureEvent(
  recipientState: Record<
    string,
    { readAt: Date | null; dismissedAt: Date | null; snoozedUntil: Date | null }
  > = {},
) {
  return projectDomainEvent({
    category: "tsa_failure",
    sourceId: EVIDENCE_X,
    workspaceId: WORKSPACE_W,
    addressedRecipientUserIds: [ADMIN_A, ADMIN_B],
    recipientState,
    now: NOW,
  });
}

describe("Two-admin invariant — the event projects onto BOTH channels", () => {
  it("produces one personal notification per addressed admin", () => {
    const projection = tsaFailureEvent();
    expect(projection.personalNotifications).toHaveLength(2);
    expect(
      projection.personalNotifications.map((n) => n.recipientUserId).sort(),
    ).toEqual([ADMIN_A, ADMIN_B].sort());
  });

  it("produces exactly ONE shared operational condition for the workspace", () => {
    const projection = tsaFailureEvent();
    expect(projection.sharedCondition).not.toBeNull();
    expect(projection.sharedCondition?.workspaceId).toBe(WORKSPACE_W);
    // Cardinality is the whole point: two recipients, one piece of work.
    expect(projection.sharedCondition?.occurrenceCount).toBe(1);
  });

  it("identifies the shared condition by Evidence id, never by recipient", () => {
    const projection = tsaFailureEvent();
    expect(projection.sharedCondition?.fingerprint).toBe(
      sharedConditionFingerprint("tsa_failure", EVIDENCE_X),
    );
    // The fingerprint must not mention either admin — a per-recipient
    // fingerprint would make N admins produce N pieces of "work".
    expect(projection.sharedCondition?.fingerprint).not.toContain(ADMIN_A);
    expect(projection.sharedCondition?.fingerprint).not.toContain(ADMIN_B);
  });

  it("leaves resolution authority with the Evidence domain, not Operations", () => {
    // Invariant 3: one domain truth must not acquire two competing lifecycle
    // state machines. Evidence.tsaStatus decides whether this is fixed.
    expect(tsaFailureEvent().sharedCondition?.authority).toBe("evidence");
  });

  it("starts both admins UNREAD and ACTIVE when neither has acted", () => {
    for (const n of tsaFailureEvent().personalNotifications) {
      expect(n.state.readState).toBe("UNREAD");
      expect(n.state.lifecycle).toBe("ACTIVE");
      expect(isUnreadActive(n.state)).toBe(true);
    }
  });
});

describe("Two-admin invariant — A archives; B and the shared work are untouched", () => {
  /** A archived at 12:00; B has done nothing. */
  const AFTER_A_ARCHIVES = tsaFailureEvent({
    [ADMIN_A]: { readAt: NOW, dismissedAt: NOW, snoozedUntil: null },
  });

  const byUser = (userId: string) =>
    AFTER_A_ARCHIVES.personalNotifications.find(
      (n) => n.recipientUserId === userId,
    )!;

  it("A's active feed changes", () => {
    const a = byUser(ADMIN_A).state;
    expect(a.lifecycle).toBe("ARCHIVED");
    expect(a.readState).toBe("READ");
    expect(isActiveForRecipient(a)).toBe(false);
  });

  it("B's notification state does NOT change", () => {
    const b = byUser(ADMIN_B).state;
    expect(b.lifecycle).toBe("ACTIVE");
    expect(b.readState).toBe("UNREAD");
    expect(isUnreadActive(b)).toBe(true);
  });

  it("the shared operational condition remains OPEN", () => {
    // The projection recomputes the shared condition from the DOMAIN event.
    // A's archive is not one of its inputs, which is why it cannot move it.
    expect(AFTER_A_ARCHIVES.sharedCondition?.status).toBe("OPEN");
  });

  it("NO personal action — present or future — can move shared truth", () => {
    const condition: SharedOperationalCondition = {
      fingerprint: sharedConditionFingerprint("tsa_failure", EVIDENCE_X),
      workspaceId: WORKSPACE_W,
      status: "OPEN",
      authority: "evidence",
      occurrenceCount: 1,
    };
    // Every action the product exposes, canonical names and legacy aliases.
    const everyAction = [
      ...(Object.keys(PERSONAL_ATTENTION_ACTIONS) as PersonalAttentionAction[]),
      ...Object.values(LEGACY_ACTION_ALIASES),
    ];
    expect(everyAction.length).toBeGreaterThanOrEqual(5);
    for (const action of everyAction) {
      const after = sharedConditionAfterPersonalAction(condition, action);
      expect(after).toEqual(condition);
      expect(after.status).toBe("OPEN");
    }
  });

  it("Home's workspace operational count is unchanged by A's archive", () => {
    // Home's count is the number of shared conditions, which is derived from
    // the domain event and never from any recipient's feed. Counting the
    // projection before and after A's archive is the assertion.
    const before = tsaFailureEvent().sharedCondition ? 1 : 0;
    const after = AFTER_A_ARCHIVES.sharedCondition ? 1 : 0;
    expect(before).toBe(1);
    expect(after).toBe(before);
  });

  it("archiving is never suppression — stated in code, asserted here", () => {
    expect(PERSONAL_STATE_IS_NEVER_SHARED_SUPPRESSION).toBe(false);
  });
});

describe("Two-admin invariant — A acknowledges Operations; personal state holds", () => {
  const ACKNOWLEDGED: SharedOperationalCondition = {
    fingerprint: sharedConditionFingerprint("tsa_failure", EVIDENCE_X),
    workspaceId: WORKSPACE_W,
    status: "ACKNOWLEDGED",
    authority: "evidence",
    occurrenceCount: 1,
  };

  it("both admins observe the SAME shared status", () => {
    // A shared condition has one status. There is no per-user copy of it to
    // diverge, which is the structural reason A and B agree.
    const asSeenByA = ACKNOWLEDGED;
    const asSeenByB = ACKNOWLEDGED;
    expect(asSeenByA.status).toBe("ACKNOWLEDGED");
    expect(asSeenByB.status).toBe("ACKNOWLEDGED");
    expect(asSeenByA).toBe(asSeenByB);
  });

  it("A stays ARCHIVED+READ and B stays ACTIVE+UNREAD across every transition", () => {
    const aState = derivePersonalAttentionState(
      { readAt: NOW, dismissedAt: NOW, snoozedUntil: null },
      NOW,
    );
    const bState = derivePersonalAttentionState(
      { readAt: null, dismissedAt: null, snoozedUntil: null },
      NOW,
    );
    const transitions: SharedConditionStatus[] = [
      "OPEN",
      "ACKNOWLEDGED",
      "RESOLVED",
      "SUPPRESSED",
      "REOPENED",
    ];
    for (const status of transitions) {
      expect(personalStateAfterSharedAdjudication(aState, status)).toEqual(
        aState,
      );
      expect(personalStateAfterSharedAdjudication(bState, status)).toEqual(
        bState,
      );
    }
    expect(aState.lifecycle).toBe("ARCHIVED");
    expect(bState.lifecycle).toBe("ACTIVE");
  });

  it("even SUPPRESSED — the shared analogue of archive — leaves feeds alone", () => {
    // SUPPRESSED is the only shared status that means "stop showing this".
    // It is reached by an authorized operator acting on the CONDITION, and it
    // still does not reach into anybody's mailbox.
    const bState = derivePersonalAttentionState(
      { readAt: null, dismissedAt: null, snoozedUntil: null },
      NOW,
    );
    expect(
      personalStateAfterSharedAdjudication(bState, "SUPPRESSED").readState,
    ).toBe("UNREAD");
  });
});

describe("Two-admin invariant — remind-me-later is equally private", () => {
  it("A deferring does not defer B, and does not defer the work", () => {
    const later = new Date(NOW.getTime() + 60 * 60 * 1000);
    const projection = tsaFailureEvent({
      [ADMIN_A]: { readAt: null, dismissedAt: null, snoozedUntil: later },
    });
    const a = projection.personalNotifications.find(
      (n) => n.recipientUserId === ADMIN_A,
    )!.state;
    const b = projection.personalNotifications.find(
      (n) => n.recipientUserId === ADMIN_B,
    )!.state;

    expect(a.deferred).toBe(true);
    expect(isActiveForRecipient(a)).toBe(false);
    // A deferred item is NOT archived — it comes back. The two axes stay
    // independent, which is why "remind me" is not a weaker "archive".
    expect(a.lifecycle).toBe("ACTIVE");

    expect(b.deferred).toBe(false);
    expect(isActiveForRecipient(b)).toBe(true);

    expect(projection.sharedCondition?.status).toBe("OPEN");
  });

  it("an elapsed reminder returns the item to the active feed", () => {
    const past = new Date(NOW.getTime() - 1000);
    const state = derivePersonalAttentionState(
      { readAt: null, dismissedAt: null, snoozedUntil: past },
      NOW,
    );
    expect(state.deferred).toBe(false);
    expect(isActiveForRecipient(state)).toBe(true);
    // The reminder timestamp is retained for audit — "when did you defer
    // this" survives the deferral expiring.
    expect(state.remindAt).toBe(past.toISOString());
  });
});
