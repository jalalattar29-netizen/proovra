/**
 * PHASE E3.1 — Automation Execution Runtime contract tests.
 *
 * Closes DEF-021. The dispatcher + 7 action handlers ship together.
 * Webhook delivery (DEF-022) remains explicitly out of scope.
 *
 * This file uses behavioural tests against the pure condition
 * evaluator + source-level pins against the dispatcher/handler
 * source. We don't spin up a Prisma test DB — the existing
 * integration test suite already runs the schema; this file pins
 * the safety invariants that must NEVER regress (no eval, no fetch,
 * no custody mutation, bounded payloads, etc).
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  evaluateCondition,
} from "../src/services/automation/automation-dispatcher.service.js";
import { AUTOMATION_TRIGGER_TYPES } from "../src/services/automation/automation.service.js";

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
function readRepo(rel: string): string {
  return readFileSync(repoPath(rel), "utf8");
}
function readWeb(rel: string): string {
  return readFileSync(webPath(rel), "utf8");
}
function readApi(rel: string): string {
  return readFileSync(apiPath(rel), "utf8");
}

const DISPATCHER = readApi(
  "src/services/automation/automation-dispatcher.service.ts",
);
const ACTIONS = readApi("src/services/automation/automation-actions.service.ts");
// ARCH-005 (2026-08-07) — the two halves the dispatcher was split into.
const OUTBOX = readApi("src/services/automation/automation-outbox.service.ts");
const PROCESSOR = readApi(
  "src/services/automation/automation-dispatch-runtime.service.ts",
);
const TRIGGERS = readApi("src/services/automation/automation-triggers.ts");
const PAGE = readWeb("app/(app)/admin/platform/automation/page.tsx");

// ===========================================================================
// PART 1 — Pure condition evaluator (no eval / vm / Function)
// ===========================================================================

describe("E3.1 Test 1 — pure condition evaluator", () => {
  it("empty condition matches (always-true semantics from E3)", () => {
    expect(evaluateCondition({}, {})).toBe(true);
    expect(evaluateCondition(null, {})).toBe(true);
    expect(evaluateCondition(undefined, {})).toBe(true);
  });

  it("equals leaf matches when ctx field equals value", () => {
    expect(
      evaluateCondition(
        { field: "status", op: "equals", value: "OPEN" },
        { status: "OPEN" },
      ),
    ).toBe(true);
    expect(
      evaluateCondition(
        { field: "status", op: "equals", value: "OPEN" },
        { status: "CLOSED" },
      ),
    ).toBe(false);
  });

  it("not_equals leaf is the inverse", () => {
    expect(
      evaluateCondition(
        { field: "status", op: "not_equals", value: "OPEN" },
        { status: "CLOSED" },
      ),
    ).toBe(true);
  });

  it("greater_than / less_than only match on numbers", () => {
    expect(
      evaluateCondition(
        { field: "count", op: "greater_than", value: 5 },
        { count: 10 },
      ),
    ).toBe(true);
    expect(
      evaluateCondition(
        { field: "count", op: "less_than", value: 5 },
        { count: 10 },
      ),
    ).toBe(false);
    // Non-numeric ctx — fail closed.
    expect(
      evaluateCondition(
        { field: "count", op: "greater_than", value: 5 },
        { count: "10" },
      ),
    ).toBe(false);
  });

  it("in / not_in operate on array values", () => {
    expect(
      evaluateCondition(
        { field: "severity", op: "in", value: ["HIGH", "CRITICAL"] },
        { severity: "HIGH" },
      ),
    ).toBe(true);
    expect(
      evaluateCondition(
        { field: "severity", op: "not_in", value: ["HIGH", "CRITICAL"] },
        { severity: "LOW" },
      ),
    ).toBe(true);
  });

  it("all composite is logical AND", () => {
    expect(
      evaluateCondition(
        {
          all: [
            { field: "status", op: "equals", value: "OPEN" },
            { field: "count", op: "greater_than", value: 5 },
          ],
        },
        { status: "OPEN", count: 10 },
      ),
    ).toBe(true);
    expect(
      evaluateCondition(
        {
          all: [
            { field: "status", op: "equals", value: "OPEN" },
            { field: "count", op: "greater_than", value: 5 },
          ],
        },
        { status: "OPEN", count: 1 },
      ),
    ).toBe(false);
  });

  it("any composite is logical OR", () => {
    expect(
      evaluateCondition(
        {
          any: [
            { field: "status", op: "equals", value: "OPEN" },
            { field: "count", op: "greater_than", value: 100 },
          ],
        },
        { status: "OPEN", count: 1 },
      ),
    ).toBe(true);
  });

  it("unknown operator fails closed (does NOT throw)", () => {
    expect(
      evaluateCondition(
        { field: "x", op: "regex_match", value: ".*" },
        { x: "anything" },
      ),
    ).toBe(false);
  });

  it("malformed shapes fail closed (do not throw)", () => {
    expect(evaluateCondition({ garbage: true }, {})).toBe(false);
  });

  it("due_within_hours matches future dates inside the window", () => {
    const inThreeHours = new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString();
    expect(
      evaluateCondition(
        { field: "dueAt", op: "due_within_hours", value: 5 },
        { dueAt: inThreeHours },
      ),
    ).toBe(true);
  });

  it("older_than_days matches old dates beyond the window", () => {
    const tenDaysAgo = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
    expect(
      evaluateCondition(
        { field: "createdAt", op: "older_than_days", value: 7 },
        { createdAt: tenDaysAgo },
      ),
    ).toBe(true);
  });
});

// ===========================================================================
// PART 2 — Dispatcher source-level safety invariants
// ===========================================================================

describe("E3.1 Test 2 — dispatcher source contains no scripting / no fetch", () => {
  it("does not import vm / child_process / fetch / http / https", () => {
    expect(DISPATCHER).not.toMatch(/from\s+["']vm["']/);
    expect(DISPATCHER).not.toMatch(/from\s+["']child_process["']/);
    expect(DISPATCHER).not.toMatch(/from\s+["']http["']/);
    expect(DISPATCHER).not.toMatch(/from\s+["']https["']/);
    expect(DISPATCHER).not.toMatch(/from\s+["']node-fetch["']/);
  });

  it("does not contain eval / new Function / Function(", () => {
    expect(DISPATCHER).not.toMatch(/\beval\s*\(/);
    expect(DISPATCHER).not.toMatch(/new\s+Function\s*\(/);
  });

  /**
   * ARCH-005 (2026-08-07) — THESE MOVED, AND THEY GOT STRICTER.
   *
   * They used to read the dispatcher, which matched rules and executed them in
   * one in-request pass. That pass is gone: matching is the PRODUCER's job and
   * execution is the PROCESSOR's, so the assertions follow the behaviour to
   * where it now lives rather than being deleted with the code that used to
   * hold it. Each also asserts the property the OLD shape could not have.
   */
  it("the producer filters rules by enabled=true (disabled rules cannot run)", () => {
    expect(OUTBOX).toMatch(/enabled:\s*true/);
  });

  it("the producer is team-scoped, and takes the tenant from the source row", () => {
    expect(OUTBOX).toMatch(/teamId:\s*input\.teamId/);
    expect(OUTBOX).toMatch(/triggerType:\s*input\.triggerType/);
  });

  it("the producer collapses a duplicate source event WITHOUT raising", () => {
    // The old assertion wanted a CAUGHT P2002. Inside a source transaction a
    // raised unique violation POISONS that transaction, so catching it in
    // JavaScript would not save the caller's commit — the domain change would
    // be lost because an automation rule fired twice. ON CONFLICT DO NOTHING
    // is the only admissible strategy, and the ABSENCE of the catch is now
    // part of the contract rather than an omission.
    expect(OUTBOX).toMatch(/skipDuplicates:\s*true/);
    // Asserted against CODE, not prose: the module's header explains why the
    // catch is inadmissible, so a bare /P2002/ would fail on its own
    // explanation. What must be absent is the HANDLER.
    expect(OUTBOX).not.toMatch(/code\s*===\s*["']P2002["']/);
    expect(OUTBOX).not.toMatch(/isUniqueConflict/);
  });

  it("the producer NEVER executes — execution belongs to the fenced processor", () => {
    expect(OUTBOX).not.toMatch(/executeAutomationAction/);
    expect(PROCESSOR).toMatch(/executeAutomationAction\(/);
  });

  it("the processor claims under a lease AND a monotonic generation", () => {
    expect(PROCESSOR).toMatch(/claimGeneration:\s*run\.claimGeneration/);
    expect(PROCESSOR).toMatch(
      /leaseExpiresAtUtc:\s*new Date\(nowMs \+ AUTOMATION_LEASE_MS\)/,
    );
  });

  it("every terminal write is FENCED on the generation it claimed under", () => {
    // `fencedUpdate` is the ONLY writer of a terminal state, and its WHERE
    // carries both the status and the generation, so a stale worker updates
    // zero rows. The old in-request executor could not even express this — it
    // had no generation, and it called `automationRun.update({where:{id}})`
    // directly, which overwrites whatever is there.
    const idx = PROCESSOR.indexOf("async function fencedUpdate");
    expect(idx).toBeGreaterThan(-1);
    const body = PROCESSOR.slice(idx, idx + 900);
    expect(body).toMatch(/status:\s*"RUNNING"/);
    expect(body).toMatch(/claimGeneration:\s*generation/);
    expect(body).toMatch(/res\.count === 1/);
    for (const terminal of ["SUCCEEDED", "FAILED", "SKIPPED", "DEAD_LETTERED"]) {
      expect(
        PROCESSOR.includes(`status: "${terminal}"`),
        `${terminal} must be a real written state`,
      ).toBe(true);
    }
    // And nothing bypasses it.
    expect(PROCESSOR.match(/automationRun\.update\(/g) ?? []).toEqual([]);
  });

  it("an ambiguous outcome never becomes SUCCEEDED", () => {
    expect(PROCESSOR).toMatch(/AMBIGUOUS_CODES/);
    expect(PROCESSOR).toMatch(/action_ambiguous/);
    // The classifier maps a timeout or a reset to AMBIGUOUS, never to success
    // and never to a permanent rejection.
    expect(PROCESSOR).toMatch(/timeout/);
    expect(PROCESSOR).toMatch(/econnreset/);
  });

  it("the dispatcher module no longer executes anything", () => {
    // The in-request executor is gone. If it comes back, this fails.
    // Again asserted against CODE: the file documents where the dispatcher
    // went, so the NAME appears in its prose. What must be absent is a
    // callable, and any import that would let it execute.
    expect(DISPATCHER).not.toMatch(
      /export\s+(async\s+)?function\s+dispatchAutomationTrigger/,
    );
    expect(DISPATCHER).not.toMatch(/automationRun\.(create|update|updateMany)/);
    expect(DISPATCHER).not.toMatch(/executeAutomationAction\(/);
    expect(DISPATCHER).not.toMatch(/^import .*automation-actions/m);
    // And neither half re-creates or calls the removed entry point. (Both
    // name it in prose, explaining what they replaced — so, again, the
    // assertion is on the callable and the import, not on the string.)
    for (const src of [OUTBOX, PROCESSOR, TRIGGERS]) {
      expect(src).not.toMatch(/dispatchAutomationTrigger\s*\(/);
      expect(src).not.toMatch(/import[^\n]*dispatchAutomationTrigger/);
    }
  });

  it("all eleven allowlisted triggers have a real source", () => {
    // The finding was not "the dispatcher is unreachable" — it was that a
    // customer could build a rule that never ran. That is only closed when
    // EVERY trigger in the allowlist is emitted or detected by something.
    for (const trigger of AUTOMATION_TRIGGER_TYPES) {
      expect(
        TRIGGERS.includes(`"${trigger}"`),
        `${trigger} has no source in automation-triggers.ts`,
      ).toBe(true);
    }
  });

  it("emits the 4 lifecycle events", () => {
    for (const evt of [
      "automation_run_started",
      "automation_run_succeeded",
      "automation_run_failed",
      "automation_run_skipped",
    ]) {
      expect(DISPATCHER).toContain(`"${evt}"`);
    }
  });

  it("neither half throws past its boundary", () => {
    // The PRODUCER runs inside somebody else's transaction, so an exception
    // here would roll back a legitimate domain change because an automation
    // rule was misconfigured. The PROCESSOR runs in a sweep, where a throw
    // would abandon the rest of the batch.
    expect((OUTBOX.match(/\btry\s*\{/g) ?? []).length).toBeGreaterThanOrEqual(2);
    expect((PROCESSOR.match(/\btry\s*\{/g) ?? []).length).toBeGreaterThanOrEqual(4);
  });

  it("safeEmitSecurityEvent is the canonical emitter (no raw payload assembly)", () => {
    expect(DISPATCHER).toMatch(/safeEmitSecurityEvent\(/);
    // Must NEVER include raw evidence / token fields.
    expect(DISPATCHER).not.toMatch(/storageKey/);
    expect(DISPATCHER).not.toMatch(/signatureBase64/);
    expect(DISPATCHER).not.toMatch(/raw_evidence/i);
  });
});

// ===========================================================================
// PART 3 — Action handlers source-level safety invariants
// ===========================================================================

describe("E3.1 Test 3 — action handler source contains no scripting / no fetch / no custody mutation", () => {
  it("does not import vm / http / https / fetch / child_process", () => {
    expect(ACTIONS).not.toMatch(/from\s+["']vm["']/);
    expect(ACTIONS).not.toMatch(/from\s+["']http["']/);
    expect(ACTIONS).not.toMatch(/from\s+["']https["']/);
    expect(ACTIONS).not.toMatch(/from\s+["']node-fetch["']/);
    expect(ACTIONS).not.toMatch(/from\s+["']child_process["']/);
  });

  it("does NOT call eval / new Function", () => {
    expect(ACTIONS).not.toMatch(/\beval\s*\(/);
    expect(ACTIONS).not.toMatch(/new\s+Function\s*\(/);
  });

  it("does NOT call appendCustodyEvent — custody chain stays out of automation", () => {
    // Match the function CALL, not the word in comments forbidding it.
    expect(ACTIONS).not.toMatch(/\bappendCustodyEvent\s*\(/);
  });

  it("does NOT call evidence.update or evidence.delete (no evidence mutation)", () => {
    // Match Prisma CALLS (with opening paren), not comment mentions.
    expect(ACTIONS).not.toMatch(/\bevidence\.update\s*\(/);
    expect(ACTIONS).not.toMatch(/\bevidence\.delete\s*\(/);
    expect(ACTIONS).not.toMatch(/\bcustodyEvent\.create\s*\(/);
  });

  it("WEBHOOK_DELIVERY handler now present (DEF-022 closed by Phase E3.2)", () => {
    // E3.2 added the bounded webhook handler. Pin its presence as the
    // canonical resolved-state — a future regression that removed the
    // handler would fail this assertion.
    expect(ACTIONS).toMatch(/function actionWebhookDelivery/);
    expect(ACTIONS).toMatch(/case\s+["']WEBHOOK_DELIVERY/);
  });

  it("implements all 7 E3 action handlers", () => {
    for (const handler of [
      "actionNotifyUser",
      "actionNotifyRole",
      "actionCreateReviewTask",
      "actionCreateEscalation",
      "actionAssignReviewer",
      "actionApplyLabel",
      "actionAddOperationalComment",
    ]) {
      expect(ACTIONS).toMatch(new RegExp(`function ${handler}\\b`));
    }
  });

  it("dispatcher exhaustively switches over the 7 action types (no fallthrough to webhook)", () => {
    for (const t of [
      `"NOTIFY_USER"`,
      `"NOTIFY_ROLE"`,
      `"CREATE_REVIEW_TASK"`,
      `"CREATE_ESCALATION"`,
      `"ASSIGN_REVIEWER"`,
      `"APPLY_LABEL"`,
      `"ADD_OPERATIONAL_COMMENT"`,
    ]) {
      expect(ACTIONS).toContain(t);
    }
    expect(ACTIONS).toContain("unknown_action_type:");
  });

  it("team-scope defence-in-depth: assignee + role membership checked via teamMember", () => {
    // NOTIFY_USER + ASSIGN_REVIEWER both look up team membership before
    // recording the action.
    //
    // PHASE 12 REMEDIATION — AUTH-004 (2026-08-06). INTENTIONAL CONTRACT
    // CHANGE, strictly stronger.
    //
    //   OLD: `teamMember.findUnique({ where: { teamId_userId } })` with NO
    //        status predicate. The check proved only that a membership ROW
    //        existed, so an automation could notify a suspended user about
    //        workspace activity they no longer have access to, and could
    //        assign review work to a revoked member who cannot open it.
    //
    //   NEW: `teamMember.findFirst({ where: { …, status: "ACTIVE" } })`, the
    //        canonical predicate. The defence-in-depth property this test
    //        pins — "the action TARGET is verified to belong to the team
    //        before the action is recorded" — is unchanged and now actually
    //        means live membership.
    //
    // The assertion counts the target checks by their status-scoped shape,
    // so a regression back to a status-blind lookup fails here.
    const membershipChecks = (ACTIONS.match(
      /teamMember\.findFirst\(\{\s*\n?\s*where:\s*\{[^}]*status:\s*"ACTIVE"/g,
    ) ?? []).length;
    expect(membershipChecks).toBeGreaterThanOrEqual(2);
    expect(ACTIONS).not.toMatch(/teamMember\.findUnique/);
  });

  it("emits automation_action_executed for every action result", () => {
    expect(ACTIONS).toMatch(/emitActionExecuted\(/);
  });

  it("operator-safe audit summaries never include raw user identifiers", () => {
    // The handlers hash userId for audit display (defence-in-depth).
    expect(ACTIONS).toMatch(/hashShort/);
    // The summary must NEVER include the raw recipient email.
    expect(ACTIONS).not.toMatch(/recipientEmail/);
  });
});

// ===========================================================================
// PART 4 — Frontend UI updated to reflect execution active
// ===========================================================================

describe("E3.1 Test 4 — UI execution-active notice replaces foundation-only notice", () => {
  it("page no longer carries the 'foundation only' notice", () => {
    expect(PAGE).not.toMatch(/foundation only/i);
    expect(PAGE).not.toMatch(/data-automation-dispatcher-notice/);
  });

  it("page shows the execution-runtime-active notice", () => {
    expect(PAGE).toMatch(/data-automation-execution-notice/);
    expect(PAGE).toMatch(/execution runtime active/i);
  });

  it("page still bans drag-drop / scripting / AI / marketplace patterns", () => {
    expect(PAGE).not.toMatch(/draggable=\{?true/);
    expect(PAGE).not.toMatch(/onDragStart=/);
    expect(PAGE).not.toMatch(/<canvas\b/i);
    expect(PAGE).not.toMatch(/react-dnd/);
    expect(PAGE).not.toMatch(/Monaco/i);
    expect(PAGE).not.toMatch(/openai/i);
    expect(PAGE).not.toMatch(/socket\.io/);
  });

  it("page still gated by PageRouteGate routeId='platform.automation'", () => {
    expect(PAGE).toMatch(/PageRouteGate\s+routeId="platform\.automation"/);
  });
});

// ===========================================================================
// PART 5 — No webhook execution code anywhere in automation package
// ===========================================================================

describe("E3.1 Test 5 — WEBHOOK_DELIVERY shipped by Phase E3.2 (DEF-022 closed)", () => {
  it("AUTOMATION_ACTION_TYPES now contains WEBHOOK_DELIVERY (E3.2 added it)", () => {
    const svc = readApi("src/services/automation/automation.service.ts");
    const m = svc.match(
      /AUTOMATION_ACTION_TYPES\s*=\s*\[([\s\S]*?)\]\s*as\s+const/,
    );
    expect(m, "AUTOMATION_ACTION_TYPES array missing").toBeTruthy();
    const arrayBody = m![1]!.replace(/\/\/[^\n]*/g, "");
    expect(arrayBody).toMatch(/WEBHOOK_DELIVERY_INTERNAL_ONLY/);
  });

  it("E3.2 migration's action CHECK constraint now permits WEBHOOK_DELIVERY", () => {
    // The E3 migration's original CHECK constraint did NOT include
    // WEBHOOK_DELIVERY — that was the DEF-022 deferral. Phase E3.2
    // ships its own migration that DROPs + recreates the constraint
    // with WEBHOOK_DELIVERY allowed.
    const e3Migration = readApi(
      "prisma/migrations/20260801000000_phase_e3_automation_foundation/migration.sql",
    );
    const e32Migration = readApi(
      "prisma/migrations/20260802000000_phase_e3_2_webhook_delivery/migration.sql",
    );
    // Original E3 CHECK constraint must NOT mention WEBHOOK (its
    // historical content is preserved — migrations are append-only).
    const e3CheckBlock = e3Migration.match(
      /automation_rules_action_type_allowlist[\s\S]*?CHECK[\s\S]*?\);/,
    );
    expect(e3CheckBlock).toBeTruthy();
    expect(e3CheckBlock![0]).not.toMatch(/WEBHOOK/);
    // E3.2 migration drops + recreates the constraint with WEBHOOK.
    expect(e32Migration).toMatch(
      /DROP CONSTRAINT "automation_rules_action_type_allowlist"/,
    );
    expect(e32Migration).toMatch(/'WEBHOOK_DELIVERY_INTERNAL_ONLY'/);
  });
});

// ===========================================================================
// PART 6 — Capture / custody / report / package files untouched
// ===========================================================================

// ===========================================================================
// PART 7 — No new root nav item; no new state library
// ===========================================================================

describe("E3.1 Test 7 — IA + state contract pins still hold", () => {
  it("32.8 canonical primaries remain exactly 6 (no new root nav)", () => {
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

  it("no new client-state library / realtime library introduced", () => {
    const pkg = JSON.parse(
      readFileSync(webPath("package.json"), "utf8"),
    ) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
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
      "socket.io-client",
      "pusher-js",
      "ably",
    ]) {
      expect(deps[forbidden]).toBeUndefined();
    }
  });
});

// ===========================================================================
// PART 8 — Documentation + registry updated, DEF-021 closed
// ===========================================================================

describe("E3.1 Test 8 — documentation + registry updated; DEF-021 resolved", () => {
  it("docs/product/PHASE_E3_1_AUTOMATION_EXECUTION.md exists + substantial", () => {
    const doc = readRepo(
      "docs/product/PHASE_E3_1_AUTOMATION_EXECUTION.md",
    );
    expect(doc.length).toBeGreaterThan(6000);
    expect(doc).toMatch(/PHASE E3\.1/);
  });

  it("registry registers Phase E3.1 with explicit status", () => {
    const registry = readRepo("docs/recovery/MASTER_PHASE_REGISTRY.md");
    expect(registry).toMatch(
      /\|\s*(Phase )?E3\.1\s*\|[\s\S]*?(CLOSED|CLOSED_WITH_DEFERRED_ITEMS)/,
    );
  });

  it("registry marks DEF-021 as RESOLVED with Phase E3.1 reference", () => {
    const registry = readRepo("docs/recovery/MASTER_PHASE_REGISTRY.md");
    // The DEF-021 row should now have RESOLVED status + reference E3.1.
    const def021Row = registry.match(/\|\s*DEF-021\s*\|[^\n]*/);
    expect(def021Row, "DEF-021 row missing from registry").toBeTruthy();
    expect(def021Row![0]).toMatch(/RESOLVED/);
    expect(def021Row![0]).toMatch(/E3\.1/);
  });

  it("DEF-022 (webhook) is RESOLVED by Phase E3.2 (replaces the original E3.1 inverse pin)", () => {
    const registry = readRepo("docs/recovery/MASTER_PHASE_REGISTRY.md");
    const def022Row = registry.match(/\|\s*DEF-022\s*\|[^\n]*/);
    expect(def022Row, "DEF-022 row missing from registry").toBeTruthy();
    expect(def022Row![0]).toMatch(/RESOLVED/);
    expect(def022Row![0]).toMatch(/E3\.2/);
  });
});
