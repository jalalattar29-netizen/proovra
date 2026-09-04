/**
 * EXTERNAL INTAKE — the review workflow the card drives.
 *
 * Three defects sat behind one message. Clicking any verdict on an
 * externally-submitted record answered "Please review your input and try
 * again", and each of the three had a different cause:
 *
 *   404  the decision endpoint derives its authorization subject from the
 *        persisted workflow row, and an untriaged intake record has none;
 *   422  the decision service requires a written rationale for every verdict
 *        except APPROVE, and the card sent `note: null` for all three;
 *   500  a valid request-more-info decision derived stage `NEEDS_MORE_INFO`
 *        and cast it straight into the Prisma column, whose enum member is
 *        `NEEDS_INFO` — a value Postgres rejects.
 *
 * All three were reproduced against a live API before being fixed, and the
 * verdicts now persist as NEEDS_INFO / REJECTED_INSUFFICIENT /
 * APPROVED_INTERNAL respectively.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  REVIEW_STAGES,
  REVIEW_STAGE_TO_DB_STATUS,
  mapDbStatusToReviewStage,
  mapReviewStageToDbStatus,
} from "@proovra/shared";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const read = (rel: string) => readFileSync(resolve(ROOT, rel), "utf8");

const CARD = read(
  "apps/web/app/(app)/evidence/[id]/components/ExternalIntakeSourceCard.tsx",
);
const SUMMARY_SERVICE = read(
  "services/api/src/services/external-intake-source-summary.service.ts",
);
const EVIDENCE_ROUTES = read("services/api/src/routes/evidence.routes.ts");
const DECISION_SERVICE = read(
  "services/api/src/services/reviewer-ops/review-decision.service.ts",
);

// ===========================================================================
// The 500 — a stage name that is not a column value
// ===========================================================================
describe("review stage maps to the value the column actually stores", () => {
  it("every stage has a stored value, and it round-trips", () => {
    for (const stage of REVIEW_STAGES) {
      const stored = mapReviewStageToDbStatus(stage);
      expect(stored, `${stage} has no stored value`).toBeTruthy();
      expect(
        mapDbStatusToReviewStage(stored),
        `${stage} does not round-trip through ${stored}`,
      ).toBe(stage);
    }
  });

  it("NEEDS_MORE_INFO stores as NEEDS_INFO — the one asymmetry", () => {
    /*
     * Nine of the ten stage names are also Prisma enum members. This one is
     * not, and the blanket cast that used to stand in for this mapping could
     * not notice, because a cast is the instruction not to check.
     */
    expect(REVIEW_STAGE_TO_DB_STATUS.NEEDS_MORE_INFO).toBe("NEEDS_INFO");
    expect(mapReviewStageToDbStatus("NEEDS_MORE_INFO")).not.toBe("NEEDS_MORE_INFO");
  });

  it("no service casts a stage into the status column any more", () => {
    for (const src of [
      "services/api/src/services/reviewer-ops/review-decision.service.ts",
      "services/api/src/services/review-operations/review-operations.service.ts",
    ]) {
      expect(read(src), `${src} still casts`).not.toContain(
        "return stage as unknown as EvidenceReviewWorkflowStatus",
      );
      expect(read(src)).toContain("mapReviewStageToDbStatus(stage)");
    }
  });

  it("the rationale rule the card must satisfy is still APPROVE-only", () => {
    // If this ever widens, the card's required-reason set has to widen with
    // it — which is why the rule is asserted here rather than assumed.
    expect(DECISION_SERVICE).toContain(
      'rationale.length === 0 && input.decision !== "APPROVE"',
    );
  });
});

// ===========================================================================
// The 422 and the 404 — what the card sends
// ===========================================================================
describe("the card sends a request the server can accept", () => {
  it("asks for the reason the two verdicts require", () => {
    expect(CARD).toContain("DECISION_REQUIRES_REASON");
    const set = CARD.slice(
      CARD.indexOf("const DECISION_REQUIRES_REASON"),
      CARD.indexOf("const REASON_PROMPT"),
    );
    expect(set).toContain('"REQUEST_MORE_INFO"');
    expect(set).toContain('"REJECT_INSUFFICIENT"');
    // APPROVE is the one the server does not require a rationale for; asking
    // for one would be inventing a requirement.
    expect(set).not.toContain('"APPROVE_INTERNAL"');
  });

  it("cannot submit an empty reason", () => {
    expect(CARD).toContain("disabled={reviewBusy || pendingReason.trim().length === 0}");
    expect(CARD).toContain("if (reason.length === 0) return;");
  });

  it("opens the workflow row before recording a verdict on an untriaged record", () => {
    /*
     * The decision route reads the workflow to find the workspace and answers
     * 404 when there is none. An intake record nobody has triaged has none —
     * which is precisely the record this card exists to review.
     */
    const fn = CARD.slice(
      CARD.indexOf("async function recordDecision("),
      CARD.indexOf("/** Start (or cancel) the reason"),
    );
    expect(fn).toContain("if (!review?.workflow?.id) {");
    expect(fn).toContain('status: "IN_REVIEW"');
    expect(fn.indexOf("reviewer-workflow")).toBeLessThan(
      fn.indexOf("review-operations"),
    );
  });

  it("still lets the server derive the status from the decision", () => {
    // The browser names the decision; it never asserts the resulting status.
    expect(CARD).toContain("JSON.stringify({ decision, note: note ?? null })");
    expect(CARD).not.toMatch(/body: JSON\.stringify\(\{\s*status: action\./);
  });
});

// ===========================================================================
// Authorization — reading is not triaging
// ===========================================================================
describe("reviewer workflow mutation requires reviewer authority", () => {
  it("the routing PATCH gates on the reviewer permission, not read access", () => {
    /*
     * Proven against a live workspace before the fix: a VIEWER moved a record
     * from IN_REVIEW back to NOT_STARTED and it persisted, while the verdict
     * endpoint beside it correctly refused the same user. Now 403 on both.
     */
    const patch = EVIDENCE_ROUTES.slice(
      EVIDENCE_ROUTES.indexOf('app.patch(\n    "/v1/evidence/:id/reviewer-workflow"'),
      EVIDENCE_ROUTES.indexOf("const summary = await upsertEvidenceReviewerWorkflow"),
    );
    expect(patch).toContain("authorizeOrFail(req, reply, {");
    expect(patch).toContain('permission: "evidence_request.review"');
    expect(patch).toContain("antiEnumeration: true");
  });

  it("a personal workspace is not gated on a membership it cannot have", () => {
    // No team row means no member row; read access there already means sole
    // ownership.
    expect(EVIDENCE_ROUTES).toContain("if (evidence.teamId) {");
  });
});

// ===========================================================================
// Provenance — recipient is not submitter
// ===========================================================================
describe("intake provenance", () => {
  it("projects the recipient contact masked, and raw only under capability", () => {
    /*
     * These two columns used to be omitted from the projection entirely. That
     * omission was recorded as a decision, so replacing it is a decision too:
     * the masked form goes to everyone who can read the record, the raw form
     * only to a caller the route said holds the capability.
     */
    const projection = SUMMARY_SERVICE.split("return {")[1] ?? "";
    expect(projection).toContain("recipientLabel: link.recipientLabel");
    expect(projection).toContain("recipientEmailMasked: maskEmail(link.recipientEmail)");
    expect(projection).toContain("maskPhonePreview(link.recipientPhone)");
    // Never unconditionally.
    expect(projection).toContain(
      "recipientEmail: revealRecipientContact ? link.recipientEmail : null",
    );
    expect(projection).toContain(
      "recipientPhone: revealRecipientContact ? link.recipientPhone : null",
    );
    // The masks are the platform's, not a local re-implementation.
    expect(SUMMARY_SERVICE).toContain(
      'import { maskEmail, maskPhonePreview } from "@proovra/shared"',
    );
    // Safe by default: an omitted flag masks.
    expect(SUMMARY_SERVICE).toContain("revealRecipientContact = false,");
  });

  it("decides the reveal with the canonical primitive, never a plan name", () => {
    const handler = EVIDENCE_ROUTES.slice(
      EVIDENCE_ROUTES.indexOf('"/v1/evidence/:id/external-intake-summary"'),
      EVIDENCE_ROUTES.indexOf('"/v1/evidence/:id/reviewer-workflow/events"'),
    );
    expect(handler).toContain("evaluateAuthorize(req, {");
    expect(handler).toContain('permission: "workflow.intake_link.create"');
    expect(handler).toContain("antiEnumeration: true");
    // A personal workspace has no membership to check.
    expect(handler).toContain("let revealRecipientContact = !evidence.teamId;");
    // No plan-name branching anywhere near the decision.
    expect(handler).not.toMatch(/plan\s*===/);
    expect(handler).not.toContain('"PRO"');
  });
  it("never projects the token, the IP hash or the user agent", () => {
    for (const secret of [
      "tokenHash",
      "submitterIpHash",
      "submitterUserAgent",
      "consentSnapshotJson",
    ]) {
      expect(
        SUMMARY_SERVICE.split("return {")[1] ?? "",
        `${secret} must not be projected`,
      ).not.toContain(secret);
    }
  });

  it("labels the delivery address as a destination, never as the submitter", () => {
    expect(CARD).toContain('<Detail label="Intake sent to">');
    expect(CARD).toContain("Not proof of who submitted");
    expect(CARD).toContain('<Detail label="Submitter provided">');
    // The two are built from different sources and never merged.
    const recipient = CARD.slice(
      CARD.indexOf("const recipientAddressed"),
      CARD.indexOf("return ("),
    );
    expect(recipient).not.toContain("session.submitter");
    const submitter = CARD.slice(
      CARD.indexOf("const submitterProvided"),
      CARD.indexOf("const recipientAddressed"),
    );
    expect(submitter).not.toContain("link.recipient");
  });

  it("omits a contact row entirely when nothing was collected", () => {
    // "Phone: unavailable" invites the reader to wonder what failed. The
    // recipient row now also renders for a masked contact with no label, so
    // the condition widened — but it is still a condition, not a placeholder.
    expect(CARD).toContain(
      "{recipientAddressed || recipientContacts.length > 0 ? (",
    );
    expect(CARD).toContain("{submitterProvided ? (");
  });
});

// ===========================================================================
// The save confirmation
// ===========================================================================
describe("the Saved confirmation", () => {
  it("is no longer rendered inside the status heading", () => {
    const heading = CARD.slice(
      CARD.indexOf('data-evidence-reviewer-current-status={currentStatus}'),
      CARD.indexOf("</header>"),
    );
    expect(heading).not.toContain("evd-flash");
    expect(heading).not.toContain("Saved");
  });

  it("sits in a row whose height is reserved in both states", () => {
    expect(CARD).toContain('<div className="evd-saved-slot" aria-live="polite">');
    const css = read("apps/web/app/(app)/evidence/[id]/evidence-detail.css");
    expect(css).toContain(".evd-saved-slot {");
    expect(css).toMatch(/\.evd-saved-slot \{[^}]*min-height/);
    expect(css).toContain(".evd-flash--inline {");
  });

  it("still confirms every save, including a repeated one", () => {
    expect(CARD).toContain("setSavedFlashStatus(decision);");
    expect(CARD).toContain("setSavedFlashStatus(nextStatus);");
  });
});
