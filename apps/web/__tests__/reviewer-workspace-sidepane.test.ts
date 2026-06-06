/**
 * PHASE 1 — Reviewer Workspace side-pane wiring regression lock.
 *
 * The Reviewer Workspace at
 *   apps/web/app/(app)/review/workspace/page.tsx
 * historically rendered a `<SidePaneStub>` for the OCR / TRANSCRIPT /
 * EVIDENCE / REPORT tabs — bounded placeholder copy with no real data
 * source. This phase wires the four tabs to EXISTING canonical
 * endpoints (no new routes) so reviewers can read the real artifact
 * state for the active evidence:
 *
 *   EVIDENCE   -> GET /v1/evidence/:id                          (wired)
 *   OCR        -> GET /v1/intelligence/evidence/:id?teamId=...  (wired —
 *                  server projection drops raw text; we surface
 *                  metadata only)
 *   TRANSCRIPT -> same intelligence endpoint, filtered by kind   (wired)
 *   REPORT     -> GET /v1/evidence/:id/artifacts/status          (wired —
 *                  side-effect-free poll; NEVER /report/latest, which
 *                  records download / view custody events)
 *
 * The contracts we MUST NOT regress:
 *
 *   1. The api lib at apps/web/lib/reviewer-workspace/reviewer-api.ts
 *      exports the four side-pane fetchers and each targets the
 *      EXISTING canonical endpoint listed above — NOT a fabricated
 *      route, and NOT the side-effect-bearing /report/latest path.
 *
 *   2. The workspace page imports each side-pane component and
 *      renders it when its tab is active (lazy: no fetch fires while
 *      the tab is closed).
 *
 *   3. The legacy `<SidePaneStub>` and its placeholder copy
 *      ("loads from the workspace search foundation when available",
 *       "loads from the worker's transcript foundation",
 *       "compare side-by-side", "existing reports aggregator") are
 *      GONE — no commit may re-introduce them.
 *
 *   4. Anti-leak: no raw storage keys, full sha256 bytes, signed
 *      preview URLs, or raw extracted-text bodies appear in the
 *      side-pane component sources.
 *
 *   5. Empty-state copy is honest — each component carries the
 *      bounded "No <kind> records for this evidence yet." / "Could
 *      not load — please retry." strings so a denied or absent
 *      projection never renders as a fake success.
 *
 *   6. Every new fetch is wrapped in try/catch with a structured
 *      `console.warn` channel so partial-failure is observable.
 *
 * Runs under Node's built-in `node:test`. Invoke with e.g.
 *   `node --test --import tsx \
 *      apps/web/__tests__/reviewer-workspace-sidepane.test.ts`
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const PAGE_PATH = resolve(
  __dirname,
  "..",
  "app",
  "(app)",
  "review",
  "workspace",
  "page.tsx",
);
const API_PATH = resolve(
  __dirname,
  "..",
  "lib",
  "reviewer-workspace",
  "reviewer-api.ts",
);
const EVIDENCE_PANE_PATH = resolve(
  __dirname,
  "..",
  "components",
  "reviewer-workspace",
  "SidePaneEvidence.tsx",
);
const TEXTS_PANE_PATH = resolve(
  __dirname,
  "..",
  "components",
  "reviewer-workspace",
  "SidePaneExtractedTexts.tsx",
);
const REPORT_PANE_PATH = resolve(
  __dirname,
  "..",
  "components",
  "reviewer-workspace",
  "SidePaneReport.tsx",
);

const PAGE_SOURCE = readFileSync(PAGE_PATH, "utf8");
const API_SOURCE = readFileSync(API_PATH, "utf8");
const EVIDENCE_PANE_SOURCE = readFileSync(EVIDENCE_PANE_PATH, "utf8");
const TEXTS_PANE_SOURCE = readFileSync(TEXTS_PANE_PATH, "utf8");
const REPORT_PANE_SOURCE = readFileSync(REPORT_PANE_PATH, "utf8");

// ---------------------------------------------------------------------------
// 1. Helpers exist and target the canonical existing endpoints.
// ---------------------------------------------------------------------------

test("reviewer-api defines fetchEvidenceSidePaneDetail targeting /v1/evidence/:id", () => {
  assert.match(
    API_SOURCE,
    /export async function fetchEvidenceSidePaneDetail\s*\(/,
    "reviewer-api.ts must export fetchEvidenceSidePaneDetail.",
  );
  assert.match(
    API_SOURCE,
    /apiFetch\(`\/v1\/evidence\/\$\{evidenceId\}`/,
    "fetchEvidenceSidePaneDetail must call GET /v1/evidence/:id (no fabricated route).",
  );
});

test("reviewer-api defines fetchExtractedTextsForEvidence targeting /v1/intelligence/evidence/:id", () => {
  assert.match(
    API_SOURCE,
    /export async function fetchExtractedTextsForEvidence\s*\(/,
    "reviewer-api.ts must export fetchExtractedTextsForEvidence.",
  );
  assert.match(
    API_SOURCE,
    /\/v1\/intelligence\/evidence\/\$\{evidenceId\}\?teamId=/,
    "fetchExtractedTextsForEvidence must call the canonical intelligence route with teamId query param.",
  );
});

test("fetchExtractedTextsForEvidence short-circuits when teamId is missing", () => {
  // Personal-mode workspaces have no teamId. The helper MUST return
  // a tagged NO_TEAM failure instead of issuing a request that the
  // route would reject with a 400 (which the UI would then render as
  // a generic ERROR).
  assert.match(
    API_SOURCE,
    /if\s*\(!teamId\)\s*return\s*\{\s*ok:\s*false,\s*reason:\s*"NO_TEAM"\s*\}/,
    "fetchExtractedTextsForEvidence must short-circuit on missing teamId.",
  );
});

test("reviewer-api defines fetchEvidenceArtifactsStatus targeting /artifacts/status", () => {
  assert.match(
    API_SOURCE,
    /export async function fetchEvidenceArtifactsStatus\s*\(/,
    "reviewer-api.ts must export fetchEvidenceArtifactsStatus.",
  );
  assert.match(
    API_SOURCE,
    /\/v1\/evidence\/\$\{evidenceId\}\/artifacts\/status/,
    "fetchEvidenceArtifactsStatus must use the side-effect-free /artifacts/status endpoint.",
  );
  // The side-pane MUST NOT use /report/latest — that endpoint creates
  // REPORT_DOWNLOADED + evidence.report_viewed audit rows. A read-only
  // status pane has no business writing custody events on every tab
  // open.
  assert.doesNotMatch(
    API_SOURCE,
    /fetchEvidenceArtifactsStatus[\s\S]{0,200}\/report\/latest/,
    "fetchEvidenceArtifactsStatus must not hit /report/latest (would forge custody events).",
  );
});

// ---------------------------------------------------------------------------
// 2. Workspace page imports the wired side-pane components.
// ---------------------------------------------------------------------------

test("workspace page imports SidePaneEvidence", () => {
  assert.match(
    PAGE_SOURCE,
    /import \{ SidePaneEvidence \} from "[^"]*SidePaneEvidence"/,
    "workspace page must import SidePaneEvidence.",
  );
});

test("workspace page imports SidePaneExtractedTexts", () => {
  assert.match(
    PAGE_SOURCE,
    /import \{ SidePaneExtractedTexts \} from "[^"]*SidePaneExtractedTexts"/,
    "workspace page must import SidePaneExtractedTexts.",
  );
});

test("workspace page imports SidePaneReport", () => {
  assert.match(
    PAGE_SOURCE,
    /import \{ SidePaneReport \} from "[^"]*SidePaneReport"/,
    "workspace page must import SidePaneReport.",
  );
});

test("workspace page imports the four side-pane fetcher helpers", () => {
  assert.match(
    PAGE_SOURCE,
    /fetchEvidenceSidePaneDetail/,
    "workspace page must import fetchEvidenceSidePaneDetail.",
  );
  assert.match(
    PAGE_SOURCE,
    /fetchExtractedTextsForEvidence/,
    "workspace page must import fetchExtractedTextsForEvidence.",
  );
  assert.match(
    PAGE_SOURCE,
    /fetchEvidenceArtifactsStatus/,
    "workspace page must import fetchEvidenceArtifactsStatus.",
  );
});

// ---------------------------------------------------------------------------
// 3. SidePaneStub is gone — placeholder copy must not survive.
// ---------------------------------------------------------------------------

test("workspace page no longer references SidePaneStub", () => {
  assert.doesNotMatch(
    PAGE_SOURCE,
    /<SidePaneStub /,
    "workspace page must not render <SidePaneStub> for any wired mode.",
  );
  assert.doesNotMatch(
    PAGE_SOURCE,
    /function SidePaneStub\s*\(/,
    "workspace page must not define a SidePaneStub component.",
  );
});

test("workspace page no longer carries the legacy stub copy", () => {
  const bannedFragments = [
    "loads from the workspace search foundation when available",
    "loads from the worker's transcript foundation when available",
    "second evidence item from the queue rail to compare side-by-side",
    "loaded from the existing reports aggregator",
  ];
  for (const frag of bannedFragments) {
    assert.ok(
      !PAGE_SOURCE.includes(frag),
      `workspace page must not contain legacy stub copy: ${JSON.stringify(frag)}`,
    );
  }
});

// ---------------------------------------------------------------------------
// 4. Lazy load — the fetcher effects only run when the matching tab is open.
// ---------------------------------------------------------------------------

test("EVIDENCE lazy-load effect gates on sidePaneMode === 'EVIDENCE'", () => {
  assert.match(
    PAGE_SOURCE,
    /if\s*\(sidePaneMode\s*!==\s*"EVIDENCE"\)\s*return;[\s\S]*?fetchEvidenceSidePaneDetail/,
    "EVIDENCE side-pane fetch must only fire while the EVIDENCE tab is open.",
  );
});

test("OCR/TRANSCRIPT lazy-load effect gates on the matching tab", () => {
  assert.match(
    PAGE_SOURCE,
    /if\s*\(sidePaneMode\s*!==\s*"OCR"\s*&&\s*sidePaneMode\s*!==\s*"TRANSCRIPT"\)\s*return;[\s\S]*?fetchExtractedTextsForEvidence/,
    "extracted-texts side-pane fetch must only fire while OCR or TRANSCRIPT is open.",
  );
});

test("REPORT lazy-load effect gates on sidePaneMode === 'REPORT'", () => {
  assert.match(
    PAGE_SOURCE,
    /if\s*\(sidePaneMode\s*!==\s*"REPORT"\)\s*return;[\s\S]*?fetchEvidenceArtifactsStatus/,
    "REPORT side-pane fetch must only fire while the REPORT tab is open.",
  );
});

// ---------------------------------------------------------------------------
// 5. Workspace page resets side-pane caches when active evidence changes.
// ---------------------------------------------------------------------------

test("workspace page resets side-pane caches on activeEvidenceId change", () => {
  // Stale OCR / TRANSCRIPT / EVIDENCE / REPORT data MUST NOT survive
  // when the operator advances to the next workflow.
  assert.match(
    PAGE_SOURCE,
    /setEvidenceSide\(null\)[\s\S]{0,200}setExtractedSide\(null\)[\s\S]{0,200}setReportSide\(null\)/,
    "workspace page must clear all three side-pane caches when activeEvidenceId changes.",
  );
});

// ---------------------------------------------------------------------------
// 6. Bounded display — anti-leak shape in each pane component.
// ---------------------------------------------------------------------------

test("SidePaneEvidence does not surface raw storage keys or full sha256 bytes", () => {
  // Strip leading-comment / block-comment regions so docstring copy
  // that documents what we DON'T leak is not flagged as a leak.
  const codeOnly = EVIDENCE_PANE_SOURCE
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split(/\r?\n/)
    .filter((l) => !/^\s*\/\//.test(l))
    .join("\n");
  // The EVIDENCE pane consumes the bounded projection from
  // fetchEvidenceSidePaneDetail and only renders displayTitle /
  // mimeType / sha256 PREFIX / etc. Direct property accesses for
  // storage bucket/key fields or signed URLs are banned.
  assert.doesNotMatch(
    codeOnly,
    /\.storageBucket\b|\.storageKey\b|\.signedPreviewUrl\b|\.previewUrl\b/,
    "SidePaneEvidence must not read storage keys or signed preview URLs in code.",
  );
  // The helper truncates sha256 to a 12-hex prefix. The pane source
  // should rely on that prefix, never re-derive from full bytes.
  assert.match(
    EVIDENCE_PANE_SOURCE,
    /fileSha256Prefix/,
    "SidePaneEvidence must render the bounded sha256 prefix, not the full digest.",
  );
  // And `fileSha256` (full digest field name) must not appear as a
  // code property access — only the prefix is allowed.
  assert.doesNotMatch(
    codeOnly,
    /\.fileSha256\b(?!Prefix)/,
    "SidePaneEvidence must only read the truncated prefix, not the full sha256 digest.",
  );
});

test("SidePaneExtractedTexts only renders projection metadata (no raw text)", () => {
  // The server's projectExtractedTextSummary helper deliberately
  // omits the `text` column. The pane source MUST NOT reference any
  // raw text field — only metadata (status / provider / wordCount /
  // confidence / language / extractedAtUtc).
  assert.doesNotMatch(
    TEXTS_PANE_SOURCE,
    /row\.text\b|\bdetail\.text\b|extractedText\.text/,
    "SidePaneExtractedTexts must not render raw extracted-text bodies.",
  );
});

test("SidePaneReport does not surface report download URLs or storage paths", () => {
  // The /artifacts/status endpoint never surfaces a download URL by
  // design — the pane must not invent one either.
  assert.doesNotMatch(
    REPORT_PANE_SOURCE,
    /downloadUrl|signedDownloadUrl|storageBucket|storageKey/,
    "SidePaneReport must not surface report download URLs or storage paths.",
  );
});

// ---------------------------------------------------------------------------
// 7. Honest empty / error copy.
// ---------------------------------------------------------------------------

test("SidePaneEvidence carries honest FORBIDDEN / NOT_FOUND / ERROR copy", () => {
  assert.match(
    EVIDENCE_PANE_SOURCE,
    /Evidence preview not available/,
    "SidePaneEvidence must surface bounded denial copy.",
  );
  assert.match(
    EVIDENCE_PANE_SOURCE,
    /Could not load evidence preview/,
    "SidePaneEvidence must surface a bounded ERROR retry copy.",
  );
});

test("SidePaneExtractedTexts carries honest empty / error copy", () => {
  assert.match(
    TEXTS_PANE_SOURCE,
    /No OCR records for this evidence yet/,
    "SidePaneExtractedTexts must surface honest OCR empty copy.",
  );
  assert.match(
    TEXTS_PANE_SOURCE,
    /No transcript segments for this evidence yet/,
    "SidePaneExtractedTexts must surface honest TRANSCRIPT empty copy.",
  );
  assert.match(
    TEXTS_PANE_SOURCE,
    /only available for team workspaces/,
    "SidePaneExtractedTexts must surface NO_TEAM copy for personal-mode workspaces.",
  );
});

test("SidePaneReport carries honest empty / blocked copy", () => {
  assert.match(
    REPORT_PANE_SOURCE,
    /No report generated for this evidence yet/,
    "SidePaneReport must surface honest no-artifact copy.",
  );
  assert.match(
    REPORT_PANE_SOURCE,
    /Could not load report status/,
    "SidePaneReport must surface a bounded ERROR retry copy.",
  );
  assert.match(
    REPORT_PANE_SOURCE,
    /Blocked by governance/,
    "SidePaneReport must distinguish governance-blocked package state.",
  );
});

// ---------------------------------------------------------------------------
// 8. Structured warn logs around new fetches.
// ---------------------------------------------------------------------------

test("each side-pane fetcher logs a structured warn on failure", () => {
  // Each of the three new fetchers must surface a tagged
  // [reviewer-workspace] warn line so observability sees partial-
  // failure cleanly. Visual proxy: the helper file contains all
  // three tags somewhere in the helper body.
  assert.match(
    API_SOURCE,
    /\[reviewer-workspace\] evidence side-pane fetch failed/,
    "fetchEvidenceSidePaneDetail must warn on failure.",
  );
  assert.match(
    API_SOURCE,
    /\[reviewer-workspace\] extracted-texts side-pane fetch failed/,
    "fetchExtractedTextsForEvidence must warn on failure.",
  );
  assert.match(
    API_SOURCE,
    /\[reviewer-workspace\] artifacts-status side-pane fetch failed/,
    "fetchEvidenceArtifactsStatus must warn on failure.",
  );
});
