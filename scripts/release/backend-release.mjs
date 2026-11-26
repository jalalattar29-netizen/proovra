#!/usr/bin/env node
/**
 * AUTOMATIC PRODUCTION BACKEND RELEASE (runner side).
 *
 * .github/workflows/backend-release.yml runs this after deploy-images publishes
 * the immutable `sha-<7>` API and worker images of a main commit. The order of
 * a release is then, with no person in the loop:
 *
 *   required CI green on the exact SHA → images published and proven
 *   → (host) rollback point recorded and proven → verified database backup
 *   → deploy-prod-pull.sh: worker, then API → (host) verification
 *   → (here) external verification: api /health revision, contract, route
 *     epoch, /readyz → commit status `release/backend` success
 *   → web-release-continuation dispatched; it promotes the matching web only
 *     when the live API's backend release is verified (release/backend).
 *
 * Subcommands (each reads the environment the workflow gives it):
 *
 *   gate              decide DEPLOY / VERIFY / ROLLBACK / no-op, write the
 *                     pending/refusal status and the step outputs
 *   finish            map the host's PROOVRA_RELEASE output to the final
 *                     status, verify from outside, keep the web compatible
 *                     after a rollback, dispatch the web continuation
 *   rollback-web      before a manual rollback: make the live web compatible
 *                     with the release being restored (Vercel promote), or refuse
 *
 * Every decision function is pure and every I/O is injected, so each path is
 * tested without GitHub, GHCR, Vercel or a host
 * (apps/web/__tests__/backend-release.test.mjs).
 */
import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  API_FACING_PATHS,
  decide as gateDecide,
  readLiveApi,
  readLiveWebRevision,
  readOwnContractVersion,
  readOwnRouteEpoch,
} from "../vercel-ignore-build.mjs";
import { REQUIRED_WORKFLOWS } from "./image-publish-gate.mjs";
import { BACKEND_FAILED_PREFIXES, BACKEND_STATUS_CONTEXT, VERCEL_API_SETUP, ciState, makeGitHub, makeVercel } from "./web-continuation.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

export const STATUS_CONTEXT = BACKEND_STATUS_CONTEXT;
export const SERVICES = Object.freeze(["api", "worker"]);
export const OWNER_SETUP = "production environment: secret PROD_RELEASE_SSH_KEY, variables PROD_RELEASE_SSH_TARGET + PROD_RELEASE_SSH_KNOWN_HOSTS";
export const VERCEL_SETUP = VERCEL_API_SETUP;
/** The prefix of every status that records a failed attempt; an automatic trigger never retries one. */
export const FAILED_PREFIXES = BACKEND_FAILED_PREFIXES;

const SHA40 = /^[0-9a-f]{40}$/;
const SHORT = (s) => String(s ?? "").slice(0, 9);
const clip = (s) => String(s).slice(0, 140);

// ---------------------------------------------------------------------------
// GHCR

/**
 * The revision label of ghcr.io/<owner>/proovra-<svc>:<tag>, read through the
 * registry API (anonymous pull token for public packages; GITHUB_TOKEN if given).
 * → { revision, digest } | { missing: true } | { error }
 */
export async function readImageRevision({ owner, svc, tag, fetchImpl = globalThis.fetch, token = "" }) {
  const repo = `${owner}/proovra-${svc}`;
  try {
    const tokRes = await fetchImpl(`https://ghcr.io/token?scope=repository:${repo}:pull&service=ghcr.io`, {
      headers: token ? { authorization: `Basic ${Buffer.from(`x:${token}`).toString("base64")}` } : {},
      signal: AbortSignal.timeout(20_000),
    });
    if (!tokRes.ok) return { error: `token HTTP ${tokRes.status}` };
    const bearer = (await tokRes.json())?.token;
    if (!bearer) return { error: "no registry token" };
    const auth = { authorization: `Bearer ${bearer}` };
    const accept = [
      "application/vnd.oci.image.index.v1+json",
      "application/vnd.docker.distribution.manifest.list.v2+json",
      "application/vnd.oci.image.manifest.v1+json",
      "application/vnd.docker.distribution.manifest.v2+json",
    ].join(", ");
    const res = await fetchImpl(`https://ghcr.io/v2/${repo}/manifests/${tag}`, { headers: { ...auth, accept }, signal: AbortSignal.timeout(20_000) });
    if (res.status === 404) return { missing: true };
    if (!res.ok) return { error: `manifest HTTP ${res.status}` };
    const digest = res.headers.get("docker-content-digest") ?? null;
    let manifest = await res.json();
    if (Array.isArray(manifest.manifests)) {
      const amd64 = manifest.manifests.find((m) => m.platform?.os === "linux" && m.platform?.architecture === "amd64") ?? manifest.manifests[0];
      if (!amd64) return { error: "empty image index" };
      const m2 = await fetchImpl(`https://ghcr.io/v2/${repo}/manifests/${amd64.digest}`, {
        headers: { ...auth, accept: "application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json" },
        signal: AbortSignal.timeout(20_000),
      });
      if (!m2.ok) return { error: `platform manifest HTTP ${m2.status}` };
      manifest = await m2.json();
    }
    const cfgDigest = manifest.config?.digest;
    if (!cfgDigest) return { error: "no config digest" };
    const cfg = await fetchImpl(`https://ghcr.io/v2/${repo}/blobs/${cfgDigest}`, { headers: auth, signal: AbortSignal.timeout(20_000) });
    if (!cfg.ok) return { error: `config HTTP ${cfg.status}` };
    const labels = (await cfg.json())?.config?.Labels ?? {};
    return { revision: labels["org.opencontainers.image.revision"] ?? null, digest };
  } catch (e) {
    return { error: e?.name === "TimeoutError" ? "timeout" : String(e?.message ?? e) };
  }
}

// ---------------------------------------------------------------------------
// THE GATE. Pure.

/**
 * facts: {
 *   mode: "auto" | "release" | "verify" | "rollback",
 *   sha, mainSha,
 *   ci: ciState(),
 *   images: { api, worker } (readImageRevision results),
 *   liveApi: readLiveApi() result,
 *   relation: "equal" | "ahead" | "older" | "diverged" | "unknown"   (live API revision vs sha),
 *   ours: release/backend statuses on sha, newest first,
 *   config: { key: bool, target: bool, knownHosts: bool },
 * }
 * → { outcome, action: "none"|"deploy"|"verify"|"rollback", status|null, exitCode, note }
 */
export function decideBackendRelease(f) {
  const sha = SHORT(f.sha);
  const out = (outcome, status, extra = {}) => ({ outcome, action: "none", status, exitCode: 0, ...extra });
  if (!SHA40.test(String(f.sha ?? ""))) return out("INVALID_SHA", null, { exitCode: 1, note: `not a 40-hex commit: ${f.sha}` });
  // config is checked where the production environment's secrets are visible
  // (the release job); the gate job passes none and is not judged on it.
  const configMissing = () => {
    if (f.config === undefined) return false;
    const c = f.config ?? {};
    return !(c.key && c.target && c.knownHosts);
  };
  const owner = (what) =>
    out("CONFIG_MISSING", { state: "error", description: clip(`waiting on owner configuration (${OWNER_SETUP}); ${what}`) }, { exitCode: 1 });

  if (f.mode === "rollback") {
    if (configMissing()) return owner(`rollback of ${sha} not started`);
    return { outcome: "ROLLBACK", action: "rollback", status: null, exitCode: 0 };
  }

  // Images: both must exist and carry this exact revision.
  for (const svc of SERVICES) {
    const img = f.images?.[svc];
    if (!img || img.error) {
      return out("IMAGES_UNREADABLE", { state: "error", description: clip(`not deployed: proovra-${svc}:sha-${String(f.sha).slice(0, 7)} unreadable in GHCR (${img?.error ?? "not asked"}); re-run`) }, { exitCode: 1 });
    }
    if (img.missing) {
      // deploy-images completes several times per commit; only one of those runs publishes.
      return out("NOT_PUBLISHED", null, { note: `proovra-${svc}:sha-${String(f.sha).slice(0, 7)} is not published (yet); nothing to deploy from this event` });
    }
    if (img.revision !== f.sha) {
      return out("IMAGE_REVISION_MISMATCH", { state: "failure", description: clip(`not deployed: proovra-${svc}:sha-${String(f.sha).slice(0, 7)} carries revision ${SHORT(img.revision)}, not ${sha}`) }, { exitCode: 1 });
    }
  }

  if (!SHA40.test(String(f.mainSha ?? ""))) return out("UNREADABLE_MAIN", { state: "error", description: `not deployed: main HEAD unreadable; re-run` }, { exitCode: 1 });
  if (f.mode !== "verify" && f.sha !== f.mainSha) {
    return out("SUPERSEDED", { state: "error", description: clip(`superseded by ${SHORT(f.mainSha)}: not deployed; the newest main commit is released instead`) });
  }

  const ci = f.ci ?? { state: "unknown", detail: "not asked" };
  if (ci.state === "failure") return out("CI_FAILED", { state: "failure", description: clip(`not deployed: required workflow ${ci.detail} on ${sha}`) }, { exitCode: 1 });
  if (ci.state !== "success") {
    return out("CI_NOT_GREEN", { state: "error", description: clip(`not deployed: required CI on ${sha} is ${ci.state} (${ci.detail})`) }, { exitCode: 1 });
  }

  const ours = Array.isArray(f.ours) ? f.ours : [];
  const lastFailed = ours[0] && FAILED_PREFIXES.some((p) => String(ours[0].description ?? "").startsWith(p));
  if (f.mode === "auto" && lastFailed) {
    return out("HELD_AFTER_FAILURE", null, { note: `${sha} already failed ("${ours[0].description}"); an automatic event never retries it — dispatch backend-release with mode=release to retry` });
  }

  const live = f.liveApi ?? { error: "not asked" };
  if (live.error || !live.ok || !SHA40.test(String(live.revision ?? ""))) {
    return out("UNREADABLE_API", { state: "error", description: clip(`not deployed: live API unreadable (${live.error ?? `HTTP ${live.status}`}, revision ${live.revision ?? "?"}); re-run`) }, { exitCode: 1 });
  }

  if (f.relation === "equal") {
    if (configMissing()) return owner(`${sha} is live but not yet verified by this workflow`);
    return { outcome: "VERIFY", action: "verify", status: { state: "pending", description: clip(`verifying backend ${sha} (already running)`) }, exitCode: 0 };
  }
  if (f.mode === "verify") {
    return out("NOT_LIVE", { state: "error", description: clip(`verification failed: the live API runs ${SHORT(live.revision)}, not ${sha}`) }, { exitCode: 1 });
  }
  if (f.relation === "older" || f.relation === "diverged") {
    return out("LIVE_NEWER", { state: "failure", description: clip(`not deployed: live API ${SHORT(live.revision)} is ${f.relation === "older" ? "newer than" : "diverged from"} ${sha}; never deployed out of order`) }, { exitCode: 1 });
  }
  if (f.relation !== "ahead") {
    return out("UNREADABLE_HISTORY", { state: "error", description: clip(`not deployed: ancestry of live API ${SHORT(live.revision)} and ${sha} unknown; re-run`) }, { exitCode: 1 });
  }
  if (configMissing()) return owner(`${sha} ready to deploy (live ${SHORT(live.revision)})`);
  return {
    outcome: "DEPLOY",
    action: "deploy",
    status: { state: "pending", description: clip(`deploying ${sha} over ${SHORT(live.revision)}: backup, worker, API, verification`) },
    exitCode: 0,
  };
}

// ---------------------------------------------------------------------------
// Host output

/** PROOVRA_RELEASE lines → { result, marks: {key: [values]} }. */
export function parseHostOutput(text) {
  const marks = {};
  let result = null;
  for (const line of String(text ?? "").split(/\r?\n/)) {
    const m = /^PROOVRA_RELEASE ([a-z_]+)=(.*)$/.exec(line.trim());
    if (!m) continue;
    (marks[m[1]] ??= []).push(m[2]);
    if (m[1] === "result") result = m[2];
  }
  return { result, marks };
}

const first = (marks, k) => (marks?.[k] ?? [])[0] ?? null;

/** "api runs from `latest` …" for each image_drift_<svc> mark. Pure. */
export function imageDriftWarnings(host) {
  const out = [];
  for (const svc of ["api", "worker"]) {
    for (const v of host?.marks?.[`image_drift_${svc}`] ?? []) {
      out.push(`image reference drift: the ${svc} container was created from ${v}; deploy only through the release (never IMAGE_TAG=latest)`);
    }
  }
  return out;
}

/**
 * The host's outcome and the external check → the final status. Pure.
 * external: { ok, revision, epoch, contract, readyz, detail } for the expected release
 * → { outcome, status, exitCode, apiRevisionNow, needsWebCheck }
 */
export function decideFinish({ action, sha, sshExit, host, external, expectedEpoch }) {
  const s = SHORT(sha);
  const r = host?.result ?? null;
  const fail = (outcome, state, description, extra = {}) => ({ outcome, status: { state, description: clip(description) }, exitCode: 1, ...extra });
  if (action === "deploy" || action === "verify") {
    if ((r === "DEPLOYED" || (action === "verify" && r === "STATUS")) && sshExit === 0) {
      if (action === "verify") {
        const apiRev = first(host.marks, "revision_api");
        const workerRev = first(host.marks, "revision_worker");
        if (apiRev !== sha || workerRev !== sha) {
          return fail("VERIFY_FAILED", "error", `verification failed: host runs api ${SHORT(apiRev)} worker ${SHORT(workerRev)}, not ${s}`);
        }
      }
      if (!external?.ok) {
        return fail("VERIFY_FAILED", "error", `verification failed: ${s} deployed but the public API says ${external?.detail ?? "nothing"}; web not released`);
      }
      return {
        outcome: "VERIFIED",
        status: { state: "success", description: clip(`backend live at ${s}: api+worker revision, readiness, epoch ${external.epoch} verified${host.marks?.backup ? `; backup ${first(host.marks, "backup")}` : ""}`) },
        exitCode: 0,
        apiRevisionNow: sha,
        needsWebCheck: false,
      };
    }
    if (r === "REFUSED_BEFORE_CHANGE") {
      return fail("REFUSED", "failure", `deploy failed before any service changed: ${first(host.marks, "reason") ?? "see run"}; still ${SHORT(first(host.marks, "running_api"))}`);
    }
    if (r === "FAILED_ROLLED_BACK") {
      const to = first(host.marks, "rolled_back_to");
      return fail("ROLLED_BACK", "failure", `deploy failed; rolled back to ${SHORT(to)} (verified)`, { apiRevisionNow: to, needsWebCheck: true });
    }
    if (r === "FAILED_ROLLBACK_FAILED") {
      return fail("ROLLBACK_FAILED", "error", `deploy failed and the rollback to ${SHORT(first(host.marks, "rollback_point"))} did NOT verify: operator needed now`, { needsWebCheck: true });
    }
    if (r === "LOCKED") return fail("LOCKED", "error", `not deployed: another release holds the host lock; re-run`);
    return fail("UNKNOWN", "error", `deploy outcome unknown (ssh exit ${sshExit}, result ${r ?? "none"}): check the host before anything else`, { needsWebCheck: true });
  }
  if (action === "rollback") {
    if (r === "ROLLED_BACK" && sshExit === 0) {
      const to = first(host.marks, "rolled_back_to");
      if (!external?.ok) return fail("ROLLBACK_UNVERIFIED", "error", `rollback failed: host restored ${SHORT(to)} but the public API says ${external?.detail ?? "nothing"}`);
      return { outcome: "ROLLED_BACK", status: { state: "failure", description: clip(`rolled back to ${SHORT(to)} (verified, epoch ${external.epoch}); ${s} is not live`) }, exitCode: 0, apiRevisionNow: to, needsWebCheck: true };
    }
    if (r === "ROLLBACK_REFUSED") return fail("ROLLBACK_REFUSED", "error", `rollback refused, nothing changed: ${first(host.marks, "reason") ?? "see run"}`);
    return fail("ROLLBACK_FAILED", "error", `rollback failed (ssh exit ${sshExit}, result ${r ?? "none"}): operator needed now`, { needsWebCheck: true });
  }
  void expectedEpoch;
  return fail("UNKNOWN_ACTION", "error", `unknown action ${action}`);
}

// ---------------------------------------------------------------------------
// External verification (the public API, as the web and the continuation see it)

export async function verifyExternal({ sha, expectedEpoch, expectedContract, apiBase = "https://api.proovra.com", fetchImpl = globalThis.fetch, attempts = 6, waitMs = 10_000, sleep = (t) => new Promise((r) => setTimeout(r, t)) }) {
  let last = { ok: false, detail: "not asked" };
  for (let i = 0; i < attempts; i += 1) {
    const live = await readLiveApi({ NEXT_PUBLIC_API_BASE: apiBase }, fetchImpl, null);
    let readyz = null;
    try {
      const r = await fetchImpl(`${apiBase.replace(/\/+$/, "")}/readyz`, { signal: AbortSignal.timeout(10_000) });
      readyz = r.status;
    } catch {
      readyz = null;
    }
    const ok =
      !live.error && live.ok && live.revision === sha && live.routeEpoch === expectedEpoch && live.contract === expectedContract && readyz === 200;
    last = {
      ok,
      revision: live.revision ?? null,
      epoch: live.routeEpoch ?? null,
      contract: live.contract ?? null,
      readyz,
      detail: live.error
        ? `unreadable (${live.error})`
        : `revision ${SHORT(live.revision)} epoch ${live.routeEpoch} (want ${expectedEpoch}) contract ${live.contract} (want ${expectedContract}) readyz ${readyz ?? "unreadable"}`,
    };
    if (ok) return last;
    if (i < attempts - 1) await sleep(waitMs);
  }
  return last;
}

// ---------------------------------------------------------------------------
// Web compatibility (rollback)

function defaultGit(args) {
  return execFileSync("git", args, { cwd: REPO_ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 120_000 });
}

export function contractAt(git, sha) {
  try {
    const src = git(["show", `${sha}:packages/shared/src/release-contract.ts`]);
    return { contract: readOwnContractVersion(src), routeEpoch: readOwnRouteEpoch(src) };
  } catch {
    return { contract: null, routeEpoch: null };
  }
}

/**
 * Would the web at `webRevision` pass the Vercel gate against an API running
 * `apiRevision`? The gate's own decide(), fed what that API would answer.
 */
export function webCompatibleWith({ git = defaultGit, webRevision, apiRevision }) {
  if (!SHA40.test(String(webRevision ?? "")) || !SHA40.test(String(apiRevision ?? ""))) return { compatible: false, reason: "revision unreadable" };
  if (webRevision === apiRevision) return { compatible: true, reason: "same commit" };
  const api = contractAt(git, apiRevision);
  const own = contractAt(git, webRevision);
  let diff = null;
  try {
    diff = git(["diff", "--name-only", apiRevision, webRevision, "--", ...API_FACING_PATHS]).split("\n").map((l) => l.trim()).filter(Boolean);
  } catch {
    diff = null;
  }
  const d = gateDecide({
    env: { VERCEL_ENV: "production", VERCEL_GIT_COMMIT_REF: "main" },
    changedFiles: null,
    own,
    live: { ok: true, status: 200, revision: apiRevision, routeEpoch: api.routeEpoch, contract: api.contract },
    apiFacingDiff: diff,
    staleness: { state: "current", liveWebRevision: webRevision },
  });
  return { compatible: d.build === true, reason: d.reason };
}

/**
 * Newest READY production deployment whose commit is compatible with apiRevision.
 * Pure over its inputs.
 */
export function chooseCompatibleWeb({ deployments, apiRevision, compatible }) {
  const sorted = [...(deployments ?? [])].filter((d) => SHA40.test(String(d.sha ?? ""))).sort((a, b) => Number(b.createdAt) - Number(a.createdAt));
  for (const d of sorted) {
    if (compatible(d.sha, apiRevision)) return d;
  }
  return null;
}

/**
 * Make the live web compatible with the API at apiRevision.
 * → { state: "compatible" | "promoted" | "refused" | "failed", detail, web }
 */
export async function ensureWebCompatible({ apiRevision, env, git = defaultGit, fetchImpl = globalThis.fetch, sleep = (t) => new Promise((r) => setTimeout(r, t)), waitMs = 15_000, attempts = 40 }) {
  const webHost = String(env.PROOVRA_WEB_ORIGIN || "https://www.proovra.com").replace(/^https?:\/\//, "").replace(/\/+$/, "");
  const live = await readLiveWebRevision({ VERCEL_PROJECT_PRODUCTION_URL: webHost }, fetchImpl);
  if (live?.revision) {
    const c = webCompatibleWith({ git, webRevision: live.revision, apiRevision });
    if (c.compatible) return { state: "compatible", detail: `live web ${SHORT(live.revision)} is compatible with API ${SHORT(apiRevision)}`, web: live.revision };
  }
  if (!env.VERCEL_TOKEN || !env.VERCEL_PROJECT_ID) {
    return {
      state: "refused",
      detail: `live web ${SHORT(live?.revision) || "unreadable"} is not known to be compatible with API ${SHORT(apiRevision)}, and ${VERCEL_SETUP} are not configured to promote one`,
      web: live?.revision ?? null,
    };
  }
  const vercel = makeVercel({ token: env.VERCEL_TOKEN, projectId: env.VERCEL_PROJECT_ID, teamId: env.VERCEL_TEAM_ID, fetchImpl });
  let target;
  try {
    target = chooseCompatibleWeb({
      deployments: await vercel.productionDeployments(),
      apiRevision,
      compatible: (w, a) => webCompatibleWith({ git, webRevision: w, apiRevision: a }).compatible,
    });
  } catch (e) {
    return { state: "failed", detail: `Vercel deployments unreadable: ${e.message}`, web: live?.revision ?? null };
  }
  if (!target) return { state: "refused", detail: `no READY production web deployment is compatible with API ${SHORT(apiRevision)}`, web: live?.revision ?? null };
  try {
    await vercel.promote(target.id);
  } catch (e) {
    return { state: "failed", detail: `promoting web ${SHORT(target.sha)} failed: ${e.message}`, web: live?.revision ?? null };
  }
  for (let i = 0; i < attempts; i += 1) {
    const now = await readLiveWebRevision({ VERCEL_PROJECT_PRODUCTION_URL: webHost }, fetchImpl);
    if (now?.revision === target.sha) return { state: "promoted", detail: `web promoted to ${SHORT(target.sha)} (${target.url})`, web: target.sha };
    await sleep(waitMs);
  }
  return { state: "failed", detail: `web ${SHORT(target.sha)} promoted but www does not serve it`, web: live?.revision ?? null };
}

// ---------------------------------------------------------------------------
// CLI

function ghFrom(env, fetchImpl) {
  return makeGitHub({ repo: env.GITHUB_REPOSITORY, token: env.GITHUB_TOKEN, fetchImpl, apiBase: env.GITHUB_API_URL || "https://api.github.com" });
}

async function setStatus(gh, env, sha, status, log) {
  if (!status) return true;
  const runUrl = env.GITHUB_SERVER_URL && env.GITHUB_RUN_ID ? `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}` : undefined;
  try {
    await gh.setStatus(sha, { state: status.state, description: clip(status.description), context: STATUS_CONTEXT, target_url: runUrl });
    return true;
  } catch (e) {
    log(`::error title=Commit status not written::${STATUS_CONTEXT} on ${SHORT(sha)}: ${e.message}`);
    return false;
  }
}

function output(env, pairs) {
  if (!env.GITHUB_OUTPUT) return;
  appendFileSync(env.GITHUB_OUTPUT, Object.entries(pairs).map(([k, v]) => `${k}=${v}`).join("\n") + "\n");
}

function summary(env, lines) {
  if (!env.GITHUB_STEP_SUMMARY) return;
  try {
    appendFileSync(env.GITHUB_STEP_SUMMARY, `### Backend release\n\n\`\`\`\n${lines.join("\n")}\n\`\`\`\n`);
  } catch {
    /* best effort */
  }
}

function relationOf(git, live, sha) {
  if (!SHA40.test(String(live ?? ""))) return "unknown";
  if (live === sha) return "equal";
  try {
    try {
      git(["cat-file", "-e", `${live}^{commit}`]);
    } catch {
      git(["fetch", "--quiet", "--filter=blob:none", "origin", live]);
    }
    const anc = (a, b) => {
      try {
        git(["merge-base", "--is-ancestor", a, b]);
        return true;
      } catch (e) {
        if (e?.status === 1) return false;
        throw e;
      }
    };
    if (anc(live, sha)) return "ahead";
    if (anc(sha, live)) return "older";
    return "diverged";
  } catch {
    return "unknown";
  }
}

export async function runGate({ env = process.env, fetchImpl = globalThis.fetch, git = defaultGit, log = (l) => console.log(l), dryRun = false } = {}) {
  const gh = ghFrom(env, fetchImpl);
  const mode = env.RELEASE_MODE || "auto";
  const sha = String(env.RELEASE_SHA ?? "").trim();
  const owner = String(env.GITHUB_REPOSITORY_OWNER ?? env.GITHUB_REPOSITORY?.split("/")[0] ?? "").toLowerCase();
  const f = {
    mode,
    sha,
    config: env.HAS_SSH_KEY === undefined ? undefined : { key: env.HAS_SSH_KEY === "true", target: env.HAS_SSH_TARGET === "true", knownHosts: env.HAS_KNOWN_HOSTS === "true" },
  };
  if (SHA40.test(sha) && mode !== "rollback") {
    f.images = {};
    for (const svc of SERVICES) f.images[svc] = await readImageRevision({ owner, svc, tag: `sha-${sha.slice(0, 7)}`, fetchImpl, token: env.GHCR_READ_TOKEN || "" });
    try {
      f.mainSha = (await gh.mainHead()).sha;
    } catch {
      f.mainSha = null;
    }
    try {
      const runs = {};
      for (const wf of REQUIRED_WORKFLOWS) runs[wf.file] = await gh.runs(wf.file, sha);
      f.ci = ciState(runs, sha);
    } catch (e) {
      f.ci = { state: "unknown", detail: e.message };
    }
    try {
      f.ours = (await gh.statuses(sha)).filter((s) => s.context === STATUS_CONTEXT).sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
    } catch {
      f.ours = [];
    }
    f.liveApi = await readLiveApi({ NEXT_PUBLIC_API_BASE: env.PROOVRA_API_BASE || "https://api.proovra.com" }, fetchImpl, null);
    f.relation = relationOf(git, f.liveApi?.revision, sha);
  }
  const d = decideBackendRelease(f);
  const c = SHA40.test(sha) ? contractAt(git, sha) : { contract: null, routeEpoch: null };
  const lines = [
    `backend-release gate: ${d.outcome} mode=${mode} sha=${sha || "-"} action=${d.action}`,
    `- images: ${SERVICES.map((s) => `${s} ${JSON.stringify(f.images?.[s] ?? null)}`).join("; ")}`,
    `- main HEAD: ${f.mainSha ?? "-"}; required CI: ${f.ci?.state ?? "-"} (${f.ci?.detail ?? "-"})`,
    `- live API: ${f.liveApi ? (f.liveApi.error ? `unreadable (${f.liveApi.error})` : `revision ${f.liveApi.revision} epoch ${f.liveApi.routeEpoch}`) : "-"}; relation ${f.relation ?? "-"}`,
    `- release expects contract ${c.contract ?? "?"} epoch ${c.routeEpoch ?? "?"}`,
    d.status ? `- status ${STATUS_CONTEXT}: ${d.status.state} "${d.status.description}"` : "- status: none written",
    d.note ? `- note: ${d.note}` : "",
  ].filter(Boolean);
  for (const l of lines) log(l);
  summary(env, lines);
  if (dryRun) log("- dry run: no status written");
  else if (d.status && SHA40.test(sha) && !(await setStatus(gh, env, sha, d.status, log))) d.exitCode = 1;
  if (d.outcome === "CONFIG_MISSING") log(`::error title=Waiting on owner configuration::${d.status.description}`);
  else if (d.exitCode !== 0) log(`::error title=Backend not deployed::${d.status?.description ?? d.note}`);
  else if (d.action === "none") log(`::notice title=No backend deploy from this event::${d.status?.description ?? d.note}`);
  output(env, { action: d.action, outcome: d.outcome, sha, epoch: c.routeEpoch ?? "", contract: c.contract ?? "" });
  return d.exitCode;
}

export async function runFinish({ env = process.env, fetchImpl = globalThis.fetch, git = defaultGit, log = (l) => console.log(l), sleep } = {}) {
  const gh = ghFrom(env, fetchImpl);
  const action = env.RELEASE_ACTION;
  const sha = String(env.RELEASE_SHA ?? "").trim();
  let hostText = "";
  try {
    hostText = readFileSync(env.HOST_LOG, "utf8");
  } catch {
    hostText = "";
  }
  const host = parseHostOutput(hostText);
  // An absent exit code (a cancelled or timed-out step) is never "0".
  const sshExit = /^\d+$/.test(String(env.SSH_EXIT ?? "")) ? Number(env.SSH_EXIT) : 255;
  // What should be live now: the release, or (rollback) the restored release.
  const restored = first(host.marks, "rolled_back_to");
  const expectRev = action === "rollback" ? restored : sha;
  const c = SHA40.test(String(expectRev ?? "")) ? contractAt(git, expectRev) : { contract: null, routeEpoch: null };
  const external = SHA40.test(String(expectRev ?? ""))
    ? await verifyExternal({ sha: expectRev, expectedEpoch: c.routeEpoch, expectedContract: c.contract, apiBase: env.PROOVRA_API_BASE || "https://api.proovra.com", fetchImpl, ...(sleep ? { sleep } : {}) })
    : { ok: false, detail: "no revision to verify" };
  const d = decideFinish({ action, sha, sshExit, host, external, expectedEpoch: c.routeEpoch });

  const lines = [
    `backend-release finish: ${d.outcome} action=${action} sha=${sha} ssh exit ${sshExit} host result ${host.result ?? "none"}`,
    `- external: ${external.detail}`,
    `- status ${STATUS_CONTEXT}: ${d.status.state} "${d.status.description}"`,
  ];
  let exitCode = d.exitCode;
  // Image-reference drift (host-release.sh status marks image_drift_<svc>):
  // the revision is right but a container was created from a moving tag such
  // as `latest`. Reported on every verify; the next release recreates the
  // containers from their immutable tag.
  for (const w of imageDriftWarnings(host)) lines.push(`::warning::${w}`);

  // The API now runs something other than the release: the web must be compatible with IT.
  if (d.needsWebCheck) {
    const apiNow = d.apiRevisionNow ?? (await readLiveApi({ NEXT_PUBLIC_API_BASE: env.PROOVRA_API_BASE || "https://api.proovra.com" }, fetchImpl, null))?.revision;
    if (SHA40.test(String(apiNow ?? ""))) {
      const w = await ensureWebCompatible({ apiRevision: apiNow, env, git, fetchImpl, ...(sleep ? { sleep } : {}) });
      lines.push(`- web after rollback: ${w.state}: ${w.detail}`);
      if (w.state === "refused" || w.state === "failed") {
        log(`::error title=Web may be incompatible with the restored API::${w.detail}`);
        exitCode = 1;
      }
    } else {
      lines.push("- web after rollback: live API revision unreadable; web compatibility NOT established");
      log("::error title=Web compatibility unknown::the live API revision could not be read after the failed release");
      exitCode = 1;
    }
  }

  for (const l of lines) log(l);
  summary(env, lines);
  // Statuses go on the commit that was released (deploy/verify) or rolled back (rollback).
  const statusSha = action === "rollback" ? String(env.ROLLBACK_FROM ?? sha) : sha;
  if (SHA40.test(statusSha) && !(await setStatus(gh, env, statusSha, d.status, log))) exitCode = 1;

  if (d.outcome === "VERIFIED") {
    log(`::notice title=Backend released::${d.status.description}`);
    // The web continuation decides with its own gate whether the web may follow now.
    try {
      const res = await fetchImpl(`${env.GITHUB_API_URL || "https://api.github.com"}/repos/${env.GITHUB_REPOSITORY}/actions/workflows/web-release-continuation.yml/dispatches`, {
        method: "POST",
        headers: { accept: "application/vnd.github+json", authorization: `Bearer ${env.GITHUB_TOKEN}`, "content-type": "application/json", "x-github-api-version": "2022-11-28" },
        body: JSON.stringify({ ref: "main" }),
        signal: AbortSignal.timeout(30_000),
      });
      log(res.status === 204 ? "- web-release-continuation dispatched" : `- web-release-continuation dispatch HTTP ${res.status}; its 10-minute schedule follows instead`);
    } catch (e) {
      log(`- web-release-continuation dispatch failed (${e.message}); its 10-minute schedule follows instead`);
    }
  } else {
    log(`::error title=Backend release not verified::${d.status.description}`);
  }
  return exitCode;
}

/** The release job found the production environment incomplete: a red, named waiting state on the commit. */
export async function runConfigMissing({ env = process.env, fetchImpl = globalThis.fetch, log = (l) => console.log(l) } = {}) {
  const sha = String(env.RELEASE_SHA ?? "").trim();
  const missing = String(env.MISSING ?? "").trim() || "unknown";
  const status = { state: "error", description: clip(`waiting on owner configuration (${OWNER_SETUP}); missing: ${missing}`) };
  log(`::error title=Waiting on owner configuration::${status.description}. Nothing was deployed. See docs/operations/automatic-backend-release.md.`);
  summary(env, [`NOT deployed: ${status.description}`]);
  if (SHA40.test(sha)) await setStatus(ghFrom(env, fetchImpl), env, sha, status, log);
  return 1;
}

export async function runRollbackWeb({ env = process.env, fetchImpl = globalThis.fetch, git = defaultGit, log = (l) => console.log(l), sleep } = {}) {
  const target = String(env.ROLLBACK_TARGET ?? "").trim();
  if (!SHA40.test(target)) {
    log(`::error title=Rollback refused::no recorded rollback point on the host (${target || "none"}); nothing changed`);
    return 1;
  }
  const w = await ensureWebCompatible({ apiRevision: target, env, git, fetchImpl, ...(sleep ? { sleep } : {}) });
  log(`rollback-web: ${w.state}: ${w.detail}`);
  summary(env, [`web before backend rollback to ${target}: ${w.state}: ${w.detail}`]);
  if (w.state === "compatible" || w.state === "promoted") return 0;
  log(`::error title=Rollback refused::${w.detail}. The backend was NOT rolled back.`);
  const from = String(env.RELEASE_SHA ?? "").trim();
  if (SHA40.test(from)) {
    await setStatus(ghFrom(env, fetchImpl), env, from, { state: "error", description: clip(`rollback refused, nothing changed: ${w.detail}`) }, log);
  }
  return 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const cmd = process.argv[2];
  const run = { gate: runGate, finish: runFinish, "rollback-web": runRollbackWeb, "config-missing": runConfigMissing }[cmd];
  if (!run) {
    console.error("usage: backend-release.mjs gate | finish | rollback-web | config-missing");
    process.exit(64);
  }
  const dryRun = process.argv.includes("--dry-run");
  (cmd === "gate" ? runGate({ dryRun }) : run()).then(
    (code) => process.exit(code),
    (e) => {
      console.error(`backend-release ${cmd}: FAILED unexpectedly: ${e?.stack ?? e}`);
      process.exit(1);
    },
  );
}
