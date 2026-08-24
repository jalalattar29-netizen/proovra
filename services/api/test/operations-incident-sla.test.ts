/**
 * THE INCIDENT SLA PROJECTION — its arithmetic, its latches and its refusals.
 *
 * The projection is a PURE function over (incident status, persisted cycle,
 * now), which is the whole reason it is written that way: every case below
 * fixes the instants explicitly, so nothing here passes or fails because of
 * what the clock happened to say during a run.
 *
 * What these cases defend:
 *
 *   - the arithmetic at BOTH edges of every window, since an off-by-one on a
 *     boundary is invisible in a screenshot and wrong for exactly the rows an
 *     operator is about to be judged on;
 *   - the LATCH, which is the closure's central claim: a missed promise stays
 *     missed through acknowledgement, suppression and severity changes;
 *   - the REFUSALS, which are what a later pass is most likely to "fix" into
 *     something friendlier and untrue — a legacy condition measured against
 *     today's policy, or a corrupt cycle reported as a breach;
 *   - that the projection reads PERSISTED history and never the live policy,
 *     which is the defect this closure exists to remove.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  SLA_ATTENTION_POSTURES,
  SLA_POSTURES,
  projectIncidentSla,
  type SlaPosture,
} from "../src/services/operations/incident-sla.js";

const HOUR = 3_600_000;
const OPENED = new Date("2026-08-20T00:00:00.000Z");

/** Deliberately un-round, so a hard-coded 24 cannot pass by luck. */
const ACK_HOURS = 5;
const RES_HOURS = 30;
const DUE_SOON_HOURS = 2;

function at(hoursAfterOpen: number): Date {
  return new Date(OPENED.getTime() + hoursAfterOpen * HOUR);
}

/** A persisted cycle, exactly as the cycle service writes one. */
function cycle(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: "cycle-1",
    teamId: "team-1",
    incidentId: "incident-1",
    cycleNumber: 1,
    policyVersionId: "version-1",
    policyDigest: "d".repeat(64),
    severityAtStart: "HIGH",
    startedAtUtc: OPENED,
    acknowledgementTargetHours: ACK_HOURS,
    resolutionTargetHours: RES_HOURS,
    dueSoonHours: DUE_SOON_HOURS,
    acknowledgementDueAtUtc: at(ACK_HOURS),
    resolutionDueAtUtc: at(RES_HOURS),
    acknowledgedAtUtc: null,
    resolvedAtUtc: null,
    acknowledgementBreached: false,
    resolutionBreached: false,
    endedAtUtc: null,
    endReason: null,
    version: 1,
    createdAt: OPENED,
    updatedAt: OPENED,
    ...over,
  } as never;
}

const postureAt = (
  hoursAfterOpen: number,
  over: Partial<Record<string, unknown>> = {},
  status = "OPEN",
): SlaPosture => projectIncidentSla(status, cycle(over), at(hoursAfterOpen)).posture;

// ===========================================================================
// 1. THE ACKNOWLEDGEMENT WINDOW
// ===========================================================================

describe("the acknowledgement window", () => {
  it("is ON_TRACK well inside the window", () => {
    expect(postureAt(1)).toBe("ON_TRACK");
  });

  it("becomes AT_RISK exactly when the warning lead time is reached", () => {
    // Window 5h, lead 2h -> the warning begins at 3h, not at 3h + epsilon.
    expect(postureAt(2.99)).toBe("ON_TRACK");
    expect(postureAt(3)).toBe("AT_RISK");
  });

  it("is still AT_RISK at the deadline itself, and BREACHED only after it", () => {
    // A condition AT its deadline has not yet missed it. Reporting a breach
    // one instant early is a false accusation, and it is the boundary a
    // reader would never notice was wrong.
    expect(postureAt(5)).toBe("AT_RISK");
    expect(postureAt(5.01)).toBe("BREACHED");
  });

  it("measures ACKNOWLEDGEMENT while unacknowledged, whatever the resolution window says", () => {
    const p = projectIncidentSla("OPEN", cycle(), at(6));
    expect(p.obligation).toBe("ACKNOWLEDGEMENT");
    expect(p.targetHours).toBe(ACK_HOURS);
    // Breached against 5h even though 30h have not elapsed.
    expect(p.posture).toBe("BREACHED");
  });
});

// ===========================================================================
// 2. THE HANDOVER TO RESOLUTION
// ===========================================================================

describe("the handover to resolution", () => {
  it("acknowledgement moves the live obligation and reports ACKNOWLEDGED", () => {
    const p = projectIncidentSla(
      "ACKNOWLEDGED",
      cycle({ acknowledgedAtUtc: at(2) }),
      at(6),
    );
    expect(p.obligation).toBe("RESOLUTION");
    expect(p.targetHours).toBe(RES_HOURS);
    // Past the 5h acknowledgement window, comfortably inside the 30h one.
    expect(p.posture).toBe("ACKNOWLEDGED");
  });

  it("does NOT restart the clock at acknowledgement", () => {
    // Acknowledged at hour 20 with a 30h resolution window: the deadline is
    // still hour 30 from FIRST OBSERVATION, not hour 50. Acknowledging late
    // must not buy a fresh window.
    const p = projectIncidentSla(
      "ACKNOWLEDGED",
      cycle({ acknowledgedAtUtc: at(20) }),
      at(21),
    );
    expect(p.dueAtUtc).toBe(at(RES_HOURS).toISOString());
  });

  it("an acknowledged condition can still breach the resolution window", () => {
    expect(postureAt(31, { acknowledgedAtUtc: at(1) }, "ACKNOWLEDGED")).toBe(
      "BREACHED",
    );
  });
});

// ===========================================================================
// 3. THE LATCH — the closure's central claim
// ===========================================================================

describe("a missed promise stays missed", () => {
  it("acknowledging late does not clear the breach", () => {
    // The single most tempting bug in this module: reporting ACKNOWLEDGED for
    // a condition somebody picked up after the deadline would let every
    // missed promise be cleared by clicking one button.
    expect(
      postureAt(
        6,
        { acknowledgedAtUtc: at(6), acknowledgementBreached: true },
        "ACKNOWLEDGED",
      ),
    ).toBe("BREACHED");
  });

  it("a latched breach survives even when the live deadline has not passed", () => {
    // Acknowledged late (ack breach latched), now inside the resolution
    // window. The live obligation is fine; the cycle is not.
    expect(
      postureAt(
        7,
        { acknowledgedAtUtc: at(6), acknowledgementBreached: true },
        "ACKNOWLEDGED",
      ),
    ).toBe("BREACHED");
  });

  it("the latched facts travel with the projection, and suppression does not hide them", () => {
    // ORIGINAL INTENT, PRESERVED: a missed promise survives suppression.
    //
    // The original case asserted posture NOT_APPLICABLE, which was the
    // superseded rule — suppression used to close the cycle and stop the
    // clock, so a workspace could clear its own SLA record by silencing
    // whatever it was about to miss. The record-survives guarantee is
    // unchanged and is now STRONGER: the breach is visible in the posture
    // itself, not merely retained in a flag nobody renders.
    const p = projectIncidentSla(
      "SUPPRESSED",
      cycle({ acknowledgementBreached: true }),
      at(100),
    );
    expect(p.posture).toBe("BREACHED");
    expect(p.acknowledgementBreached).toBe(true);
  });
});

// ===========================================================================
// 4. TERMINAL STATES
// ===========================================================================

describe("terminal states", () => {
  it("a resolved cycle reports RESOLVED", () => {
    expect(
      postureAt(29, { resolvedAtUtc: at(29), endReason: "RESOLVED" }, "RESOLVED"),
    ).toBe("RESOLVED");
  });

  it("a LATE resolution still reports RESOLVED, with the breach recorded", () => {
    const p = projectIncidentSla(
      "RESOLVED",
      cycle({
        resolvedAtUtc: at(200),
        endReason: "RESOLVED",
        resolutionBreached: true,
      }),
      at(300),
    );
    // The condition IS resolved; whether it was resolved in time is a
    // different question, and both answers are available.
    expect(p.posture).toBe("RESOLVED");
    expect(p.resolutionBreached).toBe(true);
  });

  it("suppression keeps the deadline and the clock", () => {
    // Suppression is a VISIBILITY decision. The condition is still unresolved
    // and still unfixed, so it still has a promise and that promise still has
    // a deadline. Nulling them here is what let silence become a permanent
    // escape from a workspace's own commitments.
    const p = projectIncidentSla("SUPPRESSED", cycle(), at(1));
    expect(p.posture).toBe("ON_TRACK");
    expect(p.dueAtUtc).toBe(at(ACK_HOURS).toISOString());
    expect(p.targetHours).toBe(ACK_HOURS);
  });

  it("a suppressed condition still BREACHES when its deadline passes", () => {
    expect(postureAt(10_000, {}, "SUPPRESSED")).toBe("BREACHED");
  });

  it("NOT_APPLICABLE is reserved for a condition with no promise to measure", () => {
    // The value survives — it just no longer means "somebody silenced this".
    // It means the workspace had no policy when the condition qualified, or
    // the stored promise cannot be trusted.
    const noPolicy = projectIncidentSla(
      "SUPPRESSED",
      cycle({
        policyVersionId: null,
        acknowledgementTargetHours: null,
        resolutionTargetHours: null,
        acknowledgementDueAtUtc: null,
        resolutionDueAtUtc: null,
      }),
      at(10_000),
    );
    expect(noPolicy.posture).toBe("NOT_APPLICABLE");
  });
});

// ===========================================================================
// 5. THE REFUSALS
// ===========================================================================

describe("what it refuses to measure", () => {
  it("NO CYCLE is UNTRACKED_LEGACY, not measured against anything", () => {
    const p = projectIncidentSla("OPEN", null, at(10_000));
    expect(p.posture).toBe("UNTRACKED_LEGACY");
    expect(p.dueAtUtc).toBeNull();
    expect(p.targetHours).toBeNull();
    expect(p.policyVersionId).toBeNull();
  });

  it("a cycle with NO TARGETS is NOT_APPLICABLE — the workspace had no policy", () => {
    const p = projectIncidentSla(
      "OPEN",
      cycle({
        policyVersionId: null,
        policyDigest: null,
        acknowledgementTargetHours: null,
        resolutionTargetHours: null,
        acknowledgementDueAtUtc: null,
        resolutionDueAtUtc: null,
      }),
      at(10_000),
    );
    expect(p.posture).toBe("NOT_APPLICABLE");
  });

  it("a CORRUPT cycle is not reported as a breach", () => {
    // A non-positive window is not a strict promise, it is a broken row.
    // Measuring against it would report a breach the instant the condition
    // opened, which is worse than saying nothing.
    for (const bad of [-1, 0]) {
      expect(
        postureAt(1, {
          acknowledgementTargetHours: bad,
          resolutionTargetHours: bad,
        }),
      ).toBe("NOT_APPLICABLE");
    }
  });

  it("neither refusal is ever counted as needing attention", () => {
    expect(SLA_ATTENTION_POSTURES.has("UNTRACKED_LEGACY")).toBe(false);
    expect(SLA_ATTENTION_POSTURES.has("NOT_APPLICABLE")).toBe(false);
    // RESOLVED is an outcome, not work: highlighting it would put finished
    // conditions back in front of the operator.
    expect(SLA_ATTENTION_POSTURES.has("RESOLVED")).toBe(false);
  });
});

// ===========================================================================
// 6. ONE AUTHORITY
// ===========================================================================

describe("one authority", () => {
  const SRC = readFileSync(
    fileURLToPath(
      new URL("../src/services/operations/incident-sla.ts", import.meta.url),
    ),
    "utf8",
  );

  it("the projection reads PERSISTED history and never the live policy", () => {
    // This is the closure. A projection that resolved the policy at read time
    // would be correct until somebody edited it, and then silently wrong
    // about every condition that already existed.
    for (const forbidden of [
      "resolveEffectiveSlaPolicy",
      "workspaceGovernancePolicy",
      "REVIEWER_OPS_DEFAULT_SLA_POLICY",
    ]) {
      expect(
        SRC,
        `the projection must not read the live policy (${forbidden})`,
      ).not.toContain(forbidden);
    }
  });

  it("the projection does not special-case suppression", () => {
    // A branch on SUPPRESSED here is how silence became an SLA escape. The
    // status is still an input — it reaches the function — but nothing may
    // read it to stop a clock.
    const code = SRC.replace(/\/\*[\s\S]*?\*\//g, "").replace(
      /^\s*\/\/.*$/gm,
      "",
    );
    expect(code).not.toContain('"SUPPRESSED"');
  });

  it("carries no hour literals of its own", () => {
    for (const literal of ["= 24", "= 48", "= 72", "= 4;", "DEFAULT_HOURS"]) {
      expect(
        SRC,
        `the projection must not carry its own hours (${literal})`,
      ).not.toContain(literal);
    }
  });

  it("the age heuristic no longer exists as a competing authority", () => {
    const SUMMARY = readFileSync(
      fileURLToPath(
        new URL(
          "../src/services/operations/operations-summary.service.ts",
          import.meta.url,
        ),
      ),
      "utf8",
    );
    // A fixed age threshold beside a real SLA is two answers to "is this
    // late?" on one screen, and the operator cannot tell which to act on.
    const code = SUMMARY.replace(/\/\*[\s\S]*?\*\//g, "").replace(
      /^\s*\/\/.*$/gm,
      "",
    );
    expect(code).not.toContain("UNATTENDED_OVERDUE_HOURS");
    expect(code).not.toContain("overdueBefore");
    // And the counters it publishes come from the shared projection.
    expect(SUMMARY).toContain("projectIncidentSla");
    expect(SUMMARY).toContain("slaBreached");
  });

  it("every declared posture is reachable from some real input", () => {
    const reached = new Set<SlaPosture>([
      projectIncidentSla("OPEN", null, at(1)).posture,
      postureAt(1),
      postureAt(3),
      postureAt(6),
      postureAt(1, { acknowledgedAtUtc: at(1) }, "ACKNOWLEDGED"),
      postureAt(29, { resolvedAtUtc: at(29), endReason: "RESOLVED" }, "RESOLVED"),
      // NOT_APPLICABLE now comes from an absent promise rather than from
      // suppression, which is the correction this closure made.
      projectIncidentSla(
        "OPEN",
        cycle({
          acknowledgementTargetHours: null,
          resolutionTargetHours: null,
          acknowledgementDueAtUtc: null,
          resolutionDueAtUtc: null,
        }),
        at(1),
      ).posture,
    ]);
    // A posture nothing can produce is dead vocabulary the UI must still
    // handle and no operator will ever see.
    for (const p of SLA_POSTURES) {
      expect(reached, `no input produces ${p}`).toContain(p);
    }
  });
});
