/**
 * EVERY RUNBOOK, MEASURED AGAINST ITS OWN SOURCE.
 *
 * ===========================================================================
 * WHY A CORPUS SWEEP AND NOT MORE EXAMPLES
 * ===========================================================================
 * `runbook-renderer-fidelity.render.test.tsx` proves the renderer handles four
 * constructs correctly, using hand-written fixtures. That is the right shape
 * for a rule — the fixture and the assertion are unambiguous — and it is the
 * wrong shape for a claim about THE CORPUS. A renderer can be correct on every
 * fixture somebody thought to write and still break the one runbook that
 * indents its fence under a nested bullet.
 *
 * Phase 7 §B7 is a claim about all twenty-nine: sentences whole, ordered lists
 * numbered, unordered lists bulleted, nested lists nested, paragraphs not
 * swallowed into items, inline code left-to-right, code blocks copyable,
 * cross-references pointing at routes, and no repository path on screen. So
 * this renders every runbook and compares the RENDERED structure to what the
 * SOURCE asked for, per document.
 *
 * ===========================================================================
 * WHAT "SPLIT MID-SENTENCE" MEANS HERE, AND WHY IT IS MEASURABLE
 * ===========================================================================
 * The defect this phase inherited was 394 list items across 21 of 29 runbooks
 * ending mid-sentence, with the remainder rendered as a paragraph underneath
 * the list. The tell is mechanical and does not need a language model: an item
 * whose text ends without terminal punctuation, immediately followed by a
 * sibling paragraph whose text begins lower-case. Prose does not normally do
 * that; a hard-wrapped line that escaped its bullet always does.
 */

import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { renderRunbookMarkdown } from "../../lib/runbooks/render";
import { RUNBOOK_SLUGS } from "../../lib/runbooks/slugs.generated";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../../../..");
const DIR = join(REPO, "docs", "runbooks");

/** The corpus, read from its authority rather than the generated copy. */
const FILES = readdirSync(DIR)
  .filter((f) => f.endsWith(".md"))
  .filter((f) => RUNBOOK_SLUGS.has(f.replace(/\.md$/, "")))
  .sort();

type Doc = { slug: string; md: string };

/**
 * The sources at module scope; the DOM per assertion.
 *
 * Rendering all twenty-nine at import time and holding the containers was the
 * obvious shape and the wrong one: `@testing-library/react` unmounts what it
 * rendered after every test, so by the second assertion every container was
 * empty and every count was zero — thirty-four failures that all said "expected
 * 14 to be 0" about a renderer that was working correctly.
 */
const DOCS: Doc[] = FILES.map((f) => ({
  slug: f.replace(/\.md$/, ""),
  md: readFileSync(join(DIR, f), "utf8"),
}));

/** Render one runbook and hand back its container. */
function dom(d: Doc): HTMLElement {
  return render(<div>{renderRunbookMarkdown(d.md)}</div>).container;
}

/** Source lines that open a list item, minus anything inside a fence. */
function sourceListItems(md: string): { ul: number; ol: number; nested: number } {
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  let inFence = false;
  let ul = 0;
  let ol = 0;
  let nested = 0;
  for (const line of lines) {
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    if (/^\s*[-*]\s+/.test(line)) {
      // `---` is a horizontal rule, not a bullet.
      if (/^-{3,}\s*$/.test(line.trim())) continue;
      ul += 1;
      if (/^\s{2,}[-*]\s+/.test(line)) nested += 1;
    } else if (/^\s*\d+\.\s+/.test(line)) {
      ol += 1;
    }
  }
  return { ul, ol, nested };
}

it("the corpus is all twenty-nine runbooks, and every slug resolves", () => {
  expect(FILES.length).toBeGreaterThanOrEqual(29);
  expect(DOCS.length).toBe(FILES.length);
  for (const d of DOCS) {
    expect(RUNBOOK_SLUGS.has(d.slug), `${d.slug} is not in the slug index`).toBe(true);
  }
});

describe("every list item the source writes is a list item on the page", () => {
  for (const d of DOCS) {
    it(`${d.slug}`, () => {
      const want = sourceListItems(d.md);
      const root = dom(d);
      const gotUl = root.querySelectorAll("ul.rb-ul > li").length;
      const gotOl = root.querySelectorAll("ol.rb-ol > li").length;
      expect(gotUl, `${d.slug}: unordered items`).toBe(want.ul);
      expect(gotOl, `${d.slug}: ordered items`).toBe(want.ol);
      const gotNested = root.querySelectorAll('li[data-depth="1"]').length;
      expect(gotNested, `${d.slug}: nested items`).toBe(want.nested);
    });
  }
});

describe("no item ends mid-sentence with its remainder underneath", () => {
  for (const d of DOCS) {
    it(`${d.slug}`, () => {
      const split: string[] = [];
      const root = dom(d);
      for (const list of Array.from(root.querySelectorAll("ul.rb-ul, ol.rb-ol"))) {
        const last = list.querySelector("li:last-child");
        const next = list.nextElementSibling;
        if (!last || !next || next.tagName !== "P") continue;
        const tail = (last.textContent ?? "").trim();
        const head = (next.textContent ?? "").trim();
        /* Ends without terminal punctuation AND the paragraph beneath starts
           lower-case. Either alone is ordinary — a list can end on a noun, a
           paragraph can start with `apiFetch` — so both are required. */
        const unfinished = tail.length > 0 && !/[.!?:;)”"'`]$/.test(tail);
        const continues = head.length > 0 && /^[a-z]/.test(head);
        if (unfinished && continues) {
          split.push(`…${tail.slice(-60)}"  ⇒  "${head.slice(0, 60)}…`);
        }
      }
      expect(split, `${d.slug}: sentence split across a list boundary`).toEqual([]);
    });
  }
});

it("ordered lists keep the number the source gave them", () => {
  for (const d of DOCS) {
    const lines = d.md.replace(/\r\n/g, "\n").split("\n");
    const firsts: number[] = [];
    let inFence = false;
    let prevWasItem = false;
    for (const line of lines) {
      if (/^\s*```/.test(line)) {
        inFence = !inFence;
        /* A FENCE ENDS THE LIST RUN, which is the whole reason `start` exists.
           `immutable-drift` writes step 1, a SQL block indented under it, then
           step 2 — and the renderer correctly emits a second `<ol start="2">`,
           because step 2 must not renumber itself to 1. A first version of
           this scanner skipped fence lines without clearing the run, so it
           recorded only `1` and reported the renderer's correct `start=2` as a
           number the source never wrote. The scanner was wrong, not the page. */
        prevWasItem = false;
        continue;
      }
      if (inFence) continue;
      const m = /^\s*(\d+)\.\s+/.exec(line);
      if (m && !prevWasItem) firsts.push(Number(m[1]));
      prevWasItem = Boolean(m) || (prevWasItem && /^\s+\S/.test(line));
    }
    const rendered = Array.from(dom(d).querySelectorAll("ol.rb-ol")).map((o) =>
      Number(o.getAttribute("start") ?? "1"),
    );
    /* Not a strict pairing — a fence can interrupt a list and produce a second
       <ol> from one source run — but every rendered start must be a number the
       source actually wrote, or the list has renumbered itself. */
    for (const start of rendered) {
      expect(firsts, `${d.slug}: <ol start=${start}> is not a source number`).toContain(
        start,
      );
    }
  }
});

it("no repository path reaches the page", () => {
  const found: string[] = [];
  for (const d of DOCS) {
    const root = dom(d);
    /* `docs/runbooks/x.md` is the path an operator cannot open and must never
       be shown. A cross-reference is rewritten to the console route; anything
       still carrying the directory is a link the renderer did not recognise.
       Inline code is exempt: a runbook legitimately quotes a path as a value
       an operator types, and that is the one place it belongs. */
    for (const node of Array.from(root.querySelectorAll("*"))) {
      if (node.closest("code, pre")) continue;
      if (node.children.length > 0) continue;
      const t = node.textContent ?? "";
      if (/docs\/runbooks\/[a-z0-9-]+\.md/i.test(t)) {
        found.push(`${d.slug}: ${t.trim().slice(0, 90)}`);
      }
    }
  }
  expect(found).toEqual([]);
});

it("every runbook cross-reference points at a console route that resolves", () => {
  const bad: string[] = [];
  for (const d of DOCS) {
    for (const a of Array.from(dom(d).querySelectorAll("a[href]"))) {
      const href = a.getAttribute("href") ?? "";
      const m = /^\/admin\/platform\/runbooks\/([a-z0-9-]+)$/.exec(href);
      if (!m) continue;
      if (!RUNBOOK_SLUGS.has(m[1])) bad.push(`${d.slug} → ${href}`);
    }
  }
  expect(bad, "a cross-reference points at a slug that does not exist").toEqual([]);
});

it("the corpus exercises every construct the renderer claims to support", () => {
  /* A sweep that never met a table proves nothing about tables. This records
     what the corpus actually contains, so a claim of "representative
     structural coverage" is a measurement rather than an assurance. */
  const seen = {
    h2: 0,
    h3: 0,
    p: 0,
    ul: 0,
    ol: 0,
    nested: 0,
    table: 0,
    tableHeaderless: 0,
    code: 0,
    quote: 0,
    hr: 0,
    inlineCode: 0,
    link: 0,
  };
  for (const d of DOCS) {
    const root = dom(d);
    seen.h2 += root.querySelectorAll("h2.rb-h2").length;
    seen.h3 += root.querySelectorAll("h3.rb-h3").length;
    seen.p += root.querySelectorAll("p.rb-p").length;
    seen.ul += root.querySelectorAll("ul.rb-ul").length;
    seen.ol += root.querySelectorAll("ol.rb-ol").length;
    seen.nested += root.querySelectorAll('li[data-depth="1"]').length;
    seen.table += root.querySelectorAll("table.rb-table").length;
    seen.tableHeaderless += Array.from(
      root.querySelectorAll("table.rb-table"),
    ).filter((t) => !t.querySelector("thead")).length;
    seen.code += root.querySelectorAll("pre").length;
    seen.quote += root.querySelectorAll("blockquote.rb-quote").length;
    seen.hr += root.querySelectorAll("hr.rb-hr").length;
    seen.inlineCode += root.querySelectorAll("code.rb-code-inline").length;
    seen.link += root.querySelectorAll("a[href]").length;
  }
  // eslint-disable-next-line no-console
  console.log("runbook corpus structure:", JSON.stringify(seen));
  for (const [k, v] of Object.entries(seen)) {
    expect(v, `the corpus contains no ${k}, so nothing here tested it`).toBeGreaterThan(0);
  }
});
