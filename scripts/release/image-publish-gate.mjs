/**
 * The publication gate for Production container images.
 *
 * An image may be pushed to GHCR — under its immutable SHA tag or under
 * `latest` — only for a commit that
 *
 *   1. every REQUIRED workflow has completed successfully FOR THAT EXACT SHA,
 *      on a `push` to main (a pull-request run proves a merge preview, not the
 *      commit that landed), and
 *   2. is still the head of `main` when the gate runs, so a slow completion for
 *      a superseded commit cannot move `latest` backwards.
 *
 * `decidePublication` is pure so the policy is testable without GitHub. The CLI
 * below only fetches the facts and writes the decision to `$GITHUB_OUTPUT`.
 */
import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

/** Workflows that run, unfiltered, on every push to main. All must be green. */
export const REQUIRED_WORKFLOWS = Object.freeze([
  { file: "ci.yml", name: "ci" },
  { file: "playwright-e2e.yml", name: "playwright-e2e" },
  { file: "schema-reproducibility.yml", name: "schema-reproducibility" },
]);

const SHA = /^[0-9a-f]{40}$/;

/**
 * @param {{
 *   headSha: string,
 *   mainSha: string,
 *   runs: Record<string, Array<{ head_sha: string, event: string, status: string,
 *     conclusion: string | null, run_attempt?: number, created_at?: string }>>,
 *   required?: ReadonlyArray<{ file: string, name: string }>,
 * }} input
 * @returns {{ publish: boolean, tagLatest: boolean, reason: string }}
 */
export function decidePublication({ headSha, mainSha, runs, required = REQUIRED_WORKFLOWS }) {
  if (!SHA.test(String(headSha))) return refuse(`INVALID_HEAD_SHA`);
  if (!SHA.test(String(mainSha))) return refuse(`INVALID_MAIN_SHA`);
  if (required.length === 0) return refuse("NO_REQUIRED_WORKFLOWS");

  for (const wf of required) {
    const candidates = (runs[wf.file] ?? []).filter(
      (r) => r.head_sha === headSha && r.event === "push",
    );
    if (candidates.length === 0) return refuse(`WAITING_FOR:${wf.name}`);
    // The newest attempt is the verdict: a re-run that went green after a
    // flake counts, a re-run that went red after a green does not.
    const latest = [...candidates].sort(
      (a, b) =>
        (b.run_attempt ?? 1) - (a.run_attempt ?? 1) ||
        String(b.created_at ?? "").localeCompare(String(a.created_at ?? "")),
    )[0];
    if (latest.status !== "completed") return refuse(`WAITING_FOR:${wf.name}`);
    if (latest.conclusion !== "success") return refuse(`FAILED:${wf.name}:${latest.conclusion}`);
  }

  if (headSha !== mainSha) return refuse("SUPERSEDED_BY_NEWER_MAIN");
  return { publish: true, tagLatest: true, reason: "ALL_REQUIRED_WORKFLOWS_SUCCEEDED_ON_MAIN_HEAD" };
}

function refuse(reason) {
  return { publish: false, tagLatest: false, reason };
}

async function gh(path, token) {
  const res = await fetch(`https://api.github.com${path}`, {
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "x-github-api-version": "2022-11-28",
    },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`GitHub API ${path} → HTTP ${res.status}`);
  return res.json();
}

async function main() {
  const { GITHUB_TOKEN, GITHUB_REPOSITORY, HEAD_SHA, GITHUB_OUTPUT } = process.env;
  if (!GITHUB_TOKEN || !GITHUB_REPOSITORY || !HEAD_SHA) {
    throw new Error("GITHUB_TOKEN, GITHUB_REPOSITORY and HEAD_SHA are required");
  }
  const repo = GITHUB_REPOSITORY;
  const main = await gh(`/repos/${repo}/commits/main`, GITHUB_TOKEN);
  const runs = {};
  for (const wf of REQUIRED_WORKFLOWS) {
    const page = await gh(
      `/repos/${repo}/actions/workflows/${wf.file}/runs?head_sha=${HEAD_SHA}&event=push&branch=main&per_page=50`,
      GITHUB_TOKEN,
    );
    runs[wf.file] = page.workflow_runs ?? [];
  }
  const decision = decidePublication({ headSha: HEAD_SHA, mainSha: main.sha, runs });
  console.log(`image-publish-gate: ${HEAD_SHA} → ${JSON.stringify(decision)}`);
  if (GITHUB_OUTPUT) {
    appendFileSync(
      GITHUB_OUTPUT,
      `publish=${decision.publish}\ntag_latest=${decision.tagLatest}\nreason=${decision.reason}\nsha=${HEAD_SHA}\n`,
    );
  }
}

const invokedDirectly =
  Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main().catch((err) => {
    console.error(`image-publish-gate: ${err.message}`);
    process.exit(1);
  });
}
