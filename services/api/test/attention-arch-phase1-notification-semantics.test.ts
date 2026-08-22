/**
 * ATTENTION ARCHITECTURE — PHASE 1 (2026-08-22).
 *
 * `/v1/me/inbox` is now explicitly a PERSONAL NOTIFICATION system. The route
 * name is deliberately unchanged (route migration is Phase 5); what changed is
 * that the semantics are stated in code instead of implied by a list.
 *
 * This suite pins four things:
 *
 *   1. Personal attention state is three ORTHOGONAL axes, derived in exactly
 *      one place, and every historical row stays interpretable.
 *   2. `dismissedAt` is PERSONAL and is never migrated, translated or
 *      projected into a shared suppression.
 *   3. The audited category classification is TOTAL over `InboxCategory`,
 *      encoded rather than reimplemented per surface.
 *   4. Guidance is out of the workload, and the API says so with a number.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  classifyCategory,
  countsAsWorkload,
  isGuidance,
  isSecuritySpecialized,
  NOTIFICATION_CLASSIFICATION,
  producesOperationalCondition,
  producesPersonalNotification,
  scopeForCategory,
} from "../src/services/notifications/notification-classification.js";
import {
  derivePersonalAttentionState,
  isActiveForRecipient,
  isUnreadActive,
  LEGACY_ACTION_ALIASES,
  PERSONAL_ATTENTION_ACTIONS,
} from "../src/services/notifications/personal-attention-state.js";

function readSource(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
}

const NOW = new Date("2026-08-22T12:00:00.000Z");

// ============================================================================
// 1.1 — personal attention state
// ============================================================================

describe("Phase 1.1 — three orthogonal axes", () => {
  it("no state row at all is UNREAD + ACTIVE + no reminder", () => {
    const s = derivePersonalAttentionState(null, NOW);
    expect(s).toEqual({
      readState: "UNREAD",
      lifecycle: "ACTIVE",
      remindAt: null,
      deferred: false,
    });
  });

  it("READ and ACTIVE coexist — reading is not filing", () => {
    const s = derivePersonalAttentionState(
      { readAt: NOW, dismissedAt: null, snoozedUntil: null },
      NOW,
    );
    expect(s.readState).toBe("READ");
    expect(s.lifecycle).toBe("ACTIVE");
    expect(isActiveForRecipient(s)).toBe(true);
    expect(isUnreadActive(s)).toBe(false);
  });

  it("ARCHIVED and UNREAD coexist — filing is not reading", () => {
    const s = derivePersonalAttentionState(
      { readAt: null, dismissedAt: NOW, snoozedUntil: null },
      NOW,
    );
    expect(s.readState).toBe("UNREAD");
    expect(s.lifecycle).toBe("ARCHIVED");
    expect(isActiveForRecipient(s)).toBe(false);
  });

  it("a future reminder defers without archiving; an elapsed one restores", () => {
    const future = new Date(NOW.getTime() + 1000);
    const past = new Date(NOW.getTime() - 1000);
    const deferred = derivePersonalAttentionState(
      { readAt: null, dismissedAt: null, snoozedUntil: future },
      NOW,
    );
    const elapsed = derivePersonalAttentionState(
      { readAt: null, dismissedAt: null, snoozedUntil: past },
      NOW,
    );
    expect(deferred.deferred).toBe(true);
    expect(deferred.lifecycle).toBe("ACTIVE");
    expect(isActiveForRecipient(deferred)).toBe(false);
    expect(elapsed.deferred).toBe(false);
    expect(isActiveForRecipient(elapsed)).toBe(true);
  });

  it("accepts both Date and ISO-string columns identically", () => {
    const fromDate = derivePersonalAttentionState(
      { readAt: NOW, dismissedAt: null, snoozedUntil: null },
      NOW,
    );
    const fromIso = derivePersonalAttentionState(
      { readAt: NOW.toISOString(), dismissedAt: null, snoozedUntil: null },
      NOW,
    );
    expect(fromIso).toEqual(fromDate);
  });

  it("a malformed timestamp fails closed to UNREAD/ACTIVE rather than throwing", () => {
    const s = derivePersonalAttentionState(
      { readAt: "not-a-date", dismissedAt: "also-not", snoozedUntil: "nope" },
      NOW,
    );
    expect(s.readState).toBe("UNREAD");
    expect(s.lifecycle).toBe("ACTIVE");
    expect(s.deferred).toBe(false);
  });
});

// ============================================================================
// 1.1 — product vocabulary migration
// ============================================================================

describe("Phase 1.1 — archive / remind me later", () => {
  it("names the canonical actions and the column each writes", () => {
    expect(PERSONAL_ATTENTION_ACTIONS.archive).toBe("dismissedAt");
    expect(PERSONAL_ATTENTION_ACTIONS.unarchive).toBe("dismissedAt");
    expect(PERSONAL_ATTENTION_ACTIONS.remind).toBe("snoozedUntil");
    expect(PERSONAL_ATTENTION_ACTIONS.read).toBe("readAt");
  });

  it("maps every legacy action name onto a canonical one", () => {
    expect(LEGACY_ACTION_ALIASES.dismiss).toBe("archive");
    expect(LEGACY_ACTION_ALIASES.snooze).toBe("remind");
    expect(LEGACY_ACTION_ALIASES.undismiss).toBe("unarchive");
    for (const canonical of Object.values(LEGACY_ACTION_ALIASES)) {
      expect(Object.keys(PERSONAL_ATTENTION_ACTIONS)).toContain(canonical);
    }
  });

  it("registers canonical routes AND keeps the legacy URLs alive", () => {
    const ROUTES = readSource("../src/routes/me-inbox.routes.ts");
    for (const canonical of ["archive", "unarchive", "remind"]) {
      expect(ROUTES).toContain(`/v1/me/inbox/items/:itemKey/${canonical}`);
    }
    // The legacy URLs are registered as LITERAL paths — every route in this
    // service must be statically resolvable for the capability analyzer — but
    // each points at the canonical handler, so there is one implementation
    // per pair of names and the two cannot drift.
    for (const legacy of ["dismiss", "undismiss", "snooze"]) {
      expect(ROUTES).toContain(
        `app.post("/v1/me/inbox/items/:itemKey/${legacy}"`,
      );
    }
    // And the documented alias table is reconciled against the registrations
    // at boot, so neither side can silently grow an entry the other lacks.
    expect(ROUTES).toContain("LEGACY_ACTION_ALIASES");
    expect(ROUTES).toContain("REGISTERED_LEGACY_ALIASES");
  });

  it("emits the canonical `attention` object from every mutation", () => {
    const ROUTES = readSource("../src/routes/me-inbox.routes.ts");
    expect(ROUTES).toContain("function personalStateResponse(");
    // ONE derivation feeds both the legacy trio and the new object.
    expect(ROUTES).toMatch(/isRead: attention\.readState === "READ"/);
    expect(ROUTES).toMatch(/snoozedUntil: attention\.remindAt/);
  });
});

// ============================================================================
// 1.2 — existing dismissals must NOT become workspace suppression
// ============================================================================

describe("Phase 1.2 — historical dismissals stay personal", () => {
  it("no migration translates dismissedAt into a shared SUPPRESSED status", () => {
    // A migration that did this would be irreversible and silent, so the
    // guard is a repository-wide search rather than a single-file read.
    const MIGRATIONS_DIR = fileURLToPath(
      new URL("../prisma/migrations", import.meta.url),
    );
    const offenders: string[] = [];
    for (const dir of readdirSync(MIGRATIONS_DIR)) {
      const full = `${MIGRATIONS_DIR}/${dir}`;
      if (!statSync(full).isDirectory()) continue;
      let sql: string;
      try {
        sql = readFileSync(`${full}/migration.sql`, "utf8");
      } catch {
        continue;
      }
      const normalized = sql.toLowerCase();
      const touchesPersonal =
        normalized.includes("dismissed_at") ||
        normalized.includes("inbox_item_states");
      const touchesShared =
        normalized.includes("suppressed") ||
        normalized.includes("operational_incidents");
      if (touchesPersonal && touchesShared) offenders.push(dir);
    }
    expect(offenders).toEqual([]);
  });

  it("the archive handler writes ONLY per-user columns", () => {
    const ROUTES = readSource("../src/routes/me-inbox.routes.ts");
    const start = ROUTES.indexOf("const archiveHandler");
    const end = ROUTES.indexOf("const unarchiveHandler");
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    const body = ROUTES.slice(start, end);
    expect(body).toContain("applyStateMutation");
    // Nothing shared may appear anywhere in the handler.
    expect(body).not.toMatch(/operationalIncident/i);
    expect(body).not.toMatch(/SUPPRESSED/);
  });

  it("the personal-state module states the rule as an assertable constant", () => {
    const SRC = readSource(
      "../src/services/notifications/personal-attention-state.ts",
    );
    expect(SRC).toContain("PERSONAL_STATE_IS_NEVER_SHARED_SUPPRESSION");
    expect(SRC).toContain(
      "InboxItemState.dismissedAt  IS NOT  OperationalIncident.status = SUPPRESSED",
    );
  });
});

// ============================================================================
// 1.5 — the audited classification
// ============================================================================

/**
 * Every value in the `InboxCategory` union, read out of the route module so
 * adding a category there without classifying it here is a RED test rather
 * than a silent fall-through to a default.
 */
function inboxCategoriesFromSource(): string[] {
  const SRC = readSource("../src/routes/me-inbox.routes.ts");
  const start = SRC.indexOf("type InboxCategory =");
  expect(start).toBeGreaterThan(0);
  const end = SRC.indexOf('| "case_assignment";', start);
  expect(end).toBeGreaterThan(start);
  const block = SRC.slice(start, end + '| "case_assignment";'.length);
  const found = [...block.matchAll(/\|\s*"([a-z_]+)"/g)].map((m) => m[1]);
  expect(found.length).toBeGreaterThanOrEqual(20);
  return [...new Set(found)];
}

describe("Phase 1.5 — classification is total and matches the audit", () => {
  const CATEGORIES = inboxCategoriesFromSource();

  it("classifies every InboxCategory with no leftovers on either side", () => {
    const classified = Object.keys(NOTIFICATION_CLASSIFICATION).sort();
    expect(CATEGORIES.slice().sort()).toEqual(classified);
  });

  it("encodes the audited channel assignment verbatim", () => {
    // N = notification, O = operational condition, T = assigned task,
    // G = guidance, S = security-specialized. H = both N and O.
    const expected: Record<string, string[]> = {
      onboarding: ["guidance"],
      org_invite: ["notification", "assigned_task"],
      org_admin: ["operational_condition"],
      governance: ["notification", "operational_condition"],
      review_decision: [
        "notification",
        "operational_condition",
        "assigned_task",
      ],
      discussion_mention: ["notification"],
      discussion_assigned: ["notification", "assigned_task"],
      review_escalation: [
        "notification",
        "operational_condition",
        "assigned_task",
      ],
      access_review_pending: ["security_specialized", "assigned_task"],
      mfa_recovery_pending: ["security_specialized"],
      communication_failure: ["notification", "operational_condition"],
      security_event_high: ["notification", "security_specialized"],
      report_failure: ["notification", "operational_condition"],
      verification_package_failure: ["notification", "operational_condition"],
      ots_failure: ["notification", "operational_condition"],
      tsa_failure: ["notification", "operational_condition"],
      intake_submission_pending_review: [
        "operational_condition",
        "assigned_task",
      ],
      intake_required_items_missing: ["operational_condition"],
      intake_link_expiring: ["operational_condition"],
      collaboration: ["notification"],
      case_assignment: ["notification", "assigned_task"],
    };
    for (const [category, channels] of Object.entries(expected)) {
      expect(classifyCategory(category)?.channels.slice().sort()).toEqual(
        channels.slice().sort(),
      );
    }
  });

  it("keeps security-specialized decisions Security-owned, not generic ops", () => {
    // Invariant 5. `access_review_pending` and `mfa_recovery_pending` carry
    // the security channel and NOT the operational-condition channel, so
    // Operations can summarize and link but never adjudicate them.
    for (const category of ["access_review_pending", "mfa_recovery_pending"]) {
      expect(isSecuritySpecialized(category)).toBe(true);
      expect(producesOperationalCondition(category)).toBe(false);
      expect(classifyCategory(category)?.conditionAuthority).toBe(
        "identity_security",
      );
    }
  });

  it("does not force every operational category into OperationalIncident", () => {
    // Invariant 3. Only the two categories that ALREADY are incidents name
    // Operations as their authority; the rest keep their domain's lifecycle.
    const operationsOwned = Object.entries(NOTIFICATION_CLASSIFICATION)
      .filter(([, c]) => c.conditionAuthority === "operations")
      .map(([k]) => k)
      .sort();
    expect(operationsOwned).toEqual([
      "report_failure",
      "verification_package_failure",
    ]);
    // And the integrity failures stay with Evidence, which owns the status
    // column that says whether they are fixed.
    expect(classifyCategory("tsa_failure")?.conditionAuthority).toBe("evidence");
    expect(classifyCategory("ots_failure")?.conditionAuthority).toBe("evidence");
  });

  it("declares an addressing scope for every category", () => {
    for (const category of CATEGORIES) {
      expect(["ACCOUNT", "WORKSPACE", "ORGANIZATION"]).toContain(
        scopeForCategory(category),
      );
    }
    // Account-tier signals must not be workspace-scoped away.
    expect(scopeForCategory("security_event_high")).toBe("ACCOUNT");
    expect(scopeForCategory("org_invite")).toBe("ORGANIZATION");
    expect(scopeForCategory("discussion_mention")).toBe("WORKSPACE");
  });

  it("gives every classification a written rationale", () => {
    for (const [category, c] of Object.entries(NOTIFICATION_CLASSIFICATION)) {
      expect(c.rationale.length, category).toBeGreaterThan(30);
    }
  });
});

// ============================================================================
// 1.6 — onboarding leaves the workload
// ============================================================================

describe("Phase 1.6 — guidance is not work", () => {
  it("classifies onboarding as guidance and nothing else", () => {
    expect(isGuidance("onboarding")).toBe(true);
    expect(producesOperationalCondition("onboarding")).toBe(false);
    expect(producesPersonalNotification("onboarding")).toBe(false);
    expect(countsAsWorkload("onboarding")).toBe(false);
  });

  it("is the ONLY guidance category — nothing else quietly opts out", () => {
    const guidance = Object.keys(NOTIFICATION_CLASSIFICATION).filter(isGuidance);
    expect(guidance).toEqual(["onboarding"]);
  });

  it("counts real work as work", () => {
    for (const category of [
      "tsa_failure",
      "ots_failure",
      "report_failure",
      "intake_required_items_missing",
      "access_review_pending",
      "case_assignment",
    ]) {
      expect(countsAsWorkload(category), category).toBe(true);
    }
  });

  it("a pure message is awareness, not workload", () => {
    expect(countsAsWorkload("discussion_mention")).toBe(false);
    expect(producesPersonalNotification("discussion_mention")).toBe(true);
  });

  it("the API reports workload separately from total", () => {
    const ROUTES = readSource("../src/routes/me-inbox.routes.ts");
    expect(ROUTES).toMatch(
      /workload: scopeItems\.filter\(\(i\) => i\.classification\.countsAsWorkload\)/,
    );
    expect(ROUTES).toMatch(/guidance: scopeItems\.filter/);
  });

  it("every item carries its classification so no surface re-derives it", () => {
    const ROUTES = readSource("../src/routes/me-inbox.routes.ts");
    expect(ROUTES).toContain("classification: {");
    expect(ROUTES).toContain("countsAsWorkload: countsAsWorkload(it.category)");
    expect(ROUTES).toContain("scope: scopeForCategory(it.category)");
  });
});

// ============================================================================
// 1.3 — the projection split exists as a module, not a convention
// ============================================================================

describe("Phase 1.3 — notification and operational condition are separate", () => {
  it("the split is implemented where it can be tested", () => {
    const SRC = readSource(
      "../src/services/notifications/attention-projection.ts",
    );
    expect(SRC).toContain("export function projectDomainEvent");
    expect(SRC).toContain("export function sharedConditionAfterPersonalAction");
    expect(SRC).toContain(
      "export function personalStateAfterSharedAdjudication",
    );
  });

  it("a purely personal category produces no shared work at all", () => {
    expect(producesOperationalCondition("discussion_mention")).toBe(false);
    expect(producesOperationalCondition("collaboration")).toBe(false);
  });

  it("a purely shared category produces no personal notification", () => {
    // Nobody is individually addressed by "a shared intake link is expiring".
    expect(producesPersonalNotification("intake_link_expiring")).toBe(false);
    expect(producesOperationalCondition("intake_link_expiring")).toBe(true);
  });
});
