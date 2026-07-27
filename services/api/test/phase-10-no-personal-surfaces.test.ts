/**
 * PHASE 10 §13.2 STEP 6 — REMAINING NO-PERSONAL SURFACES.
 *
 * `test/phase-10-no-personal-e2e.test.ts` proves the canonical decision
 * (`personalSpaceAllowed` / `assertPersonalSpaceAllowed`) and the FIRST wave
 * of STEP 6 surfaces (bootstrap, capture draft, Evidence create, Evidence
 * finalize, checkout/billing, context switch, personal export). This suite
 * covers the surfaces closed in the SECOND wave — do not re-assert the
 * first wave here (see the file above for those):
 *
 *   - resumable-upload parts (create session / mark-uploaded / mark-verified
 *     / complete / abort / S3-multipart initiate/presign/complete/abort) —
 *     `upload-sessions.routes.ts`
 *   - direct Evidence "add a part" presign — `POST /v1/evidence/:id/parts`
 *     in `evidence.routes.ts`
 *   - PERSONAL_ACCOUNT storage-addon checkout target — `billing.routes.ts`
 *   - the dev-only direct personal-plan-change route — `billing.routes.ts`
 *   - the client-hiding `personalSpaceAllowed` envelope signal —
 *     `platform-context.service.ts` / `types.ts` (defense in depth; the
 *     server guards above remain the actual enforcement)
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { assertPersonalUploadMutationAllowed } from "../src/routes/upload-sessions.routes.js";

const NO_PERSONAL = { code: "MANAGED_IDENTITY_NO_PERSONAL_SPACE", statusCode: 403 };

// =============================================================================
// 1. Resumable-upload parts — behavioural (real helper + prisma stub).
// =============================================================================

/** STANDARD — an ordinary self-service identity WITH a personal space. */
const STANDARD_ROW = {
  identityMode: "STANDARD",
  managingOrganizationId: null,
  managedIdentitySource: null,
  managedBySsoConnectionId: null,
};

/** MANAGED — org-owned via a SCIM source (valid without an SSO connection). */
const MANAGED_ROW = {
  identityMode: "MANAGED_ENTERPRISE",
  managingOrganizationId: "org-A",
  managedIdentitySource: "SCIM",
  managedBySsoConnectionId: null,
};

function stub(team: { isPersonal: boolean } | null, userRow: Record<string, unknown>) {
  return {
    team: { findUnique: async () => team },
    user: { findUnique: async () => userRow },
    ssoConnection: { findUnique: async () => null },
  } as never;
}

describe("resumable-upload personal-scope mutation guard (assertPersonalUploadMutationAllowed)", () => {
  it("TEAM upload (isPersonal=false) → no-op regardless of identity mode (unaffected)", async () => {
    const denial = await assertPersonalUploadMutationAllowed("team-1", "u1", stub({ isPersonal: false }, MANAGED_ROW));
    expect(denial).toBeNull();
  });

  it("unknown teamId (no row) → no-op (never treated as personal)", async () => {
    const denial = await assertPersonalUploadMutationAllowed("team-missing", "u1", stub(null, MANAGED_ROW));
    expect(denial).toBeNull();
  });

  it("PERSONAL team + STANDARD identity → allowed (no regression for normal users)", async () => {
    const denial = await assertPersonalUploadMutationAllowed(
      "personal-team-1",
      "u1",
      stub({ isPersonal: true }, STANDARD_ROW),
    );
    expect(denial).toBeNull();
  });

  it("PERSONAL team + MANAGED identity → DENIED (403 MANAGED_IDENTITY_NO_PERSONAL_SPACE)", async () => {
    const denial = await assertPersonalUploadMutationAllowed(
      "personal-team-1",
      "u1",
      stub({ isPersonal: true }, MANAGED_ROW),
    );
    expect(denial).toMatchObject(NO_PERSONAL);
  });
});

// =============================================================================
// 2. Source-contract — every mutating upload-session route calls the guard.
// =============================================================================

const API_SRC = resolve(__dirname, "../src");
const read = (rel: string) => readFileSync(resolve(API_SRC, rel), "utf8");

describe("source-contract: resumable-upload mutating routes call the personal guard", () => {
  const src = read("routes/upload-sessions.routes.ts");
  const mutatingRouteAnchors = [
    '"/v1/uploads/sessions",',
    '"/v1/uploads/sessions/:sessionId/parts/:partIndex/uploaded",',
    '"/v1/uploads/sessions/:sessionId/parts/:partIndex/verified",',
    '"/v1/uploads/sessions/:sessionId/complete",',
    '"/v1/uploads/sessions/:sessionId/abort",',
    '"/v1/uploads/sessions/:sessionId/multipart/initiate",',
    '"/v1/uploads/sessions/:sessionId/parts/:partIndex/presign",',
    '"/v1/uploads/sessions/:sessionId/multipart/complete",',
    '"/v1/uploads/sessions/:sessionId/multipart/abort",',
  ];

  for (const anchor of mutatingRouteAnchors) {
    it(`route ${anchor} guards personal-scope mutation before its service call`, () => {
      const routeAt = src.indexOf(anchor);
      expect(routeAt).toBeGreaterThan(-1);
      const guardAt = src.indexOf("assertPersonalUploadMutationAllowed(", routeAt);
      expect(guardAt).toBeGreaterThan(routeAt);
      // The guard must run before the NEXT route declaration (i.e. within
      // this handler), proving it is wired into every mutating route, not
      // just the first one.
      const nextRouteAt = mutatingRouteAnchors
        .map((a) => src.indexOf(a, routeAt + 1))
        .filter((i) => i > routeAt)
        .sort((a, b) => a - b)[0] ?? src.length;
      expect(guardAt).toBeLessThan(nextRouteAt);
    });
  }

  it("the guard itself denies via the canonical assertPersonalSpaceAllowed (not a fork)", () => {
    expect(src).toMatch(/import \{ assertPersonalSpaceAllowed \} from "\.\.\/services\/identity\/identity-mode\.service\.js"/);
    expect(src).toMatch(/await assertPersonalSpaceAllowed\(actorUserId, client\)/);
  });
});

// =============================================================================
// 3. Source-contract — direct Evidence "add part" presign guards before write.
// =============================================================================

describe("source-contract: POST /v1/evidence/:id/parts guards before the EvidencePart write", () => {
  it("references the canonical guard and runs before tx.evidencePart.create", () => {
    const src = read("routes/evidence.routes.ts");
    const routeAt = src.indexOf('"/v1/evidence/:id/parts"');
    expect(routeAt).toBeGreaterThan(-1);
    const guardAt = src.indexOf("NO-PERSONAL enforcement on ADDING a", routeAt);
    const assertAt = src.indexOf("assertPersonalSpaceAllowed", routeAt);
    const createAt = src.indexOf("tx.evidencePart.create(", routeAt);
    expect(guardAt).toBeGreaterThan(routeAt);
    expect(assertAt).toBeGreaterThan(routeAt);
    expect(createAt).toBeGreaterThan(routeAt);
    expect(guardAt).toBeLessThan(assertAt);
    expect(assertAt).toBeLessThan(createAt);
  });
});

// =============================================================================
// 4. Source-contract — billing PERSONAL_ACCOUNT storage-addon + dev plan route.
// =============================================================================

describe("source-contract: billing personal-target surfaces guard before mutation", () => {
  const src = read("routes/billing.routes.ts");

  it("PERSONAL_ACCOUNT storage-addon checkout target denies before resolveCommercialContext", () => {
    const fnAt = src.indexOf("async function assertStorageAddonAllowed");
    expect(fnAt).toBeGreaterThan(-1);
    const personalSectionAt = src.indexOf('type: "PERSONAL_ACCOUNT"', fnAt);
    expect(personalSectionAt).toBeGreaterThan(fnAt);
    const guardAt = src.lastIndexOf("await assertPersonalSpaceAllowed(params.userId)", personalSectionAt);
    expect(guardAt).toBeGreaterThan(fnAt);
    expect(guardAt).toBeLessThan(personalSectionAt);
  });

  it("the dev-only direct /v1/billing/plan personal-plan branch guards before setPersonalPlan", () => {
    const routeAt = src.indexOf('"/v1/billing/plan"');
    expect(routeAt).toBeGreaterThan(-1);
    const guardAt = src.indexOf("assertPersonalCheckoutAllowed(userId, undefined)", routeAt);
    const setAt = src.indexOf("await setPersonalPlan(userId, body.plan)", routeAt);
    expect(guardAt).toBeGreaterThan(routeAt);
    expect(setAt).toBeGreaterThan(routeAt);
    expect(guardAt).toBeLessThan(setAt);
  });

  it("Stripe + PayPal base checkout still guard the no-teamId (personal) target", () => {
    expect(src).toMatch(/await assertPersonalCheckoutAllowed\(userId, body\.teamId\)/);
  });
});

// =============================================================================
// 5. Client-hiding signal — platform-context envelope (defense in depth).
// =============================================================================

describe("source-contract: platform-context envelope exposes personalSpaceAllowed", () => {
  it("the service resolves the canonical decision (read-only call, not a fork)", () => {
    const src = read("services/platform-context/platform-context.service.ts");
    expect(src).toMatch(
      /import \{ personalSpaceAllowed as resolvePersonalSpaceAllowed \} from "\.\.\/identity\/identity-mode\.service\.js"/,
    );
    expect(src).toMatch(/personalSpaceAllowedFlag = await resolvePersonalSpaceAllowed\(userRow\.id\)/);
  });

  it("a grandfathered personal Team is suppressed from contextOptions when the flag is false", () => {
    const src = read("services/platform-context/platform-context.service.ts");
    expect(src).toMatch(/personalTeamId && personalSpaceAllowedFlag/);
  });

  it("the flag is projected on the returned envelope", () => {
    const src = read("services/platform-context/platform-context.service.ts");
    expect(src).toMatch(/personalSpaceAllowed: personalSpaceAllowedFlag/);
    const typesSrc = read("services/platform-context/types.ts");
    expect(typesSrc).toMatch(/personalSpaceAllowed: boolean/);
  });
});

// =============================================================================
// 6. Zero-metric — no second-wave surface bypasses the canonical guard.
// =============================================================================

const SECOND_WAVE_SURFACES: ReadonlyArray<{ surface: string; file: string; mustReference: RegExp }> = [
  {
    surface: "resumable-upload parts (create/uploaded/verified/complete/abort/multipart)",
    file: "routes/upload-sessions.routes.ts",
    mustReference: /assertPersonalUploadMutationAllowed/,
  },
  {
    surface: "direct Evidence part add (/v1/evidence/:id/parts)",
    file: "routes/evidence.routes.ts",
    mustReference: /NO-PERSONAL enforcement on ADDING a/,
  },
  {
    surface: "PERSONAL_ACCOUNT storage-addon checkout",
    file: "routes/billing.routes.ts",
    mustReference: /assertPersonalSpaceAllowed\(params\.userId\)/,
  },
  {
    surface: "dev-only direct personal plan change",
    file: "routes/billing.routes.ts",
    mustReference: /assertPersonalCheckoutAllowed\(userId, undefined\)/,
  },
];

describe("machine metric: second-wave personal-surface bypasses = 0", () => {
  it("every enumerated surface routes through its guard", () => {
    const bypasses = SECOND_WAVE_SURFACES.filter((s) => !s.mustReference.test(read(s.file)));
    expect(bypasses.map((b) => b.surface)).toEqual([]);
    expect(bypasses.length).toBe(0);
  });
});

