/**
 * Phase IA-reliability — contract test suite.
 *
 * Pins the closure of the post-/collaboration inbox reliability gaps:
 *
 *   1. InboxItemState model + migration are in place.
 *   2. /v1/me/inbox computes deterministic itemKeys, joins state,
 *      excludes dismissed/snoozed items, and the `unread` filter is
 *      real (not equivalent to `all`).
 *   3. The four mutation endpoints (read/unread/dismiss/snooze) exist,
 *      validate itemKey shape against the allowlist, and scope every
 *      write to the caller's userId.
 *   4. Three intake action-required categories surface from existing
 *      persistence (EvidenceRequest + WorkflowIntakeLink) WITHOUT a
 *      migration.
 *   5. Worker DLQ terminal-failure paths bridge into OperationalIncident
 *      so /v1/me/inbox sees them.
 *
 * Style: source-contract. Reads source files and asserts regex/string
 * shapes. Matches the pattern of every phase contract from A0 onward.
 */

import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

function readSource(rel: string): string {
  const url = new URL(rel, import.meta.url);
  return readFileSync(fileURLToPath(url), "utf8");
}

// ============================================================================
// 1. InboxItemState — schema + migration
// ============================================================================

describe("Phase IA-reliability — InboxItemState schema + migration", () => {
  const SCHEMA = readSource("../prisma/schema.prisma");

  it("declares the InboxItemState model with the exact field set", () => {
    expect(SCHEMA).toMatch(/^model InboxItemState \{/m);
    for (const field of [
      "userId",
      "itemKey",
      "sourceType",
      "sourceId",
      "teamId",
      "orgId",
      "readAt",
      "dismissedAt",
      "snoozedUntil",
      "createdAt",
      "updatedAt",
    ]) {
      // each field appears in the model.
      const start = SCHEMA.indexOf("model InboxItemState {");
      const end = SCHEMA.indexOf("}", start);
      const block = SCHEMA.slice(start, end + 1);
      expect(block, `missing field ${field}`).toMatch(
        new RegExp(`\\b${field}\\b`),
      );
    }
  });

  it("declares the (userId, itemKey) compound unique", () => {
    expect(SCHEMA).toMatch(/@@unique\(\[userId,\s*itemKey\]\)/);
  });

  it("declares the required @@index entries on InboxItemState", () => {
    const start = SCHEMA.indexOf("model InboxItemState {");
    const end = SCHEMA.indexOf("}", start);
    const block = SCHEMA.slice(start, end + 1);
    expect(block).toMatch(/@@index\(\[userId\]\)/);
    expect(block).toMatch(/@@index\(\[userId,\s*dismissedAt\]\)/);
    expect(block).toMatch(/@@index\(\[userId,\s*readAt\]\)/);
    expect(block).toMatch(/@@index\(\[userId,\s*snoozedUntil\]\)/);
    expect(block).toMatch(/@@index\(\[userId,\s*sourceType\]\)/);
    expect(block).toMatch(/@@index\(\[userId,\s*teamId\]\)/);
  });

  it("the SQL migration file exists and uses defensive Phase-O patterns", () => {
    const path = "../prisma/migrations/20270820000000_add_inbox_item_state/migration.sql";
    expect(
      existsSync(fileURLToPath(new URL(path, import.meta.url))),
      "migration.sql must exist",
    ).toBe(true);
    const sql = readSource(path);
    // Defensive create-table guard.
    expect(sql).toMatch(/DO\s*\$\$[\s\S]*?pg_tables[\s\S]*?inbox_item_state/);
    // Compound unique index.
    expect(sql).toMatch(/CREATE UNIQUE INDEX[\s\S]*?user_id[\s\S]*?item_key/);
    // FK with ON DELETE CASCADE so deleting the user cleans up state.
    expect(sql).toMatch(
      /ADD CONSTRAINT[\s\S]*?inbox_item_state_user_id_fkey[\s\S]*?ON DELETE CASCADE/,
    );
    // No destructive operations.
    expect(sql).not.toMatch(/\bDROP\b/);
  });
});

// ============================================================================
// 2. /v1/me/inbox — itemKey, state join, real unread filter
// ============================================================================

describe("Phase IA-reliability — inbox endpoint computes itemKey + joins state", () => {
  const ROUTES = readSource("../src/routes/me-inbox.routes.ts");

  it("the InboxItem type carries itemKey + per-user state fields", () => {
    expect(ROUTES).toMatch(/itemKey:\s*string/);
    expect(ROUTES).toMatch(/isRead:\s*boolean/);
    expect(ROUTES).toMatch(/readAt\?\s*:\s*string\s*\|\s*null/);
    expect(ROUTES).toMatch(/dismissedAt\?\s*:\s*string\s*\|\s*null/);
    expect(ROUTES).toMatch(/snoozedUntil\?\s*:\s*string\s*\|\s*null/);
    expect(ROUTES).toMatch(/canMarkRead:\s*boolean/);
    expect(ROUTES).toMatch(/canDismiss:\s*boolean/);
    expect(ROUTES).toMatch(/canSnooze:\s*boolean/);
  });

  it("batch-fetches InboxItemState scoped to the caller", () => {
    expect(ROUTES).toMatch(/prisma\.inboxItemState\.findMany/);
    // userId-scoped + IN-list of keys.
    expect(ROUTES).toMatch(
      /prisma\.inboxItemState\.findMany\([\s\S]{0,400}userId,[\s\S]{0,200}itemKey:\s*\{\s*in:\s*assembledKeys/,
    );
  });

  it("drops dismissed items + actively-snoozed items from the default result", () => {
    // Operations-Center completion — the aggregation ANNOTATES every
    // item; the GET handler applies visibility so the summary, bulk
    // read, and snapshot sync can share the full set. Dismissed and
    // actively-snoozed items stay hidden by default; the `snoozed`
    // filter shows exactly the actively-snoozed set; History reads the
    // persistent snapshot store.
    expect(ROUTES).toMatch(/const visibleItems = allItems\.filter/);
    expect(ROUTES).toMatch(
      /if \(requestedFilter === "snoozed"\) \{\s*\n\s*return activeSnooze && it\.dismissedAt == null;/,
    );
    expect(ROUTES).toMatch(/if \(it\.dismissedAt != null\) return false;/);
    expect(ROUTES).toMatch(/if \(activeSnooze\) return false;/);
  });

  it("the unread filter is a REAL filter, not aliased to all", () => {
    expect(ROUTES).toMatch(
      /if \(filter === "unread"\) return !item\.isRead/,
    );
  });

  it("itemKey === id for every emitted item (the post-assembly map sets itemKey: it.id)", () => {
    expect(ROUTES).toMatch(/itemKey:\s*it\.id/);
  });
});

// ============================================================================
// 3. Four mutation endpoints + itemKey allowlist validation
// ============================================================================

describe("Phase IA-reliability — read/unread/dismiss/snooze endpoints", () => {
  const ROUTES = readSource("../src/routes/me-inbox.routes.ts");

  it("declares the INBOX_ITEM_KEY_PREFIXES allowlist", () => {
    expect(ROUTES).toMatch(/INBOX_ITEM_KEY_PREFIXES\s*=\s*new Set/);
    for (const prefix of [
      "onboarding",
      "org_invite",
      "org_admin",
      "governance",
      "review_decision",
      "discussion_mention",
      "discussion_assigned",
      "review_escalation",
      "access_review_pending",
      "mfa_recovery_pending",
      "communication_failure",
      "security_event_high",
      "report_failure",
      "verification_package_failure",
      "ots_failure",
      "intake_submission_pending_review",
      "intake_required_items_missing",
      "intake_link_expiring",
    ]) {
      expect(ROUTES).toMatch(new RegExp(`"${prefix}"`));
    }
  });

  it("parseInboxItemKey rejects unknown prefixes + non-benign characters", () => {
    expect(ROUTES).toContain("parseInboxItemKey");
    expect(ROUTES).toMatch(
      /INBOX_ITEM_KEY_PREFIXES\.has\(sourceType\)/,
    );
    // Right-hand pattern check.
    expect(ROUTES).toMatch(/\^\[A-Za-z0-9_\.\:-\]\+\$/);
    // Bounded length.
    expect(ROUTES).toMatch(/itemKey\.length\s*>\s*200/);
  });

  it("declares POST endpoints for read / unread / dismiss / snooze", () => {
    expect(ROUTES).toMatch(
      /app\.post\(\s*"\/v1\/me\/inbox\/items\/:itemKey\/read"/,
    );
    expect(ROUTES).toMatch(
      /app\.post\(\s*"\/v1\/me\/inbox\/items\/:itemKey\/unread"/,
    );
    expect(ROUTES).toMatch(
      /app\.post\(\s*"\/v1\/me\/inbox\/items\/:itemKey\/dismiss"/,
    );
    expect(ROUTES).toMatch(
      /app\.post\(\s*"\/v1\/me\/inbox\/items\/:itemKey\/snooze"/,
    );
  });

  it("every endpoint upserts by the (userId, itemKey) compound unique", () => {
    // applyStateMutation is the single mutation site — inside ONE
    // transaction (tx) alongside the canonical collaboration row and
    // the history-snapshot mirror.
    expect(ROUTES).toMatch(
      /tx\.inboxItemState\.upsert\([\s\S]{0,400}userId_itemKey:/,
    );
  });

  it("snooze bounds reject past dates + more-than-365-days futures", () => {
    expect(ROUTES).toMatch(/365\s*\*\s*24\s*\*\s*60\s*\*\s*60\s*\*\s*1000/);
    expect(ROUTES).toMatch(/snoozedUntil must be in the future/);
    expect(ROUTES).toMatch(/cannot be more than 365 days out/);
  });

  it("every mutation endpoint uses requireAuthAndLegal (no anonymous writes)", () => {
    // The endpoints share a `preHandler: requireAuthAndLegal` literal.
    // Each one must declare it — GET inbox + 4 mutations = 5. (The
    // former /summary endpoint was removed by the Operations-Center
    // redesign — the bell uses the canonical GET /v1/me/inbox.)
    const matches = ROUTES.match(/preHandler:\s*requireAuthAndLegal/g);
    expect(matches, "missing requireAuthAndLegal preHandler").not.toBeNull();
    expect((matches ?? []).length).toBeGreaterThanOrEqual(5);
  });
});

// ============================================================================
// 4. Intake action categories
// ============================================================================

describe("Phase IA-reliability — intake action categories sourced from existing persistence", () => {
  const ROUTES = readSource("../src/routes/me-inbox.routes.ts");

  it("InboxCategory covers the 3 new intake categories", () => {
    expect(ROUTES).toMatch(/\|\s*"intake_submission_pending_review"/);
    expect(ROUTES).toMatch(/\|\s*"intake_required_items_missing"/);
    expect(ROUTES).toMatch(/\|\s*"intake_link_expiring"/);
  });

  it("intake_submission_pending_review queries EvidenceRequest unassigned + RESPONSE_RECEIVED/UNDER_REVIEW", () => {
    expect(ROUTES).toMatch(/prisma\.evidenceRequest\.findMany/);
    expect(ROUTES).toMatch(
      /pendingReviewRequests\s*=[\s\S]{0,400}status:\s*\{\s*in:\s*\["RESPONSE_RECEIVED",\s*"UNDER_REVIEW"\]/,
    );
    expect(ROUTES).toMatch(
      /pendingReviewRequests\s*=[\s\S]{0,400}assignedReviewerUserId:\s*null/,
    );
  });

  it("intake_required_items_missing queries EvidenceRequest PARTIALLY_FULFILLED + NEEDS_MORE_INFO", () => {
    expect(ROUTES).toMatch(
      /incompleteRequests\s*=[\s\S]{0,400}status:\s*\{\s*in:\s*\["PARTIALLY_FULFILLED",\s*"NEEDS_MORE_INFO"\]/,
    );
  });

  it("intake_link_expiring queries WorkflowIntakeLink ACTIVE with expiry in next 7 days", () => {
    expect(ROUTES).toMatch(/prisma\.workflowIntakeLink\.findMany/);
    expect(ROUTES).toMatch(
      /expiringIntakeLinks\s*=[\s\S]{0,400}status:\s*"ACTIVE"[\s\S]{0,300}expiresAtUtc/,
    );
    expect(ROUTES).toMatch(/INTAKE_LINK_EXPIRY_WINDOW_MS\s*=\s*7\s*\*\s*24/);
  });

  it("all 3 intake sources are workspace-scoped via teamIds", () => {
    for (const name of [
      "pendingReviewRequests",
      "incompleteRequests",
      "expiringIntakeLinks",
    ]) {
      expect(ROUTES).toMatch(
        new RegExp(
          `${name}\\s*=[\\s\\S]{0,400}teamId:\\s*\\{\\s*in:\\s*teamIds`,
        ),
      );
    }
  });

  it("intake categories map into the right priority + filter buckets", () => {
    // Pending review + items missing → P2 (action required).
    expect(ROUTES).toMatch(
      /case "intake_submission_pending_review":[\s\S]{0,200}case "intake_required_items_missing":[\s\S]{0,80}return "P2"/,
    );
    // Link expiring → P4 (awareness).
    expect(ROUTES).toMatch(
      /case "intake_link_expiring":[\s\S]{0,80}return "P4"/,
    );
    // FILTER_CATEGORY_MEMBERS routes them to the right chips.
    expect(ROUTES).toMatch(/"intake_submission_pending_review"/);
    expect(ROUTES).toMatch(/"intake_required_items_missing"/);
    expect(ROUTES).toMatch(/"intake_link_expiring"/);
  });
});

// ============================================================================
// 5. Worker DLQ → OperationalIncident bridge
// ============================================================================

describe("Phase IA-reliability — worker DLQ failures bridge into OperationalIncident", () => {
  const PROCESSOR = readSource("../../worker/src/processor.ts");
  const OTS = readSource("../../worker/src/ots-upgrade.processor.ts");
  const EMITTER = readSource(
    "../../worker/src/governance/incident-emitter.ts",
  );

  it("recordWorkerIncident accepts the full IncidentCategory enum", () => {
    for (const cat of [
      "UPLOAD",
      "REPORT",
      "PACKAGE",
      "WEBHOOK",
      "COMMUNICATIONS",
      "IDENTITY_SECURITY",
      "GOVERNANCE",
      "STORAGE",
      "AI",
      "INTEGRATION",
      "DATABASE",
      "WORKER",
      "RECONCILIATION",
    ]) {
      expect(EMITTER).toMatch(new RegExp(`"${cat}"`));
    }
  });

  it("report-DLQ non-retriable terminal failure records a REPORT incident with CRITICAL severity", () => {
    expect(PROCESSOR).toMatch(/recordReportFailureIncident\(/);
    // The bridge function declares CRITICAL for non-retriable + HIGH
    // for retry-exhausted.
    expect(PROCESSOR).toMatch(
      /recordReportFailureIncident\([\s\S]{0,400}severity:\s*"CRITICAL"[\s\S]{0,400}retriable:\s*false/,
    );
    expect(PROCESSOR).toMatch(
      /recordReportFailureIncident\([\s\S]{0,400}severity:\s*"HIGH"[\s\S]{0,400}retriable:\s*true/,
    );
  });

  it("the report bridge calls recordWorkerIncident with REPORT category + deterministic fingerprint", () => {
    expect(PROCESSOR).toMatch(
      /recordWorkerIncident\([\s\S]{0,800}category:\s*"REPORT"/,
    );
    // Fingerprint scopes by evidenceId + errorClass for dedup.
    expect(PROCESSOR).toMatch(/REPORT:\$\{input\.evidenceId\}:\$\{errorClass\}/);
  });

  it("the report bridge truncates stack traces / messages and excludes raw stack from incident metadata", () => {
    // safeSummary is bounded to 380 chars.
    expect(PROCESSOR).toMatch(/rawMessage\.slice\(0,\s*380\)/);
    // The metadata object passed to recordWorkerIncident from the
    // bridge function includes queueName + retriable + errorClass —
    // NOT the raw stack. We slice from the FUNCTION DEFINITION (the
    // last occurrence of recordReportFailureIncident, since callers
    // appear before the function) to the next function boundary.
    const declIdx = PROCESSOR.lastIndexOf(
      "async function recordReportFailureIncident",
    );
    expect(declIdx, "bridge function must be defined").toBeGreaterThan(-1);
    const nextFn = PROCESSOR.indexOf("\nasync function ", declIdx + 50);
    const declBlock = PROCESSOR.slice(
      declIdx,
      nextFn > declIdx ? nextFn : declIdx + 4000,
    );
    expect(declBlock).not.toMatch(/errorStack/);
  });

  it("OTS budget-exhaustion terminal failure records a WORKER incident with CRITICAL severity", () => {
    expect(OTS).toMatch(/recordWorkerIncident\(/);
    expect(OTS).toMatch(
      /recordWorkerIncident\([\s\S]{0,800}category:\s*"WORKER"[\s\S]{0,400}severity:\s*"CRITICAL"/,
    );
    expect(OTS).toMatch(
      /fingerprint:\s*`OTS:\$\{evidenceId\}:GLOBAL_BUDGET_EXHAUSTED`/,
    );
  });

  it("normal OTS PENDING / RETRY_SCHEDULED / WAITING_CONFIRMATIONS NEVER produces an incident", () => {
    // The OTS terminal block only calls recordWorkerIncident inside
    // the budget-exhausted branch — we assert the call site is wrapped
    // in the `if (isOtsGlobalBudgetExhausted(...))` block.
    const callIdx = OTS.indexOf("recordWorkerIncident(");
    expect(callIdx).toBeGreaterThan(-1);
    const upTo = OTS.slice(0, callIdx);
    // The nearest preceding `if (` should be the budget-exhausted check.
    const budgetCheck = upTo.lastIndexOf("isOtsGlobalBudgetExhausted");
    expect(
      budgetCheck,
      "incident emission must sit inside the budget-exhausted branch",
    ).toBeGreaterThan(-1);
    expect(callIdx - budgetCheck).toBeLessThan(3000);
  });

  it("OTS bridge is best-effort — incident emission failure is logged + swallowed", () => {
    // The call sits in a try/catch with a worker.ots.incident_bridge_failed
    // log line.
    expect(OTS).toMatch(/worker\.ots\.incident_bridge_failed/);
  });
});

// ============================================================================
// 6. /inbox UI — read/unread/dismiss/snooze action buttons
// ============================================================================

describe("Phase IA-reliability — /inbox UI exposes per-item actions", () => {
  const PAGE = readSource(
    "../../../apps/web/app/(app)/inbox/page.tsx",
  );

  it("InboxItem type declares itemKey + per-user state fields", () => {
    expect(PAGE).toMatch(/itemKey:\s*string/);
    expect(PAGE).toMatch(/isRead:\s*boolean/);
    expect(PAGE).toMatch(/canMarkRead:\s*boolean/);
    expect(PAGE).toMatch(/canDismiss:\s*boolean/);
    expect(PAGE).toMatch(/canSnooze:\s*boolean/);
  });

  it("renders Mark read / Mark unread / Snooze 1d / Dismiss actions per item", () => {
    expect(PAGE).toMatch(/data-action="mark-read"/);
    expect(PAGE).toMatch(/data-action="mark-unread"/);
    expect(PAGE).toMatch(/data-action="snooze"/);
    expect(PAGE).toMatch(/data-action="dismiss"/);
    // Optimistic-update with rollback on failure.
    expect(PAGE).toMatch(/applyOptimisticUpdate/);
    expect(PAGE).toMatch(/removeItemLocally/);
  });

  it("rendered items carry data-inbox-item-read for tests + analytics", () => {
    expect(PAGE).toMatch(/data-inbox-item-read=\{/);
  });

  it("clicking Open implicitly marks the item read", () => {
    // The Open link's onClick checks isRead + canMarkRead, then fires
    // `void markRead(item)`. We accept any onClick handler that
    // contains both the guard and the markRead call.
    expect(PAGE).toMatch(/!item\.isRead[\s\S]{0,200}markRead\(item\)/);
  });

  it("the UI POSTs to /v1/me/inbox/items/:itemKey/{read,unread,dismiss,snooze}", () => {
    expect(PAGE).toMatch(/\/v1\/me\/inbox\/items\/\$\{[^}]+\}\/\$\{action\}/);
  });

  it("the UI renders intake categories under their own labels", () => {
    for (const key of [
      "intake_submission_pending_review",
      "intake_required_items_missing",
      "intake_link_expiring",
    ]) {
      expect(PAGE).toMatch(new RegExp(`${key}:\\s*"[^"]+"`));
    }
  });
});
