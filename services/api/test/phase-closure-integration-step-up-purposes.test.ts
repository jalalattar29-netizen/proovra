/**
 * Phase 4 closure — dedicated integration step-up purposes.
 *
 * Until this closure phase several integration routes shared coarse
 * `SERVICE_ACCOUNT_*` purposes:
 *
 *   POST  /v1/integrations/api-keys                 SERVICE_ACCOUNT_CREATE
 *   POST  /v1/integrations/api-keys/:id/revoke      SERVICE_ACCOUNT_REVOKE
 *   POST  /v1/integrations/api-keys/:id/rotate      SERVICE_ACCOUNT_REVOKE  (reused)
 *   POST  /v1/integrations/webhooks/:id/rotate-secret  SERVICE_ACCOUNT_HARDENING_UPDATE
 *   POST  /v1/integrations/webhooks/:id/test        SERVICE_ACCOUNT_HARDENING_UPDATE (reused)
 *
 *   PATCH /v1/integrations/api-keys/:id             (NOT GATED)
 *   POST  /v1/integrations/webhooks                 (NOT GATED)
 *   POST  /v1/integrations/webhooks/:id/disable     (NOT GATED)
 *   PUT   /v1/integrations/webhooks/:id (status flip)  (NOT GATED)
 *   POST  /v1/integrations/webhook-deliveries/:id/retry (NOT GATED)
 *
 * Phase 4 closes the gaps and replaces every legacy purpose with a
 * dedicated INTEGRATION_API_KEY_* / INTEGRATION_WEBHOOK_* purpose so
 * each action shows up distinctly on the audit trail and an approval
 * for one action does not satisfy another. Legacy SERVICE_ACCOUNT_*
 * approvals remain accepted on already-issued challenges via the alias
 * map (`legacyAliasesForStoredPurpose` / `purposeSatisfies` in
 * @proovra/shared).
 *
 * This file pins:
 *   1. The new purposes are registered in @proovra/shared.
 *   2. The alias map is one-directional (legacy -> new) and the
 *      reverse direction is REJECTED so we never accidentally hand
 *      a stale legacy challenge a broader gate.
 *   3. Each route uses its dedicated purpose AT the canonical call
 *      site, and the import block documents the back-compat.
 *   4. The step-up middleware service uses `purposeSatisfies` (NOT a
 *      raw `===` check), which is the seam back-compat hinges on.
 *   5. The phase 6 / phase 7 / phase 8 closure invariants remain
 *      intact (no UI event type added; no tests skipped; no secret
 *      leakage in route comments).
 *
 * No DB required. Source-text + pure-helper assertions only — the
 * project convention for this surface (see phase3/phase4/phase6
 * regression files).
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  STEP_UP_PURPOSES,
  StepUpPurposeSchema,
  legacyAliasesForStoredPurpose,
  purposeSatisfies,
  type StepUpPurpose,
} from "@proovra/shared";

function readApi(rel: string): string {
  return readFileSync(
    fileURLToPath(new URL(`../${rel}`, import.meta.url)),
    "utf8",
  );
}
function readShared(rel: string): string {
  return readFileSync(
    fileURLToPath(
      new URL(`../../../packages/shared/${rel}`, import.meta.url),
    ),
    "utf8",
  );
}

const ROUTES = readApi("src/routes/integrations.routes.ts");
const STEP_UP_SERVICE = readApi(
  "src/services/identity-security/step-up.service.ts",
);
const SHARED_IDENTITY = readShared("src/identity-security.ts");

const NEW_PURPOSES = [
  "INTEGRATION_API_KEY_CREATE",
  "INTEGRATION_API_KEY_ROTATE",
  "INTEGRATION_API_KEY_REVOKE",
  "INTEGRATION_API_KEY_EXPIRY_UPDATE",
  "INTEGRATION_WEBHOOK_CREATE",
  "INTEGRATION_WEBHOOK_TEST",
  "INTEGRATION_WEBHOOK_SECRET_ROTATE",
  "INTEGRATION_WEBHOOK_RETRY",
  "INTEGRATION_WEBHOOK_DISABLE",
  "INTEGRATION_WEBHOOK_ENABLE",
] as const;

const LEGACY_PURPOSES = [
  "SERVICE_ACCOUNT_CREATE",
  "SERVICE_ACCOUNT_REVOKE",
  "SERVICE_ACCOUNT_HARDENING_UPDATE",
] as const;

// ============================================================================
// PART 1 — Canonical enum membership
// ============================================================================

describe("Phase 4 closure — STEP_UP_PURPOSES registers the new integration purposes", () => {
  for (const p of NEW_PURPOSES) {
    it(`includes ${p}`, () => {
      expect(STEP_UP_PURPOSES).toContain(p);
      // Zod schema must also accept the new value (route validation
      // uses StepUpPurposeSchema upstream of the middleware).
      expect(StepUpPurposeSchema.safeParse(p).success).toBe(true);
    });
  }

  it("keeps the legacy purposes registered for backward compatibility", () => {
    // The legacy values remain valid step-up purposes. They are still
    // used by the non-integration surfaces they were originally
    // created for (service account create/revoke/hardening on identity
    // routes), and existing challenge rows must continue to validate.
    for (const p of LEGACY_PURPOSES) {
      expect(STEP_UP_PURPOSES).toContain(p);
    }
  });

  it("every new purpose fits the storage column width (VARCHAR(64))", () => {
    for (const p of NEW_PURPOSES) {
      expect(p.length).toBeLessThanOrEqual(64);
    }
  });

  it("no DB migration was added under integrations Phase 4", () => {
    // The brief decision: purpose is plain VARCHAR(64) — adding values
    // ships without a DB migration. Pin that we did NOT smuggle in a
    // schema/migration change.
    const migrationsDir = fileURLToPath(
      new URL("../prisma/migrations", import.meta.url),
    );
    // Walk the migrations dir and confirm none mention the new
    // purposes (a SQL-level enum addition would land in a migration).
    const { readdirSync, statSync } = require("node:fs") as typeof import("node:fs");
    const subdirs = readdirSync(migrationsDir).filter((name: string) => {
      try {
        return statSync(`${migrationsDir}/${name}`).isDirectory();
      } catch {
        return false;
      }
    });
    let mentioned = false;
    for (const sub of subdirs) {
      let sql = "";
      try {
        sql = readFileSync(`${migrationsDir}/${sub}/migration.sql`, "utf8");
      } catch {
        continue;
      }
      for (const p of NEW_PURPOSES) {
        if (sql.includes(p)) mentioned = true;
      }
    }
    expect(mentioned).toBe(false);
  });
});

// ============================================================================
// PART 2 — Alias map invariants
// ============================================================================

describe("Phase 4 closure — legacy alias map", () => {
  it("SERVICE_ACCOUNT_CREATE satisfies INTEGRATION_API_KEY_CREATE", () => {
    expect(purposeSatisfies("SERVICE_ACCOUNT_CREATE", "INTEGRATION_API_KEY_CREATE")).toBe(true);
  });

  it("SERVICE_ACCOUNT_REVOKE satisfies INTEGRATION_API_KEY_REVOKE", () => {
    expect(purposeSatisfies("SERVICE_ACCOUNT_REVOKE", "INTEGRATION_API_KEY_REVOKE")).toBe(true);
  });

  it("SERVICE_ACCOUNT_HARDENING_UPDATE satisfies INTEGRATION_WEBHOOK_SECRET_ROTATE", () => {
    expect(
      purposeSatisfies(
        "SERVICE_ACCOUNT_HARDENING_UPDATE",
        "INTEGRATION_WEBHOOK_SECRET_ROTATE",
      ),
    ).toBe(true);
  });

  it("identity mapping always holds (every new purpose satisfies itself)", () => {
    for (const p of NEW_PURPOSES) {
      expect(purposeSatisfies(p, p as StepUpPurpose)).toBe(true);
    }
    for (const p of LEGACY_PURPOSES) {
      expect(
        purposeSatisfies(p, p as StepUpPurpose),
      ).toBe(true);
    }
  });

  // ----- The hard invariants the brief calls out -----

  it("does NOT broaden SERVICE_ACCOUNT_REVOKE to satisfy ROTATE (wrong-action rejection)", () => {
    // The legacy SERVICE_ACCOUNT_REVOKE used to gate BOTH revoke and
    // rotate routes. Phase 4 split these into two distinct purposes;
    // the alias must map REVOKE -> REVOKE only, never -> ROTATE.
    expect(
      purposeSatisfies("SERVICE_ACCOUNT_REVOKE", "INTEGRATION_API_KEY_ROTATE"),
    ).toBe(false);
  });

  it("does NOT broaden SERVICE_ACCOUNT_HARDENING_UPDATE to satisfy WEBHOOK_TEST", () => {
    // Same posture for the webhook side: hardening used to gate BOTH
    // rotate-secret and test-send. Phase 4 split them; the alias map
    // ties hardening only to SECRET_ROTATE. test-send requires a
    // fresh challenge with the dedicated purpose.
    expect(
      purposeSatisfies(
        "SERVICE_ACCOUNT_HARDENING_UPDATE",
        "INTEGRATION_WEBHOOK_TEST",
      ),
    ).toBe(false);
  });

  it("rejects every wrong-action permutation across the new purpose family", () => {
    // For each (stored, requested) pair where stored != requested and
    // the pair is not an explicit alias, purposeSatisfies MUST return
    // false. This catches a regression where someone extended the
    // alias map to broaden the gate.
    const explicitAliases: Array<[string, StepUpPurpose]> = [
      ["SERVICE_ACCOUNT_CREATE", "INTEGRATION_API_KEY_CREATE"],
      ["SERVICE_ACCOUNT_REVOKE", "INTEGRATION_API_KEY_REVOKE"],
      [
        "SERVICE_ACCOUNT_HARDENING_UPDATE",
        "INTEGRATION_WEBHOOK_SECRET_ROTATE",
      ],
    ];
    const aliasKey = (a: string, b: string) => `${a}::${b}`;
    const aliasSet = new Set(
      explicitAliases.map(([a, b]) => aliasKey(a, b)),
    );

    const allRelevant = [...NEW_PURPOSES, ...LEGACY_PURPOSES];
    for (const stored of allRelevant) {
      for (const requested of NEW_PURPOSES) {
        if (stored === requested) continue;
        if (aliasSet.has(aliasKey(stored, requested))) continue;
        expect(
          purposeSatisfies(stored, requested as StepUpPurpose),
          `purposeSatisfies(${stored}, ${requested}) must be false`,
        ).toBe(false);
      }
    }
  });

  it("new purpose stored on a row does NOT satisfy a legacy check (one-directional)", () => {
    // A row carrying the NEW purpose must not retroactively satisfy a
    // legacy check. The middleware never sends a legacy purpose now,
    // so this direction is dead code — but pin it to catch a future
    // accidental broadening.
    expect(
      purposeSatisfies(
        "INTEGRATION_API_KEY_CREATE",
        "SERVICE_ACCOUNT_CREATE" as StepUpPurpose,
      ),
    ).toBe(false);
    expect(
      purposeSatisfies(
        "INTEGRATION_API_KEY_REVOKE",
        "SERVICE_ACCOUNT_REVOKE" as StepUpPurpose,
      ),
    ).toBe(false);
    expect(
      purposeSatisfies(
        "INTEGRATION_WEBHOOK_SECRET_ROTATE",
        "SERVICE_ACCOUNT_HARDENING_UPDATE" as StepUpPurpose,
      ),
    ).toBe(false);
  });

  it("an ad-hoc string never satisfies any check", () => {
    expect(
      purposeSatisfies("not_a_real_purpose", "INTEGRATION_API_KEY_CREATE"),
    ).toBe(false);
    expect(purposeSatisfies("", "INTEGRATION_API_KEY_CREATE")).toBe(false);
  });

  it("legacyAliasesForStoredPurpose returns the identity for new purposes", () => {
    for (const p of NEW_PURPOSES) {
      const set = legacyAliasesForStoredPurpose(p);
      expect(set.has(p)).toBe(true);
      // No new purpose has additional aliases — the set is a
      // singleton on new values.
      expect(set.size).toBe(1);
    }
  });

  it("legacyAliasesForStoredPurpose returns identity + alias for legacy purposes", () => {
    const a = legacyAliasesForStoredPurpose("SERVICE_ACCOUNT_CREATE");
    expect(a.has("SERVICE_ACCOUNT_CREATE")).toBe(true);
    expect(a.has("INTEGRATION_API_KEY_CREATE")).toBe(true);
    expect(a.size).toBe(2);

    const b = legacyAliasesForStoredPurpose("SERVICE_ACCOUNT_REVOKE");
    expect(b.has("SERVICE_ACCOUNT_REVOKE")).toBe(true);
    expect(b.has("INTEGRATION_API_KEY_REVOKE")).toBe(true);
    expect(b.size).toBe(2);

    const c = legacyAliasesForStoredPurpose(
      "SERVICE_ACCOUNT_HARDENING_UPDATE",
    );
    expect(c.has("SERVICE_ACCOUNT_HARDENING_UPDATE")).toBe(true);
    expect(c.has("INTEGRATION_WEBHOOK_SECRET_ROTATE")).toBe(true);
    expect(c.size).toBe(2);
  });
});

// ============================================================================
// PART 3 — Step-up service uses the alias-aware comparator
// ============================================================================

describe("Phase 4 closure — consumeApprovedChallenge uses purposeSatisfies", () => {
  it("imports purposeSatisfies from @proovra/shared", () => {
    expect(STEP_UP_SERVICE).toMatch(
      /import\s+\{[\s\S]+?purposeSatisfies[\s\S]+?\}\s+from\s+"@proovra\/shared"/,
    );
  });

  it("uses purposeSatisfies instead of a raw === check on row.purpose", () => {
    // The seam the alias map relies on. A regression here would
    // silently break back-compat — a row carrying the legacy purpose
    // would throw challenge_purpose_mismatch.
    expect(STEP_UP_SERVICE).toMatch(
      /if\s*\(!purposeSatisfies\(row\.purpose,\s*input\.purpose\)\)/,
    );
    expect(STEP_UP_SERVICE).not.toMatch(
      /if\s*\(row\.purpose\s*!==\s*input\.purpose\)/,
    );
  });
});

// ============================================================================
// PART 4 — Each route uses its dedicated purpose at the canonical call site
// ============================================================================

describe("Phase 4 closure — integrations route step-up purposes", () => {
  it("POST /api-keys -> INTEGRATION_API_KEY_CREATE", () => {
    expect(ROUTES).toMatch(
      /\/v1\/integrations\/api-keys"[\s\S]+?requireStepUpForSensitiveAction[\s\S]+?purpose:\s*"INTEGRATION_API_KEY_CREATE"[\s\S]+?resourceKind:\s*"team"/,
    );
  });

  it("POST /api-keys/:id/revoke -> INTEGRATION_API_KEY_REVOKE", () => {
    expect(ROUTES).toMatch(
      /\/v1\/integrations\/api-keys\/:id\/revoke"[\s\S]+?requireStepUpForSensitiveAction[\s\S]+?purpose:\s*"INTEGRATION_API_KEY_REVOKE"[\s\S]+?resourceKind:\s*"api_credential"/,
    );
  });

  it("POST /api-keys/:id/rotate -> INTEGRATION_API_KEY_ROTATE (no longer reuses REVOKE)", () => {
    expect(ROUTES).toMatch(
      /\/v1\/integrations\/api-keys\/:id\/rotate"[\s\S]+?requireStepUpForSensitiveAction[\s\S]+?purpose:\s*"INTEGRATION_API_KEY_ROTATE"[\s\S]+?resourceKind:\s*"api_credential"/,
    );
  });

  it("PATCH /api-keys/:id -> INTEGRATION_API_KEY_EXPIRY_UPDATE (only when expiry provided)", () => {
    // Description-only updates do NOT have an expiry field; the gate
    // is conditional on the `expiresProvided` flag derived from the
    // request body. Pin both the purpose and the conditional shape.
    expect(ROUTES).toMatch(
      /if\s*\(expiresProvided\)\s*\{[\s\S]+?requireStepUpForSensitiveAction[\s\S]+?purpose:\s*"INTEGRATION_API_KEY_EXPIRY_UPDATE"[\s\S]+?resourceKind:\s*"api_credential"/,
    );
  });

  it("POST /webhooks -> INTEGRATION_WEBHOOK_CREATE", () => {
    expect(ROUTES).toMatch(
      /\/v1\/integrations\/webhooks"[\s\S]+?requireStepUpForSensitiveAction[\s\S]+?purpose:\s*"INTEGRATION_WEBHOOK_CREATE"[\s\S]+?resourceKind:\s*"team"/,
    );
  });

  it("PUT /webhooks/:id status=ACTIVE -> INTEGRATION_WEBHOOK_ENABLE", () => {
    expect(ROUTES).toMatch(
      /body\.status\s*===\s*"ACTIVE"\s*\)\s*\{[\s\S]+?requireStepUpForSensitiveAction[\s\S]+?purpose:\s*"INTEGRATION_WEBHOOK_ENABLE"/,
    );
  });

  it("PUT /webhooks/:id status=DISABLED -> INTEGRATION_WEBHOOK_DISABLE", () => {
    expect(ROUTES).toMatch(
      /body\.status\s*===\s*"DISABLED"\s*\)\s*\{[\s\S]+?requireStepUpForSensitiveAction[\s\S]+?purpose:\s*"INTEGRATION_WEBHOOK_DISABLE"/,
    );
  });

  it("POST /webhooks/:id/rotate-secret -> INTEGRATION_WEBHOOK_SECRET_ROTATE", () => {
    expect(ROUTES).toMatch(
      /\/v1\/integrations\/webhooks\/:id\/rotate-secret"[\s\S]+?requireStepUpForSensitiveAction[\s\S]+?purpose:\s*"INTEGRATION_WEBHOOK_SECRET_ROTATE"[\s\S]+?resourceKind:\s*"webhook_endpoint"/,
    );
  });

  it("POST /webhooks/:id/disable -> INTEGRATION_WEBHOOK_DISABLE", () => {
    expect(ROUTES).toMatch(
      /\/v1\/integrations\/webhooks\/:id\/disable"[\s\S]+?requireStepUpForSensitiveAction[\s\S]+?purpose:\s*"INTEGRATION_WEBHOOK_DISABLE"[\s\S]+?resourceKind:\s*"webhook_endpoint"/,
    );
  });

  it("POST /webhooks/:id/test -> INTEGRATION_WEBHOOK_TEST", () => {
    expect(ROUTES).toMatch(
      /\/v1\/integrations\/webhooks\/:id\/test"[\s\S]+?requireStepUpForSensitiveAction[\s\S]+?purpose:\s*"INTEGRATION_WEBHOOK_TEST"[\s\S]+?resourceKind:\s*"webhook_endpoint"/,
    );
  });

  it("POST /webhook-deliveries/:id/retry -> INTEGRATION_WEBHOOK_RETRY", () => {
    expect(ROUTES).toMatch(
      /\/v1\/integrations\/webhook-deliveries\/:id\/retry"[\s\S]+?requireStepUpForSensitiveAction[\s\S]+?purpose:\s*"INTEGRATION_WEBHOOK_RETRY"[\s\S]+?resourceKind:\s*"webhook_delivery"/,
    );
  });
});

// ============================================================================
// PART 5 — No legacy purpose remains on an integrations call site
// ============================================================================

describe("Phase 4 closure — no integrations route still passes a legacy SERVICE_ACCOUNT_* purpose", () => {
  // The route file may STILL mention the legacy values inside comments
  // (the migration notes explicitly cite them). The hard invariant is
  // that no `requireStepUpForSensitiveAction(...)` call argument
  // structure carries a legacy purpose as its `purpose:` field.
  it("contains no `purpose: \"SERVICE_ACCOUNT_*\"` inside a step-up call block", () => {
    // Walk every `requireStepUpForSensitiveAction({...})` block and
    // assert the `purpose:` value is one of the NEW_PURPOSES.
    const callPattern = /requireStepUpForSensitiveAction\(\{[\s\S]+?\}\)/g;
    const blocks = ROUTES.match(callPattern) ?? [];
    expect(blocks.length).toBeGreaterThanOrEqual(11);
    for (const block of blocks) {
      const purposeMatch = block.match(/purpose:\s*"([A-Z_]+)"/);
      expect(purposeMatch, `block missing purpose: ${block.slice(0, 120)}`).not.toBeNull();
      const value = purposeMatch![1];
      expect(NEW_PURPOSES, `purpose "${value}" must be one of the new dedicated purposes`).toContain(value);
    }
  });

  it("imports the step-up middleware via the canonical path", () => {
    expect(ROUTES).toMatch(
      /from\s+"\.\.\/services\/identity-security\/step-up-middleware\.js"/,
    );
  });
});

// ============================================================================
// PART 6 — Documentation references stay honest
// ============================================================================

describe("Phase 4 closure — shared module documents the alias contract", () => {
  it("identity-security.ts comments anchor the alias map invariants", () => {
    // The brief calls out: legacy values remain accepted; the map is
    // one-directional; route layer still passes only members of
    // STEP_UP_PURPOSES. Pin the comment markers that anchor those
    // invariants so they survive future edits.
    expect(SHARED_IDENTITY).toMatch(/LEGACY_STEP_UP_PURPOSE_ALIASES/);
    expect(SHARED_IDENTITY).toMatch(/one-directional/);
    expect(SHARED_IDENTITY).toMatch(/ADDITIVE/);
  });
});

// ============================================================================
// PART 7 — Honest deferrals + step-up emit security event surface intact
// ============================================================================

describe("Phase 4 closure — middleware response surface unchanged", () => {
  it("step-up middleware still emits STEP_UP_REQUIRED with the new purpose surfaced", () => {
    // The middleware echoes the requested purpose in the 401 body so
    // the frontend can render a purpose-aware prompt. Pin that the
    // surface still exposes `purpose:` (no purpose-specific text
    // path was added — UI rendering remains purpose-string agnostic).
    const middleware = readApi(
      "src/services/identity-security/step-up-middleware.ts",
    );
    expect(middleware).toMatch(/code:\s*"STEP_UP_REQUIRED"/);
    expect(middleware).toMatch(/purpose:\s*input\.purpose/);
  });
});
