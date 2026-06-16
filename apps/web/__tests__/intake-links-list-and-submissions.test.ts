/**
 * Intake-links-e2e Phases 2 + 3 + 4 — list UI + submissions drawer
 * + delivery-tracking source-contract.
 */

import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = resolve(dirname(__filename), "..", "..", "..");
const PAGE = resolve(REPO_ROOT, "apps/web/app/(app)/intake-links/page.tsx");

function read(p: string): string {
  return readFileSync(p, "utf8");
}

test("Phase 2 — list endpoint consumed as `items` envelope (not legacy `links`)", () => {
  const src = read(PAGE);
  assert.match(
    src,
    /const \[items, setItems\] = useState<LinkListItem\[\] \| null>\(null\)/,
  );
  // The refetch helper must read `items` from the response, not the
  // legacy `links` array (which is only kept for the bare-row create
  // flow).
  assert.match(src, /setItems\(res\.items \?\? \[\]\)/);
});

test("Phase 2 — list renders IntakeLinkCard per item with lifecycle data-attr", () => {
  const src = read(PAGE);
  assert.match(src, /data-intake-links-list="true"/);
  assert.match(src, /function IntakeLinkCard\(/);
  assert.match(src, /data-intake-link-lifecycle=\{computedLifecycle\}/);
  assert.match(src, /data-intake-link-lifecycle-chip="true"/);
});

test("Phase 2 — every lifecycle state has a label + chip style", () => {
  const src = read(PAGE);
  // The LIFECYCLE_LABELS + LIFECYCLE_CHIP_STYLES constants must
  // enumerate all 8 states; missing one would render `undefined` in
  // the chip.
  for (const state of [
    "CREATED",
    "SENT",
    "DELIVERY_FAILED",
    "OPENED",
    "STARTED",
    "SUBMITTED",
    "EXPIRED",
    "REVOKED",
  ]) {
    assert.ok(
      src.includes(`${state}:`),
      `LIFECYCLE_LABELS / LIFECYCLE_CHIP_STYLES missing entry for ${state}`,
    );
  }
});

test("Phase 2 — delivery + activity summary helpers produce SMB-friendly copy", () => {
  const src = read(PAGE);
  assert.match(src, /function describeDeliverySummary\(/);
  assert.match(src, /function describeActivitySummary\(/);
  // Spot-check the empty / not-sent copy so SMB users never see "null".
  assert.match(src, /Delivery: not sent yet \(manual link\)\./);
  assert.match(src, /Not opened yet\./);
});

test("Phase 2 — View submissions button is gated on sessionsCreated > 0 (no fake action)", () => {
  const src = read(PAGE);
  assert.match(
    src,
    /activity\.sessionsCreated > 0 \? \(\s*\n?\s*<button[\s\S]{0,500}data-intake-link-view-submissions/,
  );
});

test("Phase 3 — SubmissionsDrawer fetches the real endpoint and renders the safe shape", () => {
  const src = read(PAGE);
  assert.match(src, /function SubmissionsDrawer\(/);
  assert.match(
    src,
    /\/v1\/workflow\/intake-links\/\$\{encodeURIComponent\(linkId\)\}\/submissions/,
  );
  assert.match(src, /data-intake-link-submissions-drawer="true"/);
});

test("Phase 3 — submissions row links to evidence ONLY when evidenceId is present", () => {
  const src = read(PAGE);
  // No evidenceId → no Open evidence button. Pin the ternary.
  assert.match(
    src,
    /s\.evidenceId \? \(\s*\n?\s*<a\s*\n?\s*href=\{`\/evidence\/\$\{encodeURIComponent\(s\.evidenceId\)\}`\}/,
  );
});

test("Phase 3 — submissions empty state never claims work where there is none", () => {
  const src = read(PAGE);
  assert.match(src, /data-intake-link-submissions-empty="true"/);
  assert.match(
    src,
    /No submissions yet\. The link is ready; nobody has uploaded/,
  );
});

test("Phase 5 — submit body carries `idempotencyKey` generated per-modal-mount", () => {
  const src = read(PAGE);
  assert.match(src, /idempotencyKey: submitNonce,/);
  // Nonce sources crypto.randomUUID when available with a stable
  // fallback. Pin both branches.
  assert.match(src, /crypto\.randomUUID\(\)/);
  assert.match(src, /create:\$\{Math\.random\(\)/);
});

test("Phase 6 — REQUEST_TYPES catalog now includes the 3 new seed slugs (Phase 6 backend seed)", () => {
  const src = read(PAGE);
  for (const slug of ["photos-videos", "documents", "property-damage"]) {
    assert.ok(
      src.includes(`slug: "${slug}"`),
      `REQUEST_TYPES missing Phase 6 seed slug "${slug}"`,
    );
  }
});
