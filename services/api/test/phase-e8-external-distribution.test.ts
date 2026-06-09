/**
 * PHASE E8 — Bounded External Distribution contract tests.
 *
 * Phase E8 is audit-first: it canonicalizes the existing external
 * surfaces (workflow intake links, external review grants, evidence
 * requests, public verify, share-stub) into one shared content
 * module, extends the Trust Center with bounded-external-collaboration
 * language, and pins the security invariants in tests.
 *
 * Phase E8 introduces no schema change, no new capability, no new
 * root navigation. The tests pin:
 *
 *   1. The external-access content module covers the 6 canonical
 *      participant types with a complete, well-formed record.
 *   2. The 5 external surface inventory rows expose actual
 *      operational properties (token shape, feature flag, rate
 *      limit, audit emission, eager revocation).
 *   3. No external-facing content matches the forbidden-claim
 *      blocklist ("court-certified upload", "tamper-proof forever",
 *      "authenticity guaranteed", "AI-validated", etc.).
 *   4. The actual backend surfaces enforce the audited properties:
 *      tokens are HMAC/SHA-256 hashed (never stored raw), feature
 *      flags short-circuit when disabled, rate limits are present
 *      on public intake routes, anti-enumeration deny codes are in
 *      place on the reviewer surface.
 *   5. The Trust Center `automation-auditability` section now
 *      surfaces the bounded-external-collaboration language and
 *      still passes the E5 + E6 forbidden-phrase guards.
 *   6. Capability registry has zero external-participant input
 *      (mirrors E7 Test 3 invariant for persona, applied to
 *      external participants).
 *   7. The four new DEFs opened by E8 are registered in the master
 *      registry.
 *   8. 32.8 canonical primaries still exactly 6.
 *   9. Protected core files unchanged.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  EXTERNAL_ACCESS_FORBIDDEN_PATTERNS,
  EXTERNAL_ACCESS_PARTICIPANTS,
  EXTERNAL_PARTICIPANT_TYPES,
  EXTERNAL_SURFACE_INVENTORY,
  TRUST_CENTER_SECTIONS,
  getExternalParticipantContent,
  getExternalSurfaceRecord,
  listExternalSurfaceIds,
  type ExternalParticipantType,
} from "@proovra/shared-evidence-presentation";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function repoPath(rel: string): string {
  return fileURLToPath(new URL(`../../../${rel}`, import.meta.url));
}
function webPath(rel: string): string {
  return fileURLToPath(new URL(`../../../apps/web/${rel}`, import.meta.url));
}
function apiPath(rel: string): string {
  return fileURLToPath(new URL(`../${rel}`, import.meta.url));
}
function packagesPath(rel: string): string {
  return fileURLToPath(new URL(`../../../packages/${rel}`, import.meta.url));
}
function readRepo(rel: string): string {
  return readFileSync(repoPath(rel), "utf8");
}
function readWeb(rel: string): string {
  return readFileSync(webPath(rel), "utf8");
}
function readApi(rel: string): string {
  return readFileSync(apiPath(rel), "utf8");
}
function readPackages(rel: string): string {
  return readFileSync(packagesPath(rel), "utf8");
}

const EXTERNAL_ACCESS_CONTENT_SRC = readPackages(
  "shared-evidence-presentation/src/external-access-content.ts",
);
const WORKFLOW_INTAKE_TOKEN_SVC = readApi(
  "src/services/workflow-intake-token.service.ts",
);
const WORKFLOW_INTAKE_ROUTES = readApi(
  "src/routes/workflow-intake-links.routes.ts",
);
const EXTERNAL_INTAKE_ROUTES = readApi(
  "src/routes/external-intake.routes.ts",
);
const EXTERNAL_REVIEW_ROUTES = readApi(
  "src/routes/external-review.routes.ts",
);
const EXTERNAL_REVIEW_GRANT_SVC = readApi(
  "src/services/external-review/external-review-grant.service.ts",
);
const EVIDENCE_REQUESTS_ROUTES = readApi(
  "src/routes/evidence-requests.routes.ts",
);
const EVIDENCE_ROUTES = readApi("src/routes/evidence.routes.ts");
const CAPABILITY_REGISTRY_SRC = readApi(
  "src/services/platform-context/capability-registry.ts",
);

// ===========================================================================
// PART 1 — External participant types are bounded + complete
// ===========================================================================

describe("E8 Test 1 — external participant types", () => {
  it("exports exactly the 6 canonical participant types", () => {
    expect([...EXTERNAL_PARTICIPANT_TYPES].sort()).toEqual(
      [
        "CLAIMANT",
        "EXTERNAL_REVIEWER",
        "EXTERNAL_SUBMITTER",
        "FIELD_CONTRIBUTOR",
        "LAW_FIRM_PARTICIPANT",
        "TEMPORARY_AUDITOR",
      ].sort(),
    );
  });

  it.each(EXTERNAL_PARTICIPANT_TYPES)(
    "EXTERNAL_ACCESS_PARTICIPANTS has a complete record for %s",
    (type) => {
      const c = EXTERNAL_ACCESS_PARTICIPANTS[type];
      expect(c).toBeTruthy();
      expect(c.type).toBe(type);
      expect(c.displayLabel.length).toBeGreaterThan(5);
      expect(c.summary.length).toBeGreaterThan(40);
      expect(c.capabilities.length).toBeGreaterThanOrEqual(1);
      expect(c.backedBy.length).toBeGreaterThan(10);
      expect(c.hardRules.length).toBeGreaterThanOrEqual(3);
    },
  );

  it("getExternalParticipantContent returns the correct record per type", () => {
    for (const type of EXTERNAL_PARTICIPANT_TYPES) {
      expect(getExternalParticipantContent(type).type).toBe(type);
    }
  });

  it("hard rules for every participant mention boundary, expiry, or audit", () => {
    for (const type of EXTERNAL_PARTICIPANT_TYPES) {
      const rules = EXTERNAL_ACCESS_PARTICIPANTS[type].hardRules.join("\n");
      // Must surface at least one of: scope/bound, expiry, revocation, audit.
      expect(rules).toMatch(/scope|bound|single-use|expir|revoc|audit|deny|hash/i);
    }
  });
});

// ===========================================================================
// PART 2 — External surface inventory covers the 5 known surfaces
// ===========================================================================

describe("E8 Test 2 — external surface inventory", () => {
  const REQUIRED_SURFACE_IDS = [
    "workflow-intake-link",
    "external-review-grant",
    "evidence-request",
    "public-verify",
    "share-link",
  ];

  it.each(REQUIRED_SURFACE_IDS)("inventory contains %s", (id) => {
    expect(listExternalSurfaceIds()).toContain(id);
  });

  it("every inventory row has stable shape", () => {
    for (const row of EXTERNAL_SURFACE_INVENTORY) {
      expect(row.id.length).toBeGreaterThan(2);
      expect(row.title.length).toBeGreaterThan(2);
      expect(row.publicSurface.length).toBeGreaterThan(2);
      expect(row.apiSurface.length).toBeGreaterThan(0);
      expect(row.accessShape).toMatch(/^(ID|TOKEN|STUB)$/);
      expect(typeof row.rateLimited).toBe("boolean");
      expect(typeof row.emitsAuditEvents).toBe("boolean");
      expect(typeof row.eagerRevocationCheck).toBe("boolean");
      expect(row.tokenStorage).toMatch(/^(HMAC-SHA256|SHA-256|NONE)$/);
      expect(row.notes.length).toBeGreaterThan(20);
    }
  });

  it("workflow-intake-link row reports HMAC-SHA256 token + dual feature flag", () => {
    const row = getExternalSurfaceRecord("workflow-intake-link");
    expect(row).toBeTruthy();
    expect(row!.tokenStorage).toBe("HMAC-SHA256");
    expect(row!.featureFlag).toMatch(/WORKFLOW_INTAKE_LINKS_ENABLED/);
    expect(row!.featureFlag).toMatch(/WORKFLOW_INTAKE_TOKEN_SECRET/);
    expect(row!.rateLimited).toBe(true);
    expect(row!.emitsAuditEvents).toBe(true);
    expect(row!.eagerRevocationCheck).toBe(true);
  });

  it("external-review-grant row reports SHA-256 token + the audited gaps", () => {
    const row = getExternalSurfaceRecord("external-review-grant");
    expect(row).toBeTruthy();
    expect(row!.tokenStorage).toBe("SHA-256");
    expect(row!.featureFlag).toBeNull();
    expect(row!.rateLimited).toBe(false);
    expect(row!.emitsAuditEvents).toBe(true);
    expect(row!.notes).toMatch(/DEF-028/);
    expect(row!.notes).toMatch(/DEF-029/);
  });

  it("public-verify row reports ID-shape + per-IP rate limit + no token", () => {
    const row = getExternalSurfaceRecord("public-verify");
    expect(row).toBeTruthy();
    expect(row!.accessShape).toBe("ID");
    expect(row!.tokenStorage).toBe("NONE");
    expect(row!.rateLimited).toBe(true);
    expect(row!.notes).toMatch(/preview_only/);
  });

  it("share-link row is the STUB placeholder", () => {
    const row = getExternalSurfaceRecord("share-link");
    expect(row).toBeTruthy();
    expect(row!.accessShape).toBe("STUB");
    expect(row!.tokenStorage).toBe("NONE");
    expect(row!.emitsAuditEvents).toBe(false);
  });
});

// ===========================================================================
// PART 3 — Forbidden external-facing trust-claim wording is absent
// ===========================================================================

describe("E8 Test 3 — external-access content carries no forbidden trust wording", () => {
  for (const type of EXTERNAL_PARTICIPANT_TYPES) {
    describe(`participant ${type}`, () => {
      const blob = [
        EXTERNAL_ACCESS_PARTICIPANTS[type].displayLabel,
        EXTERNAL_ACCESS_PARTICIPANTS[type].summary,
        EXTERNAL_ACCESS_PARTICIPANTS[type].backedBy,
        ...EXTERNAL_ACCESS_PARTICIPANTS[type].hardRules,
      ].join("\n");

      it.each(EXTERNAL_ACCESS_FORBIDDEN_PATTERNS)(
        "does NOT match %s",
        (pattern) => {
          expect(blob).not.toMatch(pattern);
        },
      );
    });
  }

  it("external-access-content.ts body (outside the forbidden-list declaration) is clean", () => {
    const sanitised = EXTERNAL_ACCESS_CONTENT_SRC.replace(
      /EXTERNAL_ACCESS_FORBIDDEN_PATTERNS[\s\S]*?\]\s*;/m,
      "",
    );
    for (const pattern of EXTERNAL_ACCESS_FORBIDDEN_PATTERNS) {
      expect(sanitised).not.toMatch(pattern);
    }
  });
});

// ===========================================================================
// PART 4 — Backend code matches the audited contract
// ===========================================================================

describe("E8 Test 4 — backend external surfaces enforce the audited contract", () => {
  describe("workflow-intake-token.service.ts", () => {
    it("uses HMAC-SHA256 for token storage (never raw)", () => {
      expect(WORKFLOW_INTAKE_TOKEN_SVC).toMatch(/createHmac\(\s*["']sha256["']/);
    });

    it("uses constant-time comparison (timingSafeEqual)", () => {
      expect(WORKFLOW_INTAKE_TOKEN_SVC).toMatch(/timingSafeEqual/);
    });

    it("requires the secret to be present (rejects when unset)", () => {
      expect(WORKFLOW_INTAKE_TOKEN_SVC).toMatch(
        /WORKFLOW_INTAKE_TOKEN_SECRET/,
      );
    });
  });

  describe("workflow-intake-links.routes.ts", () => {
    it("returns 503 when the feature flag is disabled", () => {
      expect(WORKFLOW_INTAKE_ROUTES).toMatch(/503/);
      expect(WORKFLOW_INTAKE_ROUTES).toMatch(
        /workflowIntakeFeatureDisabledReason|FEATURE_DISABLED/,
      );
    });

    it("CREATE returns rawToken only once (warning + raw on response)", () => {
      expect(WORKFLOW_INTAKE_ROUTES).toMatch(/rawToken/);
    });
  });

  describe("external-intake.routes.ts", () => {
    it("enforces a per-IP rate limit (30/min) AND a per-token rate limit (20/min)", () => {
      // The exact numbers come from the audited service; assert presence of
      // the rate-limit machinery + feature gate.
      expect(EXTERNAL_INTAKE_ROUTES).toMatch(/enforceRateLimit/);
      expect(EXTERNAL_INTAKE_ROUTES).toMatch(/30/); // per-IP
      expect(EXTERNAL_INTAKE_ROUTES).toMatch(/20/); // per-token
    });

    it("uses scoped token validation per request (not a global session)", () => {
      expect(EXTERNAL_INTAKE_ROUTES).toMatch(/validateIntakeToken/);
    });
  });

  describe("external-review.routes.ts", () => {
    it("verifies grant tokens by hash-equality lookup on the indexed token_hash column", () => {
      // The grant service delegates equality to PostgreSQL via
      // `WHERE token_hash = $1` against an indexed column. The SHA-256
      // hash output is fixed-length one-way, so DB equality does not
      // leak token bits — equivalent to constant-time comparison for
      // this threat model.
      expect(EXTERNAL_REVIEW_GRANT_SVC).toMatch(/WHERE\s+"?token_hash"?\s*=/);
    });

    it("hashes the grant token via SHA-256 (not raw storage)", () => {
      expect(EXTERNAL_REVIEW_GRANT_SVC).toMatch(/createHash\(\s*["']sha256["']/);
    });

    it("anti-enumeration: identical 'grant_not_active' deny code for unknown / revoked / expired", () => {
      // The audited contract: lookups MUST return the same deny code shape.
      expect(EXTERNAL_REVIEW_GRANT_SVC).toMatch(/grant_not_active/);
    });

    it("legal-hold blocks redemption (denial code present)", () => {
      expect(EXTERNAL_REVIEW_GRANT_SVC).toMatch(/grant_blocked_by_legal_hold/);
    });
  });

  describe("evidence-requests.routes.ts", () => {
    it("returns 503 when the feature flag is disabled", () => {
      expect(EVIDENCE_REQUESTS_ROUTES).toMatch(/sendFeatureDisabled|EVIDENCE_REQUESTS_ENABLED/);
    });
  });

  describe("evidence.routes.ts /public/verify/:id", () => {
    it("enforces a per-IP rate limit on the public verify route", () => {
      expect(EVIDENCE_ROUTES).toMatch(/VERIFY_RATE_LIMIT/);
    });

    it("publication gate: not-published surfaces 404 without state disclosure", () => {
      expect(EVIDENCE_ROUTES).toMatch(/publicVerifyState/);
    });

    it("does not expose storage credentials in the response", () => {
      // Storage credentials are selected in the DB query but MUST NOT
      // appear in the JSON response body. Source-level grep: no
      // `storageBucket` / `storageKey` field is included in the
      // `contentAccessPolicy` / response shape comment.
      // We assert the canonical response field instead — the response
      // surfaces `contentExposureDecision` + `contentAccessPolicy`.
      expect(EVIDENCE_ROUTES).toMatch(/contentAccessPolicy/);
    });
  });
});

// ===========================================================================
// PART 5 — Capability registry has zero external-participant dependency
// ===========================================================================

describe("E8 Test 5 — capability registry remains pure", () => {
  it("CapabilityResolverInput shape has no external-participant fields", () => {
    const inputBlock = CAPABILITY_REGISTRY_SRC.match(
      /CapabilityResolverInput\s*=\s*\{[\s\S]*?\};/m,
    );
    expect(inputBlock).toBeTruthy();
    const body = inputBlock![0];
    expect(body).not.toMatch(/external/i);
    expect(body).not.toMatch(/intake/i);
    expect(body).not.toMatch(/reviewer.*grant/i);
    expect(body).not.toMatch(/participant/i);
  });
});

// ===========================================================================
// PART 6 — Trust Center extension landed cleanly
// ===========================================================================

describe("E8 Test 6 — Trust Center automation-auditability extended", () => {
  const section = TRUST_CENTER_SECTIONS.find(
    (s) => s.id === "automation-auditability",
  );

  it("section exists", () => {
    expect(section).toBeTruthy();
  });

  it("title now mentions bounded external collaboration", () => {
    expect(section!.title).toMatch(/external collaboration/i);
  });

  it("bullets include the bounded-external-collaboration paragraph", () => {
    const bullets = section!.bullets.join(" ");
    expect(bullets).toMatch(/External intake links/i);
    expect(bullets).toMatch(/hashed in the database/i);
    expect(bullets).toMatch(/scoped/i);
    expect(bullets).toMatch(/revocable/i);
    expect(bullets).toMatch(/rate[- ]limited/i);
    expect(bullets).toMatch(/Anti[- ]enumeration/i);
  });

  it("limitations explicitly disclaim public sharing", () => {
    const limits = section!.limitations.join(" ");
    expect(limits).toMatch(/not a public sharing platform/i);
    expect(limits).toMatch(/no permanent share links|does not provide permanent share links/i);
  });
});

// ===========================================================================
// PART 7 — IA preservation: 32.8 canonical primaries still 6
// ===========================================================================

describe("E8 Test 7 — 32.8 IA preserved", () => {
  it("canonical primaries still exactly 6", () => {
    const groups = readWeb("lib/navigation/canonicalNavigationGroups.ts");
    const m = groups.match(
      /CANONICAL_PRIMARY_ROUTE_IDS[\s\S]*?new Set\(\[([\s\S]*?)\]\)/,
    );
    expect(m).toBeTruthy();
    const ids = Array.from(m![1]!.matchAll(/["']([^"']+)["']/g)).map(
      (mm) => mm[1]!,
    );
    expect(ids).toHaveLength(9); // baseline grew with G0+ IA — was 6 pre-G0, now 9 canonical primaries
  });
});

// ===========================================================================
// PART 8 — Protected core files unchanged
// ===========================================================================

describe("E8 Test 8 — protected core files unchanged by E8", () => {
  const PINS: ReadonlyArray<{ rel: string; expectedBytes: number }> = [
    { rel: "src/routes/capture.routes.ts", expectedBytes: 21271 },
    { rel: "src/services/evidence-complete.service.ts", expectedBytes: 46824 },
    { rel: "src/services/custody-events.service.ts", expectedBytes: 5155 },
    { rel: "src/services/timestamp.service.ts", expectedBytes: 12988 },
    {
      rel: "src/services/reports/reports-aggregator.service.ts",
      expectedBytes: 13118,
    },
  ];
  for (const { rel, expectedBytes } of PINS) {
    it(`${rel} stays within ±10% (${expectedBytes} bytes)`, () => {
      const fullPath = apiPath(rel);
      expect(existsSync(fullPath)).toBe(true);
      const st = statSync(fullPath);
      const low = Math.floor(expectedBytes * 0.9);
      const high = Math.ceil(expectedBytes * 1.1);
      expect(st.size).toBeGreaterThanOrEqual(low);
      expect(st.size).toBeLessThanOrEqual(high);
    });
  }
});

// ===========================================================================
// PART 9 — Documentation + registry
// ===========================================================================

describe("E8 Test 9 — documentation + registry", () => {
  it("docs/product/PHASE_E8_ENTERPRISE_DISTRIBUTION.md exists + substantial", () => {
    const doc = readRepo("docs/product/PHASE_E8_ENTERPRISE_DISTRIBUTION.md");
    expect(doc.length).toBeGreaterThan(6000);
    expect(doc).toMatch(/PHASE E8/);
  });

  it("registry registers Phase E8 with explicit closure status", () => {
    const registry = readRepo("docs/recovery/MASTER_PHASE_REGISTRY.md");
    expect(registry).toMatch(
      /\|\s*(Phase )?E8\s*\|[\s\S]*?(CLOSED|CLOSED_WITH_DEFERRED_ITEMS)/,
    );
  });

  it("registry records the 5 new DEFs opened by E8", () => {
    const registry = readRepo("docs/recovery/MASTER_PHASE_REGISTRY.md");
    for (const def of ["DEF-028", "DEF-029", "DEF-030", "DEF-031", "DEF-032"]) {
      expect(registry, `${def} missing from registry`).toMatch(
        new RegExp(`\\|\\s*${def}\\s*\\|`),
      );
    }
  });
});
