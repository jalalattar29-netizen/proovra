/**
 * Investigation Suite audit — source-contract pins for the 8 minimal
 * fixes that landed under the investigation-suite audit window.
 *
 * The audit synthesis identified five investigation pages whose empty
 * states leaked producer-mode jargon and one route (investigation
 * reviewers) whose persona fit no longer warranted always-on sidebar
 * placement. This test pins:
 *
 *   1. EMPTY_STATE_COPY — each investigation page no longer renders
 *      the legacy "data unavailable" / "indexing existing rows only"
 *      raw phrases as user-facing copy AND renders the new
 *      operator-readable copy.
 *   2. NAV_VISIBILITY — the routeRegistry entry for
 *      `investigation.reviewers` carries the new sidebarEligible:
 *      false + commandPaletteVisible: true + allToolsVisible: true
 *      booleans (reviewer-only sidebar surface, still cmd-K
 *      reachable).
 *   3. DISABLED_STATE_POLISH — the disabled producer-mode panel on
 *      the reviewers page does not render any env-var-style
 *      ALL_CAPS_WITH_UNDERSCORES tokens inside <code> blocks or as
 *      plain JSX text.
 *   4. Bounded sweep — no investigation page contains the literal
 *      "data unavailable" rendered as user-facing copy.
 *
 * Style: source-contract (file-text assertions). No DB I/O, no HTTP.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve, relative } from "node:path";

import { describe, expect, it } from "vitest";

const WEB_ROOT = fileURLToPath(new URL("../../../apps/web", import.meta.url));

const INVESTIGATION_DIR = resolve(WEB_ROOT, "app/(app)/investigation");

const PAGES = {
  hub: resolve(INVESTIGATION_DIR, "page.tsx"),
  reviewers: resolve(INVESTIGATION_DIR, "reviewers/page.tsx"),
  timeline: resolve(INVESTIGATION_DIR, "timeline/page.tsx"),
  duplicates: resolve(INVESTIGATION_DIR, "duplicates/page.tsx"),
  graph: resolve(INVESTIGATION_DIR, "graph/page.tsx"),
} as const;

const REGISTRY_PATH = resolve(WEB_ROOT, "lib/navigation/routeRegistry.ts");

// Wave 2 classifier swap: the canonical empty-state body copy moved
// out of the page files into CLASSIFICATION_COPY on the operational
// primitive. The page is still the source of truth for which domain
// to classify (via `classifyInvestigationEmptyState(..., 'timeline')`
// etc.) and for the CTAs (nextAction + adminAction); the primitive
// renders the kicker + title from the resolved EmptyStateClassification.
// These pins look in BOTH places.
const OPERATIONAL_EMPTY_STATE_PATH = resolve(
  WEB_ROOT,
  "components/operational/OperationalEmptyState.tsx",
);
const PRODUCER_MODE_PATH = resolve(
  WEB_ROOT,
  "../../packages/shared-runtime/src/media-intelligence/producer-mode.ts",
);
function readClassificationCopy(): string {
  return readFileSync(OPERATIONAL_EMPTY_STATE_PATH, "utf8");
}
function readProducerMode(): string {
  return readFileSync(PRODUCER_MODE_PATH, "utf8");
}

function readPage(p: string): string {
  return readFileSync(p, "utf8");
}

/**
 * Strip block comments + line comments so assertions about
 * user-facing JSX copy don't false-positive on a documenting
 * comment that mentions the legacy phrase.
 */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = resolve(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (name === "node_modules" || name === ".next" || name === "dist") {
        continue;
      }
      out.push(...walk(full));
      continue;
    }
    if (name.endsWith(".tsx")) {
      out.push(full);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Fix #1, #2, #3, #4, #5 — EMPTY_STATE_COPY across the 5 investigation pages
// ---------------------------------------------------------------------------

describe("Investigation Suite audit — EMPTY_STATE_COPY pins", () => {
  it("investigation hub renders the new 'No analyses recorded yet' empty-state copy (fix #1)", () => {
    const src = readPage(PAGES.hub);
    // New operator-readable copy from synthesis fix #1.
    expect(src).toMatch(/No analyses recorded yet/);
    // Stripped of comments, no raw "data unavailable" string lands in
    // user-facing JSX (we allow it inside a /* */ comment).
    const stripped = stripComments(src);
    expect(stripped).not.toMatch(/data unavailable/i);
  });

  it("investigation reviewers renders the new operator-readable producer-mode copy (fix #2)", () => {
    const src = readPage(PAGES.reviewers);
    // formatModeLabel mapping was rewritten — the old labels are
    // gone, the new ones are present.
    expect(src).toMatch(/automatic extraction off/);
    expect(src).toMatch(/existing content searchable/);
    // The legacy producer-mode chip phrases must not appear as
    // user-facing copy.
    const stripped = stripComments(src);
    expect(stripped).not.toMatch(/indexing existing rows only/i);
    expect(stripped).not.toMatch(/data unavailable/i);
    // The disabled-panel banner now uses the combined fix-#2 + #8
    // copy with a bounded "contact your workspace administrator"
    // pointer (no raw env names — see DISABLED_STATE_POLISH below).
    expect(src).toMatch(/Automatic extraction is off/);
    expect(src).toMatch(/workspace administrator/);
  });

  it("investigation timeline renders the new 'No workspace events recorded yet' empty-state copy (fix #3)", () => {
    // Wave 2 classifier swap: the timeline empty-state body copy now
    // lives in CLASSIFICATION_COPY (TRUE_EMPTY title) + the classifier
    // resolver's TRUE_EMPTY_GENERIC reason. The page is still the
    // truth-source for which domain to classify ('timeline'). Assert
    // BOTH: the page calls the classifier with domain 'timeline', and
    // the canonical CLASSIFICATION_COPY entry says "Nothing has been
    // recorded here yet." (semantic equivalent of the legacy "No
    // workspace events recorded yet").
    const src = readPage(PAGES.timeline);
    expect(src).toMatch(/classifyInvestigationEmptyState[\s\S]*?"timeline"/);
    const classificationCopy = readClassificationCopy();
    expect(classificationCopy).toMatch(
      /TRUE_EMPTY:\s*\{[\s\S]*?title:\s*"Nothing has been recorded here yet\."/,
    );
    // Legacy "Run the analyzer…" empty-state phrasing is gone.
    const stripped = stripComments(src);
    expect(stripped).not.toMatch(/Run the analyzer/i);
    expect(stripped).not.toMatch(/data unavailable/i);
  });

  it("investigation duplicates renders the perceptual-similarity caveat (fix #4)", () => {
    // Wave 2 classifier swap: the perceptual-similarity caveat now
    // flows from the producer-mode resolver (PRODUCER_REASON_COPY)
    // through the classifier into CLASSIFICATION_COPY's
    // CAPABILITY_UNAVAILABLE / FEATURE_NOT_CONFIGURED entries. The
    // duplicates page consults the resolver for `perceptual_similarity`
    // and passes the bounded status into the classifier — the resolver
    // is the canonical truth source for the caveat language.
    const src = readPage(PAGES.duplicates);
    expect(src).toMatch(/p\.kind === "perceptual_similarity"/);
    expect(src).toMatch(/classifyInvestigationEmptyState[\s\S]*?"duplicates"/);
    // The classifier-primitive copy is bounded.
    const classificationCopy = readClassificationCopy();
    expect(classificationCopy).toMatch(/CAPABILITY_UNAVAILABLE/);
    expect(classificationCopy).toMatch(/FEATURE_NOT_CONFIGURED/);
    // And the producer-mode resolver still emits the NOT_CONFIGURED
    // honesty reason for the perceptual_similarity kind when not wired.
    const producerMode = readProducerMode();
    expect(producerMode).toMatch(
      /kind:\s*"perceptual_similarity"[\s\S]{0,400}NOT_CONFIGURED/,
    );
    const stripped = stripComments(src);
    expect(stripped).not.toMatch(/data unavailable/i);
  });

  it("investigation graph renders the new 'No graph yet' empty-state copy (fix #5)", () => {
    // Wave 2 classifier swap: the graph empty-state body lives in
    // CLASSIFICATION_COPY now. The page surfaces "No graph yet" in the
    // freshness pill (error path) AND wires the classifier-driven
    // OperationalEmptyState for the no-seeds path. Assert BOTH the
    // page's classifier call and the primitive's bounded TRUE_EMPTY copy.
    const src = readPage(PAGES.graph);
    expect(src).toMatch(/No graph yet/);
    expect(src).toMatch(/classifyInvestigationEmptyState[\s\S]*?"graph"/);
    const classificationCopy = readClassificationCopy();
    expect(classificationCopy).toMatch(
      /TRUE_EMPTY:\s*\{[\s\S]*?title:\s*"Nothing has been recorded here yet\."/,
    );
    const stripped = stripComments(src);
    expect(stripped).not.toMatch(/data unavailable/i);
    // Legacy per-section "No case seeds in this workspace yet" copy
    // was replaced — fix #5 rewords the global empty state.
    expect(stripped).not.toMatch(/No case seeds in this workspace yet/);
  });
});

// ---------------------------------------------------------------------------
// Fix #6 — CTA_LINK: each investigation page's empty state offers a path
// back to capture + cases.
// ---------------------------------------------------------------------------

describe("Investigation Suite audit — CTA_LINK pins (fix #6)", () => {
  const FILES_WITH_CTAS: ReadonlyArray<keyof typeof PAGES> = [
    "hub",
    "timeline",
    "duplicates",
    "graph",
  ];

  for (const name of FILES_WITH_CTAS) {
    it(`investigation ${name} empty-state offers /capture + /cases CTAs`, () => {
      const src = readPage(PAGES[name]);
      // Wave 2 classifier swap: the canonical CTAs now flow through
      // OperationalEmptyState.nextAction + adminAction (object literals
      // with `href:`) instead of inline next/link href="…" strings.
      // The intent — every empty-state offers /capture + /cases — is
      // preserved; just match either form so the pin survives the
      // classifier-primitive swap.
      const captureHref = /href[=:]\s*["']\/capture["']/;
      const casesHref = /href[=:]\s*["']\/cases["']/;
      expect(src).toMatch(captureHref);
      expect(src).toMatch(casesHref);
      // Visible button labels.
      expect(src).toMatch(/Capture evidence/);
      expect(src).toMatch(/Open cases/);
    });
  }
});

// ---------------------------------------------------------------------------
// Fix #7 — NAV_VISIBILITY: investigation.reviewers persona-fit flip
// ---------------------------------------------------------------------------

describe("Investigation Suite audit — NAV_VISIBILITY pin (fix #7)", () => {
  it("routeRegistry entry for investigation.reviewers is reviewer-only on the sidebar but reachable via cmd-K + All Tools", () => {
    const registry = readFileSync(REGISTRY_PATH, "utf8");
    // The entry block must declare the new visibility booleans.
    // The synthesis fix flips sidebarEligible from true to false
    // while keeping commandPaletteVisible + allToolsVisible true.
    expect(registry).toMatch(
      /id:\s*"investigation\.reviewers"[\s\S]{0,2000}sidebarEligible:\s*false/,
    );
    expect(registry).toMatch(
      /id:\s*"investigation\.reviewers"[\s\S]{0,2000}commandPaletteVisible:\s*true/,
    );
    expect(registry).toMatch(
      /id:\s*"investigation\.reviewers"[\s\S]{0,2000}allToolsVisible:\s*true/,
    );
  });

  it("routeRegistry leaves backend gating unchanged for investigation.reviewers (capability + active space + fallback)", () => {
    const registry = readFileSync(REGISTRY_PATH, "utf8");
    // Backend gating is the authority — the audit fix is UI-only.
    expect(registry).toMatch(
      /id:\s*"investigation\.reviewers"[\s\S]{0,2000}requiredCapabilities:\s*\[\s*"EVIDENCE_VIEW"\s*\]/,
    );
    expect(registry).toMatch(
      /id:\s*"investigation\.reviewers"[\s\S]{0,2000}requiredActiveSpace:\s*"PERSONAL_OR_ORG"/,
    );
    expect(registry).toMatch(
      /id:\s*"investigation\.reviewers"[\s\S]{0,2000}fallbackBehavior:\s*"DEGRADED"/,
    );
  });
});

// ---------------------------------------------------------------------------
// Fix #8 — DISABLED_STATE_POLISH: no env-var-style ALL_CAPS_WITH_UNDERSCORES
// tokens render inside <code> or as plain JSX text on the disabled panel.
// ---------------------------------------------------------------------------

describe("Investigation Suite audit — DISABLED_STATE_POLISH pin (fix #8)", () => {
  it("reviewers page does NOT render any <code> blocks containing env-var-style ALL_CAPS_WITH_UNDERSCORES tokens", () => {
    const src = readPage(PAGES.reviewers);
    // The audit rule forbids deployment-internal env-var names from
    // surfacing as operator-visible copy. Match any <code>…</code>
    // body whose entire contents are an ALL_CAPS_WITH_UNDERSCORES
    // identifier of 2+ underscore-separated segments (the env-var
    // shape we care about).
    const codeBlockRe = /<code[^>]*>\s*([A-Z][A-Z0-9_]*)\s*<\/code>/g;
    const offenders: string[] = [];
    let m: RegExpExecArray | null;
    while ((m = codeBlockRe.exec(src)) != null) {
      const token = m[1] ?? "";
      // Env-var shape: at least one underscore, all-caps with
      // letters + digits + underscores.
      if (/^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/.test(token)) {
        offenders.push(token);
      }
    }
    expect(offenders, offenders.join(",")).toEqual([]);
  });

  it("reviewers disabled-panel hint copy does NOT render env-var-style tokens as plain JSX text", () => {
    const src = readPage(PAGES.reviewers);
    const stripped = stripComments(src);
    // Block deployment-internal env names that the synthesis fix
    // explicitly cleaned out of the disabled-panel banner.
    const forbidden = [
      "MEDIA_INTELLIGENCE_OCR_PROVIDER",
      "MEDIA_INTELLIGENCE_TRANSCRIPT_PROVIDER",
      "MEDIA_INTELLIGENCE_OCR_MODE",
      "MEDIA_INTELLIGENCE_TRANSCRIPT_MODE",
      "OCR_PROVIDER_MODE",
      "TRANSCRIPT_PROVIDER_MODE",
    ];
    for (const tok of forbidden) {
      expect(stripped).not.toMatch(new RegExp(tok));
    }
  });

  it("reviewers disabled-panel banner uses the bounded 'Configuration required' phrasing (fix #8)", () => {
    const src = readPage(PAGES.reviewers);
    expect(src).toMatch(/Configuration required/);
    // The bounded admin pointer that replaces the runbook variable
    // reference.
    expect(src).toMatch(/workspace administrator/);
  });
});

// ---------------------------------------------------------------------------
// Bounded sweep — none of the 5 audited investigation pages contain the
// literal "data unavailable" rendered as user-facing copy.
//
// Scope note: the audit fix window covers the 5 top-level investigation
// suite surfaces (hub, reviewers, timeline, duplicates, graph). Nested
// case-scoped investigation pages (e.g. /investigation/cases/[caseId]/…)
// are governed by a different surface and were intentionally out of
// scope for the audit's safe-fix window — this sweep does NOT cover
// those files.
// ---------------------------------------------------------------------------

describe("Investigation Suite audit — bounded sweep across audited pages", () => {
  it("none of the 5 audited investigation pages render the literal 'data unavailable' as user-facing copy", () => {
    const offenders: string[] = [];
    for (const [name, file] of Object.entries(PAGES)) {
      const stripped = stripComments(readFileSync(file, "utf8"));
      if (/data unavailable/i.test(stripped)) {
        offenders.push(`${name}: ${relative(WEB_ROOT, file).replace(/\\/g, "/")}`);
      }
    }
    expect(offenders, offenders.join("\n")).toEqual([]);
  });
});
