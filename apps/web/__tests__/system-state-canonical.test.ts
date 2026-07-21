/**
 * Canonical system-state contracts (2026-07-21 rebuild).
 *
 * ONE full-surface visual system (`ProovraSystemState`) for every error /
 * denial / recovery / unavailable state, shared by public and
 * authenticated contexts. Only the recovery ACTIONS and whether the App
 * Shell stays mounted differ by context. These are source-contract
 * assertions (no brittle snapshots) that pin the acceptance criteria.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { readFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string): string => readFileSync(resolve(APP_ROOT, rel), "utf8");
const exists = (rel: string): boolean => existsSync(resolve(APP_ROOT, rel));

// ---------------------------------------------------------------------------
// 1. Canonical component exists; the superseded one is physically gone
// ---------------------------------------------------------------------------

test("canonical ProovraSystemState + SystemStateSymbol + ProovraDenialState exist", () => {
  assert.ok(exists("components/feedback/ProovraSystemState.tsx"));
  assert.ok(exists("components/feedback/SystemStateSymbol.tsx"));
  assert.ok(exists("components/feedback/ProovraDenialState.tsx"));
});

test("the superseded ProovraErrorState is physically deleted", () => {
  assert.ok(!exists("components/feedback/ProovraErrorState.tsx"), "old centered-card state removed");
  const barrel = read("components/feedback/index.ts");
  assert.ok(!barrel.includes("ProovraErrorState"), "no barrel export of the old state");
});

test("ProovraSystemState is a page-level composition, not a floating 480px card", () => {
  const src = read("components/feedback/ProovraSystemState.tsx");
  assert.ok(!/maxWidth:\s*480\b/.test(src), "no fixed 480px island");
  assert.match(src, /clamp\(/, "fluid tokenized sizing");
  assert.match(src, /SystemStateSymbol/, "uses the restrained line symbol");
  assert.match(src, /ProovraSupportReference/, "trace ids via the sanctioned surface");
});

test("SystemStateSymbol is a restrained line glyph — no childish chip", () => {
  const src = read("components/feedback/SystemStateSymbol.tsx");
  assert.match(src, /stroke:\s*"currentColor"/, "inherits foreground, no saturated fill");
  assert.ok(!/🚫|⚠️|😀|🙁/.test(src), "no emoji");
  assert.ok(!/linear-gradient/.test(src), "no gradient icon block");
});

// ---------------------------------------------------------------------------
// 2. Public + authenticated boundaries share the primitive
// ---------------------------------------------------------------------------

const BOUNDARIES: ReadonlyArray<{ rel: string; context: string }> = [
  { rel: "app/not-found.tsx", context: "public" },
  { rel: "app/error.tsx", context: "public" },
  { rel: "app/global-error.tsx", context: "public" },
  { rel: "app/(app)/not-found.tsx", context: "authenticated" },
  { rel: "app/(app)/error.tsx", context: "authenticated" },
];

for (const { rel, context } of BOUNDARIES) {
  test(`${rel} uses the canonical system with context="${context}"`, () => {
    const src = read(rel);
    assert.match(src, /ProovraSystemState/, "shared visual primitive");
    assert.match(src, new RegExp(`context="${context}"`), "context is explicit");
  });
}

test("global-error stays self-contained (own <html>, no marketing chrome)", () => {
  const src = read("app/global-error.tsx");
  assert.match(src, /<html/, "own html shell");
  // No IMPORT of marketing chrome (a comment may name it).
  assert.ok(
    !/import[^\n]*(MarketingHeader|EnterpriseFooter)/.test(src),
    "no chrome import that could recursively fail",
  );
});

// ---------------------------------------------------------------------------
// 3. Context changes ACTIONS, not the design system
// ---------------------------------------------------------------------------

test("authenticated boundaries never recover to public marketing pages in-tab", () => {
  for (const rel of [
    "app/(app)/not-found.tsx",
    "app/(app)/error.tsx",
  ]) {
    const src = read(rel);
    assert.ok(!/href:\s*"\/platform"/.test(src), `${rel}: no /platform escape`);
    assert.ok(!/href:\s*"\/pricing"/.test(src), `${rel}: no public /pricing escape`);
    assert.ok(!/href:\s*"\/"[,\s}]/.test(src), `${rel}: no marketing homepage escape`);
    assert.match(src, /href:\s*"\/home"/, `${rel}: in-app dashboard recovery`);
  }
});

test("authenticated support actions open the public /support in a NEW tab", () => {
  for (const rel of [
    "app/(app)/not-found.tsx",
    "app/(app)/error.tsx",
    "components/surface/SurfaceGate.tsx",
  ]) {
    const src = read(rel);
    // Every /support action in an authenticated surface is external.
    const supportActions = src.match(/href:\s*"\/support"[\s\S]{0,120}?\}/g) ?? [];
    assert.ok(supportActions.length > 0, `${rel}: has a /support action`);
    for (const a of supportActions) {
      assert.match(a, /external:\s*true/, `${rel}: /support must be a new-tab external action`);
    }
  }
});

// ---------------------------------------------------------------------------
// 4. Route error boundaries migrated off the bespoke red panels
// ---------------------------------------------------------------------------

for (const rel of [
  "app/(app)/evidence-lifecycle/error.tsx",
  "app/(app)/investigation/error.tsx",
]) {
  test(`${rel} uses the canonical state, not a bespoke red panel`, () => {
    const src = read(rel);
    assert.match(src, /ProovraSystemState/);
    assert.ok(!/#fef2f2|#fecaca|#7f1d1d/.test(src), "no hardcoded red-panel palette");
    assert.match(src, /reset\(\)/, "retry/reset preserved");
  });
}

// ---------------------------------------------------------------------------
// 5. Gates migrated onto the canonical system — no legacy dark gradients
// ---------------------------------------------------------------------------

for (const rel of [
  "components/access/AccessGate.tsx",
  "lib/platform-context/CapabilityDegradedPanel.tsx",
  "lib/platform-context/WorkspaceRecoveryPanel.tsx",
  "components/navigation/PageRouteGate.tsx",
  "components/surface/SurfaceGate.tsx",
]) {
  test(`${rel} is on the canonical system with no legacy dark gradient`, () => {
    const src = read(rel);
    assert.ok(
      /ProovraDenialState|ProovraSystemState/.test(src),
      "renders through the canonical system",
    );
    assert.ok(
      !/rgba\(8,18,22|rgba\(20,30,34|rgba\(12,20,24/.test(src),
      "no legacy dark-gradient card",
    );
  });
}

test("AccessGate no longer offers same-tab public marketing recovery", () => {
  const src = read("components/access/AccessGate.tsx");
  assert.ok(!/href:\s*"\/pricing"/.test(src), "no /pricing (public) escape");
  // /tools is INTERNAL/notFound for non-admins — must not be a default action.
  assert.ok(!/label:\s*"Browse tools"/.test(src), "no /tools default recovery");
});

test("WorkspaceRecoveryPanel surfaces the request id via the sanctioned reference", () => {
  const src = read("lib/platform-context/WorkspaceRecoveryPanel.tsx");
  assert.match(src, /supportReference=/, "uses the canonical support reference");
  assert.ok(!/<code>\{/.test(src), "no ad-hoc raw <code>{id}</code> request id");
});

// ---------------------------------------------------------------------------
// 6. Enterprise full-page layout refinement (2026-07-21)
//    Full-page states must read as composed page-level compositions with real
//    presence on large screens, while contained states stay compact. These
//    pin the composition so a later edit can't silently collapse full-page
//    back into a small island or inflate contained into a full-page block.
// ---------------------------------------------------------------------------

test("full-page reading column is wider than contained, and both exceed the old narrow island", () => {
  const src = read("components/feedback/ProovraSystemState.tsx");
  // Presentation-aware column: full-page 840, contained 720.
  assert.match(
    src,
    /maxWidth:\s*isFull\s*\?\s*840\s*:\s*720/,
    "column width forks on presentation (full 840 / contained 720)",
  );
  // Both are comfortably above the retired 480px island.
  assert.ok(!/maxWidth:\s*(4\d\d|[1-3]\d\d)\b/.test(src), "no sub-500 fixed reading column");
});

test("full-page and contained have SEPARATE title + message scales", () => {
  const src = read("components/feedback/ProovraSystemState.tsx");
  // Distinct constants exist and are switched by presentation.
  assert.match(src, /titleFullStyle/, "full-page title scale exists");
  assert.match(src, /titleContainedStyle/, "contained title scale exists");
  assert.match(src, /messageFullStyle/, "full-page body scale exists");
  assert.match(src, /messageContainedStyle/, "contained body scale exists");
  assert.match(
    src,
    /const\s+titleS\s*=\s*isFull\s*\?\s*titleFullStyle\s*:\s*titleContainedStyle/,
    "title style forks on presentation",
  );
  assert.match(
    src,
    /const\s+messageS\s*=\s*isFull\s*\?\s*messageFullStyle\s*:\s*messageContainedStyle/,
    "message style forks on presentation",
  );
  // Full-page title reaches a page-level H1 range (~50px top); contained stays small.
  assert.match(src, /clamp\(1\.9rem,[^)]*3\.15rem\)/, "full-page H1 fluid up to ~50px");
  assert.match(src, /clamp\(1\.35rem,[^)]*1\.7rem\)/, "contained title stays compact");
  // Symbol also forks: larger on full-page.
  assert.match(src, /size=\{isFull\s*\?\s*54\s*:\s*40\}/, "symbol scale forks on presentation");
});

test("ultrawide horizontal inset is CAPPED (never a centre-floated island)", () => {
  const src = read("components/feedback/ProovraSystemState.tsx");
  // Public inset uses a vw term that caps at 220px on ultrawide.
  assert.match(
    src,
    /clamp\(20px,\s*calc\(12vw - 24px\),\s*220px\)/,
    "public inset caps at 220px",
  );
  // Composition anchors the wrap to the top-start, never dead-centre.
  assert.match(src, /justifyContent:\s*"flex-start"/, "anchored, not vertically centred");
  assert.match(src, /alignItems:\s*"flex-start"/, "left-aligned, not horizontally centred");
  // The retired centred-island layout centred the region itself; the top-inset
  // padding is what now places the block, so a fixed 50%/center region anchor
  // must not return.
  assert.ok(
    !/regionBase[\s\S]*?justifyContent:\s*"center"/.test(src.slice(0, src.indexOf("const columnBase"))),
    "regionBase no longer centres the whole region",
  );
});

test("mobile keeps a tight, safe side gutter (horizontal insets floor at 20px)", () => {
  const src = read("components/feedback/ProovraSystemState.tsx");
  // Both horizontal (vw-based) full-page insets floor at exactly 20px so a
  // phone never over-insets — the public `vw − offset` term is engineered so
  // that floor lands at ~22px on a 390px screen, not the ~43px a bare 11vw
  // would give.
  assert.match(src, /clamp\(20px,\s*calc\(12vw - 24px\),\s*220px\)/, "public gutter floors at 20px");
  assert.match(src, /clamp\(20px,\s*4vw,\s*64px\)/, "authenticated gutter floors at 20px");
  // The public inset is the only one allowed a large (220px) upper cap; the
  // authenticated one caps modestly (64px) since it renders inside the shell.
  assert.ok(!/clamp\(20px,\s*4vw,\s*(1\d\d|[2-9]\d\d)px\)/.test(src), "authenticated inset stays modest");
});

test("public full-page fills the viewport; authenticated stays in-shell (70vh)", () => {
  const src = read("components/feedback/ProovraSystemState.tsx");
  assert.match(
    src,
    /minHeight\s*\?\?\s*\(context === "public"\s*\?\s*"100dvh"\s*:\s*"70vh"\)/,
    "context-aware default height removes the short two-tone public band",
  );
});

test("ProovraDenialState (gate preset) defaults to the COMPACT contained scale", () => {
  const src = read("components/feedback/ProovraDenialState.tsx");
  assert.match(src, /presentation\s*=\s*"contained"/, "denial preset is contained by default");
  assert.match(src, /context\s*=\s*"authenticated"/, "denial preset is authenticated by default");
});
