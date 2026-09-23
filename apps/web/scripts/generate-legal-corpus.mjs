#!/usr/bin/env node
/**
 * GENERATE THE CANONICAL LEGAL CORPUS MODULE FROM `apps/web/content/legal/en/`.
 *
 * =============================================================================
 * WHY GENERATE, RATHER THAN READ AT RUNTIME
 * =============================================================================
 * The legal markdown is the authored authority. It has always lived inside
 * `apps/web`, and the web read it with `readFile(process.cwd()/content/legal/…)`.
 * Native now needs the same text, which means `services/api` needs it too — and
 * the API container image does not contain `apps/web`.
 *
 * The three ways to get it there are the same three
 * `generate-runbook-catalog.mjs` enumerates, with the same answers:
 *
 *   1. read the markdown at request time — a filesystem dependency reaching
 *      OUTSIDE the reading application. It fails in exactly the environment
 *      that matters and nowhere a developer would notice;
 *   2. copy the markdown into the API (or into the mobile binary) — a second
 *      physical copy of a privacy policy or DPA. It drifts on the next edit and
 *      a stale one is a compliance exposure, not a cosmetic bug;
 *   3. generate a committed module and gate it on freshness.
 *
 * This is (3). `apps/web/content/legal/en/` stays the single authored source,
 * both renderers derive from one module, neither performs a runtime filesystem
 * read, and `apps/web/__tests__/legal-corpus-freshness.test.ts` fails the moment
 * the module and the markdown diverge.
 *
 * =============================================================================
 * WHAT IT REFUSES TO DO
 * =============================================================================
 *   - emit a corpus missing any slug in the canonical allow-list;
 *   - emit a corpus containing a document the allow-list does not name;
 *   - emit a document whose `Last Updated:` line is absent or unparseable.
 *
 * The last one matters because `lastUpdated` is the only document metadata with
 * a canonical source. A document without it would have to be given an invented
 * date, so it fails the build of this file instead.
 *
 * Usage:
 *   node apps/web/scripts/generate-legal-corpus.mjs           # write
 *   node apps/web/scripts/generate-legal-corpus.mjs --check   # verify only
 */

import { createHash } from "node:crypto";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..", "..");
const CONTENT_DIR = join(REPO_ROOT, "apps", "web", "content", "legal", "en");
const SLUGS_FILE = join(REPO_ROOT, "packages", "shared", "src", "legal", "slugs.ts");
const OUT_FILE = join(REPO_ROOT, "packages", "shared", "src", "legal", "corpus.generated.ts");

/*
 * THE REVISIONS, WITHOUT THE TEXT.
 *
 * `LEGAL_DOCUMENT_REVISIONS` in `@proovra/shared/legal` is derived from the
 * corpus, and the corpus carries every document's full markdown. A CLIENT
 * module that only needs to know which revision it is showing — the cookie
 * consent record's `consentVersion` is the one that matters — would drag the
 * whole corpus into the bundle of every page.
 *
 * So the same generator emits the dates on their own. One source (the
 * markdown), two artifacts, no hand-maintained copy: the consent version went
 * stale by exactly that mechanism, naming 2026-04-06 while the Cookie Policy
 * said 2026-06-26.
 */
const REVISIONS_FILE = join(
  REPO_ROOT,
  "packages",
  "shared",
  "src",
  "legal",
  "revisions.generated.ts",
);

/** Read the canonical slug list out of `slugs.ts` so there is no second list. */
function readCanonicalSlugs() {
  const src = readFileSync(SLUGS_FILE, "utf8");
  const block = src.match(/export const LEGAL_SLUGS = \[([\s\S]*?)\] as const;/);
  if (!block) {
    throw new Error("could not locate LEGAL_SLUGS in " + SLUGS_FILE);
  }
  const slugs = [...block[1].matchAll(/"([a-z0-9-]+)"/g)].map((m) => m[1]);
  if (slugs.length === 0) throw new Error("LEGAL_SLUGS parsed as empty");
  return slugs;
}

const LAST_UPDATED_RE = /^Last Updated:\s*(\d{4}-\d{2}-\d{2})\s*$/im;

function parseLastUpdated(slug, markdown) {
  const m = markdown.match(LAST_UPDATED_RE);
  if (!m) {
    throw new Error(
      slug +
        '.md has no parseable "Last Updated: YYYY-MM-DD" line. ' +
        "lastUpdated is the only document metadata with a canonical source; " +
        "add the line to the document rather than inventing a date here.",
    );
  }
  return m[1];
}

function build() {
  const slugs = readCanonicalSlugs();

  const onDisk = readdirSync(CONTENT_DIR)
    .filter((f) => f.endsWith(".md"))
    .map((f) => f.slice(0, -3))
    .sort();

  const missing = slugs.filter((s) => !onDisk.includes(s));
  if (missing.length > 0) {
    throw new Error(
      "these slugs are in LEGAL_SLUGS but have no document: " + missing.join(", "),
    );
  }

  const unlisted = onDisk.filter((s) => !slugs.includes(s));
  if (unlisted.length > 0) {
    throw new Error(
      "these documents exist but are not in LEGAL_SLUGS, so nothing can reach them: " +
        unlisted.join(", "),
    );
  }

  const docs = slugs.map((slug) => {
    const markdown = readFileSync(join(CONTENT_DIR, slug + ".md"), "utf8").replace(
      /\r\n/g,
      "\n",
    );
    return { slug, markdown, lastUpdated: parseLastUpdated(slug, markdown) };
  });

  const digest = createHash("sha256");
  const SEP = String.fromCharCode(0);
  for (const d of docs) {
    digest.update(d.slug);
    digest.update(SEP);
    digest.update(d.markdown);
    digest.update(SEP);
  }
  const sha = digest.digest("hex");

  const entries = docs
    .map(
      (d) =>
        "  " +
        JSON.stringify(d.slug) +
        ": {\n    lastUpdated: " +
        JSON.stringify(d.lastUpdated) +
        ",\n    markdown: " +
        JSON.stringify(d.markdown) +
        ",\n  },",
    )
    .join("\n");

  const header = [
    "// GENERATED FILE — DO NOT EDIT.",
    "//",
    "// Source:    apps/web/content/legal/en/*.md",
    "// Generator: apps/web/scripts/generate-legal-corpus.mjs",
    "// Gate:      apps/web/__tests__/legal-corpus-freshness.test.ts",
    "//",
    "// Editing this file instead of the markdown makes the generated copy the",
    "// authority, which is the duplicate-truth failure the generator exists to",
    "// prevent. Edit the markdown and re-run the generator.",
    "",
    'import type { LegalSlug } from "./slugs.js";',
    "",
    "export type LegalCorpusEntry = {",
    "  /** The document's own `Last Updated:` line. The only canonical metadata it carries. */",
    "  readonly lastUpdated: string;",
    "  readonly markdown: string;",
    "};",
    "",
    "/** Digest of every (slug, markdown) pair, in canonical slug order. */",
    "export const LEGAL_CORPUS_SHA256 = " + JSON.stringify(sha) + ";",
    "",
    "export const LEGAL_CORPUS: Readonly<Record<LegalSlug, LegalCorpusEntry>> = {",
  ].join("\n");

  const revisionEntries = docs
    .map((d) => "  " + JSON.stringify(d.slug) + ": " + JSON.stringify(d.lastUpdated) + ",")
    .join("\n");

  const revisionsHeader = [
    "// GENERATED FILE — DO NOT EDIT.",
    "//",
    "// Source:    apps/web/content/legal/en/*.md",
    "// Generator: apps/web/scripts/generate-legal-corpus.mjs",
    "// Gate:      apps/web/__tests__/legal-corpus-freshness.test.ts",
    "//",
    "// Each document's own `Last Updated:` line, and nothing else. This exists",
    "// so a CLIENT module can state which revision it is showing without",
    "// importing the corpus, which carries the full text of every document.",
    "",
    'import type { LegalSlug } from "./slugs.js";',
    "",
    "export const LEGAL_REVISIONS: Readonly<Record<LegalSlug, string>> = {",
  ].join("\n");

  return {
    source: header + "\n" + entries + "\n};\n",
    revisionsSource: revisionsHeader + "\n" + revisionEntries + "\n};\n",
    sha,
    count: docs.length,
  };
}

const built = build();
const check = process.argv.includes("--check");

if (check) {
  let current = "";
  let currentRevisions = "";
  try {
    current = readFileSync(OUT_FILE, "utf8");
  } catch {
    console.error("legal corpus module is missing: " + OUT_FILE);
    process.exit(1);
  }
  try {
    currentRevisions = readFileSync(REVISIONS_FILE, "utf8");
  } catch {
    console.error("legal revisions module is missing: " + REVISIONS_FILE);
    process.exit(1);
  }
  if (currentRevisions !== built.revisionsSource) {
    console.error(
      "legal revisions module is STALE.\n" +
        "  apps/web/content/legal/en/ has changed since it was generated.\n" +
        "  Run: node apps/web/scripts/generate-legal-corpus.mjs",
    );
    process.exit(1);
  }
  if (current !== built.source) {
    console.error(
      "legal corpus module is STALE.\n" +
        "  apps/web/content/legal/en/ has changed since it was generated.\n" +
        "  Run: node apps/web/scripts/generate-legal-corpus.mjs",
    );
    process.exit(1);
  }
  console.log(
    "legal corpus is fresh (" + built.count + " documents, " + built.sha.slice(0, 12) + ").",
  );
} else {
  writeFileSync(OUT_FILE, built.source, "utf8");
  writeFileSync(REVISIONS_FILE, built.revisionsSource, "utf8");
  console.log(
    "wrote " + OUT_FILE + " (" + built.count + " documents, " + built.sha.slice(0, 12) + ").",
  );
}
