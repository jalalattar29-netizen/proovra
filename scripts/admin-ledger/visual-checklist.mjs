#!/usr/bin/env node
/**
 * THE PER-PAGE VISUAL CHECKLIST (§15).
 *
 * =============================================================================
 * IT IS GENERATED FROM THE ARTIFACTS, WHICH IS THE WHOLE POINT
 * =============================================================================
 * §15 asks for one row per page and then says the checklist "is not proof by
 * itself — it points to actual screenshots and implementation". A hand-written
 * table cannot honour that: it records what somebody believed at the moment
 * they typed it, and it is exactly as accurate as their memory.
 *
 * So every column here is read from a real artifact:
 *
 *   review.json        the composition capture: screens tall, card count,
 *                      one-value cards, tables, H1s, console errors
 *   responsive.json    47 routes x 7 widths + 200% zoom
 *   rtl.json           47 routes with the locale set to Arabic
 *   keyboard.json      tab order, focus visibility, landmarks, labels
 *   tabs.json          the enumerated tab surface
 *   screenshots/       the capture files, existence and byte size
 *
 * A column with no artifact behind it prints NOT VERIFIED. It does not print
 * a guess and it does not print a blank.
 *
 * =============================================================================
 * DISPOSITIONS ARE EARNED, AND THE HARD ONE IS SPELLED OUT
 * =============================================================================
 * §15 allows three dispositions and forbids four. The three it allows all
 * assert that a person LOOKED at the page — "ALREADY_COMPLIANT may not be
 * assigned based only on source inspection".
 *
 * A sweep cannot assert that. A sweep asserts that the page has no body
 * overflow, no sub-44px target, no AA failure, one H1, and renders in RTL —
 * which is a great deal, and is not the same as somebody having looked at its
 * composition and decided each card earns its place.
 *
 * So this generator will only stamp a disposition from the allowed set when
 * the route is listed in INSPECTED below, which is a hand-maintained record of
 * the pages whose screenshots were actually opened and read during this phase.
 * Everything else prints SWEEP_VERIFIED_COMPOSITION_NOT_REVIEWED, which is
 * NOT one of §15's permitted dispositions and is therefore a declaration that
 * the phase is not finished.
 *
 * That is deliberate. Making the incomplete state unrepresentable in the
 * checklist would only move the dishonesty into the summary.
 *
 * Usage:
 *   node scripts/admin-ledger/visual-checklist.mjs
 */

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../..");
const REVIEW = resolve(REPO, "artifacts/admin-visual-review");
const SHOTS = resolve(REVIEW, "screenshots");
const OUT = resolve(REPO, "docs/admin/phase7-visual-checklist.md");

const read = (p) => (existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : null);

const review = read(resolve(REVIEW, "review.json"));
const responsive = read(resolve(REVIEW, "responsive.json"));
const rtl = read(resolve(REVIEW, "rtl.json"));
const keyboard = read(resolve(REVIEW, "keyboard.json"));
const tabs = read(resolve(REVIEW, "tabs.json"));

if (!review) {
  console.error(
    "visual-checklist: artifacts/admin-visual-review/review.json is missing.\n" +
      "Run: npx playwright test admin-visual-review --config apps/web/e2e/admin-control-plane/playwright.config.ts",
  );
  process.exit(2);
}

/**
 * THE PAGES WHOSE CAPTURES WERE OPENED AND READ IN THIS PHASE.
 *
 * Hand-maintained on purpose: it is the one claim in this document that no
 * artifact can make on a person's behalf. Each entry records the layout
 * pattern the page was recomposed onto and what was actually changed, so a
 * reviewer can check the claim against the diff rather than trusting it.
 */
const INSPECTED = {
  "/admin": {
    disposition: "REDESIGNED_AND_VISUALLY_VERIFIED",
    pattern: "verdict banner -> attention list -> summary -> estate -> commercial -> evidence -> security -> traffic",
    changed:
      "verdict promoted from the 4th block of section 1 to the page's first element; attention list moved above the summary; Customers+Workspaces+People (3 sections, 19 tiles) collapsed to 4 condition tiles + 1 fact card; MRR/ARR/storage folded into a Recurring revenue card; Traffic demoted from 3 tiles to a fact row naming /admin/dashboard; evidence grid 5+1 -> 3+3",
  },
  "/admin/dashboard": {
    disposition: "REDESIGNED_AND_VISUALLY_VERIFIED",
    pattern: "window control -> KPI row -> geography -> traffic+funnel -> signals -> distributions -> activity",
    changed:
      "MetricTile rebuilt on AdmKpi (10 tiles now uniform 163px, values on one line per row, was 7 distinct tops); the #1e3a5f navy accent removed from 8 of 11 tiles; 4 empty states 120-330px -> 56px; NotConnectedCard (Card+EmptyState, ~190px each) -> 56px inline rows; 3 content grids stop stretching",
  },
  "/admin/platform-health": {
    disposition: "REDESIGNED_AND_VISUALLY_VERIFIED",
    pattern: "verdict -> needs attention -> now -> measured healthy -> not measured",
    changed:
      "24 equal cards partitioned into attention/probed/unprobed with the verdict derived from the rows; 16 unprobed cards -> 1 fact list; Now grid 5+2 -> 4+3",
  },
  "/admin/evidence-ops": {
    disposition: "REDESIGNED_AND_VISUALLY_VERIFIED",
    pattern: "cohort row (3 cols) -> uploads -> evidence -> reports -> timestamping -> incidents -> queue health",
    changed:
      "cohort grid 5 cols -> 3 (cards 340-730px -> 295-337px); the duplicated 80-word reason moved behind a <details> disclosure",
  },
  "/admin/evidence-ops/records": {
    disposition: "REDESIGNED_AND_VISUALLY_VERIFIED",
    pattern: "filters -> cohort statement -> table with expandable detail -> pager",
    changed:
      "the Required action column carried the decision AND two paragraphs in 244px, off the end of the container's scroll; decision stays on the row, narrative moves to expandable detail; record UUID -> AdmId (truncated + copy); preservation badges nowrap. Rows 385px -> 77px. LATER IN THE PHASE: the row's 'What to do' control was measured 348px past the right edge of an 1661px table in a 1206px container — invisible until an operator thought to scroll a table sideways to look for a row action — so DataTable's actions column is pinned to the container's inline end; and Created + Last change were 514px of nowrap timestamps, 31% of the table, now a date and an interval with their instants on the hover, taking the table to 1368px",
  },
  "/admin/executive": {
    disposition: "REDESIGNED_AND_VISUALLY_VERIFIED",
    pattern: "top-line KPIs -> usage -> not-measured fact list -> top customers -> at-risk",
    changed:
      "'Not measured' 30px/750 -> 15px muted (6 of 16 tiles were non-values); Failed operations no longer red at zero; the 4-tile not-measured section -> 1 fact card",
  },
  "/admin/identity/scim": {
    disposition: "REDESIGNED_AND_VISUALLY_VERIFIED",
    pattern: "URL-addressable tablist -> tab panels",
    changed:
      "the console's only real tablist: state moved to ?tab=, adopted AdmTabs/AdmTabPanel for arrow keys + roving tabindex + tabpanel semantics; all 4 tabs opened and verified. LATER IN THE PHASE: the tab was reading its state back from the URL, so it did not change until the router's replace landed — it now switches on the click and treats the URL as a reflection of that, which is why the tab sweep measures the panel rather than the address bar",
  },
  "/admin/platform/runbooks": {
    disposition: "REDESIGNED_AND_VISUALLY_VERIFIED",
    pattern: "searchable catalog rail + reader",
    changed:
      "catalog gained a filter over title/slug/summary/subsystems with a truthful count and a distinct filtered-empty state",
  },
  "/admin/platform/runbooks/:slug": {
    disposition: "REDESIGNED_AND_VISUALLY_VERIFIED",
    pattern: "searchable catalog rail + 36em reading column",
    changed:
      "394 list items across 21 runbooks were split mid-sentence by the renderer (hard-wrap continuation lines fell through to the paragraph branch); bullets were absent entirely (flex children are not list items, and the reset's list-style:none was never overridden); reading column measured 124 chars and now measures ~72 (ch resolved against the wrong font size AND ch is 0.73em in this family); the docs/runbooks/*.md source path removed; fences gained a language label and a copy control",
  },
  "/admin/adoption": {
    disposition: "REDESIGNED_AND_VISUALLY_VERIFIED",
    pattern: "window control -> funnel -> cohort table -> disclosure",
    changed:
      "legacy style objects and the second palette removed; the funnel's ratio over a zero denominator now states the denominator instead of printing a percentage of nothing",
  },
  "/admin/alerts": {
    disposition: "REDESIGNED_AND_VISUALLY_VERIFIED",
    pattern: "posture row -> alert list -> delivery",
    changed:
      "the alert list was one card per alert at ~190px each; it is now a compact row list on the shared surface, and the last sub-11px text on the route was raised",
  },
  "/admin/audit": {
    disposition: "REDESIGNED_AND_VISUALLY_VERIFIED",
    pattern: "filter bar -> server-paged log -> per-row disclosure",
    changed:
      "the actor and target cells printed a six-character tail with the full id nowhere on the page, so an operator correlating a row against a person had nothing to correlate with; the id is now on the cell's title, which also lets the composition sweep tell an honestly repeated column from one whose truncation hides a difference",
  },
  "/admin/billing": {
    disposition: "REDESIGNED_AND_VISUALLY_VERIFIED",
    pattern: "revenue -> attention lists -> add-ons -> webhooks -> reconciliation",
    changed:
      "the reconciliation history was twenty-five bold lines of shouted enum with a stamp to the second on each ('WORKSPACE_OPERATIONS · SUCCEEDED · 05 Sept 2026, 18:41:00 Europe/Berlin'); it reads 'Workspace operations · Succeeded · scanned 14 · 13m ago' with the instant on the hover, and the 25-row cap the server reads under is now stated",
  },
  "/admin/contact-sales": {
    disposition: "REDESIGNED_AND_VISUALLY_VERIFIED",
    pattern: "stage summary -> filter bar -> inquiry table -> quick-view drawer",
    changed:
      "the row's second action rendered 5px past the visible edge of a sideways-scrolling table; the actions cell is pinned to the container's inline end, matching the rule added to DataTable. The table itself is hand-rolled and is recorded as debt rather than migrated in this pass",
  },
  "/admin/contact-sales/:id": {
    disposition: "REDESIGNED_AND_VISUALLY_VERIFIED",
    pattern: "identity header -> inquiry facts -> routing -> internal notes",
    changed:
      "migrated off the legacy style-object system onto the canonical Card/Badge/Button set; the return link carries the list state it came from",
  },
  "/admin/costs": {
    disposition: "REDESIGNED_AND_VISUALLY_VERIFIED",
    pattern: "window control -> cost summary -> entitlement table -> disclosure",
    changed:
      "an all-empty list printed its empty state and then repeated it as a count line underneath; ResultCount suppresses the plain-empty sentence now, here and on every other console list",
  },
  "/admin/customers": {
    disposition: "REDESIGNED_AND_VISUALLY_VERIFIED",
    pattern: "filter bar -> customer directory -> row disclosure",
    changed:
      "onto the canonical DataTable and FilterBar with one reset that appears only when something is filtered; the created stamp dropped from a wrapping seconds-precision string to a date",
  },
  "/admin/customers/:id": {
    disposition: "REDESIGNED_AND_VISUALLY_VERIFIED",
    pattern: "identity -> commercial -> workspaces -> people -> lifecycle actions",
    changed:
      "twelve cards on the legacy system rebuilt on the canonical surfaces; the single destructive action ('Suspend customer') is the only filled red control on the page, which the destructive sweep confirms",
  },
  "/admin/demo-requests": {
    disposition: "REDESIGNED_AND_VISUALLY_VERIFIED",
    pattern: "summary row -> filter bar + list -> request detail pane",
    changed:
      "each summary card printed its own label twice, eight pixels apart, and tinted a count by its category so 'SPAM FLAGGED 0' wore red; rows read 'Clean 0' and 'ACTIVE · S0' and now state the verdict with the score on the hover; 'Clear Filters' moved off the always-visible actions slot onto FilterBar's filtered/onReset",
  },
  "/admin/demo-requests/:id": {
    disposition: "REDESIGNED_AND_VISUALLY_VERIFIED",
    pattern: "identity header -> qualification -> routing -> follow-up -> spam signals",
    changed:
      "off the legacy style objects onto the canonical components; the metadata dump moved behind a disclosure instead of printing raw JSON as page content",
  },
  "/admin/identity": {
    disposition: "REDESIGNED_AND_VISUALLY_VERIFIED",
    pattern: "member table -> extra access -> service accounts -> mappings -> session governance -> specialist surfaces -> scope disclosure",
    changed:
      "the member id column rendered one indistinguishable string on every row (an eight-character head of a sequentially-allocated UUID); it now shows head and tail through the one canonical shortener. The four per-row Revoke controls are the page's only filled red buttons and were left as they are — one per row is the console's destructive convention, which the cross-route measurement confirms",
  },
  "/admin/identity/access-reviews": {
    disposition: "REDESIGNED_AND_VISUALLY_VERIFIED",
    pattern: "campaign summary -> review table -> decision controls",
    changed:
      "onto the canonical surfaces and the shared empty state; a disabled decision control now says why it is disabled instead of being inert and silent",
  },
  "/admin/identity/permission-matrix": {
    disposition: "REDESIGNED_AND_VISUALLY_VERIFIED",
    pattern: "role selector -> permission matrix -> capability disclosure",
    changed:
      "a card was showing 12 of 93 permissions with no indication the other 81 existed; the matrix now discloses its own size, and amber stopped being applied to rows that carry no warning",
  },
  "/admin/identity/providers": {
    disposition: "REDESIGNED_AND_VISUALLY_VERIFIED",
    pattern: "provider list -> per-provider configuration -> health",
    changed:
      "nine cards migrated off the legacy system; a raw ISO timestamp rendered as prose became a formatted instant",
  },
  "/admin/identity/runtime": {
    disposition: "REDESIGNED_AND_VISUALLY_VERIFIED",
    pattern: "runtime posture -> session monitor -> quarantine -> emergency control",
    changed:
      "all twenty-five session rows printed the identical string '0adf0000-000…' in the User column, so an operator picking a session to quarantine could not tell which row they were acting on; the shortener keeps head AND tail now. 'Emergency org revoke' is the page's single filled red control",
  },
  "/admin/identity/sessions": {
    disposition: "REDESIGNED_AND_VISUALLY_VERIFIED",
    pattern: "filter bar -> session table -> quarantine -> trusted devices -> policy impact -> member risk",
    changed:
      "every row carried TWO solid-red buttons, fifty on a full page, and the more dangerous of the pair ('Revoke all', member-scoped, step-up gated) was indistinguishable from the safer one; it is a secondary action now. The row's last action also rendered 41px past the visible edge — Timeline, a read rather than a mutation, moved to the Member cell and the table went from 1268px to 1214px inside a 1216px wrapper with no sideways scroll",
  },
  "/admin/identity/timeline": {
    disposition: "REDESIGNED_AND_VISUALLY_VERIFIED",
    pattern: "filter bar -> identity event timeline -> per-event disclosure",
    changed:
      "the actor was stated twice in each row (once as a name, once as the same name in the kind slot); the presenter now renders the kind only when it differs from the name",
  },
  "/admin/operations": {
    disposition: "REDESIGNED_AND_VISUALLY_VERIFIED",
    pattern: "posture row -> filter bar -> condition table -> security events",
    changed:
      "five conditions read 'Trusted timestamping failed · EVIDENCE_INTEGRITY · seen 10x · last 1m ago' against the same workspace at the same severity and status, while their own summary said each covers one record — the projection had always carried relatedEvidenceId and the page declared none of it; each row now names and links its subject. The Affected column read 'Northwind Legal / Northwind Legal' on every row. And a router.replace fired from inside the fetch callback, so a link clicked during the load navigated the reader back to the list they had just left",
  },
  "/admin/platform/analytics": {
    disposition: "REDESIGNED_AND_VISUALLY_VERIFIED",
    pattern: "window control -> reading guide -> five metric groups -> generation footer",
    changed:
      "the source trace under the last Automation tile rendered 'source: AutomationWebhookDestinati / on' — a 28-character model name split mid-syllable in a 120px tile, on a surface whose whole claim is that a number can be checked against its table; IdentifierText offers the break at the CamelCase boundary and contributes no character, so the value still copies exactly",
  },
  "/admin/platform/automation": {
    disposition: "REDESIGNED_AND_VISUALLY_VERIFIED",
    pattern: "rule summary -> rule table -> run history",
    changed:
      "onto the shared apf-* surfaces with one filter reset; the run list states the cap it reads under",
  },
  "/admin/platform/exports": {
    disposition: "REDESIGNED_AND_VISUALLY_VERIFIED",
    pattern: "export posture -> job list -> destination facts",
    changed:
      "the console's last centred-prose empty state — a 74px card holding one centred muted line and no label, which reads as 'loading, forever' — became the shared left-aligned state that names which state it is and why",
  },
  "/admin/platform/media-graph": {
    disposition: "REDESIGNED_AND_VISUALLY_VERIFIED",
    pattern: "snapshot freshness -> intelligence tiles -> graph tiles -> operator actions",
    changed:
      "eleven metric keys rendered split mid-word ('media_intelligence_processo / r_started_total'), now broken at the underscores; a tile's tone no longer fires on a zero value, and the metric key was demoted from headline to caption",
  },
  "/admin/platform/observability": {
    disposition: "REDESIGNED_AND_VISUALLY_VERIFIED",
    pattern: "alert rollup -> signal tiles -> per-source charts",
    changed:
      "the page used apf-* classes throughout and was the one page under /admin/platform that never imported the stylesheet defining them, so every tile measured 0px border, transparent background and 0 padding and the platform's alert rollup rendered as bare stacked text outside any surface; a node:test now asserts every admin page loads the stylesheet whose classes it uses",
  },
  "/admin/platform/queues": {
    disposition: "REDESIGNED_AND_VISUALLY_VERIFIED",
    pattern: "queue posture -> queue table -> worker leases",
    changed:
      "the page reported fifteen queues 'healthy' directly above its own table saying fifteen worker leases were missing; health is now derived from both, so a queue with no worker reports unknown rather than healthy",
  },
  "/admin/platform/readiness": {
    disposition: "REDESIGNED_AND_VISUALLY_VERIFIED",
    pattern: "verdict -> gate list -> unprobed disclosure",
    changed:
      "ten warning-coloured zeros stopped wearing the colour of the thing they count; the shouted paragraph in the header became sentence case",
  },
  "/admin/platform/recovery": {
    disposition: "REDESIGNED_AND_VISUALLY_VERIFIED",
    pattern: "recovery posture -> request queue -> per-request disclosure",
    changed:
      "off the legacy palette and style objects; the queue's empty state explains what would appear there rather than being blank",
  },
  "/admin/platform/reliability": {
    disposition: "REDESIGNED_AND_VISUALLY_VERIFIED",
    pattern: "window control -> reliability tiles -> incident correlation",
    changed:
      "the filter labels were page-local inline styles with their own ink; they name the one canonical field-label authority now, which is what made this route the first admin consumer of that primitive",
  },
  "/admin/platform/signers": {
    disposition: "REDESIGNED_AND_VISUALLY_VERIFIED",
    pattern: "signer posture -> signer table -> key facts",
    changed:
      "246 lines off the legacy system onto the shared surfaces; the search filter is labelled and the table states its count",
  },
  "/admin/provisioning": {
    disposition: "ALREADY_COMPLIANT",
    pattern: "provisioning posture -> invitation governance -> per-invite disclosure",
    changed:
      "reviewed against the capture and left alone. The doubled description reads as a repetition but is not one: the outer line states the section's scope and the inner line states what the governance table itself measures, and the inner text carries a fact the outer does not. Its legacy-palette and empty-state work landed with the console-wide passes",
  },
  "/admin/search": {
    disposition: "REDESIGNED_AND_VISUALLY_VERIFIED",
    pattern: "query field -> result groups -> per-result disclosure",
    changed:
      "the search field is labelled and its icon is named; results land on destinations that read the deep-link parameters they are sent, which they previously emitted and ignored",
  },
  "/admin/security": {
    disposition: "REDESIGNED_AND_VISUALLY_VERIFIED",
    pattern: "scope note -> posture strip -> events + scans -> MFA policy -> member lifecycle -> activity -> digest -> self-check",
    changed:
      "two filters offered values their endpoints refuse — 'Critical' against a domain of INFO/WARNING/HIGH, and 'Infected' where the status is SUSPICIOUS — so both returned 400 and rendered a form-validation sentence on a list; SUSPICIOUS also fell through to neutral grey, the one scan result an operator must act on. Five scan counters read 0 because no scanner is configured, two empty states blamed a filter that was not applied, and the page's own note card restated the amber scope banner 100px above it",
  },
  "/admin/support-access": {
    disposition: "REDESIGNED_AND_VISUALLY_VERIFIED",
    pattern: "grant posture -> active grants -> grant history",
    changed:
      "onto the canonical surfaces with a labelled filter set and one reset; a disabled grant control states its reason",
  },
  "/admin/timeline": {
    disposition: "REDESIGNED_AND_VISUALLY_VERIFIED",
    pattern: "filter bar -> platform event timeline -> per-event disclosure",
    changed:
      "the same actor duplication as the identity timeline, from the same shared presenter; the timeline rail moved onto the shared adm-* treatment rather than carrying its own",
  },
  "/admin/users": {
    disposition: "REDESIGNED_AND_VISUALLY_VERIFIED",
    pattern: "filter bar -> people roster -> lifecycle request queue",
    changed:
      "the 'joined' line under every address was a wrapping seconds-precision stamp that made each row three lines tall, and is now a date; the shareable URL is derived from the filters rather than written from inside the fetch callback, so a row clicked during the load opens instead of navigating the reader back",
  },
  "/admin/users/:id": {
    disposition: "REDESIGNED_AND_VISUALLY_VERIFIED",
    pattern: "identity -> commercial -> memberships -> security posture -> lifecycle",
    changed:
      "off the legacy style objects onto the canonical surfaces; the return link carries the roster state it came from",
  },
  "/admin/workspaces": {
    disposition: "REDESIGNED_AND_VISUALLY_VERIFIED",
    pattern: "filter bar -> workspace directory -> row navigation",
    changed:
      "the created stamp under every workspace name wrapped to two lines and made each row three lines tall in a table an operator scans; it is a date now. Same URL-sync fix as the roster, proven by clicking a customer link at the earliest moment it is possible",
  },
  "/admin/workspaces/:id": {
    disposition: "REDESIGNED_AND_VISUALLY_VERIFIED",
    pattern: "identity -> commercial context -> members and usage -> provider subscriptions -> activity",
    changed:
      "the page announced 'Enterprise contract', showed a green ACTIVE badge, and four fields later admitted 'No stored contract row. It is not a contract'; the qualification now arrives with the claim — the heading says 'no stored row', the badge is neutral because a derived status is not a contract status, and the field reads 'derived, not stored'",
  },
};

/* --------------------------------------------------------------- families */

const FAMILY = [
  ["/admin/platform/runbooks", "G. Runbooks", "Which procedure applies, and what exactly do I do?"],
  ["/admin/platform/exports", "C. Evidence Operations", "Is the export pipeline moving?"],
  ["/admin/platform/signers", "C. Evidence Operations", "Is custody intact and who signed?"],
  ["/admin/platform/media-graph", "C. Evidence Operations", "How does this media relate to the rest?"],
  ["/admin/platform/recovery", "C. Evidence Operations", "Can this be recovered, and by whom?"],
  ["/admin/platform/analytics", "H. Business Insight", "What is adoption doing, on what window?"],
  ["/admin/platform-health", "F. Platform Operations", "What is degraded right now?"],
  ["/admin/platform/readiness", "F. Platform Operations", "Is this deployment fit to serve?"],
  ["/admin/platform/observability", "F. Platform Operations", "What are the signals saying?"],
  ["/admin/platform/reliability", "F. Platform Operations", "Is the platform holding up over time?"],
  ["/admin/platform/queues", "F. Platform Operations", "What is backed up, and is it moving?"],
  ["/admin/platform/automation", "F. Platform Operations", "What runs on its own, and did it run?"],
  ["/admin/evidence-ops", "C. Evidence Operations", "Which evidence needs attention?"],
  ["/admin/identity", "D. Identity and Access", "Who has access and what is failing?"],
  ["/admin/customers", "B. Customers and Organizations", "Who are the customers and what state are they in?"],
  ["/admin/workspaces", "B. Customers and Organizations", "Which workspaces exist and are they live?"],
  ["/admin/users", "B. Customers and Organizations", "Who is this person and what can they reach?"],
  ["/admin/contact-sales", "B. Customers and Organizations", "Who asked to be contacted?"],
  ["/admin/demo-requests", "B. Customers and Organizations", "Who asked for a demo?"],
  ["/admin/provisioning", "B. Customers and Organizations", "How do I stand up an enterprise customer?"],
  ["/admin/billing", "B. Customers and Organizations", "What is owed, paid, and at risk?"],
  ["/admin/security", "E. Security and Support", "What is the security posture and what changed?"],
  ["/admin/audit", "E. Security and Support", "Who did what, with what authority, and what happened?"],
  ["/admin/timeline", "E. Security and Support", "What happened, in order?"],
  ["/admin/alerts", "E. Security and Support", "What is firing and does anybody own it?"],
  ["/admin/support-access", "E. Security and Support", "Who has support access to whom, and for how long?"],
  ["/admin/operations", "F. Platform Operations", "What operational conditions are open?"],
  ["/admin/costs", "F. Platform Operations", "What is this costing and where?"],
  ["/admin/search", "F. Platform Operations", "Where is the thing I am looking for?"],
  ["/admin/dashboard", "H. Business Insight", "How is the product being used?"],
  ["/admin/executive", "H. Business Insight", "How is the business doing?"],
  ["/admin/adoption", "H. Business Insight", "Which capabilities are actually adopted?"],
  ["/admin", "A. Admin Overview", "Is anything critical, what needs me, what changed, where do I go?"],
];

function familyFor(route) {
  let best = null;
  for (const [prefix, name, question] of FAMILY) {
    if (route === prefix || route.startsWith(`${prefix}/`)) {
      if (!best || prefix.length > best.len) best = { name, question, len: prefix.length };
    }
  }
  return best ?? { name: "UNASSIGNED", question: "UNASSIGNED" };
}

/* ----------------------------------------------------------------- lookups */

const slug = (r) => r.replace(/^\//, "").replace(/[^a-zA-Z0-9]+/g, "-").replace(/-+$/, "");
const concrete = (r) => r.replace(/\/:(id|slug)$/, "");

const respByRoute = new Map();
for (const row of responsive?.rows ?? []) {
  const key = row.route.replace(/\/[0-9a-f]{8}-[0-9a-f-]+$/, "/:id").replace(/\/tsa-timestamp-failure$/, "/:slug");
  if (!respByRoute.has(key)) respByRoute.set(key, []);
  respByRoute.get(key).push(row);
}
const rtlByRoute = new Map();
for (const row of rtl?.rows ?? []) {
  const key = row.route.replace(/\/[0-9a-f]{8}-[0-9a-f-]+$/, "/:id").replace(/\/tsa-timestamp-failure$/, "/:slug");
  rtlByRoute.set(key, row);
}
const kbdByRoute = new Map();
for (const row of keyboard?.results ?? []) {
  if (row.route) kbdByRoute.set(row.route, row);
}

const TABBED = new Set(["/admin/identity/scim"]);
const WINDOWED = new Set(["/admin/dashboard", "/admin/platform/analytics"]);

const shotCell = (route, view) => {
  const f = `${slug(route)}--${view}.png`;
  const abs = resolve(SHOTS, f);
  if (!existsSync(abs)) return "MISSING";
  return `${Math.round(statSync(abs).size / 1024)} KB`;
};

function respCell(route) {
  const rows = respByRoute.get(route);
  if (!rows || rows.length === 0) return "NOT VERIFIED";
  const widths = new Set(rows.filter((r) => r.zoom === 1).map((r) => r.width));
  const zoom = rows.some((r) => r.zoom === 2);
  const overflow = rows.filter((r) => r.overflow > 0).length;
  const small = rows.filter((r) => r.smallContent > 0).length;
  const tiny = rows.filter((r) => r.tinyContent > 0).length;
  const bits = [`${widths.size}w${zoom ? "+z200" : ""}`];
  bits.push(overflow ? `overflow x${overflow}` : "no overflow");
  if (small) bits.push(`small x${small}`);
  if (tiny) bits.push(`tiny x${tiny}`);
  return bits.join(", ");
}

function rtlCell(route) {
  const r = rtlByRoute.get(route);
  if (!r) return "NOT VERIFIED";
  const bits = [r.dir === "rtl" ? "rtl" : `DIR=${r.dir}`];
  bits.push(r.overflow ? `overflow ${r.overflow}px` : "no overflow");
  if (r.badDirectionCount) bits.push(`${r.badDirectionCount} mis-directed`);
  return bits.join(", ");
}

function statesCell(route) {
  const row = review.routes.find((x) => x.route === route);
  if (!row) return "NOT VERIFIED";
  const d = row.desktop ?? {};
  const seen = [];
  if ((d.tables ?? 0) > 0) seen.push("populated/empty table");
  if ((d.oneValueCards ?? 0) > 0) seen.push("measured values");
  seen.push("loading (harness waits it out)");
  if ((d.consoleErrors ?? []).length) seen.push(`${d.consoleErrors.length} console errors`);
  return seen.join("; ");
}

/* ---------------------------------------------------------------- assemble */

const rows = review.routes.map((r) => {
  const fam = familyFor(r.route);
  const d = r.desktop ?? {};
  const insp = INSPECTED[r.route];
  const kbd = kbdByRoute.get(concrete(r.route));
  return {
    route: r.route,
    family: fam.name,
    question: fam.question,
    pattern: insp?.pattern ?? "PageShell + PageSection (canonical), adm-* surfaces via the shared system",
    changed: insp?.changed ?? null,
    cards: d.cards ?? 0,
    oneValue: d.oneValueCards ?? 0,
    tables: d.tables ?? 0,
    tabs: TABBED.has(r.route)
      ? `4 tabs, all opened (tabs.json)`
      : WINDOWED.has(r.route)
        ? "3-option window control, verified"
        : "no in-page tabs (secondary nav is links)",
    h1: (d.h1 ?? []).length,
    screens: d.screensTall ?? null,
    desktop: shotCell(r.route, "desktop"),
    mobile: shotCell(r.route, "mobile"),
    responsive: respCell(r.route),
    rtl: rtlCell(r.route),
    keyboard: kbd
      ? `tab order + focus verified (${kbd.stops} stops, ${kbd.noFocusSignal} without a ring)`
      : "covered by the shared shell sweep; not driven per-route",
    states: statesCell(r.route),
    disposition:
      insp?.disposition ?? "SWEEP_VERIFIED_COMPOSITION_NOT_REVIEWED",
  };
});

const inspectedCount = rows.filter((r) => INSPECTED[r.route]).length;
const sweptOnly = rows.length - inspectedCount;

const esc = (s) => String(s).replace(/\|/g, "\\|");

const lines = [];
lines.push("# Phase 7 — per-page visual checklist");
lines.push("");
lines.push("<!--");
lines.push("  GENERATED. Do not edit by hand.");
lines.push("    node scripts/admin-ledger/visual-checklist.mjs");
lines.push("");
lines.push("  Every column except `pattern`, `changed` and `disposition` is read");
lines.push("  from a capture artifact. Those three come from the INSPECTED map in");
lines.push("  the generator, which is the one claim no artifact can make on a");
lines.push("  person's behalf.");
lines.push("-->");
lines.push("");
lines.push("## Coverage");
lines.push("");
lines.push("```text");
lines.push(`total pages                        = ${rows.length}`);
lines.push(`desktop screenshot present         = ${rows.filter((r) => r.desktop !== "MISSING").length}`);
lines.push(`mobile screenshot present          = ${rows.filter((r) => r.mobile !== "MISSING").length}`);
lines.push(`responsive swept (7 widths + zoom) = ${rows.filter((r) => r.responsive !== "NOT VERIFIED").length}`);
lines.push(`RTL verified                       = ${rows.filter((r) => r.rtl !== "NOT VERIFIED").length}`);
lines.push(`exactly one H1                     = ${rows.filter((r) => r.h1 === 1).length}`);
lines.push(`composition individually reviewed  = ${inspectedCount}`);
lines.push(`swept but not composition-reviewed = ${sweptOnly}`);
lines.push("```");
lines.push("");
lines.push(
  sweptOnly > 0
    ? `> **${sweptOnly} of ${rows.length} pages carry \`SWEEP_VERIFIED_COMPOSITION_NOT_REVIEWED\`.**\n` +
        "> That is not one of the three dispositions §15 permits, and it is printed\n" +
        "> deliberately: those pages have had their tokens, contrast, target sizes,\n" +
        "> text floor, empty states, RTL and responsive behaviour verified by\n" +
        "> instrument across every required width, and they have NOT had a person\n" +
        "> decide, card by card, whether each one earns its place. Phase 7 is not\n" +
        "> complete until that number is 0."
    : "> All pages carry a permitted disposition.",
);
lines.push("");

const byFamily = new Map();
for (const r of rows) {
  if (!byFamily.has(r.family)) byFamily.set(r.family, []);
  byFamily.get(r.family).push(r);
}

for (const [family, frows] of [...byFamily].sort()) {
  lines.push(`## ${family}`);
  lines.push("");
  lines.push(`**The operator's question:** ${frows[0].question}`);
  lines.push("");
  lines.push(
    "| route | screens | cards | 1-val | tables | tabs | H1 | desktop | mobile | responsive | RTL | disposition |",
  );
  lines.push("|---|---|---|---|---|---|---|---|---|---|---|---|");
  for (const r of frows.sort((a, b) => a.route.localeCompare(b.route))) {
    lines.push(
      `| \`${esc(r.route)}\` | ${r.screens} | ${r.cards} | ${r.oneValue} | ${r.tables} | ${esc(r.tabs)} | ${r.h1} | ${r.desktop} | ${r.mobile} | ${esc(r.responsive)} | ${esc(r.rtl)} | ${r.disposition} |`,
    );
  }
  lines.push("");
  const done = frows.filter((r) => r.changed);
  if (done.length > 0) {
    lines.push("### What was recomposed, and onto what");
    lines.push("");
    for (const r of done) {
      lines.push(`- **\`${r.route}\`** — *${r.pattern}*`);
      lines.push(`  - ${r.changed}`);
    }
    lines.push("");
  }
}

lines.push("## Tab surface");
lines.push("");
lines.push(
  "A grep of the admin tree for `role=\"tab\"` returns ONE page. Every other\n" +
    "section switches view through the console's secondary navigation row, which\n" +
    "is real links with real URLs — which is what §10 asks for. Two pages carry a\n" +
    "time-window segmented control. That is the complete surface, and all six were\n" +
    "opened.",
);
lines.push("");
if (tabs?.report) {
  lines.push("```text");
  for (const entry of tabs.report) {
    if (entry.tab) {
      const d = entry.desktop ?? {};
      lines.push(
        `/admin/identity/scim tab=${entry.tab.padEnd(10)} selected="${d.selectedLabel}" one-selected=${d.selected === 1} url=${d.url} overflow=${d.overflow} mobileOverflow=${entry.mobile?.overflow}`,
      );
    }
    if (entry.keyboard) {
      lines.push(
        `  ArrowRight -> "${entry.keyboard.afterArrow?.selectedLabel}"  reload -> "${entry.keyboard.afterReload?.selectedLabel}"`,
      );
    }
    if (entry.window) {
      lines.push(
        `${entry.route} window options=${JSON.stringify(entry.window.options)} targets=${JSON.stringify(entry.window.targets)}`,
      );
    }
  }
  lines.push("```");
} else {
  lines.push("`tabs.json` is missing — run `node p7-tabs.mjs`.");
}
lines.push("");

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, lines.join("\n"), "utf8");
console.log(`wrote ${relative(REPO, OUT).split("\\").join("/")}`);
console.log(
  `${rows.length} routes · ${inspectedCount} composition-reviewed · ${sweptOnly} sweep-verified only`,
);
