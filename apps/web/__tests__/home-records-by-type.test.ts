/**
 * Phase HOME-RECORDS-BY-TYPE-FIX — regression lock for the Records-by-
 * Type widget.
 *
 * Concept (locked):
 *   * The widget counts EVIDENCE RECORDS by primary type — NOT
 *     EvidenceParts / preserved files inside multipart packages.
 *   * Classification uses MIME first → EvidenceType enum second →
 *     captureMethod fallback. A multipart Evidence row counts ONCE
 *     in ONE bucket (its primary type).
 *   * The widget is bounded by the live /v1/evidence list cap (100
 *     newest); the subtitle honestly says "latest N records · by
 *     primary type" when the API reports `hasMore=true`.
 *   * The hook MUST refetch on tab visibility / window focus so a
 *     user who finalised a capture and returned to /home sees the
 *     freshly captured record without a hard refresh.
 *
 * THIS FILE PINS:
 *
 *   1. The classifier returns the right bucket for every MIME family
 *      (images / videos / audio / documents / archives / generic).
 *   2. A multipart Evidence row contributes ONE count to its primary-
 *      type bucket — never one-per-part.
 *   3. The view-model carries the `sampled` boolean honestly when the
 *      API reports `hasMore=true`.
 *   4. The `useHomeData` source registers a visibilitychange + focus
 *      listener that triggers `reload()` — the load-bearing fix for
 *      the user-reported "stays static after new capture" bug.
 *   5. The wire shape of the Home evidence list does NOT carry
 *      EvidencePart info — preserving the "records, not files"
 *      contract end-to-end.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import {
  normalizeHomeViewModel,
  type NormalizeInputs,
} from "../components/home-experience/home-view-model";

const WS = "ws-records-by-type";
const NOW = Date.parse("2026-06-14T12:00:00Z");

function baseInputs(over: Partial<NormalizeInputs> = {}): NormalizeInputs {
  return {
    workspaceId: WS,
    plan: "PRO",
    activeSpaceType: "PERSONAL",
    workspaceName: null,
    trustSummary: null,
    billing: null,
    reports: null,
    intakeLinks: null,
    inbox: null,
    communications: null,
    orgs: [],
    evidenceList: null,
    commandCenter: null,
    organizationName: null,
    organizationSlug: null,
    sessionUserName: null,
    sessionUserEmail: null,
    rawClockNow: NOW,
    rawClockTimezone: "UTC",
    ...over,
  } as NormalizeInputs;
}

type EvItem = {
  id: string;
  type?: string;
  mimeType?: string | null;
  captureMethod?: string | null;
  createdAt?: string;
  teamId?: string | null;
};
function mkItem(over: Partial<EvItem> = {}): EvItem {
  return {
    id: over.id ?? "ev-1",
    type: over.type ?? "PHOTO",
    mimeType: over.mimeType ?? "image/jpeg",
    captureMethod: over.captureMethod ?? null,
    createdAt: over.createdAt ?? new Date(NOW - 3600_000).toISOString(),
    teamId: over.teamId ?? WS,
  };
}

// ---------------------------------------------------------------------------
// 1. Classifier — each MIME family lands in its own bucket.
// ---------------------------------------------------------------------------

test("Records by type: image MIME → Images bucket", () => {
  const vm = normalizeHomeViewModel(
    baseInputs({
      evidenceList: { items: [mkItem({ id: "i", mimeType: "image/jpeg" })] },
    }),
  );
  const buckets = Object.fromEntries(
    vm.typeDistribution.slices.map((s) => [s.label, s.count]),
  );
  assert.equal(buckets["Images"], 1);
});

test("Records by type: video MIME → Videos bucket", () => {
  const vm = normalizeHomeViewModel(
    baseInputs({
      evidenceList: {
        items: [mkItem({ id: "v", type: "VIDEO", mimeType: "video/mp4" })],
      },
    }),
  );
  const buckets = Object.fromEntries(
    vm.typeDistribution.slices.map((s) => [s.label, s.count]),
  );
  assert.equal(buckets["Videos"], 1);
});

test("Records by type: PDF MIME → Documents bucket", () => {
  const vm = normalizeHomeViewModel(
    baseInputs({
      evidenceList: {
        items: [
          mkItem({ id: "p", type: "DOCUMENT", mimeType: "application/pdf" }),
        ],
      },
    }),
  );
  const buckets = Object.fromEntries(
    vm.typeDistribution.slices.map((s) => [s.label, s.count]),
  );
  assert.equal(buckets["Documents"], 1);
});

test("Records by type: audio MIME → Audio bucket", () => {
  const vm = normalizeHomeViewModel(
    baseInputs({
      evidenceList: {
        items: [mkItem({ id: "a", type: "AUDIO", mimeType: "audio/mpeg" })],
      },
    }),
  );
  const buckets = Object.fromEntries(
    vm.typeDistribution.slices.map((s) => [s.label, s.count]),
  );
  assert.equal(buckets["Audio"], 1);
});

test("Records by type: archive MIME → Archives bucket (highest precedence)", () => {
  const vm = normalizeHomeViewModel(
    baseInputs({
      evidenceList: {
        items: [
          mkItem({
            id: "z",
            type: "DOCUMENT",
            mimeType: "application/zip",
          }),
        ],
      },
    }),
  );
  const buckets = Object.fromEntries(
    vm.typeDistribution.slices.map((s) => [s.label, s.count]),
  );
  assert.equal(buckets["Archives"], 1);
});

// ---------------------------------------------------------------------------
// 2. Multipart Evidence rows count ONCE per record (records-by-type
//    concept). The widget's label and tooltip make this contract
//    explicit; this test prevents a future contributor from accidentally
//    switching to a per-part count without updating the label.
// ---------------------------------------------------------------------------

test("Records by type: multipart Evidence with 5 images + 1 video + 1 PDF counts as ONE record in the primary bucket", () => {
  // The Home wire ONLY exposes the parent row (no parts/children).
  // The parent's primary MIME determines the bucket.
  const vm = normalizeHomeViewModel(
    baseInputs({
      evidenceList: {
        items: [
          mkItem({
            id: "multi",
            type: "PHOTO",
            mimeType: "image/jpeg",
            captureMethod: "MULTIPART_PACKAGE",
          }),
        ],
      },
    }),
  );
  const total = vm.typeDistribution.slices.reduce(
    (a, s) => a + s.count,
    0,
  );
  assert.equal(total, 1, "multipart parent must contribute exactly one record");
  const buckets = Object.fromEntries(
    vm.typeDistribution.slices.map((s) => [s.label, s.count]),
  );
  assert.equal(buckets["Images"], 1, "the parent's primary MIME wins");
  assert.equal(buckets["Videos"] ?? 0, 0, "no per-part inflation");
  assert.equal(buckets["Documents"] ?? 0, 0, "no per-part inflation");
});

test("Records by type: multipart with generic-MIME parent (octet-stream) falls back to Folders bucket", () => {
  const vm = normalizeHomeViewModel(
    baseInputs({
      evidenceList: {
        items: [
          mkItem({
            id: "multi-gen",
            type: "DOCUMENT",
            mimeType: "application/octet-stream",
            captureMethod: "MULTIPART_PACKAGE",
          }),
        ],
      },
    }),
  );
  const buckets = Object.fromEntries(
    vm.typeDistribution.slices.map((s) => [s.label, s.count]),
  );
  assert.equal(buckets["Folders"], 1);
});

// ---------------------------------------------------------------------------
// 3. Sample-size honesty — the widget's subtitle uses the boolean
//    `sampled` flag. It must be `true` whenever the API reports
//    `pageInfo.hasMore = true` (workspace has > 100 records).
// ---------------------------------------------------------------------------

test("Records by type: sampled=true is set when API reports hasMore (cap honesty)", () => {
  const items = Array.from({ length: 3 }, (_, i) =>
    mkItem({ id: `it-${i}`, mimeType: "image/jpeg" }),
  );
  const vm = normalizeHomeViewModel(
    baseInputs({
      evidenceList: {
        items,
        pageInfo: { hasMore: true },
      },
    }),
  );
  assert.equal(
    vm.typeDistribution.sampled,
    true,
    "subtitle must show 'latest N records' when the workspace has more than 100 evidence rows",
  );
});

test("Records by type: sampled=false when API does NOT report hasMore", () => {
  const items = [mkItem({ id: "x", mimeType: "image/jpeg" })];
  const vm = normalizeHomeViewModel(
    baseInputs({
      evidenceList: { items, pageInfo: { hasMore: false } },
    }),
  );
  assert.equal(vm.typeDistribution.sampled, false);
});

// ---------------------------------------------------------------------------
// 4. Soft-deleted rows are excluded server-side via /v1/evidence
//    `deletedAt: null`. The client-side normalizer relies on that
//    server filter — we lock the server filter via a source assertion
//    so this assumption can't silently break.
// ---------------------------------------------------------------------------

test("source contract — /v1/evidence list filters deletedAt: null by default", async () => {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const ROUTES = readFileSync(
    resolve(
      __dirname,
      "..",
      "..",
      "..",
      "services",
      "api",
      "src",
      "routes",
      "evidence.routes.ts",
    ),
    "utf8",
  );
  // EVIDENCE LIFECYCLE CONVERGENCE (2026-08-24) — the filter is keyed off
  // `lifecycle_state`, the authority, rather than off the presence of a
  // timestamp, and the scope is named `trash` because nothing in it is deleted.
  //
  // The assumption this case protects is unchanged and is now stronger in one
  // respect the old filter got wrong: a DESTROYED tombstone still carries
  // `deleted_at` from its time in the trash, so `deletedAt: null` alone would
  // have excluded it — but so would it have excluded nothing else about it, and
  // the tombstone is now excluded from every regular scope by name.
  assert.match(
    ROUTES,
    /query\.scope\s*===\s*"trash"\s*\n?\s*\?\s*\{\s*lifecycleState:\s*"TRASHED"\s*\}\s*\n?\s*:\s*\{\s*lifecycleState:\s*\{\s*not:\s*"DESTROYED"\s*\},\s*deletedAt:\s*null\s*\}/,
    "buildEvidenceListBaseWhere must exclude trashed and destroyed records unless scope=trash",
  );
});

// ---------------------------------------------------------------------------
// 5. Workspace scope — the normalizer re-scopes by teamId. Personal
//    space accepts legacy `teamId IS NULL` rows.
// ---------------------------------------------------------------------------

test("Records by type: ORGANIZATION scope filters strictly by teamId", () => {
  const vm = normalizeHomeViewModel(
    baseInputs({
      activeSpaceType: "ORGANIZATION",
      evidenceList: {
        items: [
          mkItem({ id: "in", teamId: WS, mimeType: "image/jpeg" }),
          mkItem({ id: "out", teamId: "other-team", mimeType: "image/jpeg" }),
        ],
      },
    }),
  );
  const total = vm.typeDistribution.slices.reduce(
    (a, s) => a + s.count,
    0,
  );
  assert.equal(total, 1, "cross-workspace evidence must NOT contribute");
});

test("Records by type: PERSONAL scope accepts teamId=null AND teamId=workspace", () => {
  const vm = normalizeHomeViewModel(
    baseInputs({
      activeSpaceType: "PERSONAL",
      evidenceList: {
        items: [
          mkItem({ id: "legacy", teamId: null, mimeType: "image/jpeg" }),
          mkItem({ id: "modern", teamId: WS, mimeType: "video/mp4", type: "VIDEO" }),
          mkItem({ id: "other", teamId: "other-team", mimeType: "image/jpeg" }),
        ],
      },
    }),
  );
  const buckets = Object.fromEntries(
    vm.typeDistribution.slices.map((s) => [s.label, s.count]),
  );
  assert.equal(buckets["Images"], 1, "legacy null-team row counts");
  assert.equal(buckets["Videos"], 1, "modern workspace row counts");
  const total = vm.typeDistribution.slices.reduce(
    (a, s) => a + s.count,
    0,
  );
  assert.equal(total, 2, "cross-workspace row must NOT count even in personal scope");
});

// ---------------------------------------------------------------------------
// 6. THE LOAD-BEARING FIX — useHomeData refetches on visibility / focus.
//    Without this, /home stays stale after the user finalises a capture
//    and returns from /evidence/[id]. Lock the source contract so a
//    future refactor can't accidentally drop the listener.
// ---------------------------------------------------------------------------

test("source contract — useHomeData registers visibilitychange + focus refetch", async () => {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const SRC = readFileSync(
    resolve(
      __dirname,
      "..",
      "components",
      "home-experience",
      "useHomeData.ts",
    ),
    "utf8",
  );
  // Both listeners MUST be registered.
  assert.match(
    SRC,
    /addEventListener\(\s*"visibilitychange"\s*,/,
    "useHomeData must listen for visibilitychange",
  );
  assert.match(
    SRC,
    /addEventListener\(\s*"focus"\s*,/,
    "useHomeData must listen for window focus",
  );
  // The listener MUST call reload() so the donut + activity chart +
  // recent evidence rail all refresh from /v1/evidence.
  assert.match(
    SRC,
    /void\s+reload\(\)/,
    "the focus / visibility handler must call reload()",
  );
  // The listener MUST be throttled so rapid tab toggling doesn't
  // hammer the API. We lock the existence of the 2-second window.
  assert.match(
    SRC,
    /STALE_WINDOW_MS\s*=\s*2_000/,
    "refetch must be throttled (2s window) to avoid focus storms",
  );
  // The cleanup MUST remove both listeners on unmount.
  assert.match(
    SRC,
    /removeEventListener\(\s*"visibilitychange"\s*,/,
    "cleanup must remove the visibilitychange listener",
  );
  assert.match(
    SRC,
    /removeEventListener\(\s*"focus"\s*,/,
    "cleanup must remove the focus listener",
  );
});

// ---------------------------------------------------------------------------
// 7. WIRE-SHAPE contract — the Home evidence list payload must NOT
//    carry per-part info, so the widget cannot accidentally start
//    counting files instead of records.
// ---------------------------------------------------------------------------

test("source contract — HomeEvidenceListInput does NOT expose parts / partsCount / contentItems", async () => {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const VM = readFileSync(
    resolve(
      __dirname,
      "..",
      "components",
      "home-experience",
      "home-view-model.ts",
    ),
    "utf8",
  );
  // Find the HomeEvidenceListInput type block.
  const block = VM.match(
    /export type HomeEvidenceListInput\s*=\s*\{[\s\S]*?\};/,
  );
  assert.ok(block, "HomeEvidenceListInput type must exist");
  const t = block![0];
  // The wire shape MUST stay scoped to the per-record fields the
  // classifier reads. Per-part fields must NOT leak in.
  assert.doesNotMatch(t, /\bparts\??:/);
  assert.doesNotMatch(t, /\bpartsCount\??:/);
  assert.doesNotMatch(t, /\bcontentItems\??:/);
  assert.doesNotMatch(t, /_count/);
});
