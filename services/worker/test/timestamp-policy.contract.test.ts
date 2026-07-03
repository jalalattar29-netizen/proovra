/**
 * PROOVRA Global Timestamp Display Policy — project-wide enforcement.
 *
 * Every user-visible timestamp in the project (PDF report, dashboard, verify,
 * intake, mobile, emails, admin, audit) is formatted through the single shared
 * timestamp layer. Direct date/time formatting APIs are forbidden OUTSIDE the
 * allowlisted helper/builder/test files; this test fails CI if any are
 * reintroduced. Number formatting and time-zone CAPTURE (data collection) are
 * intentionally NOT flagged — the policy governs timestamp DISPLAY only.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve, relative, sep } from "node:path";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

const SCAN_ROOTS = [
  "apps/web",
  "apps/mobile",
  "services/api/src",
  "services/worker/src",
  "packages/shared/src",
  "packages/shared-runtime/src",
];

// Direct timestamp-display API remains OK only inside these files (the single
// shared helper + its thin per-app wrappers). Package/canonical/manifest/
// custody builders keep RAW ISO (toISOString) and never call these APIs, so
// they need no exception. Tests and generated/build output are skipped.
const ALLOWLIST_SUFFIX = [
  "packages/shared/src/timestamp-format.ts",
  "apps/web/lib/date.ts",
  "apps/mobile/src/lib/date.ts",
].map((p) => p.split("/").join(sep));

const SKIP_DIR = new Set([
  "node_modules", "dist", ".next", "build", ".expo", "coverage", "scripts-tmp",
]);

function isAllowlisted(fileAbs: string): boolean {
  if (/[.]test[.]|[.]spec[.]|[\\/]test[\\/]|[\\/]tests[\\/]/.test(fileAbs)) return true;
  return ALLOWLIST_SUFFIX.some((suf) => fileAbs.endsWith(suf));
}

function collect(dirAbs: string): string[] {
  const out: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dirAbs);
  } catch {
    return out;
  }
  for (const name of entries) {
    if (SKIP_DIR.has(name)) continue;
    const full = join(dirAbs, name);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) out.push(...collect(full));
    else if (/\.(ts|tsx)$/.test(name) && !name.endsWith(".d.ts")) out.push(full);
  }
  return out;
}

/** Return the forbidden-formatting reason for a line, or null. Number
 *  formatting and Intl time-zone CAPTURE are deliberately allowed. */
function violation(line: string): string | null {
  if (/\.toLocaleDateString\s*\(/.test(line)) return "toLocaleDateString";
  if (/\.toLocaleTimeString\s*\(/.test(line)) return "toLocaleTimeString";
  // Intl.DateTimeFormat DISPLAY (…).format — NOT the capability check
  // (`typeof Intl.DateTimeFormat === "function"`) or tz capture
  // (`Intl.DateTimeFormat().resolvedOptions().timeZone`).
  if (
    /Intl\.DateTimeFormat\s*\(/.test(line) &&
    !/resolvedOptions/.test(line) &&
    !/typeof\s+Intl\.DateTimeFormat/.test(line) &&
    !/Intl\.DateTimeFormat\s*===/.test(line)
  ) {
    return "Intl.DateTimeFormat().format";
  }
  // A Date rendered via toLocaleString / toString (bare number.toLocaleString
  // is fine and not matched here).
  if (/new Date\([^)]*\)\s*\.\s*toLocaleString\s*\(/.test(line))
    return "new Date().toLocaleString";
  if (/new Date\([^)]*\)\s*\.\s*toString\s*\(/.test(line))
    return "new Date().toString";
  return null;
}

describe("timestamp policy — no direct timestamp formatting outside the shared layer", () => {
  const files = SCAN_ROOTS.flatMap((r) => collect(join(REPO_ROOT, r)));

  it("scanned a meaningful set of source files", () => {
    expect(files.length).toBeGreaterThan(500);
  });

  it("no UI/PDF/email/mobile file formats timestamps directly", () => {
    const offenders: string[] = [];
    for (const f of files) {
      if (isAllowlisted(f)) continue;
      const src = readFileSync(f, "utf8");
      const lines = src.split(/\r?\n/);
      lines.forEach((line, i) => {
        // Skip comment-only lines.
        if (/^\s*(\/\/|\*|\/\*)/.test(line)) return;
        const reason = violation(line);
        if (reason) {
          offenders.push(`${relative(REPO_ROOT, f)}:${i + 1} → ${reason}`);
        }
      });
    }
    expect(offenders, `\nForbidden timestamp formatting found:\n${offenders.join("\n")}\n`).toEqual([]);
  });

  it("the PDF report routes system time through formatTimestampForReportUtc", () => {
    const vm = readFileSync(
      join(REPO_ROOT, "services/worker/src/report-v2/build-view-model.ts"),
      "utf8",
    );
    expect(vm).toMatch(/formatTimestampForReportUtc/);
    expect(vm).toMatch(/function formatReportTimestamp[\s\S]{0,140}formatTimestampForReportUtc/);
  });
});
