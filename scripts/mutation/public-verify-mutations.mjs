#!/usr/bin/env node
/**
 * PUBLIC VERIFY CONVERGENCE — MUTATION SUITE (2026-10-18).
 *
 *   node scripts/mutation/public-verify-mutations.mjs [--only=1,7,12] [--skip-integration]
 *
 * Each mutation re-introduces one defect the convergence removed. It is applied
 * to the source (exactly one textual match is required — a missing anchor fails
 * the suite rather than passing silently), the named tests run, and the source
 * is ALWAYS restored (and the shared package rebuilt when it was mutated). A
 * mutation is KILLED when its tests fail. The suite exits 1 when any mutation
 * survives or any anchor is missing.
 *
 * Integration mutations need the API integration infrastructure (testcontainers
 * Postgres, Redis on P7_TEST_REDIS_URL, MinIO on P7_HOST_S3_PORT); with
 * --skip-integration they are reported as SKIPPED (never as killed).
 */
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PLACEHOLDER_DB = "postgresql://placeholder:placeholder@127.0.0.1:1/placeholder_test";

const API_UNIT = (file) => ({ cwd: "services/api", cmd: "npx", args: ["vitest", "run", file], env: { DATABASE_URL: PLACEHOLDER_DB } });
const API_INTEGRATION = (pattern) => ({
  cwd: "services/api",
  cmd: "npx",
  args: ["vitest", "run", "--config", "vitest.integration.config.ts", "test/public-verify-disclosure.integration.test.ts", "-t", pattern],
  integration: true,
});
const SHARED = (...files) => ({ cwd: "packages/shared", cmd: "node", args: ["--test", ...files.map((f) => `tests/${f}`)] });
const WEB_RENDER = (file) => ({ cwd: "apps/web", cmd: "npx", args: ["vitest", "run", "--config", "vitest.render.config.ts", file] });
const MOBILE = (file) => ({ cwd: "apps/mobile", cmd: "node", args: ["--test", file] });

const PROJECTION = "services/api/src/services/public-verify/public-verify-projection.ts";

export const MUTATIONS = [
  {
    id: 1,
    name: "restore the storage-key / original-name label on a VERIFICATION_ONLY item",
    file: PROJECTION,
    find: `      label: genericItemLabel(index),\n      previewable: false,`,
    replace: `      label: typeof item.label === "string" ? item.label : genericItemLabel(index),\n      previewable: false,`,
    tests: [API_UNIT("test/public-verify-authority.test.ts")],
  },
  {
    id: 2,
    name: "restore the masked email in public custody summaries",
    file: PROJECTION,
    find: `      payloadSummary:\n        d.mode === "VERIFICATION_ONLY"`,
    replace: `      payloadSummary: e.payloadSummary ?? null,\n      _unused:\n        d.mode === "VERIFICATION_ONLY"`,
    tests: [API_UNIT("test/public-verify-authority.test.ts")],
  },
  {
    id: 3,
    name: "return coordinates while location is hidden",
    file: PROJECTION,
    find: `  out.captureContext = d.recordedLocation ? full.captureContext ?? null : null;`,
    replace: `  out.captureContext = full.captureContext ?? null;`,
    tests: [API_UNIT("test/public-verify-authority.test.ts")],
  },
  {
    id: 4,
    name: "return the access chronology on a VERIFICATION_ONLY page",
    file: PROJECTION,
    find: `    accessEvents: [],\n    accessActivity:`,
    replace: `    accessEvents: access,\n    accessActivity:`,
    tests: [API_UNIT("test/public-verify-authority.test.ts")],
  },
  {
    id: 5,
    name: "drop sealCheck in the web package card",
    file: "apps/web/app/verify/[token]/VerificationPackageIntegrityCard.tsx",
    find: "__WEB_SEAL_ANCHOR__",
    replace: "",
    tests: [WEB_RENDER("__tests__/render/public-verify-page-convergence.render.test.tsx")],
  },
  {
    id: 6,
    name: "drop sealCheck in the mobile package card",
    file: "apps/mobile/src/product/public-verify.ts",
    find: "__MOBILE_SEAL_ANCHOR__",
    replace: "",
    tests: [MOBILE("test/public-verify-convergence.test.mjs")],
  },
  {
    id: 7,
    name: "compare wording in the snapshot comparison",
    file: "packages/shared/src/snapshot-comparison.ts",
    find: `  const before = comparableSignalOf(atIssue);\n  const after = comparableSignalOf(now);`,
    replace: `  if ((atIssue?.summary ?? "") !== (now?.summary ?? "")) return "CHANGED";\n  const before = comparableSignalOf(atIssue);\n  const after = comparableSignalOf(now);`,
    rebuild: "shared",
    tests: [SHARED("public-verify-convergence.test.mjs"), API_UNIT("test/public-verify-authority.test.ts")],
  },
  {
    id: 8,
    name: "count reference issuance as a forensic change",
    file: "packages/shared/src/custody.ts",
    find: `  return isForensicCustodyEventType(eventType) && !isAdministrativeCustodyEventType(eventType);`,
    replace: `  return isForensicCustodyEventType(eventType);`,
    rebuild: "shared",
    tests: [SHARED("public-verify-convergence.test.mjs")],
  },
  {
    id: 9,
    name: "return UNAVAILABLE for a legacy snapshot without otsState",
    file: "packages/shared/src/snapshot-comparison.ts",
    find: `  const comparable = comparableSignalOf(bitcoin);\n  if (comparable?.otsVerification) {`,
    replace: `  const comparable = comparableSignalOf(bitcoin);\n  if (comparable?.otsVerification && false) {`,
    rebuild: "shared",
    tests: [SHARED("public-verify-convergence.test.mjs"), API_UNIT("test/public-verify-authority.test.ts")],
  },
  {
    id: 10,
    name: "omit the otsChain* facts from the live decision",
    file: "services/api/src/routes/evidence.routes.ts",
    find: `    otsChainVerificationStatus: evidence.otsChainVerificationStatus ?? null,\n    otsChainCheckedAtUtc: evidence.otsChainCheckedAtUtc ?? null,`,
    replace: `    otsChainVerificationStatus: null,\n    otsChainCheckedAtUtc: evidence.otsChainCheckedAtUtc ?? null,`,
    tests: [API_INTEGRATION("C5 ")],
  },
  {
    id: 11,
    name: "treat an ANCHORED attestation as independently verified",
    file: "packages/shared/src/trust-signal-state.ts",
    find: `  ATTESTATION_RECORDED: "PRESENT_NOT_INDEPENDENTLY_VERIFIED",\n  CHAIN_CONFIRMATIONS_PENDING: "PENDING",`,
    replace: `  ATTESTATION_RECORDED: "PASSED",\n  CHAIN_CONFIRMATIONS_PENDING: "PENDING",`,
    rebuild: "shared",
    tests: [SHARED("verification-matrix.test.mjs", "trust-signal-state.test.mjs")],
  },
  {
    id: 12,
    name: "treat a GRANTED timestamp word as unconditional success",
    file: "packages/shared/src/trust-signal-state.ts",
    find: `  if (status === "STAMPED") {`,
    replace: `  if (status === "STAMPED" || status === "GRANTED") {`,
    rebuild: "shared",
    tests: [SHARED("trust-signal-state.test.mjs", "verification-matrix.test.mjs", "public-verify-one-fact-authority.test.mjs")],
  },
  {
    id: 13,
    name: "run a write side effect before the access decision",
    file: "services/api/src/routes/evidence.routes.ts",
    find: `    if (canonical.status !== "AVAILABLE") {`,
    replace: `    await prisma.verificationView.create({ data: { evidenceId: id, viewerType: VerificationViewerType.PUBLIC, viewerUserId: null, accessMode: "public_verify", ipAddress: null, userAgent: null } });\n    if (canonical.status !== "AVAILABLE") {`,
    tests: [API_UNIT("test/public-verify-authority.test.ts"), API_INTEGRATION("A1 ")],
  },
  {
    id: 14,
    name: "re-enable an old public_verify_state writer",
    file: "services/api/src/services/evidence-complete.service.ts",
    find: `        data: finalizeData,`,
    replace: `        data: { ...finalizeData, publicVerifyState: "NOT_PUBLISHED" },`,
    tests: [API_UNIT("test/public-verify-authority.test.ts")],
  },
  {
    id: 15,
    name: "let a client choose the disclosure",
    file: "services/api/src/routes/evidence.routes.ts",
    find: `    const recordDisclosurePolicy = parseVerificationDisclosurePolicy(evidence);`,
    replace: `    const recordDisclosurePolicy = parseVerificationDisclosurePolicy({ verificationDisclosureMode: (req.query as { disclosure?: string }).disclosure ?? evidence.verificationDisclosureMode, showRecordedLocation: evidence.showRecordedLocation });`,
    tests: [API_INTEGRATION("C0 ")],
  },
  {
    id: 16,
    name: "permit original download from a plain pvr_",
    file: PROJECTION,
    find: `    source: "RECORD_POLICY",\n    originalDownload: false,`,
    replace: `    source: "RECORD_POLICY",\n    originalDownload: input.recordPolicy.mode === "CONTENT_PREVIEW",`,
    tests: [API_UNIT("test/public-verify-authority.test.ts")],
  },
];

/**
 * The child environment is an ALLOWLIST: the platform variables a toolchain
 * needs and the disposable-infrastructure test variables — never the ambient
 * credentials (no DATABASE_URL, S3, signing or provider secrets leak in).
 */
const CHILD_ENV_ALLOW = /^(PATH|Path|PATHEXT|SystemRoot|SYSTEMROOT|windir|ComSpec|HOME|USERPROFILE|APPDATA|LOCALAPPDATA|TEMP|TMP|TMPDIR|HOMEDRIVE|HOMEPATH|PROGRAMFILES|ProgramFiles|ProgramData|CommonProgramFiles|NUMBER_OF_PROCESSORS|PROCESSOR_ARCHITECTURE|OS|LANG|TERM|CI|DOCKER_HOST|TESTCONTAINERS_.*|P7_.*|PNPM_HOME|npm_config_.*)$/;
function childEnv(extra) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => CHILD_ENV_ALLOW.test(k)));
  return Object.assign(env, extra);
}

function run(t) {
  const r = spawnSync(t.cmd, t.args, {
    cwd: join(ROOT, t.cwd),
    encoding: "utf8",
    shell: process.platform === "win32",
    env: childEnv(t.env ?? {}),
    maxBuffer: 64 * 1024 * 1024,
  });
  return r.status;
}

const baselines = new Map();
function baselineStatus(t) {
  const key = JSON.stringify([t.cwd, t.args]);
  if (!baselines.has(key)) baselines.set(key, run(t));
  return baselines.get(key);
}

function rebuildShared() {
  const r = spawnSync("pnpm", ["build"], { cwd: join(ROOT, "packages/shared"), encoding: "utf8", shell: process.platform === "win32" });
  if (r.status !== 0) throw new Error(`shared build failed:\n${r.stdout}\n${r.stderr}`);
}

function main() {
  const onlyArg = process.argv.find((a) => a.startsWith("--only="));
  const only = onlyArg ? new Set(onlyArg.slice(7).split(",").map(Number)) : null;
  const skipIntegration = process.argv.includes("--skip-integration");
  const results = [];
  for (const m of MUTATIONS) {
    if (only && !only.has(m.id)) continue;
    const path = join(ROOT, m.file);
    let original;
    try {
      original = readFileSync(path, "utf8");
    } catch {
      results.push({ id: m.id, name: m.name, outcome: "ANCHOR_MISSING (file)" });
      continue;
    }
    const count = original.split(m.find).length - 1;
    if (count !== 1) {
      results.push({ id: m.id, name: m.name, outcome: `ANCHOR_MISSING (${count} matches)` });
      continue;
    }
    const runnable = m.tests.filter((t) => !(skipIntegration && t.integration));
    if (runnable.length === 0) {
      results.push({ id: m.id, name: m.name, outcome: "SKIPPED (integration)" });
      continue;
    }
    // A kill only counts against a GREEN baseline: tests that already fail kill nothing.
    const red = runnable.find((t) => baselineStatus(t) !== 0);
    if (red) {
      results.push({ id: m.id, name: m.name, outcome: `BASELINE_RED (${red.cwd}: ${red.args.slice(-1)[0]})` });
      console.log(`[mutation ${m.id}] BASELINE_RED — ${m.name}`);
      continue;
    }
    let killedBy = null;
    try {
      writeFileSync(path, original.replace(m.find, () => m.replace));
      if (m.rebuild === "shared") rebuildShared();
      for (const t of runnable) {
        if (run(t) !== 0) {
          killedBy = `${t.cwd}: ${t.args.filter((a) => !a.startsWith("--")).slice(-2).join(" ")}`;
          break;
        }
      }
    } finally {
      writeFileSync(path, original);
      if (m.rebuild === "shared") rebuildShared();
    }
    results.push({ id: m.id, name: m.name, outcome: killedBy ? "KILLED" : "SURVIVED", killedBy });
    console.log(`[mutation ${m.id}] ${killedBy ? "KILLED" : "SURVIVED"} — ${m.name}${killedBy ? ` (${killedBy})` : ""}`);
  }
  console.log(JSON.stringify(results, null, 2));
  const bad = results.filter((r) => r.outcome !== "KILLED" && !r.outcome.startsWith("SKIPPED"));
  process.exitCode = bad.length > 0 ? 1 : 0;
}

main();
