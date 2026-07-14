/**
 * Phase 6 (Enterprise Collaboration) — SCOPE C/E locks.
 *
 * These tests pin two inviolables the Phase 6 brief calls out:
 *
 *   1. Evidence assignment / claim / decision must NOT alter the
 *      underlying evidence's ownership, submitter, or custody chain.
 *      They only move the EvidenceReviewWorkflow row + emit an audit
 *      event. This is asserted at the SOURCE level: the review-
 *      operations service is only permitted to write to
 *      `evidenceReviewWorkflow` (the workflow row) and
 *      `evidenceReviewWorkflowEvent` (the immutable history). Any
 *      `prisma.evidence.update`, custody-event write, or mutation of
 *      submitterId/ownerId inside this service would be a regression
 *      that silently rewrites the custody story — so we fail the build
 *      if one appears.
 *
 *   2. The operational inbox scope panel must be HONEST: it must not
 *      advertise shipped, wired features (per-user read / dismiss /
 *      snooze, backed by the InboxItemState table) as "Deferred". A
 *      stale "deferred" claim about a live feature misleads operators
 *      just as much as a fabricated one.
 *
 * Pure source-text tests; no DB required. Matches the existing
 * review-operations.test.ts source-contract style.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

function readSrc(relFromTest: string): string {
  return readFileSync(
    fileURLToPath(new URL(relFromTest, import.meta.url)),
    "utf8",
  );
}

const REVIEW_OPS_SERVICE = readSrc(
  "../src/services/review-operations/review-operations.service.ts",
);

describe("SCOPE C — evidence assignment does not touch ownership / submitter / custody", () => {
  it("the review-operations service never writes evidence ownership, submitter, or custody", () => {
    // The service is the single mutation path behind assignReviewer /
    // claimReviewerWorkflow / recordReviewDecision (proven by
    // review-operations.test.ts). It must not write any of the
    // custody-story fields.
    expect(REVIEW_OPS_SERVICE).not.toMatch(/prisma\.evidence\.(update|delete|create)/);
    expect(REVIEW_OPS_SERVICE).not.toMatch(/client\.evidence\.(update|delete|create)/);
    // Custody chain models are off-limits from this service.
    expect(REVIEW_OPS_SERVICE).not.toMatch(/custodyEvent\.(create|update)/i);
    expect(REVIEW_OPS_SERVICE).not.toMatch(/chainOfCustody/i);
    // The workflow row must never carry a submitter/owner reassignment.
    expect(REVIEW_OPS_SERVICE).not.toMatch(/submitterId\s*[:=]/);
    expect(REVIEW_OPS_SERVICE).not.toMatch(/ownerId\s*[:=]/);
  });

  it("the ONLY prisma writes in the service target the workflow row + its audit event", () => {
    // Collect every `.create( / .update( / .updateMany( / .delete(` call
    // target. Assignment/claim/decision are allowed to move the workflow
    // and append to its immutable event log — nothing else.
    const writeTargets = Array.from(
      REVIEW_OPS_SERVICE.matchAll(
        /(?:client|prisma|tx)\.(\w+)\.(create|update|updateMany|delete|deleteMany|upsert)\b/g,
      ),
    ).map((m) => m[1]);

    expect(writeTargets.length).toBeGreaterThan(0);
    const allowed = new Set([
      "evidenceReviewWorkflow",
      "evidenceReviewWorkflowEvent",
    ]);
    for (const target of writeTargets) {
      expect(
        allowed.has(target),
        `review-operations.service.ts writes to prisma.${target} — assignment/claim/decision must only mutate the workflow row + its audit event, never evidence/custody`,
      ).toBe(true);
    }
  });

  it("applyTransition (the shared assign/claim/decision writer) updates only evidenceReviewWorkflow", () => {
    const start = REVIEW_OPS_SERVICE.indexOf("async function applyTransition");
    expect(start).toBeGreaterThan(-1);
    // Slice to the next top-level function so we only inspect this body.
    const rest = REVIEW_OPS_SERVICE.slice(start);
    const nextFn = rest.indexOf("\nasync function ", 1);
    const body = nextFn > 0 ? rest.slice(0, nextFn) : rest;
    // It writes the workflow row via updateMany (optimistic concurrency)
    // and re-reads it. No other model appears.
    expect(body).toMatch(/evidenceReviewWorkflow\.updateMany/);
    expect(body).not.toMatch(/\.evidence\.(update|create|delete)/);
    expect(body).not.toMatch(/custody/i);
  });

  it("assignReviewer + claimReviewerWorkflow emit an audit event via recordEvent", () => {
    // Assignment must be audited — the ASSIGNED / REASSIGNED / CLAIMED
    // event rows are the operator-visible history.
    const assignStart = REVIEW_OPS_SERVICE.indexOf(
      "export async function assignReviewer",
    );
    const claimStart = REVIEW_OPS_SERVICE.indexOf(
      "export async function claimReviewerWorkflow",
    );
    expect(assignStart).toBeGreaterThan(-1);
    expect(claimStart).toBeGreaterThan(-1);
    const assignBody = REVIEW_OPS_SERVICE.slice(assignStart, claimStart);
    expect(assignBody).toMatch(/recordEvent\(/);
    expect(assignBody).toMatch(/"REASSIGNED"|REASSIGNED/);
    // recordEvent writes the immutable workflow event row.
    const recordStart = REVIEW_OPS_SERVICE.indexOf(
      "async function recordEvent",
    );
    const recordRest = REVIEW_OPS_SERVICE.slice(recordStart);
    const recordEnd = recordRest.indexOf("\n}");
    const recordBody = recordRest.slice(0, recordEnd > 0 ? recordEnd : undefined);
    expect(recordBody).toMatch(/evidenceReviewWorkflowEvent\.create/);
  });
});

describe("SCOPE C — route gating for assignment is preserved", () => {
  const ROUTES = readSrc("../src/routes/review-operations.routes.ts");

  it("admin assign + SLA routes require an OWNER/ADMIN member; claim/decision require a reviewer member", () => {
    // requireAdminMember gates the admin-only mutations; the assign
    // route must use it (not the looser reviewer gate).
    expect(ROUTES).toMatch(/requireAdminMember/);
    expect(ROUTES).toMatch(/requireReviewerMember/);
    // Anti-enumeration: still 404 (never 403) on non-members.
    expect(ROUTES).not.toMatch(/reply\.code\(403\)/);
    expect(ROUTES).toMatch(/reply\.code\(404\)/);
  });
});

describe("SCOPE E — Operations Center ships per-user state without developer-facing panels", () => {
  const INBOX_PAGE = readSrc("../../../apps/web/app/(app)/inbox/page.tsx");

  it("the developer-facing scope panel is GONE (production UI only)", () => {
    // Operations-Center redesign — the "Available now / Deferred"
    // engineering panel was removed from the production page. Honesty
    // now lives in behavior (real filters, computed counters, degraded
    // banners), not in embedded engineering notes.
    expect(INBOX_PAGE).not.toMatch(/data-inbox-scope-panel/);
    expect(INBOX_PAGE).not.toMatch(/data-inbox-scope-item=/);
    expect(INBOX_PAGE).not.toMatch(/>Deferred</);
    expect(INBOX_PAGE).not.toMatch(/>Available now</);
  });

  it("the page still actually calls the per-user state mutation endpoints", () => {
    // Guard against a lazy 'fix' that removes the dev panel by also
    // removing the feature. The mutation calls must remain wired.
    expect(INBOX_PAGE).toMatch(
      /\/v1\/me\/inbox\/items\/\$\{encodeURIComponent\(itemKey\)\}\/\$\{action\}/,
    );
    expect(INBOX_PAGE).toMatch(/"read" \| "unread" \| "dismiss" \| "snooze"/);
  });

  it("the formerly-deferred notification preferences UI now EXISTS as a real page", () => {
    const prefsPage = readSrc(
      "../../../apps/web/app/(app)/settings/notifications/page.tsx",
    );
    expect(prefsPage).toContain("NotificationPreferencesPanel");
    expect(prefsPage).toContain("account.notification_settings");
  });
});
