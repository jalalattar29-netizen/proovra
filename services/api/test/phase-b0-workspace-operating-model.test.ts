/**
 * Phase B0 — Workspace / Team / Organization operating model,
 * contract suite.
 *
 * Source-contract style (same shape as A0 / A1 / A2 / A3). Five
 * contracts:
 *
 *   1. The `/v1/workspaces/*` alias plugin is registered and runs
 *      ahead of every route plugin. The hook rewrites
 *      `/v1/workspaces/...` to `/v1/teams/...` at the `onRequest`
 *      hook so the existing 2,497-line teams.routes is exposed
 *      under the new vocabulary without duplication.
 *
 *   2. The platform-context envelope is bumped to v3 and accepts
 *      the `x-platform-context-version: 3` request header. Default
 *      remains 2 so legacy clients are unaffected.
 *
 *   3. The org governance write surfaces are registered:
 *      POST /v1/orgs/:id/policies/retention,
 *      GET /v1/orgs/:id/policies/retention,
 *      GET /v1/orgs/:id/billing/rollup.
 *
 *   4. The retention inheritance resolver returns exactly one of
 *      `team_policy` / `org_policy_inherited` / `none` per workspace.
 *
 *   5. Sidebar terminology is canonical "Workspaces" everywhere,
 *      with the URL `/teams` kept for backwards-compatibility.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

function readSource(rel: string): string {
  const url = new URL(rel, import.meta.url);
  return readFileSync(fileURLToPath(url), "utf8");
}

const SERVER_SRC = readSource("../src/server.ts");
const ALIAS_PLUGIN = readSource("../src/routes/workspace-alias.plugin.ts");
const TYPES_SRC = readSource(
  "../src/services/platform-context/types.ts",
);
const CTX_SERVICE = readSource(
  "../src/services/platform-context/platform-context.service.ts",
);
const CTX_ROUTES = readSource("../src/routes/platform-context.routes.ts");
const GOV_ROUTES = readSource("../src/routes/organizations-governance.routes.ts");
const ORG_AUDIT_SERVICE = readSource(
  "../src/services/organization/org-audit.service.ts",
);
const RETENTION_RESOLVER = readSource(
  "../src/services/organization/retention-inheritance.service.ts",
);
const NAV_REGISTRY = readSource(
  "../src/services/platform-context/navigation-registry.ts",
);

describe("Phase B0 — workspace URL alias", () => {
  it("plugin registers an onRequest hook that rewrites /v1/workspaces → /v1/teams", () => {
    expect(ALIAS_PLUGIN).toContain("workspaceAliasPlugin");
    expect(ALIAS_PLUGIN).toContain('"/v1/workspaces"');
    expect(ALIAS_PLUGIN).toContain('"/v1/teams"');
    expect(ALIAS_PLUGIN).toMatch(/app\.addHook\("onRequest"/);
    expect(ALIAS_PLUGIN).toMatch(/request\.raw\.url\s*=\s*rewritten/);
  });

  it("rewrite is one-way (workspaces → teams; teams is not rewritten)", () => {
    // Plugin never references /v1/teams as the SOURCE of a rewrite.
    // The teams path is the target only.
    const lines = ALIAS_PLUGIN.split("\n");
    const sourceLines = lines.filter((l) =>
      l.includes("startsWith(") || l.includes("rawUrl.startsWith"),
    );
    for (const line of sourceLines) {
      expect(line).toContain("ALIAS_PREFIX");
      expect(line).not.toContain('"/v1/teams"');
    }
  });

  it("rewrite is path-prefix-safe (rejects /v1/workspacesfoo)", () => {
    // The plugin checks `nextChar` after the prefix and only
    // rewrites when it's `/`, `?`, or end-of-string.
    expect(ALIAS_PLUGIN).toMatch(
      /nextChar !== "" && nextChar !== "\/" && nextChar !== "\?"/,
    );
  });

  it("server registers the alias plugin BEFORE any team-aware route", () => {
    const aliasIdx = SERVER_SRC.indexOf("app.register(workspaceAliasPlugin)");
    const teamsIdx = SERVER_SRC.indexOf("app.register(teamsRoutes)");
    expect(aliasIdx).toBeGreaterThan(0);
    expect(teamsIdx).toBeGreaterThan(0);
    expect(aliasIdx).toBeLessThan(teamsIdx);
  });
});

describe("Phase B0 — platform-context envelope v3", () => {
  it("AUTHORITY_SCHEMA_VERSION is bumped to 3", () => {
    expect(TYPES_SRC).toMatch(
      /export\s+const\s+AUTHORITY_SCHEMA_VERSION:\s*number\s*=\s*3/,
    );
  });

  it("legacy workspace field is marked @deprecated", () => {
    // Pre-B0 contract: the `workspace` field in the envelope type
    // carries an `@deprecated` JSDoc comment pointing at
    // `activeSpace`. The annotation may span multiple lines.
    expect(TYPES_SRC).toMatch(/@deprecated[\s\S]{0,200}activeSpace/);
  });

  it("BuildPlatformContext accepts a requestedSchemaVersion", () => {
    expect(CTX_SERVICE).toContain("requestedSchemaVersion?: 2 | 3");
    expect(CTX_SERVICE).toMatch(/wireVersion[\s\S]*=\s*input\.requestedSchemaVersion === 3 \? 3 : 2/);
    expect(CTX_SERVICE).toContain("authoritySchemaVersion: wireVersion");
  });

  it("the GET /v1/platform/context route reads x-platform-context-version", () => {
    expect(CTX_ROUTES).toContain("readRequestedSchemaVersion");
    expect(CTX_ROUTES).toContain("x-platform-context-version");
    expect(CTX_ROUTES).toMatch(/requestedSchemaVersion:\s*readRequestedSchemaVersion\(req\)/);
  });

  it("unknown version values fall back to v2 for safety", () => {
    expect(CTX_ROUTES).toMatch(/if \(value === "3"\)\s*return\s+3/);
    expect(CTX_ROUTES).toMatch(/return\s+2/);
  });
});

describe("Phase B0 — organization governance write surfaces", () => {
  it("POST /v1/orgs/:id/policies/retention is registered", () => {
    expect(GOV_ROUTES).toContain('"/v1/orgs/:id/policies/retention"');
    expect(GOV_ROUTES).toContain('"retention.default"');
  });

  it("retention publish is gated on ORG_ADMIN minimum", () => {
    // The default minRole inside `requireOrgAdmin` falls back to
    // `"ORG_ADMIN"`; the source contains the literal once.
    expect(GOV_ROUTES).toMatch(/minRole\s*\?\?\s*"ORG_ADMIN"/);
    expect(GOV_ROUTES).toContain("requireOrgAdmin");
  });

  it("retention publish emits ORG_POLICY_RETENTION_PUBLISHED audit", () => {
    expect(GOV_ROUTES).toContain(
      '"ORG_POLICY_RETENTION_PUBLISHED"',
    );
    expect(ORG_AUDIT_SERVICE).toContain('"ORG_POLICY_RETENTION_PUBLISHED"');
  });

  it("billing rollup is gated at ORG_BILLING_ADMIN minimum", () => {
    expect(GOV_ROUTES).toContain('minRole: "ORG_BILLING_ADMIN"');
  });

  it("billing rollup returns counts only — no card tokens, no Stripe ids", () => {
    // Scope to the registered handler — the route file's top
    // comment also mentions the path so we anchor on the registration.
    const registerIdx = GOV_ROUTES.indexOf(
      'app.get(\n    "/v1/orgs/:id/billing/rollup"',
    );
    expect(registerIdx).toBeGreaterThan(0);
    const handlerSlice = GOV_ROUTES.slice(registerIdx, registerIdx + 3_500);
    expect(handlerSlice).not.toMatch(
      /stripeSubscriptionId|stripeCustomerId|cardLast4/,
    );
    expect(handlerSlice).toContain("workspaceCount");
    expect(handlerSlice).toContain("planCounts");
  });

  it("write endpoints emit anti-enumeration 404 — never 403 — on access denial", () => {
    // `requireOrgAdmin` and `requireOrgMember` both return `code: 404`
    // for any non-OK outcome (not_found / forbidden) so org existence
    // is not enumerable.
    expect(GOV_ROUTES).toMatch(
      /if \(result\.kind !== "ok"\)[\s\S]*?return\s*\{\s*ok:\s*false,\s*code:\s*404/,
    );
  });
});

describe("Phase B0 — retention inheritance resolver", () => {
  it("exports the bounded RetentionResolution union", () => {
    expect(RETENTION_RESOLVER).toContain('"team_policy"');
    expect(RETENTION_RESOLVER).toContain('"org_policy_inherited"');
    expect(RETENTION_RESOLVER).toContain('"none"');
  });

  it("resolution order is team-first → org-inherited → none", () => {
    // The function body checks team policy BEFORE the org policy.
    const fn = RETENTION_RESOLVER.slice(
      RETENTION_RESOLVER.indexOf("export async function resolveTeamRetentionPolicy"),
    );
    const teamIdx = fn.indexOf("evidenceRetentionPolicy.findFirst");
    const orgIdx = fn.indexOf("organizationPolicy.findUnique");
    expect(teamIdx).toBeGreaterThan(0);
    expect(orgIdx).toBeGreaterThan(0);
    expect(teamIdx).toBeLessThan(orgIdx);
  });

  it("resolver is read-only — never creates a team policy from an inherited template", () => {
    expect(RETENTION_RESOLVER).not.toMatch(
      /\bevidenceRetentionPolicy\.create\(/,
    );
    expect(RETENTION_RESOLVER).not.toMatch(
      /\bevidenceRetentionPolicy\.upsert\(/,
    );
  });

  it("DB errors fall through to `none` — never throws", () => {
    // Two try/catch guards on the two reads.
    const catchCount = (RETENTION_RESOLVER.match(/catch\s*\{/g) ?? []).length;
    expect(catchCount).toBeGreaterThanOrEqual(2);
  });
});

describe("Phase B0 — sidebar vocabulary", () => {
  it("server navigation registry surfaces 'Workspaces' label", () => {
    // Both the administration sidebar entry and the account-menu
    // entry now read "Workspaces".
    const matches = NAV_REGISTRY.match(/label:\s*"Workspaces"/g) ?? [];
    expect(matches.length).toBeGreaterThanOrEqual(2);
  });

  it("server registry does NOT carry a literal 'Teams' label any more", () => {
    // The two known sites previously labelled "Teams" are now
    // "Workspaces"; the URL stays `/teams` for backwards-compat.
    expect(NAV_REGISTRY).not.toMatch(/label:\s*"Teams"\s*,/);
  });

  it("URL /teams is preserved (no breaking redirect)", () => {
    expect(NAV_REGISTRY).toMatch(/href:\s*"\/teams"/);
  });
});
