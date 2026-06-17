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
const ADMIN_PAGE = resolve(
  REPO_ROOT,
  "apps/web/app/(app)/intake-links/page.tsx",
);

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

test("DELIVERY_METHODS catalog contains all 4 channels (strict-UX brief retires the fixed order pin)", () => {
  const src = read(ADMIN_PAGE);
  // Strict-UX brief shortened every label and reordered the
  // catalog (Copy link / SMS / Email / WhatsApp). The exact order
  // is no longer a UX invariant — the operator's actual default is
  // chosen by the config-aware fallback in CreateLinkModal, and
  // the dropdown order is just the choice surface. Pin only that
  // all 4 enum values still exist.
  for (const v of ['"EMAIL"', '"SMS"', '"WHATSAPP"', '"MANUAL"']) {
    assert.ok(
      src.includes(`value: ${v}`),
      `DELIVERY_METHODS catalog missing value ${v}`,
    );
  }
});

test("MANUAL label is the short 'Copy link' (strict-UX shortening) — never 'Copy link manually'", () => {
  const src = read(ADMIN_PAGE);
  // Strict-UX brief shortened "Copy link only" → "Copy link".
  assert.match(src, /value:\s*"MANUAL"[\s\S]{0,200}label:\s*"Copy link"/);
  // Both old labels must stay gone.
  assert.ok(
    !/label:\s*"Copy link manually"/.test(src),
    "old confusing label 'Copy link manually' must be removed",
  );
  assert.ok(
    !/label:\s*"Copy link only"/.test(src),
    "old verbose label 'Copy link only' must be removed (strict-UX shortened to 'Copy link')",
  );
});

test("unconfigured channels render as disabled <option>s with '— not configured' suffix", () => {
  const src = read(ADMIN_PAGE);
  assert.match(
    src,
    /disabled \? `\$\{d\.label\} — not configured` : d\.label/,
  );
  assert.match(
    src,
    /data-intake-link-delivery-method-disabled=\{\s*\n?\s*disabled \? "true" : "false"\s*\n?\s*\}/,
  );
});

test("selector onChange refuses to set an unconfigured channel — forces MANUAL fallback", () => {
  const src = read(ADMIN_PAGE);
  // Every channel branch must check transport.configured before
  // accepting the value. Pin all three.
  for (const channel of ["WHATSAPP", "EMAIL", "SMS"]) {
    assert.match(
      src,
      new RegExp(
        `next === "${channel}" && senderTransport && !senderTransport\\.${channel.toLowerCase()}\\.configured`,
      ),
      `delivery onChange missing ${channel}-not-configured guard`,
    );
  }
});

// ============================================================================
// Reveal modal — hide (not disable) Send buttons when no phone
// ============================================================================

test("reveal modal hides Send-by-SMS / Send-by-WhatsApp buttons when no recipient phone", () => {
  const src = read(ADMIN_PAGE);
  // The Send buttons are wrapped in `canSend ? (<>...</>) : null`
  // — the disabled-state version is gone.
  assert.match(
    src,
    /\{canSend \? \(\s*\n?\s*<>\s*\n?\s*<button[\s\S]{0,1500}Send by WhatsApp[\s\S]{0,200}<\/>\s*\n?\s*\) : null\}/,
  );
});
