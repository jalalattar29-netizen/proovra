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

test("Phase 2 (post-console) — page wires the operations console with the rich items envelope", () => {
  const src = read(PAGE);
  // The legacy stacked-card list (`data-intake-links-list="true"`,
  // `IntakeLinkCard`, lifecycle chip data-attrs, etc.) was replaced
  // by IntakeLinksOperationsConsole. The page must now render the
  // console and pass items through; the console owns its own
  // lifecycle chip styling, delivery copy, and activity summary.
  assert.match(src, /<IntakeLinksOperationsConsole/);
  assert.match(src, /items=\{items as ConsoleItem\[\]\}/);
  // Pin the absence of the old card so a future refactor can't
  // accidentally resurrect the stacked layout.
  assert.ok(
    !/function IntakeLinkCard\(/.test(src),
    "IntakeLinkCard was replaced by the operations console — it must not return",
  );
  // Lifecycle chip styling now lives inside the console; the page
  // file must not redeclare the legacy LIFECYCLE_LABELS /
  // LIFECYCLE_CHIP_STYLES constants.
  assert.ok(
    !/const LIFECYCLE_LABELS\s*:/.test(src),
    "LIFECYCLE_LABELS belongs to the console now",
  );
  assert.ok(
    !/const LIFECYCLE_CHIP_STYLES\s*:/.test(src),
    "LIFECYCLE_CHIP_STYLES belongs to the console now",
  );
});

test("Phase 2 (post-console) — every lifecycle state still has a label + chip style (now in the console)", () => {
  const CONSOLE = resolve(
    REPO_ROOT,
    "apps/web/components/intake-links/IntakeLinksOperationsConsole.tsx",
  );
  const src = read(CONSOLE);
  // The console's LIFECYCLE_LABELS + LIFECYCLE_CHIP enumerate all 8
  // states; missing one would render `undefined` in a chip.
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
      `console LIFECYCLE_LABELS / LIFECYCLE_CHIP missing entry for ${state}`,
    );
  }
});

test("Phase 2 (post-console) — submissions visibility is wired through the console row menu, gated on sessionsCreated > 0", () => {
  const CONSOLE = resolve(
    REPO_ROOT,
    "apps/web/components/intake-links/IntakeLinksOperationsConsole.tsx",
  );
  const src = read(CONSOLE);
  // The "View submissions" menu item must only render when the link
  // has at least one session — no fake action when nothing happened.
  assert.match(
    src,
    /props\.item\.activity\.sessionsCreated > 0 \? \(\s*<li>[\s\S]{0,500}data-intake-links-row-action="submissions"/,
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
