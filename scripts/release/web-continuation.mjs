#!/usr/bin/env node
/**
 * WEB RELEASE CONTINUATION (closure 3, 2026-11-22).
 *
 * The web ships from Vercel's Git integration on every push to main, and the
 * Vercel build runs a fail-closed compatibility gate (scripts/vercel-ignore-build.mjs):
 * a commit whose API-facing source the live API does not serve yet is
 * "Canceled by Ignored Build Step". The API and worker ship separately, by an
 * operator on the host (scripts/deploy-prod-pull.sh). Nothing ever retried the
 * cancelled web build: an operator pushed an EMPTY commit after each backend
 * deploy (2307542a8, 7b852996e).
 *
 * This script, run by .github/workflows/web-release-continuation.yml on every
 * push to main, on each required workflow's completion and every 10 minutes,
 * finishes that release by itself:
 *
 *   1. It evaluates ONLY the newest commit of main (older commits are never
 *      triggered; a still-pending older commit is marked superseded).
 *   2. It reads the real state: the live web's revision (www /api/health), the
 *      live API's revision, contract and route epoch (api /health), the
 *      required workflows on that exact SHA (the same list that gates the
 *      container images), and Vercel's own commit status for that SHA.
 *   3. It asks the Vercel gate's own `decide()` whether a build of that SHA
 *      would pass against the live API right now, so it predicts the gate with
 *      the gate's code rather than a copy of its rules.
 *   4. While the API is behind it sets the commit status `release/web-continuation`
 *      to pending, naming the dependency ("waiting for API epoch 5 (live 4)..."),
 *      and exits; the next trigger re-reads the state.
 *   5. When the gate refused the commit earlier and the API now serves it, and
 *      every required workflow is green on that SHA, and main has not moved, it
 *      calls the proovra-web Vercel Deploy Hook ONCE. The Vercel build runs the
 *      same gate again on the SHA it actually builds, and refuses anything older
 *      than the live web.
 *
 * It never pushes, commits or tags anything. An unreadable fact never
 * promotes: the status says what could not be read, and the next run retries.
 * A missing hook secret shows as "waiting on owner configuration:
 * VERCEL_WEB_DEPLOY_HOOK_URL" and fails the run only when a continuation is
 * actually due.
 *
 * `decideContinuation` is pure; `gatherFacts` takes an injected fetch and git
 * runner, so every scenario is testable without GitHub, Vercel or the network
 * (apps/web/__tests__/web-release-continuation.test.mjs).
 *
 *   node scripts/release/web-continuation.mjs --dry-run
 *
 * reads the REAL public endpoints (unauthenticated GitHub API, 60 req/h) and
 * prints the decision without writing a status or calling the hook.
 */
import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  API_FACING_PATHS,
  decide as gateDecide,
  readLiveApi,
  readLiveWebRevision,
  readOwnContractVersion,
  readOwnRouteEpoch,
  readWebDefaultApiBase,
} from "../vercel-ignore-build.mjs";
import { REQUIRED_WORKFLOWS } from "./image-publish-gate.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

export const STATUS_CONTEXT = "release/web-continuation";
/**
 * Written by .github/workflows/backend-release.yml (scripts/release/backend-release.mjs)
 * on each released commit. A web is promoted by this script only while the live
 * API's revision carries a `success` here: its backend release was verified
 * (revisions, readiness, epoch), not merely started.
 */
export const BACKEND_STATUS_CONTEXT = "release/backend";
/** Descriptions of release/backend statuses that record a failed or reverted release. */
export const BACKEND_FAILED_PREFIXES = ["deploy failed", "rolled back", "rollback failed", "verification failed"];
export const VERCEL_API_SETUP = "VERCEL_TOKEN + VERCEL_PROJECT_ID";
const PROMOTE_RE = /^promoted web ([0-9a-f]{7,40}) via the Vercel API/;
export const VERCEL_WEB_CONTEXT = "Vercel – proovra-web";
export const HOOK_SECRET_NAME = "VERCEL_WEB_DEPLOY_HOOK_URL";
/** A triggered build that Vercel has not reported on within this window is treated as lost. */
export const TRIGGER_IN_FLIGHT_MS = 30 * 60_000;
/** A fresh push gets this long for Vercel to post its first status before it counts as absent. */
export const VERCEL_REPORT_GRACE_MS = 15 * 60_000;
/** Vercel said "completed" but www does not serve the SHA yet: propagation allowance. */
export const PROPAGATION_GRACE_MS = 10 * 60_000;
/** Continuation builds per (SHA, live API revision) before the run asks for an operator. */
export const MAX_TRIGGERS_PER_API_REVISION = 3;
/** Older main commits checked for a stale pending continuation status. */
export const SUPERSEDE_LOOKBACK = 10;

const SHA40 = /^[0-9a-f]{40}$/;
const SHORT = (s) => String(s ?? "").slice(0, 9);
const HOOK_URL = /^https:\/\/api\.vercel\.com\/v1\/integrations\/deploy\/[A-Za-z0-9_]+\/[A-Za-z0-9_]+\/?(\?[A-Za-z0-9_=&-]*)?$/;

export function isDeployHookUrl(url) {
  return HOOK_URL.test(String(url ?? "").trim());
}

/**
 * Required workflows on one SHA (push runs on main): "success" when every one
 * has a successful latest attempt, "failure" (with the workflow) when any is
 * red, "pending" while any is missing or running, "unknown" when unreadable.
 */
export function ciState(runsByFile, sha, required = REQUIRED_WORKFLOWS) {
  if (!runsByFile) return { state: "unknown", detail: "workflow runs unreadable" };
  const waiting = [];
  const urls = [];
  for (const wf of required) {
    const runs = runsByFile[wf.file];
    if (!Array.isArray(runs)) return { state: "unknown", detail: `runs of ${wf.name} unreadable` };
    const mine = runs.filter((r) => r.head_sha === sha && r.event === "push");
    if (mine.length === 0) {
      waiting.push(wf.name);
      continue;
    }
    const latest = [...mine].sort(
      (a, b) =>
        (b.run_attempt ?? 1) - (a.run_attempt ?? 1) ||
        String(b.created_at ?? "").localeCompare(String(a.created_at ?? "")),
    )[0];
    if (latest.html_url) urls.push(`${wf.name}: ${latest.html_url}`);
    if (latest.status !== "completed") {
      waiting.push(wf.name);
      continue;
    }
    if (latest.conclusion !== "success") {
      return { state: "failure", detail: `${wf.name} ${latest.conclusion}`, workflow: wf.name, urls };
    }
  }
  if (waiting.length > 0) return { state: "pending", detail: waiting.join(", "), urls };
  return { state: "success", detail: "all required workflows green", urls };
}

/** Vercel's latest web status for the SHA, classified. */
export function classifyVercel(statuses) {
  const latest = (statuses ?? [])[0];
  if (!latest) return { kind: "absent" };
  const desc = String(latest.description ?? "");
  if (latest.state === "pending") return { kind: "building", latest };
  if (latest.state === "success" && /cancel/i.test(desc)) return { kind: "refused", latest };
  if (latest.state === "success") return { kind: "deployed", latest };
  return { kind: "failed", latest };
}

const TRIGGER_RE = /^triggered web build of ([0-9a-f]{7,40}) \(api ([0-9a-f]{7,40}) epoch (\d+)\)/;

/** The facts a "triggered" status records, or null. */
export function parseTrigger(description) {
  const m = TRIGGER_RE.exec(String(description ?? ""));
  return m ? { sha: m[1], apiRevision: m[2], epoch: Number(m[3]) } : null;
}

/** Written after a trigger record when the hook call itself failed: that record is void. */
export const HOOK_FAILED_PREFIX = "deploy hook call failed";

/**
 * Trigger records (newest first) that stand: a record followed by a
 * "deploy hook call failed" status is void (the hook never accepted it). A
 * record whose follow-up could not be written stands — the conservative side:
 * it is waited on, and counted.
 */
export function effectiveTriggers(oursNewestFirst) {
  const out = [];
  let voidNext = 0;
  for (const s of oursNewestFirst ?? []) {
    if (String(s.description ?? "").startsWith(HOOK_FAILED_PREFIX)) {
      voidNext += 1;
      continue;
    }
    const t = parseTrigger(s.description);
    if (!t) continue;
    if (voidNext > 0) {
      voidNext -= 1;
      continue;
    }
    out.push({ s, t });
  }
  return out;
}

export function triggerDescription(sha, live) {
  return `triggered web build of ${SHORT(sha)} (api ${SHORT(live.revision)} epoch ${live.routeEpoch}) via the Vercel deploy hook`;
}

const ms = (iso) => {
  const t = Date.parse(String(iso ?? ""));
  return Number.isFinite(t) ? t : null;
};

/**
 * THE DECISION. Pure.
 *
 * facts: {
 *   now, headSha, headCommittedAt (ms|null),
 *   liveWeb: { revision } | { error },
 *   relation: "current" | "ahead" | "older" | "unknown"   (head vs the live web revision),
 *   liveApi: readLiveApi() result,
 *   own: { contract, routeEpoch } of head,
 *   apiFacingDiff: string[] | null   (live API revision vs head),
 *   requiredApiRevision: string | null (newest API-facing commit at or before head),
 *   ci: ciState(),
 *   vercel: Vercel web statuses on head, newest first (null = unreadable),
 *   ours: this workflow's statuses on head, newest first,
 *   hookConfigured: boolean, hookValid: boolean,
 * }
 * returns { outcome, action: "none" | "trigger", status: {state, description} | null, exitCode, note }
 */
export function decideContinuation(f) {
  const head = SHORT(f.headSha);
  const out = (outcome, status, extra = {}) => ({ outcome, action: "none", status, exitCode: 0, ...extra });
  if (!SHA40.test(String(f.headSha ?? ""))) return out("UNREADABLE_MAIN", null, { note: "main HEAD unreadable" });

  if (!f.liveWeb || f.liveWeb.error || !f.liveWeb.revision) {
    return out("UNREADABLE_WEB", {
      state: "pending",
      description: `no promotion: live web revision unreadable (${f.liveWeb?.error ?? "not asked"}); retrying on the next run`,
    });
  }
  const web = SHORT(f.liveWeb.revision);
  if (f.relation === "current") return out("WEB_CURRENT", { state: "success", description: `web live at ${head}` });
  if (f.relation === "older") {
    return out("STALE_HEAD", {
      state: "error",
      description: `main ${head} is older than the live web ${web}; never deployed over a newer release`,
    });
  }
  if (f.relation !== "ahead") {
    return out("UNREADABLE_HISTORY", {
      state: "pending",
      description: `no promotion: ancestry of ${head} and live web ${web} could not be established; retrying`,
    });
  }

  // The backend release of this very commit failed or was rolled back: its web
  // is not released, whatever the gate would say (the rollback already made
  // the live web compatible with the restored API).
  const headBackend = Array.isArray(f.backendHead) ? f.backendHead[0] : null;
  if (
    headBackend &&
    headBackend.state !== "success" &&
    headBackend.state !== "pending" &&
    BACKEND_FAILED_PREFIXES.some((p) => String(headBackend.description ?? "").startsWith(p))
  ) {
    return out("HELD_BACKEND_FAILED", {
      state: "failure",
      description: `held: the backend release of ${head} did not stay live (${String(headBackend.description).slice(0, 60)}); web stays at ${web}`,
    });
  }

  if (!Array.isArray(f.vercel)) {
    return out("UNREADABLE_VERCEL", {
      state: "pending",
      description: `no promotion: Vercel's commit status for ${head} unreadable; retrying on the next run`,
    });
  }
  const vercel = classifyVercel(f.vercel);
  const ours = Array.isArray(f.ours) ? f.ours : [];
  const triggers = effectiveTriggers(ours);
  const lastTrigger = triggers[0] ?? null;
  const vercelAt = ms(vercel.latest?.created_at);
  const lastTriggerAt = lastTrigger ? ms(lastTrigger.s.created_at) : null;
  const vercelSinceTrigger = lastTrigger ? vercelAt !== null && lastTriggerAt !== null && vercelAt >= lastTriggerAt : true;

  if (vercel.kind === "building") {
    return out("BUILDING", { state: "pending", description: `Vercel is building ${head}; web still ${web}` });
  }
  // Deployed but not live: after a web rollback (Vercel promote of an older
  // deployment) Vercel stops assigning production domains to new deployments,
  // so the next compatible release must be PROMOTED. That is done below, through
  // the same compatibility, CI and backend checks, when the Vercel API is configured.
  let promoteDue = false;
  if (vercel.kind === "deployed" && vercelSinceTrigger) {
    const age = vercelAt === null ? Infinity : f.now - vercelAt;
    if (age < PROPAGATION_GRACE_MS) {
      return out("PROPAGATING", { state: "pending", description: `Vercel deployed ${head}; waiting for www to serve it (still ${web})` });
    }
    if (!f.vercelApiConfigured) {
      return out("DEPLOYED_NOT_LIVE", {
        state: "error",
        description: `Vercel reports ${head} deployed but www serves ${web}; promote it, or configure ${VERCEL_API_SETUP} so this is automatic`,
      }, { exitCode: 1 });
    }
    promoteDue = true;
  }
  if (vercel.kind === "absent" && !lastTrigger) {
    const age = f.headCommittedAt === null || f.headCommittedAt === undefined ? Infinity : f.now - f.headCommittedAt;
    if (age < VERCEL_REPORT_GRACE_MS) {
      return out("AWAITING_VERCEL", { state: "pending", description: `waiting for Vercel to report a deployment of ${head}` });
    }
  }

  // The gate refused (or failed) the build, or Vercel never reported one. Would it pass now?
  const live = f.liveApi ?? { error: "not asked" };
  if (live.error || !live.ok) {
    const unhealthy = !live.error && Number(live.status) >= 500;
    return out(unhealthy ? "API_UNHEALTHY" : "UNREADABLE_API", {
      state: unhealthy ? "error" : "pending",
      description: unhealthy
        ? `live API unhealthy (HTTP ${live.status}); web stays at ${web}, no promotion; retrying`
        : `no promotion: live API unreadable (${live.error ?? `HTTP ${live.status}`}); web stays at ${web}; retrying`,
    });
  }
  const own = f.own ?? {};
  const gate = gateDecide({
    env: { VERCEL_ENV: "production", VERCEL_GIT_COMMIT_REF: "main" },
    changedFiles: null,
    own,
    live,
    apiFacingDiff: f.apiFacingDiff,
    staleness: { state: "current", liveWebRevision: f.liveWeb.revision },
  });
  if (!gate.build) {
    const need = f.requiredApiRevision ? `revision >= ${SHORT(f.requiredApiRevision)}` : "a newer revision";
    let description;
    if (Number.isInteger(own.routeEpoch) && Number.isInteger(live.routeEpoch) && live.routeEpoch < own.routeEpoch) {
      description = `waiting for API epoch ${own.routeEpoch} (live ${live.routeEpoch}), ${need} (live ${SHORT(live.revision)})`;
    } else if (Array.isArray(f.apiFacingDiff) && f.apiFacingDiff.length > 0) {
      description = `waiting for API ${need} (live ${SHORT(live.revision)}, epoch ${live.routeEpoch}): ${f.apiFacingDiff.length} API-facing file(s) differ`;
    } else if (!Array.isArray(f.apiFacingDiff)) {
      return out("UNREADABLE_DIFF", {
        state: "pending",
        description: `no promotion: API-facing diff of live API ${SHORT(live.revision)} vs ${head} unreadable; retrying`,
      }, { note: gate.reason });
    } else {
      description = `waiting for a compatible API: ${gate.reason}`;
    }
    return out("WAITING_API", { state: "pending", description: `${description}; web stays at ${web}` }, { note: gate.reason });
  }

  const ci = f.ci ?? { state: "unknown", detail: "not asked" };
  if (ci.state === "failure") {
    return out("CI_FAILED", {
      state: "failure",
      description: `required workflow ${ci.detail} on ${head}; web not continued, stays at ${web}`,
    });
  }
  if (ci.state === "pending") {
    return out("WAITING_CI", { state: "pending", description: `API ready; waiting for required CI on ${head}: ${ci.detail}` });
  }
  if (ci.state !== "success") {
    return out("UNREADABLE_CI", { state: "pending", description: `no promotion: required CI on ${head} unreadable (${ci.detail}); retrying` });
  }

  // Compatible and green. The live API's own backend release must be VERIFIED
  // (release/backend success on its revision), not merely running: a release
  // in progress, failed or never verified promotes no web.
  const liveShort = SHORT(live.revision);
  if (!Array.isArray(f.backendLive)) {
    return out("UNREADABLE_BACKEND", {
      state: "pending",
      description: `no promotion: ${BACKEND_STATUS_CONTEXT} of live API ${liveShort} unreadable; web stays at ${web}; retrying`,
    });
  }
  const backend = f.backendLive[0];
  if (!backend) {
    return out("WAITING_BACKEND", {
      state: "pending",
      description: `waiting for a verified backend release of live API ${liveShort} (${BACKEND_STATUS_CONTEXT}); web stays at ${web}`,
    });
  }
  if (backend.state === "pending") {
    return out("WAITING_BACKEND", {
      state: "pending",
      description: `waiting for backend verification of ${liveShort} (release in progress); web stays at ${web}`,
    });
  }
  if (backend.state !== "success") {
    return out("HELD_BACKEND_UNVERIFIED", {
      state: "failure",
      description: `held: backend ${liveShort} is not verified (${String(backend.description ?? "").slice(0, 60)}); web stays at ${web}`,
    });
  }

  if (promoteDue) {
    const lastPromote = ours.find((s) => PROMOTE_RE.test(String(s.description ?? "")));
    const at = lastPromote ? ms(lastPromote.created_at) : null;
    if (at !== null && f.now - at < TRIGGER_IN_FLIGHT_MS) {
      return out("PROMOTE_IN_FLIGHT", null, { note: `promotion requested at ${lastPromote.created_at}; waiting for www` });
    }
    return {
      outcome: "PROMOTE",
      action: "promote",
      status: { state: "pending", description: `promoted web ${SHORT(f.headSha)} via the Vercel API (api ${liveShort} epoch ${live.routeEpoch}); waiting for www` },
      exitCode: 0,
      note: gate.reason,
    };
  }

  // Everything is green and compatible. Was a continuation already started?
  if (lastTrigger && !vercelSinceTrigger && lastTriggerAt !== null && f.now - lastTriggerAt < TRIGGER_IN_FLIGHT_MS) {
    return out("TRIGGER_IN_FLIGHT", null, { note: `continuation build requested at ${lastTrigger.s.created_at}; waiting for Vercel` });
  }
  const sameApi = triggers.filter((x) => String(live.revision).startsWith(x.t.apiRevision));
  if (sameApi.length >= MAX_TRIGGERS_PER_API_REVISION) {
    return out("GAVE_UP", {
      state: "failure",
      description: `${sameApi.length} continuation builds of ${head} against API ${SHORT(live.revision)} did not go live (Vercel: ${vercel.latest?.description ?? "no report"}); read the Vercel build log`,
    }, { exitCode: 1 });
  }
  if (!f.hookConfigured || !f.hookValid) {
    return out("CONFIG_MISSING", {
      state: "error",
      description: `waiting on owner configuration: ${HOOK_SECRET_NAME}${f.hookConfigured ? " (not a Vercel deploy hook URL)" : ""}; web ${head} is ready (API ${SHORT(live.revision)})`,
    }, { exitCode: 1 });
  }
  return {
    outcome: "TRIGGER",
    action: "trigger",
    status: { state: "pending", description: triggerDescription(f.headSha, live) },
    exitCode: 0,
    note: gate.reason,
  };
}

/**
 * Older main commits whose latest continuation status is still pending: they
 * will never be deployed (only the newest main is), so they are marked.
 */
export function supersedeTargets(headSha, olderCommits) {
  return (olderCommits ?? [])
    .filter((c) => c.sha !== headSha && Array.isArray(c.ours) && c.ours[0]?.state === "pending")
    .map((c) => ({
      sha: c.sha,
      status: { state: "error", description: `superseded by ${SHORT(headSha)}: not deployed; the newest main commit is released instead` },
    }));
}

// ---------------------------------------------------------------------------
// I/O

function defaultGit(args) {
  return execFileSync("git", args, { cwd: REPO_ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 120_000 });
}

function ensureCommit(git, sha) {
  try {
    git(["cat-file", "-e", `${sha}^{commit}`]);
    return true;
  } catch {
    try {
      git(["fetch", "--quiet", "--filter=blob:none", "origin", sha]);
      git(["cat-file", "-e", `${sha}^{commit}`]);
      return true;
    } catch {
      return false;
    }
  }
}

function isAncestor(git, a, b) {
  try {
    git(["merge-base", "--is-ancestor", a, b]);
    return true;
  } catch (e) {
    if (e?.status === 1) return false;
    throw e;
  }
}

/** head vs the live web revision. */
export function relationTo(git, head, webRevision) {
  if (!webRevision) return "unknown";
  if (head.startsWith(webRevision) || webRevision.startsWith(head)) return "current";
  try {
    if (!ensureCommit(git, webRevision)) return "unknown";
    if (isAncestor(git, webRevision, head)) return "ahead";
    if (isAncestor(git, head, webRevision)) return "older";
    return "unknown";
  } catch {
    return "unknown";
  }
}

export function makeGitHub({ repo, token, fetchImpl = globalThis.fetch, apiBase = "https://api.github.com" }) {
  const headers = {
    accept: "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
    "user-agent": "proovra-web-continuation",
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  };
  async function call(method, path, body) {
    const res = await fetchImpl(`${apiBase}${path}`, {
      method,
      headers: body ? { ...headers, "content-type": "application/json" } : headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(30_000),
    });
    if (res.status < 200 || res.status >= 300) throw new Error(`GitHub ${method} ${path.split("?")[0]} -> HTTP ${res.status}`);
    return res.json();
  }
  return {
    mainHead: async () => {
      const c = await call("GET", `/repos/${repo}/commits/main`);
      return { sha: c.sha, committedAt: ms(c.commit?.committer?.date) };
    },
    runs: async (file, sha) =>
      (await call("GET", `/repos/${repo}/actions/workflows/${file}/runs?head_sha=${sha}&event=push&branch=main&per_page=50`)).workflow_runs ?? [],
    statuses: async (sha) => call("GET", `/repos/${repo}/commits/${sha}/statuses?per_page=100`),
    setStatus: async (sha, status) => call("POST", `/repos/${repo}/statuses/${sha}`, status),
  };
}

const newestFirst = (list) => [...list].sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
const byContext = (statuses, context) => newestFirst((statuses ?? []).filter((s) => s.context === context));

/** Everything decideContinuation needs, read from the real world (all injected). */
export async function gatherFacts({ gh, git = defaultGit, fetchImpl = globalThis.fetch, env = {}, now = Date.now() }) {
  const f = { now, headSha: null, vercel: null, ours: [], ci: { state: "unknown", detail: "not asked" }, links: {} };
  let head;
  try {
    head = await gh.mainHead();
  } catch (e) {
    f.error = `main HEAD unreadable: ${e.message}`;
    return f;
  }
  f.headSha = head.sha;
  f.headCommittedAt = head.committedAt;
  const webHost = String(env.PROOVRA_WEB_ORIGIN || "https://www.proovra.com").replace(/^https?:\/\//, "").replace(/\/+$/, "");
  f.liveWeb = await readLiveWebRevision({ VERCEL_PROJECT_PRODUCTION_URL: webHost }, fetchImpl);

  const haveHead = ensureCommit(git, head.sha);
  let contractSrc = null;
  let apiSrc = null;
  if (haveHead) {
    try {
      contractSrc = git(["show", `${head.sha}:packages/shared/src/release-contract.ts`]);
    } catch {
      contractSrc = null;
    }
    try {
      apiSrc = git(["show", `${head.sha}:apps/web/lib/api.ts`]);
    } catch {
      apiSrc = null;
    }
    try {
      f.requiredApiRevision = git(["log", "-1", "--format=%H", head.sha, "--", ...API_FACING_PATHS]).trim() || null;
    } catch {
      f.requiredApiRevision = null;
    }
  }
  f.own = { contract: readOwnContractVersion(contractSrc), routeEpoch: readOwnRouteEpoch(contractSrc) };
  f.relation = haveHead ? relationTo(git, head.sha, f.liveWeb?.revision) : "unknown";

  const apiBase = env.PROOVRA_API_BASE || readWebDefaultApiBase(apiSrc) || "https://api.proovra.com";
  f.liveApi = await readLiveApi({ NEXT_PUBLIC_API_BASE: apiBase }, fetchImpl, null);
  f.apiFacingDiff = null;
  if (haveHead && f.liveApi && !f.liveApi.error && f.liveApi.ok && /^[0-9a-f]{7,40}$/.test(String(f.liveApi.revision ?? ""))) {
    if (ensureCommit(git, f.liveApi.revision)) {
      try {
        f.apiFacingDiff = git(["diff", "--name-only", f.liveApi.revision, head.sha, "--", ...API_FACING_PATHS])
          .split("\n")
          .map((l) => l.trim())
          .filter(Boolean);
      } catch {
        f.apiFacingDiff = null;
      }
    }
  }

  try {
    const runs = {};
    for (const wf of REQUIRED_WORKFLOWS) runs[wf.file] = await gh.runs(wf.file, head.sha);
    f.ci = ciState(runs, head.sha);
  } catch (e) {
    f.ci = { state: "unknown", detail: e.message };
  }
  f.backendLive = null;
  if (f.liveApi && !f.liveApi.error && /^[0-9a-f]{40}$/.test(String(f.liveApi.revision ?? ""))) {
    try {
      f.backendLive = byContext(await gh.statuses(f.liveApi.revision), BACKEND_STATUS_CONTEXT);
    } catch {
      f.backendLive = null;
    }
  }
  f.vercelApiConfigured = Boolean(String(env.VERCEL_TOKEN ?? "").trim() && String(env.VERCEL_PROJECT_ID ?? "").trim());
  try {
    const statuses = await gh.statuses(head.sha);
    f.backendHead = byContext(statuses, BACKEND_STATUS_CONTEXT);
    f.vercel = byContext(statuses, env.VERCEL_WEB_CONTEXT || VERCEL_WEB_CONTEXT);
    f.ours = byContext(statuses, STATUS_CONTEXT);
    f.links.vercel = [...new Set(byContext(statuses, env.VERCEL_WEB_CONTEXT || VERCEL_WEB_CONTEXT).map((s) => s.target_url).filter(Boolean))];
  } catch {
    f.vercel = null;
  }
  const hook = String(env[HOOK_SECRET_NAME] ?? "").trim();
  f.hookConfigured = hook !== "";
  f.hookValid = isDeployHookUrl(hook);
  return f;
}

/**
 * The Vercel REST API, for the two things a deploy hook cannot do: list the
 * project's READY production deployments and PROMOTE one (a web rollback, and
 * the first release after one). Needs VERCEL_TOKEN + VERCEL_PROJECT_ID
 * (+ VERCEL_TEAM_ID for a team project). Never logs the token.
 */
export function makeVercel({ token, projectId, teamId, fetchImpl = globalThis.fetch }) {
  const q = teamId ? `teamId=${encodeURIComponent(teamId)}` : "";
  const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  const call = async (method, path) => {
    const sep = path.includes("?") ? "&" : "?";
    const res = await fetchImpl(`https://api.vercel.com${path}${q ? `${sep}${q}` : ""}`, { method, headers, signal: AbortSignal.timeout(30_000) });
    if (res.status < 200 || res.status >= 300) throw new Error(`Vercel ${method} ${path.split("?")[0]} -> HTTP ${res.status}`);
    if (res.status === 204) return {};
    try {
      return await res.json();
    } catch {
      return {};
    }
  };
  return {
    productionDeployments: async () =>
      ((await call("GET", `/v6/deployments?projectId=${encodeURIComponent(projectId)}&target=production&state=READY&limit=50`)).deployments ?? []).map((d) => ({
        id: d.uid ?? d.id,
        url: d.url,
        sha: d.meta?.githubCommitSha ?? null,
        createdAt: d.createdAt ?? d.created ?? 0,
      })),
    promote: async (deploymentId) => call("POST", `/v10/projects/${encodeURIComponent(projectId)}/promote/${encodeURIComponent(deploymentId)}`),
  };
}

/** Calls the hook. Never logs the URL. */
export async function callDeployHook(url, fetchImpl = globalThis.fetch) {
  try {
    const res = await fetchImpl(url, { method: "POST", signal: AbortSignal.timeout(30_000) });
    let job = null;
    try {
      job = (await res.json())?.job ?? null;
    } catch {
      job = null;
    }
    return { ok: res.status >= 200 && res.status < 300, status: res.status, jobId: job?.id ?? null };
  } catch (e) {
    return { ok: false, status: null, error: e?.name ?? "Error" };
  }
}

const sleep = (t) => new Promise((r) => setTimeout(r, t));

/**
 * One evaluation. Returns the exit code. Writes statuses and calls the hook
 * only when not a dry run.
 */
export async function runContinuation({
  env = process.env,
  fetchImpl = globalThis.fetch,
  git = defaultGit,
  log = (l) => console.log(l),
  now = () => Date.now(),
  dryRun = false,
  observeMs = 180_000,
  observeEveryMs = 20_000,
} = {}) {
  const repo = env.GITHUB_REPOSITORY || "jalalattar29-netizen/proovra";
  const gh = makeGitHub({ repo, token: dryRun ? env.GITHUB_TOKEN || "" : env.GITHUB_TOKEN, fetchImpl, apiBase: env.GITHUB_API_URL || "https://api.github.com" });
  const runUrl = env.GITHUB_SERVER_URL && env.GITHUB_RUN_ID ? `${env.GITHUB_SERVER_URL}/${repo}/actions/runs/${env.GITHUB_RUN_ID}` : undefined;
  const summary = [];
  const say = (l) => {
    log(l);
    summary.push(l);
  };

  const facts = await gatherFacts({ gh, git, fetchImpl, env, now: now() });
  const d = facts.error ? { outcome: "UNREADABLE_MAIN", action: "none", status: null, exitCode: 0, note: facts.error } : decideContinuation(facts);

  say(`web-continuation: ${d.outcome} head=${facts.headSha ?? "unknown"} action=${d.action}${dryRun ? " (dry run)" : ""}`);
  say(`- origin: event ${env.GITHUB_EVENT_NAME ?? "manual"} at ${env.ORIGIN_SHA || env.GITHUB_SHA || "-"}${runUrl ? ` (${runUrl})` : ""}`);
  say(`- live web: ${facts.liveWeb?.revision ?? `unreadable (${facts.liveWeb?.error ?? "-"})`}; head is ${facts.relation ?? "unknown"} relative to it`);
  const la = facts.liveApi;
  say(`- live API: ${la ? (la.error ? `unreadable (${la.error})` : `HTTP ${la.status} revision ${la.revision ?? "unknown"} contract ${la.contract ?? "?"} epoch ${la.routeEpoch ?? "?"}`) : "not asked"}`);
  say(`- head needs: contract ${facts.own?.contract ?? "?"} epoch ${facts.own?.routeEpoch ?? "?"}, API-facing source of ${facts.requiredApiRevision ?? "unknown"}; API-facing diff vs live: ${Array.isArray(facts.apiFacingDiff) ? facts.apiFacingDiff.length : "unknown"}`);
  say(`- required CI on head: ${facts.ci?.state} (${facts.ci?.detail})`);
  for (const u of facts.ci?.urls ?? []) say(`  - ${u}`);
  say(`- Vercel web status on head: ${facts.vercel ? (facts.vercel[0] ? `${facts.vercel[0].state} "${facts.vercel[0].description}"` : "none") : "unreadable"}`);
  for (const u of facts.links?.vercel ?? []) say(`  - deployment ${u}`);
  if (d.status) say(`- status ${STATUS_CONTEXT}: ${d.status.state} "${d.status.description}"`);
  if (d.note) say(`- note: ${d.note}`);
  if (!facts.hookConfigured) {
    log(`::warning title=Owner configuration: ${HOOK_SECRET_NAME}::The repository secret ${HOOK_SECRET_NAME} is not set. Web releases that wait for the API cannot continue automatically until the owner adds it.`);
  }

  let exitCode = d.exitCode;
  const setStatus = async (sha, status) => {
    if (dryRun) return true;
    const latest = sha === facts.headSha ? facts.ours?.[0] : null;
    // An unchanged status is not re-posted (statuses are capped per SHA); every trigger is, because triggers are counted.
    const recordKeeping = parseTrigger(status.description) || status.description.startsWith(HOOK_FAILED_PREFIX) || PROMOTE_RE.test(status.description);
    if (latest && !recordKeeping && latest.state === status.state && latest.description === status.description.slice(0, 140)) return true;
    try {
      await gh.setStatus(sha, { state: status.state, description: status.description.slice(0, 140), context: STATUS_CONTEXT, target_url: runUrl });
      return true;
    } catch (e) {
      log(`::error title=Commit status not written::${STATUS_CONTEXT} on ${SHORT(sha)}: ${e.message}`);
      exitCode = 1;
      return false;
    }
  };

  if (d.action === "trigger" && !dryRun) {
    // Never build a moving reference: the hook builds main's HEAD, so it must still be the SHA evaluated.
    let current = null;
    try {
      current = (await gh.mainHead()).sha;
    } catch (e) {
      current = null;
    }
    if (current !== facts.headSha) {
      say(`- SUPERSEDED: main moved to ${current ?? "unreadable"} after evaluation; no build requested (the next run evaluates the new head)`);
    } else {
      const triggeredAt = now();
      // The trigger is recorded BEFORE the hook is called, and the hook is not
      // called if that record cannot be written: an unrecorded build would
      // escape the in-flight window and the retry cap, and every later run would
      // call the hook again. A failed call then voids its record (HOOK_FAILED_PREFIX).
      const recorded = await setStatus(facts.headSha, d.status);
      const res = recorded ? await callDeployHook(String(env[HOOK_SECRET_NAME]).trim(), fetchImpl) : null;
      if (!recorded) {
        say("- the trigger record could not be written; the deploy hook was NOT called (retrying on the next run)");
      } else if (!res.ok) {
        say(`- deploy hook call FAILED (HTTP ${res.status ?? res.error}); retrying on the next run`);
        await setStatus(facts.headSha, { state: "pending", description: `${HOOK_FAILED_PREFIX} (HTTP ${res.status ?? res.error}); retrying on the next run` });
      } else {
        say(`- deploy hook accepted (HTTP ${res.status}, job ${res.jobId ?? "-"}) for ${facts.headSha}`);
        log(`::notice title=Web release continued::Vercel deploy hook called for ${facts.headSha} (live API ${la?.revision}).`);
        // Record WHICH commit Vercel builds: the hook builds main's HEAD at the moment Vercel resolves it.
        const deadline = triggeredAt + observeMs;
        let seen = null;
        while (!seen && now() < deadline) {
          await sleep(observeEveryMs);
          try {
            const latestHead = (await gh.mainHead()).sha;
            const st = byContext(await gh.statuses(latestHead), env.VERCEL_WEB_CONTEXT || VERCEL_WEB_CONTEXT);
            const fresh = st.find((s) => (ms(s.created_at) ?? 0) >= triggeredAt - 5_000);
            if (fresh) seen = { sha: latestHead, status: fresh };
          } catch {
            /* observation only */
          }
        }
        if (seen) {
          say(`- Vercel build observed for ${seen.sha}${seen.sha === facts.headSha ? " (the evaluated SHA)" : " (NEWER than the evaluated SHA: it passes the same gate and is evaluated on the next run)"}: ${seen.status.target_url ?? "-"}`);
        } else {
          say(`- no Vercel status within ${Math.round(observeMs / 1000)} s; the next run follows the build (in-flight window ${TRIGGER_IN_FLIGHT_MS / 60_000} min)`);
        }
      }
    }
  } else if (d.action === "promote" && !dryRun) {
    // Recorded first, like a trigger: an unrecorded promotion would repeat every run.
    const recorded = await setStatus(facts.headSha, d.status);
    if (!recorded) {
      say("- the promotion record could not be written; nothing was promoted (retrying on the next run)");
    } else {
      try {
        const vercel = makeVercel({ token: String(env.VERCEL_TOKEN).trim(), projectId: String(env.VERCEL_PROJECT_ID).trim(), teamId: env.VERCEL_TEAM_ID, fetchImpl });
        const dep = (await vercel.productionDeployments()).find((x) => x.sha === facts.headSha);
        if (!dep) throw new Error(`no READY production deployment of ${facts.headSha}`);
        await vercel.promote(dep.id);
        say(`- promoted Vercel deployment ${dep.url ?? dep.id} of ${facts.headSha}`);
        log(`::notice title=Web release promoted::${facts.headSha} promoted through the Vercel API (live API ${la?.revision}).`);
      } catch (e) {
        say(`- promotion FAILED (${e.message}); retrying on the next run`);
        await setStatus(facts.headSha, { state: "pending", description: `promotion failed (${String(e.message).slice(0, 80)}); retrying on the next run` });
        exitCode = 1;
      }
    }
  } else if (d.status) {
    await setStatus(facts.headSha, d.status);
  }

  if (d.outcome === "CONFIG_MISSING") log(`::error title=Waiting on owner configuration: ${HOOK_SECRET_NAME}::${d.status.description}`);
  if (d.outcome === "GAVE_UP" || d.outcome === "DEPLOYED_NOT_LIVE") log(`::error title=Web release continuation stopped::${d.status.description}`);
  if (d.outcome.startsWith("UNREADABLE") || d.outcome === "API_UNHEALTHY") log(`::warning title=Web release state unreadable::${d.status?.description ?? d.note}`);
  if (d.outcome === "CI_FAILED") log(`::warning title=Web release not continued::${d.status.description}`);

  // Older commits still showing "pending" will never deploy: say so.
  if (!dryRun && facts.headSha) {
    try {
      const older = git(["rev-list", `--max-count=${SUPERSEDE_LOOKBACK}`, `${facts.headSha}^`]).split("\n").map((s) => s.trim()).filter(Boolean);
      const commits = [];
      for (const sha of older) commits.push({ sha, ours: byContext(await gh.statuses(sha), STATUS_CONTEXT) });
      for (const t of supersedeTargets(facts.headSha, commits)) {
        if (await setStatus(t.sha, t.status)) say(`- marked ${SHORT(t.sha)} superseded`);
      }
    } catch (e) {
      log(`supersede scan skipped: ${e.message}`);
    }
  }

  if (env.GITHUB_STEP_SUMMARY) {
    try {
      appendFileSync(env.GITHUB_STEP_SUMMARY, `### Web release continuation\n\n\`\`\`\n${summary.join("\n")}\n\`\`\`\n`);
    } catch {
      /* summary is best effort */
    }
  }
  return exitCode;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const dryRun = process.argv.includes("--dry-run") || process.env.WEB_CONTINUATION_DRY_RUN === "1";
  runContinuation({ dryRun }).then(
    (code) => process.exit(code),
    (e) => {
      console.error(`web-continuation: FAILED unexpectedly: ${e?.message ?? e}`);
      process.exit(1);
    },
  );
}
