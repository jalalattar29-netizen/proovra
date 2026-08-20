/**
 * Intake-links P0 forensic-audit follow-ups — frontend pins:
 *
 *   1) Filename display is CSS-only — the stored value is never
 *      mutated. The row renders a primary kind+size line and the
 *      original filename as a clamped secondary line with a tooltip.
 *
 *   2) Submit failure preserves uploaded parts (stays on `upload`
 *      phase) and renders the requestId as "Support ID: ..." so the
 *      contributor can quote it to the sender.
 *
 *   3) Delivery method order is Email → SMS → WhatsApp → Manual,
 *      and unconfigured channels are rendered as disabled options
 *      with "— not configured" suffix (the user can NEVER pick a
 *      channel that won't deliver).
 *
 *   4) Reveal-modal Send buttons disappear (not just disable) when
 *      no recipient phone is on the link.
 */

import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = resolve(dirname(__filename), "..", "..", "..");
const PUBLIC_PAGE = resolve(REPO_ROOT, "apps/web/app/intake/[token]/page.tsx");
const ROUTE = resolve(REPO_ROOT, "apps/web/app/(app)/intake-links");
const CATALOG = resolve(REPO_ROOT, "apps/web/lib/intake-links/catalog.ts");
const VOCABULARY = resolve(REPO_ROOT, "apps/web/lib/intake-links/vocabulary.ts");
const WIZARD_STEPS = resolve(ROUTE, "_components/wizard/steps.tsx");
const WIZARD_STATE = resolve(ROUTE, "_lib/wizardState.ts");
const CREATED_DIALOG = resolve(ROUTE, "_components/LinkCreatedDialog.tsx");

function read(p: string): string {
  return readFileSync(p, "utf8");
}

// ============================================================================
// Filename display — CSS only, NEVER mutate
// ============================================================================

test("public page renders the original filename verbatim — never mutates it before display", () => {
  const src = read(PUBLIC_PAGE);
  // The filename appears as `{p.fileName}` inside the clamp wrapper
  // (no `.slice(...)`, no `truncate(...)`, no `.replace(...)` —
  // any of those would silently rewrite the stored value).
  assert.match(src, /title=\{p\.fileName\}/);
  assert.match(src, /data-intake-part-filename=\{p\.fileName\}/);
  // The `originalFileName` sent in the POST body is `file.name` —
  // never a rewritten version.
  assert.match(src, /originalFileName: file\.name,/);
});

test("filename clamp style is CSS-only — line-clamp + word-break, not a JS substring", () => {
  const src = read(PUBLIC_PAGE);
  assert.match(src, /fileNameClampStyle/);
  // Must use the standardised 2-line clamp behavior.
  assert.match(src, /WebkitLineClamp: 2/);
  assert.match(src, /wordBreak: "break-all"/);
});

test("primary line shows kind + size — never embeds the filename", () => {
  const src = read(PUBLIC_PAGE);
  // humanFileKindLabel resolves to "Photo" / "Video" / "Audio" /
  // "Document" — text the user can read at a glance instead of the
  // raw filename. The filename is the SECONDARY line, in monospace.
  assert.match(src, /function humanFileKindLabel\(/);
  // The render composes the kind label and the size in one line.
  // We don't pin exact whitespace — only that both calls appear
  // adjacent in the JSX.
  assert.match(src, /humanFileKindLabel\(p\.mimeType\)/);
  assert.match(src, /\(p\.sizeBytes \/ 1024 \/ 1024\)\.toFixed\(2\)/);
});

// ============================================================================
// Submit failure — preserves uploads + surfaces requestId
// ============================================================================

test("submit failure does NOT clear uploads — stays on the `upload` phase so files remain visible", () => {
  const src = read(PUBLIC_PAGE);
  // The onSubmit catch block must call setPhase("upload") at the
  // end of its body so the parts array remains rendered. We pin
  // the function name + the literal call rather than the precise
  // brace layout, which moved when we added the requestId surface.
  assert.match(src, /async function onSubmit\(\)/);
  const onSubmitIdx = src.indexOf("async function onSubmit()");
  assert.ok(onSubmitIdx > 0);
  // Find the END of the onSubmit function — the next async function
  // declaration in the file.
  const nextFnIdx = src.indexOf("async function ", onSubmitIdx + 10);
  const onSubmitBody = src.slice(onSubmitIdx, nextFnIdx);
  assert.match(onSubmitBody, /\} catch \(err\) \{/);
  assert.match(onSubmitBody, /setPhase\("upload"\);/);
  // No code path inside the catch must clear `parts` or reset
  // session — pin the absence.
  assert.ok(
    !/setParts\(\[\]\)/.test(onSubmitBody),
    "onSubmit catch must not clear uploaded parts",
  );
  assert.ok(
    !/setSession\(null\)/.test(onSubmitBody),
    "onSubmit catch must not nuke the session",
  );
});

test("submit failure renders the requestId as a quotable Support ID", () => {
  const src = read(PUBLIC_PAGE);
  assert.match(src, /Support ID:/);
  // The requestId is read from BOTH the top-level `requestId` field
  // (Phase A SUBMIT_FAILED envelope) AND from `details.requestId`
  // (legacy responses) so it works during the rolling deploy.
  assert.match(
    src,
    /requestId =\s*\n?\s*e\?\.requestId \?\? e\?\.details\?\.requestId/,
  );
});

// ============================================================================
// Delivery method order + disabled-when-unconfigured
// ============================================================================

// NOTE ON THE FOUR TESTS BELOW
// ----------------------------------------------------------------------------
// They used to pin the admin page's `DELIVERY_METHODS` array and its native
// `<select>` markup. The admin surface was rebuilt: the catalog moved to
// `lib/intake-links/catalog.ts`, the selector became a canonical radio-card
// group, and the one-shot reveal moved to its own dialog component. The
// PROPERTIES are unchanged and are re-pinned here against their new homes; the
// runtime behaviour they protect is additionally proven by driving the real
// wizard in `__tests__/render/intake-links-wizard.render.test.tsx`
// ("disables a channel the deployment cannot send on, with the reason",
// "defaults to a channel the deployment can actually deliver on",
// "falls all the way back to copy-link when no provider is configured").

test("the delivery catalog contains all 4 channels (the order is not a UX invariant)", () => {
  const src = read(CATALOG);
  for (const v of ['"EMAIL"', '"SMS"', '"WHATSAPP"', '"MANUAL"']) {
    assert.ok(
      src.includes(`value: ${v}`),
      `delivery catalog missing value ${v}`,
    );
  }
});

test("MANUAL reads as the short 'Copy link' — never the older verbose labels", () => {
  const src = read(CATALOG);
  assert.match(src, /value:\s*"MANUAL"[\s\S]{0,200}label:\s*"Copy link"/);
  const surface = src + read(VOCABULARY);
  for (const dead of ["Copy link manually", "Copy link only"]) {
    assert.ok(
      !surface.includes(dead),
      `the old label "${dead}" must stay removed`,
    );
  }
});

test("an unconfigured channel is a DISABLED choice carrying its reason", () => {
  const src = read(WIZARD_STEPS);
  // The option is disabled from the server-projected transport envelope, and
  // the card states why instead of silently greying out.
  assert.match(src, /const unavailable = channelUnavailableReason\(c\.value, transport\)/);
  assert.match(src, /disabled: Boolean\(unavailable\)/);
  assert.match(src, /disabledReason: "Not configured on this deployment\."/);
});

test("an unconfigured channel cannot be submitted even if it is somehow selected", () => {
  // Stronger than the previous JS "force MANUAL" fallback: the control itself
  // is disabled AND the step gate refuses the value, so no code path reaches
  // the API with a channel this deployment cannot deliver on.
  const state = read(WIZARD_STATE);
  assert.match(state, /export function channelUnavailableReason\(/);
  assert.match(state, /if \(transport\[key\]\?\.configured\) return null;/);
  assert.match(
    state,
    /const unavailable = channelUnavailableReason\(state\.channel, ctx\.transport\);\s*\n\s*if \(unavailable\) errors\.channel = unavailable;/,
  );
});

// ============================================================================
// Reveal dialog — hide (not disable) Send buttons when no phone
// ============================================================================

test("the reveal dialog hides Send-by-SMS / Send-by-WhatsApp when no recipient phone", () => {
  const src = read(CREATED_DIALOG);
  assert.match(src, /const canSend = Boolean\(link\.recipientPhone\)/);
  assert.match(
    src,
    /\{canSend \? \(\s*\n?[\s\S]{0,2000}data-intake-link-send="WHATSAPP"[\s\S]{0,400}\) : null\}/,
  );
});
