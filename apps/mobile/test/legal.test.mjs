/**
 * LEGAL — the native reader's projections, against the REAL corpus.
 *
 * The parser is exercised on every authored document rather than on a fixture,
 * because the thing that matters is that a real policy renders completely. A
 * fixture proves the parser handles the markdown somebody wrote for the test.
 *
 * The load-bearing claim: THE RENDERER NEVER SWALLOWS A LINE. A vanished
 * clause in a DPA is the failure nobody notices until it matters, so every
 * non-blank line of every document must survive into a block.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import ts from "typescript";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..", "..");
const CONTENT_DIR = join(REPO_ROOT, "apps", "web", "content", "legal", "en");

const src = readFileSync(resolve(HERE, "../src/product/legal.ts"), "utf8");
const js = ts.transpileModule(src, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const L = await import(`data:text/javascript,${encodeURIComponent(js)}`);

const DOCS = readdirSync(CONTENT_DIR)
  .filter((f) => f.endsWith(".md"))
  .map((f) => [f.slice(0, -3), readFileSync(join(CONTENT_DIR, f), "utf8").replace(/\r\n/g, "\n")]);

/* ----------------------------------------------------------------- transport */

test("paths are the canonical read-only legal endpoints", () => {
  assert.equal(L.buildLegalIndexPath(), "/v1/legal");
  assert.equal(L.buildLegalDocumentPath("privacy"), "/v1/legal/privacy");
  // A slug is a path segment, so it is encoded — a caller cannot smuggle a
  // second path component through it.
  assert.equal(L.buildLegalDocumentPath("a/b"), "/v1/legal/a%2Fb");
});

test("a document with no body is not a document", () => {
  assert.equal(L.parseLegalDocument({ slug: "privacy", content: "" }), null);
  assert.equal(L.parseLegalDocument({ slug: "privacy" }), null);
  assert.equal(L.parseLegalDocument({ content: "# x" }), null);
  assert.equal(L.parseLegalDocument(null), null);
});

test("the document projection carries what the API states, and nothing else", () => {
  const doc = L.parseLegalDocument({
    slug: "terms",
    title: "Terms of Service",
    locale: "en",
    lastUpdated: "2026-06-23",
    contentFormat: "markdown",
    content: "# Terms of Service\n\nBody.",
    acceptance: { policyKey: "terms", requiredVersion: "2026-04-06" },
  });

  assert.equal(doc.slug, "terms");
  assert.equal(doc.title, "Terms of Service");
  assert.equal(doc.lastUpdated, "2026-06-23");
  assert.deepEqual(doc.acceptance, { policyKey: "terms", requiredVersion: "2026-04-06" });
});

test("a document the acceptance gate does not govern gets no invented version", () => {
  const doc = L.parseLegalDocument({ slug: "dpa", content: "x", acceptance: null });
  assert.equal(doc.acceptance, null);

  // A half-formed acceptance object is not an acceptance requirement.
  const partial = L.parseLegalDocument({
    slug: "dpa",
    content: "x",
    acceptance: { policyKey: "dpa" },
  });
  assert.equal(partial.acceptance, null);
});

test("the index drops rows with no slug rather than rendering a dead row", () => {
  const list = L.parseLegalIndex({
    documents: [
      { slug: "privacy", title: "Privacy Policy", lastUpdated: "2026-06-23" },
      { title: "Nameless" },
      null,
    ],
  });
  assert.equal(list.length, 1);
  assert.equal(list[0].slug, "privacy");
});

/* ------------------------------------------------------- web path resolution */

test("the five web redirect routes resolve to their document", () => {
  // apps/web/app/{privacy,terms,subprocessors,data-retention,abuse-reporting}
  // are each nothing but redirect("/legal/<slug>").
  assert.equal(L.legalSlugFromWebPath("/privacy"), "privacy");
  assert.equal(L.legalSlugFromWebPath("/terms"), "terms");
  assert.equal(L.legalSlugFromWebPath("/subprocessors"), "subprocessors");
  assert.equal(L.legalSlugFromWebPath("/data-retention"), "data-retention");
  assert.equal(L.legalSlugFromWebPath("/abuse-reporting"), "abuse-reporting");
});

test("both web readers resolve to one native reader", () => {
  assert.equal(L.legalSlugFromWebPath("/legal/dpa"), "dpa");
  assert.equal(L.legalSlugFromWebPath("/settings/legal/dpa"), "dpa");
  assert.equal(L.legalSlugFromWebPath("/security-overview"), "security");
  assert.equal(L.legalSlugFromWebPath("/legal/dpa?x=1#s2"), "dpa");
  assert.equal(L.legalSlugFromWebPath("/legal/dpa/"), "dpa");
});

test("a non-legal path is not claimed", () => {
  for (const p of ["/trust", "/support", "/home", "/evidence/ev-1", "https://x.test/legal/dpa"]) {
    assert.equal(L.legalSlugFromWebPath(p), null, p);
  }
});

/* ------------------------------------------------------------------ markdown */

test("the parser handles every construct the web renderer supports", () => {
  const blocks = L.parseLegalMarkdown(
    [
      "# Title",
      "",
      "## Section",
      "",
      "### Sub",
      "",
      "A paragraph with **bold**, *italic* and a [link](/legal/terms).",
      "",
      "- one",
      "- two",
      "",
      "1. first",
      "2. second",
      "",
      "---",
      "",
      "| Scenario | Role |",
      "|---|---|",
      "| Upload | processor |",
    ].join("\n"),
  );

  assert.deepEqual(
    blocks.map((b) => b.kind),
    ["h1", "h2", "h3", "p", "ul", "ol", "hr", "table"],
  );

  const p = blocks[3];
  assert.deepEqual(
    p.spans.map((s) => s.kind),
    ["text", "bold", "text", "italic", "text", "link", "text"],
  );

  const link = p.spans.find((s) => s.kind === "link");
  assert.equal(link.href, "/legal/terms");
  assert.equal(link.external, false);

  const table = blocks[7];
  assert.equal(table.headers.length, 2);
  assert.equal(table.rows.length, 1);
});

test("external links are marked external so they are not pushed onto the stack", () => {
  const [p] = L.parseLegalMarkdown(
    "See [the site](https://proovra.com) or mail [us](mailto:legal@proovra.com).",
  );
  const links = p.spans.filter((s) => s.kind === "link");
  assert.equal(links.length, 2);
  assert.ok(links.every((l) => l.external === true));
});

test("a line that looks like a table but is not falls through as text", () => {
  const blocks = L.parseLegalMarkdown("| not a table, no separator row");
  assert.deepEqual(blocks.map((b) => b.kind), ["p"]);
  assert.match(blocks[0].spans.map((s) => s.text).join(""), /not a table/);
});

test("the leading H1 is dropped only when it repeats the API title", () => {
  const blocks = L.parseLegalMarkdown("# Privacy Policy\n\nBody.");
  assert.equal(L.stripLeadingTitle(blocks, "Privacy Policy").length, 1);
  assert.equal(L.stripLeadingTitle(blocks, "Something Else").length, 2);
});

/* ------------------------------------------- the whole corpus, no lost lines */

test("every authored document parses into blocks", () => {
  assert.ok(DOCS.length > 0, "no legal documents were found to parse");
  for (const [slug, md] of DOCS) {
    const blocks = L.parseLegalMarkdown(md);
    assert.ok(blocks.length > 0, `${slug} produced no blocks`);
  }
});

test("no non-blank line of any document is lost", () => {
  const textOf = (spans) => spans.map((s) => s.text).join("");

  const rendered = (blocks) => {
    const out = [];
    for (const b of blocks) {
      if (b.kind === "hr") {
        out.push("---");
      } else if (b.kind === "ul" || b.kind === "ol") {
        for (const item of b.items) out.push(textOf(item));
      } else if (b.kind === "table") {
        out.push(b.headers.map(textOf).join(" "));
        for (const row of b.rows) out.push(row.map(textOf).join(" "));
      } else {
        out.push(textOf(b.spans));
      }
    }
    // Normalized identically to the expected side below: emphasis markers are
    // syntax on one side and can survive as literal text on the other (an odd
    // number of `*` inside a table cell is what makes the difference), and
    // cell joining collapses whitespace.
    return out
      .join("\n")
      .replace(/\*/g, "")
      .replace(/[ \t]+/g, " ");
  };

  for (const [slug, md] of DOCS) {
    const shown = rendered(L.parseLegalMarkdown(md));

    for (const raw of md.split("\n")) {
      const line = raw.trim();
      if (!line) continue;
      // A table separator row (`|---|---|`) and a `---` rule are syntax, not
      // content — they carry no words to lose.
      if (/^\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?$/.test(line)) continue;

      // Strip the markdown syntax the parser consumes, leaving the words.
      const words = line
        .replace(/^#{1,3}\s+/, "")
        .replace(/^-\s+/, "")
        .replace(/^\d+\.\s+/, "")
        .replace(/^\|/, "")
        .replace(/\|$/, "")
        .replace(/\|/g, " ")
        .replace(/\*\*/g, "")
        .replace(/\*/g, "")
        .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
        .replace(/[ 	]+/g, " ")
        .trim();

      if (!words || /^:?-{3,}:?$/.test(words)) continue;

      assert.ok(
        shown.includes(words),
        `${slug}: this line does not survive into any block:\n  ${line}`,
      );
    }
  }
});
