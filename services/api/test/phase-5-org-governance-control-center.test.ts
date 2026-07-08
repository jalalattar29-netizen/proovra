/**
 * Phase 5 (Enterprise Governance) — Org Governance Control Center
 * aggregate endpoint, source-contract suite.
 *
 * Mirrors the Phase B0 source-contract style: read the route + service
 * source and assert the load-bearing structural guarantees without a
 * live DB/HTTP harness. Verifies the endpoint is:
 *
 *   - registered on the org-governance router at the expected path,
 *   - org-role gated at ORG_AUDITOR minimum with anti-enumeration 404,
 *   - read-only (no Prisma writes, no audit emission),
 *   - free of secrets/tokens/payment instruments in its projection,
 *   - correctly shaped (the required governance sections),
 *   - registered in the server.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

function readSource(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
}

const ROUTES_SRC = readSource(
  "../src/routes/organizations-governance.routes.ts",
);
const SERVICE_SRC = readSource(
  "../src/services/organization/org-governance-control-center.service.ts",
);
const SERVER_SRC = readSource("../src/server.ts");

describe("Phase 5 — org governance control-center endpoint registration", () => {
  it("registers GET /v1/orgs/:id/governance/control-center", () => {
    expect(ROUTES_SRC).toContain(
      '"/v1/orgs/:id/governance/control-center"',
    );
    expect(ROUTES_SRC).toContain("buildOrgGovernanceControlCenter");
  });

  it("is registered in the server via organizationsGovernanceRoutes", () => {
    expect(SERVER_SRC).toContain(
      "app.register(organizationsGovernanceRoutes)",
    );
  });
});

describe("Phase 5 — access gate (org-admin, ORG_AUDITOR+, anti-enumeration)", () => {
  it("gates the control-center at ORG_AUDITOR minimum", () => {
    const idx = ROUTES_SRC.indexOf(
      '"/v1/orgs/:id/governance/control-center"',
    );
    expect(idx).toBeGreaterThan(0);
    const handler = ROUTES_SRC.slice(idx, idx + 1_400);
    expect(handler).toContain("requireOrgAdmin");
    expect(handler).toContain('minRole: "ORG_AUDITOR"');
  });

  it("returns an anti-enumeration 404 on any non-OK access outcome", () => {
    const idx = ROUTES_SRC.indexOf(
      '"/v1/orgs/:id/governance/control-center"',
    );
    const handler = ROUTES_SRC.slice(idx, idx + 1_400);
    // requireOrgAdmin returns code:404 for both not_found + forbidden;
    // the handler replies with access.code (never a distinct 403).
    expect(handler).toMatch(/reply\.code\(access\.code\)/);
    expect(handler).not.toMatch(/reply\.code\(403\)/);
  });
});

describe("Phase 5 — read-only + no-secrets guarantees", () => {
  it("service performs NO Prisma writes", () => {
    expect(SERVICE_SRC).not.toMatch(/\.create\(/);
    expect(SERVICE_SRC).not.toMatch(/\.update\(/);
    expect(SERVICE_SRC).not.toMatch(/\.upsert\(/);
    expect(SERVICE_SRC).not.toMatch(/\.delete\(/);
    expect(SERVICE_SRC).not.toMatch(/\.deleteMany\(/);
  });

  it("service emits NO audit / security events", () => {
    expect(SERVICE_SRC).not.toMatch(/emitOrgAuditEvent/);
    expect(SERVICE_SRC).not.toMatch(/emitSecurityEvent/);
    expect(SERVICE_SRC).not.toMatch(/emitAuditEvent/);
  });

  it("service never selects secrets, tokens, storage keys, or payment ids", () => {
    expect(SERVICE_SRC).not.toMatch(
      /tokenHash|token_hash|rawToken|keyHash|storageKey|storage_key/i,
    );
    expect(SERVICE_SRC).not.toMatch(
      /stripeSubscriptionId|stripeCustomerId|cardLast4/i,
    );
    // Reviewer emails are workspace-internal PII — the external-sharing
    // section projects a COUNT only, never reviewer identities.
    expect(SERVICE_SRC).not.toMatch(/reviewer_email|reviewerEmail/);
  });
});

describe("Phase 5 — org → workspace scoping", () => {
  it("resolves the org's non-personal workspaces before aggregating", () => {
    expect(SERVICE_SRC).toContain("resolveOrgWorkspaceIds");
    expect(SERVICE_SRC).toMatch(
      /organizationId:\s*orgId,\s*isPersonal:\s*false/,
    );
  });

  it("aggregates every workspace-scoped read by the resolved team-id set", () => {
    // Legal holds, retention, and destruction all filter teamId IN teamIds.
    const inTeamIds = (SERVICE_SRC.match(/teamId:\s*\{\s*in:\s*teamIds\s*\}/g) ?? [])
      .length;
    expect(inTeamIds).toBeGreaterThanOrEqual(3);
  });
});

describe("Phase 5 — envelope shape (required governance sections)", () => {
  it("declares every required section", () => {
    for (const section of [
      "legalHolds",
      "retention",
      "destruction",
      "externalSharing",
      "audit",
      "coverage",
    ]) {
      expect(SERVICE_SRC).toContain(`${section}:`);
    }
  });

  it("legal-hold section carries active count + evidence-under-hold + sample", () => {
    expect(SERVICE_SRC).toContain("activeCount");
    expect(SERVICE_SRC).toContain("evidenceUnderHoldCount");
    expect(SERVICE_SRC).toContain("activeCaseHoldCount");
  });

  it("retention section carries coverage counts + org template flag", () => {
    expect(SERVICE_SRC).toContain("activePolicyCount");
    expect(SERVICE_SRC).toContain("workspacesWithPolicyCount");
    expect(SERVICE_SRC).toContain("orgTemplatePublished");
  });

  it("destruction section counts PENDING + UNDER_REVIEW reviews only", () => {
    expect(SERVICE_SRC).toContain('"PENDING"');
    expect(SERVICE_SRC).toContain('"UNDER_REVIEW"');
  });

  it("external-sharing counts ACTIVE governance grants only", () => {
    expect(SERVICE_SRC).toContain('"INVITED"');
    expect(SERVICE_SRC).toContain('"ACTIVE"');
    expect(SERVICE_SRC).toContain("activeGrantCount");
  });

  it("coverage section derives honest indicators (no synthetic health badge)", () => {
    expect(SERVICE_SRC).toContain("retentionCoveredWorkspaceCount");
    expect(SERVICE_SRC).toContain("legalHoldActive");
    expect(SERVICE_SRC).toContain("pendingDestructionCount");
  });
});

describe("Phase 5 — honest degradation (per-section try/catch)", () => {
  it("each section degrades to an 'unavailable' status rather than throwing", () => {
    // Every section sets status:"unavailable" in its catch branch.
    const unavailableCount = (
      SERVICE_SRC.match(/status:\s*"unavailable"/g) ?? []
    ).length;
    expect(unavailableCount).toBeGreaterThanOrEqual(4);
    const catchCount = (SERVICE_SRC.match(/catch\s*\{/g) ?? []).length;
    expect(catchCount).toBeGreaterThanOrEqual(5);
  });
});
