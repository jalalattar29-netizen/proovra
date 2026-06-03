/**
 * Phase 16 — Collaboration API tests.
 *
 *   - Service: error code surface
 *   - Service: projection privacy (resolutionNote / escalationReason
 *     omitted from list projection)
 *   - Route surface: 404 (not 403) on non-members; service accounts
 *     blocked from posting
 *   - Public verify isolation: source-level grep proves no
 *     discussion_* table is read from the public verify route
 *   - Notification template wiring: source-level confirmation that
 *     bodies use the ReviewAssigned context (no body text leakage)
 *
 * No DB — source-text and projection contract tests only.
 */
import { describe, expect, it } from "vitest";
import { DiscussionError, projectDiscussionMessage, projectDiscussionThread, } from "../src/services/collaboration/discussion.service.js";
describe("DiscussionError — stable code surface", () => {
    it("covers every code the route layer maps", () => {
        const codes = [
            "evidence_not_in_workspace",
            "thread_not_found",
            "thread_terminal",
            "invalid_status_transition",
            "body_empty",
            "body_too_long",
            "not_participant",
            "contributor_revoked",
            "internal_only",
            "user_not_found",
            "service_account_forbidden",
        ];
        for (const code of codes) {
            const err = new DiscussionError(code);
            expect(err.code).toBe(code);
            expect(err.message).toBe(code);
        }
    });
});
describe("Thread projection — privacy", () => {
    it("omits resolutionNote + escalationReason from list projection", () => {
        const projected = projectDiscussionThread({
            id: "11111111-1111-4111-8111-111111111111",
            teamId: "22222222-2222-4222-8222-222222222222",
            evidenceId: "33333333-3333-4333-8333-333333333333",
            evidenceRequestId: null,
            kind: "EVIDENCE_GENERAL",
            status: "RESOLVED",
            visibility: "INTERNAL",
            title: "Test thread",
            createdByUserId: "44444444-4444-4444-8444-444444444444",
            assignedToUserId: null,
            assignedAtUtc: null,
            resolvedByUserId: "44444444-4444-4444-8444-444444444444",
            resolvedAtUtc: new Date(),
            resolutionNote: "SHOULD NEVER LEAK",
            reopenedAtUtc: null,
            reopenedByUserId: null,
            reopenCount: 0,
            escalatedAtUtc: null,
            escalatedByUserId: null,
            escalationReason: "ALSO SHOULD NEVER LEAK",
            createdAt: new Date(),
            updatedAt: new Date(),
        });
        const json = JSON.stringify(projected);
        expect(json).not.toContain("SHOULD NEVER LEAK");
        expect(json).not.toContain("ALSO SHOULD NEVER LEAK");
        expect(projected.resolutionNote).toBeUndefined();
        expect(projected.escalationReason).toBeUndefined();
    });
});
describe("Message projection — shape", () => {
    it("includes body text (internal channel) but never raw deleted/edited internals", () => {
        const projected = projectDiscussionMessage({
            id: "11111111-1111-4111-8111-111111111111",
            threadId: "22222222-2222-4222-8222-222222222222",
            teamId: "33333333-3333-4333-8333-333333333333",
            authorKind: "USER",
            authorUserId: "44444444-4444-4444-8444-444444444444",
            contributorIntakeSessionId: null,
            contributorLabel: null,
            body: "Hello team",
            editedAtUtc: null,
            deletedAtUtc: null,
            deletedByUserId: null,
            createdAt: new Date(),
        });
        expect(projected.body).toBe("Hello team");
        expect(projected.deletedByUserId).toBeUndefined();
        expect(projected.contributorIntakeSessionId).toBeUndefined();
    });
});
describe("Collaboration routes — anti-enumeration + service-account block", () => {
    it("never responds 403 for non-members (404 anti-enumeration posture)", async () => {
        const { readFile } = await import("node:fs/promises");
        const { fileURLToPath } = await import("node:url");
        const src = await readFile(fileURLToPath(new URL("../src/routes/collaboration.routes.ts", import.meta.url)), "utf8");
        // requireReviewerMember returns 404 — never 403 — for both
        // "not a member" and "not permitted" branches.
        expect(src).toMatch(/reply\.code\(404\)/);
        // 403 may appear only via discussionErrorToReply for hard service-
        // account / contributor permission errors (the four codes below).
        // It MUST NOT appear directly on the membership guard.
        const membershipGuard = src.match(/requireReviewerMember[\s\S]{0,800}/);
        expect(membershipGuard).not.toBeNull();
        if (membershipGuard) {
            expect(membershipGuard[0]).not.toMatch(/reply\.code\(403\)/);
        }
    });
    it("post-message route uses requireAuth (session) — never requireApiKey", async () => {
        const { readFile } = await import("node:fs/promises");
        const { fileURLToPath } = await import("node:url");
        const src = await readFile(fileURLToPath(new URL("../src/routes/collaboration.routes.ts", import.meta.url)), "utf8");
        // Doc-comment may mention requireApiKey for context, but it must
        // NEVER be invoked as a function call.
        expect(src).not.toMatch(/requireApiKey\(/);
        expect(src).not.toMatch(/preHandler:\s*requireApiKey/);
        expect(src).toMatch(/preHandler:\s*requireAuth/);
    });
});
describe("Public verify isolation — collaboration NOT exposed", () => {
    it("public verify route does not read discussion_* tables", async () => {
        const { readFile } = await import("node:fs/promises");
        const { fileURLToPath } = await import("node:url");
        const src = await readFile(fileURLToPath(new URL("../src/routes/evidence.routes.ts", import.meta.url)), "utf8");
        // Find the public verify route block and assert none of the
        // discussion model accessors appear inside it.
        const start = src.indexOf('app.get("/public/verify/:id"');
        expect(start).toBeGreaterThan(-1);
        const verifyBlock = src.slice(start, start + 8000);
        expect(verifyBlock).not.toMatch(/discussionThread/);
        expect(verifyBlock).not.toMatch(/discussionMessage/);
        expect(verifyBlock).not.toMatch(/discussionMention/);
        expect(verifyBlock).not.toMatch(/discussionParticipant/);
    });
});
describe("Notification templates — collaboration cases use ReviewAssigned context", () => {
    it("five new case branches present + each uses expectCtx(ctx, ReviewAssigned)", async () => {
        const { readFile } = await import("node:fs/promises");
        const { fileURLToPath } = await import("node:url");
        const src = await readFile(fileURLToPath(new URL("../src/services/notifications/templates.ts", import.meta.url)), "utf8");
        for (const evt of [
            "DISCUSSION_MENTION_RECEIVED",
            "DISCUSSION_REPLY_RECEIVED",
            "DISCUSSION_RESOLVED",
            "DISCUSSION_REOPENED",
            "CONTRIBUTOR_REPLY_RECEIVED",
        ]) {
            const re = new RegExp(`case\\s+"${evt}":[\\s\\S]{0,300}expectCtx\\(ctx,\\s*"ReviewAssigned"\\)`);
            expect(src).toMatch(re);
        }
    });
    it("renderReviewVariant body never includes the message text or thread internals", async () => {
        const { readFile } = await import("node:fs/promises");
        const { fileURLToPath } = await import("node:url");
        const src = await readFile(fileURLToPath(new URL("../src/services/notifications/templates.ts", import.meta.url)), "utf8");
        const fn = src.match(/function renderReviewVariant[\s\S]*?\n\}/);
        expect(fn).not.toBeNull();
        if (fn) {
            // The template uses workspaceName + requestTitle only; never
            // references body text or internal notes.
            expect(fn[0]).not.toMatch(/messageBody/);
            expect(fn[0]).not.toMatch(/discussionBody/);
            expect(fn[0]).not.toMatch(/resolutionNote/);
            expect(fn[0]).not.toMatch(/escalationReason/);
        }
    });
});
describe("Discussion service — audit chain reuse", () => {
    it("emits via appendReviewerAuditEvent (Phase 13.5 chain)", async () => {
        const { readFile } = await import("node:fs/promises");
        const { fileURLToPath } = await import("node:url");
        const src = await readFile(fileURLToPath(new URL("../src/services/collaboration/discussion.service.ts", import.meta.url)), "utf8");
        expect(src).toMatch(/appendReviewerAuditEvent/);
        // The known audit event types are recorded.
        for (const ev of [
            "DISCUSSION_THREAD_CREATED",
            "DISCUSSION_MESSAGE_POSTED",
            "DISCUSSION_RESOLVED",
            "DISCUSSION_REOPENED",
            "DISCUSSION_ASSIGNED",
            "DISCUSSION_ESCALATED",
            "MENTION_CREATED",
            "CONTRIBUTOR_REPLY_RECEIVED",
            "CONTRIBUTOR_ACCESS_GRANTED",
            "CONTRIBUTOR_ACCESS_REVOKED",
        ]) {
            expect(src).toMatch(new RegExp(`"${ev}"`));
        }
    });
});
