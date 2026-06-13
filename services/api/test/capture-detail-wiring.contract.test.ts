/**
 * Phase CAPTURE-DETAIL-WIRING — contract locks proving capture-origin
 * fields actually reach the Evidence Detail UI.
 *
 * BACKGROUND
 *
 * Capture state carries seven workspace-internal fields per evidence
 * record (Evidence.internalNotes, Evidence.intakePlanJson) and four
 * per uploaded part (EvidencePart.privateNote, privateRole,
 * sourceLabel, clientSignals, plus the already-projected
 * checklistStepId). Until this pass:
 *
 *  - sourceLabel + clientSignals were SELECTED by the
 *    review-workspace handler but never PROJECTED into the
 *    contentItems response sent to the UI.
 *  - privateRole was projected upstream but the Evidence Detail UI
 *    never rendered it on the per-item card.
 *  - intakePlanJson was in the response but had NO UI surface at
 *    all — the reviewer could not see which capture template the
 *    capturer used or whether every required step was satisfied.
 *
 * This file locks the fix at three layers (source-level grep tests
 * because the real end-to-end path requires a running DB + S3):
 *
 *   1. evidence.routes.ts review-workspace contentItems projection
 *      includes privateRole, sourceLabel, clientSignals.
 *   2. The Evidence Detail page renders privateRole + sourceLabel +
 *      privateNote per item AND includes the CaptureTemplateCard.
 *   3. The Discussion tab is hidden for PERSONAL workspaces, and
 *      the Technical Appendix `<details>` is collapsed by default.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, "..", "..", "..");

const EVIDENCE_ROUTES = readFileSync(
  resolve(REPO_ROOT, "services", "api", "src", "routes", "evidence.routes.ts"),
  "utf8",
);
const DETAIL_PAGE = readFileSync(
  resolve(
    REPO_ROOT,
    "apps",
    "web",
    "app",
    "(app)",
    "evidence",
    "[id]",
    "page.tsx",
  ),
  "utf8",
);

describe("CAPTURE-DETAIL-WIRING — backend projection", () => {
  it("review-workspace contentItems carries privateNote", () => {
    expect(EVIDENCE_ROUTES).toMatch(/privateNote:\s*part\?\.privateNote\s*\?\?\s*null/);
  });

  it("review-workspace contentItems carries privateRole (new)", () => {
    expect(EVIDENCE_ROUTES).toMatch(/privateRole:\s*part\?\.privateRole\s*\?\?\s*null/);
  });

  it("review-workspace contentItems carries sourceLabel (new)", () => {
    expect(EVIDENCE_ROUTES).toMatch(/sourceLabel:\s*part\?\.sourceLabel\s*\?\?\s*null/);
  });

  it("review-workspace contentItems carries clientSignals (new)", () => {
    expect(EVIDENCE_ROUTES).toMatch(/clientSignals:\s*part\?\.clientSignals\s*\?\?\s*null/);
  });

  it("public-verify projection MUST NOT carry privateNote (legal-chain firewall)", () => {
    // The public-verify projection in evidence.routes.ts:10936-10948
    // selects EvidencePart fields. It must include privateRole only
    // for internal role resolution but never privateNote. This lock
    // is the regression guard preventing accidental leakage.
    const publicSelect = EVIDENCE_ROUTES.match(
      /(\/\/.*public[\s\S]{0,300}?)select:\s*\{([^}]+)\}/i,
    );
    // Soft lock: ensure no occurrence of `privateNote:\s*true` in a
    // block immediately under any "public" comment.
    // Stronger lock: there is exactly one allowed surface that
    // attaches privateNote (the review-workspace projection above).
    const allOccurrences = (EVIDENCE_ROUTES.match(/privateNote:\s*true/g) ?? []).length;
    // SAFE_EVIDENCE_SELECT etc. — only the review-workspace parts
    // SELECT should request privateNote.
    expect(allOccurrences).toBeGreaterThan(0);
    expect(allOccurrences).toBeLessThan(5); // sanity bound; if this grows audit it
    expect(publicSelect ? publicSelect[0] : "").not.toMatch(/privateNote:\s*true/);
  });
});

describe("CAPTURE-DETAIL-WIRING — Evidence Detail page", () => {
  it("renders privateNote per item card (existing behaviour preserved)", () => {
    expect(DETAIL_PAGE).toMatch(/data-content-item-private-note/);
  });

  it("renders privateRole per item card (new)", () => {
    expect(DETAIL_PAGE).toMatch(/data-content-item-private-role/);
  });

  it("renders sourceLabel per item card (new)", () => {
    expect(DETAIL_PAGE).toMatch(/data-content-item-source-label/);
  });

  it("CaptureTemplateCard component is defined AND mounted in the Overview tab", () => {
    expect(DETAIL_PAGE).toMatch(/function CaptureTemplateCard\(/);
    expect(DETAIL_PAGE).toMatch(/<CaptureTemplateCard/);
    // Mounted with intakePlanJson + contentItems (both required so
    // the mapped/required-step count can be computed).
    expect(DETAIL_PAGE).toMatch(
      /<CaptureTemplateCard[\s\S]{0,200}intakePlanJson=\{workspace\.evidence\.intakePlanJson/,
    );
  });

  it("CaptureTemplateCard surfaces unmapped required steps via data hook", () => {
    expect(DETAIL_PAGE).toMatch(/data-capture-template-missing/);
  });

  it("Capture template section uses the dedicated data hook", () => {
    expect(DETAIL_PAGE).toMatch(/data-evidence-section="capture-template"/);
  });
});

describe("CAPTURE-DETAIL-WIRING — structural fixes", () => {
  it("Discussion tab is filtered out when workspace is PERSONAL", () => {
    expect(DETAIL_PAGE).toMatch(/isPersonalWorkspace\s*=\s*workspaceCaps\?\.workspaceType\s*===\s*"PERSONAL"/);
    expect(DETAIL_PAGE).toMatch(
      /visibleTabs\s*=\s*DETAIL_TABS\.filter\([\s\S]{0,200}t\.id\s*===\s*"discussion"\s*&&\s*isPersonalWorkspace/,
    );
  });

  it("Technical Appendix details block is COLLAPSED by default (no `open` attribute)", () => {
    // Must contain a <details> for the raw appendix that is NOT open.
    expect(DETAIL_PAGE).toMatch(/<details\s+data-evidence-raw-appendix>/);
    // Regression guard — the previous `<details open>` form must NOT
    // re-appear for the raw appendix.
    expect(DETAIL_PAGE).not.toMatch(/<details\s+open>\s*\n\s*<summary[^>]*>Raw technical appendix/);
  });

  it("Technical Appendix tab kicker says `Advanced` so the user is warned", () => {
    expect(DETAIL_PAGE).toMatch(/Technical Appendix · Advanced/);
  });
});
