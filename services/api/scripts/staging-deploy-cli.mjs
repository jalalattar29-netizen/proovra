/**
 * PHASE 12 — POINT 8 PART B: the Staging deployment command.
 *
 * `deploy-staging.yml` calls this for validate / deploy / health / rollback.
 * The validation half is complete and tested; the three halves that TALK to
 * infrastructure refuse honestly, because no Staging environment exists yet and
 * a script that pretended otherwise would be worse than none.
 *
 * The refusal is deliberate and specific: it names the owner prerequisite. When
 * the environment exists, each branch is a bounded implementation against it —
 * not a redesign.
 *
 * Exit codes:
 *   0   validation passed / operation completed
 *   11  the deployment request was refused by the guard
 *   12  the operation needs Staging infrastructure that does not exist yet
 */
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { validateStagingDeploy, validateStagingWorkflowSource } from "./staging-deploy-guard.mjs";
import { runPreflight } from "./staging-preflight-cli.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../../..");

/** Build the deploy request from the workflow's inputs. Never reads a secret. */
export function requestFromEnv(env = process.env) {
  return {
    ref: env.GITHUB_REF ?? env.REF ?? "",
    environment: env.GITHUB_ENVIRONMENT ?? env.ENVIRONMENT ?? "staging",
    imageTags: (env.RC ?? env.IMAGE_TAG ?? "").split(",").map((s) => s.trim()).filter(Boolean),
    // NAMES only — the value never enters the guard.
    secretRefs: Object.fromEntries(
      Object.keys(env)
        .filter((k) => k.startsWith("STAGING_"))
        .map((k) => [k, "secrets." + k]),
    ),
    wave: env.WAVE ?? "A_B",
    contractRehearsalApproved: String(env.REHEARSAL ?? "false") === "true",
    preflightPassed: runPreflight(env).green,
    buildIds: {
      api: env.API_BUILD_ID ?? env.RC ?? "",
      worker: env.WORKER_BUILD_ID ?? env.RC ?? "",
      web: env.WEB_BUILD_ID ?? env.RC ?? "",
    },
  };
}

function needsInfrastructure(operation) {
  console.error(
    [
      `staging-deploy: cannot ${operation} — no Staging environment is provisioned.`,
      "",
      "OWNER PREREQUISITE:",
      "  * create the GitHub environment `staging` with the STAGING_* secrets,",
      "  * provision the staging database, Redis, object storage and origins,",
      "  * set P8_STAGING_PROVISIONING_APPROVED=true and P8_STAGING_DEPLOY_APPROVED=true.",
      "",
      "This command refuses rather than simulating the operation: a deploy that",
      "reports success without deploying is the failure mode Point 8 exists to",
      "prevent.",
    ].join("\n"),
  );
  process.exit(12);
}

const argv = process.argv.slice(2);

if (argv.includes("--validate")) {
  const request = requestFromEnv();
  const r = validateStagingDeploy(request);
  const w = validateStagingWorkflowSource(
    readFileSync(resolve(REPO, ".github/workflows/deploy-staging.yml"), "utf8"),
  );
  const refusals = [...r.refusals, ...w.refusals];
  console.log(JSON.stringify({ ok: refusals.length === 0, refusals }, null, 2));
  if (refusals.length > 0) process.exit(11);
} else if (argv.includes("--deploy")) {
  needsInfrastructure("deploy");
} else if (argv.includes("--health")) {
  needsInfrastructure("check health");
} else if (argv.includes("--rollback")) {
  needsInfrastructure("roll back");
} else {
  console.error("usage: staging-deploy-cli.mjs --validate | --deploy | --health | --rollback");
  process.exit(2);
}
