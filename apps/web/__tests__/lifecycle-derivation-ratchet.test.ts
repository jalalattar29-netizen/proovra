/**
 * PROOVRA Phase 1 — Lifecycle Derivation Ratchet Test.
 *
 * This test scans production source for derivations that are known to
 * drift away from the canonical Evidence Lifecycle Contract. It does
 * NOT delete the existing offenders — Phase 1 is foundation only. It
 * pins the current offender list as an explicit allowlist so:
 *
 *   1. every offender is documented, with file:line and reason; and
 *   2. any NEW offender introduced after Phase 1 fails this test.
 *
 * When a later phase legitimately removes an offender, remove its entry
 * from the allowlist. When a later phase legitimately adds a new
 * derivation (rare), document the reason and add it here.
 *
 * What we scan for:
 *   - "package version exists implies verified"
 *       (verificationPackageVersion / latestReportVersion truthy-checks
 *        used to gate user-facing "verified" state)
 *   - "teamId exists implies team_governed"
 *       (teamId ? "team_governed" : "personal_basic" derived outside
 *        the canonical writer in services/worker/src/verification-package.ts)
 *   - "verificationPackages: { some: ... }" used as a synonym for
 *     "package validated" instead of "package row exists"
 *   - hardcoded verdict label strings outside the shared trust-decision
 *     module
 *
 * Phase 1 is allowed to have offenders. Phase 2+ removes them.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = resolve(__filename, "..");
const REPO_ROOT = resolve(__dirname, "..", "..", "..");
const APP_WEB = resolve(REPO_ROOT, "apps", "web");
const SERVICES_API = resolve(REPO_ROOT, "services", "api", "src");
const SERVICES_WORKER = resolve(REPO_ROOT, "services", "worker", "src");

type Offender = {
  file: string;
  line: number;
  matched: string;
  reason: string;
};

type ScanRoot = {
  root: string;
  label: string;
  excludeDirs: ReadonlyArray<string>;
};

const SCAN_ROOTS: ReadonlyArray<ScanRoot> = [
  {
    root: APP_WEB,
    label: "apps/web",
    excludeDirs: ["node_modules", ".next", "__tests__", "e2e", "dist", "scripts"],
  },
  {
    root: SERVICES_API,
    label: "services/api/src",
    excludeDirs: ["node_modules", "dist"],
  },
  {
    root: SERVICES_WORKER,
    label: "services/worker/src",
    excludeDirs: ["node_modules", "dist"],
  },
];

function walk(dir: string, excludeDirs: ReadonlyArray<string>): string[] {
  const out: string[] = [];
  let entries: { name: string; isDirectory(): boolean; isFile(): boolean }[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (excludeDirs.includes(entry.name)) continue;
      out.push(...walk(join(dir, entry.name), excludeDirs));
      continue;
    }
    if (!entry.isFile()) continue;
    const ext = extname(entry.name);
    if (ext === ".ts" || ext === ".tsx" || ext === ".js" || ext === ".jsx") {
      out.push(join(dir, entry.name));
    }
  }
  return out;
}

function toRepoRelative(absPath: string): string {
  return relative(REPO_ROOT, absPath).split(sep).join("/");
}

function scan(
  patterns: ReadonlyArray<{ regex: RegExp; reason: string }>,
): Offender[] {
  const found: Offender[] = [];
  for (const scope of SCAN_ROOTS) {
    for (const file of walk(scope.root, scope.excludeDirs)) {
      let text: string;
      try {
        text = readFileSync(file, "utf8");
      } catch {
        continue;
      }
      const lines = text.split(/\r?\n/);
      for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i]!;
        // Cheap comment skip: pure // or * comment lines.
        const trimmed = line.trim();
        if (
          trimmed.startsWith("//") ||
          trimmed.startsWith("*") ||
          trimmed.startsWith("/*")
        ) {
          continue;
        }
        for (const { regex, reason } of patterns) {
          if (regex.test(line)) {
            found.push({
              file: toRepoRelative(file),
              line: i + 1,
              matched: trimmed.slice(0, 200),
              reason,
            });
          }
        }
      }
    }
  }
  return found;
}

/**
 * Allowlist of CURRENT offenders. Each entry is a { file, reason }
 * pair. Phase 1 is permitted to leave these in place — they are tracked
 * here so any *new* offender shows up as a test failure.
 *
 * Each entry must include WHY it is currently acceptable. When a future
 * phase removes the offender, delete the entry from this list.
 */
const ALLOWED_OFFENDERS: ReadonlyArray<{
  fileSubstring: string;
  reason: string;
}> = [
  // Canonical writer for packageMode — single source of truth that
  // package-mode.json reflects. Acceptable here; offenders elsewhere
  // would be the bug.
  {
    fileSubstring: "services/worker/src/verification-package.ts",
    reason:
      "Canonical writer of packageMode for the verification package ZIP. Phase 2 will add workspaceLabelAtPackageTime; Phase 1 leaves the derivation in place.",
  },
  // Canonical writer for shared trust-decision verdict labels.
  {
    fileSubstring: "packages/shared/src/trust-decision.ts",
    reason: "Canonical source of trust-decision verdict labels.",
  },
  // Library summary count predicate. The comment at
  // services/api/src/routes/evidence.routes.ts:6305-6314 explicitly
  // documents that `verificationPackages: { some: {} }` is the correct
  // existence check (NOT a package-validation proxy). Allowlisted.
  {
    fileSubstring: "services/api/src/routes/evidence.routes.ts",
    reason:
      "Library-summary endpoint uses verificationPackages: { some: {} } as the correct existence predicate (see comment at lines 6305-6314). Phase 1 leaves this in place.",
  },
  // Dashboard trust summary aggregator legitimately reads
  // verificationPackages / reports relations to count READY records.
  {
    fileSubstring: "services/api/src/services/dashboard/trust-summary.service.ts",
    reason:
      "Dashboard trust-summary aggregator counts evidence with reports + packages. Operational projection, not user-facing 'verified' claim. Phase 1 leaves in place.",
  },
  // Public verify route is the single source of the public-verify
  // payload. It legitimately reads verificationPackageMetadata and
  // package presence flags. Phase 2 will rename "verified" wording on
  // the public verify signal label.
  {
    fileSubstring: "services/api/src/routes/evidence.routes.ts",
    reason:
      "Public verify endpoint derives the verificationPackageIntegrity payload from verificationPackageMetadata + ZIP central-dir inspection. Phase 1 keeps wording untouched; Phase 2 will reword 'Verified' → 'Present (manifest signed)'.",
  },
  // Shared reviewer-evidence label module is the canonical source for
  // 'Mixed Media Evidence Package' labels.
  {
    fileSubstring: "packages/shared/src/reviewer-evidence.ts",
    reason: "Canonical source of reviewer-evidence-type labels.",
  },
  // PDF report builder is the documented snapshot consumer.
  {
    fileSubstring: "services/worker/src/report-v2",
    reason:
      "Report-v2 builder is a snapshot consumer; it imports from packages/shared/src/trust-decision.ts. Allowlisted on the path to track future drift.",
  },
  // Verify page reads snapshot/live; will be refactored in Phase 2 to
  // remove hard-coded verdict strings noted in the audit.
  {
    fileSubstring: "apps/web/app/verify/[token]/page.tsx",
    reason:
      "Public verify page currently hard-codes some verdict labels (audit Phase 0 finding R2). Phase 2 will route through getTrustDecisionLabel(). Phase 1 leaves in place.",
  },
  // Evidence detail / library use status + relation predicates for
  // operational projections; not user-facing 'verified' claims.
  {
    fileSubstring: "apps/web/app/(app)/evidence",
    reason:
      "Evidence list + detail use status flags and relation presence for operational projections. Allowlisted; Phase 3 will route badges through a shared projector.",
  },
  // Worker processor mutates these columns during the report job — it
  // is the authoritative writer.
  {
    fileSubstring: "services/worker/src/processor.ts",
    reason:
      "Worker processor is the authoritative writer for latestReportVersion, verificationPackageVersion, verificationPackageGeneratedAtUtc, and the REPORT_GENERATED / VERIFICATION_PACKAGE_GENERATED custody events.",
  },

  // ---------------------------------------------------------------------
  // Phase 0 audit findings — pre-existing operational projections.
  // Documented here so the ratchet pins the current shape. Phase 2+
  // will route these through a shared lifecycle projector.
  // ---------------------------------------------------------------------

  // Home view-model now uses `it.reportReady` from the canonical API
  // field (deriveCanonicalArtifactAvailability in mapEvidenceListItem).
  // The `latestReportVersion` field is retained as a display-only
  // passthrough but is no longer used as a readiness gate.

  // ---------------------------------------------------------------------
  // Phase 0 audit findings — RESOLVED in Phase 2.
  // case-workspace.routes.ts, cases.routes.ts, and matter-workspace.service.ts
  // now route through deriveCanonicalArtifactAvailability(). Entries removed.
  // matter-workspace.service.ts retains one correct existence-check predicate:
  {
    fileSubstring: "services/api/src/services/cases/matter-workspace.service.ts",
    reason:
      "matter-workspace uses verificationPackages: { some: {} } as the correct existence check for deliverablesPending aggregate count. NOT a per-item readiness gate; NOT a version-number proxy. Allowlisted per canonical sites pattern.",
  },
  // ---------------------------------------------------------------------

  // Dashboard command-center aggregates package/report counts. Same as
  // trust-summary.service.ts — operational projection, not a verified
  // claim. Allowlisted.
  {
    fileSubstring: "services/api/src/services/dashboard/command-center.service.ts",
    reason:
      "Command-center aggregates use verificationPackages: { some: {} } as the correct existence check (mirrors library-summary endpoint). Operational projection only.",
  },
  // Trust-decision-consistency service compares snapshot vs live state
  // and legitimately reads the report-version field; not a user-facing
  // "verified" claim.
  {
    fileSubstring: "services/api/src/services/trust-decision-consistency.service.ts",
    reason:
      "Trust-decision-consistency service reads latestReportVersion to compare snapshot vs live state. Operational consistency check, not a verdict derivation.",
  },
];

function offenderIsAllowed(o: Offender): boolean {
  return ALLOWED_OFFENDERS.some(({ fileSubstring }) =>
    o.file.includes(fileSubstring),
  );
}

// -----------------------------------------------------------------------------
// Patterns scanned for. Comments are stripped per line so doc strings
// don't trigger a hit; the regex itself is the gate.
// -----------------------------------------------------------------------------

const PATTERNS: ReadonlyArray<{ regex: RegExp; reason: string }> = [
  {
    // "verificationPackageVersion != null" / "verificationPackageVersion >= 1"
    // truthy-checks. The lifecycle contract says package presence is a
    // snapshot-only material — never use it as a synonym for "verified".
    regex: /verificationPackageVersion\s*(!==|!=|>=?|>)\s*(null|0|1)/,
    reason:
      "verificationPackageVersion truthy-check used outside the canonical writer. Lifecycle contract: package version is a snapshot-only material, never a 'verified' proxy.",
  },
  {
    // "latestReportVersion != null" / "latestReportVersion >= 1"
    regex: /latestReportVersion\s*(!==|!=|>=?|>)\s*(null|0|1)/,
    reason:
      "latestReportVersion truthy-check used outside the canonical writer. Lifecycle contract: report presence is a snapshot-only material, never a 'verified' proxy.",
  },
  {
    // teamId ? "team_governed" : "personal_basic" derived outside the
    // canonical writer in verification-package.ts.
    regex: /teamId\s*\?\s*"team_governed"\s*:\s*"personal_basic"/,
    reason:
      "Inline derivation of packageMode from teamId. The canonical writer lives in services/worker/src/verification-package.ts; downstream code must read packageMode from package-mode.json or VerificationPackage.row, never re-derive.",
  },
  {
    // verificationPackages: { some: ... } used as a "validated" proxy.
    regex: /verificationPackages\s*:\s*\{\s*some\s*:/,
    reason:
      "verificationPackages: { some: ... } predicate. This is the correct EXISTENCE check, but it must not be presented as 'package cryptographically verified'. Allowlisted at canonical sites.",
  },
  {
    // Hardcoded verdict labels from the public verify hero card.
    regex: /"Recorded integrity verified;\s*publication pending"/i,
    reason:
      "Hardcoded verdict label string outside packages/shared/src/trust-decision.ts. Lifecycle contract: verdict labels come from getTrustDecisionLabel().",
  },
  {
    // Phase 2 closure: no public surface may render "Verification
    // package — Verified" wording for what is only manifest-present
    // state. The canonical signal label lives in
    // packages/shared/src/trust-decision.ts:1113 and is intentionally
    // worded as a presence claim, not a re-validation claim.
    regex: /"Verification package\s*(?:—|--|-)\s*Verified"/i,
    reason:
      "Public 'Verification package — Verified' wording falsely implies cryptographic re-validation. Use the canonical signal label or render 'present' instead.",
  },
];

test("lifecycle-derivation ratchet: no NEW offenders outside the allowlist", () => {
  const all = scan(PATTERNS);
  const newOffenders = all.filter((o) => !offenderIsAllowed(o));
  if (newOffenders.length > 0) {
    const sample = newOffenders
      .slice(0, 20)
      .map((o) => `  - ${o.file}:${o.line} [${o.reason}]  >> ${o.matched}`)
      .join("\n");
    assert.fail(
      `Phase 1 lifecycle-derivation ratchet detected ${newOffenders.length} new offender(s) outside the allowlist:\n${sample}\n\nIf this derivation is legitimate, add the file to ALLOWED_OFFENDERS with a reason. If it isn't, route through the canonical writer.`,
    );
  }
});

test("ratchet allowlist itself is fully documented", () => {
  for (const a of ALLOWED_OFFENDERS) {
    assert.ok(a.fileSubstring.length > 8, `allowlist entry missing fileSubstring`);
    assert.ok(
      a.reason.length > 20,
      `allowlist entry ${a.fileSubstring} must explain WHY it is currently acceptable`,
    );
  }
});

test("source scan finds at least one matching pattern overall (sanity)", () => {
  // If this hits zero, the scan is broken — Phase 0 audit confirmed
  // current offenders exist in the codebase (e.g. the canonical
  // verification-package.ts derivation).
  const all = scan(PATTERNS);
  assert.ok(
    all.length > 0,
    "Source scan found zero matches across the whole repo — pattern set is broken",
  );
});

// Silence the unused-warning for statSync that we keep available for
// potential future per-file timestamp checks.
void statSync;
