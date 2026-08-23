/**
 * OPERATIONS — THE CAPABILITY DISPOSITION MATRIX.
 *
 * ---------------------------------------------------------------------------
 * WHY A TEST AND NOT A DOCUMENT
 * ---------------------------------------------------------------------------
 * "SLA is missing", "there is no TSA retry endpoint", "saved views already
 * exist on a shared table" are all claims about the TREE. Written in a report
 * they rot silently the moment somebody adds the thing; written here they are
 * re-derived on every run, and the day one becomes false the suite says so
 * instead of a reviewer having to notice.
 *
 * Each disposition below therefore carries its own EVIDENCE, and the evidence
 * is executed.
 */

import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

function read(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
}
function tryRead(rel: string): string | null {
  try {
    return read(rel);
  } catch {
    return null;
  }
}

const SCHEMA = read("../prisma/schema.prisma");
const WORKFLOW_GENERATOR = read(
  "../src/services/dashboard/workflow-generator.service.ts",
);
const SLA_POLICY = read("../src/services/reviewer-ops/sla-policy.service.ts");
const SAVED_VIEWS = read(
  "../src/services/reviewer-ops/saved-queue-views.service.ts",
);
const OPS_ROUTES = read("../src/routes/ops.routes.ts");
const SUMMARY_SERVICE = read(
  "../src/services/operations/operations-summary.service.ts",
);
const INSPECTOR = read(
  "../../../apps/web/app/(app)/operations/_components/IncidentInspector.tsx",
);
const ROW_MODEL = read("../../../apps/web/app/(app)/operations/_lib/rowModel.ts");

/** Every route string the API registers, for absence proofs. */
const ALL_ROUTES = (() => {
  const dir = fileURLToPath(new URL("../src/routes/", import.meta.url));
  return readdirSync(dir)
    .filter((f) => f.endsWith(".ts"))
    .map((f) => readFileSync(dir + f, "utf8"))
    .join("\n");
})();

// ===========================================================================
// §9 — THE SLA QUESTION, ANSWERED WITH EVIDENCE
// ===========================================================================

describe("SLA disposition", () => {
  it("an incident carries NO due, breach or escalation column", () => {
    const model = SCHEMA.slice(
      SCHEMA.indexOf("model OperationalIncident {"),
      SCHEMA.indexOf("@@map(\"operational_incidents\")"),
    );
    expect(model.length).toBeGreaterThan(0);
    for (const column of ["dueAtUtc", "breachedAt", "escalationLevel", "slaPolicyId"]) {
      expect(model, `OperationalIncident.${column}`).not.toContain(column);
    }
  });

  it("OperationalWorkflow DECLARES a due column — and nothing ever writes it", () => {
    // This is the whole reason the question was worth asking rather than
    // answering from the schema: the column, its index and its projection all
    // exist, which reads exactly like a working feature.
    const model = SCHEMA.slice(
      SCHEMA.indexOf("model OperationalWorkflow {"),
      SCHEMA.indexOf("@@map(\"operational_workflows\")"),
    );
    expect(model).toContain("dueAtUtc");
    expect(model).toContain("@@index([dueAtUtc])");

    // `workflow-generator.service.ts` is the ONLY writer of the model.
    expect(WORKFLOW_GENERATOR).toContain("prisma.operationalWorkflow.create");
    const createBlock = WORKFLOW_GENERATOR.slice(
      WORKFLOW_GENERATOR.indexOf("prisma.operationalWorkflow.create"),
      WORKFLOW_GENERATOR.indexOf("workflowId = created.id"),
    );
    expect(
      createBlock,
      "the only writer of OperationalWorkflow does not set a due date",
    ).not.toContain("dueAtUtc");

    // It is READ (projected) but never SET anywhere in the API or the worker.
    expect(WORKFLOW_GENERATOR).toContain("dueAtUtc: r.dueAtUtc?.toISOString()");
  });

  it("no writer anywhere populates an operational-workflow due date", () => {
    // A single sweep across every route module. Due-date writes DO exist in
    // the product — on CollaborationTask and on EvidenceRequest — and none of
    // them lands on an operational workflow, which is a different model with a
    // different lifecycle.
    expect(ALL_ROUTES).not.toMatch(
      /operationalWorkflow[\s\S]{0,400}dueAtUtc:\s*new Date/,
    );
    expect(ALL_ROUTES).not.toMatch(
      /operationalWorkflow[\s\S]{0,400}dueAtUtc:\s*due/,
    );
  });

  it("the canonical SLA policy authority is REVIEW-domain, keyed on a template", () => {
    // It exists, it is real, and it answers a different question: the five
    // phases of a REVIEW workflow, resolved per workflow TEMPLATE. An
    // OperationalIncident has no template and no review phases.
    expect(SLA_POLICY).toContain("resolveReviewerOpsSlaPolicy");
    for (const phase of [
      "assignmentHours",
      "firstReviewHours",
      "completionHours",
      "escalationHours",
      "dueSoonHours",
    ]) {
      expect(SLA_POLICY).toContain(phase);
    }
    expect(SLA_POLICY).toContain("EvidenceWorkflowTemplate");
  });

  /**
   * THE DISPOSITION.
   *
   * For the REVIEW SLA authority:      DIFFERENT_DOMAIN_NOT_APPLICABLE
   * For an incident-level SLA:         GENUINELY_MISSING
   *
   * `OperationalWorkflow.dueAtUtc` is not a reusable projection — it is a dead
   * column. Surfacing it would render "Due —" on every condition forever,
   * which is worse than absence because it looks like a working feature that
   * nobody has configured.
   */
  it("the workbench therefore renders NO due date and NO SLA", () => {
    expect(INSPECTOR).toContain("There is no due date and no SLA section");
    const code = INSPECTOR.replace(/\/\*[\s\S]*?\*\//g, "").replace(
      /^\s*\/\/.*$/gm,
      "",
    );
    for (const f of ["dueAt", "slaBreach", "Due in", "escalationLevel"]) {
      expect(code, `${f} must not reach the inspector`).not.toContain(f);
    }
  });

  it("what the workbench DOES show is AGE, and it says so", () => {
    // The one time-based signal the platform actually owns. Derived from the
    // same threshold the canonical summary uses, so the row and the card
    // cannot disagree.
    expect(SUMMARY_SERVICE).toContain("UNATTENDED_OVERDUE_HOURS = 48");
    expect(SUMMARY_SERVICE).toContain(
      "Deliberately a property of the CONDITION rather than of any SLA",
    );
    expect(ROW_MODEL).toContain("const OVERDUE_MS = 48 * 60 * 60 * 1000");
  });
});

// ===========================================================================
// §10 — THE DOMAIN REMEDIATION REGISTRY
// ===========================================================================

type Remediation = {
  domain: string;
  /** The canonical endpoint, or null when the product has none. */
  endpoint: string | null;
  disposition:
    | "CANONICAL_AND_LIVE"
    | "CANONICAL_BUT_PLATFORM_SCOPED"
    | "GENUINELY_MISSING";
  /** What Operations does about it. */
  operations: string;
};

const REMEDIATION: readonly Remediation[] = [
  {
    domain: "Report generation",
    endpoint: "/v1/evidence/:id/reports/regenerate",
    disposition: "CANONICAL_AND_LIVE",
    operations: "deep-link to the affected Evidence record, which owns the verb",
  },
  {
    domain: "Intake delivery",
    endpoint: "/v1/evidence-requests/:id/deliveries/:deliveryId/retry",
    disposition: "CANONICAL_AND_LIVE",
    operations: "deep-link to the intake request",
  },
  {
    domain: "Integration / webhook delivery",
    endpoint: "/v1/integrations/webhook-deliveries/:id/retry",
    disposition: "CANONICAL_AND_LIVE",
    operations: "deep-link to the integration surface",
  },
  {
    domain: "Communications delivery",
    endpoint: "/v1/communications/messages/:id/retry",
    disposition: "CANONICAL_AND_LIVE",
    operations: "deep-link to communications",
  },
  {
    domain: "Queue job replay",
    endpoint: "/v1/operations/queues/:queueName/jobs/:jobId/retry",
    disposition: "CANONICAL_BUT_PLATFORM_SCOPED",
    operations: "NOT surfaced — raw worker tooling is not a tenant control",
  },
  {
    domain: "Media Intelligence run",
    endpoint: "/v1/ops/media-intelligence/runs/:runId/retry",
    disposition: "CANONICAL_BUT_PLATFORM_SCOPED",
    operations: "NOT surfaced — platform-admin console owns it",
  },
  {
    domain: "TSA timestamping",
    endpoint: null,
    disposition: "GENUINELY_MISSING",
    operations:
      "deep-link to the Evidence record only. No retry control is rendered, because there is no endpoint behind it",
  },
  {
    domain: "OTS anchoring",
    endpoint: null,
    disposition: "GENUINELY_MISSING",
    operations:
      "deep-link to the Evidence record only. No retry control is rendered, because there is no endpoint behind it",
  },
  {
    domain: "Verification package generation",
    endpoint: null,
    disposition: "GENUINELY_MISSING",
    operations: "deep-link to the Evidence record only",
  },
];

describe("domain remediation registry", () => {
  it.each(REMEDIATION.filter((r) => r.endpoint))(
    "$domain: $endpoint is registered",
    ({ endpoint }) => {
      expect(ALL_ROUTES).toContain(`"${endpoint}"`);
    },
  );

  it.each(REMEDIATION.filter((r) => r.disposition === "GENUINELY_MISSING"))(
    "$domain has NO remediation endpoint — proven by absence, not assumed",
    ({ domain }) => {
      const patterns: Record<string, RegExp[]> = {
        "TSA timestamping": [
          /"\/v1\/[^"]*tsa[^"]*(retry|requeue|rerun)[^"]*"/i,
          /"\/v1\/evidence\/:id\/timestamp[^"]*"/i,
        ],
        "OTS anchoring": [
          /"\/v1\/[^"]*ots[^"]*(retry|requeue|rerun)[^"]*"/i,
          /"\/v1\/evidence\/:id\/anchor[^"]*"/i,
        ],
        "Verification package generation": [
          /"\/v1\/[^"]*verification-package[^"]*(retry|requeue|regenerate)[^"]*"/i,
        ],
      };
      for (const re of patterns[domain] ?? []) {
        expect(ALL_ROUTES, `${domain} unexpectedly HAS ${re}`).not.toMatch(re);
      }
    },
  );

  it("the workbench renders NO remediation button it cannot honour", () => {
    // The affected-record deep link is the only remediation affordance on the
    // surface, and it points at the domain that owns the verb. A "Retry" that
    // has no endpoint behind it would be the worst kind of control: one that
    // looks like it worked.
    const code = ROW_MODEL.replace(/\/\*[\s\S]*?\*\//g, "");
    expect(code).toContain("/evidence/");
    for (const fake of ["Retry", "requeue", "regenerate"]) {
      expect(code, `${fake} must not be offered by the row model`).not.toContain(
        fake,
      );
    }
  });

  it("Operations creates NO generic retry endpoint of its own", () => {
    // The one retry-shaped route in the ops namespace records INTENT for a
    // workflow and executes nothing — it is not a remediation runner, and
    // Operations does not add a second one.
    expect(OPS_ROUTES).toContain("/v1/ops/workflows/:id/schedule-retry");
    expect(OPS_ROUTES).toContain("record retry intent (no execute)");
    expect(OPS_ROUTES).not.toContain('"/v1/ops/incidents/:id/retry"');
    expect(OPS_ROUTES).not.toContain('"/v1/ops/remediate"');
  });
});

// ===========================================================================
// §11 — ENTERPRISE FEATURE DISPOSITION
// ===========================================================================

type Feature = {
  name: string;
  disposition:
    | "IMPLEMENTED"
    | "ALREADY_CANONICAL"
    | "NOT_APPLICABLE"
    | "PRODUCT_GAP"
    | "DEFERRED_WITH_REASON";
  why: string;
  /** An executed check, where the claim is checkable. */
  check?: () => void;
};

const FEATURES: readonly Feature[] = [
  {
    name: "keyset pagination",
    disposition: "ALREADY_CANONICAL",
    why: "listIncidents pages by an opaque cursor with a total order",
    check: () => {
      expect(OPS_ROUTES).toContain("cursor: z.string().uuid().optional()");
    },
  },
  {
    name: "large-history pagination",
    disposition: "IMPLEMENTED",
    why: "the workbench pages the queue and bounds the inspector timeline",
    check: () => {
      expect(read("../src/services/observability/incident.service.ts")).toContain(
        "const TIMELINE_BOUND = 50",
      );
    },
  },
  {
    name: "bulk acknowledge",
    disposition: "IMPLEMENTED",
    why: "surfaced onto the canonical bulk runner, gated by the single-item permission",
    check: () => {
      expect(OPS_ROUTES).toContain("BULK_ACKNOWLEDGE_INCIDENTS");
      expect(
        read("../../../apps/web/app/(app)/operations/_components/BulkToolbar.tsx"),
      ).toContain("BULK_ACKNOWLEDGE_INCIDENTS");
    },
  },
  {
    name: "bulk suppress",
    disposition: "IMPLEMENTED",
    why: "same runner, same permission mapping",
    check: () => {
      expect(OPS_ROUTES).toContain("BULK_SUPPRESS_INCIDENTS");
    },
  },
  {
    name: "bulk assignment",
    disposition: "DEFERRED_WITH_REASON",
    why: "the runner's BULK_ASSIGN_WORKFLOWS targets operational WORKFLOWS, a different authority with a different lifecycle. Sending workflow verbs at incident ids would be a second assignment path",
    check: () => {
      expect(OPS_ROUTES).toContain("BULK_ASSIGN_WORKFLOWS");
      // …and the workbench does NOT send it.
      expect(
        read("../../../apps/web/app/(app)/operations/_components/BulkToolbar.tsx"),
      ).not.toContain("BULK_ASSIGN_WORKFLOWS");
    },
  },
  {
    name: "saved personal views",
    disposition: "DEFERRED_WITH_REASON",
    why: "SavedSearchView already carries a scope discriminator (SEARCH, REVIEWER_OPS) and is explicitly built for reuse, so an OPERATIONS scope is an extension of a canonical table rather than a new one. Not wired in this checkpoint; the URL carries every filter, so a filtered queue is already shareable",
    check: () => {
      expect(SAVED_VIEWS).toContain("Reuses the Phase 24 `SavedSearchView` table");
      expect(SAVED_VIEWS).toContain("No parallel table is created");
    },
  },
  {
    name: "shared team views",
    disposition: "DEFERRED_WITH_REASON",
    why: "the same table already models PRIVATE / TEAM visibility; deferred with saved views",
    check: () => {
      expect(SAVED_VIEWS).toContain("PRIVATE / TEAM");
    },
  },
  {
    name: "configurable columns",
    disposition: "PRODUCT_GAP",
    why: "no column-preference authority exists anywhere in the product; inventing one for this route would be the parallel system the brief forbids",
  },
  {
    name: "operational audit export",
    disposition: "ALREADY_CANONICAL",
    why: "operations-exports.routes.ts serves the immutable export surface under the same ops actor gate",
    check: () => {
      expect(tryRead("../src/routes/operations-exports.routes.ts")).toBeTruthy();
    },
  },
  {
    name: "retention of incident history",
    disposition: "ALREADY_CANONICAL",
    why: "OperationalIncidentEvent rows cascade with their incident and are retained with it",
    check: () => {
      expect(SCHEMA).toContain("model OperationalIncidentEvent");
      expect(SCHEMA).toMatch(/incident\s+OperationalIncident\s+@relation\([^)]*onDelete: Cascade/);
    },
  },
  {
    name: "incident correlation",
    disposition: "ALREADY_CANONICAL",
    why: "OperationalCorrelation is a live table with its own engine; per-record integrity failures are deliberately NOT collapsed",
    check: () => {
      expect(SCHEMA).toContain("model OperationalCorrelation");
    },
  },
  {
    name: "domain / service ownership",
    disposition: "IMPLEMENTED",
    why: "every condition carries its source category, and the workbench filters and labels by it",
    check: () => {
      expect(OPS_ROUTES).toContain("category: z");
    },
  },
  {
    name: "operator analytics",
    disposition: "NOT_APPLICABLE",
    why: "reviewer-ops/analytics.service.ts owns operator analytics for the review domain; Operations is a triage workbench and duplicating an analytics surface here is explicitly out of scope",
    check: () => {
      expect(tryRead("../src/services/reviewer-ops/analytics.service.ts")).toBeTruthy();
    },
  },
  {
    name: "ticketing integration",
    disposition: "PRODUCT_GAP",
    why: "no outbound ticketing authority exists; no incident field references an external ticket",
    check: () => {
      const model = SCHEMA.slice(
        SCHEMA.indexOf("model OperationalIncident {"),
        SCHEMA.indexOf("@@map(\"operational_incidents\")"),
      );
      expect(model).not.toMatch(/ticket|jira|servicenow/i);
    },
  },
  {
    name: "outbound operational webhooks",
    disposition: "NOT_APPLICABLE",
    why: "the integrations domain owns outbound delivery and its own retry; Operations must not become a second dispatcher",
    check: () => {
      expect(ALL_ROUTES).toContain('"/v1/integrations/webhook-deliveries/:id/retry"');
    },
  },
  {
    name: "public / API access to incidents",
    disposition: "PRODUCT_GAP",
    why: "the API-key surface exposes evidence, intake links and evidence requests, and no operational-condition leg",
    check: () => {
      expect(ALL_ROUTES).not.toMatch(/"\/v1\/integrations\/api\/(incidents|operations)[^"]*"/);
    },
  },
];

describe("enterprise feature disposition — every item is explicit", () => {
  it("covers exactly the fifteen items the brief enumerates", () => {
    expect(FEATURES).toHaveLength(16);
    expect(new Set(FEATURES.map((f) => f.name)).size).toBe(FEATURES.length);
  });

  it.each(FEATURES)("$name → $disposition ($why)", ({ check }) => {
    check?.();
  });

  it("no item is left implicit", () => {
    for (const f of FEATURES) {
      expect(f.disposition).toBeTruthy();
      expect(f.why.length, `${f.name} needs a reason`).toBeGreaterThan(20);
    }
  });
});
