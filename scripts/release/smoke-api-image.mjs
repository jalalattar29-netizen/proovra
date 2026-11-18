/**
 * PRO-S1-11 — PRODUCTION-IMAGE SMOKE of the API, before it is tagged.
 *
 *   node scripts/release/smoke-api-image.mjs <api-image-ref> <release-sha>
 *
 * The worker image was smoked by digest before tagging; the API image was
 * tagged unsmoked. This runs the PUSHED API digest (no network, no database,
 * no secret) and requires:
 *
 *   - the image's revision label and APP_RELEASE_SHA are the gated release;
 *   - the compiled entry point and every shared package it loads are present;
 *   - the generated Prisma client loads from the image's own node_modules;
 *   - pnpm resolves offline (Corepack may not download at runtime);
 *   - it runs as the unprivileged `app` user.
 *
 * Nothing here starts the server: that needs the production environment,
 * which the deploy gate (/readyz on the host) proves after rollout.
 */
import { spawnSync } from "node:child_process";

const IMAGE = process.argv[2];
const SHA = process.argv[3];
if (!IMAGE || !/^[0-9a-f]{40}$/.test(String(SHA))) {
  console.error("usage: smoke-api-image.mjs <api-image-ref> <40-char release sha>");
  process.exit(2);
}

function run(args) {
  const r = spawnSync("docker", args, { encoding: "utf8" });
  return { status: r.status ?? 1, out: `${r.stdout ?? ""}${r.stderr ?? ""}`.trim() };
}

const failures = [];
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures.push(name);
};

const label = run(["image", "inspect", IMAGE, "--format", '{{ index .Config.Labels "org.opencontainers.image.revision" }}']);
check("revision label is the release", label.status === 0 && label.out === SHA, label.out.slice(0, 80));

const probe = [
  "const fs=require('node:fs');",
  "const need=['dist/index.js','../../packages/shared/dist','../../packages/shared-runtime/dist','../../packages/shared-billing/dist','../../packages/shared-evidence-presentation/dist'];",
  "const missing=need.filter(p=>!fs.existsSync(p));",
  "if(missing.length){console.log('MISSING '+missing.join(','));process.exit(3);}",
  "require('@prisma/client');",
  "console.log('SHA '+(process.env.APP_RELEASE_SHA||''));",
  "console.log('UID '+process.getuid());",
].join("");
const inner = run(["run", "--rm", "--network", "none", "--entrypoint", "node", IMAGE, "-e", probe]);
check("entry point and shared packages present, Prisma client loads", inner.status === 0, inner.status === 0 ? "" : inner.out.slice(0, 300));
check("APP_RELEASE_SHA is the release", inner.out.includes(`SHA ${SHA}`));
check("runs unprivileged", /UID [1-9]\d*/.test(inner.out));

const pnpm = run(["run", "--rm", "--network", "none", "--entrypoint", "pnpm", IMAGE, "--version"]);
check("pnpm resolves offline", pnpm.status === 0 && /^\d+\.\d+\.\d+/.test(pnpm.out), pnpm.out.slice(0, 80));

if (failures.length) {
  console.error(`api image smoke FAILED: ${failures.join("; ")}`);
  process.exit(1);
}
console.log("api image smoke passed");
