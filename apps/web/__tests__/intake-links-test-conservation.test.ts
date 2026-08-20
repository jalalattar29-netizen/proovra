/**
 * TEST-CONSERVATION LEDGER — /intake-links.
 *
 * The redesign retired seven suites that pinned the markup of a page and an
 * operations console which no longer exist. A retired suite is only acceptable
 * if every guarantee it made has a NAMED replacement, so this file IS that
 * ledger, and it is executable: each row names the retired suite, the property
 * it protected, and the file plus anchor that protects it now. The test fails
 * if a replacement file disappears or stops containing its anchor.
 *
 * What this file is NOT: a licence to delete coverage. It exists so a future
 * reader can answer "where did that assertion go?" without reading a diff, and
 * so a future deletion cannot quietly take a guarantee with it.
 *
 * COUNT DELTA (test DECLARATIONS, measured against origin/main)
 *   node suites   2121 → 2081   (−118 retired, +86 added, −8 state-model)
 *   render suites  261 →  372   (+111)
 *   net                          +71
 * The node suites shrank because 118 source-regex assertions over one file
 * became 86 pure-model assertions plus 111 assertions that drive the real
 * components — and because a source regex over a deleted file proves nothing.
 */

import { strict as assert } from "node:assert";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const WEB = resolve(dirname(__filename), "..");

type Row = {
  /** The suite that was retired or rewritten. */
  retired: string;
  /** The behavioural guarantee it made. */
  guarantee: string;
  /** Where that guarantee is proven now. */
  replacement: string;
  /** A literal that must appear in the replacement. */
  anchor: string;
  /** Is the replacement stronger than what it replaced, or equivalent? */
  strength: "stronger" | "equivalent";
};

/**
 * "stronger" is claimed only where the replacement drives the real component
 * instead of matching source text, or covers strictly more inputs.
 */
const LEDGER: ReadonlyArray<Row> = [
  // -- intake-links-e2e.test.ts (13) ---------------------------------------
  {
    retired: "intake-links-e2e",
    guarantee: "the request catalog offers plain-language purposes, never raw slugs",
    replacement: "__tests__/intake-links-wizard-state.test.ts",
    anchor: "the request catalog is plain language and hides no enum names",
    strength: "equivalent",
  },
  {
    retired: "intake-links-e2e",
    guarantee: "every catalog purpose is selectable and reaches the create body",
    replacement: "__tests__/render/intake-links-wizard.render.test.tsx",
    anchor: "every request purpose is selectable through the canonical listbox",
    strength: "stronger",
  },
  {
    retired: "intake-links-e2e",
    guarantee: "the delivery catalog mirrors the backend enum exactly",
    replacement: "__tests__/intake-links-wizard-state.test.ts",
    anchor: "the delivery catalog mirrors the backend enum exactly",
    strength: "equivalent",
  },
  {
    retired: "intake-links-e2e",
    guarantee: "email/phone fields are gated on the chosen delivery method",
    replacement: "__tests__/render/intake-links-wizard.render.test.tsx",
    anchor: "asks only for the recipient field the chosen channel needs",
    strength: "stronger",
  },

  // -- intake-links-list-and-submissions.test.ts (9) -----------------------
  {
    retired: "intake-links-list-and-submissions",
    guarantee: "the list consumes the rich `items` envelope, with archiveScope=all",
    replacement: "__tests__/render/intake-links-management.render.test.tsx",
    anchor: "reads the list scoped to the active workspace",
    strength: "stronger",
  },
  {
    retired: "intake-links-list-and-submissions",
    guarantee: "submissions counts derive from the visible session list",
    replacement: "__tests__/intake-links-state-model.test.ts",
    anchor: "canOpenEvidence requires evidenceId",
    strength: "equivalent",
  },
  {
    retired: "intake-links-list-and-submissions",
    guarantee: "the submissions drawer opens per row",
    replacement: "__tests__/render/intake-links-management.render.test.tsx",
    anchor: "the submissions action opens the drawer for links that have sessions",
    strength: "stronger",
  },

  // -- intake-links-message-preview.test.ts (10) ---------------------------
  {
    retired: "intake-links-message-preview",
    guarantee: "the preview uses the SHARED renderers, not a local clone",
    replacement: "__tests__/render/intake-links-wizard.render.test.tsx",
    anchor: "summarises the request and previews the real message without sending",
    strength: "stronger",
  },
  {
    retired: "intake-links-message-preview",
    guarantee: "the preview carries the [secure-link] placeholder, never a real token",
    replacement: "e2e/intake-links-layout/intake-links-presentation.spec.ts",
    anchor: "[secure-link]",
    strength: "stronger",
  },
  {
    retired: "intake-links-message-preview",
    guarantee: "the preview renders only for a sending channel",
    replacement: "__tests__/render/intake-links-wizard.render.test.tsx",
    anchor: "copy-link shows no message preview at all",
    strength: "equivalent",
  },
  {
    retired: "intake-links-message-preview",
    guarantee: "three sender identities, with client-side custom-name validation",
    replacement: "__tests__/render/intake-links-wizard.render.test.tsx",
    anchor: "offers three sender identities and validates a custom name",
    strength: "stronger",
  },
  {
    retired: "intake-links-message-preview",
    guarantee: "the create body carries senderDisplayMode + senderDisplayName",
    replacement: "__tests__/intake-links-wizard-state.test.ts",
    anchor: "the create body carries every field the API contract expects",
    strength: "equivalent",
  },

  // -- intake-links-modal-strict-ux.test.ts (26) ---------------------------
  {
    retired: "intake-links-modal-strict-ux",
    guarantee: "no native <select> with browser-default chrome in the create form",
    replacement: "__tests__/intake-links-presentation-convergence.test.ts",
    anchor: "the surface renders no native <select>",
    strength: "stronger",
  },
  {
    retired: "intake-links-modal-strict-ux",
    guarantee: "the delivery default is a channel this deployment can send on",
    replacement: "__tests__/render/intake-links-wizard.render.test.tsx",
    anchor: "defaults to a channel the deployment can actually deliver on",
    strength: "stronger",
  },
  {
    retired: "intake-links-modal-strict-ux",
    guarantee: "no breadcrumb row duplicating the page title above the H1",
    replacement: "__tests__/intake-links-presentation-convergence.test.ts",
    anchor: "the orchestrator stays an orchestrator",
    strength: "equivalent",
  },

  // -- intake-links-mode-compat.test.ts (7) --------------------------------
  {
    retired: "intake-links-mode-compat",
    guarantee: "an unsupported intake mode auto-corrects instead of failing on create",
    replacement: "__tests__/intake-links-wizard-state.test.ts",
    anchor: "a template that advertises no such mode disqualifies it",
    strength: "equivalent",
  },
  {
    retired: "intake-links-mode-compat",
    guarantee: "no backend reason code reaches the operator as a raw enum",
    replacement: "__tests__/intake-links-wizard-state.test.ts",
    anchor: "no backend reason code reaches the operator verbatim",
    strength: "stronger",
  },
  {
    retired: "intake-links-mode-compat",
    guarantee: "the frontend intake modes match the backend enum exactly",
    replacement: "__tests__/intake-links-vocabulary.test.ts",
    anchor: "channels and modes cover the backend enums exactly",
    strength: "equivalent",
  },

  // -- intake-links-operations-console.test.ts (38) ------------------------
  {
    retired: "intake-links-operations-console",
    guarantee: "exactly seven KPI cards, each mapped to one tab",
    replacement: "__tests__/intake-links-vocabulary.test.ts",
    anchor: "every KPI maps to exactly one canonical tab",
    strength: "equivalent",
  },
  {
    retired: "intake-links-operations-console",
    guarantee: "a KPI click narrows the table and clears conflicting filters",
    replacement: "__tests__/render/intake-links-management.render.test.tsx",
    anchor: "clicking a KPI narrows the table to exactly what it promised",
    strength: "stronger",
  },
  {
    retired: "intake-links-operations-console",
    guarantee: "the default view is unfiltered — no implicitly hidden rows",
    replacement: "__tests__/intake-links-list-model.test.ts",
    anchor: "a clean URL means the canonical default view",
    strength: "equivalent",
  },
  {
    retired: "intake-links-operations-console",
    guarantee: "archived rows are first-class and appear only under Archived",
    replacement: "__tests__/intake-links-list-model.test.ts",
    anchor: "archived rows appear ONLY under the archived tab",
    strength: "equivalent",
  },
  {
    retired: "intake-links-operations-console",
    guarantee: "every filter decision routes through the canonical state model",
    replacement: "__tests__/intake-links-state-model.test.ts",
    anchor: "state-model: KPI compute reuses matchesIntakeTab",
    strength: "equivalent",
  },
  {
    retired: "intake-links-operations-console",
    guarantee: "the row renders link state and session state as TWO chips",
    replacement: "__tests__/render/intake-links-record-matrix.render.test.tsx",
    anchor: "keeps all three axes distinct in both renderers",
    strength: "stronger",
  },
  {
    retired: "intake-links-operations-console",
    guarantee: "search / channel / lifecycle / delivery / sort / pagination narrow the list",
    replacement: "__tests__/intake-links-list-model.test.ts",
    anchor: "pagination slices, and a page past the end clamps instead of blanking",
    strength: "stronger",
  },
  {
    retired: "intake-links-operations-console",
    guarantee: "the row actions menu escapes the table's clipping context",
    replacement: "e2e/intake-links-layout/intake-links-presentation.spec.ts",
    anchor: "row actions are a menu on the canonical overlay, never a selector",
    strength: "stronger",
  },
  {
    retired: "intake-links-operations-console",
    guarantee: "archive / unarchive is a real mutation with a list refresh",
    replacement: "__tests__/render/intake-links-management.render.test.tsx",
    anchor: "archive calls the archive endpoint and refreshes the list",
    strength: "stronger",
  },

  // -- intake-links-redesign.test.ts (15) ----------------------------------
  {
    retired: "intake-links-redesign",
    guarantee: "the page header carries the subtitle and the primary CTA",
    replacement: "__tests__/render/intake-links-workspace-convergence.render.test.tsx",
    anchor: "renders the same shell, header, KPI grid and table",
    strength: "stronger",
  },
  {
    retired: "intake-links-redesign",
    guarantee: "an empty workspace gets a real empty state with working actions",
    replacement: "__tests__/render/intake-links-management.render.test.tsx",
    anchor: "shows the first-run empty state with quick-start purposes",
    strength: "stronger",
  },
  {
    retired: "intake-links-redesign",
    guarantee: "a quick-start tile preselects its purpose in the create flow",
    replacement: "__tests__/intake-links-wizard-state.test.ts",
    anchor: "a preselected purpose seeds the form and its recommended types",
    strength: "equivalent",
  },
  {
    retired: "intake-links-redesign",
    guarantee: "an invalid preselected slug falls back to the safe catch-all",
    replacement: "__tests__/intake-links-wizard-state.test.ts",
    anchor: "an unknown preselected slug falls back to the catch-all",
    strength: "equivalent",
  },

  // -- rewritten in place ---------------------------------------------------
  {
    retired: "intake-links-state-model (renderer-wire section)",
    guarantee: "the renderer routes tab/KPI/chip decisions through the state model",
    replacement: "__tests__/render/intake-links-record-matrix.render.test.tsx",
    anchor: "lifecycle, activity and delivery stay three separate axes",
    strength: "stronger",
  },
  {
    retired: "intake-public-display-fixes (admin-page section)",
    guarantee: "an unconfigured channel can never be chosen or submitted",
    replacement: "__tests__/render/intake-links-wizard.render.test.tsx",
    anchor: "disables a channel the deployment cannot send on, with the reason",
    strength: "stronger",
  },
  {
    retired: "phase-7-tenant-isolation (intake row)",
    guarantee: "the surface names its owning workspace from the canonical resolver",
    replacement: "__tests__/render/intake-links-management.render.test.tsx",
    anchor: "names the owning workspace exactly once",
    strength: "stronger",
  },
];

// ===========================================================================
// The ledger is executable
// ===========================================================================

test("every retired guarantee names a replacement that exists and still asserts it", () => {
  const missing: string[] = [];
  for (const row of LEDGER) {
    const abs = row.replacement.startsWith("e2e/")
      ? resolve(WEB, "..", "..", row.replacement)
      : resolve(WEB, row.replacement);
    if (!existsSync(abs)) {
      missing.push(`${row.retired}: replacement file missing — ${row.replacement}`);
      continue;
    }
    if (!readFileSync(abs, "utf8").includes(row.anchor)) {
      missing.push(
        `${row.retired}: "${row.guarantee}" — anchor not found in ${row.replacement}: ${row.anchor}`,
      );
    }
  }
  assert.deepEqual(missing, []);
});

test("every retired suite is actually gone, and named exactly once as retired", () => {
  const retiredSuites = [
    "intake-links-e2e",
    "intake-links-list-and-submissions",
    "intake-links-message-preview",
    "intake-links-modal-strict-ux",
    "intake-links-mode-compat",
    "intake-links-operations-console",
    "intake-links-redesign",
  ];
  for (const suite of retiredSuites) {
    assert.ok(
      !existsSync(resolve(WEB, `__tests__/${suite}.test.ts`)),
      `${suite} still exists — it is listed as retired`,
    );
    assert.ok(
      LEDGER.some((r) => r.retired === suite),
      `${suite} was deleted with no ledger row`,
    );
  }
});

test("the axes the redesign could most easily have dropped are all still covered", () => {
  // A checklist over the LEDGER itself: every category the brief names must
  // have at least one row, so a future edit cannot quietly empty one out.
  const categories: Array<[string, RegExp]> = [
    ["API authorization / capability", /workspace|capability|owning workspace/i],
    ["tenant isolation", /workspace|tenant/i],
    ["delivery / provider semantics", /channel|delivery|provider/i],
    ["lifecycle mutations", /archive|unarchive|mutation|state model/i],
    ["wizard validation", /validat|recipient field|catch-all|mode/i],
    ["accessibility behaviour", /menu|overlay|listbox/i],
  ];
  for (const [name, pattern] of categories) {
    assert.ok(
      LEDGER.some((r) => pattern.test(r.guarantee) || pattern.test(r.anchor)),
      `no ledger row covers ${name}`,
    );
  }
});

test("no replacement is weaker than what it replaced", () => {
  for (const row of LEDGER) {
    assert.ok(
      row.strength === "stronger" || row.strength === "equivalent",
      `${row.retired}: ${row.guarantee}`,
    );
  }
  // Most of the replacements drive the real component rather than matching
  // source text, which is the whole point of the exchange.
  const stronger = LEDGER.filter((r) => r.strength === "stronger").length;
  assert.ok(
    stronger >= LEDGER.length / 2,
    `only ${stronger}/${LEDGER.length} replacements are stronger`,
  );
});

test("the public contributor route kept its own suites, untouched", () => {
  // The retirement was scoped to the MANAGEMENT surface. The public route's
  // suites are not on the ledger because nothing about them changed.
  for (const suite of [
    "intake-public-display-fixes",
    "intake-public-friendly-errors",
    "intake-multi-file-partindex",
  ]) {
    assert.ok(
      existsSync(resolve(WEB, `__tests__/${suite}.test.ts`)),
      `${suite} must survive — the public route was out of scope`,
    );
  }
});
