/**
 * THE LEGAL CORPUS — ONE SOURCE, AND PROOF THAT IT IS ONE.
 *
 * ===========================================================================
 * WHAT CAN GO WRONG, AND WHY EACH IS GATED
 * ===========================================================================
 * 1. A READER SHOWS A SUPERSEDED POLICY. `apps/web/content/legal/en/*.md` is
 *    the authored authority; `packages/shared/src/legal/corpus.generated.ts`
 *    is a build of it. If they diverge, the web, the API and the Native app
 *    display a privacy policy or DPA that the repository has already
 *    corrected — and nobody can tell which one a user accepted. That is the
 *    entire cost of generating rather than reading at request time, so it is
 *    the first thing asserted.
 *
 * 2. A SECOND CORPUS APPEARS. The failure this delivery exists to prevent is
 *    a copy of the legal text living somewhere else — bundled into the mobile
 *    binary, seeded into a table, or re-authored in the API. A slug list or a
 *    title map counts too: two allow-lists mean a document reachable on one
 *    surface and 404 on another.
 *
 * 3. THE WEB QUIETLY GOES BACK TO THE FILESYSTEM. `loadLegalMarkdown` reading
 *    `process.cwd()` again would work in development and on the web, and leave
 *    the API with nothing to read — which is exactly the state this replaced.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const APP_ROOT = resolve(HERE, "..");
const REPO_ROOT = resolve(APP_ROOT, "..", "..");

const CONTENT_DIR = join(APP_ROOT, "content", "legal", "en");
const GENERATOR = join(APP_ROOT, "scripts", "generate-legal-corpus.mjs");
const SLUGS_FILE = join(REPO_ROOT, "packages", "shared", "src", "legal", "slugs.ts");
const CORPUS_FILE = join(
  REPO_ROOT,
  "packages",
  "shared",
  "src",
  "legal",
  "corpus.generated.ts",
);
const LEGAL_ENTRY = join(REPO_ROOT, "packages", "shared", "src", "legal.ts");
const WEB_LEGAL_CONTENT = join(APP_ROOT, "app", "legal", "legal-content.tsx");

const read = (p: string) => readFileSync(p, "utf8");

// ---------------------------------------------------------------------------
// 1. Freshness
// ---------------------------------------------------------------------------

test("the generated legal corpus matches apps/web/content/legal/en", () => {
  const run = spawnSync(process.execPath, [GENERATOR, "--check"], {
    encoding: "utf8",
    cwd: REPO_ROOT,
  });

  assert.equal(
    run.status,
    0,
    "legal corpus is stale or unbuildable:\n" +
      (run.stderr || run.stdout || "(no output)"),
  );
});

test("every authored document is in the corpus, and nothing else is", () => {
  const onDisk = readdirSync(CONTENT_DIR)
    .filter((f) => f.endsWith(".md"))
    .map((f) => f.slice(0, -3))
    .sort();

  const corpus = read(CORPUS_FILE);
  const inCorpus = [...corpus.matchAll(/^ {2}"([a-z0-9-]+)": \{$/gm)]
    .map((m) => m[1])
    .sort();

  assert.deepEqual(
    inCorpus,
    onDisk,
    "the generated corpus and the authored markdown name different documents",
  );
});

test("every document carries its own Last Updated date", () => {
  const corpus = read(CORPUS_FILE);
  const dates = [...corpus.matchAll(/^ {4}lastUpdated: "([^"]+)",$/gm)].map(
    (m) => m[1],
  );

  assert.ok(dates.length > 0, "no lastUpdated values were emitted at all");

  for (const d of dates) {
    assert.match(
      d,
      /^\d{4}-\d{2}-\d{2}$/,
      `lastUpdated ${JSON.stringify(d)} is not a YYYY-MM-DD date`,
    );
  }
});

// ---------------------------------------------------------------------------
// 2. One corpus, one allow-list
// ---------------------------------------------------------------------------

test("the generated corpus is marked as generated and names its generator", () => {
  const corpus = read(CORPUS_FILE);
  assert.match(corpus, /GENERATED FILE — DO NOT EDIT/);
  assert.match(corpus, /apps\/web\/scripts\/generate-legal-corpus\.mjs/);
});

test("the web holds no slug list and no title map of its own", () => {
  const content = read(WEB_LEGAL_CONTENT);

  assert.match(
    content,
    /from "@proovra\/shared\/legal"/,
    "apps/web must take legal identity from the shared module",
  );

  // The old shape: a literal Set of slugs, and a literal slug→title map.
  assert.doesNotMatch(
    content,
    /new Set\(\[\s*\n\s*"privacy"/,
    "apps/web re-declared its own slug allow-list",
  );
  assert.doesNotMatch(
    content,
    /privacy: "Privacy Policy"/,
    "apps/web re-declared its own title map",
  );
});

test("nothing outside the authored corpus ships legal markdown", () => {
  // A second physical copy of the legal text is the failure mode. The corpus
  // directory and the generated module are the only places it may exist.
  const offenders: string[] = [];
  const skip = new Set([
    "node_modules",
    ".git",
    ".next",
    "dist",
    "build",
    "android",
    "ios",
    "audit-output",
  ]);

  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (skip.has(entry.name)) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.name.endsWith(".md")) continue;
      if (full.startsWith(join(APP_ROOT, "content", "legal"))) continue;

      const text = read(full);
      // The corpus signature: a legal document states its own Last Updated
      // line directly under an H1 title.
      if (/^# .+\n\nLast Updated: \d{4}-\d{2}-\d{2}\n/m.test(text)) {
        offenders.push(full.slice(REPO_ROOT.length + 1).replace(/\\/g, "/"));
      }
    }
  };

  for (const top of ["apps", "packages", "services"]) {
    walk(join(REPO_ROOT, top));
  }

  assert.deepEqual(
    offenders,
    [],
    "these files are a SECOND copy of legal document text:\n  " +
      offenders.join("\n  "),
  );
});

// ---------------------------------------------------------------------------
// 3. No runtime filesystem read
// ---------------------------------------------------------------------------

test("the web legal loader does not read the filesystem at request time", () => {
  const content = read(WEB_LEGAL_CONTENT);

  assert.doesNotMatch(
    content,
    /node:fs/,
    "the legal loader reads the filesystem again — the API cannot follow it there",
  );
  assert.doesNotMatch(content, /process\.cwd\(\)/);
});

test("the shared legal module does not read the filesystem either", () => {
  for (const file of [LEGAL_ENTRY, SLUGS_FILE, CORPUS_FILE]) {
    const src = read(file);
    assert.doesNotMatch(
      src,
      /node:fs|require\("fs"\)|from "fs"/,
      `${file} performs a filesystem read; it is consumed by an image that has no corpus on disk`,
    );
  }
});

// ---------------------------------------------------------------------------
// 4. The contract carries only metadata that has a canonical source
// ---------------------------------------------------------------------------

test("the legal document contract invents no version or effective date", () => {
  const entry = read(LEGAL_ENTRY);

  const documentType = entry.match(
    /export type LegalDocument = \{([\s\S]*?)\n\};/,
  );
  assert.ok(documentType, "LegalDocument type not found");

  for (const invented of ["version", "effectiveAt", "publishedAt", "revision"]) {
    assert.doesNotMatch(
      documentType[1],
      new RegExp("\\b" + invented + "\\b"),
      `LegalDocument carries "${invented}", which no authored document states`,
    );
  }

  assert.match(documentType[1], /lastUpdated/);
});
