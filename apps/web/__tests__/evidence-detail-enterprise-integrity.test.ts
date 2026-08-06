import { strict as assert } from "node:assert";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Phase EVIDENCE-IA-DECOMPOSE — the Evidence Detail page used to be
// a 3,614-line monolith inside `page.tsx`. It is now decomposed into:
//   - page.tsx                  — orchestrator (state, hero, modals)
//   - _tabs/_lib.tsx            — shared helpers + ctx type
//   - _tabs/Evidence{...}Tab.tsx — one file per tab body
// All of this directory is the "Evidence Detail page" — the canonical
// helpers + copy may live in any of these files. Scan the whole
// directory tree so source-shape assertions don't break on the
// next mechanical reshuffle.
const EVIDENCE_DETAIL_DIR = resolve(__dirname, "../app/(app)/evidence/[id]");

function readDirRecursive(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      out.push(...readDirRecursive(full));
    } else if (full.endsWith(".tsx") || full.endsWith(".ts")) {
      out.push(full);
    }
  }
  return out;
}

const SRC = readDirRecursive(EVIDENCE_DETAIL_DIR)
  .map((p) => readFileSync(p, "utf8"))
  .join("\n\n/* --- file boundary --- */\n\n");

test("published verification url helper gates on PUBLISHED state", () => {
  assert.match(SRC, /function buildPublishedVerificationUrl/);
  assert.match(SRC, /summary\.state !== "PUBLISHED"/);
  assert.match(SRC, /disabled=\{isIntegrityFailed \|\| !shareUrl\}/);
});

test("public verification copy comes from canonical state mapping", () => {
  assert.match(SRC, /function describePublicVerificationState/);
  assert.match(SRC, /Configured but not published/);
  assert.match(SRC, /Not included on plan/);
  assert.match(SRC, /Suspended/);
  assert.match(SRC, /Unpublished/);
});

test("client signal wording distinguishes missing, false, detected, and unavailable", () => {
  assert.match(SRC, /Client signal not collected/);
  assert.match(SRC, /Collected: no signal detected/);
  assert.match(SRC, /Signal detected/);
  assert.match(SRC, /Unavailable for this evidence type/);
  assert.match(SRC, /Screenshot filename heuristic/);
});

test("artifact rendering uses canonical report and package status helpers", () => {
  assert.match(SRC, /function describeReportArtifactStatus/);
  assert.match(SRC, /function describeVerificationPackageStatus/);
  assert.match(SRC, /function describeReportPdfSignature/);
  assert.match(SRC, /function describePackageManifestStatus/);
});

test("artifact polling is scoped to report and package readiness only", () => {
  assert.match(SRC, /function shouldPollArtifactReadiness/);
  assert.match(SRC, /status === "SIGNED" \|\| status === "REPORTED"/);
  // Phase CAPTURE-CLOSURE Part A — polling stops once a plan-gated
  // artifact is unreachable (workspaceCapabilitySnapshot.reportsIncluded /
  // verificationPackageIncluded === false). The predicate is now:
  //   reportNeedsRefresh = reportReachable && !workspace.artifactStatus.report.available
  // (and the symmetric form for the verification package).
  assert.match(
    SRC,
    /reportNeedsRefresh\s*=\s*\n?\s*reportReachable\s*&&\s*!workspace\.artifactStatus\.report\.available/,
  );
  assert.match(
    SRC,
    /!verificationPackage\.available &&\s*!verificationPackage\.blocked &&\s*!verificationPackage\.unavailable/
  );
  assert.equal((SRC.match(/setInterval\(/g) ?? []).length, 1);
});

test("OTS pending stays passive and uses manual one-shot refresh", () => {
  assert.match(SRC, /function isOtsTerminal/);
  assert.match(SRC, /Check latest status/);
  assert.match(SRC, /showManualLatestStatusCheck/);
  assert.doesNotMatch(SRC, /window\.location\.reload/);
  assert.doesNotMatch(SRC, /window\.setInterval/);
});

test("technical readiness wording is separated from workflow lifecycle", () => {
  // Phase EVIDENCE-IA — the "Technical Review Readiness" label was a
  // duplicate Overview panel that re-rendered the same readiness fact
  // the Review tab + the consolidated Record summary already carry.
  // It is gone as a visible label, but the canonical readiness
  // sentence ("Evidence is technically ready; no reviewer workflow
  // has started yet.") MUST still appear — it is the load-bearing
  // copy the Overview's reviewDecision card renders. And "Review
  // workflow" must still appear as a metadata label.
  assert.match(
    SRC,
    /Evidence is technically ready; no reviewer workflow has started yet\./,
  );
  assert.match(SRC, /Review workflow/);
});

// ============================================================================
// PHASE 12B (Evidence Operations, 2026-07-29) — Provenance chain.
//
// GET /v1/provenance/:evidenceId had no product consumer. It is now the
// canonical Provenance surface inside the Evidence detail Integrity tab.
// ============================================================================

test("Integrity tab mounts the canonical provenance-chain section", () => {
  assert.match(SRC, /EvidenceProvenanceChainSection/);
  assert.match(SRC, /<EvidenceProvenanceChainSection evidenceId=\{evidenceId\} \/>/);
});

test("provenance section reads the server projection and holds no client trust authority", () => {
  const panel = readFileSync(
    join(EVIDENCE_DETAIL_DIR, "_tabs/EvidenceProvenanceChainSection.tsx"),
    "utf8",
  );
  // Canonical client only; workspace scope is server-held (no teamId on
  // the wire) so the component cannot widen it.
  assert.match(panel, /apiFetch\(\s*`\/v1\/provenance\/\$\{encodeURIComponent\(evidenceId\)\}`/);
  assert.ok(!/teamId=/.test(panel));
  // Never render a projection for a different record.
  assert.match(panel, /chain\.evidenceId !== evidenceId/);
  // Full state coverage: loading / denial / error / ready.
  assert.match(panel, /data-evidence-provenance-loading/);
  assert.match(panel, /data-evidence-provenance-denied/);
  assert.match(panel, /data-evidence-provenance-error/);
  assert.match(panel, /data-evidence-provenance-body/);
  // Stale-context rejection + safe error copy + workspace re-key.
  assert.match(panel, /useTenantGuard/);
  assert.match(panel, /isStale\(captured\)/);
  assert.match(panel, /toSafeUserError/);
  assert.match(panel, /useActiveWorkspaceId/);
  // Standing limitations are always surfaced.
  assert.match(panel, /data-evidence-provenance-limitations/);
});
