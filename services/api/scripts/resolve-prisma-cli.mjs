/**
 * The ONE way the operator scripts find the Prisma CLI.
 *
 * The release image installs with `--node-linker=hoisted`, so the `prisma` bin
 * link lives in /app/node_modules/.bin, which `pnpm exec` run from services/api
 * does not search (`Command "prisma" not found`). Resolving the package through
 * Node's module resolution works in the image, in CI and on a developer machine.
 *
 * Used by safe-migrate.mjs (2026-10-28 incident) and drift-check.mjs
 * (2026-11-25: the production status check failed the same way).
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";

/** @param {string} apiRoot absolute path of services/api */
export function resolvePrismaCli(apiRoot) {
  const requireFromApi = createRequire(resolve(apiRoot, "package.json"));
  const manifestPath = requireFromApi.resolve("prisma/package.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const bin = typeof manifest.bin === "string" ? manifest.bin : manifest.bin?.prisma;
  if (!bin) throw new Error(`prisma@${manifest.version} declares no 'prisma' bin`);
  return { cliPath: resolve(dirname(manifestPath), bin), version: manifest.version };
}
