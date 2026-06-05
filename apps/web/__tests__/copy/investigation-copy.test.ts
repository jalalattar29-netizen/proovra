/**
 * Regression lock: user-facing copy for the Investigation tree and the
 * classifier-driven OperationalEmptyState must remain operator-facing
 * (no developer / release-train language).
 *
 * Why this exists:
 *   - Several pages and the empty-state primitive previously surfaced
 *     internal language like "Wave 2", "No producer wired yet — see
 *     Wave 2", "Nothing has been recorded here yet.", and the literal
 *     enum identifier via `kind.toLowerCase()`.
 *   - This test pins the NEW canonical copy strings and forbids the
 *     OLD strings so any future regression that re-introduces dev
 *     copy fails the suite.
 *
 * Runs under Node's built-in `node:test` so it does not require a new
 * test runner in apps/web. Invoke with e.g.
 *   `node --test --import tsx apps/web/__tests__/copy/investigation-copy.test.ts`
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const WEB_ROOT = resolve(__dirname, "..", "..");
const REPO_ROOT = resolve(WEB_ROOT, "..", "..");

const EMPTY_STATE_SRC = readFileSync(
  resolve(WEB_ROOT, "components", "operational", "OperationalEmptyState.tsx"),
  "utf8",
);
const CLASSIFIER_SRC = readFileSync(
  resolve(WEB_ROOT, "lib", "empty-state", "classifier.ts"),
  "utf8",
);
const PRODUCER_MODE_SRC = readFileSync(
  resolve(
    REPO_ROOT,
    "packages",
    "shared-runtime",
    "src",
    "media-intelligence",
    "producer-mode.ts",
  ),
  "utf8",
);
const OVERVIEW_SRC = readFileSync(
  resolve(WEB_ROOT, "app", "(app)", "investigation", "page.tsx"),
  "utf8",
);
const TIMELINE_SRC = readFileSync(
  resolve(WEB_ROOT, "app", "(app)", "investigation", "timeline", "page.tsx"),
  "utf8",
);
const DUPLICATES_SRC = readFileSync(
  resolve(WEB_ROOT, "app", "(app)", "investigation", "duplicates", "page.tsx"),
  "utf8",
);
const REVIEWERS_SRC = readFileSync(
  resolve(WEB_ROOT, "app", "(app)", "investigation", "reviewers", "page.tsx"),
  "utf8",
);
const GRAPH_SRC = readFileSync(
  resolve(WEB_ROOT, "app", "(app)", "investigation", "graph", "page.tsx"),
  "utf8",
);

// ---------------------------------------------------------------------------
// 1. New canonical copy is present.
// ---------------------------------------------------------------------------

test("OperationalEmptyState TRUE_EMPTY uses operator-facing title", () => {
  assert.ok(
    EMPTY_STATE_SRC.includes(
      "No analyses for this workspace yet. Capture or link evidence to populate this view.",
    ),
    "TRUE_EMPTY title must use the new operator-facing copy",
  );
});

test("OperationalEmptyState CAPABILITY_UNAVAILABLE uses operator-facing title", () => {
  assert.ok(
    EMPTY_STATE_SRC.includes(
      "This view is not available in your current workspace configuration.",
    ),
    "CAPABILITY_UNAVAILABLE title must use the new operator-facing copy",
  );
});

test("classifier CAPABILITY_UNAVAILABLE_GENERIC uses operator-facing reason", () => {
  assert.ok(
    CLASSIFIER_SRC.includes(
      "This capability is not enabled for your workspace. Contact your administrator.",
    ),
    "CAPABILITY_UNAVAILABLE_GENERIC must use the new operator-facing copy",
  );
});

test("producer-mode DEFERRED_NO_PRODUCER uses operator-facing copy", () => {
  assert.ok(
    PRODUCER_MODE_SRC.includes(
      `DEFERRED_NO_PRODUCER: "Provider not configured for this workspace."`,
    ),
    "DEFERRED_NO_PRODUCER must use the new operator-facing copy",
  );
});

test("graph page uses a singular-label map (not `kind.toLowerCase()`)", () => {
  assert.ok(
    GRAPH_SRC.includes("SEED_KIND_SINGULAR_LABELS"),
    "graph page must use SEED_KIND_SINGULAR_LABELS to label section-level empty states",
  );
  assert.ok(
    GRAPH_SRC.includes(
      "No {SEED_KIND_SINGULAR_LABELS[kind]} entries in the workspace map yet.",
    ),
    "graph page section-empty must read the label from the map, not via toLowerCase",
  );
});

test("freshness pills surface fetch-error retry text (not 'No X recorded yet')", () => {
  assert.ok(
    GRAPH_SRC.includes('"Graph unavailable — retrying"'),
    "graph freshness pill must signal retry on fetch error",
  );
  assert.ok(
    OVERVIEW_SRC.includes('"Overview unavailable — retrying"'),
    "investigation overview freshness pill must signal retry on fetch error",
  );
  assert.ok(
    DUPLICATES_SRC.includes('"Relationships unavailable — retrying"'),
    "duplicates freshness pill must signal retry on fetch error",
  );
  assert.ok(
    REVIEWERS_SRC.includes('"Reviewer activity unavailable — retrying"'),
    "reviewers freshness pill must signal retry on fetch error",
  );
});

// ---------------------------------------------------------------------------
// 2. Forbidden substrings — the OLD developer copy must never reappear.
// ---------------------------------------------------------------------------

const FORBIDDEN_COPY: ReadonlyArray<{
  description: string;
  source: string;
  sourceName: string;
  needle: string;
}> = [
  // Old TRUE_EMPTY title.
  {
    description: "old TRUE_EMPTY title (\"Nothing has been recorded here yet\")",
    source: EMPTY_STATE_SRC,
    sourceName: "OperationalEmptyState.tsx",
    needle: "Nothing has been recorded here yet.",
  },
  // Old CAPABILITY_UNAVAILABLE title.
  {
    description:
      "old CAPABILITY_UNAVAILABLE title (\"The capability backing this surface is not wired yet\")",
    source: EMPTY_STATE_SRC,
    sourceName: "OperationalEmptyState.tsx",
    needle: "The capability backing this surface is not wired yet.",
  },
  // Old classifier generic reason.
  {
    description:
      "old CAPABILITY_UNAVAILABLE_GENERIC (\"not wired in this release. See the upcoming Wave\")",
    source: CLASSIFIER_SRC,
    sourceName: "classifier.ts",
    needle: "not wired in this release. See the upcoming Wave",
  },
  // Old producer-mode copy.
  {
    description:
      "old DEFERRED_NO_PRODUCER copy (\"No producer wired yet — see Wave 2\")",
    source: PRODUCER_MODE_SRC,
    sourceName: "producer-mode.ts",
    needle: "No producer wired yet",
  },
  // Old freshness-pill error strings.
  {
    description:
      "old graph freshness-pill error string (\"No graph yet\")",
    source: GRAPH_SRC,
    sourceName: "investigation/graph/page.tsx",
    needle: '"No graph yet"',
  },
  {
    description:
      "old investigation overview freshness-pill error string (\"No analyses recorded yet\")",
    source: OVERVIEW_SRC,
    sourceName: "investigation/page.tsx",
    needle: '"No analyses recorded yet"',
  },
  {
    description:
      "old timeline freshness-pill error string (\"No events recorded yet\")",
    source: TIMELINE_SRC,
    sourceName: "investigation/timeline/page.tsx",
    needle: '"No events recorded yet"',
  },
  {
    description:
      "old duplicates freshness-pill error string (\"No relationships recorded yet\")",
    source: DUPLICATES_SRC,
    sourceName: "investigation/duplicates/page.tsx",
    needle: '"No relationships recorded yet"',
  },
  {
    description:
      "old reviewers freshness-pill error string (\"No reviewer activity recorded yet\")",
    source: REVIEWERS_SRC,
    sourceName: "investigation/reviewers/page.tsx",
    needle: '"No reviewer activity recorded yet"',
  },
  // The toLowerCase leak in the graph SeedSection.
  {
    description: "graph SeedSection toLowerCase enum leak",
    source: GRAPH_SRC,
    sourceName: "investigation/graph/page.tsx",
    needle: "No {kind.toLowerCase()} entries",
  },
];

for (const f of FORBIDDEN_COPY) {
  test(`forbidden: ${f.description} must not appear in ${f.sourceName}`, () => {
    assert.ok(
      !f.source.includes(f.needle),
      `${f.sourceName} still contains forbidden developer copy: ${JSON.stringify(f.needle)}`,
    );
  });
}

// ---------------------------------------------------------------------------
// 3. Cross-cutting: user-facing files in the Investigation tree must not
//    leak Wave / Phase tokens inside JSX string literals or text nodes.
//    Doc-comments (// or /* */) are excluded.
// ---------------------------------------------------------------------------

function stripComments(src: string): string {
  // Remove /* ... */ blocks (greedy across lines).
  let out = src.replace(/\/\*[\s\S]*?\*\//g, "");
  // Remove // line comments.
  out = out.replace(/(^|[^:])\/\/[^\n]*/g, "$1");
  return out;
}

const INVESTIGATION_PAGES: ReadonlyArray<{ name: string; src: string }> = [
  { name: "investigation/page.tsx", src: OVERVIEW_SRC },
  { name: "investigation/timeline/page.tsx", src: TIMELINE_SRC },
  { name: "investigation/duplicates/page.tsx", src: DUPLICATES_SRC },
  { name: "investigation/reviewers/page.tsx", src: REVIEWERS_SRC },
  { name: "investigation/graph/page.tsx", src: GRAPH_SRC },
];

const FORBIDDEN_TOKENS: ReadonlyArray<{ name: string; regex: RegExp }> = [
  { name: "Wave \\d in JSX text", regex: /Wave\s*\d/i },
  { name: "Phase \\d in JSX text", regex: /Phase\s*\d/i },
  { name: "\"not wired\" leak", regex: /not wired/i },
  { name: "\"producer wired\" leak", regex: /producer wired/i },
];

for (const page of INVESTIGATION_PAGES) {
  const cleaned = stripComments(page.src);
  for (const tok of FORBIDDEN_TOKENS) {
    test(`${page.name} non-comment body must not contain ${tok.name}`, () => {
      assert.ok(
        !tok.regex.test(cleaned),
        `${page.name} non-comment body matched forbidden token /${tok.regex.source}/${tok.regex.flags}`,
      );
    });
  }
}
