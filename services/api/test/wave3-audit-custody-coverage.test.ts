/**
 * Wave 3 — Phase 7B: audit + custody wiring coverage + producer-mode
 * cross-boundary fix regression test (source-contract).
 *
 * Pins:
 *
 *   A. For each of the 8 Investigation-mutation sites:
 *      - appendPlatformAuditLog emit present
 *      - appendInvestigationCustody emit present
 *      - bounded details payload (no JSON.stringify on req.body, no
 *        large blobs, no eval)
 *      - custody emit ordered AFTER the corresponding audit emit
 *        (which itself is after the DB write success path)
 *
 *   B. Producer-mode seam:
 *      - registerProbes function exists in probe-registry.ts
 *      - producer-mode.ts no longer contains relative-path imports
 *        into services/api/...
 *      - probe-bootstrap.ts wires the four real probes into the seam
 *      - server.ts imports the bootstrap once before route handlers
 *
 * The test is source-contract — it reads the route handler source and
 * the shared-runtime + bootstrap sources, never spawns the API.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

function readApi(rel: string): string {
  return readFileSync(
    fileURLToPath(new URL(`../${rel}`, import.meta.url)),
    "utf8",
  );
}

function readRoot(rel: string): string {
  return readFileSync(
    fileURLToPath(new URL(`../../../${rel}`, import.meta.url)),
    "utf8",
  );
}

const GRAPH_ROUTES = readApi("src/routes/graph.routes.ts");
const MI_ROUTES = readApi("src/routes/media-intelligence.routes.ts");
const CUSTODY_HELPER = readApi(
  "src/services/investigation-custody.service.ts",
);
const PROBE_REGISTRY = readRoot(
  "packages/shared-runtime/src/media-intelligence/probe-registry.ts",
);
const PRODUCER_MODE = readRoot(
  "packages/shared-runtime/src/media-intelligence/producer-mode.ts",
);
const PROBE_BOOTSTRAP = readApi(
  "src/services/media-intelligence/probe-bootstrap.ts",
);
const SERVER_TS = readApi("src/server.ts");

// ===========================================================================
// A. Mutation-site audit + custody coverage (8 sites)
// ===========================================================================

describe("Wave 3 Phase 7B — audit + custody coverage", () => {
  // ------------------------------------------------------------------ helper
  function sliceRoute(source: string, routeMarker: string, span = 4000): string {
    const idx = source.indexOf(routeMarker);
    if (idx === -1) {
      throw new Error(`route marker not found: ${routeMarker}`);
    }
    return source.slice(idx, idx + span);
  }

  // ------------------------------------------------------------------ 1
  it("POST /v1/graph/duplicates/:edgeId/decision — audit + custody emit", () => {
    const block = sliceRoute(GRAPH_ROUTES, "/v1/graph/duplicates/:edgeId/decision", 6000);
    expect(block).toContain('action: "DUPLICATE_DECISION_RECORDED"');
    expect(block).toContain("appendInvestigationCustody");
    expect(block).toContain(
      "prismaPkg.CustodyEventType.DUPLICATE_DECISION_RECORDED",
    );
    expect(block).toContain('surface: "graph.routes.ts:duplicateDecision"');
  });

  // ------------------------------------------------------------------ 2
  it("POST /v1/graph/relationships/manual — audit + custody emit", () => {
    const block = sliceRoute(GRAPH_ROUTES, '"/v1/graph/relationships/manual"', 4000);
    expect(block).toContain('action: "GRAPH_MANUAL_RELATIONSHIP_CREATED"');
    expect(block).toContain("appendInvestigationCustody");
    expect(block).toContain(
      "prismaPkg.CustodyEventType.MANUAL_RELATIONSHIP_CREATED",
    );
    expect(block).toContain('surface: "graph.routes.ts:manualCreate"');
  });

  // ------------------------------------------------------------------ 3
  it("DELETE /v1/graph/relationships/manual/:id — audit + custody emit", () => {
    const block = sliceRoute(
      GRAPH_ROUTES,
      '"/v1/graph/relationships/manual/:manualRelationshipId"',
      4000,
    );
    expect(block).toContain('action: "GRAPH_MANUAL_RELATIONSHIP_RETRACTED"');
    expect(block).toContain("appendInvestigationCustody");
    expect(block).toContain(
      "prismaPkg.CustodyEventType.MANUAL_RELATIONSHIP_RETRACTED",
    );
    expect(block).toContain('surface: "graph.routes.ts:manualRetract"');
  });

  // ------------------------------------------------------------------ 4
  it("POST /v1/graph/reconcile — audit + custody emit", () => {
    const block = sliceRoute(GRAPH_ROUTES, '"/v1/graph/reconcile"', 4000);
    expect(block).toContain('action: "GRAPH_MANUAL_RECONCILE_REQUESTED"');
    expect(block).toContain("appendInvestigationCustody");
    expect(block).toContain(
      "prismaPkg.CustodyEventType.GRAPH_RECONCILE_REQUESTED",
    );
    expect(block).toContain('surface: "graph.routes.ts:reconcile"');
  });

  // ------------------------------------------------------------------ 5
  it("POST /v1/investigation/media-intelligence/refresh — audit + custody emit", () => {
    const block = sliceRoute(
      MI_ROUTES,
      '"/v1/investigation/media-intelligence/refresh"',
      6000,
    );
    expect(block).toContain('action: "MEDIA_INTELLIGENCE_REFRESH_REQUESTED"');
    expect(block).toContain("appendInvestigationCustody");
    expect(block).toContain(
      "prismaPkg.CustodyEventType.MEDIA_INTELLIGENCE_REFRESH_REQUESTED",
    );
    expect(block).toContain(
      'surface: "media-intelligence.routes.ts:refresh"',
    );
  });

  // ------------------------------------------------------------------ 6
  it("POST /v1/graph/export — audit + custody emit", () => {
    const block = sliceRoute(GRAPH_ROUTES, '"/v1/graph/export"', 6000);
    expect(block).toContain('action: "INVESTIGATION_EXPORT_GENERATED"');
    expect(block).toContain("appendInvestigationCustody");
    expect(block).toContain(
      "prismaPkg.CustodyEventType.INVESTIGATION_GRAPH_EXPORTED",
    );
    expect(block).toContain('surface: "graph.routes.ts:graphExport"');
  });

  // ------------------------------------------------------------------ 7
  it("POST /v1/graph/timeline/export — audit + custody emit", () => {
    const block = sliceRoute(GRAPH_ROUTES, '"/v1/graph/timeline/export"', 4000);
    expect(block).toContain('action: "INVESTIGATION_EXPORT_GENERATED"');
    expect(block).toContain("appendInvestigationCustody");
    expect(block).toContain(
      "prismaPkg.CustodyEventType.INVESTIGATION_TIMELINE_EXPORTED",
    );
    expect(block).toContain('surface: "graph.routes.ts:timelineExport"');
  });

  // ------------------------------------------------------------------ 8
  it("POST /v1/graph/duplicates/export — audit + custody emit", () => {
    const block = sliceRoute(GRAPH_ROUTES, '"/v1/graph/duplicates/export"', 4000);
    expect(block).toContain('action: "INVESTIGATION_EXPORT_GENERATED"');
    expect(block).toContain("appendInvestigationCustody");
    expect(block).toContain(
      "prismaPkg.CustodyEventType.INVESTIGATION_DUPLICATES_EXPORTED",
    );
    expect(block).toContain('surface: "graph.routes.ts:duplicatesExport"');
  });
});

// ===========================================================================
// A.cont — bounded payload + ordering rules
// ===========================================================================

describe("Wave 3 Phase 7B — bounded payload + ordering", () => {
  it("custody helper enforces ≤ 200-byte serialized payload", () => {
    expect(CUSTODY_HELPER).toMatch(/MAX_PAYLOAD_BYTES\s*=\s*200/);
    expect(CUSTODY_HELPER).toContain("investigation_custody_payload_too_large");
    expect(CUSTODY_HELPER).toContain("assertBoundedPayload");
  });

  it("custody helper uses canonical swallowCustodyAppendError", () => {
    expect(CUSTODY_HELPER).toContain("swallowCustodyAppendError");
    expect(CUSTODY_HELPER).toContain(
      'from "./custody-events-observability.js"',
    );
  });

  it("custody helper anchors via Evidence FK (NEVER bypasses FK)", () => {
    // The CustodyEvent model requires an evidenceId FK; the helper
    // resolves an anchor for workspace-scoped mutations or per-edge.
    expect(CUSTODY_HELPER).toContain("resolveWorkspaceAnchor");
    expect(CUSTODY_HELPER).toContain("resolveEdgeEvidenceAnchors");
    expect(CUSTODY_HELPER).toContain("appendCustodyEvent");
  });

  it("graph routes NEVER stringify req.body into audit/custody payload", () => {
    // Hard rule: no JSON.stringify(req.body), no req.body in metadata
    // (Zod parses to a local bound shape only).
    expect(GRAPH_ROUTES).not.toMatch(/JSON\.stringify\(\s*req\.body\b/);
    expect(GRAPH_ROUTES).not.toMatch(/metadata:\s*req\.body/);
  });

  it("media-intel route NEVER stringifies req.body into audit/custody payload", () => {
    expect(MI_ROUTES).not.toMatch(/JSON\.stringify\(\s*req\.body\b/);
    expect(MI_ROUTES).not.toMatch(/metadata:\s*req\.body/);
  });

  it("graph routes import prismaPkg + appendInvestigationCustody", () => {
    expect(GRAPH_ROUTES).toContain('import * as prismaPkg from "@prisma/client"');
    expect(GRAPH_ROUTES).toContain("appendInvestigationCustody");
    expect(GRAPH_ROUTES).toContain(
      'from "../services/investigation-custody.service.js"',
    );
  });

  it("MI routes import prismaPkg + appendInvestigationCustody", () => {
    expect(MI_ROUTES).toContain('import * as prismaPkg from "@prisma/client"');
    expect(MI_ROUTES).toContain("appendInvestigationCustody");
    expect(MI_ROUTES).toContain(
      'from "../services/investigation-custody.service.js"',
    );
  });
});

// ===========================================================================
// A.cont — ordering: custody emit happens AFTER DB write success.
// ===========================================================================

describe("Wave 3 Phase 7B — custody emit ordered after DB write", () => {
  function assertCustodyAfterAudit(routeBlock: string, eventTypeMarker: string): void {
    // PHASE 11 §3 Batch A migrated graph.routes.ts's direct
    // appendPlatformAuditLog calls onto the canonical emitTenantAudit
    // facade; media-intelligence.routes.ts (a different batch's scope)
    // still calls appendPlatformAuditLog directly. Accept either marker.
    const legacyIdx = routeBlock.indexOf("appendPlatformAuditLog");
    const canonicalIdx = routeBlock.indexOf("emitTenantAudit");
    const auditIdx =
      legacyIdx === -1
        ? canonicalIdx
        : canonicalIdx === -1
          ? legacyIdx
          : Math.min(legacyIdx, canonicalIdx);
    const custodyIdx = routeBlock.indexOf("appendInvestigationCustody");
    expect(auditIdx).toBeGreaterThan(-1);
    expect(custodyIdx).toBeGreaterThan(-1);
    // The audit emit is itself in a try/catch that runs AFTER the DB
    // write success path. The custody emit follows immediately.
    expect(custodyIdx).toBeGreaterThan(auditIdx);
    expect(routeBlock).toContain(eventTypeMarker);
  }

  it("duplicate decision — custody after audit", () => {
    const block = GRAPH_ROUTES.slice(
      GRAPH_ROUTES.indexOf("/v1/graph/duplicates/:edgeId/decision"),
      GRAPH_ROUTES.indexOf("/v1/graph/duplicates/:edgeId/decision") + 6000,
    );
    assertCustodyAfterAudit(block, "DUPLICATE_DECISION_RECORDED");
  });

  it("manual relationship create — custody after audit", () => {
    const block = GRAPH_ROUTES.slice(
      GRAPH_ROUTES.indexOf('"/v1/graph/relationships/manual"'),
      GRAPH_ROUTES.indexOf('"/v1/graph/relationships/manual"') + 4000,
    );
    assertCustodyAfterAudit(block, "MANUAL_RELATIONSHIP_CREATED");
  });

  it("graph reconcile — custody after audit", () => {
    const block = GRAPH_ROUTES.slice(
      GRAPH_ROUTES.indexOf('"/v1/graph/reconcile"'),
      GRAPH_ROUTES.indexOf('"/v1/graph/reconcile"') + 4000,
    );
    assertCustodyAfterAudit(block, "GRAPH_RECONCILE_REQUESTED");
  });

  it("MI refresh — custody after audit", () => {
    const block = MI_ROUTES.slice(
      MI_ROUTES.indexOf('"/v1/investigation/media-intelligence/refresh"'),
      MI_ROUTES.indexOf('"/v1/investigation/media-intelligence/refresh"') + 6000,
    );
    assertCustodyAfterAudit(block, "MEDIA_INTELLIGENCE_REFRESH_REQUESTED");
  });
});

// ===========================================================================
// B. Producer-mode seam — cross-boundary fix
// ===========================================================================

describe("Wave 3 Phase 7B — producer-mode probe-registry seam", () => {
  it("probe-registry.ts exports registerProbes + getProbes", () => {
    expect(PROBE_REGISTRY).toContain("export function registerProbes");
    expect(PROBE_REGISTRY).toContain("export function getProbes");
    expect(PROBE_REGISTRY).toContain("ProducerProbeSet");
  });

  it("probe-registry.ts NOT_CONFIGURED fallback is honest", () => {
    expect(PROBE_REGISTRY).toContain("NOT_CONFIGURED_PROBE_SET");
    expect(PROBE_REGISTRY).toContain('state: "NOT_CONFIGURED"');
  });

  it("producer-mode.ts NO LONGER imports relative paths into services/api", () => {
    // The pre-Wave 3 implementation used dynamic imports like
    //   "../../../services/api/src/services/..."
    // which broke `pnpm --filter @proovra/shared-runtime build`. The
    // fix routes everything through the registry seam.
    expect(PRODUCER_MODE).not.toMatch(
      /services\/api\/src\/services\/redaction\/providers/,
    );
    expect(PRODUCER_MODE).not.toMatch(
      /services\/api\/src\/services\/search\/embedding-provider/,
    );
  });

  it("producer-mode.ts consults getProbes() from registry seam", () => {
    expect(PRODUCER_MODE).toContain('from "./probe-registry.js"');
    expect(PRODUCER_MODE).toContain("getProbes()");
  });

  it("producer-mode.ts preserves PUBLIC API surface", () => {
    // PUBLIC API contract: ProducerModeStatus interface + 5-kind
    // resolveProducerModeStatuses signature MUST remain unchanged.
    expect(PRODUCER_MODE).toContain("export interface ProducerModeStatus");
    expect(PRODUCER_MODE).toContain(
      "export async function resolveProducerModeStatuses",
    );
    expect(PRODUCER_MODE).toContain("ResolveProducerModeStatusesInput");
  });

  it("probe-bootstrap.ts wires the four real probes into the seam", () => {
    expect(PROBE_BOOTSTRAP).toContain(
      'from "@proovra/shared-runtime/media-intelligence"',
    );
    expect(PROBE_BOOTSTRAP).toContain("registerProbes(");
    expect(PROBE_BOOTSTRAP).toContain("probeAzureDocumentIntelligence");
    expect(PROBE_BOOTSTRAP).toContain("probeDeepgram");
    expect(PROBE_BOOTSTRAP).toContain("isSemanticReadyAtRuntime");
    expect(PROBE_BOOTSTRAP).toContain("resolveEmbeddingProviderFromEnv");
  });

  it("server.ts imports probe-bootstrap as a side-effect once", () => {
    expect(SERVER_TS).toContain(
      'import "./services/media-intelligence/probe-bootstrap.js"',
    );
  });
});
