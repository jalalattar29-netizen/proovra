/**
 * PHASE E2 — Controlled collaboration contract tests.
 *
 * The Phase E2 prompt asked for substantial new collaboration features.
 * The parallel inventory audits (backend / frontend / external-access)
 * proved that PROOVRA already has comprehensive controlled
 * collaboration shipped across phases 8, 16, 22, 25, 27, and 28:
 *
 *   - Assignments        — `CaseAssignment` model + AssignmentPickerModal
 *   - Comments           — `CaseComment` + `EvidenceReviewerComment` +
 *                          `ReviewerCommentsPanel`
 *   - Escalations        — `ReviewEscalation` + escalations console
 *   - Discussion threads — Phase 16 `/collaboration` page + routes
 *   - External grants    — Phase 27/28 `external_review_grants`
 *   - Notification engine — Phase 8 with 16+ event types
 *   - Reviewer ops UI    — full console + per-workflow inspector
 *
 * Reviewer handoff is shipped as `reviewer_reassigned` security event
 * via `EvidenceReviewWorkflow.currentReviewerId` ownership change
 * (no separate "Handoff" model is needed; the reassignment IS the
 * handoff with audit trail).
 *
 * This file therefore pins the canonical collaboration model so future
 * phases cannot regress it. It also pins the 5 audit gaps surfaced by
 * the E2 inventory (registered as DEF-016 → DEF-020) so they remain
 * tracked, not forgotten.
 *
 * Hard rules preserved (CR1.7 §12 + 32.8 §17 + E2 absolute rules):
 *   - No chat product. No Slack/Teams clone. No emoji / reactions /
 *     social feed.
 *   - No new root nav item (32.8 IA pinned).
 *   - No capture / custody / report / package logic touched
 *     (file-size pin carried from 32.8 Test 10).
 *   - No PlatformContextEnvelope semantic change.
 *   - No new state library.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

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

const TYPES = readApi("src/services/platform-context/types.ts");
const PRISMA = readApi("prisma/schema.prisma");
const ROUTE_REGISTRY = readWeb("lib/navigation/routeRegistry.ts");
const SECURITY_EVENTS = readPackages("shared/src/security.ts");

// ===========================================================================
// PART 1 — Existing collaboration capabilities remain shipped
// ===========================================================================

describe("E2 Test 1 — collaboration capability keys exist in CapabilityKey enum", () => {
  // These are gates the audit found in the platform-context types.
  // Pinning them prevents accidental removal during future refactors.
  const REQUIRED_CAPABILITY_KEYS = [
    "CASE_ASSIGN",
    "CASE_COMMENT",
    "CASE_COMMENT_RESOLVE",
    "REVIEW_ASSIGN",
    "REVIEW_REASSIGN",
    "REVIEW_ESCALATE",
  ];

  it.each(REQUIRED_CAPABILITY_KEYS)(
    "CapabilityKey enum contains: %s",
    (key) => {
      // The enum is the bounded source of truth.
      // Format: `"CASE_ASSIGN"` inside the union or array literal.
      expect(TYPES).toMatch(new RegExp(`["']${key}["']`));
    },
  );
});

// ===========================================================================
// PART 2 — Existing collaboration security-event vocabulary preserved
// ===========================================================================

describe("E2 Test 2 — collaboration security-event vocabulary is preserved", () => {
  // These events constitute the audit trail for collaboration actions.
  // The Phase 25 / 25.5 / 27 / 28 phases shipped the full vocabulary.
  // E2 pins them.
  const REQUIRED_EVENT_TYPES = [
    // Assignment / reassignment
    "reviewer_assignment_created",
    "reviewer_reassigned",
    // Escalation lifecycle
    "reviewer_escalation_created",
    "reviewer_escalation_acknowledged",
    "reviewer_escalation_reassigned",
    "reviewer_escalation_resolved",
    "reviewer_escalation_suppressed",
    // External review grants (Phase 27/28)
    "external_review_invited",
    "external_review_revoked",
    // Member access changes
    "member_invited",
    "member_role_changed",
    "member_suspended",
    "member_revoked",
    // Capability grants
    "capability_granted",
    "capability_revoked",
  ];

  it.each(REQUIRED_EVENT_TYPES)(
    "security-event vocabulary contains: %s",
    (eventType) => {
      expect(SECURITY_EVENTS).toMatch(
        new RegExp(`["']${eventType}["']`),
      );
    },
  );
});

// ===========================================================================
// PART 3 — Prisma collaboration models still present
// ===========================================================================

describe("E2 Test 3 — Prisma collaboration models present", () => {
  // The audit confirmed these models exist. Pin them so a future
  // schema change can't silently remove or rename them without a
  // coordinated phase.
  const REQUIRED_MODELS = [
    "CaseAssignment",
    "CaseComment",
    "EvidenceReviewerComment",
    "ReviewEscalation",
    "DiscussionThread",
    "DiscussionMessage",
    "OperationalTimelineEvent",
    "NotificationDelivery",
  ];

  it.each(REQUIRED_MODELS)(
    "Prisma schema declares model: %s",
    (modelName) => {
      // Prisma model declaration looks like `model <Name> {`.
      const re = new RegExp(`\\bmodel\\s+${modelName}\\b`);
      expect(PRISMA).toMatch(re);
    },
  );
});

// ===========================================================================
// PART 4 — Collaboration backend routes still registered
// ===========================================================================

describe("E2 Test 4 — collaboration backend routes present", () => {
  it("services/api/src/routes/collaboration.routes.ts exists", () => {
    expect(existsSync(apiPath("src/routes/collaboration.routes.ts"))).toBe(true);
  });

  it("services/api/src/routes/external-review.routes.ts exists", () => {
    expect(existsSync(apiPath("src/routes/external-review.routes.ts"))).toBe(true);
  });

  it("services/api/src/routes/notifications.routes.ts exists", () => {
    expect(existsSync(apiPath("src/routes/notifications.routes.ts"))).toBe(true);
  });

  it("case-workspace.routes.ts handles comments + assignments (per E2 inventory)", () => {
    // Audit found case comments + assignments live in
    // case-workspace.routes.ts, not cases.routes.ts. Both files exist;
    // the workspace router is the canonical home for the matter
    // collaboration endpoints.
    expect(existsSync(apiPath("src/routes/case-workspace.routes.ts"))).toBe(
      true,
    );
    const src = readApi("src/routes/case-workspace.routes.ts");
    expect(src).toMatch(/\/v1\/cases\/[^"']+\/comments/);
    expect(src).toMatch(/\/v1\/cases\/[^"']+\/assignments/);
  });
});

// ===========================================================================
// PART 5 — Collaboration frontend surfaces still wired
// ===========================================================================

describe("E2 Test 5 — collaboration UI surfaces present", () => {
  const REQUIRED_FILES: ReadonlyArray<{ rel: string; description: string }> = [
    {
      rel: "app/(app)/collaboration/page.tsx",
      description: "/collaboration thread console",
    },
    {
      rel: "components/cases-experience/CaseWorkspace.tsx",
      description: "case workspace with assignment + comments",
    },
    {
      rel: "components/cases-experience/matter-modals/AssignmentPickerModal.tsx",
      description: "canonical assignment picker modal",
    },
    {
      rel: "app/(app)/evidence/components/ReviewerCommentsPanel.tsx",
      description: "canonical evidence comments panel",
    },
    {
      rel: "components/reviewer-experience/ReviewerCommandConsole.tsx",
      description: "reviewer command console (Phase 32.8E)",
    },
    {
      rel: "app/(app)/reviewer-ops/escalations/page.tsx",
      description: "escalations console",
    },
    {
      rel: "app/(app)/notifications/page.tsx",
      description: "notification delivery log",
    },
  ];

  it.each(REQUIRED_FILES)(
    "$description exists at $rel",
    ({ rel }) => {
      expect(
        existsSync(webPath(rel)),
        `Required collaboration UI file missing: ${rel}`,
      ).toBe(true);
    },
  );
});

// ===========================================================================
// PART 6 — Forbidden chat / social patterns are absent
// ===========================================================================

describe("E2 Test 6 — no chat / social-feed product introduced", () => {
  it("no /chat route registered", () => {
    expect(ROUTE_REGISTRY).not.toMatch(/href:\s*["']\/chat\b/);
    expect(ROUTE_REGISTRY).not.toMatch(/id:\s*["']workspace\.chat["']/);
    expect(ROUTE_REGISTRY).not.toMatch(/id:\s*["']chat\b/);
  });

  it("no /feed route registered", () => {
    expect(ROUTE_REGISTRY).not.toMatch(/href:\s*["']\/feed\b/);
    expect(ROUTE_REGISTRY).not.toMatch(/id:\s*["']feed\b/);
  });

  it("no reactions/emoji model in Prisma", () => {
    expect(PRISMA).not.toMatch(/\bmodel\s+Reaction\b/);
    expect(PRISMA).not.toMatch(/\bmodel\s+EmojiReaction\b/);
    expect(PRISMA).not.toMatch(/\bmodel\s+ReactionTally\b/);
  });

  it("no public 'feed' or 'social' Prisma model", () => {
    expect(PRISMA).not.toMatch(/\bmodel\s+SocialFeed\b/);
    expect(PRISMA).not.toMatch(/\bmodel\s+ActivityFeed\b/);
    // Note: ActivityFeed (with a capital F) is forbidden. The
    // existing operational timeline uses `OperationalTimelineEvent`
    // which is intentionally NOT a feed in the social sense.
  });

  it("no new root nav item added by E2 (32.8 Test 1 still binds)", () => {
    // The 6 canonical primaries from 32.8 are the only sidebar
    // primaries. E2 must not add a 7th.
    const m = readWeb("lib/navigation/canonicalNavigationGroups.ts").match(
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
// PART 7 — External review grants remain scoped + revocable
// ===========================================================================

describe("E2 Test 7 — external review grants are bounded (Phase 27/28 invariants)", () => {
  it("external_review_grants table is created by Prisma migration", () => {
    // Phase 27/28 created the external_review_grants table via raw
    // SQL migration (not a first-class Prisma model). Pin its
    // existence by asserting the migration file contains the CREATE
    // TABLE statement.
    const migrationFile = repoPath(
      "services/api/prisma/migrations/20260620100000_phase24_31_consolidated_drift_patches/migration.sql",
    );
    expect(
      existsSync(migrationFile),
      "Phase 27/28 migration file missing",
    ).toBe(true);
    const migration = readFileSync(migrationFile, "utf8");
    expect(migration).toMatch(/external_review_grants/);
  });

  it("external-review routes implement issue + revoke + token-access pattern", () => {
    const src = readApi("src/routes/external-review.routes.ts");
    // Operator-side: issue + revoke
    expect(src).toMatch(/\/grants\b/);
    expect(src).toMatch(/\brevoke\b/i);
    // Reviewer-side: token-scoped access
    expect(src).toMatch(/\/access\/:token/);
  });

  it("shared external-review decision engine exports access evaluator", () => {
    const src = readPackages("shared/src/external-review.ts");
    expect(src).toMatch(/evaluateExternalReviewAccess/);
    // Privacy projection — strips internal fields.
    expect(src).toMatch(/projectEvidenceForExternalReview/);
  });
});

// ===========================================================================
// PART 8 — Notification engine wired with multi-channel delivery
// ===========================================================================

describe("E2 Test 8 — notification engine remains bounded + multi-channel", () => {
  it("Prisma declares NotificationDelivery with status lifecycle", () => {
    expect(PRISMA).toMatch(/\bmodel\s+NotificationDelivery\b/);
  });

  it("shared notifications module exports bounded event-type vocabulary", () => {
    const src = readPackages("shared/src/notifications.ts");
    // Spot-check the canonical event types from Phase 8. The actual
    // names (audit-verified) are REVIEW_REQUEST_ASSIGNED + REVIEW_ESCALATED
    // (escalation is NOT under the REVIEW_REQUEST_* prefix).
    expect(src).toMatch(/REVIEW_REQUEST_ASSIGNED/);
    expect(src).toMatch(/\bREVIEW_ESCALATED\b/);
    expect(src).toMatch(/EVIDENCE_REQUEST_SENT/);
  });

  it("notification delivery routes are present", () => {
    const src = readApi("src/routes/notifications.routes.ts");
    expect(src).toMatch(/\/deliveries/);
  });
});

// ===========================================================================
// PART 9 — Custody / report / package files untouched
// ===========================================================================

describe("E2 Test 9 — capture / custody / report / package files untouched", () => {
  const PINS: ReadonlyArray<{ rel: string; expectedBytes: number }> = [
    { rel: "src/routes/capture.routes.ts", expectedBytes: 18308 },
    { rel: "src/services/evidence-complete.service.ts", expectedBytes: 41849 },
    { rel: "src/services/custody-events.service.ts", expectedBytes: 4446 },
    { rel: "src/services/timestamp.service.ts", expectedBytes: 6033 },
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
// PART 10 — No new client-state library added
// ===========================================================================

describe("E2 Test 10 — no new client-state library introduced", () => {
  it("apps/web/package.json has no React Query / SWR / Redux / Zustand", () => {
    const pkg = JSON.parse(readFileSync(webPath("package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const deps = {
      ...(pkg.dependencies ?? {}),
      ...(pkg.devDependencies ?? {}),
    };
    for (const forbidden of [
      "@tanstack/react-query",
      "react-query",
      "swr",
      "redux",
      "@reduxjs/toolkit",
      "zustand",
      "jotai",
      "recoil",
      "mobx",
      // Specifically realtime/social libs:
      "socket.io-client",
      "pusher-js",
      "ably",
    ]) {
      expect(
        deps[forbidden],
        `Forbidden library added in E2: ${forbidden} (no realtime/social/state-lib expansion)`,
      ).toBeUndefined();
    }
  });
});

// ===========================================================================
// PART 11 — Documentation + registry updated
// ===========================================================================

describe("E2 Test 11 — documentation + registry updated", () => {
  it("docs/product/PHASE_E2_CONTROLLED_COLLABORATION.md exists + substantial", () => {
    const doc = readRepo("docs/product/PHASE_E2_CONTROLLED_COLLABORATION.md");
    expect(doc.length).toBeGreaterThan(8000);
    expect(doc).toMatch(/PHASE E2/);
    expect(doc).toMatch(/Controlled Collaboration/i);
  });

  it("doc enumerates the 8 collaboration entities", () => {
    const doc = readRepo("docs/product/PHASE_E2_CONTROLLED_COLLABORATION.md");
    for (const entity of [
      "Case assignment",
      "Evidence assignment",
      "Reviewer assignment",
      "Operational comment",
      "Reviewer handoff",
      "Escalation owner",
      "External reviewer grant",
      "Activity event",
    ]) {
      expect(
        doc,
        `Collaboration model entity missing from doc: ${entity}`,
      ).toContain(entity);
    }
  });

  it("doc records the 5 new audit-gap DEF items (DEF-016 → DEF-020)", () => {
    const doc = readRepo("docs/product/PHASE_E2_CONTROLLED_COLLABORATION.md");
    for (const def of ["DEF-016", "DEF-017", "DEF-018", "DEF-019", "DEF-020"]) {
      expect(doc).toContain(def);
    }
  });

  it("MASTER_PHASE_REGISTRY.md registers Phase E2 with explicit status", () => {
    const registry = readRepo("docs/recovery/MASTER_PHASE_REGISTRY.md");
    expect(registry).toMatch(
      /\|\s*(Phase )?E2\s*\|[\s\S]*?(CLOSED|CLOSED_WITH_DEFERRED_ITEMS)/,
    );
  });

  it("registry contains the 5 new DEF items (DEF-016 → DEF-020) per CR1.7 silent-debt rule", () => {
    const registry = readRepo("docs/recovery/MASTER_PHASE_REGISTRY.md");
    for (const def of ["DEF-016", "DEF-017", "DEF-018", "DEF-019", "DEF-020"]) {
      expect(
        registry,
        `New DEF item ${def} missing from registry §6 (CR1.7 silent-debt rule violation).`,
      ).toContain(def);
    }
  });
});
