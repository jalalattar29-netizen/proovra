#!/usr/bin/env node
/**
 * CONTACT SHEETS, GROUPED BY ADMIN FAMILY.
 *
 * =============================================================================
 * WHY THIS EXISTS
 * =============================================================================
 * 94 full-page PNGs in a flat directory is not a review — nobody opens 94
 * files, and a reviewer who opens twelve of them has reviewed twelve pages.
 * §24 asks for the captures to be grouped by the eight families so the result
 * can be looked at efficiently, and looking at it is the whole point: "do not
 * claim world-class based on automated tests".
 *
 * So this builds one HTML page per family — desktop and phone side by side per
 * route, with the composition measurements the review harness recorded beside
 * each pair, and the before/after pair where a baseline capture exists.
 *
 * =============================================================================
 * WHY HTML AND NOT A STITCHED IMAGE
 * =============================================================================
 * A stitched sheet has to shrink each capture to fit, and a full-page admin
 * screenshot at 1440x3200 shrunk into a grid cell is unreadable — which makes
 * the sheet look like coverage while providing none. HTML keeps every image at
 * a size a person can actually read, lets the browser lazy-load them, and
 * links each one to the full-resolution file.
 *
 * `artifacts/` is gitignored on purpose (see screenshot-manifest.mjs), so
 * these sheets are local review surfaces. What travels in the repository is
 * the manifest: route, viewport, byte size and sha256 per capture.
 *
 * Usage:
 *   node scripts/admin-ledger/contact-sheets.mjs
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../..");
const REVIEW = resolve(REPO, "artifacts/admin-visual-review");
const SHOTS = resolve(REVIEW, "screenshots");
const BEFORE = resolve(REVIEW, "before");
const OUT = resolve(REVIEW, "contact-sheets");

/**
 * THE EIGHT FAMILIES, in the order §14 names them.
 *
 * Matched by route prefix, longest first, so `/admin/platform/runbooks` lands
 * in Runbooks rather than in Platform Operations. A route that matches nothing
 * would be a silent omission, so the generator refuses instead — see below.
 */
const FAMILIES = [
  {
    id: "a-overview",
    name: "A. Admin Overview",
    question: "Is anything critical, what needs action, what changed, where do I go?",
    routes: ["/admin"],
  },
  {
    id: "b-customers",
    name: "B. Customers and Organizations",
    question: "Who is this customer, what state are they in, what can I do about it?",
    routes: [
      "/admin/customers",
      "/admin/workspaces",
      "/admin/users",
      "/admin/contact-sales",
      "/admin/demo-requests",
      "/admin/provisioning",
      "/admin/billing",
    ],
  },
  {
    id: "c-evidence",
    name: "C. Evidence Operations",
    question: "Which evidence is affected, is its custody intact, what do I do?",
    routes: [
      "/admin/evidence-ops",
      "/admin/platform/exports",
      "/admin/platform/signers",
      "/admin/platform/media-graph",
      "/admin/platform/recovery",
    ],
  },
  {
    id: "d-identity",
    name: "D. Identity and Access",
    question: "Who has access, how did they get it, and what is failing?",
    routes: ["/admin/identity"],
  },
  {
    id: "e-security",
    name: "E. Security and Support",
    question: "Who did what to whom, with what authority, and what was the outcome?",
    routes: [
      "/admin/security",
      "/admin/audit",
      "/admin/timeline",
      "/admin/alerts",
      "/admin/support-access",
    ],
  },
  {
    id: "f-platform",
    name: "F. Platform Operations",
    question: "What is the platform's state, what is degraded, and what do I run?",
    routes: [
      "/admin/platform-health",
      "/admin/operations",
      "/admin/platform/readiness",
      "/admin/platform/observability",
      "/admin/platform/reliability",
      "/admin/platform/queues",
      "/admin/platform/automation",
      "/admin/costs",
      "/admin/search",
    ],
  },
  {
    id: "g-runbooks",
    name: "G. Runbooks",
    question: "Which procedure applies, and what exactly do I do?",
    routes: ["/admin/platform/runbooks"],
  },
  {
    id: "h-insight",
    name: "H. Business Insight",
    question: "How is the business doing, on what timeframe, measured how?",
    routes: ["/admin/dashboard", "/admin/executive", "/admin/adoption", "/admin/platform/analytics"],
  },
];

const slug = (route) =>
  route.replace(/^\//, "").replace(/[^a-zA-Z0-9]+/g, "-").replace(/-+$/, "");

function familyFor(route) {
  let best = null;
  for (const f of FAMILIES) {
    for (const p of f.routes) {
      if (route === p || route.startsWith(`${p}/`)) {
        if (!best || p.length > best.len) best = { family: f, len: p.length };
      }
    }
  }
  return best?.family ?? null;
}

/* ------------------------------------------------------------------ inputs */

if (!existsSync(SHOTS)) {
  console.error(
    `contact-sheets: no captures at ${relative(REPO, SHOTS)}.\n` +
      "Run the review first:\n" +
      "  npx playwright test admin-visual-review --config apps/web/e2e/admin-control-plane/playwright.config.ts",
  );
  process.exit(2);
}

const reviewPath = resolve(REVIEW, "review.json");
const review = existsSync(reviewPath)
  ? JSON.parse(readFileSync(reviewPath, "utf8")).routes
  : [];
const byRoute = new Map(review.map((r) => [r.route, r]));

const captures = readdirSync(SHOTS).filter((f) => f.endsWith(".png"));
const routes = [...new Set(review.map((r) => r.route))];
if (routes.length === 0) {
  console.error("contact-sheets: review.json listed no routes.");
  process.exit(2);
}

/* --------------------------------------------------------------- rendering */

const esc = (s) =>
  String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

const kb = (abs) => (existsSync(abs) ? `${Math.round(statSync(abs).size / 1024)} KB` : "missing");

function metrics(route, view) {
  const m = byRoute.get(route)?.[view];
  if (!m) return "";
  const bits = [
    `${m.screensTall} screens`,
    `${m.scrollHeight}px`,
    `${m.cards} cards`,
    m.oneValueCards ? `${m.oneValueCards} one-value` : null,
    m.overflowX ? "OVERFLOW-X" : null,
    (m.consoleErrors ?? []).length ? `${m.consoleErrors.length} console errors` : null,
    m.h1?.length !== 1 ? `h1=${m.h1?.length ?? 0}` : null,
  ].filter(Boolean);
  return bits.join(" · ");
}

function pane(route, view, label) {
  const file = `${slug(route)}--${view}.png`;
  const after = resolve(SHOTS, file);
  const before = resolve(BEFORE, file);
  const rel = (abs) => relative(OUT, abs).split("\\").join("/");
  const hasBefore = existsSync(before);
  return `
      <div class="pane">
        <div class="pane-head">
          <span class="view">${esc(label)}</span>
          <span class="meta">${esc(metrics(route, view))}</span>
        </div>
        <div class="shots">
          ${
            hasBefore
              ? `<figure>
            <figcaption>before · ${esc(kb(before))}</figcaption>
            <a href="${esc(rel(before))}" target="_blank" rel="noreferrer">
              <img loading="lazy" src="${esc(rel(before))}" alt="${esc(route)} ${esc(label)} before">
            </a>
          </figure>`
              : ""
          }
          <figure>
            <figcaption>${hasBefore ? "after" : "capture"} · ${esc(kb(after))}</figcaption>
            <a href="${esc(rel(after))}" target="_blank" rel="noreferrer">
              <img loading="lazy" src="${esc(rel(after))}" alt="${esc(route)} ${esc(label)}">
            </a>
          </figure>
        </div>
      </div>`;
}

const CSS = `
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body { margin: 0; font: 14px/1.5 -apple-system, "Segoe UI", system-ui, sans-serif;
         background: #f7f8fc; color: #0f172a; }
  header { position: sticky; top: 0; z-index: 2; padding: 20px 32px;
           background: #fff; border-bottom: 1px solid rgba(15,23,42,.09); }
  h1 { margin: 0; font-size: 24px; letter-spacing: -.01em; }
  .question { margin: 6px 0 0; font-size: 13px; color: #475569; max-width: 78ch; }
  nav.families { margin: 12px 0 0; display: flex; gap: 8px; flex-wrap: wrap; }
  nav.families a { min-height: 32px; display: inline-flex; align-items: center;
                   padding: 0 10px; border: 1px solid rgba(15,23,42,.09);
                   border-radius: 999px; font-size: 12px; font-weight: 600;
                   color: #475569; text-decoration: none; background: #fff; }
  nav.families a[aria-current] { border-color: #7C3AED; background: #F2ECFE; color: #6D28D9; }
  main { padding: 24px 32px 64px; }
  section.route { margin: 0 0 40px; }
  h2 { margin: 0 0 4px; font-size: 17px; font-family: ui-monospace, Consolas, monospace; }
  .panes { display: grid; gap: 16px; grid-template-columns: 3fr 1fr; align-items: start; }
  @media (max-width: 1100px) { .panes { grid-template-columns: 1fr; } }
  .pane { border: 1px solid rgba(15,23,42,.09); border-radius: 12px;
          background: #fff; overflow: hidden; }
  .pane-head { display: flex; justify-content: space-between; gap: 12px;
               padding: 8px 12px; border-bottom: 1px solid rgba(15,23,42,.06);
               background: #f8fafc; }
  .view { font-size: 11px; font-weight: 700; letter-spacing: .06em;
          text-transform: uppercase; color: #5B6B7B; }
  .meta { font-size: 11.5px; color: #475569; font-variant-numeric: tabular-nums;
          text-align: right; }
  .shots { display: flex; gap: 12px; padding: 12px; align-items: flex-start;
           overflow-x: auto; }
  figure { margin: 0; flex: 1 1 0; min-width: 0; }
  figcaption { font-size: 11px; color: #5B6B7B; margin-bottom: 6px; }
  img { width: 100%; height: auto; display: block; border: 1px solid rgba(15,23,42,.09);
        border-radius: 8px; background: #fff; }
`;

mkdirSync(OUT, { recursive: true });

const unmatched = [];
const assigned = new Map(FAMILIES.map((f) => [f.id, []]));
for (const route of routes) {
  const f = familyFor(route);
  if (!f) {
    unmatched.push(route);
    continue;
  }
  assigned.get(f.id).push(route);
}

/*
 * A ROUTE THAT MATCHES NO FAMILY IS A HOLE IN THE REVIEW, not a route to skip.
 * The generator refuses rather than quietly producing eight sheets that
 * together cover 44 of 47 pages — which is exactly the omission the completion
 * ledger exists to prevent.
 */
if (unmatched.length > 0) {
  console.error(
    `contact-sheets: ${unmatched.length} route(s) belong to no family:\n  ` +
      unmatched.join("\n  ") +
      "\nAdd them to FAMILIES in this file. Refusing to write a partial set.",
  );
  process.exit(1);
}

const navFor = (currentId) =>
  `<nav class="families">` +
  FAMILIES.map(
    (f) =>
      `<a href="${f.id}.html"${f.id === currentId ? ' aria-current="page"' : ""}>${esc(
        f.name,
      )} <span>(${assigned.get(f.id).length})</span></a>`,
  ).join("") +
  `<a href="index.html">All</a></nav>`;

let totalPanes = 0;
for (const f of FAMILIES) {
  const rs = assigned.get(f.id).sort();
  const body = rs
    .map(
      (route) => `
    <section class="route" id="${esc(slug(route))}">
      <h2>${esc(route)}</h2>
      <div class="panes">
        ${pane(route, "desktop", "desktop · 1440")}
        ${pane(route, "mobile", "phone · 390")}
      </div>
    </section>`,
    )
    .join("");
  totalPanes += rs.length * 2;
  writeFileSync(
    resolve(OUT, `${f.id}.html`),
    `<!doctype html><meta charset="utf-8"><title>${esc(f.name)} — contact sheet</title>
<style>${CSS}</style>
<header>
  <h1>${esc(f.name)}</h1>
  <p class="question"><strong>The operator's question:</strong> ${esc(f.question)}</p>
  ${navFor(f.id)}
</header>
<main>${body}</main>`,
    "utf8",
  );
  console.log(`${f.id}.html  ${String(rs.length).padStart(2)} routes`);
}

writeFileSync(
  resolve(OUT, "index.html"),
  `<!doctype html><meta charset="utf-8"><title>Admin contact sheets</title>
<style>${CSS}</style>
<header>
  <h1>Admin control plane — contact sheets</h1>
  <p class="question">${routes.length} routes, desktop and phone, grouped by the eight
  families. Before/after where a baseline capture exists. Click any image for
  the full-resolution capture.</p>
  ${navFor(null)}
</header>
<main>
  <section class="route">
    <h2>Coverage</h2>
    <p class="question">
      ${routes.length} routes · ${captures.length} captures on disk ·
      ${totalPanes} panes across ${FAMILIES.length} sheets.
    </p>
  </section>
</main>`,
  "utf8",
);

console.log(
  `\n${routes.length} routes · ${captures.length} captures · ${totalPanes} panes · ${FAMILIES.length} sheets`,
);
console.log(`open ${relative(REPO, resolve(OUT, "index.html")).split("\\").join("/")}`);
