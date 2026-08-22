/**
 * ATTENTION ARCHITECTURE — PHASE 7 (2026-08-22).
 * ZERO GENERAL-ATTENTION DUPLICATION.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS SUITE IS FOR
 * ---------------------------------------------------------------------------
 * Every previous phase removed one duplicate authority. This one asserts that
 * the removals HOLD, and that a future pass cannot quietly reintroduce a
 * second answer to "what needs attention?" without a red test.
 *
 * There are exactly four places allowed to answer an attention question, and
 * each answers a DIFFERENT one:
 *
 *   NOTIFICATIONS   what happened that I personally should know about
 *   OPERATIONS      what unresolved shared work must we act on
 *   SECURITY/DOMAIN specialised decisions their own domains own
 *   HOME            the state of my workspace — CONSUMING the above
 *
 * Anything else that computes a general "priority", "pressure", "attention" or
 * "health" number over a workspace is, by construction, a fifth answer.
 */

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

function repoPath(rel: string): string {
  return fileURLToPath(new URL(`../../../${rel}`, import.meta.url));
}
function read(rel: string): string {
  return readFileSync(repoPath(rel), "utf8");
}
function exists(rel: string): boolean {
  return existsSync(repoPath(rel));
}

// ============================================================================
// The removals, each with its zero-consumer evidence
// ============================================================================

describe("Phase 7 — removed duplicate authorities stay removed", () => {
  it("buildOperationalQueue() is gone from the Home view model", () => {
    const VM = read("apps/web/components/home-experience/home-view-model.ts");
    expect(VM).not.toMatch(/function buildOperationalQueue\(/);
    // Its row type and severity mapper went with it — a type with no producer
    // is an invitation to write a second producer.
    expect(VM).not.toMatch(/export type OperationalQueueItem = \{/);
    expect(VM).not.toMatch(/^function failureType\(/m);
  });

  it("the OperationalQueue widget and its row renderer are gone", () => {
    const SECTIONS = read("apps/web/components/home-experience/HomeSections.tsx");
    expect(SECTIONS).not.toMatch(/export function OperationalQueue\(/);
    expect(SECTIONS).not.toMatch(/^function QueueRow\(/m);
  });

  it("the account-priorities endpoint and its banner are deleted", () => {
    expect(exists("services/api/src/routes/me-operational-priorities.routes.ts")).toBe(
      false,
    );
    expect(
      exists("apps/web/components/command-center/AccountPrioritiesBanner.tsx"),
    ).toBe(false);
  });

  it("the deleted route is no longer registered", () => {
    const SERVER = read("services/api/src/server.ts");
    expect(SERVER).not.toMatch(/meOperationalPrioritiesRoutes/);
  });

  it("ZERO CONSUMERS — nothing in the product still calls the removed surfaces", () => {
    // The removal discipline is: search consumers, verify replacement, remove,
    // run tests. This is the search, kept permanently so a re-introduction is
    // caught rather than reviewed.
    const SEARCHED = [
      "apps/web/app/(app)/home/page.tsx",
      "apps/web/components/home-experience/SelfServeHomeDashboard.tsx",
      "apps/web/components/home-experience/HomeDashboardSections.tsx",
      "apps/web/components/home-experience/useHomeData.ts",
      "apps/web/components/command-center/CommandCenter.tsx",
    ];
    for (const rel of SEARCHED) {
      const src = read(rel);
      // Strip comments: the tombstones NAME what was removed.
      const code = src
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .split("\n")
        .filter((l) => !l.trim().startsWith("//"))
        .join("\n");
      expect(code, `${rel} still uses the removed queue`).not.toMatch(
        /operationalQueue/,
      );
      expect(code, `${rel} still renders the removed banner`).not.toMatch(
        /AccountPrioritiesBanner/,
      );
      expect(code, `${rel} still calls the removed endpoint`).not.toMatch(
        /operational-priorities/,
      );
    }
  });
});

// ============================================================================
// 7.1 — the repository-wide sweep
// ============================================================================

describe("Phase 7.1 — every surviving general computation has an owner", () => {
  /**
   * The Command Center is the surface most likely to grow a second authority
   * back, because it renders every domain at once. Its pressure section is a
   * PROJECTION now, and this holds it there.
   */
  it("the Command Center computes no operational pressure of its own", () => {
    const CC = read("services/api/src/services/dashboard/command-center.service.ts");
    const start = CC.indexOf("async function runOperationalPressure(");
    expect(start).toBeGreaterThan(0);
    const body = CC.slice(start, CC.indexOf("\n}\n", start));
    expect(body).toContain("buildOperationsSummary");
    expect(body).toContain("listIncidents");
    // No bespoke scan, no second ranking, no second cap.
    expect(body).not.toContain("prisma.evidenceReviewWorkflow");
    expect(body).not.toContain("SEVERITY_RANK");
    expect(body).not.toContain("PRESSURE_PER_KIND");
  });

  it("Home consumes the Operations summary and derives nothing", () => {
    const VM = read("apps/web/components/home-experience/home-view-model.ts");
    expect(VM).toContain("inputs.operationsSummary");
    // The one place Home is allowed to touch operational state is projecting
    // that input. It must not read the notification feed for it.
    const start = VM.indexOf("const operations: HomeOperationsSummary");
    expect(start).toBeGreaterThan(0);
    // Bound the window to the projection EXPRESSION — it ends at the `};`
    // that closes the ternary's else-branch object. A longer window reads the
    // view model's return statement, where `needsFixing` legitimately still
    // appears: it is a personal list of failures the caller can see, and this
    // test is about what feeds the WORKSPACE summary, not about deleting the
    // personal list.
    const end = VM.indexOf("\n      };", start);
    expect(end).toBeGreaterThan(start);
    const block = VM.slice(start, end);
    expect(block).not.toMatch(/inbox/i);
    expect(block).not.toMatch(/needsFixing/);
    expect(block).toContain("inputs.operationsSummary");
  });

  it("there is exactly ONE canonical workspace Operations summary authority", () => {
    // A second file computing workspace operational totals is a second answer.
    const authority = "services/api/src/services/operations/operations-summary.service.ts";
    expect(exists(authority)).toBe(true);
    const SRC = read(authority);
    expect(SRC).toContain("export async function buildOperationsSummary");
    // And it reads SHARED truth, never a per-user table.
    expect(SRC).toContain("operationalIncident.findMany");
    expect(SRC).not.toMatch(/inboxItemState|dismissedAt|snoozedUntil/);
  });

  it("no surviving surface derives workspace health from a personal feed", () => {
    // THE coupling this program removed, asserted as an absence across the
    // surfaces that used to have it.
    for (const rel of [
      "apps/web/components/home-experience/home-view-model.ts",
      "apps/web/components/home-experience/useHomeData.ts",
      "services/api/src/services/dashboard/command-center.service.ts",
    ]) {
      const src = read(rel);
      const code = src
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .split("\n")
        .filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*"))
        .join("\n");
      // A workspace-health computation must not read per-user attention state.
      expect(code, `${rel} reads personal attention state`).not.toMatch(
        /\bdismissedAt\b|\bsnoozedUntil\b|inboxItemState/,
      );
    }
  });
});

// ============================================================================
// The permanent boundary, restated as assertions
// ============================================================================

describe("Phase 7 — the five boundaries hold", () => {
  it("personal attention state cannot reach shared operational truth", async () => {
    const { sharedConditionAfterPersonalAction } = await import(
      "../src/services/notifications/attention-projection.js"
    );
    const condition = {
      fingerprint: "tsa_failure:evidence-aaaa",
      workspaceId: "w",
      status: "OPEN" as const,
      authority: "evidence" as const,
      occurrenceCount: 1,
    };
    for (const action of ["read", "unread", "archive", "unarchive", "remind"] as const) {
      expect(sharedConditionAfterPersonalAction(condition, action)).toEqual(
        condition,
      );
    }
  });

  it("Security keeps its specialised decisions", async () => {
    const { producesOperationalCondition, isSecuritySpecialized } = await import(
      "../src/services/notifications/notification-classification.js"
    );
    for (const category of ["access_review_pending", "mfa_recovery_pending"]) {
      expect(isSecuritySpecialized(category)).toBe(true);
      expect(producesOperationalCondition(category)).toBe(false);
    }
  });

  it("one domain truth never acquires two lifecycle state machines", async () => {
    const { NOTIFICATION_CLASSIFICATION } = await import(
      "../src/services/notifications/notification-classification.js"
    );
    // Each category names exactly ONE condition authority. Two would be the
    // invariant this program forbids, expressed as data.
    for (const [category, entry] of Object.entries(
      NOTIFICATION_CLASSIFICATION,
    )) {
      expect(typeof entry.conditionAuthority, category).toBe("string");
      expect(entry.conditionAuthority.length, category).toBeGreaterThan(0);
    }
    // And the integrity failures stay with the domain that owns their status
    // column rather than being adopted by Operations.
    expect(NOTIFICATION_CLASSIFICATION.tsa_failure.conditionAuthority).toBe(
      "evidence",
    );
    expect(NOTIFICATION_CLASSIFICATION.ots_failure.conditionAuthority).toBe(
      "evidence",
    );
  });
});
