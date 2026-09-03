/**
 * DOES THE DETECTOR STILL FAIL ON THE DEFECT IT CLAIMS TO CATCH?
 *
 * ===========================================================================
 * WHY THIS EXISTS
 * ===========================================================================
 * `admin-composition-contract.mjs` reported `47 pages · 47 meet the contract`.
 * That sentence has two readings — every page is correct, or the detector
 * stopped detecting — and the exit code cannot tell them apart.
 *
 * It was the second one, twice over. This file found both:
 *
 *   LIST_NO_PAGINATION   matched `/page|cursor|limit|offset/i` anywhere in the
 *                        file. Every module here is `export default function
 *                        SomethingPage()`, so all 47 matched on their own
 *                        component name. The check could not fire, ever.
 *
 *   LIST_NO_TOTAL_COUNT  matched the WORD `count`, which
 *                        `data-testid="admin-support-grants-count"` satisfies.
 *                        Deleting a page's entire count left it green,
 *                        because the test id naming the deleted thing stayed.
 *
 * Repairing them turned up thirteen pages that had been passing on dead
 * checks. "Zero findings" was true of the instrument and false of the product.
 *
 * There is precedent for the mechanism too: a shell heredoc twice turned a
 * `\b` into a literal BACKSPACE byte inside these scripts, silently disabling
 * a regex while the script went on printing a clean result.
 *
 * ===========================================================================
 * WHY SYNTHETIC PAGES AND ALSO REAL ONES
 * ===========================================================================
 * Synthetic pages isolate one clause each: the control and the mutant differ
 * by exactly the property under test, so a firing check is unambiguous.
 *
 * They are also the weaker half, and were weak here in a specific way — the
 * first version had no `useState` and no `useEffect`, so `filterKind` saw no
 * filters at all and three mutations "passed" for the wrong reason. A fixture
 * written by the same hand as the detector shares its blind spots. So the
 * second half mutates REAL pages: remove the property, assert the check fires
 * against the code shape it actually has to work against.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const WEB = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(WEB, "scripts", "admin-composition-contract.mjs");
const REAL_ADMIN = join(WEB, "app", "(app)", "admin");

/** Runs the contract against a throwaway root and returns its findings. */
function findingsIn(root) {
  const out = execFileSync(
    process.execPath,
    [SCRIPT, "--root", root, "--json"],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  return JSON.parse(out).rows;
}

function scratch() {
  const dir = mkdtempSync(join(tmpdir(), "admin-contract-adv-"));
  return {
    dir,
    /** Writes `page.tsx` at `app/(app)/admin/<route>`. */
    page(route, code) {
      const at = join(dir, "app", "(app)", "admin", ...route.split("/"));
      mkdirSync(at, { recursive: true });
      writeFileSync(join(at, "page.tsx"), code, "utf8");
      return dir;
    },
    dispose() {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

// ---------------------------------------------------------------------------
// The fixture, in removable pieces.
// ---------------------------------------------------------------------------
// Shaped like a real page on purpose. `filterKind` decides a filter is
// server-side by finding its state in the dependency array of a block that
// fetches, so a fixture without hooks has no filters as far as the contract is
// concerned — which is how the first version of this file proved nothing.

const LIST = {
  filterState: 'const [statusFilter, setStatusFilter] = useState("");',
  filters:
    '<select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}><option value="">All</option></select>',
  serverSide: 'params.set("status", statusFilter);',
  paging: 'params.set("limit", "50");',
  count: '<ResultCount shown={rows.length} total={total} noun="thing" />',
  filteredEmpty:
    '{rows.length === 0 ? "No things match these filters" : null}',
  table:
    '<div style={{ overflowX: "auto" }}><table><tbody>{rows.map((x) => <tr key={x.id}><td>{x.id}</td></tr>)}</tbody></table></div>',
};

function listPage(omit = []) {
  const part = (k) => (omit.includes(k) ? "" : LIST[k]);
  return [
    '"use client";',
    'import { useEffect, useState } from "react";',
    'import { apiFetch } from "../../../../lib/api";',
    "export default function Page() {",
    "  const [rows, setRows] = useState([]);",
    "  const [total, setTotal] = useState(0);",
    "  " + part("filterState"),
    "  useEffect(() => {",
    "    const params = new URLSearchParams();",
    "    " + part("paging"),
    "    " + part("serverSide"),
    "    apiFetch(`/v1/things?${params.toString()}`).then((r) => {",
    "      setRows(r.rows);",
    "      setTotal(r.total);",
    "    });",
    "  }, [statusFilter]);",
    "  return (<div>",
    "    " + part("filters"),
    "    " + part("count"),
    "    " + part("filteredEmpty"),
    "    " + part("table"),
    "  </div>);",
    "}",
  ].join("\n");
}

const DETAIL = {
  back: '<a href="/admin/things">← Back to all things</a>',
  when: "<time dateTime={x.createdAt}>{formatDateTime(x.createdAt)}</time>",
  state: "<Badge>{x.status}</Badge>",
};

function detailPage(omit = []) {
  const part = (k) => (omit.includes(k) ? "" : DETAIL[k]);
  return [
    '"use client";',
    'import { apiFetch } from "../../../../../lib/api";',
    "export default function Page() {",
    '  const x = use(apiFetch("/v1/things/1"));',
    "  return (<div>" + part("back") + part("when") + part("state") + "</div>);",
    "}",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// The control. If this fails, every mutation below is meaningless.
// ---------------------------------------------------------------------------

test("the synthetic control satisfies every clause", () => {
  const s = scratch();
  try {
    s.page("things", listPage());
    s.page("things/[id]", detailPage());
    const rows = findingsIn(s.dir);
    assert.equal(rows.length, 2, "both fixture pages were scanned");
    for (const r of rows) {
      assert.deepEqual(
        r.failures,
        [],
        `the control page ${r.route} should satisfy the contract`,
      );
    }
    assert.equal(rows.find((r) => r.route === "/admin/things").kind, "list");
    assert.equal(
      rows.find((r) => r.route === "/admin/things/:id").kind,
      "detail",
    );
  } finally {
    s.dispose();
  }
});

// ---------------------------------------------------------------------------
// One clause removed at a time.
// ---------------------------------------------------------------------------

const MUTATIONS = [
  { omit: ["count"], expect: "LIST_NO_TOTAL_COUNT" },
  { omit: ["filters", "filterState", "serverSide"], expect: "LIST_NO_FILTERS" },
  // Both halves. The clause is satisfied by paging OR by a count that cannot
  // overstate completeness, so removing only one of them proves nothing.
  { omit: ["paging", "count"], expect: "LIST_NO_PAGINATION" },
  { omit: ["filteredEmpty"], expect: "LIST_NO_FILTERED_EMPTY" },
];

for (const { omit, expect } of MUTATIONS) {
  test(`${expect} fires when the page drops ${omit.join(" + ")}`, () => {
    const s = scratch();
    try {
      s.page("things", listPage(omit));
      const [row] = findingsIn(s.dir);
      assert.ok(
        row.failures.includes(expect),
        `expected ${expect}; got [${row.failures.join(", ")}] on a ${row.kind}`,
      );
    } finally {
      s.dispose();
    }
  });
}

test("LIST_TABLE_NOT_SCROLLABLE fires on a table with no scroll container", () => {
  const s = scratch();
  try {
    s.page(
      "things",
      listPage().replace('<div style={{ overflowX: "auto" }}>', "<div>"),
    );
    const [row] = findingsIn(s.dir);
    assert.ok(
      row.failures.includes("LIST_TABLE_NOT_SCROLLABLE"),
      `got [${row.failures.join(", ")}]`,
    );
  } finally {
    s.dispose();
  }
});

test("LIST_FILTER_NOT_SERVER_SIDE fires when a paged list filters locally", () => {
  // The defect: a control narrows the rows already in the browser while the
  // server keeps paging the unnarrowed set. The reader sees "3 results" out of
  // a page of 50 and has no way to know the other 290 were never consulted.
  const s = scratch();
  try {
    s.page(
      "things",
      // `paging` goes too, not because the list stops being paged — the URL
      // below still carries `limit=50` — but because its `params.set(…)` is
      // one of the shapes the check reads as "the request was built from the
      // controls". Leaving it in made the mutant look server-side.
      listPage(["serverSide", "paging"])
        // Out of the fetching effect's dependency array — that is what makes
        // the filter "declared" rather than "request". Left in, the contract
        // correctly classifies it as server-side and the clause never applies.
        .replace("}, [statusFilter]);", "}, []);")
        .replace(
          "  return (<div>",
          "  const shown = rows.filter((x) => x.status === statusFilter);\n  return (<div>",
        )
        .replace("const params = new URLSearchParams();", 'const q = "?limit=50";')
        .replace("apiFetch(`/v1/things?${params.toString()}`)", "apiFetch(`/v1/things` + q)"),
    );
    const [row] = findingsIn(s.dir);
    assert.ok(
      row.failures.includes("LIST_FILTER_NOT_SERVER_SIDE"),
      `got [${row.failures.join(", ")}]`,
    );
  } finally {
    s.dispose();
  }
});

for (const [omit, expected] of [
  [["back"], "DETAIL_NO_RETURN_PATH"],
  [["when"], "DETAIL_NO_TIMESTAMPS"],
  [["state"], "DETAIL_NO_STATE"],
]) {
  test(`${expected} fires when a detail page drops ${omit[0]}`, () => {
    const s = scratch();
    try {
      s.page("things/[id]", detailPage(omit));
      const [row] = findingsIn(s.dir);
      assert.ok(
        row.failures.includes(expected),
        `got [${row.failures.join(", ")}] on a ${row.kind}`,
      );
    } finally {
      s.dispose();
    }
  });
}

// ---------------------------------------------------------------------------
// The two whole-page clauses.
// ---------------------------------------------------------------------------

test("LONE_VALUE_CARD_WALL fires on a column of boxes each holding one number", () => {
  const s = scratch();
  try {
    const card = (v) => `<Card><div>{${v}}</div></Card>`;
    s.page(
      "wall",
      [
        '"use client";',
        "export default function Page() {",
        "  return (<div>",
        "    " + ["a", "b", "c", "d", "e"].map(card).join(""),
        "  </div>);",
        "}",
      ].join("\n"),
    );
    const [row] = findingsIn(s.dir);
    assert.ok(
      row.failures.includes("LONE_VALUE_CARD_WALL"),
      `got [${row.failures.join(", ")}]`,
    );
  } finally {
    s.dispose();
  }
});

test("a status BANNER is not counted as a stat card", () => {
  // The discrimination that matters, and the one the check got wrong first
  // time: /admin/support-access has five `variant="status"` error banners, at
  // most one or two ever on screen, and they were reported as a wall of
  // numbers. If this passed only because the check counts nothing, the test
  // above would fail — the pair is what makes either meaningful.
  const s = scratch();
  try {
    const banner = (v) => `<Card variant="status" tone="risk">{${v}}</Card>`;
    s.page(
      "banners",
      [
        '"use client";',
        "export default function Page() {",
        "  return (<div>",
        "    " + ["errA", "errB", "errC", "errD", "errE"].map(banner).join(""),
        "  </div>);",
        "}",
      ].join("\n"),
    );
    const [row] = findingsIn(s.dir);
    assert.ok(
      !row.failures.includes("LONE_VALUE_CARD_WALL"),
      `status banners were miscounted as a card wall: [${row.failures.join(", ")}]`,
    );
  } finally {
    s.dispose();
  }
});

test("DUPLICATE_PRIMARY_ACTION fires when a surface has four primary buttons", () => {
  const s = scratch();
  try {
    s.page(
      "actions",
      [
        '"use client";',
        "export default function Page() {",
        "  return (<div>",
        ...["A", "B", "C", "D"].map(
          (l) => `    <Button variant="primary">${l}</Button>`,
        ),
        "  </div>);",
        "}",
      ].join("\n"),
    );
    const [row] = findingsIn(s.dir);
    assert.ok(
      row.failures.includes("DUPLICATE_PRIMARY_ACTION"),
      `got [${row.failures.join(", ")}]`,
    );
  } finally {
    s.dispose();
  }
});

test("three primary actions are not a finding", () => {
  // The boundary. A page with a couple of distinct primary paths is normal;
  // the clause is about a surface where everything is emphasised and so
  // nothing is.
  const s = scratch();
  try {
    s.page(
      "actions",
      [
        '"use client";',
        "export default function Page() {",
        "  return (<div>",
        ...["A", "B", "C"].map(
          (l) => `    <Button variant="primary">${l}</Button>`,
        ),
        "  </div>);",
        "}",
      ].join("\n"),
    );
    const [row] = findingsIn(s.dir);
    assert.ok(
      !row.failures.includes("DUPLICATE_PRIMARY_ACTION"),
      `got [${row.failures.join(", ")}]`,
    );
  } finally {
    s.dispose();
  }
});

// ---------------------------------------------------------------------------
// The same properties, removed from REAL pages.
// ---------------------------------------------------------------------------

/** Copies the real admin tree, applies `edit`, and scans the copy. */
function mutateReal(routeDir, edit) {
  const dir = mkdtempSync(join(tmpdir(), "admin-contract-real-"));
  try {
    const dest = join(dir, "app", "(app)", "admin");
    mkdirSync(dirname(dest), { recursive: true });
    cpSync(REAL_ADMIN, dest, { recursive: true });
    const page = join(dest, ...routeDir.split("/"), "page.tsx");
    const before = readFileSync(page, "utf8");
    const after = edit(before);
    assert.notEqual(after, before, `the mutation changed nothing in ${routeDir}`);
    writeFileSync(page, after, "utf8");
    return findingsIn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("an unmutated copy of the real tree is clean", () => {
  // Establishes that the copy itself introduces nothing — otherwise a finding
  // below could be an artefact of the copy rather than of the mutation.
  const dir = mkdtempSync(join(tmpdir(), "admin-contract-copy-"));
  try {
    const dest = join(dir, "app", "(app)", "admin");
    mkdirSync(dirname(dest), { recursive: true });
    cpSync(REAL_ADMIN, dest, { recursive: true });
    const rows = findingsIn(dir);
    assert.equal(rows.length, 47, "all 47 routes were scanned");
    assert.deepEqual(
      rows.filter((r) => r.failures.length > 0),
      [],
      "an unmutated copy has no findings",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("removing every rendered count from /admin/support-access is caught", () => {
  // All four shapes, because the clause is about a NUMBER ON SCREEN and the
  // page has more than one way of putting one there. The earlier version of
  // this test removed only the component and passed — against a check that
  // was matching the word "count" in a test id.
  const rows = mutateReal("support-access", (src) =>
    src
      .replace(/<ResultCount[\s\S]*?\/>/g, "")
      .replace(/\{[^{}]*\btotal\b[^{}]*\}/gi, "{0}")
      .replace(/\{\s*[\w.]*\.length\s*\}/g, "{0}")
      .replace(/of\s*\{/g, "at {"),
  );
  const row = rows.find((r) => r.route === "/admin/support-access");
  assert.ok(
    row.failures.includes("LIST_NO_TOTAL_COUNT"),
    `got [${row.failures.join(", ")}]`,
  );
});

test("removing the real filtered-empty wording from /admin/contact-sales is caught", () => {
  const rows = mutateReal("contact-sales", (src) =>
    src
      .replace(/match these filters/g, "")
      .replace(/matching/g, "")
      .replace(/\bmatch\b/g, ""),
  );
  const row = rows.find((r) => r.route === "/admin/contact-sales");
  assert.ok(
    row.failures.includes("LIST_NO_FILTERED_EMPTY"),
    `got [${row.failures.join(", ")}]`,
  );
});

test("unwrapping a real table's scroll container is caught", () => {
  // /admin/contact-sales, not /admin/customers: the customers roster renders
  // through <DataTable>, so it has no `<table` element for this check to apply
  // to and the mutation would have proved nothing.
  const rows = mutateReal("contact-sales", (src) =>
    src
      .replace(/overflowX:\s*"auto"/g, 'overflowX: "visible"')
      .replace(/overflow-x/g, "overflow-y")
      .replace(/apf-table-wrap/g, "apf-table-plain")
      .replace(/table-wrap/g, "table-plain")
      .replace(/overflow:\s*auto/g, "overflow: visible"),
  );
  const row = rows.find((r) => r.route === "/admin/contact-sales");
  assert.ok(
    row.failures.includes("LIST_TABLE_NOT_SCROLLABLE"),
    `got [${row.failures.join(", ")}]`,
  );
});

test("removing a real detail page's way back is caught", () => {
  const rows = mutateReal("users/[id]", (src) =>
    src
      .replace(/←/g, "")
      .replace(/Back to/g, "Go")
      .replace(/All \w+/g, "Everything"),
  );
  const row = rows.find((r) => r.route === "/admin/users/:id");
  assert.ok(
    row.failures.includes("DETAIL_NO_RETURN_PATH"),
    `got [${row.failures.join(", ")}]`,
  );
});

// ---------------------------------------------------------------------------
// Every check must be reachable.
// ---------------------------------------------------------------------------

test("no check in the contract is unexercised by this file", () => {
  // A check nobody proves can fire is a check that might not. This asserts the
  // cases above keep pace with the contract rather than silently falling
  // behind it — the failure mode that let LIST_NO_PAGINATION sit dead through
  // an entire audit.
  const out = execFileSync(process.execPath, [SCRIPT, "--json"], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  const ids = JSON.parse(out).checks.map((c) => c.id);
  const self = readFileSync(fileURLToPath(import.meta.url), "utf8");
  const unexercised = ids.filter((id) => !self.includes(id));
  assert.deepEqual(
    unexercised,
    [],
    "these checks have no adversarial case proving they can fire",
  );
});
