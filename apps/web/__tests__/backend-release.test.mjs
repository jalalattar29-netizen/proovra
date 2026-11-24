/**
 * The automatic production backend release (scripts/release/backend-release.mjs).
 *
 * A fake world stands in for GitHub (main HEAD, required workflow runs, commit
 * statuses, the workflow dispatch), GHCR (token, manifests, image configs), the
 * live API and web /health, Vercel's REST API and git (a linear history). The
 * gate, the finish step and the web rollback are driven end to end.
 */
import { strict as assert } from "node:assert";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  STATUS_CONTEXT,
  chooseCompatibleWeb,
  decideBackendRelease,
  decideFinish,
  parseHostOutput,
  readImageRevision,
  runFinish,
  runGate,
  runRollbackWeb,
  webCompatibleWith,
} from "../../../scripts/release/backend-release.mjs";

const sha = (c) => c.repeat(40);
const C0 = sha("0");
const C1 = sha("1");
const C2 = sha("2");
const contractSource = (epoch) => `export const PRESENTATION_CONTRACT_VERSION = 1;\nexport const PRESENTATION_CONTRACT_ROUTE_EPOCH = ${epoch};\n`;
const noSleep = async () => {};

function res(status, body, headers = {}) {
  return { status, ok: status >= 200 && status < 300, headers: { get: (n) => headers[n.toLowerCase()] ?? null }, json: async () => body };
}

/** commits: [{ sha, epoch, api }], oldest first. */
function makeWorld({ commits, main, api, web, images = {}, ci = "success" }) {
  const w = {
    commits, main, api: { status: 200, contract: 1, readyz: 200, ...api }, web, ci,
    images: { api: C1, worker: C1, ...images }, // tag sha-1111111 → revision
    statuses: {}, dispatches: [], promotes: [], vercelDeployments: [],
    env: { GITHUB_REPOSITORY: "o/r", GITHUB_REPOSITORY_OWNER: "o", GITHUB_TOKEN: "t", GITHUB_SERVER_URL: "https://github.com", GITHUB_RUN_ID: "9" },
  };
  const idx = (s) => w.commits.findIndex((c) => c.sha === s);
  w.fetch = async (url, opts = {}) => {
    const u = String(url);
    const method = opts.method ?? "GET";
    if (u.startsWith("https://ghcr.io/token")) return res(200, { token: "anon" });
    let m = /^https:\/\/ghcr\.io\/v2\/o\/proovra-(api|worker)\/manifests\/(.+)$/.exec(u);
    if (m) {
      const [, svc, ref] = m;
      if (ref.startsWith("sha-")) {
        const rev = w.images[svc];
        if (!rev || !rev.startsWith(ref.slice(4))) return res(404, {});
        return res(200, { manifests: [{ digest: `sha256:${svc}-${rev}`, platform: { os: "linux", architecture: "amd64" } }] }, { "docker-content-digest": `sha256:idx-${svc}` });
      }
      return res(200, { config: { digest: ref.replace("sha256:", "sha256:cfg-") } });
    }
    m = /^https:\/\/ghcr\.io\/v2\/o\/proovra-(api|worker)\/blobs\/sha256:cfg-(api|worker)-([0-9a-f]{40})$/.exec(u);
    if (m) return res(200, { config: { Labels: { "org.opencontainers.image.revision": m[3] } } });
    if (u === "https://api.proovra.com/health") {
      return res(w.api.status, { revision: w.api.revision }, { "x-proovra-contract": String(w.api.contract), "x-proovra-route-epoch": String(w.api.epoch) });
    }
    if (u === "https://api.proovra.com/readyz") return res(w.api.readyz, {});
    if (u === "https://www.proovra.com/api/health") return res(200, { revision: w.web });
    if (u.startsWith("https://api.vercel.com/v6/deployments")) return res(200, { deployments: w.vercelDeployments });
    m = /^https:\/\/api\.vercel\.com\/v10\/projects\/prj\/promote\/([^?]+)/.exec(u);
    if (m && method === "POST") {
      w.promotes.push(m[1]);
      const d = w.vercelDeployments.find((x) => x.uid === m[1]);
      if (d) w.web = d.meta.githubCommitSha;
      return res(201, {});
    }
    const p = u.replace("https://api.github.com", "");
    if (p === "/repos/o/r/commits/main") return res(200, { sha: w.main, commit: { committer: { date: "2026-11-24T00:00:00Z" } } });
    m = /^\/repos\/o\/r\/actions\/workflows\/([^/]+)\/runs\?head_sha=([0-9a-f]+)/.exec(p);
    if (m) {
      const state = typeof w.ci === "function" ? w.ci(m[1]) : w.ci;
      return res(200, { workflow_runs: [{ head_sha: m[2], event: "push", status: state === "running" ? "in_progress" : "completed", conclusion: state === "running" ? null : state }] });
    }
    m = /^\/repos\/o\/r\/commits\/([0-9a-f]+)\/statuses/.exec(p);
    if (m) return res(200, [...(w.statuses[m[1]] ?? [])].reverse());
    m = /^\/repos\/o\/r\/statuses\/([0-9a-f]+)$/.exec(p);
    if (m && method === "POST") {
      const b = JSON.parse(opts.body);
      (w.statuses[m[1]] ??= []).push({ ...b, created_at: new Date(Date.parse("2026-11-24T00:00:00Z") + (w.statuses[m[1]]?.length ?? 0) * 1000).toISOString() });
      return res(201, {});
    }
    if (p === "/repos/o/r/actions/workflows/web-release-continuation.yml/dispatches" && method === "POST") {
      w.dispatches.push(JSON.parse(opts.body));
      return res(204, {});
    }
    throw new Error(`unrouted ${method} ${u}`);
  };
  w.git = (args) => {
    const [cmd] = args;
    if (["commit", "push", "tag", "update-ref"].includes(cmd)) throw new Error(`git ${cmd} must never run`);
    if (cmd === "cat-file") {
      if (idx(args[2].replace("^{commit}", "")) < 0) throw new Error("missing");
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
      if (path.endsWith("release-contract.ts")) return contractSource(w.commits[idx(s)].epoch);
      throw new Error("no file");
    }
    if (cmd === "diff") {
      const [from, to] = [idx(args[2]), idx(args[3])];
      const files = [];
      for (let i = Math.min(from, to) + 1; i <= Math.max(from, to); i += 1) if (w.commits[i].api) files.push(`services/api/src/r${i}.ts`);
      return files.join("\n");
    }
    throw new Error(`unexpected git ${args.join(" ")}`);
  };
  w.ours = (s) => (w.statuses[s] ?? []).filter((x) => x.context === STATUS_CONTEXT);
  w.last = (s) => w.ours(s).at(-1);
  w.gate = async (extra = {}) => {
    const lines = [];
    const out = join(mkdtempSync(join(tmpdir(), "br-")), "out");
    writeFileSync(out, "");
    const env = { ...w.env, HAS_SSH_KEY: "true", HAS_SSH_TARGET: "true", HAS_KNOWN_HOSTS: "true", GITHUB_OUTPUT: out, ...extra };
    const code = await runGate({ env, fetchImpl: w.fetch, git: w.git, log: (l) => lines.push(l) });
    const { readFileSync } = await import("node:fs");
    const outputs = Object.fromEntries(readFileSync(out, "utf8").trim().split("\n").filter(Boolean).map((l) => l.split("=")));
    return { code, lines, outputs };
  };
  w.finish = async (hostText, extra = {}) => {
    const dir = mkdtempSync(join(tmpdir(), "br-"));
    const log = join(dir, "host.log");
    writeFileSync(log, hostText);
    const lines = [];
    const code = await runFinish({ env: { ...w.env, HOST_LOG: log, ...extra }, fetchImpl: w.fetch, git: w.git, log: (l) => lines.push(l), sleep: noSleep });
    return { code, lines };
  };
  return w;
}

const HISTORY = [{ sha: C0, epoch: 4, api: true }, { sha: C1, epoch: 5, api: true }, { sha: C2, epoch: 5, api: false }];

test("gate — the exact published, green main HEAD over an older live release is DEPLOYED, with a pending status first", async () => {
  const w = makeWorld({ commits: HISTORY, main: C1, api: { revision: C0, epoch: 4 }, web: C0 });
  const r = await w.gate({ RELEASE_SHA: C1 });
  assert.equal(r.code, 0);
  assert.equal(r.outputs.action, "deploy");
  assert.equal(r.outputs.epoch, "5");
  assert.equal(w.last(C1).state, "pending");
  assert.match(w.last(C1).description, /^deploying 111111111 over 000000000: backup, worker, API, verification/);
});

test("gate — never deploys: unpublished images, a superseded commit, red CI, a newer live API, a mislabelled image", async () => {
  // deploy-images completed without publishing (one of several completions per commit).
  let w = makeWorld({ commits: HISTORY, main: C1, api: { revision: C0, epoch: 4 }, web: C0, images: { api: null } });
  let r = await w.gate({ RELEASE_SHA: C1 });
  assert.equal(r.outputs.action, "none");
  assert.equal(r.outputs.outcome, "NOT_PUBLISHED");
  assert.equal(r.code, 0);
  assert.equal(w.ours(C1).length, 0, "no status: nothing was claimed");

  // main moved on: the older commit is never deployed, and says so.
  w = makeWorld({ commits: HISTORY, main: C2, api: { revision: C0, epoch: 4 }, web: C0 });
  r = await w.gate({ RELEASE_SHA: C1 });
  assert.equal(r.outputs.outcome, "SUPERSEDED");
  assert.equal(w.last(C1).state, "error");
  assert.match(w.last(C1).description, /^superseded by 222222222: not deployed/);

  // a required workflow is red on the SHA.
  w = makeWorld({ commits: HISTORY, main: C1, api: { revision: C0, epoch: 4 }, web: C0, ci: (f) => (f === "playwright-e2e.yml" ? "failure" : "success") });
  r = await w.gate({ RELEASE_SHA: C1 });
  assert.equal(r.outputs.outcome, "CI_FAILED");
  assert.equal(r.code, 1);
  assert.equal(w.last(C1).state, "failure");

  // the live API is NEWER than the release (out of order).
  w = makeWorld({ commits: HISTORY, main: C1, api: { revision: C2, epoch: 5 }, web: C0 });
  r = await w.gate({ RELEASE_SHA: C1 });
  assert.equal(r.outputs.outcome, "LIVE_NEWER");
  assert.equal(r.code, 1);
  assert.match(w.last(C1).description, /never deployed out of order/);

  // the tag exists but carries another revision.
  w = makeWorld({ commits: HISTORY, main: C1, api: { revision: C0, epoch: 4 }, web: C0, images: { worker: "1111111" + "f".repeat(33) } });
  r = await w.gate({ RELEASE_SHA: C1 });
  assert.equal(r.outputs.outcome, "IMAGE_REVISION_MISMATCH");
  assert.equal(r.code, 1);
});

test("gate — missing owner configuration is a red, named waiting state, never a silent skip", async () => {
  const w = makeWorld({ commits: HISTORY, main: C1, api: { revision: C0, epoch: 4 }, web: C0 });
  const r = await w.gate({ RELEASE_SHA: C1, HAS_SSH_KEY: "false" });
  assert.equal(r.code, 1);
  assert.equal(r.outputs.action, "none");
  assert.equal(w.last(C1).state, "error");
  assert.match(w.last(C1).description, /^waiting on owner configuration \(production environment: secret PROD_RELEASE_SSH_KEY/);
});

test("gate — a release already live is verified, not redeployed; an automatic event never retries a failed release", async () => {
  let w = makeWorld({ commits: HISTORY, main: C1, api: { revision: C1, epoch: 5 }, web: C0 });
  let r = await w.gate({ RELEASE_SHA: C1 });
  assert.equal(r.outputs.action, "verify");

  w = makeWorld({ commits: HISTORY, main: C1, api: { revision: C0, epoch: 4 }, web: C0 });
  w.statuses[C1] = [{ context: STATUS_CONTEXT, state: "failure", description: "deploy failed; rolled back to 000000000 (verified)", created_at: "2026-11-23T00:00:00Z" }];
  r = await w.gate({ RELEASE_SHA: C1 });
  assert.equal(r.outputs.outcome, "HELD_AFTER_FAILURE");
  assert.equal(r.outputs.action, "none");
  // A deliberate dispatch retries it.
  r = await w.gate({ RELEASE_SHA: C1, RELEASE_MODE: "release" });
  assert.equal(r.outputs.action, "deploy");
});

const HOST_OK = `== release
PROOVRA_RELEASE release=${C1}
PROOVRA_RELEASE running_api=${C0}
PROOVRA_RELEASE rollback_point=${C0}
PROOVRA_RELEASE backup=proovra-20261124T010000Z.dump
PROOVRA_RELEASE verified_epoch=5
PROOVRA_RELEASE result=DEPLOYED
`;

test("finish — a verified host release AND a matching public API: success, then the web continuation is dispatched", async () => {
  const w = makeWorld({ commits: HISTORY, main: C1, api: { revision: C1, epoch: 5 }, web: C0 });
  const r = await w.finish(HOST_OK, { RELEASE_ACTION: "deploy", RELEASE_SHA: C1, SSH_EXIT: "0" });
  assert.equal(r.code, 0);
  assert.equal(w.last(C1).state, "success");
  assert.match(w.last(C1).description, /^backend live at 111111111: api\+worker revision, readiness, epoch 5 verified; backup proovra-20261124T010000Z\.dump/);
  assert.deepEqual(w.dispatches, [{ ref: "main" }]);
});

test("finish — the host says DEPLOYED but the public API disagrees: never success, no web", async () => {
  const w = makeWorld({ commits: HISTORY, main: C1, api: { revision: C0, epoch: 4 }, web: C0 });
  const r = await w.finish(HOST_OK, { RELEASE_ACTION: "deploy", RELEASE_SHA: C1, SSH_EXIT: "0" });
  assert.equal(r.code, 1);
  assert.equal(w.last(C1).state, "error");
  assert.match(w.last(C1).description, /^verification failed: 111111111 deployed but the public API says revision 000000000/);
  assert.equal(w.dispatches.length, 0);
});

test("finish — a failed release that was rolled back: failure, and the live web is checked against the restored API", async () => {
  const w = makeWorld({ commits: HISTORY, main: C1, api: { revision: C0, epoch: 4 }, web: C0 });
  const host = `PROOVRA_RELEASE running_api=${C0}\nPROOVRA_RELEASE rollback_point=${C0}\nPROOVRA_RELEASE rollback_started=${C0}\nPROOVRA_RELEASE rolled_back_to=${C0}\nPROOVRA_RELEASE result=FAILED_ROLLED_BACK\n`;
  const r = await w.finish(host, { RELEASE_ACTION: "deploy", RELEASE_SHA: C1, SSH_EXIT: "20" });
  assert.equal(r.code, 1, "a rolled-back release is a failed run");
  assert.equal(w.last(C1).state, "failure");
  assert.equal(w.last(C1).description, "deploy failed; rolled back to 000000000 (verified)");
  assert.ok(r.lines.some((l) => /web after rollback: compatible: live web 000000000 is compatible with API 000000000/.test(l)));
  assert.equal(w.dispatches.length, 0);
});

test("finish — a failure before any change, a lock and an unknown outcome are explicit, never success", async () => {
  const w = makeWorld({ commits: HISTORY, main: C1, api: { revision: C0, epoch: 4 }, web: C0 });
  let r = await w.finish(`PROOVRA_RELEASE running_api=${C0}\nPROOVRA_RELEASE reason=the database backup failed\nPROOVRA_RELEASE result=REFUSED_BEFORE_CHANGE\n`, { RELEASE_ACTION: "deploy", RELEASE_SHA: C1, SSH_EXIT: "10" });
  assert.equal(r.code, 1);
  assert.equal(w.last(C1).description, "deploy failed before any service changed: the database backup failed; still 000000000");
  r = await w.finish("PROOVRA_RELEASE result=LOCKED\n", { RELEASE_ACTION: "deploy", RELEASE_SHA: C1, SSH_EXIT: "75" });
  assert.equal(r.code, 1);
  assert.match(w.last(C1).description, /another release holds the host lock/);
  r = await w.finish("ssh: connect to host … Connection timed out\n", { RELEASE_ACTION: "deploy", RELEASE_SHA: C1, SSH_EXIT: "255" });
  assert.equal(r.code, 1);
  assert.equal(w.last(C1).state, "error");
  assert.match(w.last(C1).description, /^deploy outcome unknown \(ssh exit 255, result none\)/);
});

test("rollback-web — a web that needs the newer API is replaced BEFORE the backend rollback, or the rollback is refused", async () => {
  // Live web C1 needs epoch 5; the rollback restores C0 (epoch 4).
  let w = makeWorld({ commits: HISTORY, main: C1, api: { revision: C1, epoch: 5 }, web: C1 });
  let lines = [];
  let code = await runRollbackWeb({ env: { ...w.env, ROLLBACK_TARGET: C0 }, fetchImpl: w.fetch, git: w.git, log: (l) => lines.push(l), sleep: noSleep });
  assert.equal(code, 1, "without the Vercel API the rollback is refused");
  assert.ok(lines.some((l) => /Rollback refused::.*not known to be compatible with API 000000000.*VERCEL_TOKEN \+ VERCEL_PROJECT_ID/.test(l)));
  assert.equal(w.promotes.length, 0);

  w = makeWorld({ commits: HISTORY, main: C1, api: { revision: C1, epoch: 5 }, web: C1 });
  w.vercelDeployments = [
    { uid: "dpl_1", url: "w1.vercel.app", meta: { githubCommitSha: C1 }, createdAt: 2 },
    { uid: "dpl_0", url: "w0.vercel.app", meta: { githubCommitSha: C0 }, createdAt: 1 },
  ];
  lines = [];
  code = await runRollbackWeb({ env: { ...w.env, ROLLBACK_TARGET: C0, VERCEL_TOKEN: "vt", VERCEL_PROJECT_ID: "prj" }, fetchImpl: w.fetch, git: w.git, log: (l) => lines.push(l), sleep: noSleep });
  assert.equal(code, 0);
  assert.deepEqual(w.promotes, ["dpl_0"], "the newest deployment compatible with the restored API");
  assert.equal(w.web, C0);
});

test("helpers — host output, compatibility, choice of web, GHCR revision", async () => {
  const h = parseHostOutput("noise\nPROOVRA_RELEASE result=DEPLOYED\nPROOVRA_RELEASE backup=a.dump\n");
  assert.equal(h.result, "DEPLOYED");
  assert.deepEqual(h.marks.backup, ["a.dump"]);

  const w = makeWorld({ commits: HISTORY, main: C2, api: { revision: C1, epoch: 5 }, web: C1 });
  assert.equal(webCompatibleWith({ git: w.git, webRevision: C2, apiRevision: C1 }).compatible, true, "web-only change");
  assert.equal(webCompatibleWith({ git: w.git, webRevision: C1, apiRevision: C0 }).compatible, false, "needs epoch 5");
  const chosen = chooseCompatibleWeb({
    deployments: [{ id: "a", sha: C2, createdAt: 3 }, { id: "b", sha: C1, createdAt: 2 }, { id: "c", sha: C0, createdAt: 1 }],
    apiRevision: C0,
    compatible: (x, a) => webCompatibleWith({ git: w.git, webRevision: x, apiRevision: a }).compatible,
  });
  assert.equal(chosen.id, "c");

  assert.deepEqual(await readImageRevision({ owner: "o", svc: "api", tag: "sha-1111111", fetchImpl: w.fetch }), { revision: C1, digest: "sha256:idx-api" });
  assert.deepEqual(await readImageRevision({ owner: "o", svc: "api", tag: "sha-2222222", fetchImpl: w.fetch }), { missing: true });

  const d = decideFinish({ action: "rollback", sha: C1, sshExit: 0, host: parseHostOutput(`PROOVRA_RELEASE rolled_back_to=${C0}\nPROOVRA_RELEASE result=ROLLED_BACK\n`), external: { ok: true, epoch: 4 } });
  assert.equal(d.status.state, "failure");
  assert.match(d.status.description, /^rolled back to 000000000 \(verified, epoch 4\); 111111111 is not live/);
  assert.equal(d.needsWebCheck, true);

  const ok = decideBackendRelease({ mode: "rollback", sha: C1, config: { key: true, target: true, knownHosts: true } });
  assert.equal(ok.action, "rollback");
});
