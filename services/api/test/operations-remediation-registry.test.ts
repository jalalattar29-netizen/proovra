/**
 * THE REMEDIATION REGISTRY, AND THE TSA SAFETY BOUNDARY.
 *
 * ---------------------------------------------------------------------------
 * WHY THE TSA HALF OF THIS FILE IS NOT NEGOTIABLE
 * ---------------------------------------------------------------------------
 * An RFC3161 timestamp proves a record existed at a moment. Re-contacting the
 * authority for already-finalized evidence would mint a token whose genTime is
 * LATER than the evidence it certifies, and presenting that as the record's
 * timestamp asserts something untrue about when the evidence existed.
 *
 * The product's structure already refuses this, and these tests hold it there:
 * `tsaStatus` is written once, inside the finalize claim, and there is no TSA
 * queue or job in the canonical work registry to re-run. The only repair that
 * exists re-parses bytes already persisted and explicitly never contacts the
 * provider.
 *
 * A test that merely asserted "we did not add a retry button" would pass while
 * somebody added the route. These assert the ABSENCE OF THE AUTHORITY.
 */

import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  REMEDIATION_ACTION_IDS,
  actionById,
  entryForIncident,
  integrityClassOf,
  registeredCategories,
  resolveRemediations,
} from "../src/services/operations/remediation-registry.js";

function read(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
}

const SCHEMA = read("../prisma/schema.prisma");
const EXECUTOR = read("../src/services/operations/remediation-executor.ts");
const REGISTRY = read("../src/services/operations/remediation-registry.ts");
const OPS_ROUTES = read("../src/routes/ops.routes.ts");

/** Every route module, for absence proofs. */
const ALL_ROUTES = (() => {
  const dir = fileURLToPath(new URL("../src/routes/", import.meta.url));
  return readdirSync(dir)
    .filter((f) => f.endsWith(".ts"))
    .map((f) => readFileSync(dir + f, "utf8"))
    .join("\n");
})();

/** Every incident category the schema can emit. */
const CATEGORIES: string[] = (() => {
  const block = SCHEMA.slice(
    SCHEMA.indexOf("enum IncidentCategory {"),
    SCHEMA.indexOf("}", SCHEMA.indexOf("enum IncidentCategory {")),
  );
  return block
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => /^[A-Z_]+$/.test(l));
})();

const ALLOW_ALL = {
  can: () => true,
  hasPermission: () => true,
  workspaceCanMutate: true,
  incidentStatus: "OPEN",
};

// ===========================================================================
// 1. COVERAGE — every emitted type has exactly one disposition
// ===========================================================================

describe("registry coverage", () => {
  it("the schema emits the categories the registry governs", () => {
    expect(CATEGORIES.length).toBeGreaterThan(10);
    expect(new Set(registeredCategories())).toEqual(new Set(CATEGORIES));
  });

  it.each(CATEGORIES)("%s has exactly one disposition", (category) => {
    const entry = entryForIncident({ category, fingerprint: "x:1" });
    expect(entry, `${category} is not governed`).not.toBeNull();
    expect(entry!.disposition).toBeTruthy();
  });

  it("a DIRECT_REMEDIATION entry carries a real action, and no other kind does", () => {
    for (const category of CATEGORIES) {
      const entry = entryForIncident({ category, fingerprint: "x:1" })!;
      if (entry.disposition === "DIRECT_REMEDIATION") {
        expect(entry.action, `${category}`).toBeTruthy();
        expect(REMEDIATION_ACTION_IDS).toContain(entry.action!.actionId);
      } else {
        expect(entry.action, `${category} must not carry an action`).toBeUndefined();
      }
    }
  });

  it("NO_SAFE_REMEDIATION_AUTHORITY always says WHY", () => {
    const tsa = entryForIncident({
      category: "EVIDENCE_INTEGRITY",
      fingerprint: "tsa_failure:abc",
    })!;
    expect(tsa.disposition).toBe("NO_SAFE_REMEDIATION_AUTHORITY");
    expect(tsa.unsafeReason ?? "").toMatch(/genTime|later than the evidence/i);
    expect(tsa.action).toBeUndefined();
  });

  it("an UNKNOWN category fails closed — no entry, no actions", () => {
    expect(entryForIncident({ category: "NOT_A_REAL_CATEGORY", fingerprint: "x:1" }))
      .toBeNull();
    const projected = resolveRemediations(
      { category: "NOT_A_REAL_CATEGORY", fingerprint: "x:1" },
      ALLOW_ALL,
    );
    expect(projected.actions).toEqual([]);
    expect(projected.deepLink).toBeNull();
  });

  it("the two integrity classes have OPPOSITE dispositions", () => {
    // The clearest demonstration that disposition belongs to the CONDITION and
    // not to its category: one category, two fingerprints, two answers.
    expect(integrityClassOf("ots_failure:e1")).toBe("ots_failure");
    expect(integrityClassOf("tsa_failure:e1")).toBe("tsa_failure");
    expect(integrityClassOf("nonsense")).toBeNull();

    const ots = entryForIncident({
      category: "EVIDENCE_INTEGRITY",
      fingerprint: "ots_failure:e1",
    })!;
    expect(ots.disposition).toBe("DIRECT_REMEDIATION");
    expect(ots.action!.actionId).toBe("ots.resume_anchoring");
  });

  it("report and package resolve to ONE action, because they are one pipeline", () => {
    const report = entryForIncident({ category: "REPORT", fingerprint: "x:1" })!;
    const pkg = entryForIncident({ category: "PACKAGE", fingerprint: "x:1" })!;
    expect(report.action!.actionId).toBe("report.regenerate_artifacts");
    expect(pkg.action!.actionId).toBe(report.action!.actionId);
  });
});

// ===========================================================================
// 2. PROJECTION — the client is handed only what it may do
// ===========================================================================

describe("projection is already authorized", () => {
  it("withholds the action when the permission is absent", () => {
    const projected = resolveRemediations(
      { category: "REPORT", fingerprint: "x:1" },
      { ...ALLOW_ALL, can: () => false },
    );
    // ABSENT, not disabled. A disabled control is a promise the surface
    // cannot keep, and it teaches operators that refusals are normal.
    expect(projected.actions).toEqual([]);
  });

  it("withholds the action for a CLOSED condition", () => {
    for (const status of ["RESOLVED", "SUPPRESSED"]) {
      const projected = resolveRemediations(
        { category: "REPORT", fingerprint: "x:1" },
        { ...ALLOW_ALL, incidentStatus: status },
      );
      expect(projected.actions, status).toEqual([]);
    }
  });

  it("withholds the action for a workspace that may not mutate", () => {
    const projected = resolveRemediations(
      { category: "REPORT", fingerprint: "x:1" },
      { ...ALLOW_ALL, workspaceCanMutate: false },
    );
    expect(projected.actions).toEqual([]);
  });

  it("withholds a deep link the reader cannot open", () => {
    const projected = resolveRemediations(
      { category: "WEBHOOK", fingerprint: "x:1" },
      { ...ALLOW_ALL, hasPermission: () => false },
    );
    // Not rendered-and-refused. The header defect this redesign removed was
    // exactly a shortcut to a console the reader is refused from.
    expect(projected.deepLink).toBeNull();
  });

  it("offers the deep link when the reader CAN open it", () => {
    const projected = resolveRemediations(
      { category: "WEBHOOK", fingerprint: "x:1" },
      ALLOW_ALL,
    );
    expect(projected.deepLink?.href).toBe("/integrations");
  });

  it("never offers a platform-admin destination to a tenant", () => {
    for (const category of CATEGORIES) {
      const entry = entryForIncident({ category, fingerprint: "x:1" })!;
      if (!entry.deepLink) continue;
      expect(entry.deepLink.href, category).not.toMatch(/^\/admin\/platform\//);
    }
  });
});

// ===========================================================================
// 3. THE TSA SAFETY BOUNDARY
// ===========================================================================

describe("TSA safety — no provider re-contact exists", () => {
  it("the canonical work registry has NO timestamping job", () => {
    const names = read("../../../packages/shared/src/queue-integrity/names.ts");
    const jobs = names.slice(names.indexOf("export const JOB_NAMES"));
    const block = jobs.slice(0, jobs.indexOf("} as const"));
    expect(block).not.toMatch(/TSA|TIMESTAMP|RFC3161/i);
  });

  it("no route re-contacts a timestamp authority", () => {
    // The MECHANISM, not the word.
    //
    // A bare "rfc3161" substring catches projection fields (`rfc3161Applied:
    // false`, which REPORTS that no timestamp was applied) and prose. Those
    // are the opposite of a provider contact. Contact happens exactly two
    // ways: the `openssl ts` subprocess that builds or parses a token, and an
    // HTTP request to the authority endpoint.
    for (const marker of [
      "openssl",
      "ts -query",
      "ts -reply",
      "execFile",
      "TSA_URL",
    ]) {
      expect(
        ALL_ROUTES.includes(marker),
        `a route must not reach a timestamp provider (${marker})`,
      ).toBe(false);
    }
  });

  it("the only stored-token repair is an operator script, and it never calls out", () => {
    // Recorded because it is the nearest thing to a TSA remediation that
    // exists, and its own header is the reason it is not exposed: it repairs a
    // parser mistake by re-reading bytes already persisted.
    const repair = read("../src/scripts/repair-tsa-failed-with-token.ts");
    expect(repair).toContain("The provider is NEVER re-contacted");
    expect(repair).toContain("never writes a fake success");
    // It is a script, not a route: nothing registers it with Fastify.
    expect(ALL_ROUTES).not.toContain("repair-tsa-failed-with-token");
  });

  it("the executor has no TSA branch at all", () => {
    const code = EXECUTOR.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    for (const marker of ["tsaStatus", "tsaToken", "tsa_failure", "openssl"]) {
      expect(code, `${marker} must not appear in executor code`).not.toContain(marker);
    }
  });

  it("no remediation action id names a TSA retry", () => {
    for (const id of REMEDIATION_ACTION_IDS) {
      expect(id).not.toMatch(/tsa|timestamp|restamp/i);
    }
  });

  it("no user-facing label says Retry TSA or any equivalent", () => {
    const labels: string[] = [];
    for (const id of REMEDIATION_ACTION_IDS) {
      const action = actionById(id)!;
      labels.push(action.label);
    }
    for (const label of labels) {
      expect(label).not.toMatch(/retry tsa|repair tsa|refresh timestamp|restamp|reprocess tsa/i);
    }
    // …and the registry's copy never promises one either.
    expect(REGISTRY).not.toMatch(/"Retry TSA"|'Retry TSA'/);
  });

  it("the TSA disposition offers guidance and a record link, and no control", () => {
    const projected = resolveRemediations(
      { category: "EVIDENCE_INTEGRITY", fingerprint: "tsa_failure:e1" },
      ALLOW_ALL,
    );
    expect(projected.disposition).toBe("NO_SAFE_REMEDIATION_AUTHORITY");
    expect(projected.actions).toEqual([]);
    expect(projected.guidance ?? "").toMatch(/cannot be corrected after the fact/i);
    // The record is still reachable — the operator can see WHICH record.
    expect(projected.deepLink?.href).toBe("/evidence");
  });

  it("the remediation route cannot dispatch anything but the two registered actions", () => {
    // The union is the gate: an unregistered id is refused before a workspace
    // is even looked up, so probing for action names reveals nothing.
    expect(actionById("tsa.retry")).toBeNull();
    expect(actionById("tsa.repair")).toBeNull();
    expect(actionById("")).toBeNull();
    expect(OPS_ROUTES).toContain("unknown_remediation_action");
  });
});

// ===========================================================================
// 4. NO SECOND QUEUE, NO SECOND TRANSPORT
// ===========================================================================

describe("the executor owns no infrastructure", () => {
  it("dispatches only through canonical authorities", () => {
    expect(EXECUTOR).toContain("enqueueCanonicalWork");
    expect(EXECUTOR).toContain("requestReportGeneration");
    // No private producer, no queue literal, no job id construction.
    expect(EXECUTOR).not.toMatch(/new Queue\(/);
    expect(EXECUTOR).not.toMatch(/QUEUE_NAMES\./);
    expect(EXECUTOR).not.toMatch(/jobId:\s*`/);
  });

  it("uses the registered job name rather than a string", () => {
    expect(EXECUTOR).toContain("JOB_NAMES.UPGRADE_OTS");
    expect(EXECUTOR).not.toMatch(/"ots-upgrade"/);
  });

  it("never reports queued work as completed", () => {
    // `SUCCEEDED` is deliberately not in the result vocabulary: nothing this
    // module can observe would justify it.
    expect(REGISTRY).toContain('"QUEUED"');
    const results = REGISTRY.slice(
      REGISTRY.indexOf("export const REMEDIATION_RESULTS"),
      REGISTRY.indexOf("] as const", REGISTRY.indexOf("export const REMEDIATION_RESULTS")),
    );
    expect(results).not.toContain("SUCCEEDED");
    expect(results).not.toContain("COMPLETED");
  });

  it("never resolves an incident by enqueuing", () => {
    const code = EXECUTOR.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    expect(code).not.toMatch(/status:\s*"RESOLVED"/);
    expect(code).not.toContain("resolveIncident");
  });

  it("returns bounded messages, never a provider or database string", () => {
    const code = EXECUTOR.replace(/\/\*[\s\S]*?\*\//g, "");
    for (const leak of ["err.message", "error.message", "String(err)"]) {
      expect(code, `${leak} must not reach the caller`).not.toContain(leak);
    }
  });
});
