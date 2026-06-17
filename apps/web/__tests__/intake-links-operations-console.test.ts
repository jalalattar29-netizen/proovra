/**
 * Intake Links Operations Console — strict-model source-contract.
 *
 * After multiple rounds of patch-driven changes left the filter model
 * with overlapping primitives (KPI cards setting lifecycle filters,
 * Needs-attention duplicating Failed, Expiring-soon duplicating
 * Active, etc.), the console was rewritten to a single strict
 * model. These pins lock the strict model in place so a future
 * refactor can't quietly re-introduce the duplication:
 *
 *   1. Default tab is "all" (not "active"). Every other tab is an
 *      explicit narrowing chosen by the operator.
 *   2. Exactly 6 mutually-exclusive primary tabs:
 *      All / Active / Submitted / Failed / Archived / Closed.
 *      "needs_attention" and "expiring_soon" are gone.
 *   3. Exactly 7 KPI cards, each mapped to ONE tab:
 *      Total / Active / Submitted / Opened / Failed / Archived / Closed.
 *      KPI click also clears every secondary filter so the resulting
 *      view matches exactly what the KPI promised.
 *   4. Archived is first-class:
 *      - included in KPI strip with its own count
 *      - listed in the Lifecycle dropdown
 *      - rendered as the PRIMARY row badge when archived
 *      - has its own tab
 *   5. Secondary dropdowns are independent dimensions only:
 *      channel / lifecycle / delivery / sort.
 *   6. Sort dropdown has exactly 3 options:
 *      Latest activity / Newest created / Expiring soon.
 *   7. Clear filters resets to the canonical default
 *      (tab=all, every dropdown empty, sort=activity, search="").
 *   8. Empty state shows "No intake links match these filters" and
 *      a Clear-filters button (not an inline link).
 *   9. Actions menu still portals out so it can't be clipped.
 *  10. Page fetches with archiveScope=all so the Archived tab works.
 *  11. URL is canonical: a clean "/intake-links" URL matches the
 *      default (no params written when state matches the default).
 *  12. No raw token / token hash references anywhere in the console.
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

describe("Pin 1 — strict default: tab=all", () => {
  it("CONSOLE file exists and the page renders it", () => {
    assert.ok(existsSync(CONSOLE), "operations console file missing");
    const page = read(PAGE);
    assert.match(page, /<IntakeLinksOperationsConsole/);
  });

  it('initial tab state defaults to "all" (not "active")', () => {
    const src = read(CONSOLE);
    assert.match(
      src,
      /clamp<Tab>\(initial\.get\("tab"\) as Tab, TABS\) \?\? "all"/,
    );
  });

  it("URL writer skips tab when it equals the default", () => {
    const src = read(CONSOLE);
    assert.match(src, /if \(tab !== "all"\) next\.set\("tab", tab\)/);
  });
});

describe("Pin 2 — exactly 7 mutually-exclusive tabs (one per KPI card)", () => {
  it("TABS array enumerates all / active / submitted / opened / failed / archived / closed (and nothing else)", () => {
    const src = read(CONSOLE);
    const m = src.match(/const TABS = \[([\s\S]*?)\] as const;/);
    assert.ok(m, "TABS array not found");
    // Duplicate-tab-row removal turned every KPI card into the
    // sole filter trigger — `opened` joined the tab union so the
    // Opened KPI can drive a real filter (it was previously
    // informational-only). All 7 tabs map 1:1 with KPI cards.
    const expected = [
      '"all"',
      '"active"',
      '"submitted"',
      '"opened"',
      '"failed"',
      '"archived"',
      '"closed"',
    ];
    for (const tab of expected) {
      assert.ok(
        m[1].includes(tab),
        `TABS missing ${tab}`,
      );
    }
    // The retired tabs must be gone.
    for (const removed of ['"needs_attention"', '"expiring_soon"']) {
      assert.ok(
        !m[1].includes(removed),
        `${removed} must not appear in TABS (retired)`,
      );
    }
  });

  it("matchesTab predicate handles every tab and rejects unknowns", () => {
    const src = read(CONSOLE);
    // Each named case in the switch is the canonical truthful predicate.
    for (const tag of [
      'case "active":',
      'case "submitted":',
      'case "opened":',
      'case "failed":',
      'case "closed":',
    ]) {
      assert.ok(
        src.includes(tag),
        `matchesTab switch missing ${tag}`,
      );
    }
    // No leftover predicates for the retired tabs.
    assert.ok(
      !src.includes('case "needs_attention":'),
      "needs_attention predicate must be removed",
    );
    assert.ok(
      !src.includes('case "expiring_soon":'),
      "expiring_soon predicate must be removed",
    );
  });

  it("non-Archived tabs exclude archived rows; Archived tab includes them", () => {
    const src = read(CONSOLE);
    assert.match(src, /if \(tab === "archived"\) return isArchived\(item\)/);
    // The "archived rows are excluded from every other tab" rule.
    assert.match(
      src,
      /if \(isArchived\(item\)\) return false/,
    );
  });
});

describe("Pin 3 — KPI strip = 7 cards, each maps to one tab, click clears conflicting filters", () => {
  it("KpiStrip declares exactly 7 entries with the prescribed keys", () => {
    const src = read(CONSOLE);
    for (const key of [
      '"total"',
      '"active"',
      '"submitted"',
      '"opened"',
      '"failed"',
      '"archived"',
      '"closed"',
    ]) {
      assert.ok(
        src.includes(`key: ${key}`),
        `KPI entries missing ${key}`,
      );
    }
    // Retired KPIs must be gone.
    for (const removed of ['"started"', '"expiring_soon"']) {
      assert.ok(
        !src.includes(`key: ${removed}`),
        `${removed} KPI must not appear (retired)`,
      );
    }
  });

  it("every KPI entry maps to exactly one tab — no informational-only or lifecycle-mutating entries", () => {
    const src = read(CONSOLE);
    // After the duplicate-tab-row removal, every KPI card became
    // a real filter trigger. There is no kind:"info" anymore (the
    // Opened KPI now drives tab="opened"), and no kind:"lifecycle"
    // (those were retired earlier — KPIs never silently mutate
    // secondary filters).
    assert.ok(
      !/kind:\s*"lifecycle"/.test(src),
      "KPI strip must not have lifecycle-kind entries",
    );
    assert.ok(
      !/kind:\s*"info"/.test(src),
      "KPI strip must not have info-kind entries — every card is a real filter now",
    );
    // The Opened entry now maps to tab="opened" (was kind:"info").
    assert.match(
      src,
      /key:\s*"opened",[\s\S]{0,200}tab:\s*"opened"/,
    );
  });

  it("handleKpiClick sets tab AND clears lifecycle/delivery/channel", () => {
    const src = read(CONSOLE);
    const idx = src.indexOf("const handleKpiClick");
    assert.ok(idx > 0, "handleKpiClick missing");
    const body = src.slice(idx, idx + 600);
    assert.match(body, /setTab\(targetTab\)/);
    assert.match(body, /setLifecycle\(""\)/);
    assert.match(body, /setDelivery\(""\)/);
    assert.match(body, /setChannel\(""\)/);
  });

  it("KpiStrip is wired with onKpi (not onTab + onLifecycle pair)", () => {
    const src = read(CONSOLE);
    assert.match(src, /<KpiStrip kpis=\{kpis\} onKpi=\{handleKpiClick\}/);
  });
});

describe("Pin 4 — Archived is first-class", () => {
  it("computeKpis returns an `archived` count", () => {
    const src = read(CONSOLE);
    assert.match(src, /archived,/);
    assert.match(src, /if \(isArchived\(it\)\) \{\s*\n?\s*archived \+= 1/);
  });

  it("Lifecycle dropdown lists ARCHIVED as a selectable value", () => {
    const src = read(CONSOLE);
    const m = src.match(/const LIFECYCLES = \[([\s\S]*?)\] as const;/);
    assert.ok(m);
    assert.ok(m[1].includes('"ARCHIVED"'), "LIFECYCLES missing ARCHIVED");
    assert.match(src, /ARCHIVED: "Archived"/);
  });

  it("lifecycle=ARCHIVED filter matches link.archivedAtUtc (not computedLifecycle)", () => {
    const src = read(CONSOLE);
    // matchesLifecycleFilter delegates ARCHIVED to isArchived().
    assert.match(
      src,
      /if \(lifecycle === "ARCHIVED"\) return isArchived\(item\)/,
    );
  });

  it("row badge shows ARCHIVED as the PRIMARY chip when archived", () => {
    const src = read(CONSOLE);
    assert.match(
      src,
      /const primaryBadgeKind: ConsoleLifecycle \| "ARCHIVED" = archived\s*\n?\s*\? "ARCHIVED"\s*\n?\s*: computedLifecycle/,
    );
    assert.match(
      src,
      /primaryBadgeKind === "ARCHIVED"\s*\n?\s*\? "Archived"/,
    );
    // The chip palette has an ARCHIVED entry.
    assert.match(src, /ARCHIVED: \{ bg:[^}]+\}/);
  });

  it("page fetches with archiveScope=all so the Archived tab has data", () => {
    const src = read(PAGE);
    assert.match(
      src,
      /\/v1\/workflow\/intake-links\?teamId=\$\{encodeURIComponent\(teamId\)\}&archiveScope=all/,
    );
  });
});

describe("Pin 5 — secondary dropdowns are independent dimensions", () => {
  it("channel / lifecycle / delivery dropdowns rendered with addressable data-attrs", () => {
    const src = read(CONSOLE);
    assert.match(src, /data-intake-links-filter-channel/);
    assert.match(src, /data-intake-links-filter-lifecycle/);
    assert.match(src, /data-intake-links-filter-delivery/);
  });

  it("filter pipeline AND-combines tab + channel + lifecycle + delivery + search", () => {
    const src = read(CONSOLE);
    assert.match(src, /!matchesTab\(it, tab\)/);
    assert.match(
      src,
      /channel && \(it\.delivery\.latestChannel \?\? "MANUAL"\) !== channel/,
    );
    assert.match(src, /!matchesLifecycleFilter\(it, lifecycle\)/);
  });
});

describe("Pin 6 — Sort dropdown = exactly 3 options", () => {
  it("SORTS list is activity / created / expires", () => {
    const src = read(CONSOLE);
    const m = src.match(/const SORTS = \[([\s\S]*?)\] as const;/);
    assert.ok(m);
    assert.ok(m[1].includes('"activity"'));
    assert.ok(m[1].includes('"created"'));
    assert.ok(m[1].includes('"expires"'));
    // The dropped sorts must be gone.
    assert.ok(!m[1].includes('"priority"'), "priority sort retired");
    assert.ok(!m[1].includes('"recipient"'), "recipient sort retired");
  });

  it("SORT_LABELS map matches the brief", () => {
    const src = read(CONSOLE);
    assert.match(src, /activity: "Latest activity"/);
    assert.match(src, /created: "Newest created"/);
    assert.match(src, /expires: "Expiring soon"/);
  });
});

describe("Pin 7 — Clear filters resets to canonical default", () => {
  it("clearFilters sets tab=all, all dropdowns empty, sort=activity, search empty", () => {
    const src = read(CONSOLE);
    const idx = src.indexOf("const clearFilters");
    assert.ok(idx > 0);
    const body = src.slice(idx, idx + 400);
    assert.match(body, /setQ\(""\)/);
    assert.match(body, /setTab\("all"\)/);
    assert.match(body, /setChannel\(""\)/);
    assert.match(body, /setLifecycle\(""\)/);
    assert.match(body, /setDelivery\(""\)/);
    assert.match(body, /setSort\("activity"\)/);
  });

  it("anyFilterActive baseline matches the new default (tab !== 'all')", () => {
    const src = read(CONSOLE);
    assert.match(src, /tab !== "all" \|\|/);
  });
});

describe("Pin 8 — empty state copy + Clear filters button", () => {
  it('renders "No intake links match these filters." + Clear-filters button', () => {
    const src = read(CONSOLE);
    assert.match(src, /No intake links match these filters\./);
    assert.match(src, /data-intake-links-empty-state/);
    assert.match(src, /data-intake-links-empty-clear/);
    // Disabled when no filters are active (no point clicking).
    assert.match(src, /disabled=\{!anyFilterActive\}/);
  });
});

describe("Pin 9 — Actions menu still portaled (clipping fix preserved)", () => {
  it("RowMenu still uses createPortal + position:fixed", () => {
    const src = read(CONSOLE);
    assert.match(src, /import\s*\{\s*createPortal\s*\}\s*from\s*"react-dom"/);
    assert.match(src, /createPortal\(menu, document\.body\)/);
    assert.match(src, /position:\s*"fixed"/);
  });
});

describe("Pin 10 — URL is canonical (defaults written as no params)", () => {
  it("URL writer skips every default value", () => {
    const src = read(CONSOLE);
    // tab=all, sort=activity, page=1, pageSize=25 are all default.
    assert.match(src, /if \(tab !== "all"\) next\.set/);
    assert.match(src, /if \(sort !== "activity"\) next\.set/);
    assert.match(src, /if \(page !== 1\) next\.set/);
    assert.match(src, /if \(pageSize !== 25\) next\.set/);
  });
});

describe("Pin 11 — no raw token / token hash references", () => {
  it("the console source never references rawToken or tokenHash", () => {
    const src = read(CONSOLE);
    assert.ok(!/rawToken/.test(src));
    assert.ok(!/tokenHash/.test(src));
  });
});

describe("Pin 12 — DeliveryCell honesty + 63016 mapping preserved", () => {
  it("QUEUED renders 'Queued with provider' (not Delivered / not Sent)", () => {
    const src = read(CONSOLE);
    assert.match(
      src,
      /s === "QUEUED" \|\| s === "RETRY_SCHEDULED"[\s\S]{0,50}\? "Queued with provider"/,
    );
  });

  it("Twilio errorCode 63016 maps to a plain-English label", () => {
    const src = read(CONSOLE);
    assert.match(src, /case "63016":/);
    assert.match(src, /WhatsApp template required or not approved\./);
  });
});

describe("Pin 13 — Opened KPI is a real filter (tab=opened), not informational and not tab=all", () => {
  it('the Opened entry maps to tab:"opened" — the real filter the brief required', () => {
    const src = read(CONSOLE);
    assert.match(
      src,
      /key:\s*"opened",[\s\S]{0,200}tab:\s*"opened"/,
    );
    // It MUST NOT silently fall through to tab=all (the original
    // bug) and MUST NOT be informational anymore (the duplicate-
    // tab-row removal made every KPI a real filter).
    assert.ok(
      !/key:\s*"opened"[\s\S]{0,200}tab:\s*"all"/.test(src),
      "Opened KPI must NOT map to tab=all (would mislead the operator)",
    );
    assert.ok(
      !/key:\s*"opened"[\s\S]{0,200}kind:\s*"info"/.test(src),
      "Opened KPI must NOT be informational — it's a real filter now",
    );
  });

  it("matchesTab handles tab='opened' via the same predicate as the KPI count (activity.sessionsOpened > 0)", () => {
    const src = read(CONSOLE);
    assert.match(
      src,
      /case "opened":[\s\S]{0,400}item\.activity\.sessionsOpened > 0/,
    );
  });

  it("every KPI card is clickable now (no disabled / aria-disabled left in the render branch)", () => {
    const src = read(CONSOLE);
    // The render is a single onClick → onKpi(e.tab); no isClickable
    // gate, no disabled attribute, no aria-disabled.
    assert.match(src, /onClick=\{\(\) => onKpi\(e\.tab\)\}/);
    assert.ok(
      !/disabled=\{!isClickable\}/.test(src),
      "no leftover disabled={!isClickable} (every KPI is a real filter)",
    );
  });
});

describe("Pin 15 — duplicate tab-pill row removed (KPI cards are the only primary filter)", () => {
  it("the KpiStrip body has no <button data-intake-links-tab> pills next to the cards", () => {
    const src = read(CONSOLE);
    // The duplicate row used to render a TABS.map(...) block of
    // tab pills inside KpiStrip, each tagged with data-intake-
    // links-tab. That entire block was deleted.
    assert.ok(
      !/data-intake-links-tab=/.test(src),
      "duplicate tab-pill row must be removed — only data-intake-links-kpi-tab on the cards remains",
    );
  });

  it("TAB_LABELS constant is retired (the labels live inline on the KPI entries now)", () => {
    const src = read(CONSOLE);
    assert.ok(
      !/const TAB_LABELS:/.test(src),
      "TAB_LABELS constant must be removed — KPI entries carry their own labels",
    );
  });

  it("tabPillStyle is retired with the row it styled", () => {
    const src = read(CONSOLE);
    assert.ok(
      !/^const tabPillStyle:/m.test(src),
      "tabPillStyle constant must be removed (dead CSS)",
    );
  });

  it("KpiStrip props no longer accept the now-deleted tab pill renderer", () => {
    const src = read(CONSOLE);
    // The strip exposes only kpis / onKpi / currentTab — no
    // separate onTab handler split from the KPI click handler.
    assert.match(
      src,
      /function KpiStrip\(\{\s*\n?\s*kpis,\s*\n?\s*onKpi,\s*\n?\s*currentTab,\s*\n?\s*\}/,
    );
  });
});

describe("Pin 14 — lifecycle=ARCHIVED auto-harmonises with tab=archived", () => {
  it("handleLifecycleChange auto-switches to tab=archived when ARCHIVED is selected", () => {
    const src = read(CONSOLE);
    const idx = src.indexOf("const handleLifecycleChange");
    assert.ok(idx > 0, "handleLifecycleChange missing");
    const body = src.slice(idx, idx + 800);
    assert.match(
      body,
      /if \(next === "ARCHIVED" && tab !== "archived"\) \{\s*\n?\s*setTab\("archived"\);/,
    );
  });

  it("picking a non-archive lifecycle while sitting on Archived moves the tab back to All", () => {
    const src = read(CONSOLE);
    const idx = src.indexOf("const handleLifecycleChange");
    const body = src.slice(idx, idx + 800);
    assert.match(
      body,
      /if \(next !== "ARCHIVED" && next !== "" && tab === "archived"\) \{\s*\n?\s*[\s\S]{0,400}setTab\("all"\)/,
    );
  });

  it("the lifecycle dropdown's onChange wires through handleLifecycleChange (not setLifecycle directly)", () => {
    const src = read(CONSOLE);
    assert.match(
      src,
      /onChange=\{\(e\) =>\s*\n?\s*handleLifecycleChange\(e\.target\.value as LifecycleFilter\)\s*\n?\s*\}/,
    );
  });

  it("the filter pipeline no longer has a lifecycle-ARCHIVED cross-tab override (handler keeps state in sync)", () => {
    const src = read(CONSOLE);
    // The previous override (if (lifecycle === "ARCHIVED") { if
    // (!isArchived(it)) return false; }) is gone — the dropdown
    // handler keeps tab+lifecycle consistent so the pipeline can
    // be a strict AND of independent dimensions.
    assert.ok(
      !/if \(lifecycle === "ARCHIVED"\) \{\s*\n?\s*if \(!isArchived\(it\)\) return false/.test(src),
      "lifecycle=ARCHIVED special-case in filter pipeline must be removed (now handled at dropdown handler)",
    );
  });
});
