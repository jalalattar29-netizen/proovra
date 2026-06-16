/**
 * Intake Links Operations Console — frontend source-contract.
 *
 * Pins the structural commitments of the rebuilt console so a future
 * refactor can't silently regress the operations-grade UX:
 *
 *   1) Operations console component exists and is wired into page.tsx
 *      via <IntakeLinksOperationsConsole>. The page no longer renders
 *      the legacy <ul data-intake-links-list="true"> stacked-card list.
 *
 *   2) KPI strip exposes the 7 enterprise metrics (Active, Submitted,
 *      Upload started, Opened, Expiring soon, Failed delivery,
 *      Revoked or expired) via data-intake-links-kpi attrs.
 *
 *   3) Search / channel filter / lifecycle filter / delivery filter /
 *      sort / pagination controls are all present and carry the
 *      data-intake-links-* attrs the e2e tests target.
 *
 *   4) URL state — the console seeds from initialQuery and pushes
 *      changes back via writeQuery (matching the page-level Next
 *      router.replace plumbing).
 *
 *   5) Onboarding tiles are HIDDEN when items.length > 0 (rendered
 *      only when the workspace has zero links). This is the
 *      "no template-tile clutter once you're operational" rule.
 *
 *   6) The console renders a details drawer (data-intake-links-
 *      details-drawer) with Overview / Delivery / Activity /
 *      Submissions / Safety sections.
 *
 *   7) Row actions menu includes View details, Delivery history,
 *      Revoke (only when active), Archive/Unarchive. No Delete.
 *
 *   8) Raw token / token hash is NEVER referenced anywhere in the
 *      console component (the reveal modal is the only place a raw
 *      token is shown, and only immediately after creation).
 */

import { strict as assert } from "node:assert";
import { readFileSync, existsSync } from "node:fs";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = resolve(dirname(__filename), "..", "..", "..");
const PAGE = resolve(
  REPO_ROOT,
  "apps/web/app/(app)/intake-links/page.tsx",
);
const CONSOLE = resolve(
  REPO_ROOT,
  "apps/web/components/intake-links/IntakeLinksOperationsConsole.tsx",
);

function read(p: string): string {
  return readFileSync(p, "utf8");
}

describe("Pin 1 — console exists and replaces the legacy list", () => {
  it("IntakeLinksOperationsConsole.tsx file exists", () => {
    assert.ok(existsSync(CONSOLE), "operations console file missing");
  });

  it("page.tsx imports and renders the console", () => {
    const src = read(PAGE);
    assert.match(
      src,
      /import\s*\{\s*IntakeLinksOperationsConsole/,
    );
    assert.match(src, /<IntakeLinksOperationsConsole/);
  });

  it("page.tsx no longer renders the legacy <ul data-intake-links-list> when items exist", () => {
    const src = read(PAGE);
    // The legacy attr should be absent — the data-attr migrated to
    // data-intake-links-operations-console (set on the new section).
    assert.ok(
      !/data-intake-links-list="true"/.test(src),
      "legacy <ul data-intake-links-list> must not appear; console replaces it",
    );
    assert.match(
      read(CONSOLE),
      /data-intake-links-operations-console="true"/,
    );
  });
});

describe("Pin 2 — KPI strip exposes the 7 enterprise metrics", () => {
  it("each KPI chip carries data-intake-links-kpi with the expected key", () => {
    const src = read(CONSOLE);
    for (const k of [
      "active",
      "submitted",
      "started",
      "opened",
      "expiring_soon",
      "failed",
      "closed",
    ]) {
      // The render uses the same template attr binding on every chip;
      // the canonical pin is that the literal key appears as a value
      // in the entries[] array.
      assert.ok(
        src.includes(`key: "${k}"`),
        `KPI key "${k}" missing from console entries`,
      );
    }
    assert.match(src, /data-intake-links-kpi=\{e\.key\}/);
  });
});

describe("Pin 3 — operations controls are present and addressable", () => {
  it("search input, sort dropdown, channel/lifecycle/delivery filters and clear button are rendered", () => {
    const src = read(CONSOLE);
    assert.match(src, /data-intake-links-search/);
    assert.match(src, /data-intake-links-filter-channel/);
    assert.match(src, /data-intake-links-filter-lifecycle/);
    assert.match(src, /data-intake-links-filter-delivery/);
    assert.match(src, /data-intake-links-sort/);
    assert.match(src, /data-intake-links-clear/);
  });

  it("pagination controls are present (page-size selector + prev/next buttons)", () => {
    const src = read(CONSOLE);
    assert.match(src, /data-intake-links-page-size/);
    assert.match(src, /data-intake-links-prev-page/);
    assert.match(src, /data-intake-links-next-page/);
  });

  it("table layout — replaces stacked cards with <table> + <tbody> rows", () => {
    const src = read(CONSOLE);
    assert.match(src, /<table[\s\S]{0,200}data-intake-links-table/);
    assert.match(src, /data-intake-links-row/);
  });

  it("default page size is 25 (per design brief)", () => {
    const src = read(CONSOLE);
    assert.match(src, /PAGE_SIZES = \[25, 50, 100\]/);
  });
});

describe("Pin 4 — URL state plumbing", () => {
  it("console accepts initialQuery + writeQuery props", () => {
    const src = read(CONSOLE);
    assert.match(src, /initialQuery\?:\s*URLSearchParams/);
    assert.match(src, /writeQuery\?:\s*\(q: URLSearchParams\) => void/);
  });

  it("page passes useSearchParams + router.replace through", () => {
    const src = read(PAGE);
    assert.match(src, /writeQueryToUrl/);
    assert.match(src, /router\.replace\(/);
    // initialQuery must be seeded from the page-level useSearchParams
    // so reload restores filter state.
    assert.match(src, /initialQuery=\{searchParams \? new URLSearchParams/);
  });
});

describe("Pin 5 — onboarding tiles hidden when links exist", () => {
  it("CommonRequestsSection renders ONLY when items.length === 0", () => {
    const src = read(PAGE);
    // The post-rebuild conditional reads items?.length ?? 0 === 0.
    assert.match(
      src,
      /currentTeam && \(items\?\.length \?\? 0\) === 0 \? \(\s*\n?\s*<CommonRequestsSection/,
    );
  });

  it("HowItWorksStrip is ALSO hidden when items exist (no clutter for returning operators)", () => {
    const src = read(PAGE);
    assert.match(
      src,
      /currentTeam && \(items\?\.length \?\? 0\) === 0 \? \(\s*\n?\s*<HowItWorksStrip/,
    );
  });
});

describe("Pin 6 — details drawer with the 5 required sections", () => {
  it("DetailsDrawer renders Overview / Delivery / Activity / Submissions / Safety", () => {
    const src = read(CONSOLE);
    assert.match(src, /data-intake-links-details-drawer/);
    for (const section of [
      "data-intake-links-details-overview",
      "data-intake-links-details-delivery",
      "data-intake-links-details-activity",
      "data-intake-links-details-submissions",
      "data-intake-links-details-safety",
    ]) {
      assert.match(read(CONSOLE), new RegExp(section));
    }
  });

  it('Delivery section surfaces "Provider tracking unavailable for older attempts" when SID is null', () => {
    const src = read(CONSOLE);
    assert.match(
      src,
      /Provider tracking unavailable for older attempts/,
    );
  });
});

describe("Pin 7 — row actions menu includes correct actions and no Delete", () => {
  it("menu lists View details / Delivery history / Submissions / Revoke / Archive", () => {
    const src = read(CONSOLE);
    assert.match(src, /data-intake-links-row-action="details"/);
    assert.match(src, /data-intake-links-row-action="delivery"/);
    assert.match(src, /data-intake-links-row-action="submissions"/);
    assert.match(src, /data-intake-links-row-action="revoke"/);
    assert.match(src, /data-intake-links-row-action=\{archived \? "unarchive" : "archive"\}/);
  });

  it("there is NO Delete action in the menu (revoke + archive cover the workflow)", () => {
    const src = read(CONSOLE);
    assert.ok(
      !/data-intake-links-row-action="delete"/.test(src),
      "console must not expose a Delete row action",
    );
  });

  it("Revoke is only rendered when the link is currently active (closed/expired/revoked rows do not show it again)", () => {
    const src = read(CONSOLE);
    // The pin: the Revoke <li> sits behind an `isActive ? (...) : null` gate.
    assert.match(
      src,
      /isActive \? \(\s*<li>[\s\S]{0,500}data-intake-links-row-action="revoke"/,
    );
  });
});

describe("Pin 8 — no raw token / token hash in the console", () => {
  it("the console source never references rawToken or tokenHash", () => {
    const src = read(CONSOLE);
    assert.ok(
      !/rawToken/.test(src),
      "rawToken must never appear in the operations console — it lives only in the post-create reveal modal",
    );
    assert.ok(
      !/tokenHash/.test(src),
      "tokenHash is a server secret — must not leak into the console",
    );
  });
});

describe("Pin 9 — Actions dropdown is portaled out of the table (clipping fix)", () => {
  it("RowMenu uses createPortal + a fixed-position panel so it escapes overflow:auto", () => {
    const src = read(CONSOLE);
    assert.match(src, /import\s*\{\s*createPortal\s*\}\s*from\s*"react-dom"/);
    // Pin: the menu render uses createPortal with document.body. A
    // future refactor that drops the portal would re-trigger the
    // clipping bug.
    assert.match(src, /createPortal\(menu, document\.body\)/);
    // The panel must be position:fixed (not absolute) so it sits in
    // the viewport coordinate system, immune to table-cell scroll
    // ancestors.
    assert.match(src, /position:\s*"fixed"/);
    // data-attr so a future e2e test can grab the panel from anywhere
    // on the page even though it lives in a portal.
    assert.match(src, /data-intake-links-row-menu-panel/);
  });

  it("the trigger refs an element and positions the panel from its bounding rect", () => {
    const src = read(CONSOLE);
    assert.match(src, /triggerRef = useRef<HTMLButtonElement \| null>\(null\)/);
    assert.match(src, /getBoundingClientRect\(\)/);
  });
});

describe("Pin 10 — Archived tab actually loads archived rows", () => {
  it("page fetches /v1/workflow/intake-links with archiveScope=all so every tab has data", () => {
    const src = read(PAGE);
    assert.match(
      src,
      /\/v1\/workflow\/intake-links\?teamId=\$\{encodeURIComponent\(teamId\)\}&archiveScope=all/,
    );
  });
});

describe("Pin 11 — KPI cards Upload started / Opened set the lifecycle filter", () => {
  it("KpiStrip accepts onLifecycle + currentLifecycle props", () => {
    const src = read(CONSOLE);
    assert.match(src, /onLifecycle:\s*\(l:\s*LifecycleFilter\)\s*=>\s*void/);
    assert.match(src, /currentLifecycle:\s*LifecycleFilter/);
  });

  it('"started" and "opened" entries set kind:"lifecycle" with STARTED / OPENED filter values', () => {
    const src = read(CONSOLE);
    assert.match(
      src,
      /key:\s*"started"[\s\S]{0,200}kind:\s*"lifecycle"[\s\S]{0,100}lifecycle:\s*"STARTED"/,
    );
    assert.match(
      src,
      /key:\s*"opened"[\s\S]{0,200}kind:\s*"lifecycle"[\s\S]{0,100}lifecycle:\s*"OPENED"/,
    );
  });

  it("clicking a lifecycle-kind KPI resets the tab to 'all' so older OPENED/STARTED rows aren't hidden", () => {
    const src = read(CONSOLE);
    // The wired handler in the IntakeLinksOperationsConsole body
    // sets tab="all" then setLifecycle(l). Pin both.
    assert.match(
      src,
      /onLifecycle=\{\(l\) => \{\s*\n?\s*[\s\S]{0,400}setTab\("all"\);\s*\n?\s*setLifecycle\(l\);\s*\n?\s*\}\}/,
    );
  });
});

describe("Pin 12 — Delivery cell never shows 'Delivered' for QUEUED rows", () => {
  it("QUEUED / RETRY_SCHEDULED render as 'Queued with provider' (not 'Delivered', not 'Sent')", () => {
    const src = read(CONSOLE);
    assert.match(
      src,
      /s === "QUEUED" \|\| s === "RETRY_SCHEDULED"[\s\S]{0,50}\? "Queued with provider"/,
    );
  });

  it("SENT renders 'Sent to provider', DELIVERED renders 'Delivered' — no other status can map to those labels", () => {
    const src = read(CONSOLE);
    assert.match(src, /s === "SENT"[\s\S]{0,50}\? "Sent to provider"/);
    assert.match(src, /s === "DELIVERED"[\s\S]{0,50}\? "Delivered"/);
  });

  it("the row delivery cell surfaces latestErrorCode so operators can act without opening the drawer", () => {
    const src = read(CONSOLE);
    assert.match(src, /delivery\.latestErrorCode/);
    assert.match(src, /code \$\{delivery\.latestErrorCode\}/);
  });
});
