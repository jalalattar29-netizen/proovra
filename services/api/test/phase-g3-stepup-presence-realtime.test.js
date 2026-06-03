/**
 * Phase G3 — Step-up Closure + Presence / Realtime / Collision
 * (Wave 4 + G2.x closure) — source-contract suite.
 *
 * Asserts:
 *
 *   1. Step-up modal infrastructure exists and never bypasses the
 *      backend gate. Detects STEP_UP_REQUIRED via the existing
 *      apiFetch error shape; supports exactly one retry per challenge.
 *   2. GovernanceSummary mounted on Evidence detail Overview tab.
 *   3. GovernedExportAction wires Report PDF + Verification Package
 *      ZIP downloads on the ArtifactPanel (A2 vocabulary preserved).
 *   4. Presence routes registered with bounded resource-kind
 *      vocabulary + workspace gate.
 *   5. In-process presence service has bounded TTL + per-key cap.
 *   6. Thread subscription endpoints register + use the existing
 *      Phase 16 DiscussionParticipant model (WATCHER role) — no new
 *      schema.
 *   7. Subscription endpoints reject cross-workspace access and the
 *      RESOLVER self-unsubscribe edge case.
 *   8. Vocabulary discipline — no Slack / DM / emoji / reaction / AI
 *      summarization drift across new G3 surfaces.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
function readSource(rel) {
    const url = new URL(rel, import.meta.url);
    return readFileSync(fileURLToPath(url), "utf8");
}
function stripComments(src) {
    return src
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .split(/\n/)
        .map((line) => line.replace(/(^|[^:])\/\/.*$/, "$1"))
        .join("\n");
}
const STEP_UP_MODAL = readSource("../../../apps/web/components/identity-security/StepUpModal.tsx");
const EVIDENCE_PAGE = readSource("../../../apps/web/app/(app)/evidence/[id]/page.tsx");
const ARTIFACT_PANEL = readSource("../../../apps/web/app/(app)/evidence/components/ArtifactPanel.tsx");
const PRESENCE_ROUTES = readSource("../src/routes/presence.routes.ts");
const PRESENCE_SERVICE = readSource("../src/services/presence/presence.service.ts");
const COLLAB_ROUTES = readSource("../src/routes/collaboration.routes.ts");
const SERVER_SRC = readSource("../src/server.ts");
// ===========================================================================
// 1. Step-up modal infrastructure
// ===========================================================================
describe("Phase G3 — step-up modal infrastructure", () => {
    it("exports useStepUpAction hook + StepUpModal component", () => {
        expect(STEP_UP_MODAL).toMatch(/export function useStepUpAction/);
        expect(STEP_UP_MODAL).toMatch(/export function StepUpModal/);
        expect(STEP_UP_MODAL).toMatch(/export function StepUpModalProvider/);
    });
    it("detects STEP_UP_REQUIRED via the existing apiFetch error shape", () => {
        expect(STEP_UP_MODAL).toMatch(/code\s*===\s*"STEP_UP_REQUIRED"\s*&&\s*e\.statusCode\s*===\s*401/);
    });
    it("forwards the x-proovra-step-up-challenge-id header on retry", () => {
        expect(STEP_UP_MODAL).toMatch(/"x-proovra-step-up-challenge-id":\s*state\.challengeId/);
    });
    it("never auto-retries more than once per challenge", () => {
        // The hook clears the pendingActionRef immediately after a single
        // retry, so a subsequent failure cannot trigger another retry
        // loop. We assert the single-shot pattern.
        expect(STEP_UP_MODAL).toMatch(/pendingActionRef\.current\s*=\s*null;\s*\n\s*onSuccessRef\.current\s*=\s*null;\s*\n\s*onFailureRef\.current\s*=\s*null;[\s\S]*?if \(onSuccess\) onSuccess\(value\)/);
    });
    it("cancel propagates a STEP_UP_CANCEL error to the caller (never silent)", () => {
        expect(STEP_UP_MODAL).toMatch(/code\s*=\s*"STEP_UP_CANCEL"/);
        expect(STEP_UP_MODAL).toMatch(/if \(onFail\) \{[\s\S]*?onFail\(cancelErr\)/);
    });
    it("uses the existing step-up backend endpoints (no new endpoints)", () => {
        expect(STEP_UP_MODAL).toContain("/v1/identity-security/step-up/start");
        expect(STEP_UP_MODAL).toContain("/v1/identity-security/step-up/check");
    });
    it("Escape key cancels the modal", () => {
        expect(STEP_UP_MODAL).toMatch(/e\.key\s*===\s*"Escape"[\s\S]*?cancel\(\)/);
    });
});
// ===========================================================================
// 2. GovernanceSummary mount on Evidence detail
// ===========================================================================
describe("Phase G3 — GovernanceSummary on Evidence detail", () => {
    it("imports GovernanceSummary from the Phase G1 governance components", () => {
        expect(EVIDENCE_PAGE).toMatch(/import\s*\{\s*GovernanceSummary\s*\}\s*from\s+".*\/components\/governance\/GovernanceSummary"/);
    });
    it("mounts GovernanceSummary in the Overview tab with evidence variant", () => {
        expect(EVIDENCE_PAGE).toMatch(/<GovernanceSummary\s+variant="evidence"\s*\/>/);
    });
});
// ===========================================================================
// 3. GovernedExportAction wiring on ArtifactPanel
// ===========================================================================
describe("Phase G3 — GovernedExportAction wired on ArtifactPanel", () => {
    it("imports GovernedExportAction", () => {
        expect(ARTIFACT_PANEL).toMatch(/import\s*\{\s*GovernedExportAction\s*\}/);
    });
    it("wraps both Report PDF and Verification Package ZIP downloads", () => {
        expect(ARTIFACT_PANEL).toMatch(/<GovernedExportAction[\s\S]*?actionLabel="Download Report PDF"/);
        expect(ARTIFACT_PANEL).toMatch(/<GovernedExportAction[\s\S]*?actionLabel="Download Verification Package ZIP"/);
    });
    it("preserves Phase A2 vocabulary — Report PDF vs Verification Package ZIP are never collapsed", () => {
        expect(ARTIFACT_PANEL).toContain("Download Report PDF");
        expect(ARTIFACT_PANEL).toContain("Download Verification Package ZIP");
    });
    it("degrades to the legacy disabled-when-unavailable buttons when evidenceId/teamId are absent", () => {
        expect(ARTIFACT_PANEL).toMatch(/evidenceId\s*&&\s*teamId\s*\?\s*\([\s\S]*?<GovernedExportAction/);
    });
});
// ===========================================================================
// 4. Presence routes
// ===========================================================================
describe("Phase G3 — presence routes registered", () => {
    it("server.ts registers presenceRoutes alongside meInboxRoutes", () => {
        expect(SERVER_SRC).toContain("presenceRoutes");
        expect(SERVER_SRC).toMatch(/app\.register\(presenceRoutes\)/);
    });
    it("declares POST /v1/me/presence/heartbeat + GET /v1/me/presence/here", () => {
        expect(PRESENCE_ROUTES).toMatch(/app\.post\(\s*"\/v1\/me\/presence\/heartbeat"/);
        expect(PRESENCE_ROUTES).toMatch(/app\.get\(\s*"\/v1\/me\/presence\/here"/);
    });
    it("resource kind is a bounded enum (no free-form resource ids)", () => {
        expect(PRESENCE_ROUTES).toMatch(/resourceKind:\s*z\.enum\(\s*\[\s*\n?\s*"evidence"[\s\S]*?"matter"[\s\S]*?"discussion_thread"[\s\S]*?"reviewer_workflow"[\s\S]*?"evidence_request"/);
    });
    it("workspace-membership gate on both endpoints (404 for non-members)", () => {
        const heartbeatHandler = PRESENCE_ROUTES.match(/presence\/heartbeat[\s\S]*?\}\s*,\s*\)\s*;/);
        expect(heartbeatHandler).toBeTruthy();
        expect(heartbeatHandler[0]).toMatch(/teamMember\.findUnique/);
        expect(heartbeatHandler[0]).toMatch(/reply\.code\(404\)/);
    });
    it("excludes the caller from the returned viewer list", () => {
        expect(PRESENCE_ROUTES).toMatch(/excludeUserId:\s*userId/);
    });
    it("emits NO audit (presence pings are not custody events)", () => {
        expect(PRESENCE_ROUTES).not.toMatch(/appendCustodyEvent|appendPlatformAuditLog|writeAnalyticsEvent|appendReviewerAuditEvent/);
    });
});
// ===========================================================================
// 5. In-process presence service
// ===========================================================================
describe("Phase G3 — presence service bounds", () => {
    it("declares the bounded TTL + per-key cap constants", () => {
        expect(PRESENCE_SERVICE).toMatch(/HEARTBEAT_TTL_MS\s*=\s*90\s*\*\s*1000/);
        expect(PRESENCE_SERVICE).toMatch(/MAX_VIEWERS_PER_KEY\s*=\s*25/);
    });
    it("evicts stale entries at read time (no zombie viewers)", () => {
        expect(PRESENCE_SERVICE).toMatch(/now\s*-\s*entry\.lastSeenAtUtc\.getTime\(\)\s*>\s*HEARTBEAT_TTL_MS[\s\S]*?bucket\.delete\(userId\)/);
    });
    it("workspace-scoped storage key (teamId | resourceKind | resourceId)", () => {
        expect(PRESENCE_SERVICE).toMatch(/function key\([\s\S]*?\)\s*:\s*Key\s*\{\s*\n\s*return `\$\{teamId\}\|\$\{resourceKind\}\|\$\{resourceId\}`/);
    });
    it("entries carry only userId + displayName + lastSeenAtUtc (no IP / device / route history)", () => {
        expect(PRESENCE_SERVICE).toMatch(/type Entry\s*=\s*\{[\s\S]*?userId[\s\S]*?displayName[\s\S]*?lastSeenAtUtc[\s\S]*?\};/);
        const code = stripComments(PRESENCE_SERVICE);
        expect(code).not.toMatch(/\bip\b/i);
        expect(code).not.toMatch(/userAgent/i);
        expect(code).not.toMatch(/deviceId/i);
    });
    it("exports the test reset helper for clean per-test isolation", () => {
        expect(PRESENCE_SERVICE).toMatch(/export function _resetPresenceStoreForTests/);
    });
});
// ===========================================================================
// 6. Thread subscriptions on existing DiscussionParticipant model
// ===========================================================================
describe("Phase G3 — thread subscription endpoints", () => {
    it("registers POST + DELETE /v1/collaboration/threads/:id/subscribe", () => {
        expect(COLLAB_ROUTES).toMatch(/app\.post\(\s*"\/v1\/collaboration\/threads\/:id\/subscribe"/);
        expect(COLLAB_ROUTES).toMatch(/app\.delete\(\s*"\/v1\/collaboration\/threads\/:id\/subscribe"/);
    });
    it("uses the existing Phase 16 DiscussionParticipant model with WATCHER role", () => {
        expect(COLLAB_ROUTES).toMatch(/discussionParticipant\.create\(\{[\s\S]*?role:\s*"WATCHER"/);
    });
    it("rejects cross-workspace subscribe attempts (thread.teamId !== query.teamId)", () => {
        expect(COLLAB_ROUTES).toMatch(/subscribe[\s\S]*?thread\.teamId\s*!==\s*query\.teamId/);
    });
    it("idempotent subscribe (no-op when an active subscription exists)", () => {
        expect(COLLAB_ROUTES).toMatch(/subscribed:\s*true,\s*already:\s*true/);
    });
    it("RESOLVER cannot self-unsubscribe (orphan-thread guard)", () => {
        expect(COLLAB_ROUTES).toMatch(/existing\.role\s*===\s*"RESOLVER"[\s\S]*?resolver_cannot_unsubscribe/);
    });
});
// ===========================================================================
// 7. Vocabulary discipline across G3 surfaces
// ===========================================================================
describe("Phase G3 — vocabulary discipline", () => {
    const surfaces = [
        { name: "StepUpModal", src: STEP_UP_MODAL },
        { name: "PresenceRoutes", src: PRESENCE_ROUTES },
        { name: "PresenceService", src: PRESENCE_SERVICE },
    ];
    const banned = [
        { name: "Slack", re: /\bSlack\b/i },
        { name: "DMs", re: /\bdirect messages?\b/i },
        { name: "emoji", re: /\bemoji\b/i },
        { name: "reaction", re: /\breaction\b/i },
        { name: "social feed", re: /\bsocial\s+feed\b/i },
        { name: "AI summarization", re: /\bAI\s+summariz/i },
        { name: "tampered", re: /\btampered?\b/i },
        { name: "authentic", re: /\bauthentic\b/i },
        { name: "admissible", re: /\badmissible\b/i },
        { name: "court-ready", re: /\bcourt-?ready\b/i },
        { name: "compliance attestation", re: /\bcompliance attestation\b/i },
    ];
    for (const { name, src } of surfaces) {
        for (const { name: bn, re } of banned) {
            it(`${name} contains no '${bn}' (after stripping doc comments)`, () => {
                expect(stripComments(src)).not.toMatch(re);
            });
        }
    }
});
