/**
 * PHASE 1 §1 — THE EXACT BASELINE.
 *
 * Phase 0 carried a limitation forward and had to say so twice: no artifact
 * recorded the working tree at the instant that phase began, so a path changed
 * relative to HEAD could not be attributed to the pass rather than to work that
 * predated it. Every counter about "what Phase 0 touched" had to be proven the
 * long way round — by showing that no production file bore any trace of it —
 * because the direct question was unanswerable.
 *
 * This closes that for Phase 1 before a single edit is made. It records the
 * SHA-256 of EVERY file in the tree, tracked and untracked alike, plus the
 * porcelain=v2 status, HEAD, branch and the hashes of the canonical artifacts.
 * A later pass can then diff the tree against this and get a real answer
 * instead of an argument.
 *
 * NAMES AND DIGESTS ONLY. No file contents are copied, so nothing sensitive
 * transits it — and it is written OUTSIDE the repository, because a baseline
 * stored inside the thing it describes is not a baseline.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import path from "node:path";

import { REPO, CANONICAL, DIAGNOSTICS } from "./registry.mjs";

const SKIP_DIR = /^(node_modules|\.git|\.next|dist|build|coverage|\.turbo|\.expo)$/;

const git = (...args) =>
  execFileSync("git", args, { cwd: REPO, encoding: "utf8", maxBuffer: 1 << 28 });

const sha256File = (abs) => {
  try {
    return createHash("sha256").update(readFileSync(abs)).digest("hex");
  } catch {
    return null;
  }
};

function walk(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (SKIP_DIR.test(e.name)) continue;
      walk(p, out);
    } else if (e.isFile()) {
      out.push(p);
    }
  }
  return out;
}

/** Hash of a canonical artifact, or null when it is absent. */
const artifactHash = (rel) => {
  const abs = path.join(REPO, rel);
  return existsSync(abs) ? sha256File(abs) : null;
};

/** Run/build identifiers a proof artifact binds itself to. */
function proofBindings(rel) {
  const abs = path.join(REPO, rel);
  if (!existsSync(abs)) return null;
  let json;
  try {
    json = JSON.parse(readFileSync(abs, "utf8"));
  } catch {
    return null;
  }
  const suites = json?.suites && typeof json.suites === "object" ? json.suites : {};
  const ids = new Set();
  for (const s of Object.values(suites)) {
    for (const k of ["runId", "buildId", "nextBuildId"]) {
      if (typeof s?.[k] === "string" && s[k].length > 0) ids.add(`${k}=${s[k]}`);
    }
  }
  return {
    path: rel,
    contentHash: artifactHash(rel),
    suiteCount: Object.keys(suites).length,
    bindings: [...ids].sort(),
  };
}

export function buildBaseline() {
  const files = walk(REPO).map((abs) => {
    const rel = path.relative(REPO, abs).split(path.sep).join("/");
    return { path: rel, bytes: statSync(abs).size, sha256: sha256File(abs) };
  });

  const porcelain = git("status", "--porcelain=v2", "--branch", "--untracked-files=all");
  const statusEntries = porcelain
    .split("\n")
    .filter((l) => l && !l.startsWith("#"))
    .map((l) => {
      // v2 formats: `1 XY ...`, `2 XY ...` (rename), `? path`, `u ...`
      if (l.startsWith("? ")) return { state: "UNTRACKED", path: l.slice(2) };
      if (l.startsWith("u ")) return { state: "UNMERGED", path: l.split(" ").pop() };
      const parts = l.split(" ");
      const xy = parts[1];
      const rest = l.slice(l.indexOf("\t") >= 0 ? l.indexOf("\t") + 1 : 0);
      const p = l.startsWith("2 ") ? rest.split("\t")[0] : parts.slice(8).join(" ");
      const staged = xy[0] !== ".";
      const unstaged = xy[1] !== ".";
      return {
        state: staged && unstaged ? "STAGED_AND_UNSTAGED" : staged ? "STAGED" : "UNSTAGED",
        xy,
        path: p,
      };
    });

  let ahead = null;
  let behind = null;
  let originMain = null;
  try {
    originMain = git("rev-parse", "origin/main").trim();
    const [b, a] = git("rev-list", "--left-right", "--count", "origin/main...HEAD")
      .trim()
      .split(/\s+/)
      .map(Number);
    behind = b;
    ahead = a;
  } catch {
    /* no remote — recorded as null, never guessed */
  }

  const hashFailures = files.filter((f) => f.sha256 === null).map((f) => f.path);

  return {
    schemaVersion: "phase1-baseline@1",
    generatedBy: "services/api/scripts/audit/engine/baseline.mjs",
    note:
      "EXACT pre-Phase-1 baseline. Names, sizes and SHA-256 digests only — no file contents. " +
      "Written outside the repository so it survives anything done inside it.",
    frozenAtUtc: new Date().toISOString(),
    branch: git("rev-parse", "--abbrev-ref", "HEAD").trim(),
    head: git("rev-parse", "HEAD").trim(),
    sourceRevision: git("rev-parse", "HEAD").trim(),
    originMain,
    ahead,
    behind,
    fileCount: files.length,
    totalBytes: files.reduce((a, f) => a + f.bytes, 0),
    hashFailures,
    statusEntryCount: statusEntries.length,
    status: statusEntries,
    canonicalArtifacts: {
      capabilityMap: artifactHash(CANONICAL.capabilityMap.path),
      ledgerRows: artifactHash(CANONICAL.findingsLedger.rows),
      ledgerJson: artifactHash(CANONICAL.findingsLedger.derived[0]),
      ledgerMd: artifactHash(CANONICAL.findingsLedger.derived[1]),
      architectureFacts: artifactHash(CANONICAL.currentFacts.path),
      governanceInventory: artifactHash(CANONICAL.governanceInventory.path),
      currentReport: artifactHash(CANONICAL.currentReport.path),
      diagnostics: DIAGNOSTICS.map((d) => ({ path: d.path, sha256: artifactHash(d.path) })),
    },
    engineComponents: CANONICAL.engineComponents.map((p) => ({
      path: p,
      sha256: artifactHash(p),
    })),
    domainProofs: [
      proofBindings("docs/architecture/point5-family-proven-cases.json"),
      proofBindings("docs/architecture/point7-proven-scenarios.json"),
    ].filter(Boolean),
    files,
  };
}
