/**
 * ATTENTION ARCHITECTURE — PHASE 4D (2026-08-22).
 * ENTERPRISE COMMAND CENTER DECOMPOSITION.
 *
 * The Command Center was a SECOND product architecture: one page answering
 * every question the rest of the product answers, from its own computations,
 * with its own vocabularies. This suite holds the decomposition:
 *
 *   1. EVERY section has exactly one final owner, recorded in
 *      `docs/architecture/command-center-decomposition.json`. No section is
 *      orphaned and none is invented — the registry and the code agree.
 *   2. The duplicate general-Operations computation is GONE. `runOperationalPressure`
 *      projects the canonical summary and the canonical condition list; it
 *      does not scan a dozen domain tables and rank them itself.
 *   3. Security-specialised sections stay Security-owned.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

function readSource(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
}

const CC_SERVICE = readSource(
  "../src/services/dashboard/command-center.service.ts",
);

type Section = {
  owner: string;
  disposition: string;
  destination?: string;
  authority: string;
  note: string;
};

const REGISTRY = JSON.parse(
  readSource("../../../docs/architecture/command-center-decomposition.json"),
) as { sections: Record<string, Section> };

const OWNERS = [
  "HOME",
  "OPERATIONS",
  "SECURITY",
  "ANALYTICS",
  "PLATFORM",
  "DOMAIN",
  "REMOVE",
];

/**
 * The section keys the envelope actually declares, read out of the service's
 * `CommandCenterEnvelope["sections"]` shape. Derived rather than typed out, so
 * a new section cannot be added without this suite noticing.
 */
function declaredSections(): string[] {
  const start = CC_SERVICE.indexOf("  sections: {");
  expect(start).toBeGreaterThan(0);
  // The envelope's `sections` object closes at the first `\n  };` after it.
  const end = CC_SERVICE.indexOf("\n  };", start);
  expect(end).toBeGreaterThan(start);
  const block = CC_SERVICE.slice(start, end);
  // Top-level keys are indented exactly four spaces inside `sections: {`.
  const keys = [...block.matchAll(/^ {4}([a-zA-Z][a-zA-Z0-9]*): \{/gm)].map(
    (m) => m[1],
  );
  return [...new Set(keys)];
}

// ============================================================================
// 4D.6 — no feature loss: every section is accounted for
// ============================================================================

describe("Phase 4D.6 — every section has exactly one owner", () => {
  const SECTIONS = declaredSections();

  it("discovers a realistic number of sections", () => {
    expect(SECTIONS.length).toBeGreaterThanOrEqual(25);
  });

  it("every declared section appears in the decomposition registry", () => {
    const missing = SECTIONS.filter((s) => !REGISTRY.sections[s]);
    expect(
      missing,
      `Command Center sections with no recorded owner:\n${missing.join("\n")}`,
    ).toEqual([]);
  });

  it("the registry names no section that does not exist", () => {
    const phantom = Object.keys(REGISTRY.sections).filter(
      (s) => !SECTIONS.includes(s),
    );
    expect(
      phantom,
      `registry entries with no corresponding section:\n${phantom.join("\n")}`,
    ).toEqual([]);
  });

  it("every owner is one of the seven, and every entry names an authority", () => {
    for (const [name, section] of Object.entries(REGISTRY.sections)) {
      expect(OWNERS, `${name} has an unknown owner`).toContain(section.owner);
      expect(section.authority.length, `${name} names no authority`).toBeGreaterThan(
        5,
      );
      expect(section.note.length, `${name} has no rationale`).toBeGreaterThan(20);
    }
  });

  it("a moved section names where it went", () => {
    for (const [name, section] of Object.entries(REGISTRY.sections)) {
      if (section.disposition === "move" || section.disposition === "link") {
        expect(
          section.destination,
          `${name} is ${section.disposition} but names no destination`,
        ).toBeTruthy();
      }
    }
  });
});

// ============================================================================
// 4D.1 — the duplicate Operations authority is gone
// ============================================================================

describe("Phase 4D.1 — Command Center projects Operations, never computes it", () => {
  /** The body of `runOperationalPressure`, isolated. */
  function pressureBody(): string {
    const start = CC_SERVICE.indexOf("async function runOperationalPressure(");
    expect(start).toBeGreaterThan(0);
    const end = CC_SERVICE.indexOf("\n}\n", start);
    expect(end).toBeGreaterThan(start);
    return CC_SERVICE.slice(start, end);
  }

  it("reads the canonical summary for its counts", () => {
    const body = pressureBody();
    expect(body).toContain("buildOperationsSummary({ workspaceId: teamId })");
    expect(body).toMatch(/critical: summary\.critical/);
    expect(body).toMatch(/high: summary\.high/);
    expect(body).toMatch(/warning: summary\.warning/);
    expect(body).toMatch(/info: summary\.info/);
  });

  it("reads the canonical condition list for its rows", () => {
    expect(pressureBody()).toMatch(/await listIncidents\(\{/);
  });

  it("no longer runs its own domain scans", () => {
    const body = pressureBody();
    // The dozen bespoke scans that made it a second authority.
    for (const scan of [
      "prisma.evidenceReviewWorkflow.findMany",
      "prisma.evidence.findMany",
      "prisma.evidenceReviewEscalation",
      "prisma.upload",
      "prisma.governanceNotification",
    ]) {
      expect(body, `pressure must not scan ${scan} itself`).not.toContain(scan);
    }
  });

  it("does not maintain a second severity ranking or cap", () => {
    const body = pressureBody();
    expect(body).not.toContain("SEVERITY_RANK");
    expect(body).not.toContain("PRESSURE_PER_KIND");
    // ONE translation from the incident vocabulary, so a CRITICAL condition
    // cannot read differently here than it does on /operations.
    expect(body).toContain("SEVERITY_FROM_INCIDENT");
  });

  it("deep-links into the canonical surface rather than acting in place", () => {
    const body = pressureBody();
    expect(body).toMatch(/href: `\/operations\?incidentId=/);
    for (const mutation of [
      "acknowledgeIncident",
      "resolveIncident",
      "suppressIncident",
      "assignIncident",
    ]) {
      expect(body, `Command Center must not ${mutation}`).not.toContain(
        mutation,
      );
    }
  });

  it("an unreadable summary is UNAVAILABLE, never a healthy set of zeros", () => {
    const body = pressureBody();
    expect(body).toMatch(/status: "unavailable"/);
    expect(body).toMatch(/incompleteReason === "SOURCE_FAILED"/);
    // A bounded read is degraded, not ok — the section shows a floor and
    // says so.
    expect(body).toMatch(
      /summary\.complete && page\.complete \? "ok" : "degraded"/,
    );
  });
});

// ============================================================================
// 4D.3 — Security keeps its decisions
// ============================================================================

describe("Phase 4D.3 — security-specialised sections stay Security-owned", () => {
  it("every security section is owned by SECURITY and only linked", () => {
    for (const name of [
      "accessSecurityAnomalies",
      "accessSecurityClassifier",
      "custodyIntegrityAnomalies",
      "deepIntegrityWatch",
    ]) {
      const section = REGISTRY.sections[name];
      expect(section, `${name} must be registered`).toBeTruthy();
      expect(section.owner).toBe("SECURITY");
      expect(section.disposition).toBe("link");
      expect(section.destination).toBe("/security-center");
    }
  });

  it("no security section was reassigned to OPERATIONS", () => {
    const misfiled = Object.entries(REGISTRY.sections)
      .filter(
        ([name, s]) =>
          /security|custody/i.test(name) && s.owner === "OPERATIONS",
      )
      .map(([name]) => name);
    expect(misfiled).toEqual([]);
  });
});

// ============================================================================
// 4D.4 / 4D.5 — analytics and platform destinations
// ============================================================================

describe("Phase 4D.4/4D.5 — analytics and platform sections leave the page", () => {
  it("intelligence sections go to the canonical analytics surfaces", () => {
    for (const name of [
      "organizationalIntelligence",
      "investigationIntelligence",
      "relationshipIntelligence",
      "predictiveRisk",
      "operationalGraph",
      "organizationalHealth",
    ]) {
      const section = REGISTRY.sections[name];
      expect(section, `${name} must be registered`).toBeTruthy();
      expect(section.owner).toBe("ANALYTICS");
      expect(section.destination?.startsWith("/")).toBe(true);
      // No new analytics product was invented — every destination is an
      // existing canonical surface.
      expect([
        "/intelligence",
        "/investigation",
        "/investigation/relationships",
        "/investigation/graph",
        "/executive",
      ]).toContain(section.destination);
    }
  });

  it("worker and queue telemetry stays under /admin/platform/*", () => {
    for (const name of ["queueCongestion", "queueWorkerTelemetry"]) {
      const section = REGISTRY.sections[name];
      expect(section.owner).toBe("PLATFORM");
      expect(section.destination?.startsWith("/admin/platform/")).toBe(true);
    }
  });
});
