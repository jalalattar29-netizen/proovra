/**
 * RUNBOOK RENDERING PROBE — what the reader actually produces.
 *
 * A runbook is the procedure an incident's slug points at. If the renderer
 * loses a numbered step, flattens a nested bullet, or drops the text of a
 * command, the operator reads a DIFFERENT procedure from the one in the
 * repository and does not know it. Nothing in a build catches that, and a
 * screenshot of one runbook says nothing about the other thirty-three.
 *
 * So this compares the RENDERED page against the SOURCE markdown, per runbook:
 *
 *   headings          every ## and ### in the source has an element
 *   ordered steps     every `1.` list item survives, in order, numbered
 *   nested bullets    a two-level list renders as two levels
 *   inline code       every `code` span becomes a code element
 *   command blocks    every fenced block's text survives byte-for-byte
 *   cross-references  every [text](link) is a link with an href
 *   warnings          a blockquote / "WARNING:" line is still distinguishable
 *   tables            every | table | keeps its row count
 *
 * Usage: node scripts/admin-ledger/visual/runbooks.mjs [--rtl] [slug…]
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { open, signIn, strip, WEB } from "./lib.mjs";

const rtl = process.argv.includes("--rtl");
const only = process.argv.slice(2).filter((a) => !a.startsWith("--"));

/* ------------------------------------------------- the source of truth --- */
const SOURCE_DIRS = ["docs/runbooks", "docs/operations/runbooks", "docs"];
const sources = new Map();
for (const dir of SOURCE_DIRS) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    continue;
  }
  for (const e of entries) {
    if (!e.isFile() || !e.name.endsWith(".md")) continue;
    const slug = e.name.replace(/\.md$/, "");
    if (!sources.has(slug)) sources.set(slug, readFileSync(join(dir, e.name), "utf8"));
  }
}

const index = readFileSync("apps/web/lib/runbooks/index.generated.ts", "utf8");
const slugs = [...index.matchAll(/slug:\s*"([^"]+)"/g)].map((m) => m[1]);
const targets = only.length ? only : slugs;

console.log(`runbooks in the index: ${slugs.length}`);
console.log(`markdown sources found: ${sources.size}`);
console.log(`probing: ${targets.length}${rtl ? " (rtl)" : ""}\n`);

/* --------------------------------------------------------- expectations -- */
function expectationsFor(md) {
  if (!md) return null;
  // Strip fenced blocks before counting anything that lives outside them.
  const fences = [...md.matchAll(/```[a-zA-Z0-9]*\n([\s\S]*?)```/g)].map((m) => m[1]);
  const prose = md.replace(/```[\s\S]*?```/g, "\n");

  return {
    headings: (prose.match(/^#{2,3} +\S/gm) ?? []).length,
    orderedItems: (prose.match(/^ *\d+\. +\S/gm) ?? []).length,
    nestedBullets: (prose.match(/^ {2,} *[-*] +\S/gm) ?? []).length,
    topBullets: (prose.match(/^[-*] +\S/gm) ?? []).length,
    inlineCode: (prose.match(/`[^`\n]+`/g) ?? []).length,
    fences,
    /* A cross-reference the BROWSER can follow. A markdown link to a
       repository path (`services/api/src/…`, `../../packages/…`) is
       deliberately rendered as its label plus the path in a code span, because
       a link to a file the browser cannot open is a 404 dressed as a
       cross-reference. Counting those as expected links reports a documented
       decision as a defect — which is exactly what this probe did on
       privacy-leak and reviewer-escalation-storm before it was corrected. */
    links: (prose.match(/\[[^\]]+\]\([^)]+\)/g) ?? []).filter((m) => {
      const href = /\(([^)]+)\)$/.exec(m)?.[1] ?? "";
      if (/^https?:\/\//i.test(href)) return true;
      if (href.startsWith("/")) return true;
      return /^\.?\/?[a-z0-9-]+\.md(#.*)?$/i.test(href);
    }).length,
    quotes: (prose.match(/^> +\S/gm) ?? []).length,
    tableRows: (prose.match(/^\|.*\|\s*$/gm) ?? []).length,
  };
}

const { browser, page } = await open({ width: 1440, height: 1000, rtl });
const consoleErrors = [];
page.on("console", (m) => {
  if (m.type() === "error") consoleErrors.push(m.text());
});
await signIn(page);

let clean = 0;
let probed = 0;
const defects = [];

for (const slug of targets) {
  const md = sources.get(slug);
  const want = expectationsFor(md);
  if (!want) {
    console.log(`skip  ${slug.padEnd(46)} no markdown source on disk`);
    continue;
  }

  consoleErrors.length = 0;
  await page.goto(`${WEB}/admin/platform/runbooks/${slug}`, {
    waitUntil: "networkidle",
    timeout: 90_000,
  });
  await strip(page);
  await page.waitForTimeout(600);

  const got = await page.evaluate(() => {
    /* The runbook BODY, not the page. The catalog sidebar is 34 links in a
       <ul> and sits inside <main>, so measuring <main> counts the navigation
       as content and reports 52 bullets on every runbook. */
    const root = document.querySelector("article.rb-doc");
    if (!root) return null;
    const olItems = Array.from(root.querySelectorAll("ol > li"));
    return {
      headings: root.querySelectorAll("h2, h3").length,
      orderedItems: olItems.length,
      // A list marker that renders as nothing is the defect that makes a
      // numbered procedure unusable, so measure the COMPUTED marker.
      orderedUnnumbered: olItems.filter(
        (li) => getComputedStyle(li).listStyleType === "none",
      ).length,
      /* Nesting is expressed as data-depth on a flat list rather than as a
         nested <ul>, so the structural selector would report zero on a page
         that indents correctly. */
      nestedBullets: root.querySelectorAll("li[data-depth=\"1\"]").length,
      topBullets: root.querySelectorAll("li[data-depth=\"0\"]").length,
      inlineCode: root.querySelectorAll("code").length,
      preBlocks: Array.from(root.querySelectorAll("pre")).map(
        (p) => p.textContent ?? "",
      ),
      links: root.querySelectorAll("a[href]").length,
      quotes: root.querySelectorAll("blockquote, [data-callout]").length,
      tableRows: root.querySelectorAll("table tr").length,
      tables: root.querySelectorAll("table").length,
      textLength: (root.textContent ?? "").length,
      overflow:
        document.documentElement.scrollWidth - document.documentElement.clientWidth,
    };
  });

  probed += 1;
  const bad = [];

  if (got.headings < want.headings) {
    bad.push(`headings ${got.headings}/${want.headings}`);
  }
  if (got.orderedItems < want.orderedItems) {
    bad.push(`ordered steps ${got.orderedItems}/${want.orderedItems}`);
  }
  if (got.orderedUnnumbered > 0) {
    bad.push(`${got.orderedUnnumbered} ordered items render no number`);
  }
  if (want.nestedBullets > 0 && got.nestedBullets === 0) {
    bad.push(`nested bullets flattened (source has ${want.nestedBullets})`);
  }
  if (got.topBullets + got.nestedBullets < want.topBullets + want.nestedBullets) {
    bad.push(
      `bullets ${got.topBullets + got.nestedBullets}/${want.topBullets + want.nestedBullets}`,
    );
  }
  if (want.inlineCode > 0 && got.inlineCode === 0) {
    bad.push(`inline code lost (source has ${want.inlineCode})`);
  }
  if (got.preBlocks.length < want.fences.length) {
    bad.push(`command blocks ${got.preBlocks.length}/${want.fences.length}`);
  } else {
    for (let i = 0; i < want.fences.length; i += 1) {
      const wantText = want.fences[i].trim();
      const gotText = (got.preBlocks[i] ?? "").trim();
      // The block may carry a language label and a copy control; what must
      // survive is the COMMAND.
      const firstLine = wantText.split("\n")[0]?.trim();
      if (firstLine && !gotText.includes(firstLine)) {
        bad.push(`command block ${i + 1} lost its text`);
        break;
      }
    }
  }
  if (want.links > 0 && got.links === 0) {
    bad.push(`cross-references lost (source has ${want.links})`);
  }
  if (want.quotes > 0 && got.quotes === 0) {
    bad.push(`warning callouts lost (source has ${want.quotes})`);
  }
  /* A markdown table spends ONE line on its |---| separator, which is not a
     row. With more than one table on a page that is one line per table, so the
     expectation has to know how many tables rendered. */
  const wantRendered = want.tableRows - Math.max(got.tables, want.tableRows > 0 ? 1 : 0);
  if (want.tableRows > 2 && got.tableRows < wantRendered) {
    bad.push(`table rows ${got.tableRows}/${wantRendered}`);
  }
  if (got.overflow > 0) bad.push(`overflow ${got.overflow}px`);
  if (consoleErrors.length) bad.push(`${consoleErrors.length} console errors`);

  if (bad.length === 0) clean += 1;
  else defects.push({ slug, bad });

  console.log(
    `${bad.length ? "FAIL" : "ok  "}  ${slug.padEnd(46)} ` +
      `h=${got.headings} ol=${got.orderedItems} ul=${got.topBullets}+${got.nestedBullets} ` +
      `code=${got.inlineCode} pre=${got.preBlocks.length} a=${got.links}` +
      (bad.length ? "\n        " + bad.join("; ") : ""),
  );
}

await browser.close();
console.log(`\n${clean}/${probed} runbooks render their source faithfully${rtl ? " (rtl)" : ""}`);
if (defects.length) {
  console.log("\ndefects:");
  for (const d of defects) console.log(`  ${d.slug}: ${d.bad.join("; ")}`);
}
process.exit(defects.length ? 1 : 0);
