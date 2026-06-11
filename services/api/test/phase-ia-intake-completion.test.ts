/**
 * Phase IA-intake-completion — source-contract tests for the 5-phase
 * intake-links completion (capability gate, send UI, delivery drawer,
 * inbox surfacing, request-more flow, reject notification).
 */

import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  validateE164,
  canonicalizeE164,
  isCanonicalE164,
} from "../../../apps/web/lib/phone/e164";

function readWeb(rel: string): string {
  return readFileSync(
    fileURLToPath(new URL(`../../../apps/web/${rel}`, import.meta.url)),
    "utf8",
  );
}
function readApi(rel: string): string {
  return readFileSync(
    fileURLToPath(new URL(`../${rel}`, import.meta.url)),
    "utf8",
  );
}

// ============================================================================
// Phase 1 — capability registry + denial copy
// ============================================================================

describe("Phase IA-intake-completion P1 — capability + denial", () => {
  const REG = readApi("src/services/platform-context/capability-registry.ts");

  it("grants INTAKE_LINKS_MANAGE to writer-tier members (not just admins)", () => {
    // Match the isWriter branch block and assert INTAKE_LINKS_MANAGE is
    // inside it. The branch starts with `if (isWriter)` and ends at the
    // matching closing brace; we use the regex with a non-greedy match
    // up to the next `if (isAdmin)`.
    const writerBlock = REG.match(/if \(isWriter\)[\s\S]*?if \(isAdmin\)/)?.[0] ?? "";
    expect(writerBlock).toContain("INTAKE_LINKS_MANAGE");
  });

  it("ADMIN branch still has INTAKE_LINKS_MANAGE (defence in depth)", () => {
    const adminBlock = REG.match(/if \(isAdmin\)[\s\S]*?if \(isOwner\)/)?.[0] ?? "";
    expect(adminBlock).toContain("INTAKE_LINKS_MANAGE");
  });

  it("RouteDefinition supports optional denialGuidance for route-specific copy", () => {
    const REGISTRY = readWeb("lib/navigation/routeRegistry.ts");
    expect(REGISTRY).toMatch(/denialGuidance\?\s*:\s*string/);
  });

  it("workspace.intake_links carries route-specific denial guidance", () => {
    const REGISTRY = readWeb("lib/navigation/routeRegistry.ts");
    // Look for the intake_links definition + a denialGuidance string.
    const block = REGISTRY.match(
      /id:\s*"workspace\.intake_links"[\s\S]{0,2000}\}/,
    )?.[0] ?? "";
    expect(block).toMatch(/denialGuidance:/);
  });

  it("PageRouteGate prefers route.denialGuidance over the canonical fallback", () => {
    const GATE = readWeb("components/navigation/PageRouteGate.tsx");
    expect(GATE).toMatch(/route\.denialGuidance/);
  });
});

// ============================================================================
// Phase 2 — Send UI + E.164 validator
// ============================================================================

describe("Phase IA-intake-completion P2 — Send UI + E.164", () => {
  it("validateE164 accepts canonical international numbers", () => {
    expect(validateE164("+14155550123")).toEqual({
      ok: true,
      canonical: "+14155550123",
    });
    expect(validateE164("+442079460958")).toEqual({
      ok: true,
      canonical: "+442079460958",
    });
  });

  it("validateE164 forgives user formatting and canonicalizes", () => {
    expect(canonicalizeE164("+1 (415) 555-0123")).toBe("+14155550123");
    expect(canonicalizeE164("+44 20 7946 0958")).toBe("+442079460958");
  });

  it("validateE164 rejects numbers without country-code prefix", () => {
    expect(validateE164("415-555-0123")).toEqual({
      ok: false,
      reason: "missing_plus",
    });
    expect(validateE164("4155550123")).toEqual({
      ok: false,
      reason: "missing_plus",
    });
  });

  it("validateE164 rejects too-short or too-long numbers", () => {
    expect(validateE164("+1234")).toEqual({
      ok: false,
      reason: "invalid_length",
    });
    expect(validateE164("+1234567890123456789")).toEqual({
      ok: false,
      reason: "invalid_length",
    });
  });

  it("isCanonicalE164 matches the standard regex shape", () => {
    expect(isCanonicalE164("+14155550123")).toBe(true);
    expect(isCanonicalE164("4155550123")).toBe(false);
    expect(isCanonicalE164("+0123456789")).toBe(false); // first digit can't be 0
  });

  it("intake-links page wires the phone input + Send buttons", () => {
    const PAGE = readWeb("app/(app)/intake-links/page.tsx");
    expect(PAGE).toMatch(/recipientPhone:\s*string\s*\|\s*null/);
    expect(PAGE).toMatch(/data-intake-link-phone/);
    expect(PAGE).toMatch(/data-intake-link-send="SMS"/);
    expect(PAGE).toMatch(/data-intake-link-send="WHATSAPP"/);
    expect(PAGE).toMatch(/data-intake-link-copy/);
  });

  it("intake-links page validates phone via the E.164 helper", () => {
    const PAGE = readWeb("app/(app)/intake-links/page.tsx");
    expect(PAGE).toMatch(/validateE164\(/);
  });

  it("Send action posts to the existing /v1/workflow/intake-links/:id/send endpoint", () => {
    const PAGE = readWeb("app/(app)/intake-links/page.tsx");
    expect(PAGE).toMatch(/\/v1\/workflow\/intake-links\/\$\{encodeURIComponent\(linkId\)\}\/send/);
  });

  it("Send is gated on recipientPhone presence (cannot send without phone)", () => {
    const PAGE = readWeb("app/(app)/intake-links/page.tsx");
    expect(PAGE).toMatch(/canSend = Boolean\(recipientPhone\)/);
  });
});

// ============================================================================
// Phase 3 — Delivery history drawer
// ============================================================================

describe("Phase IA-intake-completion P3 — Delivery history", () => {
  it("/v1/communications/messages accepts the relatedIntakeLinkId filter", () => {
    const ROUTE = readApi("src/routes/communications.routes.ts");
    expect(ROUTE).toMatch(/relatedIntakeLinkId:\s*z\.string\(\)\.uuid\(\)\.optional\(\)/);
    expect(ROUTE).toMatch(/relatedIntakeLinkId:\s*q\.relatedIntakeLinkId/);
  });

  it("IntakeLinkDeliveryDrawer component exists and queries the link-scoped list", () => {
    const drawerPath = fileURLToPath(
      new URL(
        "../../../apps/web/components/intake-links/IntakeLinkDeliveryDrawer.tsx",
        import.meta.url,
      ),
    );
    expect(existsSync(drawerPath)).toBe(true);
    const SRC = readFileSync(drawerPath, "utf8");
    expect(SRC).toMatch(/relatedIntakeLinkId=\$\{encodeURIComponent\(linkId\)\}/);
    expect(SRC).toMatch(/data-delivery-row/);
    expect(SRC).toMatch(/data-delivery-status/);
  });

  it("drawer exposes Retry action for FAILED / RETRY_SCHEDULED rows", () => {
    const drawerPath = fileURLToPath(
      new URL(
        "../../../apps/web/components/intake-links/IntakeLinkDeliveryDrawer.tsx",
        import.meta.url,
      ),
    );
    const SRC = readFileSync(drawerPath, "utf8");
    expect(SRC).toMatch(/data-delivery-retry/);
    expect(SRC).toMatch(/\/v1\/communications\/messages\//);
    expect(SRC).toMatch(/\/retry/);
  });

  it("intake-links page opens the drawer per row", () => {
    const PAGE = readWeb("app/(app)/intake-links/page.tsx");
    expect(PAGE).toMatch(/data-intake-link-delivery=\{l\.id\}/);
    expect(PAGE).toMatch(/<IntakeLinkDeliveryDrawer/);
  });
});

// ============================================================================
// Phase 4 — Submission inbox category surfaces in /inbox
// ============================================================================

describe("Phase IA-intake-completion P4 — Inbox surfacing", () => {
  it("backend emits intake_submission_pending_review inbox items", () => {
    const ROUTE = readApi("src/routes/me-inbox.routes.ts");
    expect(ROUTE).toMatch(/category:\s*"intake_submission_pending_review"/);
  });

  it("inbox UI labels the intake-review category in plain language", () => {
    const INBOX = readWeb("app/(app)/inbox/page.tsx");
    expect(INBOX).toMatch(/intake_submission_pending_review:\s*"Intake review"/);
    expect(INBOX).toMatch(/intake_submission_pending_review:\s*"Intake awaiting review"/);
  });

  it("intake_submission deep-links to /evidence-requests/[id] (the review surface)", () => {
    const ROUTE = readApi("src/routes/me-inbox.routes.ts");
    expect(ROUTE).toMatch(
      /href:\s*`\/evidence-requests\/\$\{encodeURIComponent\(r\.id\)\}`/,
    );
  });

  it("/evidence-requests/[id] surface is gated by INTAKE_LINKS_MANAGE (matches /intake-links)", () => {
    const REGISTRY = readWeb("lib/navigation/routeRegistry.ts");
    // The detail page registers under workspace.evidence_requests.
    const block = REGISTRY.match(
      /id:\s*"workspace\.evidence_requests"[\s\S]{0,1500}\}/,
    )?.[0] ?? "";
    expect(block).toMatch(/requiredCapabilities:\s*\[\s*"INTAKE_LINKS_MANAGE"\s*\]/);
  });
});

// ============================================================================
// Phase 5 — Request-more (new link) + notify-on-reject + evidence link
// ============================================================================

describe("Phase IA-intake-completion P5 — Request more + notify + evidence link", () => {
  it("review endpoint accepts notifyContributor + notifyChannel", () => {
    const ROUTE = readApi("src/routes/evidence-requests.routes.ts");
    expect(ROUTE).toMatch(/notifyContributor:\s*z\.boolean\(\)\.optional\(\)/);
    expect(ROUTE).toMatch(/notifyChannel:\s*z\.enum\(\["SMS",\s*"WHATSAPP"\]\)/);
  });

  it("review service notifies contributor when REJECTED and phone present", () => {
    const SVC = readApi("src/services/evidence-request.service.ts");
    expect(SVC).toMatch(/notifyContributorOfReview/);
    expect(SVC).toMatch(/status === "REJECTED"/);
    expect(SVC).toMatch(/enqueueOutboundMessage/);
    // Notification fires AFTER tx commits — failure does not roll back
    // the reviewer decision.
    expect(SVC).toMatch(
      /Notification fires AFTER the transaction commits/,
    );
  });

  it("new POST /v1/evidence-requests/:id/responses/:responseId/request-more endpoint exists", () => {
    const ROUTE = readApi("src/routes/evidence-requests.routes.ts");
    expect(ROUTE).toMatch(
      /\/v1\/evidence-requests\/:id\/responses\/:responseId\/request-more/,
    );
    expect(ROUTE).toMatch(/requestMoreEvidenceForResponse/);
  });

  it("request-more service creates a fresh intake link in the same thread", () => {
    const SVC = readApi("src/services/evidence-request.service.ts");
    expect(SVC).toMatch(/export async function requestMoreEvidenceForResponse/);
    // Reuses createWorkflowIntakeLink so token/HMAC/security model is
    // identical to the initial create.
    expect(SVC).toMatch(
      /createWorkflowIntakeLink\([\s\S]{0,1500}workflowTemplateSlug:[\s\S]{0,200}request\.workflowTemplateSlug/,
    );
    // The response is transitioned to NEEDS_MORE_INFO atomically + an
    // audit event is appended naming the new link.
    expect(SVC).toMatch(/status:\s*"NEEDS_MORE_INFO"/);
    expect(SVC).toMatch(/followUpIntakeLinkId:\s*created\.link\.id/);
  });

  it("request-more service optionally enqueues SMS/WhatsApp to the contributor", () => {
    const SVC = readApi("src/services/evidence-request.service.ts");
    // The notification branch reads the recipientPhone from the
    // original request and queues a CommunicationMessage with the
    // freshly issued intakeUrl.
    expect(SVC).toMatch(
      /if \(input\.notifyContributor && request\.recipientPhone\)/,
    );
    expect(SVC).toMatch(/enqueueOutboundMessage\(/);
  });

  it("response returns the new rawToken (one-shot reveal preserved)", () => {
    const ROUTE = readApi("src/routes/evidence-requests.routes.ts");
    expect(ROUTE).toMatch(/rawToken:\s*result\.newRawToken/);
  });

  it("frontend evidence-request page calls /request-more and shows a reveal modal", () => {
    const PAGE = readWeb("app/(app)/evidence-requests/[id]/page.tsx");
    expect(PAGE).toMatch(/\/responses\/\$\{encodeURIComponent\(responseId\)\}\/request-more/);
    expect(PAGE).toMatch(/data-request-more-reveal/);
    expect(PAGE).toMatch(/data-request-more-reveal-url/);
  });

  it("frontend Reject flow asks before notifying the contributor", () => {
    const PAGE = readWeb("app/(app)/evidence-requests/[id]/page.tsx");
    // Confirm modal title + the notifyContributor flag.
    expect(PAGE).toMatch(/Notify the contributor\?/);
    expect(PAGE).toMatch(/notifyContributor/);
  });

  it("Accepted submission already exposes a link to the new Evidence", () => {
    const PAGE = readWeb("app/(app)/evidence-requests/[id]/page.tsx");
    // The existing UI shows "Open evidence" when responseEvidenceId is
    // present — capture-sourced and intake-sourced evidence both flow
    // through completeEvidence() so this link is meaningful.
    expect(PAGE).toMatch(
      /href=\{`\/evidence\/\$\{encodeURIComponent\(r\.responseEvidenceId\)\}`\}/,
    );
  });

  it("review endpoint accepts status (not the older `decision` field) — contract bug pin", () => {
    const PAGE = readWeb("app/(app)/evidence-requests/[id]/page.tsx");
    // The body must send `status` to match the backend zod schema.
    expect(PAGE).toMatch(/JSON\.stringify\(\{\s*status,/);
    // The older bug shape sent `decision` — must not regress.
    expect(PAGE).not.toMatch(/JSON\.stringify\(\{\s*decision,/);
  });
});

// ============================================================================
// Cross-phase invariants
// ============================================================================

describe("Phase IA-intake-completion — cross-phase invariants", () => {
  it("no new top-level API endpoint families were added (intake reuses existing routes)", () => {
    const SERVER = readApi("src/server.ts");
    // We don't register a brand-new "intake-completion.routes.ts". The
    // work piggybacks on existing routers.
    expect(SERVER).not.toMatch(/intake-completion\.routes/);
  });

  it("token semantics unchanged: send still requires rawToken + intakeUrl in body", () => {
    const ROUTE = readApi("src/routes/workflow-intake-links.routes.ts");
    expect(ROUTE).toMatch(/rawToken:\s*z\.string\(\)\.min\(8\)\.max\(512\)/);
    expect(ROUTE).toMatch(/intakeUrl:\s*z\.string\(\)\.url\(\)\.max\(1000\)/);
  });

  it("evidence-complete path unchanged for intake-sourced evidence", () => {
    const ORCH = readApi("src/services/external-intake-orchestration.service.ts");
    // completeEvidence call is the only finalize path for both
    // capture and intake — the audit pinned this and Phase 5 must NOT
    // diverge.
    expect(ORCH).toMatch(/completeEvidence\(/);
  });
});
