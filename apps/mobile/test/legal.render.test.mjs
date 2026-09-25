/**
 * RENDER TESTS for the legal reader.
 *
 * What these pin, because each was a defect or a decision:
 *   - Settings opened www.proovra.com in a browser for Terms and Privacy, so
 *     two documents were "reachable" and the other 23 were not reachable at
 *     all. No screen may hand a legal document to a browser again;
 *   - the reader shows the document's REAL text from `GET /v1/legal/:slug`,
 *     not a bundled copy and not a placeholder;
 *   - a 404 is "no such document", which is an answer, not a failure.
 */
import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadWithProviders, renderInProviders, React } from "./support/render.mjs";

const h = React.createElement;
const HERE = dirname(fileURLToPath(import.meta.url));
const APP = resolve(HERE, "..", "app", "(stack)");
const CONTENT_DIR = resolve(HERE, "..", "..", "..", "apps", "web", "content", "legal", "en");

const TERMS = readFileSync(join(CONTENT_DIR, "terms.md"), "utf8").replace(/\r\n/g, "\n");

let Reader;
let Index;
let responses = {};

function installFetch() {
  globalThis.fetch = async (url) => {
    const path = String(url).replace(/^https?:\/\/[^/]+/, "");
    const hit = Object.entries(responses).find(([p]) => path.startsWith(p));
    if (!hit) {
      return new Response(JSON.stringify({ error: { code: "NOT_STUBBED" } }), {
        status: 500,
        headers: { "content-type": "application/json" },
      });
    }
    const [, make] = hit;
    const { status = 200, body } = make();
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  };
}

before(async () => {
  Reader = await loadWithProviders(join(APP, "legal", "[slug].tsx"));
  Index = await loadWithProviders(join(APP, "legal", "index.tsx"));
});

beforeEach(() => {
  installFetch();
  responses = {
    "/v1/legal/terms": () => ({
      body: {
        slug: "terms",
        title: "Terms of Service",
        locale: "en",
        lastUpdated: "2026-06-23",
        contentFormat: "markdown",
        content: TERMS,
        acceptance: { policyKey: "terms", requiredVersion: "2026-04-06" },
      },
    }),
    "/v1/legal/nope": () => ({
      status: 404,
      body: { error: { code: "LEGAL_DOCUMENT_NOT_FOUND" } },
    }),
    "/v1/legal": () => ({
      body: {
        locale: "en",
        documents: [
          { slug: "terms", title: "Terms of Service", lastUpdated: "2026-06-23" },
          { slug: "dpa", title: "Data Processing Agreement (DPA)", lastUpdated: "2026-06-23" },
        ],
      },
    }),
  };
});

test("the reader renders the canonical document text", async () => {
  globalThis.__EXPO_PARAMS__ = { slug: "terms" };
  const view = await renderInProviders(Reader, h(Reader.default, null));

  const shown = view.texts().join("\n");

  // Real sentences out of the real Terms of Service, not a fixture.
  const firstHeading = TERMS.match(/^## (.+)$/m)[1];
  assert.ok(shown.includes(firstHeading), `the first section heading is missing: ${firstHeading}`);
  assert.ok(shown.includes("Terms of Service"), "the title is missing");
  assert.ok(shown.includes("2026-06-23"), "the last-updated date is missing");
  assert.ok(
    shown.includes("2026-04-06"),
    "the acceptance version the gate requires is not stated",
  );
});

test("an unknown document says so instead of failing", async () => {
  globalThis.__EXPO_PARAMS__ = { slug: "nope" };
  const view = await renderInProviders(Reader, h(Reader.default, null));

  const shown = view.texts().join("\n");
  assert.match(shown, /No such document/i);
  assert.doesNotMatch(shown, /could not be loaded/i);
});

test("the index lists the corpus and nothing is hard-coded into it", async () => {
  const view = await renderInProviders(Index, h(Index.default, null));
  const shown = view.texts().join("\n");

  assert.ok(shown.includes("Terms of Service"));
  assert.ok(shown.includes("Data Processing Agreement (DPA)"));

  const source = readFileSync(join(APP, "legal", "index.tsx"), "utf8");
  assert.doesNotMatch(
    source,
    /"Privacy Policy"|"Terms of Service"/,
    "the index hard-codes a document title instead of reading the corpus",
  );
});

/* ------------------------------------------------- no browser handoff remains */

test("no screen opens a legal document in a browser", () => {
  const offenders = [];

  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!/\.tsx?$/.test(entry.name)) continue;

      const src = readFileSync(full, "utf8");
      // A hard-coded proovra.com legal URL handed to the system browser.
      const re = /openURL\(\s*["'`][^"'`]*proovra\.com\/(legal|terms|privacy|subprocessors|data-retention|abuse-reporting)/g;
      if (re.test(src)) offenders.push(full);
    }
  };

  walk(resolve(HERE, "..", "app"));
  walk(resolve(HERE, "..", "src"));

  assert.deepEqual(
    offenders,
    [],
    "these hand a legal document to a browser instead of the canonical reader:\n  " +
      offenders.join("\n  "),
  );
});

/* ---- T-14 (LegalDocumentShell.tsx:371/:382 "On this page") ---- */

test("a document with three or more sections offers 'On this page' with every H2", async () => {
  globalThis.__EXPO_PARAMS__ = { slug: "terms" };
  const view = await renderInProviders(Reader, h(Reader.default, null));
  const h2s = [...TERMS.matchAll(/^## (.+)$/gm)].map((m) => m[1].replace(/\*\*/g, "").trim());
  assert.ok(h2s.length >= 3, "fixture precondition: the real Terms has at least three sections");
  assert.equal(view.byTestId("legal-toc").length, 1, "no section index");
  await view.press("On this page");
  assert.ok(view.byLabel(`Go to ${h2s[0]}`).length === 1, "the first section is not in the index");
  assert.ok(view.byLabel(`Go to ${h2s.at(-1)}`).length === 1, "the last section is not in the index");
  // Jumping does not throw, even where the scroll view cannot measure.
  await view.press(`Go to ${h2s[1]}`);
});
