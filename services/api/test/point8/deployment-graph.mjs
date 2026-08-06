/**
 * PHASE 12 — POINT 8 PART B, STEP B1: the executable deployment graph.
 *
 * "What deploys production?" was answered in the previous pass by reading
 * `deploy-images.yml`. That is exactly the method Part A showed to be
 * unreliable: a human reading one file and generalising. So the graph is
 * DERIVED from every workflow in `.github/workflows`, and a trigger the parser
 * does not recognise is counted as UNKNOWN rather than assumed harmless.
 *
 * It is a deliberately small YAML reader. It does not need to understand
 * workflows in general — only which of them can fire without a human, and
 * which of those reach a registry, a host or a database.
 */
import { readFileSync, readdirSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../../../..");
const WF_DIR = resolve(REPO, ".github/workflows");

/** Trigger kinds this parser understands. Anything else is UNKNOWN. */
const KNOWN_TRIGGERS = new Set([
  "push",
  "pull_request",
  "workflow_dispatch",
  "schedule",
  "workflow_call",
  "release",
  "merge_group",
]);

/** Effects that make a workflow a DELIVERY path rather than a check. */
const EFFECTS = [
  [/ghcr\.io|docker\/build-push-action|push:\s*true/, "publishes-container-image"],
  [/vercel|netlify|fly deploy|kubectl|helm|ssh /i, "deploys-hosting"],
  [/migrate deploy|release-deploy\.mjs/, "applies-migrations"],
  [/type=raw,value=latest|:latest\b/, "publishes-mutable-tag"],
];

function stripComments(text) {
  return text
    .split("\n")
    .map((l) => (/^\s*#/.test(l) ? "" : l.replace(/\s#.*$/, "")))
    .join("\n");
}

/** Extract the `on:` block's trigger names and any branch filters under them. */
function parseTriggers(code) {
  const lines = code.split("\n");
  const start = lines.findIndex((l) => /^on:\s*$/.test(l) || /^on:\s*\S/.test(l));
  if (start < 0) return { triggers: [], branches: {} };
  const triggers = [];
  const branches = {};
  let current = null;
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (/^\S/.test(line)) break; // dedented out of `on:`
    const trig = /^\s{2}([a-z_]+):/.exec(line);
    if (trig) {
      current = trig[1];
      triggers.push(current);
      continue;
    }
    const br = /branches:\s*\[([^\]]*)\]/.exec(line);
    if (br && current) {
      branches[current] = br[1].split(",").map((s) => s.trim().replace(/['"]/g, "")).filter(Boolean);
    }
  }
  return { triggers, branches };
}

export function buildDeploymentGraph() {
  const files = readdirSync(WF_DIR).filter((f) => /\.ya?ml$/.test(f)).sort();
  const nodes = files.map((file) => {
    const raw = readFileSync(join(WF_DIR, file), "utf8");
    const code = stripComments(raw);
    const { triggers, branches } = parseTriggers(code);
    const effects = EFFECTS.filter(([re]) => re.test(code)).map(([, name]) => name);
    const unknownTriggers = triggers.filter((t) => !KNOWN_TRIGGERS.has(t));
    // Automatic = can fire with no human action.
    const automatic = triggers.some((t) => ["push", "pull_request", "schedule", "merge_group", "release"].includes(t));
    const manualOnly = triggers.length > 0 && triggers.every((t) => t === "workflow_dispatch" || t === "workflow_call");
    return {
      workflow: file,
      triggers,
      branchFilters: branches,
      automatic,
      manualOnly,
      unknownTriggers,
      effects,
      // A production delivery path: fires automatically AND publishes or deploys.
      productionDeliveryPath:
        automatic &&
        effects.some((e) => e === "publishes-container-image" || e === "deploys-hosting"),
      environment: /^\s*environment:\s*(\S+)/m.exec(code)?.[1] ?? null,
    };
  });

  const staging = nodes.find((n) => n.workflow === "deploy-staging.yml") ?? null;

  return {
    nodes,
    metrics: {
      workflows: nodes.length,
      UnknownDeploymentTriggers: nodes.reduce((n, w) => n + w.unknownTriggers.length, 0),
      productionDeliveryPaths: nodes.filter((n) => n.productionDeliveryPath).map((n) => n.workflow),
      // The staging path may not be automatic, may not publish a mutable tag,
      // and may not be triggered by a branch that also reaches production.
      StagingPathCanTriggerProduction:
        staging === null
          ? true // no staging path at all is the same risk as an unsafe one
          : staging.automatic ||
            staging.effects.includes("publishes-mutable-tag") ||
            Object.values(staging.branchFilters).flat().length > 0,
    },
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  console.log(JSON.stringify(buildDeploymentGraph(), null, 2));
}
