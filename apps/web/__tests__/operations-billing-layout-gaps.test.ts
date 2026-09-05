/**
 * THE THREE GAPS LEFT BY THE SEMANTIC-COLOUR PASS.
 *
 * Each of these was a layout or emphasis fact that the colour work named but
 * did not close, and each is asserted here as STRUCTURE rather than geometry:
 * where the status cell sits in the row, which token a number resolves to,
 * and what decides the width of a panel. The pixels are measured where pixels
 * can be measured — the `operations-layout` and `billing-layout` Playwright
 * projects — because jsdom applies no stylesheet and answers 0 to every box.
 *
 * No byte counts and no screenshot comparisons: those pin a rendering, and
 * what is worth pinning is the reason the rendering came out that way.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { splitLeadingCount } from "../app/(app)/billing/_sections/format";

const APP = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string) => readFileSync(resolve(APP, rel), "utf8");

const INCIDENTS = read("app/(app)/operations/_components/IncidentSurface.tsx");
const OPS_CSS = read("app/(app)/operations/operations.css");
const VOCAB = read("app/(app)/operations/_lib/vocabulary.ts");
const BILL_CSS = read("app/(app)/billing/billing.css");
const OVERVIEW = read("app/(app)/billing/_sections/BillingOverview.tsx");
const STORAGE = read("app/(app)/billing/_sections/StorageAndHistory.tsx");

// ===========================================================================
// 1. THE LIFECYCLE STATUS SITS AT THE END OF THE ROW
// ===========================================================================

test("the table puts Status last, after every descriptive column", () => {
  const header = INCIDENTS.slice(
    INCIDENTS.indexOf("<thead"),
    INCIDENTS.indexOf("</thead>"),
  );
  const at = (cls: string) => header.indexOf(`opsw-col-${cls}`);

  assert.ok(at("status") > at("age"), "Status must follow First seen");
  assert.ok(at("status") > at("activity"), "Status must follow Latest activity");
  assert.ok(
    at("actions") > at("status"),
    "the row menu stays last; Status is the last column a reader reads",
  );
});

test("the body cells follow the header, so the column is not transposed", () => {
  const body = INCIDENTS.slice(INCIDENTS.indexOf("<tbody"));
  const at = (cls: string) => body.indexOf(`opsw-col-${cls}`);

  assert.ok(at("status") > at("activity"), "the data must arrive in header order");
  assert.ok(at("actions") > at("status"));
});

test("the status column is right-aligned and does not wrap mid-word", () => {
  assert.match(
    OPS_CSS,
    /\.opsw-col-status \{[^}]*text-align: end/,
    "right-aligned, so every row answers at the same x",
  );
  assert.match(
    OPS_CSS,
    /td\.opsw-col-status \{[^}]*white-space: nowrap/,
    "Acknowledged must not break across two lines inside its own cell",
  );
});

test("the card sends the status to the trailing edge, and lets it wrap there", () => {
  assert.ok(
    INCIDENTS.includes('<span className="opsw-card__status">'),
    "the narrow renderer needs its own slot, not a bare sibling badge",
  );
  assert.match(
    OPS_CSS,
    /\.opsw-card__status \{[^}]*margin-inline-start: auto/,
    "pushed to the end by the layout, never by a fixed offset",
  );
  assert.doesNotMatch(
    OPS_CSS.slice(OPS_CSS.indexOf(".opsw-card__status")),
    /^\s*position: absolute/m,
    "no absolute positioning: it cannot answer what happens when the row wraps",
  );
  assert.match(
    OPS_CSS,
    /\.opsw-card__head \{[^}]*flex-wrap: wrap/,
    "a long status takes its own line rather than overlapping the severity",
  );
});

test("moving the column did NOT touch what the states are coloured", () => {
  // The brief moved the status; it did not recolour it. These are the tones
  // the vocabulary already assigned, and a change here is a change of meaning.
  assert.match(VOCAB, /OPEN: "blue"/);
  assert.match(VOCAB, /ACKNOWLEDGED: "indigo"/);
});

// ===========================================================================
// 2. THE NUMBERS ON THE BILLING CARDS
// ===========================================================================

test("an account metric is the accent; the words around it are not", () => {
  assert.match(
    BILL_CSS,
    /\.bill-facts__value \{[^}]*color: var\(--accent-600/,
    "the figures carry the product's usage accent",
  );
  assert.match(BILL_CSS, /\.bill-lead__used \{[^}]*color: var\(--accent-600/);
  // PHASE 7 — this pinned `--text-muted`, which no longer exists. It was one
  // of two muted-ink ALIASES pointing at a value that failed AA against the
  // card surface; all sixty consumers were migrated to `--silver-ink` (or
  // `--ink-primary` where the text was not secondary) and both aliases were
  // deleted. The role asserted here is unchanged: the total is quieter than
  // the figure measured against it.
  assert.match(
    BILL_CSS,
    /\.bill-lead__of \{[^}]*color: var\(--silver-ink/,
    "the total is the thing measured against, not a second metric",
  );
});

test("an over-limit row is a WARNING, and keeps a warning's colour", () => {
  // The row renders only when `over > 0`. It carried `data-tone="pending"`
  // already and nothing painted it, so a real breach read exactly like a
  // credit balance. It must never be swept into the accent with the rest.
  assert.match(OVERVIEW, /over > 0 \? \([\s\S]{0,200}data-tone="pending"/);
  assert.match(
    BILL_CSS,
    /\.bill-facts__row\[data-tone="pending"\] \.bill-facts__value \{[^}]*color: var\(--orange-500/,
    "the canonical warning orange, not the accent",
  );
  assert.match(
    BILL_CSS,
    /\.bill-facts__row\[data-tone="pending"\] \.bill-facts__label \{[^}]*color: var\(--orange-500/,
  );
});

test("Billing invents no colour of its own for these numbers", () => {
  // Scoped to the rules this pass added, deliberately. A blanket hex ban here
  // would fail on `.bill-pay__mark[data-mark="visa"]`, whose literal IS the
  // fact — a payment brand is recognised by its own colour, and that mark is
  // not a semantic state.
  for (const selector of [
    ".bill-facts__value",
    ".bill-lead__used",
    ".bill-lead__of",
    '.bill-facts__row[data-tone="pending"] .bill-facts__value',
    '.bill-facts__row[data-tone="pending"] .bill-facts__label',
  ]) {
    const at = BILL_CSS.indexOf(`${selector} {`);
    assert.ok(at > -1, `${selector} must exist`);
    const rule = BILL_CSS.slice(at, BILL_CSS.indexOf("}", at));
    /*
      PHASE 7 — THIS REQUIRED THE FALLBACK IT WAS TRYING TO ALLOW.
      The rule was written as "a hex may only appear as a token fallback",
      which the pattern `var(--x, #hex)` enforced by MANDATING that shape — so
      a declaration with no hex at all failed it. `--silver-ink` has no
      fallback (the phase removed 374 of them: a fallback is a second value
      for the same name, and when the two disagree the fallback is what ships
      wherever the token is missing), and this test read that as the defect.

      What it protects is unchanged and now said directly: the value must be a
      token reference, and no bare hex may stand as the colour.
    */
    for (const line of rule.split("\n").filter((l) => /^\s*color:/.test(l))) {
      assert.match(
        line,
        /color:\s*var\(--[a-z0-9-]+/i,
        `the colour must come from a token: ${line.trim()}`,
      );
      assert.doesNotMatch(
        line,
        /color:\s*#[0-9a-f]{3,8}/i,
        `a bare hex may not be the colour: ${line.trim()}`,
      );
    }
  }
  assert.doesNotMatch(
    BILL_CSS,
    /--billing-[a-z]+:/,
    "no page-local colour variable; the tokens already exist",
  );
});

test("both cards emphasise the same part of the same kind of sentence", () => {
  assert.ok(
    STORAGE.includes('className="bill-lead__used"') &&
      STORAGE.includes('className="bill-lead__of"'),
    "Storage splits the used figure from the total",
  );
  assert.ok(
    OVERVIEW.includes('className="bill-lead__used"'),
    "Evidence splits its count the same way",
  );
  assert.ok(
    STORAGE.includes("<bdi>") && OVERVIEW.includes("<bdi>"),
    "the isolation stays over the whole run, or RTL reorders the sentence",
  );
});

test("splitLeadingCount takes the count and nothing else", () => {
  assert.deepEqual(splitLeadingCount("176 lifetime records"), {
    value: "176",
    rest: " lifetime records",
  });
  assert.deepEqual(splitLeadingCount("176 of 127 included lifetime records"), {
    value: "176",
    rest: " of 127 included lifetime records",
  });
  assert.deepEqual(splitLeadingCount("1,234 records"), {
    value: "1,234",
    rest: " records",
  });
  // A headline with no number is a WORD, and a word is never a metric.
  for (const whole of ["Not included", "Contract-managed", "Unavailable"]) {
    assert.deepEqual(splitLeadingCount(whole), { value: "", rest: whole });
  }
  // A trailing separator belongs to the sentence, not to the number.
  assert.deepEqual(splitLeadingCount("12. Something"), {
    value: "12",
    rest: ". Something",
  });
});

// ===========================================================================
// 3. THE CAPABILITIES PANEL IS AS WIDE AS THE SECTION BELOW IT
// ===========================================================================

test("a row of one is a row of one, and takes the row's full width", () => {
  // `EnterpriseContractCard` returns null without a contract — which is every
  // self-serve account — so the two-column row rendered a single card at half
  // width directly above a full-width Billing history.
  assert.match(
    read("app/(app)/billing/_sections/PlanAndUsage.tsx"),
    /const contract = projection\.contract;\s*\n\s*if \(!contract\) return null;/,
  );
  assert.match(
    BILL_CSS,
    /\.bill-row:has\(> \*:only-child\) \{[^}]*grid-template-columns: minmax\(0, 1fr\)/,
    "the track count follows what actually rendered",
  );
});

test("the width is the page grid's, never a number typed into the panel", () => {
  const rule = BILL_CSS.slice(
    BILL_CSS.indexOf(".bill-row:has(> *:only-child)"),
  ).slice(0, 200);
  assert.doesNotMatch(rule, /width:/, "no width is stated here, fixed or otherwise");

  const panel = BILL_CSS.slice(BILL_CSS.indexOf(".bill-panel {"));
  assert.doesNotMatch(
    panel.slice(0, panel.indexOf("}")),
    /(?:^|[^-])width: \d+px/,
    "a panel never states a desktop width of its own",
  );
});

test("the responsive collapse still owns the narrow widths", () => {
  // The single-child rule must not be what decides one column on a phone —
  // that is the media query's job, and it applies to full rows too.
  assert.match(
    BILL_CSS,
    /@media \(max-width: 980px\)[\s\S]{0,400}\.bill-row \{[^}]*grid-template-columns: minmax\(0, 1fr\)/,
  );
});
