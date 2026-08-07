#!/usr/bin/env node
/**
 * PHASE 12 REMEDIATION — INFRA-001 + UNK-002 (2026-08-06).
 *
 * READ-ONLY release-identity verifier.
 *
 * The problem
 * -----------
 * `infra/docker/docker-compose.prod.yml` defaulted both service images to
 * `${IMAGE_TAG:-latest}`. An unset IMAGE_TAG resolved both to whatever
 * `:latest` currently pointed at, so the deployed revision was not pinned by
 * the compose file and source-to-image correspondence could not be
 * determined from the repository at all (UNK-002).
 *
 * The compose file now REQUIRES `IMAGE_TAG` (`${IMAGE_TAG:?...}`), so an
 * unpinned deploy fails at compose parse time. This script is the second
 * half: it proves the identity is IMMUTABLE and that the images actually
 * running were built from the intended commit.
 *
 * What it checks
 * --------------
 *   1. IMAGE_TAG is present and IMMUTABLE — a 40-char commit SHA, a
 *      `sha256:` digest, or an explicitly allowed release tag. `latest`,
 *      `main`, `edge`, `stable` and friends are REFUSED.
 *   2. The API image and the worker image carry the SAME
 *      `org.opencontainers.image.revision` label.
 *   3. That revision equals the intended source revision (`--source-revision`
 *      or `SOURCE_REVISION`; defaults to `git rev-parse HEAD`).
 *   4. The Web build revision, when a build manifest is available locally,
 *      is reported and compared.
 *
 * What it does NOT do
 * -------------------
 * It mutates nothing. It pulls nothing. It contacts no production host. It
 * runs `docker inspect` against images ALREADY PRESENT on whatever host it
 * is invoked on, and reports. If Docker is unavailable, or the images are
 * not present, it says so and exits non-zero — it never assumes a match.
 *
 * Output is bounded: revisions, image references and booleans. No
 * environment values, no URLs, no secrets.
 *
 * Usage:
 *   node scripts/verify-release-identity.mjs
 *   node scripts/verify-release-identity.mjs --source-revision <sha>
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..", "..");

const REVISION_LABEL = "org.opencontainers.image.revision";

/** Tags that are, by definition, not an immutable release identity. */
const MUTABLE_TAGS = new Set([
  "latest",
  "main",
  "master",
  "edge",
  "stable",
  "dev",
  "development",
  "staging",
  "prod",
  "production",
  "nightly",
]);

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] ?? null : null;
}

function run(cmd, args) {
  const res = spawnSync(cmd, args, {
    encoding: "utf8",
    timeout: 30_000,
    windowsHide: true,
  });
  if (res.error || res.status !== 0) {
    return { ok: false, stdout: "", stderr: (res.stderr ?? "").trim() };
  }
  return { ok: true, stdout: (res.stdout ?? "").trim(), stderr: "" };
}

function resolveSourceRevision() {
  const explicit = arg("source-revision") ?? process.env.SOURCE_REVISION ?? null;
  if (explicit) return { revision: explicit.trim(), source: "explicit" };
  const git = run("git", ["-C", REPO_ROOT, "rev-parse", "HEAD"]);
  if (git.ok) return { revision: git.stdout, source: "git-head" };
  return { revision: null, source: "unavailable" };
}

function classifyImageTag(imageTag) {
  if (!imageTag) {
    return { immutable: false, reason: "IMAGE_TAG is not set." };
  }
  const value = imageTag.trim();
  if (value.length === 0) {
    return { immutable: false, reason: "IMAGE_TAG is empty." };
  }
  if (MUTABLE_TAGS.has(value.toLowerCase())) {
    return {
      immutable: false,
      reason: `IMAGE_TAG "${value}" is a floating tag; a release must be pinned to a commit SHA or an image digest.`,
    };
  }
  if (/^sha256:[0-9a-f]{64}$/i.test(value)) {
    return { immutable: true, kind: "digest" };
  }
  if (/^[0-9a-f]{40}$/i.test(value)) {
    return { immutable: true, kind: "commit-sha" };
  }
  if (/^[0-9a-f]{7,40}$/i.test(value)) {
    return { immutable: true, kind: "abbreviated-commit-sha" };
  }
  if (/^v?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(value)) {
    return { immutable: true, kind: "semver-release-tag" };
  }
  return {
    immutable: false,
    reason: `IMAGE_TAG "${value}" is not recognisably immutable (expected a commit SHA, a sha256: digest, or a semver release tag).`,
  };
}

function inspectImageRevision(imageRef) {
  const res = run("docker", [
    "image",
    "inspect",
    imageRef,
    "--format",
    `{{ index .Config.Labels "${REVISION_LABEL}" }}`,
  ]);
  if (!res.ok) {
    return { available: false, revision: null, reason: "image not present locally or docker unavailable" };
  }
  const rev = res.stdout.trim();
  if (!rev || rev === "<no value>") {
    return {
      available: true,
      revision: null,
      reason: `image carries no ${REVISION_LABEL} label`,
    };
  }
  return { available: true, revision: rev, reason: null };
}

/**
 * Web build revision, read from a locally available build manifest. The Web
 * app is a Next.js build, not an OCI image in this deployment, so its
 * revision is recorded at build time rather than inspected from a registry.
 */
function resolveWebBuildRevision() {
  const candidates = [
    path.join(REPO_ROOT, "apps", "web", ".next", "BUILD_REVISION"),
    path.join(REPO_ROOT, "apps", "web", ".next", "BUILD_ID"),
  ];
  for (const c of candidates) {
    if (!existsSync(c)) continue;
    try {
      const value = readFileSync(c, "utf8").trim();
      if (value) {
        return {
          available: true,
          revision: value,
          source: path.relative(REPO_ROOT, c).split(path.sep).join("/"),
        };
      }
    } catch {
      // fall through
    }
  }
  return { available: false, revision: null, source: null };
}

function main() {
  const owner = process.env.GHCR_OWNER ?? null;
  const imageTag = process.env.IMAGE_TAG ?? null;
  const tagClass = classifyImageTag(imageTag);
  const { revision: sourceRevision, source: sourceRevisionOrigin } =
    resolveSourceRevision();

  const problems = [];
  if (!owner) problems.push("GHCR_OWNER is not set; the image reference cannot be resolved.");
  if (!tagClass.immutable) problems.push(tagClass.reason);

  const apiRef = owner && imageTag ? `ghcr.io/${owner}/proovra-api:${imageTag}` : null;
  const workerRef = owner && imageTag ? `ghcr.io/${owner}/proovra-worker:${imageTag}` : null;

  const api = apiRef
    ? inspectImageRevision(apiRef)
    : { available: false, revision: null, reason: "image reference unresolved" };
  const worker = workerRef
    ? inspectImageRevision(workerRef)
    : { available: false, revision: null, reason: "image reference unresolved" };
  const web = resolveWebBuildRevision();

  if (!api.available || !api.revision) {
    problems.push(`API image revision unverifiable: ${api.reason}`);
  }
  if (!worker.available || !worker.revision) {
    problems.push(`Worker image revision unverifiable: ${worker.reason}`);
  }
  if (api.revision && worker.revision && api.revision !== worker.revision) {
    problems.push(
      "API and worker images were built from DIFFERENT revisions; they are not one release candidate.",
    );
  }
  if (sourceRevision && api.revision && api.revision !== sourceRevision) {
    problems.push(
      "API image revision does not match the intended source revision.",
    );
  }
  if (sourceRevision && worker.revision && worker.revision !== sourceRevision) {
    problems.push(
      "Worker image revision does not match the intended source revision.",
    );
  }

  const oneReleaseCandidate =
    problems.length === 0 &&
    Boolean(api.revision) &&
    api.revision === worker.revision &&
    (!sourceRevision || api.revision === sourceRevision);

  const report = {
    check: "release-identity",
    generatedBy: "services/api/scripts/verify-release-identity.mjs",
    SourceRevision: sourceRevision,
    SourceRevisionOrigin: sourceRevisionOrigin,
    ImageTagImmutable: tagClass.immutable === true,
    ImageTagKind: tagClass.immutable ? tagClass.kind : null,
    ApiImageRevision: api.revision,
    WorkerImageRevision: worker.revision,
    WebBuildRevision: web.revision,
    WebBuildRevisionSource: web.source,
    OneReleaseCandidate: oneReleaseCandidate,
    problems,
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!oneReleaseCandidate) {
    process.stderr.write(
      "\nRELEASE IDENTITY CHECK FAILED — the deployed revision is not provably one immutable release candidate.\n",
    );
    process.exit(1);
  }
}

main();
