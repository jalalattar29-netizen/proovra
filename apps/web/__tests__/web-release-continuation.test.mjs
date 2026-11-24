/**
 * The web release continuation (scripts/release/web-continuation.mjs).
 *
 * A fake world stands in for GitHub (main HEAD, workflow runs, commit
 * statuses), the live web and API /health endpoints, the Vercel deploy hook
 * (which, like Vercel, starts a build of main's HEAD and posts a pending
 * status there) and git (a linear main history). Each scenario drives the real
 * runContinuation() end to end, run after run, and checks what it wrote and
 * whether it called the hook.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";

import { REQUIRED_WORKFLOWS } from "../../../scripts/release/image-publish-gate.mjs";
import {
  BACKEND_STATUS_CONTEXT,
  HOOK_SECRET_NAME,
  MAX_TRIGGERS_PER_API_REVISION,
  STATUS_CONTEXT,
  TRIGGER_IN_FLIGHT_MS,
  VERCEL_WEB_CONTEXT,
  ciState,
  classifyVercel,
  decideContinuation,
  effectiveTriggers,
  isDeployHookUrl,
  parseTrigger,
  runContinuation,
  supersedeTargets,
} from "../../../scripts/release/web-continuation.mjs";

const REPO = "o/r";
const HOOK = "https://api.vercel.com/v1/integrations/deploy/prj_abc123/hookXYZ";
const sha = (c) => c.repeat(40);
const C0 = sha("0");
const C1 = sha("1");
const C2 = sha("2");
const C3 = sha("3");
const MIN = 60_000;

const contractSource = (epoch) =>
  `export const PRESENTATION_CONTRACT_VERSION = 1;\nexport const PRESENTATION_CONTRACT_ROUTE_EPOCH = ${epoch};\n`;

/**
 * commits: [{ sha, epoch, api: boolean (touches API-facing source) }], oldest first.
 */
function makeWorld({ commits, main, web, api, ci = "success", hook = HOOK, start = Date.parse("2026-11-22T00:00:00Z"), backend = "verified" }) {
  const w = {
    commits,
    main,
    web,
    api: { status: 200, contract: 1, ...api },
    ci,
    // "verified": the live API revision carries release/backend success (the
    // automatic backend release verified it), unless a test posts its own.
    backend,
    clock: start,
    statuses: {},
    hookCalls: [],
    hookStatus: 200,
    gitCalls: [],
    fail: {},
    mainReads: 0,
    moveMainOnRead: null,
    env: { GITHUB_REPOSITORY: REPO, GITHUB_TOKEN: "t", GITHUB_SERVER_URL: "https://github.com", GITHUB_RUN_ID: "77", GITHUB_EVENT_NAME: "schedule" },
  };
  if (hook !== null) w.env[HOOK_SECRET_NAME] = hook;
  const idx = (s) => w.commits.findIndex((c) => c.sha === s);
  w.addStatus = (s, context, state, description, at = w.clock) => {
    (w.statuses[s] ??= []).push({ context, state, description, created_at: new Date(at).toISOString(), target_url: `https://x/${context}/${s.slice(0, 4)}` });
  };
  const res = (status, body, headers = {}) => ({
    status,
    headers: { get: (n) => headers[n.toLowerCase()] ?? null },
    json: async () => body,
    text: async () => JSON.stringify(body),
  });
  w.fetch = async (url, opts = {}) => {
    const u = String(url);
    const method = opts.method ?? "GET";
    if (u === HOOK || u.startsWith("https://api.vercel.com/")) {
      w.hookCalls.push({ main: w.main, at: w.clock });
      if (w.hookStatus !== 200) return res(w.hookStatus, {});
      w.addStatus(w.main, VERCEL_WEB_CONTEXT, "pending", "Vercel is deploying your app");
      return res(201, { job: { id: `job${w.hookCalls.length}` } });
    }
    if (u.startsWith("https://www.proovra.com/api/health")) {
      if (w.fail.web) throw new Error("web down");
      return res(200, { ok: true, revision: w.web });
    }
    if (u.startsWith("https://api.proovra.com/health")) {
      if (w.fail.api) throw Object.assign(new Error("connect ECONNREFUSED"), { name: "TypeError" });
      return res(w.api.status, { ok: w.api.status === 200, revision: w.api.revision }, {
        "x-proovra-contract": String(w.api.contract),
        "x-proovra-route-epoch": String(w.api.epoch),
      });
    }
    const p = u.replace("https://api.github.com", "");
    if (p === `/repos/${REPO}/commits/main`) {
      if (w.fail.main) return res(500, {});
      w.mainReads += 1;
      if (w.moveMainOnRead && w.mainReads === w.moveMainOnRead.at) w.main = w.moveMainOnRead.to;
      const c = w.commits[idx(w.main)];
      return res(200, { sha: w.main, commit: { committer: { date: new Date(c.at ?? start - 60 * MIN).toISOString() } } });
    }
    let m = /^\/repos\/o\/r\/actions\/workflows\/([^/]+)\/runs\?head_sha=([0-9a-f]+)/.exec(p);
    if (m) {
      if (w.fail.runs) return res(500, {});
      const state = typeof w.ci === "function" ? w.ci(m[1], m[2]) : w.ci;
      if (state === "missing") return res(200, { workflow_runs: [] });
      const run = { head_sha: m[2], event: "push", status: state === "running" ? "in_progress" : "completed", conclusion: state === "running" ? null : state, html_url: `https://gh/${m[1]}` };
      return res(200, { workflow_runs: [run] });
    }
    m = /^\/repos\/o\/r\/commits\/([0-9a-f]+)\/statuses/.exec(p);
    if (m) {
      if (w.fail.statuses) return res(500, {});
      const list = [...(w.statuses[m[1]] ?? [])].reverse();
      if (w.backend === "verified" && m[1] === w.api.revision && !list.some((x) => x.context === BACKEND_STATUS_CONTEXT)) {
        list.push({ context: BACKEND_STATUS_CONTEXT, state: "success", description: "backend live", created_at: new Date(start).toISOString() });
      }
      return res(200, list);
    }
    m = /^\/repos\/o\/r\/statuses\/([0-9a-f]+)$/.exec(p);
    if (m && method === "POST") {
      const b = JSON.parse(opts.body);
      if (w.fail.statusWrite?.(b)) return res(500, {});
      w.addStatus(m[1], b.context, b.state, b.description);
      return res(201, {});
    }
    throw new Error(`unrouted ${method} ${u}`);
  };
  w.git = (args) => {
    w.gitCalls.push(args);
    const [cmd] = args;
    if (["commit", "push", "tag", "update-ref"].includes(cmd)) throw new Error(`git ${cmd} must never run`);
    if (cmd === "cat-file") {
      const s = args[2].replace("^{commit}", "");
      if (idx(s) < 0) throw new Error("missing");
      return "";
    }
    if (cmd === "fetch") throw new Error("no network in tests");
    if (cmd === "merge-base") {
      const [a, b] = [idx(args[2]), idx(args[3])];
      if (a < 0 || b < 0) throw Object.assign(new Error("bad"), { status: 128 });
      if (a <= b) return "";
      throw Object.assign(new Error("not ancestor"), { status: 1 });
    }
    if (cmd === "show") {
      const [s, path] = args[1].split(":");
      const c = w.commits[idx(s)];
      if (path.endsWith("release-contract.ts")) return contractSource(c.epoch);
      if (path.endsWith("api.ts")) return 'const DEFAULT_API_BASE = "https://api.proovra.com";\n';
      throw new Error("no file");
    }
    if (cmd === "log") {
      const upto = idx(args[3]);
      for (let i = upto; i >= 0; i -= 1) if (w.commits[i].api) return `${w.commits[i].sha}\n`;
      return "";
    }
    if (cmd === "diff") {
      const [from, to] = [idx(args[2]), idx(args[3])];
      const files = [];
      for (let i = from + 1; i <= to; i += 1) if (w.commits[i].api) files.push(`services/api/src/routes/r${i}.ts`);
      return files.join("\n");
    }
    if (cmd === "rev-list") {
      const n = Number(args[1].split("=")[1]);
      const upto = idx(args[2].replace("^", "")) - 1;
      const out = [];
      for (let i = upto; i >= 0 && out.length < n; i -= 1) out.push(w.commits[i].sha);
      return out.join("\n");
    }
    throw new Error(`unexpected git ${args.join(" ")}`);
  };
  w.run = async (opts = {}) => {
    const lines = [];
    const code = await runContinuation({ env: w.env, fetchImpl: w.fetch, git: w.git, log: (l) => lines.push(l), now: () => w.clock, observeMs: 0, ...opts });
    return { code, lines, outcome: /web-continuation: (\S+)/.exec(lines[0])?.[1] };
  };
  w.ours = (s) => (w.statuses[s] ?? []).filter((x) => x.context === STATUS_CONTEXT);
  w.lastOurs = (s) => w.ours(s).at(-1);
  return w;
}

const noGitWrites = (w) =>
  assert.equal(w.gitCalls.filter((a) => ["commit", "push", "tag", "update-ref"].includes(a[0])).length, 0, "no git write, no empty commit");

test("A — a compatible web-only push: no action; the Git integration deploys it", async () => {
  const w = makeWorld({
    commits: [{ sha: C0, epoch: 4, api: true }, { sha: C1, epoch: 4, api: false }],
    main: C1,
    web: C0,
    api: { revision: C0, epoch: 4 },
  });
  w.addStatus(C1, VERCEL_WEB_CONTEXT, "pending", "Vercel is deploying your app");
  let r = await w.run();
  assert.equal(r.outcome, "BUILDING");
  assert.equal(w.hookCalls.length, 0);
  w.clock += 3 * MIN;
  w.addStatus(C1, VERCEL_WEB_CONTEXT, "success", "Deployment has completed");
  w.web = C1;
  r = await w.run();
  assert.equal(r.outcome, "WEB_CURRENT");
  assert.equal(r.code, 0);
  assert.equal(w.lastOurs(C1).state, "success");
  assert.equal(w.lastOurs(C1).description, `web live at ${C1.slice(0, 9)}`);
  assert.equal(w.hookCalls.length, 0);
  noGitWrites(w);
});

test("B — a backend-dependent push waits visibly, then continues the exact SHA once the API serves it", async () => {
  const w = makeWorld({
    commits: [{ sha: C0, epoch: 4, api: true }, { sha: C1, epoch: 5, api: true }],
    main: C1,
    web: C0,
    api: { revision: C0, epoch: 4 },
  });
  w.addStatus(C1, VERCEL_WEB_CONTEXT, "success", "Canceled by Ignored Build Step");
  w.clock += 20 * MIN;
  let r = await w.run();
  assert.equal(r.outcome, "WAITING_API");
  assert.equal(r.code, 0);
  assert.equal(w.lastOurs(C1).state, "pending");
  assert.match(w.lastOurs(C1).description, /^waiting for API epoch 5 \(live 4\), revision >= 111111111 \(live 000000000\); web stays at 000000000/);
  assert.equal(w.hookCalls.length, 0);

  // A second evaluation with nothing changed writes no duplicate status.
  const before = w.ours(C1).length;
  r = await w.run();
  assert.equal(r.outcome, "WAITING_API");
  assert.equal(w.ours(C1).length, before);

  // The operator deploys the backend at C1 on the host.
  w.clock += 30 * MIN;
  w.api = { status: 200, contract: 1, revision: C1, epoch: 5 };
  r = await w.run();
  assert.equal(r.outcome, "TRIGGER");
  assert.equal(w.hookCalls.length, 1);
  assert.equal(w.hookCalls[0].main, C1, "the hook built the SHA that was evaluated");
  assert.deepEqual(parseTrigger(w.lastOurs(C1).description), { sha: C1.slice(0, 9), apiRevision: C1.slice(0, 9), epoch: 5 });
  assert.ok(r.lines.some((l) => l.includes(`deploy hook accepted`) && l.includes(C1)));

  // Vercel builds; the next runs do nothing more.
  w.clock += 2 * MIN;
  r = await w.run();
  assert.equal(r.outcome, "BUILDING");
  w.clock += 4 * MIN;
  w.addStatus(C1, VERCEL_WEB_CONTEXT, "success", "Deployment has completed");
  w.web = C1;
  r = await w.run();
  assert.equal(r.outcome, "WEB_CURRENT");
  assert.equal(w.hookCalls.length, 1);
  noGitWrites(w);
});

test("B — the waiting status names API-facing drift when the epoch already matches", () => {
  const d = decideContinuation({
    now: 0, headSha: C1, liveWeb: { revision: C0 }, relation: "ahead",
    liveApi: { ok: true, status: 200, contract: 1, routeEpoch: 4, revision: C0 },
    own: { contract: 1, routeEpoch: 4 }, apiFacingDiff: ["services/api/src/a.ts", "packages/shared/src/b.ts"],
    requiredApiRevision: C1, ci: { state: "success" }, vercel: [{ state: "success", description: "Canceled by Ignored Build Step", created_at: "2026-01-01T00:00:00Z" }],
    ours: [], hookConfigured: true, hookValid: true,
  });
  assert.equal(d.outcome, "WAITING_API");
  assert.match(d.status.description, /^waiting for API revision >= 111111111 \(live 000000000, epoch 4\): 2 API-facing file\(s\) differ/);
  assert.equal(d.action, "none");
});

test("C — a failed backend: the web stays and the status says why", async () => {
  const w = makeWorld({
    commits: [{ sha: C0, epoch: 4, api: true }, { sha: C1, epoch: 5, api: true }],
    main: C1,
    web: C0,
    api: { revision: C0, epoch: 4, status: 503 },
  });
  w.addStatus(C1, VERCEL_WEB_CONTEXT, "success", "Canceled by Ignored Build Step");
  w.clock += 20 * MIN;
  let r = await w.run();
  assert.equal(r.outcome, "API_UNHEALTHY");
  assert.equal(w.lastOurs(C1).state, "error");
  assert.match(w.lastOurs(C1).description, /live API unhealthy \(HTTP 503\); web stays at 000000000, no promotion/);
  assert.equal(w.hookCalls.length, 0);

  // The backend deploy was rolled back to the old revision: still waiting, never promoted.
  w.api = { status: 200, contract: 1, revision: C0, epoch: 4 };
  r = await w.run();
  assert.equal(r.outcome, "WAITING_API");
  assert.equal(w.hookCalls.length, 0);

  // The API serves C1 but a required workflow failed on C1: not continued.
  w.api = { status: 200, contract: 1, revision: C1, epoch: 5 };
  w.ci = (file) => (file === "playwright-e2e.yml" ? "failure" : "success");
  r = await w.run();
  assert.equal(r.outcome, "CI_FAILED");
  assert.equal(w.lastOurs(C1).state, "failure");
  assert.match(w.lastOurs(C1).description, /required workflow playwright-e2e failure on 111111111; web not continued, stays at 000000000/);
  assert.equal(w.hookCalls.length, 0);

  // Required CI still running: waits.
  w.ci = (file) => (file === "ci.yml" ? "running" : "success");
  r = await w.run();
  assert.equal(r.outcome, "WAITING_CI");
  assert.equal(w.hookCalls.length, 0);
});

test("D — unreadable API, web or GitHub: never promotes, and the next run retries", async () => {
  const w = makeWorld({
    commits: [{ sha: C0, epoch: 4, api: true }, { sha: C1, epoch: 5, api: true }],
    main: C1,
    web: C0,
    api: { revision: C1, epoch: 5 },
  });
  w.addStatus(C1, VERCEL_WEB_CONTEXT, "success", "Canceled by Ignored Build Step");
  w.clock += 20 * MIN;

  w.fail.api = true;
  let r = await w.run();
  assert.equal(r.outcome, "UNREADABLE_API");
  assert.equal(w.lastOurs(C1).state, "pending");
  assert.match(w.lastOurs(C1).description, /^no promotion: live API unreadable/);
  w.fail.api = false;

  w.fail.web = true;
  r = await w.run();
  assert.equal(r.outcome, "UNREADABLE_WEB");
  w.fail.web = false;

  w.fail.statuses = true;
  r = await w.run();
  assert.equal(r.outcome, "UNREADABLE_VERCEL");
  w.fail.statuses = false;

  w.fail.runs = true;
  r = await w.run();
  assert.equal(r.outcome, "UNREADABLE_CI");
  w.fail.runs = false;

  w.fail.main = true;
  r = await w.run();
  assert.equal(r.outcome, "UNREADABLE_MAIN");
  w.fail.main = false;

  assert.equal(w.hookCalls.length, 0, "nothing was promoted while any fact was unreadable");
  r = await w.run();
  assert.equal(r.outcome, "TRIGGER", "the next readable run continues");
  assert.equal(w.hookCalls.length, 1);
});

test("E — two close pushes: the older commit is never built after the newer one", async () => {
  const w = makeWorld({
    commits: [{ sha: C0, epoch: 4, api: true }, { sha: C1, epoch: 5, api: true }, { sha: C2, epoch: 5, api: true }],
    main: C1,
    web: C0,
    api: { revision: C0, epoch: 4 },
  });
  w.addStatus(C1, VERCEL_WEB_CONTEXT, "success", "Canceled by Ignored Build Step");
  w.clock += 20 * MIN;
  let r = await w.run();
  assert.equal(r.outcome, "WAITING_API");

  // C2 lands; its own push build is refused too.
  w.main = C2;
  w.commits[2].at = w.clock;
  w.addStatus(C2, VERCEL_WEB_CONTEXT, "success", "Canceled by Ignored Build Step");
  // The API is deployed at C1 only: C1 would be compatible, but C1 is not main HEAD.
  w.api = { status: 200, contract: 1, revision: C1, epoch: 5 };
  r = await w.run();
  assert.equal(r.outcome, "WAITING_API", "C2 still needs a newer API");
  assert.equal(w.hookCalls.length, 0, "C1 is never triggered once C2 is main");
  assert.equal(w.lastOurs(C1).state, "error");
  assert.match(w.lastOurs(C1).description, /^superseded by 222222222: not deployed/);

  // API reaches C2: only C2 continues.
  w.api = { status: 200, contract: 1, revision: C2, epoch: 5 };
  r = await w.run();
  assert.equal(r.outcome, "TRIGGER");
  assert.deepEqual(w.hookCalls.map((c) => c.main), [C2]);
  assert.equal(w.ours(C1).filter((s) => parseTrigger(s.description)).length, 0);
});

test("E — main moves between evaluation and the hook call: no build is requested", async () => {
  const w = makeWorld({
    commits: [{ sha: C0, epoch: 4, api: true }, { sha: C1, epoch: 5, api: true }, { sha: C2, epoch: 5, api: true }],
    main: C1,
    web: C0,
    api: { revision: C1, epoch: 5 },
  });
  w.addStatus(C1, VERCEL_WEB_CONTEXT, "success", "Canceled by Ignored Build Step");
  w.clock += 20 * MIN;
  w.moveMainOnRead = { at: 2, to: C2 };
  const r = await w.run();
  assert.equal(r.outcome, "TRIGGER");
  assert.ok(r.lines.some((l) => l.startsWith("- SUPERSEDED: main moved to 222")));
  assert.equal(w.hookCalls.length, 0);
});

test("E — a head older than the live web is never deployed", () => {
  const d = decideContinuation({
    now: 0, headSha: C1, liveWeb: { revision: C2 }, relation: "older",
    liveApi: { ok: true, status: 200, contract: 1, routeEpoch: 5, revision: C2 }, own: { contract: 1, routeEpoch: 5 },
    apiFacingDiff: [], ci: { state: "success" }, vercel: [], ours: [], hookConfigured: true, hookValid: true,
  });
  assert.equal(d.outcome, "STALE_HEAD");
  assert.equal(d.action, "none");
});

test("F — retries after a temporary failure never duplicate a pending build, and never commit", async () => {
  const w = makeWorld({
    commits: [{ sha: C0, epoch: 4, api: true }, { sha: C1, epoch: 5, api: true }],
    main: C1,
    web: C0,
    api: { revision: C1, epoch: 5 },
  });
  w.addStatus(C1, VERCEL_WEB_CONTEXT, "success", "Canceled by Ignored Build Step");
  w.clock += 20 * MIN;

  // The hook endpoint fails once: recorded as a failure, not as a trigger.
  w.hookStatus = 500;
  let r = await w.run();
  assert.equal(w.hookCalls.length, 1);
  assert.match(w.lastOurs(C1).description, /^deploy hook call failed \(HTTP 500\)/);
  assert.equal(parseTrigger(w.lastOurs(C1).description), null);

  // Next run retries and succeeds, but Vercel has not posted anything yet.
  w.hookStatus = 200;
  w.clock += 10 * MIN;
  const realAdd = w.addStatus;
  w.addStatus = (s, ctx, ...rest) => (ctx === VERCEL_WEB_CONTEXT ? undefined : realAdd(s, ctx, ...rest));
  r = await w.run();
  assert.equal(r.outcome, "TRIGGER");
  assert.equal(w.hookCalls.length, 2);

  // Inside the in-flight window: no second call.
  for (const step of [5, 10, 10]) {
    w.clock += step * MIN;
    r = await w.run();
    assert.equal(r.outcome, "TRIGGER_IN_FLIGHT");
  }
  assert.equal(w.hookCalls.length, 2);

  // Past the window with no Vercel report: the build counts as lost and is requested again, up to the cap.
  w.addStatus = realAdd;
  w.clock += TRIGGER_IN_FLIGHT_MS;
  r = await w.run();
  assert.equal(r.outcome, "TRIGGER");
  assert.equal(w.hookCalls.length, 3);
  // That build is refused by the gate (Vercel posts the cancellation after the trigger).
  w.clock += 2 * MIN;
  w.addStatus(C1, VERCEL_WEB_CONTEXT, "success", "Canceled by Ignored Build Step");
  r = await w.run();
  assert.equal(r.outcome, "TRIGGER");
  assert.equal(w.hookCalls.length, 4);
  w.clock += 2 * MIN;
  w.addStatus(C1, VERCEL_WEB_CONTEXT, "success", "Canceled by Ignored Build Step");
  r = await w.run();
  assert.equal(r.outcome, "GAVE_UP");
  assert.equal(r.code, 1);
  // Four records were written (each before its call); the first is voided by its recorded hook failure.
  assert.equal(w.ours(C1).filter((s) => parseTrigger(s.description)).length, MAX_TRIGGERS_PER_API_REVISION + 1);
  assert.equal(effectiveTriggers([...w.ours(C1)].reverse()).length, MAX_TRIGGERS_PER_API_REVISION);
  assert.equal(w.hookCalls.length, 4, "no further calls after the cap");
  noGitWrites(w);
});

test("missing hook secret: a specific 'waiting on owner configuration' status, red only when a continuation is due", async () => {
  const w = makeWorld({
    commits: [{ sha: C0, epoch: 4, api: true }, { sha: C1, epoch: 5, api: true }],
    main: C1,
    web: C0,
    api: { revision: C0, epoch: 4 },
    hook: null,
  });
  w.addStatus(C1, VERCEL_WEB_CONTEXT, "success", "Canceled by Ignored Build Step");
  w.clock += 20 * MIN;
  let r = await w.run();
  assert.equal(r.outcome, "WAITING_API");
  assert.equal(r.code, 0);
  assert.ok(r.lines.some((l) => l.startsWith(`::warning title=Owner configuration: ${HOOK_SECRET_NAME}`)));

  w.api = { status: 200, contract: 1, revision: C1, epoch: 5 };
  r = await w.run();
  assert.equal(r.outcome, "CONFIG_MISSING");
  assert.equal(r.code, 1);
  assert.equal(w.lastOurs(C1).state, "error");
  assert.match(w.lastOurs(C1).description, /^waiting on owner configuration: VERCEL_WEB_DEPLOY_HOOK_URL; web 111111111 is ready/);
  assert.ok(r.lines.some((l) => l.startsWith(`::error title=Waiting on owner configuration: ${HOOK_SECRET_NAME}`)));
  assert.equal(w.hookCalls.length, 0);

  w.env[HOOK_SECRET_NAME] = "https://example.com/hook";
  r = await w.run();
  assert.equal(r.outcome, "CONFIG_MISSING");
  assert.match(w.lastOurs(C1).description, /\(not a Vercel deploy hook URL\)/);
  assert.equal(w.hookCalls.length, 0);
  assert.ok(!r.lines.join("\n").includes("example.com/hook"), "the secret value is never logged");
});

test("dry run writes nothing and calls no hook", async () => {
  const w = makeWorld({
    commits: [{ sha: C0, epoch: 4, api: true }, { sha: C1, epoch: 5, api: true }],
    main: C1,
    web: C0,
    api: { revision: C1, epoch: 5 },
  });
  w.addStatus(C1, VERCEL_WEB_CONTEXT, "success", "Canceled by Ignored Build Step");
  w.clock += 20 * MIN;
  const r = await w.run({ dryRun: true });
  assert.equal(r.outcome, "TRIGGER");
  assert.equal(w.hookCalls.length, 0);
  assert.equal(w.ours(C1).length, 0);
  assert.ok(!r.lines.join("\n").includes(HOOK), "the hook URL is never logged");
});

test("a fresh push gets time for Vercel to report before anything happens", () => {
  const d = decideContinuation({
    now: 5 * MIN, headSha: C1, headCommittedAt: 0, liveWeb: { revision: C0 }, relation: "ahead",
    liveApi: { ok: true, status: 200, contract: 1, routeEpoch: 4, revision: C0 }, own: { contract: 1, routeEpoch: 4 },
    apiFacingDiff: [], ci: { state: "pending", detail: "ci" }, vercel: [], ours: [], hookConfigured: true, hookValid: true,
  });
  assert.equal(d.outcome, "AWAITING_VERCEL");
  assert.equal(d.action, "none");
});

test("helpers: ciState, classifyVercel, isDeployHookUrl, supersedeTargets", () => {
  const all = (state) => Object.fromEntries(REQUIRED_WORKFLOWS.map((wf) => [wf.file, [{ head_sha: C1, event: "push", status: "completed", conclusion: state }]]));
  assert.equal(ciState(all("success"), C1).state, "success");
  assert.equal(ciState(all("failure"), C1).state, "failure");
  assert.equal(ciState({ ...all("success"), "ci.yml": [] }, C1).state, "pending");
  assert.equal(ciState({ ...all("success"), "ci.yml": [{ head_sha: C1, event: "pull_request", status: "completed", conclusion: "success" }] }, C1).state, "pending", "a PR run is not the pushed commit");
  assert.equal(ciState(null, C1).state, "unknown");
  // A re-run attempt that went green after a flake is the verdict.
  const rerun = all("success");
  rerun["ci.yml"] = [
    { head_sha: C1, event: "push", status: "completed", conclusion: "failure", run_attempt: 1 },
    { head_sha: C1, event: "push", status: "completed", conclusion: "success", run_attempt: 2 },
  ];
  assert.equal(ciState(rerun, C1).state, "success");

  assert.equal(classifyVercel([]).kind, "absent");
  assert.equal(classifyVercel([{ state: "success", description: "Canceled by Ignored Build Step" }]).kind, "refused");
  assert.equal(classifyVercel([{ state: "success", description: "Deployment has completed" }]).kind, "deployed");
  assert.equal(classifyVercel([{ state: "failure", description: "Deployment has failed" }]).kind, "failed");
  assert.equal(classifyVercel([{ state: "pending", description: "Vercel is deploying your app" }]).kind, "building");

  assert.ok(isDeployHookUrl(HOOK));
  assert.ok(!isDeployHookUrl("https://api.vercel.com/v13/deployments"));
  assert.ok(!isDeployHookUrl("http://api.vercel.com/v1/integrations/deploy/a/b"));
  assert.ok(!isDeployHookUrl(""));

  const t = supersedeTargets(C3, [
    { sha: C2, ours: [{ state: "pending", description: "waiting for API epoch 5 (live 4)" }] },
    { sha: C1, ours: [{ state: "success", description: "web live at 111111111" }] },
    { sha: C0, ours: [] },
  ]);
  assert.deepEqual(t.map((x) => x.sha), [C2]);
});

test("L5 — the trigger is recorded before the hook is called; an unwritable record means no call, and a recorded call is never repeated", async () => {
  const w = makeWorld({
    commits: [{ sha: C0, epoch: 4, api: true }, { sha: C1, epoch: 5, api: true }],
    main: C1,
    web: C0,
    api: { revision: C1, epoch: 5 },
  });
  w.addStatus(C1, VERCEL_WEB_CONTEXT, "success", "Canceled by Ignored Build Step");
  w.clock += 20 * MIN;
  // Vercel never reports, so only the trigger record can stop a repeat.
  const realAdd = w.addStatus;
  w.addStatus = (s, ctx, ...rest) => (ctx === VERCEL_WEB_CONTEXT ? undefined : realAdd(s, ctx, ...rest));

  // 1. The GitHub status write fails: the hook is NOT called, and the run is red.
  w.fail.statusWrite = () => true;
  let r = await w.run();
  assert.equal(r.outcome, "TRIGGER");
  assert.equal(r.code, 1);
  assert.equal(w.hookCalls.length, 0);
  assert.ok(r.lines.some((l) => l.includes("the deploy hook was NOT called")));

  // 2. Writes work again: recorded, then called once.
  w.fail.statusWrite = null;
  w.clock += 10 * MIN;
  r = await w.run();
  assert.equal(w.hookCalls.length, 1);
  const order = w.ours(C1).map((s) => s.description);
  assert.ok(parseTrigger(order.at(-1)), "the trigger record is the last write, made before the call");

  // 3. Every status write fails from now on: the next runs inside the window still do not call again.
  w.fail.statusWrite = () => true;
  for (const step of [10, 10]) {
    w.clock += step * MIN;
    r = await w.run();
    assert.equal(r.outcome, "TRIGGER_IN_FLIGHT");
  }
  assert.equal(w.hookCalls.length, 1);
});

test("L5 — a failed hook call voids its record, but only when the failure itself was recorded", async () => {
  const w = makeWorld({
    commits: [{ sha: C0, epoch: 4, api: true }, { sha: C1, epoch: 5, api: true }],
    main: C1,
    web: C0,
    api: { revision: C1, epoch: 5 },
  });
  w.addStatus(C1, VERCEL_WEB_CONTEXT, "success", "Canceled by Ignored Build Step");
  w.clock += 20 * MIN;
  // Hook refuses; the failure note cannot be written: the record stands (conservative), so the next run waits.
  w.hookStatus = 500;
  w.fail.statusWrite = (b) => b.description.startsWith("deploy hook call failed");
  await w.run();
  assert.equal(w.hookCalls.length, 1);
  w.clock += 10 * MIN;
  let r = await w.run();
  assert.equal(r.outcome, "TRIGGER_IN_FLIGHT");
  assert.equal(w.hookCalls.length, 1);

  // Repeated hook failures, each recorded: the voided records do not count toward the cap.
  w.fail.statusWrite = null;
  w.clock += TRIGGER_IN_FLIGHT_MS;
  for (let i = 0; i < MAX_TRIGGERS_PER_API_REVISION + 1; i += 1) {
    r = await w.run();
    assert.equal(r.outcome, "TRIGGER");
    w.clock += 10 * MIN;
  }
  assert.equal(w.hookCalls.length, 2 + MAX_TRIGGERS_PER_API_REVISION);
  assert.equal(effectiveTriggers([...w.ours(C1)].reverse()).length, 1, "only the unvoided record counts");
});

// ---------------------------------------------------------------------------
// Automatic backend release (2026-11-24): the web follows a VERIFIED backend.

test("G — a backend release in progress, unverified or never verified promotes no web; a verified one does", async () => {
  const w = makeWorld({
    commits: [{ sha: C0, epoch: 4, api: true }, { sha: C1, epoch: 5, api: true }],
    main: C1,
    web: C0,
    api: { revision: C1, epoch: 5 },
    backend: "none",
  });
  w.addStatus(C1, VERCEL_WEB_CONTEXT, "success", "Canceled by Ignored Build Step");
  w.clock += 20 * MIN;

  // The API already answers as C1, but no backend release verified it.
  let r = await w.run();
  assert.equal(r.outcome, "WAITING_BACKEND");
  assert.match(w.lastOurs(C1).description, /^waiting for a verified backend release of live API 111111111 \(release\/backend\); web stays at 000000000/);
  assert.equal(w.hookCalls.length, 0);

  // The automatic release is still running (worker, API, verification).
  w.addStatus(C1, BACKEND_STATUS_CONTEXT, "pending", "deploying 111111111 over 000000000: backup, worker, API, verification");
  r = await w.run();
  assert.equal(r.outcome, "WAITING_BACKEND");
  assert.match(w.lastOurs(C1).description, /^waiting for backend verification of 111111111 \(release in progress\)/);
  assert.equal(w.hookCalls.length, 0);

  // Verification failed (the public API disagreed with the host): held.
  w.clock += MIN;
  w.addStatus(C1, BACKEND_STATUS_CONTEXT, "error", "verification failed: 111111111 deployed but the public API says revision 000000000");
  r = await w.run();
  assert.equal(r.outcome, "HELD_BACKEND_FAILED");
  assert.equal(w.lastOurs(C1).state, "failure");
  assert.equal(w.hookCalls.length, 0);

  // A later verified release of the same commit (a dispatched retry) releases the web once.
  w.clock += MIN;
  w.addStatus(C1, BACKEND_STATUS_CONTEXT, "success", "backend live at 111111111: api+worker revision, readiness, epoch 5 verified");
  r = await w.run();
  assert.equal(r.outcome, "TRIGGER");
  assert.equal(w.hookCalls.length, 1);
  assert.equal(w.hookCalls[0].main, C1);
  noGitWrites(w);
});

test("G — a live API whose backend release is unverified for another reason holds the web", () => {
  const d = decideContinuation({
    now: 0, headSha: C2, liveWeb: { revision: C0 }, relation: "ahead",
    liveApi: { ok: true, status: 200, contract: 1, routeEpoch: 5, revision: C1 },
    own: { contract: 1, routeEpoch: 5 }, apiFacingDiff: [], requiredApiRevision: C1,
    ci: { state: "success" }, vercel: [{ state: "success", description: "Canceled by Ignored Build Step", created_at: "2026-01-01T00:00:00Z" }],
    ours: [], hookConfigured: true, hookValid: true,
    backendHead: [],
    backendLive: [{ state: "error", description: "deploy failed and the rollback to 000000000 did NOT verify: operator needed now", created_at: "2026-01-01T00:00:00Z" }],
  });
  assert.equal(d.outcome, "HELD_BACKEND_UNVERIFIED");
  assert.equal(d.action, "none");
  const unreadable = decideContinuation({
    now: 0, headSha: C2, liveWeb: { revision: C0 }, relation: "ahead",
    liveApi: { ok: true, status: 200, contract: 1, routeEpoch: 5, revision: C1 },
    own: { contract: 1, routeEpoch: 5 }, apiFacingDiff: [], requiredApiRevision: C1,
    ci: { state: "success" }, vercel: [{ state: "success", description: "Canceled by Ignored Build Step", created_at: "2026-01-01T00:00:00Z" }],
    ours: [], hookConfigured: true, hookValid: true, backendHead: [], backendLive: null,
  });
  assert.equal(unreadable.outcome, "UNREADABLE_BACKEND");
  assert.equal(unreadable.action, "none");
});

test("G — the backend release of HEAD was rolled back: its web is held even when the gate would pass", async () => {
  // C1 changes only web code, so the gate would build it against the restored C0 API.
  const w = makeWorld({
    commits: [{ sha: C0, epoch: 4, api: true }, { sha: C1, epoch: 4, api: false }],
    main: C1,
    web: C0,
    api: { revision: C0, epoch: 4 },
  });
  w.addStatus(C1, VERCEL_WEB_CONTEXT, "success", "Canceled by Ignored Build Step");
  w.addStatus(C1, BACKEND_STATUS_CONTEXT, "failure", "deploy failed; rolled back to 000000000 (verified)");
  w.clock += 20 * MIN;
  const r = await w.run();
  assert.equal(r.outcome, "HELD_BACKEND_FAILED");
  assert.match(w.lastOurs(C1).description, /^held: the backend release of 111111111 did not stay live \(deploy failed; rolled back to 000000000/);
  assert.equal(w.hookCalls.length, 0);
});

test("G — after a web rollback Vercel stops auto-assigning: the next compatible release is promoted once, only with the Vercel API configured", async () => {
  const w = makeWorld({
    commits: [{ sha: C0, epoch: 4, api: true }, { sha: C1, epoch: 4, api: false }],
    main: C1,
    web: C0,
    api: { revision: C0, epoch: 4 },
  });
  w.addStatus(C1, VERCEL_WEB_CONTEXT, "success", "Deployment has completed");
  w.clock += 20 * MIN;
  let r = await w.run();
  assert.equal(r.outcome, "DEPLOYED_NOT_LIVE");
  assert.equal(r.code, 1);
  assert.match(w.lastOurs(C1).description, /promote it, or configure VERCEL_TOKEN \+ VERCEL_PROJECT_ID/);

  const promotes = [];
  const base = w.fetch;
  w.fetch = async (url, opts = {}) => {
    const u = String(url);
    if (u.startsWith("https://api.vercel.com/v6/deployments")) {
      assert.match(u, /projectId=prj_web&target=production&state=READY/);
      return { status: 200, headers: { get: () => null }, json: async () => ({ deployments: [{ uid: "dpl_c1", url: "c1.vercel.app", meta: { githubCommitSha: C1 }, createdAt: 2 }, { uid: "dpl_c0", url: "c0.vercel.app", meta: { githubCommitSha: C0 }, createdAt: 1 }] }) };
    }
    if (u.startsWith("https://api.vercel.com/v10/projects/prj_web/promote/")) {
      promotes.push(u);
      return { status: 201, headers: { get: () => null }, json: async () => ({}) };
    }
    return base(url, opts);
  };
  w.env.VERCEL_TOKEN = "vt";
  w.env.VERCEL_PROJECT_ID = "prj_web";
  r = await w.run();
  assert.equal(r.outcome, "PROMOTE");
  assert.equal(r.code, 0);
  assert.deepEqual(promotes.map((u) => u.split("?")[0]), ["https://api.vercel.com/v10/projects/prj_web/promote/dpl_c1"]);
  assert.match(w.lastOurs(C1).description, /^promoted web 111111111 via the Vercel API \(api 000000000 epoch 4\)/);
  assert.equal(w.hookCalls.length, 0, "a promotion is not a rebuild");

  // The next run inside the in-flight window does not promote again.
  w.clock += 2 * MIN;
  r = await w.run();
  assert.equal(r.outcome, "PROMOTE_IN_FLIGHT");
  assert.equal(promotes.length, 1);
  w.web = C1;
  r = await w.run();
  assert.equal(r.outcome, "WEB_CURRENT");
  noGitWrites(w);
});
