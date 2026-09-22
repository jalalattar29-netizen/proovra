#!/usr/bin/env node
/**
 * NATIVE ACTION INVENTORY — what the app lets an ordinary user DO.
 *
 * The route inventory answers "which SURFACES exist natively". F-01 asked a
 * different question at a level nothing measured: which ACTIONS does the app
 * offer, and is any of them Enterprise administration that the web reserves
 * for a console an ordinary user never reaches?
 *
 * A route-level inventory cannot answer it. `/organizations/[id]` is
 * membership-gated and correctly native — routeRegistry.ts:185 says so in
 * words — while the administration BELOW it is enterprise-gated. The two live
 * on the same surface, so the surface's classification tells you nothing about
 * the actions on it.
 *
 * ---------------------------------------------------------------------------
 * HOW THIS ANSWERS IT, AND WHY NOT THE OTHER WAY
 * ---------------------------------------------------------------------------
 * The first version of this file tried to read the CLIENT GATE around each
 * action — the `isOrgOwner(...)` that decides whether a control renders. It
 * reported 115 of 122 actions ungated, because a native surface gates in the
 * JSX that renders the control and the handler it calls is a separate
 * function. A tool that cries wolf 115 times is worse than no tool.
 *
 * So this measures something factual instead: for every WRITE the native app
 * makes, which WEB page makes the same write? The capability map already
 * records both consumers per route, and the product manifest already
 * classifies every web route as NATIVE_REQUIRED or admin/enterprise/marketing.
 * The question becomes a join, and the answer is evidence rather than
 * inference:
 *
 *   MATCHES_WEB     a non-enterprise web page performs the same write. The
 *                   native app is offering what the product offers.
 *   ENTERPRISE_ONLY the only web page performing it is one the registry
 *                   reserves. THIS is an F-01 instance.
 *   NATIVE_ONLY     no web consumer at all — a deliberate native affordance,
 *                   listed so it is reviewed rather than assumed.
 *
 * A client gate is not authorization: the server decides, and every one of
 * these routes is authorized there. What this measures is whether the product
 * OFFERS something it will then refuse — a different defect, which wastes a
 * person's time and misrepresents what their role is.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
const MOBILE = resolve(import.meta.dirname, "..");
const REPO = resolve(MOBILE, "..", "..");
const CAPABILITY_MAP = join(REPO, "docs/architecture/current-runtime-capability-map.json");

const WRITE_METHODS = new Set(["POST", "PATCH", "PUT", "DELETE"]);

/**
 * The product manifest's own classification, keyed by the SAME source file the
 * capability map records for a web consumer.
 *
 * Nothing here forms a second opinion about which web routes are reserved: the
 * manifest already decides NATIVE_REQUIRED vs ADMIN_ONLY / ENTERPRISE_ONLY
 * from routeRegistry, and this joins against it.
 *
 * A consumer file the manifest does not know is reported as UNKNOWN_WEB_OWNER
 * and FAILS the check rather than passing it. The first draft of this tool
 * looked up a manifest file that was not there; every web route then read
 * "UNCLASSIFIED", the ENTERPRISE_ONLY verdict could never fire, and it
 * reported a clean result over nothing. A check that cannot fail is not a
 * check — the same lesson the contract audit records.
 */
async function loadClassifications() {
  const { buildManifest } = await import("./derive-product-manifest.mjs");
  const manifest = await buildManifest();
  const byFile = new Map();
  for (const row of manifest.rows) byFile.set(row.sourceFile, row.classification);
  if (byFile.size === 0) throw new Error("the product manifest classified nothing");
  return byFile;
}

const RESERVED = new Set(["ADMIN_ONLY", "ENTERPRISE_ONLY"]);

export async function inventory() {
  const map = JSON.parse(readFileSync(CAPABILITY_MAP, "utf8"));
  const classOf = await loadClassifications();

  const rows = [];
  for (const route of map.routes) {
    const [method, path] = route.routeId.split(" ");
    if (!WRITE_METHODS.has(method)) continue;

    const consumers = route.productConsumers ?? [];
    const native = consumers.filter((c) => c.class === "MOBILE");
    if (native.length === 0) continue;

    const web = consumers.filter((c) => c.class === "WEB");
    // A web consumer that is not a page — a lib, a hook, a server action —
    // carries no route classification of its own, so it is named rather than
    // silently treated as unreserved.
    const owners = web.map((c) => ({
      file: c.file,
      classification: classOf.get(c.file) ?? (/\/page\.tsx?$/.test(c.file) ? "UNKNOWN_WEB_OWNER" : "NOT_A_PAGE"),
    }));

    let verdict;
    if (web.length === 0) verdict = "NATIVE_ONLY";
    else if (owners.some((o) => o.classification === "UNKNOWN_WEB_OWNER")) {
      verdict = "UNKNOWN_WEB_OWNER";
    } else {
      const pages = owners.filter((o) => o.classification !== "NOT_A_PAGE");
      verdict =
        pages.length > 0 && pages.every((o) => RESERVED.has(o.classification))
          ? "ENTERPRISE_ONLY"
          : "MATCHES_WEB";
    }

    rows.push({
      routeId: route.routeId,
      method,
      path,
      gates: route.gates ?? [],
      securityFamily: route.primarySecurityFamily ?? null,
      nativeSites: native.map((c) => `${c.file}:${c.line}`),
      webOwners: owners,
      verdict,
    });
  }

  rows.sort((a, b) => a.routeId.localeCompare(b.routeId));
  const counts = rows.reduce((acc, r) => ({ ...acc, [r.verdict]: (acc[r.verdict] ?? 0) + 1 }), {});
  return { rows, counts };
}

/* -------------------------------------------------------------------- main */

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  const { rows, counts } = await inventory();
  console.log(
    `native write actions: ${rows.length}  ` +
      Object.entries(counts)
        .map(([k, v]) => `${k} ${v}`)
        .join("  "),
  );
  for (const r of rows) {
    if (r.verdict === "ENTERPRISE_ONLY") {
      console.log(`  ENTERPRISE_ONLY ${r.routeId}\n    native: ${r.nativeSites.join(", ")}\n    web:    ${r.webRoutes.join(", ")}`);
    }
  }
  for (const r of rows) {
    if (r.verdict === "NATIVE_ONLY") console.log(`  NATIVE_ONLY ${r.routeId}  (${r.nativeSites[0]})`);
  }
  if (process.argv.includes("--json")) {
    const out = join(MOBILE, "docs", "native-action-inventory.json");
    writeFileSync(out, `${JSON.stringify({ counts, rows }, null, 2)}\n`);
    console.log(`wrote ${out}`);
  }
  // Both are failures: an Enterprise action offered natively, and a web owner
  // this tool could not classify — an unclassified row is not a pass.
  const bad = (counts.ENTERPRISE_ONLY ?? 0) + (counts.UNKNOWN_WEB_OWNER ?? 0);
  if (process.argv.includes("--check") && bad > 0) process.exit(1);
}
