/**
 * ADM-013 — THE DIAGNOSTIC SUMMARY READER.
 *
 * ===========================================================================
 * WHAT THIS PROTECTS
 * ===========================================================================
 * The summary is what gets printed on a shared screen during an incident
 * review, so the two ways it can fail are:
 *
 *   1. it prints something it should not — an id, an email, a domain, a
 *      per-workspace row, one person's activity;
 *   2. it prints a confident set of numbers when the capture was truncated or
 *      a section failed, and the reader takes a missing number for a zero.
 *
 * Both are tested here against a synthetic document that deliberately contains
 * bait: pseudonyms, an email domain, a per-workspace distribution and a traced
 * account. If any of that reaches stdout, these fail.
 *
 * The reader is also asserted to be READ-ONLY and dependency-free: it must run
 * inside a production container piped from stdin, where nothing from
 * node_modules is guaranteed to resolve for a file dropped into /tmp.
 */

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const API_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const READER = resolve(API_ROOT, "scripts/proovra-diagnostic-summary.cjs");
const SOURCE = readFileSync(READER, "utf8");

/**
 * A document shaped exactly like the diagnostic's output, seeded with values
 * that must NOT appear in the summary.
 */
const BAIT = {
  workspacePseudonym: "ws-0a1b2c3d4e5f6071",
  emailDomain: "very-distinctive-customer-domain.example",
  incidentSourceId: "evidence_integrity_source_marker",
};

function makeDoc(over: Record<string, unknown> = {}) {
  return {
    diagnostic: {
      name: "proovra-diagnostic",
      version: "1.0.0",
      sourceSha256: "a".repeat(64),
      sourceFile: "proovra-diagnostic.cjs",
      generatedAtUtc: "2026-09-01T00:00:00.000Z",
      database: "some_production_db",
      readOnly: true,
      sectionsFailed: [],
      complete: true,
      ...over,
    },
    sections: {
      incidents: {
        ok: true,
        total: 412,
        byStatus: { OPEN: 133, ACKNOWLEDGED: 9, RESOLVED: 270 },
        duplicates: {
          workspaceScoped: { groups: 4, excess: 7 },
          platformScoped: { groups: 11, excess: 63 },
        },
        sharedConditionsAcrossWorkspaces: [
          { sourceId: BAIT.incidentSourceId, workspaces: 3, rows: 9 },
        ],
        unresolvedByWorkspace: {
          workspacesWithUnresolved: 12,
          distribution: [{ workspace: BAIT.workspacePseudonym, unresolved: 40 }],
        },
        historicalStillOpen: { notSeenIn30Days: 58, oldestOpen: null },
      },
      signals: {
        ok: true,
        openIncidents: 133,
        incidentBackedSignals: 100,
        incidentBackedTruncated: true,
        additionalSignals: { total: 6 },
        distinctAttentionItems: 139,
      },
      evidenceHealth: {
        ok: true,
        cohorts: {
          tsaFailedOnly: 30,
          signedWithoutReportOnly: 12,
          both: 4,
          distinctAffectedEvidence: 46,
          tsaFailedTotal: 34,
          signedWithoutReportTotal: 16,
        },
        arithmeticCheck: { expectedUnion: 46, measuredUnion: 46, agrees: true },
        ageBuckets: {
          under1Day: 1,
          oneToSevenDays: 5,
          sevenToThirtyDays: 10,
          overThirtyDays: 30,
        },
        workspaceDistribution: [
          { workspace: BAIT.workspacePseudonym, affected: 22 },
        ],
        otsAnchoringFailed: 3,
      },
      runtime: {
        ok: true,
        workerTelemetry: [{ workerKind: "report", queueDepth: 2 }],
        searchDocumentRows: 9182,
        searchAuditLogTablePresent: true,
        schemaObjects: {
          tsv_column: false,
          tsv_gin: false,
          free_text_index: true,
          platform_incident_uk: false,
        },
        migrations: { applied: 221, unfinished: 0 },
      },
      tracedAccount: {
        ok: true,
        requested: true,
        resolved: true,
        emailDomain: BAIT.emailDomain,
        user: BAIT.workspacePseudonym,
        activity: { logins: 14, evidenceCreated: 3 },
      },
    },
  };
}

function run(input: string) {
  const r = spawnSync(process.execPath, [READER], {
    input,
    encoding: "utf8",
    timeout: 30_000,
  });
  // spawnSync blocks the worker, so a timeout cannot fire while it runs —
  // assert the child actually RAN before asserting what it said.
  expect(r.error, `the reader did not run: ${r.error?.message}`).toBeUndefined();
  expect(typeof r.status, "the reader produced no exit code").toBe("number");
  return r;
}

describe("diagnostic summary reader — what it refuses", () => {
  it("refuses empty input rather than printing an empty platform", () => {
    const r = run("");
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/empty/i);
    expect(r.stdout).toBe("");
  });

  it("refuses a truncated capture and says that is what it looks like", () => {
    const full = JSON.stringify(makeDoc());
    const r = run(full.slice(0, Math.floor(full.length * 0.6)));
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/truncated/i);
    // A truncated document must produce NO numbers at all. A partial summary
    // is the failure mode this whole exercise exists to prevent.
    expect(r.stdout).toBe("");
  });

  it("refuses a document that is not a diagnostic", () => {
    const r = run(JSON.stringify({ hello: "world" }));
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/not a proovra-diagnostic/i);
  });

  it("refuses an output version it was not written for", () => {
    const r = run(JSON.stringify(makeDoc({ version: "2.0.0" })));
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/not supported/i);
    expect(r.stderr).toMatch(/raw document/i);
  });
});

describe("diagnostic summary reader — what it prints", () => {
  it("exits 0 and reports the identity of the document", () => {
    const r = run(JSON.stringify(makeDoc()));
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("a".repeat(64));
    expect(r.stdout).toContain("some_production_db");
    expect(r.stdout).toContain("2026-09-01T00:00:00.000Z");
  });

  it("prints the distinct affected count and warns against adding the two totals", () => {
    const r = run(JSON.stringify(makeDoc()));
    expect(r.stdout).toMatch(/DISTINCT affected records\s*:\s*46/);
    // The two raw totals are shown, but only alongside the statement that they
    // overlap. Printing 34 and 16 without that line is how "50" was born.
    expect(r.stdout).toMatch(/OVERLAP by 4/);
    expect(r.stdout).toMatch(/must not be added/i);
  });

  it("prints distinct attention items, not the double-counted sum", () => {
    const r = run(JSON.stringify(makeDoc()));
    expect(r.stdout).toMatch(/Distinct attention items\s*:\s*139/);
    expect(r.stdout).toMatch(/ARE the open incidents/);
    // 133 + 100 + 6 = 239 is the number a reader would reach by adding what
    // the old surfaces displayed.
    expect(r.stdout).not.toContain("239");
  });

  it("says when the incident-backed signal count is capped", () => {
    const r = run(JSON.stringify(makeDoc()));
    expect(r.stdout).toMatch(/capped at 100/);
  });

  it("surfaces the convergence precondition", () => {
    const r = run(JSON.stringify(makeDoc()));
    // Until the partial unique index exists, platform-scoped duplicates can
    // still be created while remediation is in flight.
    expect(r.stdout).toMatch(/Platform incident unique index\s*:\s*ABSENT/);
  });

  it("reports a disagreeing arithmetic check as unreliable", () => {
    const doc = makeDoc();
    (doc.sections.evidenceHealth as Record<string, unknown>).arithmeticCheck = {
      expectedUnion: 46,
      measuredUnion: 44,
      agrees: false,
    };
    const r = run(JSON.stringify(doc));
    expect(r.stdout).toMatch(/DISAGREES/);
    expect(r.stdout).toMatch(/unreliable/i);
  });
});

describe("diagnostic summary reader — incompleteness is loud", () => {
  it("a failed section is named, not skipped, and is not a zero", () => {
    const doc = makeDoc({ complete: false, sectionsFailed: ["evidenceHealth"] });
    doc.sections.evidenceHealth = {
      ok: false,
      error: "connection terminated",
    } as never;
    const r = run(JSON.stringify(doc));

    expect(r.status, "an incomplete capture must not exit 0").toBe(1);
    expect(r.stdout).toMatch(/Not read: connection terminated/);
    expect(r.stdout).toMatch(/This is NOT a zero/);
    expect(r.stdout).toMatch(/AT LEAST ONE SECTION FAILED/);
  });

  it("an unconnected worker telemetry read is not a healthy queue", () => {
    const doc = makeDoc();
    (doc.sections.runtime as Record<string, unknown>).workerTelemetry = null;
    const r = run(JSON.stringify(doc));
    expect(r.stdout).toMatch(/UNMEASURED, not healthy/);
    expect(r.stdout).not.toMatch(/Worker telemetry rows\s*:\s*0/);
  });
});

describe("diagnostic summary reader — the disclosure boundary", () => {
  it("prints no identifier, pseudonym, domain or per-workspace row", () => {
    const r = run(JSON.stringify(makeDoc()));
    for (const [what, value] of Object.entries(BAIT)) {
      expect(
        r.stdout,
        `the summary printed ${what} — this output is read on shared screens`,
      ).not.toContain(value);
    }
    // And the per-workspace figures themselves, which identify a customer by
    // shape even without a name attached.
    expect(r.stdout).not.toMatch(/unresolved:\s*40/);
    expect(r.stdout).not.toMatch(/affected:\s*22/);
  });

  it("says a trace resolved without saying what the person did", () => {
    const r = run(JSON.stringify(makeDoc()));
    expect(r.stdout).toMatch(/Resolved to exactly one account/);
    expect(r.stdout).toMatch(/withheld/i);
    expect(r.stdout).not.toContain("14");
    expect(r.stdout).not.toMatch(/evidenceCreated/);
  });

  it("states the omission, so a reader knows the summary is not the document", () => {
    const r = run(JSON.stringify(makeDoc()));
    expect(r.stdout).toMatch(/omits every identifier/i);
  });
});

describe("diagnostic summary reader — it can run where it has to", () => {
  it("requires nothing from node_modules", () => {
    // It is dropped into /tmp inside a production container and piped from
    // stdin. Anything but a node: builtin would fail to resolve there.
    const requires = [...SOURCE.matchAll(/require\((["'])(.+?)\1\)/g)].map(
      (m) => m[2],
    );
    expect(requires.length).toBeGreaterThan(0);
    for (const r of requires) {
      expect(r, `${r} is not a node: builtin`).toMatch(/^node:/);
    }
  });

  it("writes nothing and executes nothing", () => {
    // A "summary" tool that could write is a tool somebody will eventually run
    // against production with a typo.
    for (const forbidden of [
      "writeFileSync",
      "appendFileSync",
      "unlinkSync",
      "child_process",
      "$executeRaw",
      "exec(",
    ]) {
      expect(
        SOURCE,
        `the reader references ${forbidden}`,
      ).not.toContain(forbidden);
    }
  });

  it("reads stdin when given no path", () => {
    // The whole point: `docker exec -i "$API" node /tmp/reader.cjs < diag.json`
    // needs no Node on the host and no file inside the container.
    expect(SOURCE).toMatch(/readFileSync\(0, "utf8"\)/);
  });
});
