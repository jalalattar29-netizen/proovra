/**
 * PHASE 12 — POINT 8, STEP 0 (5-6): identify the release candidate.
 *
 * Point 7 recorded a build id that was supplied from OUTSIDE the repository
 * (`POINT7_BUILD_ID`), so it could not be recomputed later and could not be
 * checked against the tree it claimed to describe. Point 8 has to reject
 * "mixed build IDs" (Step 5, rejection 3), which is only meaningful if a build
 * id is DERIVED from the thing it identifies.
 *
 * So each service's build id here is a content digest over its own sources:
 * the same tree always produces the same id, a changed tree never does, and
 * the three ids can be compared to prove one artifact was under test.
 *
 * Nothing here connects to anything. It reads files and hashes them.
 */
import { createHash } from "node:crypto";
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { execFileSync } from "node:child_process";

const REPO = resolve(new URL("../../../..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));

const SKIP = new Set(["node_modules", ".next", "dist", ".turbo", "coverage", ".git"]);

function* walk(dir) {
  if (!existsSync(dir)) return;
  if (!statSync(dir).isDirectory()) {
    // A root may name a single file (schema.prisma, package.json).
    yield dir;
    return;
  }
  for (const name of readdirSync(dir).sort()) {
    if (SKIP.has(name)) continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) yield* walk(p);
    else yield p;
  }
}

/** Digest a set of roots. Line endings are normalised so the id is stable across platforms. */
function digestRoots(roots) {
  const h = createHash("sha256");
  let files = 0;
  for (const root of roots) {
    for (const file of walk(resolve(REPO, root))) {
      const rel = relative(REPO, file).replace(/\\/g, "/");
      h.update(rel);
      h.update("\0");
      h.update(readFileSync(file, "utf8").replace(/\r\n/g, "\n"));
      h.update("\0");
      files += 1;
    }
  }
  return { digest: h.digest("hex"), files };
}

function git(...args) {
  try {
    return execFileSync("git", args, { cwd: REPO, encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

const api = digestRoots([
  "services/api/src",
  "services/api/prisma/schema.prisma",
  "services/api/package.json",
]);
const worker = digestRoots(["services/worker/src", "services/worker/package.json"]);
const web = digestRoots(["apps/web/app", "apps/web/components", "apps/web/lib", "apps/web/package.json"]);
const shared = digestRoots(["packages"]);

/** Migration directories present on disk, and which of them git would ship. */
function migrationDisposition() {
  const dir = resolve(REPO, "services/api/prisma/migrations");
  const onDisk = existsSync(dir)
    ? readdirSync(dir).filter((d) => existsSync(join(dir, d, "migration.sql"))).sort()
    : [];
  const tracked = new Set(
    (git("ls-files", "services/api/prisma/migrations") ?? "")
      .split("\n")
      .filter(Boolean)
      .map((p) => p.split("/")[4])
      .filter(Boolean),
  );
  return {
    onDisk: onDisk.length,
    trackedInHead: onDisk.filter((d) => tracked.has(d)).length,
    untracked: onDisk.filter((d) => !tracked.has(d)),
  };
}

const rc = {
  point8Step: "0.5-0.6 release-candidate identification",
  gitCommit: git("rev-parse", "HEAD"),
  gitBranch: git("rev-parse", "--abbrev-ref", "HEAD"),
  gitTreeClean: (git("status", "--porcelain") ?? "x") === "",
  uncommittedEntries: (git("status", "--porcelain") ?? "").split("\n").filter(Boolean).length,
  apiBuildId: api.digest,
  apiSourceFiles: api.files,
  workerBuildId: worker.digest,
  workerSourceFiles: worker.files,
  webBuildId: web.digest,
  webSourceFiles: web.files,
  sharedPackagesDigest: shared.digest,
  // The composite is what a manifest cites. Three services built from one tree
  // share it; a manifest mixing runs cannot.
  releaseCandidateId: createHash("sha256")
    .update([api.digest, worker.digest, web.digest, shared.digest].join(":"))
    .digest("hex"),
  nextBuildIdOnDisk: existsSync(resolve(REPO, "apps/web/.next/BUILD_ID"))
    ? readFileSync(resolve(REPO, "apps/web/.next/BUILD_ID"), "utf8").trim()
    : null,
  migrations: migrationDisposition(),
};

console.log(JSON.stringify(rc, null, 2));
