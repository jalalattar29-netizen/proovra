/**
 * Phase HOME-RECORDS-BY-TYPE — contract lock for the new workspace-
 * scoped aggregation that powers the Home "Records by primary type"
 * donut.
 *
 * BEFORE THIS PHASE the donut classified the latest-100 evidence
 * list client-side and presented the result as if it were the whole
 * workspace — a SAMPLE rendered as a total. That widget violated
 * PROOVRA's "every metric must be truthful" rule.
 *
 * THIS PHASE replaces it with two backend aggregates over EVERY
 * active non-deleted Evidence row in scope:
 *
 *   records  — one count per Evidence row
 *              (classifier reads mimeType + type + captureMethod)
 *   files    — one count per EvidencePart row
 *              (classifier reads mimeType only)
 *
 * The two concepts are kept STRICTLY SEPARATE — the route returns
 * both, the widget renders one or the other, never mixed.
 *
 * Source-shape locks pinned here (anti-drift):
 *
 *   1. The shared classifier module exists and exports the 7-category
 *      taxonomy and `classifyEvidenceCategory()`. Both backend and
 *      frontend must import from this one module — divergent
 *      classifications would silently mis-bucket records.
 *
 *   2. The backend service exists, imports the shared classifier,
 *      excludes soft-deleted via `deletedAt: null` on BOTH queries,
 *      and uses `workspaceEvidenceWhere` for personal-team parity
 *      with `trust-summary.service.ts`.
 *
 *   3. The route exists, sits under `/v1/dashboard/records-by-type`,
 *      is gated by `requireAuth` + `requireMember`, and parses
 *      `teamId` with the same Zod schema as the rest of the
 *      dashboard family.
 *
 *   4. The frontend hook fetches the new endpoint workspace-scoped
 *      and threads the response through `normalizeHomeViewModel`.
 *
 *   5. The view-model surfaces `typeDistribution.source` so the
 *      widget can label the count provenance ("workspace-aggregate"
 *      vs "latest-sample") and exposes a separate
 *      `preservedFilesByType` field so records and files never mix.
 *
 *   6. The widget renders the Records/Files toggle when the files
 *      aggregate is present.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, "..", "..", "..");

function readSrc(rel: string): string {
  return readFileSync(resolve(REPO_ROOT, rel), "utf8");
}

describe("Phase HOME-RECORDS-BY-TYPE — shared classifier module", () => {
  const CLASSIFIER = readSrc(
    "packages/shared/src/records-by-type-classifier.ts",
  );

  it("exports the canonical 7-category taxonomy", () => {
    expect(CLASSIFIER).toMatch(
      /export const RECORDS_BY_TYPE_CATEGORIES\s*=\s*\[[\s\S]*?"Images"[\s\S]*?"Documents"[\s\S]*?"Videos"[\s\S]*?"Audio"[\s\S]*?"Archives"[\s\S]*?"Folders"[\s\S]*?"Other Files"[\s\S]*?\]\s*as const/,
    );
  });

  it("exports `classifyEvidenceCategory` and `emptyRecordsByTypeAggregate`", () => {
    expect(CLASSIFIER).toMatch(/export function classifyEvidenceCategory\(/);
    expect(CLASSIFIER).toMatch(
      /export function emptyRecordsByTypeAggregate\(/,
    );
  });

  it("is re-exported from @proovra/shared so backend + frontend use one source", () => {
    const SHARED_INDEX = readSrc("packages/shared/src/index.ts");
    expect(SHARED_INDEX).toMatch(
      /from\s+["']\.\/records-by-type-classifier\.js["']/,
    );
    expect(SHARED_INDEX).toMatch(/RECORDS_BY_TYPE_CATEGORIES/);
    expect(SHARED_INDEX).toMatch(/classifyEvidenceCategory/);
    expect(SHARED_INDEX).toMatch(/emptyRecordsByTypeAggregate/);
  });
});

describe("Phase HOME-RECORDS-BY-TYPE — backend service", () => {
  const SERVICE = readSrc(
    "services/api/src/services/dashboard/records-by-type.service.ts",
  );

  it("imports the shared classifier from @proovra/shared (NOT a local copy)", () => {
    expect(SERVICE).toMatch(
      /import\s*\{[\s\S]*?classifyEvidenceCategory[\s\S]*?\}\s*from\s*["']@proovra\/shared["']/,
    );
    // The service must NOT define its own classifier — silent drift
    // between backend bucket assignment and the frontend taxonomy
    // would mis-bucket the donut without any test failing.
    expect(SERVICE).not.toMatch(/function\s+classifyEvidenceCategory\s*\(/);
  });

  it("uses workspaceEvidenceWhere for personal-team scope parity with trust-summary", () => {
    expect(SERVICE).toMatch(
      /from\s*["']\.\.\/workspace-personal-scope\.service\.js["']/,
    );
    expect(SERVICE).toMatch(/await\s+workspaceEvidenceWhere\(/);
  });

  it("RECORDS query excludes soft-deleted evidence (`deletedAt: null`)", () => {
    // The records aggregate is one count per Evidence row.
    expect(SERVICE).toMatch(
      /prisma\.evidence\.findMany\(\{\s*\n?\s*where:\s*\{\s*AND:\s*\[\s*scopeWhere\s*,\s*\{\s*deletedAt:\s*null\s*\}\s*\]/,
    );
  });

  it("FILES query excludes soft-deleted evidence via the parent relation", () => {
    // The files aggregate is one count per EvidencePart row. The
    // soft-delete predicate lives on the parent Evidence.
    expect(SERVICE).toMatch(
      /prisma\.evidencePart\.findMany\(\{\s*\n?\s*where:\s*\{\s*\n?\s*evidence:\s*\{\s*AND:\s*\[\s*scopeWhere\s*,\s*\{\s*deletedAt:\s*null\s*\}\s*\]/,
    );
  });

  it("returns both `records` and `files` aggregates — never one mixed bucket", () => {
    expect(SERVICE).toMatch(/return\s*\{\s*records\s*,\s*files\s*\}/);
  });

  it("RECORDS classifier feeds it the parent triple (mimeType, type, captureMethod)", () => {
    expect(SERVICE).toMatch(
      /classifyEvidenceCategory\(\{\s*\n?\s*mimeType:\s*ev\.mimeType\s*,\s*\n?\s*type:\s*ev\.type\s*,\s*\n?\s*captureMethod:\s*ev\.captureMethod\s*,?\s*\n?\s*\}\)/,
    );
  });

  it("FILES classifier feeds it the part's mimeType ONLY (parts have no type/captureMethod)", () => {
    expect(SERVICE).toMatch(
      /classifyEvidenceCategory\(\{\s*mimeType:\s*p\.mimeType\s*\}\)/,
    );
  });
});

describe("Phase HOME-RECORDS-BY-TYPE — route registration", () => {
  const ROUTES = readSrc("services/api/src/routes/dashboard.routes.ts");

  it("imports buildRecordsByType from the new service", () => {
    expect(ROUTES).toMatch(
      /import\s*\{\s*buildRecordsByType\s*\}\s*from\s*["']\.\.\/services\/dashboard\/records-by-type\.service\.js["']/,
    );
  });

  it("registers GET /v1/dashboard/records-by-type with the same auth posture as trust-summary", () => {
    expect(ROUTES).toMatch(
      /app\.get\(\s*\n?\s*["']\/v1\/dashboard\/records-by-type["']\s*,\s*\n?\s*\{\s*preHandler:\s*requireAuth\s*\}/,
    );
    // requireMember gate + member-inactive short-circuit is the same
    // pattern as the rest of /v1/dashboard/*.
    const idx = ROUTES.indexOf("/v1/dashboard/records-by-type");
    expect(idx).toBeGreaterThan(0);
    const handlerSlice = ROUTES.slice(idx, idx + 800);
    expect(handlerSlice).toMatch(
      /const\s+member\s*=\s*await\s+requireMember\(req,\s*reply,\s*query\.teamId\)/,
    );
    expect(handlerSlice).toMatch(/if\s*\(!member\)\s*return/);
    expect(handlerSlice).toMatch(
      /buildRecordsByType\(\{\s*teamId:\s*query\.teamId\s*\}\)/,
    );
  });
});

describe("Phase HOME-RECORDS-BY-TYPE — frontend hook wiring", () => {
  const HOOK = readSrc("apps/web/components/home-experience/useHomeData.ts");

  it("fetches the new endpoint workspace-scoped", () => {
    expect(HOOK).toMatch(
      /apiFetch\(scoped\(["']\/v1\/dashboard\/records-by-type["']\)/,
    );
  });

  it("is partial-failure tolerant — `.catch(() => null)` mirrors the rest of Home", () => {
    const idx = HOOK.indexOf("/v1/dashboard/records-by-type");
    expect(idx).toBeGreaterThan(0);
    const slice = HOOK.slice(idx, idx + 400);
    expect(slice).toMatch(/\.catch\(\(\)\s*=>\s*null\)/);
  });

  it("threads `recordsByType` through to normalizeHomeViewModel", () => {
    expect(HOOK).toMatch(/normalizeHomeViewModel\(\{[\s\S]*?recordsByType\s*,/);
  });
});

describe("Phase HOME-RECORDS-BY-TYPE — view-model surface", () => {
  const VM = readSrc(
    "apps/web/components/home-experience/home-view-model.ts",
  );

  it("EvidenceTypeDistribution gains the `source` provenance field", () => {
    expect(VM).toMatch(
      /export type EvidenceTypeDistribution\s*=\s*\{[\s\S]*?source:\s*["']workspace-aggregate["']\s*\|\s*["']latest-sample["']/,
    );
  });

  it("HomeViewModel exposes `preservedFilesByType` (records and files never share one field)", () => {
    expect(VM).toMatch(
      /preservedFilesByType:\s*EvidenceTypeDistribution\s*\|\s*null/,
    );
  });

  it("NormalizeInputs accepts a `recordsByType` input from the hook", () => {
    expect(VM).toMatch(
      /recordsByType\?:\s*HomeRecordsByTypeInput\s*\|\s*null/,
    );
  });

  it("the aggregate builder marks counts as `source: 'workspace-aggregate'` and never `sampled`", () => {
    const start = VM.indexOf("function buildTypeDistributionFromAggregate");
    expect(start).toBeGreaterThan(0);
    const end = VM.indexOf("\nfunction ", start + 1);
    const body = VM.slice(start, end > 0 ? end : start + 4_000);
    expect(body).toMatch(/source:\s*["']workspace-aggregate["']/);
    expect(body).toMatch(/sampled:\s*false/);
  });

  it("the legacy latest-100 builder remains as a fallback but is labelled `source: 'latest-sample'`", () => {
    const start = VM.indexOf("function buildTypeDistribution(");
    expect(start).toBeGreaterThan(0);
    const end = VM.indexOf("\nfunction ", start + 1);
    const body = VM.slice(start, end > 0 ? end : start + 4_000);
    expect(body).toMatch(/source:\s*["']latest-sample["']/);
  });

  it("normalizeHomeViewModel prefers the aggregate, falls back to the legacy classifier", () => {
    // Use the indexOf trick to find the integration block precisely
    // rather than letting a free-form regex span 200+ lines and
    // accidentally match unrelated code.
    const start = VM.indexOf(
      "Phase HOME-RECORDS-BY-TYPE — prefer the workspace-aggregate",
    );
    expect(start).toBeGreaterThan(0);
    const block = VM.slice(start, start + 1_500);
    expect(block).toMatch(
      /const\s+recordsAggregate\s*=\s*inputs\.recordsByType\?\.records/,
    );
    expect(block).toMatch(/buildTypeDistributionFromAggregate\(recordsAggregate\)/);
    expect(block).toMatch(
      /buildTypeDistribution\(\{\s*scoped:\s*scopedEvidence\s*,\s*listHasMore\s*\}\)/,
    );
    expect(block).toMatch(
      /const\s+preservedFilesByType\s*=[\s\S]*?buildTypeDistributionFromAggregate\(filesAggregate\)[\s\S]*?null/,
    );
  });
});

describe("Phase HOME-RECORDS-BY-TYPE — donut widget", () => {
  const WIDGET = readSrc(
    "apps/web/components/home-experience/HomeDashboardSections.tsx",
  );

  it("accepts the optional preservedFiles prop", () => {
    expect(WIDGET).toMatch(
      /preservedFiles\?:\s*EvidenceTypeDistribution\s*\|\s*null/,
    );
  });

  it("renders the Records / Preserved files toggle when files data is present", () => {
    expect(WIDGET).toMatch(
      /data-evidence-types-toggle/,
    );
    expect(WIDGET).toMatch(
      /data-evidence-types-tab=["']records["']/,
    );
    expect(WIDGET).toMatch(
      /data-evidence-types-tab=["']files["']/,
    );
  });

  it("subtitle is provenance-honest — latest-sample is labelled as sampled, workspace-aggregate is not", () => {
    // The exact wording is load-bearing: the widget MUST NOT present a
    // "latest 100 records" sample as if it were the whole workspace.
    expect(WIDGET).toMatch(/latest \$\{sampleSize\} records sampled/);
    expect(WIDGET).toMatch(
      /\$\{sampleSize\} record\$\{sampleSize === 1 \? "" : "s"\} · by primary type/,
    );
  });

  it("SelfServeHomeDashboard passes both distribution and preservedFiles to the widget", () => {
    const DASHBOARD = readSrc(
      "apps/web/components/home-experience/SelfServeHomeDashboard.tsx",
    );
    expect(DASHBOARD).toMatch(
      /<EvidenceTypeDonutCard[\s\S]*?distribution=\{vm\.typeDistribution\}[\s\S]*?preservedFiles=\{vm\.preservedFilesByType\}/,
    );
  });
});
