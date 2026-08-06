/**
 * PHASE 12 — POINT 8 PART B: the Staging deployment guard.
 *
 * WHAT IT IS PROTECTING AGAINST
 * ---------------------------------------------------------------------------
 * The only deployment automation this repository has is `deploy-images.yml`,
 * which builds and pushes `latest` to GHCR on every push to `main`. There is no
 * staging path, so the obvious way to make one — copy that workflow, change a
 * value — produces something one typo away from a production release. And the
 * artifact work in Part A showed how such a typo survives: everything is
 * checked against the developer's tree, nothing against what actually ships.
 *
 * So the staging path is validated by a function rather than by reading the
 * YAML carefully. Each refusal below is proved by a negative case; a guard
 * that has only ever passed has not been shown to be capable of failing.
 *
 * It is pure. It opens no socket, resolves no secret, and is given the deploy
 * request rather than reading the ambient environment — the ambient
 * environment on this machine is production.
 */

/** Branches whose CI already builds and pushes production images. */
export const PRODUCTION_TRIGGER_BRANCHES = new Set(["main", "master", "production", "release"]);

/** Environment names that must never appear in a staging deployment. */
export const PRODUCTION_ENVIRONMENTS = new Set(["production", "prod", "live"]);

/** Mutable tags. A staging deploy must name an immutable artifact. */
export const MUTABLE_TAGS = new Set(["latest", "main", "master", "edge", "stable"]);

/**
 * Secret NAMES that carry production material in this repository. The guard
 * checks names, never values — it must be safe to run anywhere, and a guard
 * that reads secrets to decide whether secrets are safe is its own hazard.
 */
export const PRODUCTION_SECRET_NAMES = new Set([
  "DATABASE_URL",
  "DIRECT_URL",
  "REDIS_URL",
  "S3_ACCESS_KEY",
  "S3_SECRET_KEY",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "STRIPE_SECRET_KEY",
  "STRIPE_WEBHOOK_SECRET",
  "PAYPAL_CLIENT_ID",
  "PAYPAL_SECRET",
  "RESEND_API_KEY",
  "SENTRY_DSN",
  "OPENAI_API_KEY",
  "TWILIO_AUTH_TOKEN",
]);

/** Waves a staging deployment may apply without an explicit rehearsal flag. */
export const DEFAULT_ALLOWED_WAVES = new Set(["A_B", "C"]);

/**
 * @typedef {object} StagingDeployRequest
 * @property {string} ref                      git ref being deployed
 * @property {string} environment              GitHub environment name
 * @property {string[]} imageTags              tags the deploy would publish/pull
 * @property {Record<string,string>} secretRefs  env var name → secret reference expression
 * @property {string} wave                     migration wave to apply
 * @property {boolean} contractRehearsalApproved  explicit Release-D rehearsal opt-in
 * @property {boolean} preflightPassed         the Step-2 credential preflight result
 * @property {{api:string,worker:string,web:string}} buildIds
 */

/**
 * Validate a staging deployment request.
 * Returns `{ok, refusals}`; a refusal names the rule, so a failure in CI says
 * what was wrong rather than "guard failed".
 */
export function validateStagingDeploy(request) {
  const refusals = [];
  const refuse = (rule, reason) => refusals.push({ rule, reason });

  const ref = String(request?.ref ?? "");
  const branch = ref.replace(/^refs\/heads\//, "");

  // 1 — a production-triggering branch may never be the staging target.
  if (PRODUCTION_TRIGGER_BRANCHES.has(branch)) {
    refuse(
      "PRODUCTION_TRIGGER_BRANCH",
      `"${branch}" is a production-triggering branch: deploy-images.yml builds and pushes :latest on push to it`,
    );
  }

  // 2 — the environment must be staging, and must not be a production one.
  const env = String(request?.environment ?? "");
  if (PRODUCTION_ENVIRONMENTS.has(env.toLowerCase())) {
    refuse("PRODUCTION_ENVIRONMENT", `environment "${env}" is a production environment`);
  } else if (!/^staging(-[a-z0-9-]+)?$/.test(env)) {
    refuse("NON_STAGING_ENVIRONMENT", `environment "${env}" is not a staging environment`);
  }

  // 3 — production secret names may not be bound directly. Staging must use
  // staging-scoped names, so a misconfigured environment cannot silently
  // resolve a production value.
  for (const [name, reference] of Object.entries(request?.secretRefs ?? {})) {
    if (PRODUCTION_SECRET_NAMES.has(name)) {
      refuse(
        "PRODUCTION_SECRET_NAME",
        `"${name}" is a production secret name; staging must bind STAGING_${name}`,
      );
    }
    if (typeof reference === "string" && /secrets\.(PROD|PRODUCTION)_/i.test(reference)) {
      refuse("PRODUCTION_SECRET_REFERENCE", `"${name}" resolves a production secret reference`);
    }
  }

  // 4 — the artifact must be immutable. `:latest` is what production publishes.
  for (const tag of request?.imageTags ?? []) {
    const short = String(tag).split(":").pop() ?? "";
    if (MUTABLE_TAGS.has(short.toLowerCase())) {
      refuse("MUTABLE_IMAGE_TAG", `tag "${short}" is mutable; staging must deploy an immutable tag`);
    }
  }
  if ((request?.imageTags ?? []).length === 0) {
    refuse("NO_IMAGE_TAG", "no image tag was named, so the deployed artifact is not identified");
  }

  // 5 — the credential preflight is a precondition, not a report.
  if (request?.preflightPassed !== true) {
    refuse("PREFLIGHT_NOT_PASSED", "the Staging credential preflight did not pass");
  }

  // 6 — deferred contract migrations require an explicit rehearsal opt-in.
  const wave = String(request?.wave ?? "");
  if (!DEFAULT_ALLOWED_WAVES.has(wave)) {
    if (wave === "D" && request?.contractRehearsalApproved === true) {
      // Allowed: the Point-6 runbook assigns Release D to an isolated Staging
      // rehearsal, and this request says so explicitly.
    } else {
      refuse(
        "DEFERRED_CONTRACT_WAVE",
        `wave "${wave}" carries deferred Contract/Drop migrations and no explicit Staging rehearsal approval was given`,
      );
    }
  }

  // 7 — one artifact, not three. Mixed build ids mean nobody knows what ran.
  const b = request?.buildIds ?? {};
  const ids = [b.api, b.worker, b.web];
  if (ids.some((v) => !v)) {
    refuse("MISSING_BUILD_ID", "api, worker and web build ids must all be recorded");
  } else if (new Set(ids.map((v) => String(v).split("@").pop())).size !== 1) {
    refuse(
      "MIXED_BUILD_IDS",
      "api, worker and web do not come from one release candidate",
    );
  }

  return { ok: refusals.length === 0, refusals };
}

/**
 * Validate the staging WORKFLOW FILE itself, so the guarantees survive a later
 * edit to the YAML. Given the file's text; returns the same shape.
 */
export function validateStagingWorkflowSource(yamlText) {
  const refusals = [];
  const refuse = (rule, reason) => refusals.push({ rule, reason });
  const text = String(yamlText ?? "");

  // Strip comments: this file explains what it refuses, and prose naming
  // `latest` or `main` must not read as configuration doing so.
  const code = text
    .split("\n")
    .map((l) => (/^\s*#/.test(l) ? "" : l.replace(/\s#.*$/, "")))
    .join("\n");

  if (/\bon:\s*[\s\S]*?\bpush:/.test(code) && !/workflow_dispatch/.test(code)) {
    refuse("AUTOMATIC_TRIGGER", "the staging workflow must be manual or dedicated-branch only");
  }
  for (const branch of PRODUCTION_TRIGGER_BRANCHES) {
    if (new RegExp(String.raw`branches:\s*\[[^\]]*\b${branch}\b`).test(code)) {
      refuse("PRODUCTION_BRANCH_TRIGGER", `the workflow triggers on "${branch}"`);
    }
  }
  if (/value=latest|:latest\b|type=raw,value=latest/.test(code)) {
    refuse("MUTABLE_IMAGE_TAG", "the workflow publishes or pulls a mutable tag");
  }
  if (/environment:\s*(production|prod|live)\b/i.test(code)) {
    refuse("PRODUCTION_ENVIRONMENT", "the workflow names a production environment");
  }
  if (!/environment:/.test(code)) {
    refuse("NO_ENVIRONMENT", "the workflow declares no environment, so it cannot require approval");
  }
  // The guard may be invoked directly or through the CLI that wraps it; both
  // reach `validateStagingDeploy`. What is refused is a workflow that reaches
  // neither.
  if (!/staging-deploy-guard|validateStagingDeploy|staging-deploy-cli\.mjs\s+--validate/.test(code)) {
    refuse("NO_GUARD_INVOCATION", "the workflow does not run the staging deploy guard");
  }
  if (!/staging-preflight-cli\.mjs/.test(code)) {
    refuse("NO_PREFLIGHT_INVOCATION", "the workflow does not run the Staging credential preflight");
  }
  if (!/release-deploy\.mjs|--wave/.test(code)) {
    refuse("UNBOUNDED_MIGRATIONS", "the workflow does not apply migrations through the wave selector");
  }
  for (const name of PRODUCTION_SECRET_NAMES) {
    if (new RegExp(String.raw`secrets\.${name}\b`).test(code)) {
      refuse("PRODUCTION_SECRET_NAME", `the workflow reads secrets.${name}`);
    }
  }

  return { ok: refusals.length === 0, refusals };
}
