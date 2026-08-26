/**
 * THE THREE NUMBERS, AND THE SENTENCE THAT NO LONGER CONTAINS ANY OF THEM.
 *
 * ---------------------------------------------------------------------------
 * WHAT PRODUCTION ACTUALLY LOOKED LIKE
 * ---------------------------------------------------------------------------
 * The grouped queue rendered, verbatim:
 *
 *     Report backlog above threshold (26)
 *     Verification package backlog above threshold (69)
 *     Queue telemetry sampler delayed (902m)
 *     Retry storm pattern detected (36 repeat incidents)
 *
 * and beneath them, as metadata:
 *
 *     1 condition
 *     26 occurrences
 *     34 conditions - 34 affected records
 *
 * Five distinct quantities are in that list and the surface distinguished
 * none of them: how many incidents there are, how many real records they stand
 * for, what the threshold is, how many times the source was re-observed, and
 * how much time has elapsed. Two of them appeared twice under different names,
 * one was an elapsed time formatted as an identity, and one — the threshold —
 * could not be seen at all without opening the condition.
 *
 * Worse, four of those numbers were INSIDE A TITLE. A title is written once,
 * when the condition opens, and no writer rewrote it; a workspace that worked
 * its backlog down to 22 kept reading 26 for as long as the condition existed.
 *
 * ---------------------------------------------------------------------------
 * WHAT THESE CASES HOLD
 * ---------------------------------------------------------------------------
 * That the label comes from the SOURCE and carries no number; that the numbers
 * come from the structured metric and are named individually; and — the part
 * that is easy to lose — that nothing anywhere parses a number back out of a
 * stored title to get there.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  buildConditionMetric,
  conditionDisplayLabel,
  lifecycleForSourceId,
  OPERATIONS_SOURCE_LIFECYCLES,
  resolveConditionSource,
} from "@proovra/shared-runtime";

import { projectIncident } from "../src/services/observability/incident.service.js";
import {
  projectConditionGroups,
  type GroupableCondition,
} from "../src/services/operations/operations-grouping.service.js";

const REPO = fileURLToPath(new URL("../../..", import.meta.url));

const NOW = new Date("2026-08-26T12:00:00.000Z");

const TEAM = "22222222-2222-4222-8222-222222222222";

/** A persisted row, as `projectIncident` receives it. */
function row(over: Record<string, unknown>) {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    teamId: TEAM,
    category: "REPORT",
    severity: "HIGH",
    status: "OPEN",
    title: "a stored title",
    safeSummary: "...",
    fingerprint: `dashboard:pipeline:report_backlog:${TEAM}`,
    sourceId: null,
    occurrenceCount: 4,
    firstSeenAtUtc: NOW,
    lastSeenAtUtc: NOW,
    requestId: null,
    traceId: null,
    relatedEvidenceId: null,
    relatedJobId: null,
    relatedProvider: null,
    runbookSlug: null,
    acknowledgedByUserId: null,
    resolvedByUserId: null,
    acknowledgedAtUtc: null,
    resolvedAtUtc: null,
    assignedOperatorUserId: null,
    assignedAtUtc: null,
    metricSnapshot: null,
    ...over,
  } as never;
}

/** One groupable condition, with sane defaults. */
function condition(over: Partial<GroupableCondition>): GroupableCondition {
  return {
    id: "c-1",
    category: "REPORT",
    fingerprint: "dashboard:pipeline:report_backlog:t1",
    severity: "HIGH",
    status: "OPEN",
    title: "Report backlog above threshold (26)",
    safeSummary: "...",
    firstSeenAtUtc: NOW,
    lastSeenAtUtc: NOW,
    occurrenceCount: 1,
    relatedEvidenceId: null,
    assignedOperatorUserId: null,
    sourceId: "pipeline.report_backlog",
    ...over,
  };
}

function metric(
  over: Partial<Parameters<typeof buildConditionMetric>[0]> = {},
) {
  return buildConditionMetric({
    currentValue: 26,
    thresholdValue: 20,
    criticalThresholdValue: 60,
    unit: "records",
    observedAtUtc: NOW,
    affectedEntityType: "evidence",
    ...over,
  });
}

// ===========================================================================
// SECTION 1 — COUNT-FREE LABELS, FROM SOURCE IDENTITY
// ===========================================================================

describe("the label is the source's, and carries no count", () => {
  it("prints the label table", () => {
    // eslint-disable-next-line no-console -- the label table IS the deliverable
    console.table(
      OPERATIONS_SOURCE_LIFECYCLES.map((s) => ({
        sourceId: s.sourceId,
        displayLabel: s.displayLabel,
      })),
    );
    expect(OPERATIONS_SOURCE_LIFECYCLES.length).toBeGreaterThan(30);
  });

  it("no registered source's label contains a digit", () => {
    // The registry throws at load if one does. Asserted here because the
    // CONSEQUENCE lives on this surface: a digit in a label is a value put
    // back somewhere nothing can refresh it.
    const offenders = OPERATIONS_SOURCE_LIFECYCLES.filter((s) =>
      /[0-9]/.test(s.displayLabel),
    ).map((s) => `${s.sourceId}: ${s.displayLabel}`);
    expect(offenders, offenders.join("\n")).toEqual([]);
  });

  it("no registered label reproduces one of the four defect titles", () => {
    for (const s of OPERATIONS_SOURCE_LIFECYCLES) {
      expect(s.displayLabel, s.sourceId).not.toMatch(/above threshold/i);
      expect(s.displayLabel, s.sourceId).not.toMatch(/\(\s*\d/);
    }
  });

  it("A LEGACY ROW WITH A COUNT-BEARING TITLE PROJECTS THE COUNT-FREE LABEL", () => {
    // The exact row shape production carries: no `source_id` (written before
    // the column existed) and a title with the value baked in.
    const projected = projectIncident(
      row({ sourceId: null, title: "Report backlog above threshold (26)" }),
    );
    expect(projected.title).toBe("Report generation backlog");
    expect(projected.title).not.toMatch(/[0-9]/);
    // Traced through the LEGACY FINGERPRINT, which is how a row written before
    // the column reaches its contract at all.
    expect(projected.lifecycle.sourceMatch).toBe("LEGACY_FINGERPRINT");
    expect(projected.lifecycle.sourceId).toBe("pipeline.report_backlog");
  });

  it("...and so does the telemetry row whose title carried an elapsed time", () => {
    const projected = projectIncident(
      row({
        category: "WORKER",
        fingerprint: `dashboard:telemetry:queue_stale:${TEAM}`,
        title: "Queue telemetry sampler delayed (902m)",
      }),
    );
    expect(projected.title).toBe("Queue telemetry sampler delayed");
    expect(projected.title).not.toMatch(/902/);
    // The CONTRACT travels with it, so the browser knows the number it will
    // receive is an age and not a population.
    expect(projected.lifecycle.metricContract).toBe("AGE_THRESHOLD");
  });

  it("a row with a DECLARED source uses its label too", () => {
    const projected = projectIncident(
      row({
        sourceId: "queue.retry_storm",
        category: "WORKER",
        fingerprint: `dashboard:reliability:retry_storms:${TEAM}`,
        title: "Retry storm pattern detected (36 repeat incidents)",
      }),
    );
    expect(projected.title).toBe("Queue retry storm");
    expect(projected.lifecycle.sourceMatch).toBe("DECLARED");
  });

  it("AN UNREGISTERED ROW KEEPS ITS STORED TITLE", () => {
    // Deliberate. The stored sentence is the only description of it that
    // exists, and replacing it with a generic placeholder would lose
    // information without gaining any safety — the safety is in the LIFECYCLE,
    // which fails closed regardless of what the row is called.
    const projected = projectIncident(
      row({
        sourceId: null,
        category: "GOVERNANCE",
        fingerprint: "nothing:claims:this",
        title: "Something nobody registered",
      }),
    );
    expect(projected.title).toBe("Something nobody registered");
    expect(projected.lifecycle.sourceMatch).toBe("UNREGISTERED");
    expect(projected.lifecycle.resolutionAuthority).toBe("NO_DIRECT_RESOLUTION");
  });

  it("conditionDisplayLabel is total over the three match kinds", () => {
    const declared = resolveConditionSource({ sourceId: "queue.retry_storm" });
    expect(conditionDisplayLabel(declared, "stored")).toBe("Queue retry storm");

    const legacy = resolveConditionSource({
      fingerprint: "dashboard:pipeline:report_backlog:t1",
    });
    expect(legacy.match).toBe("LEGACY_FINGERPRINT");
    expect(conditionDisplayLabel(legacy, "stored")).toBe(
      "Report generation backlog",
    );

    const unknown = resolveConditionSource({ fingerprint: "unclaimed:x" });
    expect(conditionDisplayLabel(unknown, "stored")).toBe("stored");
  });
});

// ===========================================================================
// SECTION 1b — NOTHING PARSES A NUMBER OUT OF A TITLE
// ===========================================================================

describe("titles are never a metric authority", () => {
  it("no production module extracts digits from an incident title", () => {
    const files = execFileSync(
      "git",
      [
        "ls-files",
        "services/api/src",
        "services/worker/src",
        "apps/web/app",
        "packages/shared-runtime/src",
      ],
      { cwd: REPO, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
    )
      .split("\n")
      .map((f) => f.trim())
      .filter((f) => /\.(ts|tsx)$/.test(f) && !f.endsWith(".d.ts"));

    const offenders: string[] = [];
    for (const rel of files) {
      const src = readFileSync(`${REPO}/${rel}`, "utf8")
        // Comments quote the old titles in order to explain what was removed.
        .replace(/\/\*[\s\S]*?\*\//g, " ")
        .replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");
      // A `match`, a `parseInt` or a `Number(` applied to something called a
      // title. This is the shape the correction must never grow back: deriving
      // a CURRENT value from a string written months ago.
      if (
        /\btitle\b[^\n]{0,60}\.match\(/.test(src) ||
        /(parseInt|parseFloat|Number)\s*\(\s*[a-zA-Z_$.]*[Tt]itle/.test(src)
      ) {
        offenders.push(rel);
      }
    }
    expect(
      offenders,
      `modules parsing numbers out of a title:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });
});

// ===========================================================================
// SECTION 3 — AFFECTED RECORDS, THRESHOLDS AND OBSERVATIONS ARE THREE FIELDS
// ===========================================================================

describe("the three quantities are distinct fields", () => {
  it("an aggregate group separates 1 condition, 26 records, 4 observations, threshold 20", () => {
    const [g] = projectConditionGroups([
      condition({ occurrenceCount: 4, metric: metric() }),
    ]);
    expect(g.conditionCount).toBe(1);
    expect(g.affectedRecordCount).toBe(26);
    expect(g.affectedUnit).toBe("records");
    expect(g.observations).toBe(4);
    expect(g.metric?.thresholdValue).toBe(20);
    expect(g.metric?.criticalThresholdValue).toBe(60);
    expect(g.metric?.contract).toBe("AGGREGATE_THRESHOLD");
    // The label carries none of them.
    expect(g.title).toBe("Report generation backlog");
    expect(g.title).not.toMatch(/[0-9]/);
  });

  it("A RETRY-STORM GROUP COUNTS CONDITIONS, NOT RECORDS", () => {
    // The unit used to be hard-coded "records" on BOTH sides — server and
    // browser — so this group said "36 affected records" about thirty-six
    // repeatedly-observed conditions, and an operator who went looking for
    // thirty-six affected evidence records would have found none.
    const [g] = projectConditionGroups([
      condition({
        category: "WORKER",
        sourceId: "queue.retry_storm",
        fingerprint: "dashboard:reliability:retry_storms:t1",
        title: "Retry storm pattern detected (36 repeat incidents)",
        metric: metric({
          currentValue: 36,
          thresholdValue: 1,
          criticalThresholdValue: 3,
          unit: "conditions",
        }),
      }),
    ]);
    expect(g.affectedRecordCount).toBe(36);
    expect(g.affectedUnit).toBe("conditions");
    expect(g.metric?.unit).toBe("conditions");
    expect(g.title).toBe("Queue retry storm");
  });

  it("AN AGE IS A DURATION, NOT A POPULATION", () => {
    const [g] = projectConditionGroups([
      condition({
        category: "WORKER",
        sourceId: "platform.telemetry_stale",
        fingerprint: "dashboard:telemetry:queue_stale:t1",
        title: "Queue telemetry sampler delayed (902m)",
        metric: metric({
          currentValue: 902,
          thresholdValue: 15,
          criticalThresholdValue: 60,
          unit: "minutes",
        }),
      }),
    ]);
    // NOT 902 affected records. The old rule — "everything that is not
    // EVIDENCE_INTEGRITY sums the metric into affectedRecordCount" — reported
    // fifteen hours as a population of nine hundred and two.
    expect(g.affectedRecordCount).toBeNull();
    expect(g.affectedUnit).toBeNull();
    expect(g.durationSeconds).toBe(902 * 60);
    expect(g.metric?.contract).toBe("AGE_THRESHOLD");
  });

  it("a per-record group's affected count is its member count, in records", () => {
    const members = Array.from({ length: 34 }, (_, i) =>
      condition({
        id: `evidence-${String(i).padStart(3, "0")}`,
        category: "EVIDENCE_INTEGRITY",
        sourceId: "evidence_integrity.tsa_failed",
        fingerprint: `tsa_failure:evidence-${String(i).padStart(3, "0")}`,
        title: "Trusted timestamp missing",
        occurrenceCount: 2,
      }),
    );
    const [g] = projectConditionGroups(members);
    expect(g.conditionCount).toBe(34);
    expect(g.affectedRecordCount).toBe(34);
    expect(g.affectedUnit).toBe("records");
    // The THIRD number, and it is not either of the other two.
    expect(g.observations).toBe(68);
    expect(g.metric).toBeNull();
    expect(g.durationSeconds).toBeNull();
  });

  it("a group with no metric reports NULL, never a misleading zero", () => {
    const [g] = projectConditionGroups([
      condition({
        category: "IDENTITY_SECURITY",
        sourceId: "identity.security_condition",
        fingerprint: "identity:security_event:SUSPICIOUS_LOGIN",
        title: "Repeated failed sign-ins",
      }),
    ]);
    expect(g.affectedRecordCount).toBeNull();
    expect(g.durationSeconds).toBeNull();
    expect(g.metric).toBeNull();
  });

  it("a STALE metric says so rather than presenting old values as current", () => {
    const stale = { ...metric(), stale: true };
    const [g] = projectConditionGroups([condition({ metric: stale })]);
    expect(g.metric?.stale).toBe(true);
    expect(g.metric?.currentValue).toBe(26);
    expect(g.lastObservedAtUtc).toBe(NOW.toISOString());
  });

  it("the group label does not change when a second condition appears", () => {
    // It used to: a group of one rendered its member's stored title and a
    // group of two rendered a counted heading, so a source's row rewrote
    // itself the moment a second condition opened and rewrote itself back when
    // one recovered.
    const first = condition({
      id: "a",
      category: "EVIDENCE_INTEGRITY",
      sourceId: "evidence_integrity.tsa_failed",
      fingerprint: "tsa_failure:evidence-001",
      title: "Trusted timestamp missing for record aaa",
    });
    const second = condition({
      id: "b",
      category: "EVIDENCE_INTEGRITY",
      sourceId: "evidence_integrity.tsa_failed",
      fingerprint: "tsa_failure:evidence-002",
      title: "Trusted timestamp missing for record bbb",
    });
    const one = projectConditionGroups([first]);
    const two = projectConditionGroups([first, second]);
    expect(one[0].title).toBe(two[0].title);
    expect(one[0].title).toBe(
      lifecycleForSourceId("evidence_integrity.tsa_failed")!.displayLabel,
    );
  });
});
