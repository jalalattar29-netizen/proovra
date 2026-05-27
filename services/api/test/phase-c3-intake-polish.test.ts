/**
 * Phase C3 — Intake Polish (source-contract suite).
 *
 * Asserts:
 *
 *  1. The public intake projection now surfaces per-deliverable
 *     `status`, `fulfilledCount`, `captureAfterRequest`, plus a
 *     deterministic completion summary + request-level `status`.
 *  2. `GET /v1/cases/:id/evidence-requests` aggregator returns
 *     bounded per-request completion summaries with workspace
 *     isolation.
 *  3. The /intake/[token] page surfaces the C3 components
 *     (IntakeChecklist + IntakeCompletionProgress + IntakeReReviewBanner)
 *     and renders operational empty/degraded states.
 *  4. The IntakeChecklist component disambiguates required vs
 *     optional and surfaces count requirements, accepted kinds,
 *     and capture-fresh guidance.
 *  5. The IntakeCompletionProgress component is deterministic — it
 *     never invents percentages.
 *  6. The IntakeReReviewBanner appears when status = NEEDS_MORE_INFO
 *     and points at the deliverables still blocking.
 *  7. The /evidence-requests/[id] reviewer inspector renders the
 *     authenticated projection, exposes mark-needs-more-info / waive
 *     / review-response affordances that route through the existing
 *     audited backend endpoints, and never bypasses audit.
 *  8. The Matter Workspace Evidence tab surfaces the evidence-request
 *     aggregator above the linked-evidence table and preserves the
 *     Phase C1 EmptyState contract.
 *  9. Vocabulary discipline — no overclaim, no chat/social drift, no
 *     "Slack-replacement" language across C3 surfaces.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

function readSource(rel: string): string {
  const url = new URL(rel, import.meta.url);
  return readFileSync(fileURLToPath(url), "utf8");
}

function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split(/\n/)
    .map((line) => line.replace(/(^|[^:])\/\/.*$/, "$1"))
    .join("\n");
}

const EVIDENCE_REQUEST_SVC = readSource(
  "../src/services/evidence-request.service.ts",
);
const CASE_ROUTES = readSource("../src/routes/case-workspace.routes.ts");
const INTAKE_PAGE = readSource(
  "../../../apps/web/app/intake/[token]/page.tsx",
);
const INTAKE_CHECKLIST = readSource(
  "../../../apps/web/components/intake/IntakeChecklist.tsx",
);
const INTAKE_PROGRESS = readSource(
  "../../../apps/web/components/intake/IntakeCompletionProgress.tsx",
);
const INTAKE_RERE = readSource(
  "../../../apps/web/components/intake/IntakeReReviewBanner.tsx",
);
const REQUEST_INSPECTOR = readSource(
  "../../../apps/web/app/(app)/evidence-requests/[id]/page.tsx",
);
const MATTER_UI = readSource(
  "../../../apps/web/components/cases-experience/MatterWorkspace.tsx",
);

// ===========================================================================
// 1. Public projection extension
// ===========================================================================

describe("Phase C3 — public intake projection extension", () => {
  it("ExternalRequestPublicView declares the new request-level status field", () => {
    expect(EVIDENCE_REQUEST_SVC).toMatch(
      /export type ExternalRequestPublicView[\s\S]*?status:\s*string/,
    );
  });

  it("ExternalRequestPublicView declares the deterministic completion summary", () => {
    expect(EVIDENCE_REQUEST_SVC).toMatch(
      /completion:\s*\{[\s\S]*?requiredTotal[\s\S]*?requiredFulfilled[\s\S]*?optionalTotal[\s\S]*?optionalFulfilled[\s\S]*?completionPercent[\s\S]*?reviewReady[\s\S]*?needsMoreInfo/,
    );
  });

  it("Deliverable projection surfaces fulfilledCount + captureAfterRequest", () => {
    expect(EVIDENCE_REQUEST_SVC).toMatch(
      /deliverables:\s*Array<[\s\S]*?fulfilledCount:\s*number/,
    );
    expect(EVIDENCE_REQUEST_SVC).toMatch(
      /deliverables:\s*Array<[\s\S]*?captureAfterRequest:\s*boolean/,
    );
  });

  it("projectRequestForExternalView computes the completion summary deterministically", () => {
    expect(EVIDENCE_REQUEST_SVC).toMatch(
      /const\s+isSatisfied\s*=\s*\(status:\s*string\)\s*=>[\s\S]*?"FULFILLED"[\s\S]*?"WAIVED"/,
    );
    expect(EVIDENCE_REQUEST_SVC).toMatch(
      /const\s+completionPercent\s*=[\s\S]*?Math\.round\(\(allSatisfied\s*\/\s*allItems\)\s*\*\s*100\)/,
    );
    expect(EVIDENCE_REQUEST_SVC).toMatch(
      /const\s+reviewReady\s*=[\s\S]*?requiredFulfilled\s*===\s*requiredItems\.length/,
    );
  });

  it("review readiness never silently flips on optional-only requests", () => {
    expect(EVIDENCE_REQUEST_SVC).toMatch(
      /requiredItems\.length\s*===\s*0\s*\|\|\s*requiredFulfilled\s*===\s*requiredItems\.length/,
    );
  });
});

// ===========================================================================
// 2. Matter-level evidence-request aggregator
// ===========================================================================

describe("Phase C3 — GET /v1/cases/:id/evidence-requests aggregator", () => {
  it("registers the endpoint behind requireAuth + requireCaseAccess", () => {
    expect(CASE_ROUTES).toContain('"/v1/cases/:id/evidence-requests"');
    const handler = CASE_ROUTES.match(
      /evidence-requests[\s\S]*?\}\s*,\s*\)\s*;/,
    );
    expect(handler).toBeTruthy();
    expect(handler![0]).toContain("requireCaseAccess");
  });

  it("scope-binds the query to the case's teamId AND caseId", () => {
    expect(CASE_ROUTES).toMatch(
      /prisma\.evidenceRequest\.findMany\(\{[\s\S]*?teamId:\s*caseRow\.teamId[\s\S]*?caseId:\s*params\.id/,
    );
  });

  it("returns per-request completion summary + bounded status counts", () => {
    // The aggregator computes `completionPercent` from `total === 0
    // ? 0 : Math.round((satisfied / total) * 100)` and emits it as
    // part of the per-request `completion` object.
    expect(CASE_ROUTES).toMatch(
      /completionPercent\s*=[\s\S]*?Math\.round\(\(satisfied\s*\/\s*total\)\s*\*\s*100\)/,
    );
    expect(CASE_ROUTES).toMatch(/reviewReady\s*=[\s\S]*?required\.length\s*===\s*0/);
    expect(CASE_ROUTES).toMatch(/needsMoreInfo:\s*r\.status\s*===\s*"NEEDS_MORE_INFO"/);
  });

  it("is bounded (≤ 50 requests per response)", () => {
    expect(CASE_ROUTES).toMatch(/evidence-requests[\s\S]*?take:\s*50/);
  });

  it("emits no audit on read (browsing is not an auditable action)", () => {
    const handler = CASE_ROUTES.match(
      /evidence-requests[\s\S]*?\}\s*,\s*\)\s*;/,
    );
    expect(handler).toBeTruthy();
    expect(handler![0]).not.toMatch(/appendCustodyEvent|appendPlatformAuditLog|writeAnalyticsEvent|appendReviewerAuditEvent/);
  });
});

// ===========================================================================
// 3. Intake page integration
// ===========================================================================

describe("Phase C3 — /intake/[token] page surfaces the C3 components", () => {
  it("imports the three new components", () => {
    expect(INTAKE_PAGE).toMatch(
      /import\s*\{?\s*IntakeChecklist\s*\}?\s*from\s+"\.\.\/\.\.\/\.\.\/components\/intake\/IntakeChecklist"/,
    );
    expect(INTAKE_PAGE).toMatch(
      /import\s*\{[\s\S]*?IntakeCompletionProgress[\s\S]*?\}\s*from\s+"\.\.\/\.\.\/\.\.\/components\/intake\/IntakeCompletionProgress"/,
    );
    expect(INTAKE_PAGE).toMatch(
      /import\s*\{?\s*IntakeReReviewBanner\s*\}?\s*from\s+"\.\.\/\.\.\/\.\.\/components\/intake\/IntakeReReviewBanner"/,
    );
  });

  it("renders the re-request banner when request.completion.needsMoreInfo", () => {
    expect(INTAKE_PAGE).toMatch(
      /request\.completion\.needsMoreInfo[\s\S]*?<IntakeReReviewBanner/,
    );
  });

  it("renders the completion progress driven by request.completion", () => {
    expect(INTAKE_PAGE).toMatch(
      /<IntakeCompletionProgress\s+completion=\{request\.completion\}/,
    );
  });

  it("renders the checklist driven by request.deliverables", () => {
    expect(INTAKE_PAGE).toMatch(
      /<IntakeChecklist\s+deliverables=\{request\.deliverables\}/,
    );
  });

  it("RequestView type now carries status + completion + deliverable fulfilledCount", () => {
    expect(INTAKE_PAGE).toMatch(/type RequestView[\s\S]*?status:\s*string/);
    expect(INTAKE_PAGE).toMatch(/type RequestView[\s\S]*?completion:\s*IntakeCompletion/);
    expect(INTAKE_PAGE).toMatch(/type RequestView[\s\S]*?fulfilledCount:\s*number/);
  });

  it("error page surfaces operationally meaningful next-step copy per error class", () => {
    expect(INTAKE_PAGE).toContain("data-intake-error-class");
    expect(INTAKE_PAGE).toMatch(/expired-or-revoked|invalid|feature-disabled|rate-limited/);
  });
});

// ===========================================================================
// 4. IntakeChecklist component
// ===========================================================================

describe("Phase C3 — IntakeChecklist component", () => {
  it("renders an explicit Required vs Optional chip per deliverable", () => {
    expect(INTAKE_CHECKLIST).toContain("data-intake-required-chip");
    expect(INTAKE_CHECKLIST).toContain("data-intake-optional-chip");
  });

  it("renders count requirement, accepted kinds, and location requirement metadata", () => {
    expect(INTAKE_CHECKLIST).toContain("data-intake-count-requirement");
    expect(INTAKE_CHECKLIST).toContain("data-intake-accepted-kinds");
    expect(INTAKE_CHECKLIST).toContain("data-intake-location-required");
  });

  it("renders capture-fresh hint when captureAfterRequest is true", () => {
    expect(INTAKE_CHECKLIST).toContain("data-intake-capture-hint");
    expect(INTAKE_CHECKLIST).toMatch(/captureAfterRequest/);
  });

  it("renders an operational empty state when no deliverables exist", () => {
    expect(INTAKE_CHECKLIST).toContain("data-intake-checklist-empty");
  });

  it("status chips include FULFILLED / PENDING / PARTIALLY_FULFILLED / WAIVED / REJECTED", () => {
    expect(INTAKE_CHECKLIST).toMatch(/PENDING:/);
    expect(INTAKE_CHECKLIST).toMatch(/PARTIALLY_FULFILLED:/);
    expect(INTAKE_CHECKLIST).toMatch(/FULFILLED:/);
    expect(INTAKE_CHECKLIST).toMatch(/WAIVED:/);
    expect(INTAKE_CHECKLIST).toMatch(/REJECTED:/);
  });
});

// ===========================================================================
// 5. IntakeCompletionProgress component
// ===========================================================================

describe("Phase C3 — IntakeCompletionProgress component", () => {
  it("renders the backend-provided percent without recomputing it", () => {
    expect(INTAKE_PROGRESS).toMatch(
      /Math\.max\(0,\s*Math\.min\(100,\s*completion\.completionPercent\)\)/,
    );
  });

  it("renders Review-ready chip ONLY when completion.reviewReady is true", () => {
    expect(INTAKE_PROGRESS).toMatch(
      /completion\.reviewReady\s*\?[\s\S]*?Review-ready[\s\S]*?:[\s\S]*?Required items remaining/,
    );
  });

  it("exposes required vs optional counts separately", () => {
    expect(INTAKE_PROGRESS).toContain("data-intake-required-counts");
    expect(INTAKE_PROGRESS).toContain("data-intake-optional-counts");
  });
});

// ===========================================================================
// 6. IntakeReReviewBanner component
// ===========================================================================

describe("Phase C3 — IntakeReReviewBanner component", () => {
  it("only surfaces the blocking required deliverables (status in PENDING/PARTIALLY_FULFILLED/REJECTED)", () => {
    expect(INTAKE_RERE).toMatch(
      /status\s*===\s*"PENDING"[\s\S]*?status\s*===\s*"PARTIALLY_FULFILLED"[\s\S]*?status\s*===\s*"REJECTED"/,
    );
  });

  it("never leaks reviewer notes — only operational deliverable titles", () => {
    // The component must not read or render a `reviewerNote` field
    // — the public projection deliberately omits it. We check after
    // stripping comments so doc references to the omitted field do
    // not register as a leak.
    expect(stripComments(INTAKE_RERE)).not.toMatch(/reviewerNote/);
  });

  it("renders a bounded list (max 10 blocking items)", () => {
    expect(INTAKE_RERE).toMatch(/requiredBlocking\.slice\(0,\s*10\)/);
  });
});

// ===========================================================================
// 7. Reviewer inspector
// ===========================================================================

describe("Phase C3 — /evidence-requests/[id] reviewer inspector", () => {
  it("is wrapped in PageRouteGate", () => {
    expect(REQUEST_INSPECTOR).toContain("PageRouteGate");
    expect(REQUEST_INSPECTOR).toMatch(/routeId="workspace\.intake_links"/);
  });

  it("consumes the authenticated /v1/evidence-requests/:id endpoint", () => {
    expect(REQUEST_INSPECTOR).toContain("/v1/evidence-requests/");
    expect(REQUEST_INSPECTOR).toMatch(/encodeURIComponent\(requestId\)/);
  });

  it("invokes the existing audited needs-more-info endpoint", () => {
    expect(REQUEST_INSPECTOR).toContain("/needs-more-info");
    expect(REQUEST_INSPECTOR).toMatch(/method:\s*"POST"/);
  });

  it("invokes the existing audited waive endpoint", () => {
    expect(REQUEST_INSPECTOR).toMatch(
      /\/deliverables\/\$\{encodeURIComponent\(deliverableId\)\}\/waive/,
    );
  });

  it("invokes the existing audited response review endpoint", () => {
    expect(REQUEST_INSPECTOR).toMatch(
      /\/responses\/\$\{encodeURIComponent\(responseId\)\}\/review/,
    );
  });

  it("renders explicit empty states for no-deliverables and no-responses", () => {
    expect(REQUEST_INSPECTOR).toContain('data-evidence-request-empty="no-deliverables"');
    expect(REQUEST_INSPECTOR).toContain('data-evidence-request-empty="no-responses"');
  });

  it("never bypasses backend audit — no direct prisma calls, no custody event emission", () => {
    const code = stripComments(REQUEST_INSPECTOR);
    expect(code).not.toMatch(/prisma\./);
    expect(code).not.toMatch(/appendCustodyEvent|appendPlatformAuditLog/);
  });
});

// ===========================================================================
// 8. Matter Workspace Evidence tab extension
// ===========================================================================

describe("Phase C3 — Matter Workspace Evidence tab extension", () => {
  it("fetches the new /v1/cases/:id/evidence-requests aggregator", () => {
    expect(MATTER_UI).toContain(
      "/v1/cases/${encodeURIComponent(envelope.case.id)}/evidence-requests",
    );
  });

  it("renders an Evidence requests section with click-through to the inspector", () => {
    expect(MATTER_UI).toContain("data-matter-evidence-requests");
    expect(MATTER_UI).toMatch(/\/evidence-requests\/\$\{encodeURIComponent\(r\.id\)\}/);
  });

  it("surfaces per-request review-ready / needs-more-info status chips", () => {
    expect(MATTER_UI).toContain("data-request-review-ready");
    expect(MATTER_UI).toContain("data-request-needs-more-info");
  });

  it("preserves the C1 empty-state contract — EmptyState still fires when BOTH evidence and requests are empty", () => {
    expect(MATTER_UI).toMatch(
      /ev\.items\.length\s*===\s*0\s*&&\s*requestRows\.length\s*===\s*0/,
    );
    const tabFn = MATTER_UI.match(
      /function\s+EvidenceTab\s*\([\s\S]*?\n\}\s*\n/,
    );
    expect(tabFn).toBeTruthy();
    expect(tabFn![0]).toContain("<EmptyState");
  });
});

// ===========================================================================
// 9. Vocabulary discipline
// ===========================================================================

describe("Phase C3 — vocabulary discipline", () => {
  const surfaces: Array<{ name: string; src: string }> = [
    { name: "IntakeChecklist", src: INTAKE_CHECKLIST },
    { name: "IntakeCompletionProgress", src: INTAKE_PROGRESS },
    { name: "IntakeReReviewBanner", src: INTAKE_RERE },
    { name: "RequestInspector", src: REQUEST_INSPECTOR },
  ];

  const banned: Array<{ name: string; re: RegExp }> = [
    { name: "Slack", re: /\bSlack\b/i },
    { name: "DMs", re: /\bdirect messages?\b/i },
    { name: "social feed", re: /\bsocial\s+feed\b/i },
    { name: "reaction/emoji", re: /\bemoji\b|\breaction\b/i },
    { name: "AI summarization", re: /\bAI\s+summariz/i },
    { name: "AI intake coach", re: /\bAI\s+(intake|coach|agent)/i },
    { name: "Dropbox", re: /\bDropbox\b/i },
    { name: "Google Drive", re: /\bGoogle\s+Drive\b/i },
    { name: "tampered", re: /\btampered?\b/i },
    { name: "tamper-proof", re: /\btamper-?proof\b/i },
    { name: "authentic", re: /\bauthentic\b/i },
    { name: "admissible", re: /\badmissible\b/i },
    { name: "court-ready", re: /\bcourt-?ready\b/i },
    { name: "forensic proof", re: /\bforensic\s+proof\b/i },
    { name: "legal validity claim", re: /\blegally\s+valid\b/i },
  ];

  for (const { name, src } of surfaces) {
    for (const { name: bn, re } of banned) {
      it(`${name} contains no '${bn}'`, () => {
        expect(stripComments(src)).not.toMatch(re);
      });
    }
  }
});
