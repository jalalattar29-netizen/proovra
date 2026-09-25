/**
 * V3 INSTRUMENT — the applicable route inventory with BOTH entry points.
 *
 * Web entry  : apps/web/app/<...>/page.tsx  (from the frozen reclass.json)
 * Native entry: from apps/mobile/src/product/native-destinations.mjs `routeFile`,
 *               corrected for the three routes v2 proved the manifest wrong on.
 *
 * Emits routes.json. Read-only.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";

const ROOT = "D:/digital-witness";
const OUT = `${ROOT}/docs/audit/pwa-native-2026-09-24-v2`;

const reclass = JSON.parse(readFileSync(`${OUT}/reclass.json`, "utf8"));
const { NATIVE_DESTINATIONS } = await import(`file:///${ROOT}/apps/mobile/src/product/native-destinations.mjs`);

/* v2 baseline §3c corrections to the manifest's classification. */
const ADD = ["/operations", "/operations/health"];       // CORE/allow, manifest wrongly excluded
const DROP = new Set(["/workspaces"]);                    // ENTERPRISE/redirect, manifest wrongly included

const applicable = reclass
  .filter((r) => r.manifest === "NATIVE_REQUIRED" || ADD.includes(r.path))
  .filter((r) => !DROP.has(r.path));

const webEntryFor = (p) => {
  const row = reclass.find((r) => r.path === p);
  // reclass carries path only; recover the source file from the manifest run
  return row?.sourceFile ?? null;
};

// The manifest JSON has sourceFile; reclass.json does not. Recover from disk.
function findWebEntry(routePath) {
  const segs = routePath === "/" ? [] : routePath.slice(1).split("/");
  const cands = [
    `apps/web/app/(app)/${segs.join("/")}/page.tsx`,
    `apps/web/app/${segs.join("/")}/page.tsx`,
  ];
  for (const c of cands) if (existsSync(`${ROOT}/${c}`)) return c;
  return null;
}

const rows = applicable.map((r) => {
  const dest = NATIVE_DESTINATIONS[r.path];
  const nativeFile = dest?.routeFile ? `apps/mobile/app/${dest.routeFile}` : null;
  return {
    route: r.path,
    webEntry: findWebEntry(r.path),
    nativeEntry: nativeFile && existsSync(`${ROOT}/${nativeFile}`) ? nativeFile : null,
    nativeDeclared: dest?.routeFile ?? null,
    ledgerStatus: dest?.status ?? "(absent from ledger)",
    physicallyAccepted: dest?.physicallyAccepted ?? false,
    tier: r.tier,
    policy: r.policy,
    borderline: false,
  };
});

// /workspaces kept as BORDERLINE (compared, excluded from gap counts)
const wsRow = reclass.find((r) => r.path === "/workspaces");
if (wsRow) {
  const d = NATIVE_DESTINATIONS["/workspaces"];
  rows.push({
    route: "/workspaces", webEntry: findWebEntry("/workspaces"),
    nativeEntry: d?.routeFile ? `apps/mobile/app/${d.routeFile}` : null,
    nativeDeclared: d?.routeFile ?? null, ledgerStatus: d?.status ?? "(absent)",
    physicallyAccepted: d?.physicallyAccepted ?? false,
    tier: wsRow.tier, policy: wsRow.policy, borderline: true,
  });
}

rows.sort((a, b) => a.route.localeCompare(b.route));

const noWeb = rows.filter((r) => !r.webEntry);
const noNat = rows.filter((r) => !r.nativeEntry);
console.log("applicable rows :", rows.length, `(incl. ${rows.filter(r=>r.borderline).length} borderline)`);
console.log("web entry missing:", noWeb.length, noWeb.map((r) => r.route).join(", "));
console.log("NO NATIVE SCREEN :", noNat.length);
for (const r of noNat) console.log("   ", r.route.padEnd(40), "ledger:", r.ledgerStatus);

writeFileSync(`${OUT}/routes.json`, JSON.stringify({ frozenSha: "71e148f34410c7c231f8930d1387d8924b10b4e5", rows }, null, 1));
console.log("wrote routes.json");
