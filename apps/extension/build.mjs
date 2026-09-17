/**
 * Reproducible extension build. Bundles the three entry points with esbuild
 * (no remote code — everything ships inside the package) and copies the static
 * assets. Configuration is injected via `define` from the environment with safe
 * localhost defaults, so the same source builds for dev/staging/production.
 */
import { build } from "esbuild";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const DIST = join(HERE, "dist");
const pkg = JSON.parse(readFileSync(join(HERE, "package.json"), "utf8"));

const env = process.env;
const define = {
  __PROOVRA_API_ORIGIN__: JSON.stringify(env.PROOVRA_API_ORIGIN ?? "http://localhost:4000"),
  __PROOVRA_AUTH_AUTHORIZE_URL__: JSON.stringify(
    env.PROOVRA_AUTH_AUTHORIZE_URL ?? "http://localhost:3000/oauth/extension/authorize",
  ),
  __PROOVRA_AUTH_TOKEN_URL__: JSON.stringify(
    env.PROOVRA_AUTH_TOKEN_URL ?? "http://localhost:4000/v1/oauth/extension/token",
  ),
  __PROOVRA_OAUTH_CLIENT_ID__: JSON.stringify(env.PROOVRA_OAUTH_CLIENT_ID ?? "proovra-extension"),
  __PROOVRA_EXTENSION_VERSION__: JSON.stringify(pkg.version),
};

rmSync(DIST, { recursive: true, force: true });
mkdirSync(DIST, { recursive: true });

await build({
  entryPoints: {
    background: join(HERE, "src/background.ts"),
    content: join(HERE, "src/content.ts"),
    popup: join(HERE, "src/popup.ts"),
  },
  outdir: DIST,
  bundle: true,
  format: "esm",
  platform: "browser",
  target: ["chrome116"],
  sourcemap: false,
  minify: env.NODE_ENV === "production",
  legalComments: "none",
  define,
});

// Static assets (manifest, popup html/css, icons).
cpSync(join(HERE, "public"), DIST, { recursive: true });

// Build a checksum manifest so a reviewer can confirm the artifact is exactly
// what was built (reproducible-build evidence).
const checksums = {};
function walk(dir) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      walk(full);
      continue;
    }
    const rel = relative(DIST, full).split("\\").join("/");
    if (rel === "SHA256SUMS.json") continue;
    checksums[rel] = createHash("sha256").update(readFileSync(full)).digest("hex");
  }
}
walk(DIST);
writeFileSync(join(DIST, "SHA256SUMS.json"), JSON.stringify(checksums, null, 2) + "\n");

console.log(`extension built: ${Object.keys(checksums).length} files in dist/`);
