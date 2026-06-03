/**
 * PHASE 37.95 — Behavioral proof of canonical tenant access helpers.
 *
 * The Phase TENANT-ISOLATION + SCALE source-contract suite proved that
 * routes wire up the helpers. This file proves the *helpers themselves*
 * reject cross-tenant access at runtime, using mocked Prisma + a mocked
 * authorize middleware.
 *
 * Hard contract under test:
 *   1. If the resource doesn't exist, the helper sends 404 not_found and
 *      returns null. Existence is never leaked.
 *   2. If the resource exists but the actor is not an ACTIVE member of
 *      its team, the helper sends 404 (anti-enumeration) and returns null.
 *   3. If the actor IS a member, the helper returns the canonical grant
 *      with actorUserId + teamId resolved server-side (NOT the client's
 *      claim).
 *   4. The DB-resolved teamId is the one authorize is called with. The
 *      client cannot cause the helper to authorize against a different
 *      team.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
// Mock Prisma BEFORE importing the helpers. The mock provides per-test
// hook points for evidence / case / report / verificationPackage lookups.
const mockPrisma = {
    evidence: { findUnique: vi.fn() },
    case: { findUnique: vi.fn() },
    report: { findUnique: vi.fn() },
    verificationPackage: { findUnique: vi.fn() },
};
vi.mock("../src/db.js", () => ({ prisma: mockPrisma }));
// Mock the authorize middleware. It accepts an `AuthorizeOptions` object
// and a (req, reply) and returns the canonical outcome shape.
const authorizeOrFailMock = vi.fn();
vi.mock("../src/middleware/authorize.js", () => ({
    authorizeOrFail: authorizeOrFailMock,
}));
// Now import the helpers (mocks are bound).
const { requireEvidenceAccess, requireCaseAccess, requireReportAccess, requirePackageAccess, requireActiveSpaceAccess, } = await import("../src/services/access/tenant-access.helpers.js");
function makeReply() {
    const rec = {
        statusCode: null,
        payload: null,
        code(code) {
            this.statusCode = code;
            return this;
        },
        send(payload) {
            this.payload = payload;
            return this;
        },
    };
    return rec;
}
function makeReq() {
    // The helpers only forward `req` to authorizeOrFail (mocked); a bare
    // object is sufficient.
    return { user: { id: "userA" } };
}
beforeEach(() => {
    mockPrisma.evidence.findUnique.mockReset();
    mockPrisma.case.findUnique.mockReset();
    mockPrisma.report.findUnique.mockReset();
    mockPrisma.verificationPackage.findUnique.mockReset();
    authorizeOrFailMock.mockReset();
});
// =============================================================================
// Cross-tenant rejection — the headline behavior
// =============================================================================
describe("Phase 37.95 — requireEvidenceAccess cross-tenant rejection", () => {
    it("returns 404 + null when the evidence does not exist (no existence leak)", async () => {
        mockPrisma.evidence.findUnique.mockResolvedValueOnce(null);
        const reply = makeReply();
        const grant = await requireEvidenceAccess(makeReq(), reply, { evidenceId: "missing", permission: "evidence.read" });
        expect(grant).toBeNull();
        expect(reply.statusCode).toBe(404);
        expect(reply.payload).toEqual({ error: { code: "not_found" } });
        // authorize was never called — the helper short-circuited.
        expect(authorizeOrFailMock).not.toHaveBeenCalled();
    });
    it("calls authorize with the DB-resolved teamId, NOT a client-provided one", async () => {
        // Evidence belongs to teamB. The helper must call authorize against
        // teamB regardless of any other input.
        mockPrisma.evidence.findUnique.mockResolvedValueOnce({ teamId: "teamB" });
        authorizeOrFailMock.mockResolvedValueOnce({
            actorUserId: "userA",
            teamId: "teamB",
        });
        const reply = makeReply();
        await requireEvidenceAccess(makeReq(), reply, {
            evidenceId: "evidenceB-1",
            permission: "evidence.read",
        });
        const call = authorizeOrFailMock.mock.calls[0];
        expect(call[2].teamId).toBe("teamB");
        expect(call[2].permission).toBe("evidence.read");
        expect(call[2].antiEnumeration).toBe(true);
    });
    it("returns null when authorize denies (cross-tenant userA → evidenceB)", async () => {
        // Evidence belongs to teamB; userA is not a member of teamB.
        mockPrisma.evidence.findUnique.mockResolvedValueOnce({ teamId: "teamB" });
        // authorizeOrFail returns null on deny (response already sent inside).
        authorizeOrFailMock.mockResolvedValueOnce(null);
        const reply = makeReply();
        const grant = await requireEvidenceAccess(makeReq(), reply, { evidenceId: "evidenceB-1", permission: "evidence.read" });
        expect(grant).toBeNull();
    });
    it("returns the canonical grant when authorize allows (same-tenant userA → evidenceA)", async () => {
        mockPrisma.evidence.findUnique.mockResolvedValueOnce({ teamId: "teamA" });
        authorizeOrFailMock.mockResolvedValueOnce({
            actorUserId: "userA",
            teamId: "teamA",
        });
        const grant = await requireEvidenceAccess(makeReq(), makeReply(), { evidenceId: "evidenceA-1", permission: "evidence.read" });
        expect(grant).toEqual({
            actorUserId: "userA",
            teamId: "teamA",
            resourceId: "evidenceA-1",
        });
    });
    it("anti-enumeration: even if userA passes the wrong teamId in args, the helper resolves from the DB", async () => {
        // The helper signature only accepts evidenceId — teamId is not even
        // a parameter the client can influence here. We assert the call site
        // does not pass any client teamId to authorize.
        mockPrisma.evidence.findUnique.mockResolvedValueOnce({ teamId: "teamB" });
        authorizeOrFailMock.mockResolvedValueOnce(null);
        await requireEvidenceAccess(makeReq(), makeReply(), {
            evidenceId: "evidenceB-1",
            permission: "evidence.read",
        });
        const call = authorizeOrFailMock.mock.calls[0];
        // The teamId passed to authorize is exactly what the DB returned.
        expect(call[2].teamId).toBe("teamB");
    });
});
// =============================================================================
// Case / Report / Package — same contract, different table
// =============================================================================
describe("Phase 37.95 — requireCaseAccess cross-tenant rejection", () => {
    it("404s on missing case", async () => {
        mockPrisma.case.findUnique.mockResolvedValueOnce(null);
        const reply = makeReply();
        const grant = await requireCaseAccess(makeReq(), reply, {
            caseId: "missing",
            permission: "evidence.read",
        });
        expect(grant).toBeNull();
        expect(reply.statusCode).toBe(404);
    });
    it("authorizes against the DB-resolved teamId", async () => {
        mockPrisma.case.findUnique.mockResolvedValueOnce({ teamId: "teamA" });
        authorizeOrFailMock.mockResolvedValueOnce({
            actorUserId: "userA",
            teamId: "teamA",
        });
        await requireCaseAccess(makeReq(), makeReply(), {
            caseId: "caseA-1",
            permission: "evidence.read",
        });
        expect(authorizeOrFailMock.mock.calls[0][2].teamId).toBe("teamA");
    });
    it("denies cross-tenant userA → caseB", async () => {
        mockPrisma.case.findUnique.mockResolvedValueOnce({ teamId: "teamB" });
        authorizeOrFailMock.mockResolvedValueOnce(null);
        const grant = await requireCaseAccess(makeReq(), makeReply(), { caseId: "caseB-1", permission: "evidence.read" });
        expect(grant).toBeNull();
    });
});
describe("Phase 37.95 — requireReportAccess resolves via parent evidence", () => {
    it("404s when the report row does not exist", async () => {
        mockPrisma.report.findUnique.mockResolvedValueOnce(null);
        const reply = makeReply();
        const grant = await requireReportAccess(makeReq(), reply, { reportId: "missing", permission: "evidence.read" });
        expect(grant).toBeNull();
        expect(reply.statusCode).toBe(404);
    });
    it("404s when the report has no parent evidence (orphan)", async () => {
        mockPrisma.report.findUnique.mockResolvedValueOnce({ evidence: null });
        const reply = makeReply();
        const grant = await requireReportAccess(makeReq(), reply, { reportId: "orphan", permission: "evidence.read" });
        expect(grant).toBeNull();
        expect(reply.statusCode).toBe(404);
    });
    it("authorizes against the parent evidence's teamId", async () => {
        mockPrisma.report.findUnique.mockResolvedValueOnce({
            evidence: { teamId: "teamB" },
        });
        authorizeOrFailMock.mockResolvedValueOnce({
            actorUserId: "userA",
            teamId: "teamB",
        });
        await requireReportAccess(makeReq(), makeReply(), {
            reportId: "reportB-1",
            permission: "evidence.read",
        });
        expect(authorizeOrFailMock.mock.calls[0][2].teamId).toBe("teamB");
    });
});
describe("Phase 37.95 — requirePackageAccess resolves via parent evidence", () => {
    it("404s when the package does not exist", async () => {
        mockPrisma.verificationPackage.findUnique.mockResolvedValueOnce(null);
        const reply = makeReply();
        const grant = await requirePackageAccess(makeReq(), reply, { packageId: "missing", permission: "evidence.read" });
        expect(grant).toBeNull();
        expect(reply.statusCode).toBe(404);
    });
    it("authorizes against the parent evidence's teamId, never the package id alone", async () => {
        mockPrisma.verificationPackage.findUnique.mockResolvedValueOnce({
            evidence: { teamId: "teamA" },
        });
        authorizeOrFailMock.mockResolvedValueOnce({
            actorUserId: "userA",
            teamId: "teamA",
        });
        await requirePackageAccess(makeReq(), makeReply(), {
            packageId: "packageA-1",
            permission: "evidence.read",
        });
        expect(authorizeOrFailMock.mock.calls[0][2].teamId).toBe("teamA");
        expect(authorizeOrFailMock.mock.calls[0][2].resourceKind).toBe("verificationPackage");
    });
});
describe("Phase 37.95 — requireActiveSpaceAccess (team membership only)", () => {
    it("forwards the caller-supplied teamId to authorize (no resource lookup)", async () => {
        authorizeOrFailMock.mockResolvedValueOnce({
            actorUserId: "userA",
            teamId: "teamA",
        });
        const grant = await requireActiveSpaceAccess(makeReq(), makeReply(), { teamId: "teamA", permission: "evidence.read" });
        expect(grant).toEqual({
            actorUserId: "userA",
            teamId: "teamA",
            resourceId: "teamA",
        });
        expect(authorizeOrFailMock.mock.calls[0][2].antiEnumeration).toBe(true);
    });
    it("returns null when authorize denies (cross-tenant userA → teamB)", async () => {
        authorizeOrFailMock.mockResolvedValueOnce(null);
        const grant = await requireActiveSpaceAccess(makeReq(), makeReply(), { teamId: "teamB", permission: "evidence.read" });
        expect(grant).toBeNull();
    });
});
// =============================================================================
// Anti-enumeration: the response code on deny is 404, not 403
// =============================================================================
describe("Phase 37.95 — anti-enumeration on every helper", () => {
    it("every helper calls authorize with antiEnumeration: true", async () => {
        mockPrisma.evidence.findUnique.mockResolvedValueOnce({ teamId: "teamA" });
        mockPrisma.case.findUnique.mockResolvedValueOnce({ teamId: "teamA" });
        mockPrisma.report.findUnique.mockResolvedValueOnce({
            evidence: { teamId: "teamA" },
        });
        mockPrisma.verificationPackage.findUnique.mockResolvedValueOnce({
            evidence: { teamId: "teamA" },
        });
        authorizeOrFailMock.mockResolvedValue({
            actorUserId: "userA",
            teamId: "teamA",
        });
        await requireEvidenceAccess(makeReq(), makeReply(), {
            evidenceId: "x",
            permission: "evidence.read",
        });
        await requireCaseAccess(makeReq(), makeReply(), {
            caseId: "x",
            permission: "evidence.read",
        });
        await requireReportAccess(makeReq(), makeReply(), {
            reportId: "x",
            permission: "evidence.read",
        });
        await requirePackageAccess(makeReq(), makeReply(), {
            packageId: "x",
            permission: "evidence.read",
        });
        await requireActiveSpaceAccess(makeReq(), makeReply(), {
            teamId: "teamA",
            permission: "evidence.read",
        });
        for (const call of authorizeOrFailMock.mock.calls) {
            expect(call[2].antiEnumeration).toBe(true);
        }
    });
});
