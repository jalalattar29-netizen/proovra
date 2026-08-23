/**
 * THE INCIDENT SLA AUTHORITY — its arithmetic and its refusals.
 *
 * The posture resolver is a PURE function over (incident, policy, now), which
 * is the whole reason it is written that way: every case below fixes the
 * instants explicitly, so nothing here passes or fails because of what the
 * clock happened to say during the run.
 *
 * What these cases are actually defending:
 *
 *   - the arithmetic, at both edges of every window, since an off-by-one on a
 *     boundary is invisible in a screenshot and wrong for exactly the rows an
 *     operator is about to be judged on;
 *   - the REFUSALS, which are the part a later pass is most likely to "fix"
 *     into something friendlier and untrue — a suppressed condition that
 *     reports a breach, a MET claimed from a status with no timestamp, or a
 *     posture computed from defaults a workspace never agreed to;
 *   - the SINGLE-AUTHORITY property: the hours come from the canonical
 *     reviewer-ops resolver, and nothing here restates them.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  SLA_ATTENTION_POSTURES,
  SLA_POSTURES,
  projectIncidentSla,
  type IncidentSlaPolicy,
  type SlaPosture,
} from "../src/services/operations/incident-sla.js";

const HOUR = 3_600_000;

/** A deliberately un-round policy, so a hard-coded 24 cannot pass by luck. */
const POLICY: IncidentSlaPolicy = {
  responseHours: 5,
  resolutionHours: 30,
  dueSoonHours: 2,
};

const OPENED = new Date("2026-08-20T00:00:00.000Z");

function at(hoursAfterOpen: number): Date {
  return new Date(OPENED.getTime() + hoursAfterOpen * HOUR);
}

function posture(input: {
  status?: string;
  acknowledgedAfter?: number | null;
  resolvedAfter?: number | null;
  nowAfter: number;
}): SlaPosture {
  return projectIncidentSla(
    {
      status: input.status ?? "OPEN",
      firstSeenAtUtc: OPENED,
      acknowledgedAtUtc:
        input.acknowledgedAfter == null ? null : at(input.acknowledgedAfter),
      resolvedAtUtc: input.resolvedAfter == null ? null : at(input.resolvedAfter),
    },
    POLICY,
    at(input.nowAfter),
  ).posture;
}

describe("incident SLA — the response window", () => {
  it("is ON_TRACK well inside the window", () => {
    expect(posture({ nowAfter: 1 })).toBe("ON_TRACK");
  });

  it("becomes DUE_SOON exactly when the warning lead time is reached", () => {
    // Window 5h, lead time 2h -> the warning begins at 3h, not at 3h+epsilon.
    expect(posture({ nowAfter: 2.99 })).toBe("ON_TRACK");
    expect(posture({ nowAfter: 3 })).toBe("DUE_SOON");
  });

  it("is still DUE_SOON at the deadline itself, and BREACHED only after it", () => {
    // A condition AT its deadline has not yet missed it. Reporting a breach
    // one instant early is a false accusation, and it is the boundary a
    // reader would never notice was wrong.
    expect(posture({ nowAfter: 5 })).toBe("DUE_SOON");
    expect(posture({ nowAfter: 5.01 })).toBe("BREACHED");
  });

  it("measures RESPONSE while unacknowledged, whatever the resolution window says", () => {
    const projected = projectIncidentSla(
      { status: "OPEN", firstSeenAtUtc: OPENED, acknowledgedAtUtc: null, resolvedAtUtc: null },
      POLICY,
      at(6),
    );
    expect(projected.obligation).toBe("RESPONSE");
    expect(projected.targetHours).toBe(POLICY.responseHours);
    // Breached against 5h even though 30h have not elapsed.
    expect(projected.posture).toBe("BREACHED");
  });
});

describe("incident SLA — the handover to resolution", () => {
  it("acknowledgement moves the live obligation to RESOLUTION", () => {
    const projected = projectIncidentSla(
      {
        status: "ACKNOWLEDGED",
        firstSeenAtUtc: OPENED,
        acknowledgedAtUtc: at(2),
        resolvedAtUtc: null,
      },
      POLICY,
      at(6),
    );
    expect(projected.obligation).toBe("RESOLUTION");
    expect(projected.targetHours).toBe(POLICY.resolutionHours);
    // Past the 5h response window, but comfortably inside the 30h one.
    expect(projected.posture).toBe("ON_TRACK");
  });

  it("does NOT restart the clock at acknowledgement", () => {
    // Acknowledged at hour 20, resolved at hour 35. Measured from FIRST SEEN
    // that is late; measured from acknowledgement it would be 15h and look
    // fine. Late acknowledgement must not buy a fresh window.
    const projected = projectIncidentSla(
      {
        status: "RESOLVED",
        firstSeenAtUtc: OPENED,
        acknowledgedAtUtc: at(20),
        resolvedAtUtc: at(35),
      },
      POLICY,
      at(40),
    );
    expect(projected.posture).toBe("MET_LATE");
    expect(projected.dueAtUtc).toBe(at(POLICY.resolutionHours).toISOString());
  });

  it("an acknowledged condition can still breach the resolution window", () => {
    expect(posture({ acknowledgedAfter: 1, nowAfter: 31 })).toBe("BREACHED");
  });
});

describe("incident SLA — discharged obligations", () => {
  it("reports MET when resolved inside the window", () => {
    expect(posture({ resolvedAfter: 29, nowAfter: 100 })).toBe("MET");
  });

  it("reports MET at the deadline exactly, not MET_LATE", () => {
    expect(posture({ resolvedAfter: 30, nowAfter: 100 })).toBe("MET");
    expect(posture({ resolvedAfter: 30.01, nowAfter: 100 })).toBe("MET_LATE");
  });

  it("does not round a late resolution up to MET", () => {
    // The distinction exists so a workspace reviewing its own performance
    // can see that something WAS handled AND that it was handled late.
    // Collapsing the two would make the record flatter than the truth.
    expect(posture({ resolvedAfter: 200, nowAfter: 300 })).toBe("MET_LATE");
  });

  it("a resolved condition answers about RESOLUTION even if never acknowledged", () => {
    const projected = projectIncidentSla(
      {
        status: "RESOLVED",
        firstSeenAtUtc: OPENED,
        acknowledgedAtUtc: null,
        resolvedAtUtc: at(4),
      },
      POLICY,
      at(50),
    );
    // Resolving is a stronger discharge of the same duty; reporting a
    // response breach on something already fixed is true but useless.
    expect(projected.obligation).toBe("RESOLUTION");
    expect(projected.posture).toBe("MET");
  });

  it("a posture is never MET without a recorded instant", () => {
    // A status of RESOLVED with no `resolvedAtUtc` is a record that cannot
    // support the claim. It must fall through to the open-obligation branch
    // rather than assert a success it has no evidence for.
    const projected = projectIncidentSla(
      {
        status: "RESOLVED",
        firstSeenAtUtc: OPENED,
        acknowledgedAtUtc: null,
        resolvedAtUtc: null,
      },
      POLICY,
      at(50),
    );
    expect(projected.posture).not.toBe("MET");
    expect(projected.posture).not.toBe("MET_LATE");
  });
});

describe("incident SLA — what it refuses to measure", () => {
  it("a suppressed condition has NO posture and NO deadline", () => {
    const projected = projectIncidentSla(
      {
        status: "SUPPRESSED",
        firstSeenAtUtc: OPENED,
        acknowledgedAtUtc: null,
        resolvedAtUtc: null,
      },
      POLICY,
      at(10_000),
    );
    // Suppression is the workspace saying "stop telling me". Reporting a
    // breach against it would make the workspace's own decision look broken.
    expect(projected.posture).toBe("NOT_APPLICABLE");
    expect(projected.dueAtUtc).toBeNull();
    expect(projected.targetHours).toBeNull();
  });

  it("suppression wins even over a resolved instant", () => {
    expect(
      posture({ status: "SUPPRESSED", resolvedAfter: 1, nowAfter: 2 }),
    ).toBe("NOT_APPLICABLE");
  });

  it("the deadline is stated so the reader can check the verdict", () => {
    const projected = projectIncidentSla(
      { status: "OPEN", firstSeenAtUtc: OPENED, acknowledgedAtUtc: null, resolvedAtUtc: null },
      POLICY,
      at(1),
    );
    expect(projected.dueAtUtc).toBe(at(POLICY.responseHours).toISOString());
    expect(projected.targetHours).toBe(POLICY.responseHours);
  });
});

describe("incident SLA — one authority", () => {
  const SRC = readFileSync(
    fileURLToPath(
      new URL("../src/services/operations/incident-sla.ts", import.meta.url),
    ),
    "utf8",
  );

  it("takes its hours from the canonical resolver and defines none of its own", () => {
    expect(SRC).toContain("resolveEffectiveSlaPolicy");
    // No literal hour count anywhere: a default typed here would be a second
    // SLA authority that quietly outranked the workspace's own policy.
    for (const literal of ["= 24", "= 48", "= 72", "= 4;", "DEFAULT_HOURS"]) {
      expect(
        SRC,
        `the incident SLA must not carry its own hours (${literal})`,
      ).not.toContain(literal);
    }
  });

  it("yields no posture at all when the workspace policy cannot be resolved", () => {
    // The loader's declared return admits null and its failure path takes
    // it, so an unreadable policy produces NO envelope. Asserted on the
    // signature and the catch rather than on prose, which reflows.
    expect(SRC).toContain("Promise<IncidentSlaPolicy | null>");
    expect(SRC).toMatch(/catch\s*\{[\s\S]{0,400}?return null;/);
    // And the route omits the envelope rather than substituting one.
    const ROUTE = readFileSync(
      fileURLToPath(new URL("../src/routes/ops.routes.ts", import.meta.url)),
      "utf8",
    );
    expect(ROUTE).toContain("if (!policy) return projected;");
  });

  it("the attention set is a subset of the declared postures", () => {
    for (const p of SLA_ATTENTION_POSTURES) {
      expect(SLA_POSTURES).toContain(p);
    }
    // MET/MET_LATE are outcomes, not work: a queue that highlighted them
    // would put finished conditions back in front of the operator.
    expect(SLA_ATTENTION_POSTURES.has("MET")).toBe(false);
    expect(SLA_ATTENTION_POSTURES.has("MET_LATE")).toBe(false);
    expect(SLA_ATTENTION_POSTURES.has("NOT_APPLICABLE")).toBe(false);
  });

  it("every declared posture is reachable from some real input", () => {
    const reached = new Set<SlaPosture>([
      posture({ nowAfter: 1 }),
      posture({ nowAfter: 3 }),
      posture({ nowAfter: 6 }),
      posture({ resolvedAfter: 1, nowAfter: 2 }),
      posture({ resolvedAfter: 200, nowAfter: 300 }),
      posture({ status: "SUPPRESSED", nowAfter: 1 }),
    ]);
    // A posture nothing can produce is a value the UI must still handle and
    // no operator will ever see — dead vocabulary that outlives its reason.
    for (const p of SLA_POSTURES) {
      expect(reached, `no input produces ${p}`).toContain(p);
    }
  });
});
