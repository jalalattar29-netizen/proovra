/**
 * OPERATIONAL-CONDITION SOURCE COVERAGE.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS FILE IS
 * ---------------------------------------------------------------------------
 * The executable half of the source-coverage matrix. Every source that can
 * produce workspace-actionable operational work is declared below with its
 * fingerprint strategy, its severity authority, its lifecycle rules, its
 * remediation and its Operations disposition — and every declaration is
 * checked against the tree, so a source cannot be listed here and absent from
 * the product, or present in the product and missing from here.
 *
 * ---------------------------------------------------------------------------
 * THE TWO FINGERPRINT STRATEGIES, AND WHY THERE ARE TWO
 * ---------------------------------------------------------------------------
 * PER-RECORD (`tsa_failure:<evidenceId>`) — one condition per record per
 * failure class. Ten records that could not be timestamped are TEN records
 * that cannot be proven; each has a different owner, case and legal posture,
 * and each has to be fixed individually. Collapsing them makes nine of them
 * invisible, which on an evidence platform is the worst available outcome.
 * That decision is permanent and is enforced, not remembered, by
 * `evidence-integrity-correlation.ts`.
 *
 * PER-WORKSPACE (`dashboard:pipeline:report_backlog:<teamId>`) — one condition
 * however many rows are behind it. A report queue that is too deep is ONE
 * operational fact about the workspace, not one fact per queued report, and
 * emitting the latter would be exactly the incident flood the brief warns
 * about.
 *
 * The strategy is a property of the SOURCE, and this file records which each
 * source uses so the choice is reviewable rather than incidental.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

function read(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
}

const INTEGRITY = read("../src/services/operations/evidence-integrity-conditions.service.ts");
const CORRELATION = read("../src/services/operations/evidence-integrity-correlation.ts");
const GENERATOR = read("../src/services/dashboard/incident-generator.service.ts");
/** The ONE observation authority per source: counts, thresholds, identities. */
const PROBES = read("../src/services/operations/operations-source-probes.ts");
const INCIDENT_SERVICE = read("../src/services/observability/incident.service.ts");
const OPS_ROUTES = read("../src/routes/ops.routes.ts");
const SCHEMA = read("../prisma/schema.prisma");

// ===========================================================================
// THE MATRIX
// ===========================================================================

type Fingerprint = "PER_RECORD" | "PER_WORKSPACE";

type Disposition =
  /** Operations opens the condition and owns its triage lifecycle. */
  | "OPERATIONS_INCIDENT"
  /** The domain owns it; Operations shows a condition and deep-links out. */
  | "OPERATIONS_INCIDENT_WITH_DEEP_LINK"
  /** Not an Operations concern — another surface is the canonical home. */
  | "OTHER_SURFACE_IS_CANONICAL"
  /** No writer exists. A named product gap, not a silent absence. */
  | "PRODUCT_GAP";

type Source = {
  name: string;
  /** The module that OPENS the condition. */
  writer: string;
  /**
   * Where the condition's IDENTITY is declared, when that is not the writer.
   *
   * The two came apart when the per-rule scanners moved out of the generator.
   * Each of them was a private count that only discovery could run, which is
   * why an operator could declare a backlog resolved: nothing else in the
   * product could ask whether the backlog was still there. The count, the
   * threshold and the fingerprint prefix now live with the SOURCE, in
   * `operations-source-probes.ts`, and the generator consumes them.
   *
   * `writer` still means "the module that opens the condition" and is still
   * the generator; this names the module the fingerprint literal must be in.
   */
  identityOwner?: string;
  /** A literal that must be present in that module. */
  evidence: string;
  category: string;
  fingerprint: Fingerprint;
  /** How severity is decided. */
  severity: string;
  disposition: Disposition;
  /** Where an operator goes to actually fix it. */
  remediation: string;
};

const SOURCES: readonly Source[] = [
  {
    name: "TSA timestamp failure",
    writer: "evidence-integrity-conditions.service.ts",
    evidence: `"tsa_failure"`,
    category: "EVIDENCE_INTEGRITY",
    fingerprint: "PER_RECORD",
    severity: "deriveIntegritySeverity — escalates with the record's age",
    disposition: "OPERATIONS_INCIDENT_WITH_DEEP_LINK",
    remediation: "the Evidence record's own integrity path",
  },
  {
    name: "OTS anchoring failure",
    writer: "evidence-integrity-conditions.service.ts",
    evidence: `"ots_failure"`,
    category: "EVIDENCE_INTEGRITY",
    fingerprint: "PER_RECORD",
    severity: "deriveIntegritySeverity — escalates with the record's age",
    disposition: "OPERATIONS_INCIDENT_WITH_DEEP_LINK",
    remediation: "the Evidence record's own integrity path",
  },
  {
    name: "Report generation backlog",
    writer: "incident-generator.service.ts",
    identityOwner: "operations/operations-source-probes.ts",
    evidence: "dashboard:pipeline:report_backlog",
    category: "REPORT",
    fingerprint: "PER_WORKSPACE",
    severity: "threshold on queue depth",
    disposition: "OPERATIONS_INCIDENT",
    remediation: "the report domain's own requeue path",
  },
  {
    name: "Verification package backlog",
    writer: "incident-generator.service.ts",
    identityOwner: "operations/operations-source-probes.ts",
    evidence: "dashboard:pipeline:package_backlog",
    category: "PACKAGE",
    fingerprint: "PER_WORKSPACE",
    severity: "threshold on queue depth",
    disposition: "OPERATIONS_INCIDENT",
    remediation: "the package domain's own requeue path",
  },
  {
    name: "Review & Sign stale assignments",
    writer: "incident-generator.service.ts",
    identityOwner: "operations/operations-source-probes.ts",
    evidence: "dashboard:review:stale_assignments",
    category: "WORKER",
    fingerprint: "PER_WORKSPACE",
    severity: "threshold on stale count",
    disposition: "OPERATIONS_INCIDENT_WITH_DEEP_LINK",
    remediation: "the Review & Sign queue",
  },
  {
    name: "Retry storms",
    writer: "incident-generator.service.ts",
    identityOwner: "operations/operations-source-probes.ts",
    evidence: "dashboard:reliability:retry_storms",
    category: "WORKER",
    fingerprint: "PER_WORKSPACE",
    severity: "threshold on retry rate",
    disposition: "OPERATIONS_INCIDENT",
    remediation: "the owning domain's retry path",
  },
  {
    name: "Stale queue telemetry",
    writer: "incident-generator.service.ts",
    identityOwner: "operations/operations-source-probes.ts",
    evidence: "dashboard:telemetry:queue_stale",
    category: "WORKER",
    fingerprint: "PER_WORKSPACE",
    severity: "threshold on staleness",
    disposition: "OPERATIONS_INCIDENT",
    remediation: "platform operations (deep link withheld from tenants)",
  },
  {
    name: "Worker heartbeat staleness",
    writer: "incident-generator.service.ts",
    identityOwner: "operations/operations-source-probes.ts",
    evidence: "dashboard:worker:heartbeat_stale",
    category: "WORKER",
    fingerprint: "PER_WORKSPACE",
    severity: "threshold on heartbeat age",
    disposition: "OPERATIONS_INCIDENT",
    remediation: "platform operations (deep link withheld from tenants)",
  },
  {
    name: "Finalized but unsigned, aged",
    writer: "incident-generator.service.ts",
    identityOwner: "operations/operations-source-probes.ts",
    evidence: "dashboard:integrity:unsigned_aged",
    category: "GOVERNANCE",
    fingerprint: "PER_WORKSPACE",
    severity: "threshold on age",
    disposition: "OPERATIONS_INCIDENT_WITH_DEEP_LINK",
    remediation: "the Evidence library",
  },
  {
    name: "Coordination backlog stale",
    writer: "incident-generator.service.ts",
    identityOwner: "operations/operations-source-probes.ts",
    evidence: "dashboard:coordination:stale_backlog",
    category: "GOVERNANCE",
    fingerprint: "PER_WORKSPACE",
    severity: "threshold on backlog age",
    disposition: "OPERATIONS_INCIDENT_WITH_DEEP_LINK",
    remediation: "the collaboration surface",
  },
  {
    name: "Governance destruction review",
    writer: "governance-lifecycle/destruction-review.service.ts",
    evidence: "recordIncident",
    category: "GOVERNANCE",
    fingerprint: "PER_WORKSPACE",
    severity: "domain-decided",
    disposition: "OPERATIONS_INCIDENT_WITH_DEEP_LINK",
    remediation: "the Governance surface",
  },
  {
    name: "Immutable storage reconciliation",
    writer: "worker/governance/immutable-storage-reconciliation.worker.ts",
    evidence: "recordIncident",
    category: "GOVERNANCE",
    fingerprint: "PER_WORKSPACE",
    severity: "domain-decided",
    disposition: "OPERATIONS_INCIDENT",
    remediation: "the Governance surface",
  },
  {
    name: "Reviewer escalation",
    writer: "reviewer-ops/escalation-engine.service.ts",
    evidence: "recordIncident",
    category: "GOVERNANCE",
    fingerprint: "PER_WORKSPACE",
    severity: "reviewer-ops SLA policy",
    disposition: "OPERATIONS_INCIDENT_WITH_DEEP_LINK",
    remediation: "the reviewer escalation queue",
  },
  {
    name: "Identity / access-security conditions",
    writer: "access-control/runtime-risk.service.ts",
    evidence: `"IDENTITY_SECURITY"`,
    category: "IDENTITY_SECURITY",
    fingerprint: "PER_WORKSPACE",
    severity: "risk-engine decided",
    disposition: "OTHER_SURFACE_IS_CANONICAL",
    remediation: "Security Center — Operations does not duplicate its authority",
  },
  {
    name: "Communications delivery failure",
    writer: "security/security-event.service.ts",
    evidence: `"COMMUNICATIONS"`,
    category: "COMMUNICATIONS",
    fingerprint: "PER_WORKSPACE",
    severity: "domain-decided",
    disposition: "OPERATIONS_INCIDENT",
    remediation: "the communications retry path",
  },
];

// ===========================================================================
// 1. EVERY DECLARED SOURCE EXISTS IN THE TREE
// ===========================================================================

const WRITER_SOURCE: Record<string, string> = {
  "evidence-integrity-conditions.service.ts": INTEGRITY,
  "incident-generator.service.ts": GENERATOR,
  "operations/operations-source-probes.ts": PROBES,
};

/** Where a source's fingerprint literal must be: its identity owner. */
function identityModuleOf(s: Source): string {
  return s.identityOwner ?? s.writer;
}

describe("source coverage — every declared source is real", () => {
  it.each(SOURCES.filter((s) => WRITER_SOURCE[identityModuleOf(s)]))(
    "$name declares its identity in $identityOwner",
    (s) => {
      expect(WRITER_SOURCE[identityModuleOf(s)]).toContain(s.evidence);
    },
  );

  it("every aggregate source is still OPENED by the generator", () => {
    // The identity moved; the writer did not. This is the half that would
    // otherwise go unchecked once `identityOwner` started absorbing the
    // fingerprint assertions — a source whose prefix is declared and whose
    // sweep no longer runs it would look perfectly healthy above.
    for (const s of SOURCES.filter((x) => x.identityOwner)) {
      expect(GENERATOR, s.name).toContain("aggregateSpecs()");
      expect(GENERATOR, s.name).toContain("recordIncident(");
    }
  });

  it("every source whose writer is not inlined above still exists on disk", () => {
    for (const s of SOURCES) {
      if (WRITER_SOURCE[s.writer]) continue;
      const path = s.writer.startsWith("worker/")
        ? `../../worker/src/${s.writer.slice("worker/".length)}`
        : `../src/services/${s.writer}`;
      expect(() => read(path), `${s.name}: ${s.writer}`).not.toThrow();
    }
  });

  it("every declared category is a real IncidentCategory", () => {
    const block = SCHEMA.slice(
      SCHEMA.indexOf("enum IncidentCategory {"),
      SCHEMA.indexOf("}", SCHEMA.indexOf("enum IncidentCategory {")),
    );
    for (const s of SOURCES) {
      expect(block, `${s.name} → ${s.category}`).toContain(s.category);
    }
  });
});

// ===========================================================================
// 2. NO ACTIONABLE DOMAIN DISAPPEARS FOR WANT OF A RENDERER
// ===========================================================================

describe("source coverage — the workbench can project every source", () => {
  it("every category a source writes is filterable in the UI vocabulary", () => {
    const vocabulary = readFileSync(
      fileURLToPath(
        new URL(
          "../../../apps/web/app/(app)/operations/_lib/vocabulary.ts",
          import.meta.url,
        ),
      ),
      "utf8",
    );
    for (const s of SOURCES) {
      expect(
        vocabulary,
        `${s.category} must have a plain-language label, or its conditions render as an enum token`,
      ).toContain(`${s.category}:`);
    }
  });

  it("the category filter is sent to the SERVER, not applied to a page", () => {
    expect(OPS_ROUTES).toContain("category: z");
    const filters = readFileSync(
      fileURLToPath(
        new URL(
          "../../../apps/web/app/(app)/operations/_lib/filters.ts",
          import.meta.url,
        ),
      ),
      "utf8",
    );
    expect(filters).toContain('p.set("category", input.filters.category)');
  });

  it("Security Center keeps its own authority — Operations does not duplicate it", () => {
    const security = SOURCES.find((s) => s.category === "IDENTITY_SECURITY");
    expect(security?.disposition).toBe("OTHER_SURFACE_IS_CANONICAL");
    // The workbench does not open, resolve or remediate identity conditions;
    // it can only SHOW them, which is what stops two surfaces adjudicating one
    // security posture.
    expect(INTEGRITY).not.toContain("IDENTITY_SECURITY");
  });
});

// ===========================================================================
// 3. THE TWO FINGERPRINT STRATEGIES, PINNED
// ===========================================================================

describe("fingerprint strategy is a deliberate property of each source", () => {
  it("per-record sources key on the RECORD, so no record becomes invisible", () => {
    for (const s of SOURCES.filter((x) => x.fingerprint === "PER_RECORD")) {
      expect(s.category).toBe("EVIDENCE_INTEGRITY");
    }
    // The identity function itself, not a comment about it.
    expect(INTEGRITY).toMatch(
      /return `\$\{integrityClass\}:\$\{evidenceId\}`/,
    );
  });

  it("per-workspace sources key on the WORKSPACE, so a backlog is one fact", () => {
    for (const s of SOURCES.filter((x) => x.fingerprint === "PER_WORKSPACE")) {
      const module = WRITER_SOURCE[identityModuleOf(s)];
      if (!module) continue;
      expect(module, s.name).toContain(s.evidence);
    }
    // The workspace id terminates the key, and it is appended in exactly ONE
    // place. Eight interpolated template literals became one function, which
    // is what lets the resolve path, the recovery sweep and the sweep itself
    // address the SAME row — a second copy of this template is how they would
    // stop agreeing.
    expect(PROBES).toMatch(
      /return `\$\{spec\.fingerprintPrefix\}:\$\{teamId\}`/,
    );
    // …and the sweep uses that function rather than rebuilding the string.
    expect(GENERATOR).toContain("aggregateFingerprint(spec, ctx.teamId)");
  });

  it("no aggregate fingerprint is built anywhere but the one function", () => {
    // A literal `dashboard:` prefix followed by an interpolation is the shape
    // the eight scanners used. It must not reappear: a second construction
    // site would address a different row than the one the resolve path probes.
    for (const module of [GENERATOR, INCIDENT_SERVICE, INTEGRITY]) {
      expect(module).not.toMatch(/`dashboard:[^`]*\$\{/);
    }
  });

  it("the collapse of per-record integrity failures is BANNED, not merely discouraged", () => {
    // The retracted finding. Grouping requires positive evidence of a shared
    // CAUSE; resemblance is not causation, and the forbidden list is asserted
    // rather than reviewed.
    for (const forbidden of [
      "failureReason",
      "normalizedFailureReason",
      "fileName",
      "provider",
      "workspaceId",
      "occurredOnDate",
    ]) {
      expect(CORRELATION).toContain(`"${forbidden}"`);
    }
    // …and none of them is a PARAMETER of the correlator.
    const fn = CORRELATION.slice(CORRELATION.indexOf("export type CorrelationEvidence"));
    const params = fn.slice(0, fn.indexOf("};"));
    for (const forbidden of ["failureReason", "fileName", "provider"]) {
      expect(params).not.toContain(`${forbidden}?:`);
    }
  });
});

// ===========================================================================
// 4. LIFECYCLE RULES ARE SOURCE-DRIVEN, NOT UI-DRIVEN
// ===========================================================================

describe("lifecycle rules belong to the source, not to the workbench", () => {
  it("a condition resolves from DOMAIN truth, re-read per condition", () => {
    // Never "absent from a capped scan". A truncated listing may cause a
    // MISSED resolution, which is harmless; it may never cause a FALSE one.
    expect(INTEGRITY).toContain("re-reads each open condition's own Evidence by id");
  });

  it("SUPPRESSED survives a re-observation; RESOLVED does not", () => {
    expect(INTEGRITY).toContain("SUPPRESSED + observed FAILED -> stays suppressed");
    expect(INTEGRITY).toContain("RESOLVED  + observed FAILED  -> REOPEN");
  });

  it("personal notification state is not an input to any of it", () => {
    expect(INTEGRITY).toContain(
      "Personal notification state — read, archived, deferred — is not an input",
    );
    for (const feedWord of ["isRead", "dismissedAt", "snoozedUntil", "InboxItemState"]) {
      expect(INTEGRITY, `${feedWord} must not reach the condition writer`).not.toContain(
        feedWord,
      );
    }
  });

  it("the incident authority is the ONLY lifecycle the workbench can drive", () => {
    // Four transitions, one writer each, all in the canonical service.
    for (const fn of [
      "acknowledgeIncident",
      "resolveIncident",
      "suppressIncident",
      "assignIncident",
    ]) {
      expect(INCIDENT_SERVICE).toContain(`export async function ${fn}`);
      expect(OPS_ROUTES).toContain(fn);
    }
  });
});
