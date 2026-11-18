/**
 * Free-extension acceptance build (test-only helper, NOT a product change).
 *
 * The same esbuild bundle + manifest plan as ../../build.mjs --e2e, but written to
 * a scratch dir OUTSIDE the package (default <repo>/.p7tmp/ext-free-e2e), so
 * it never touches dist/ or dist-e2e/ that another run may be using. Origins
 * come from the environment exactly as build.mjs reads them:
 *   PROOVRA_API_ORIGIN, PROOVRA_WEB_ORIGIN, PROOVRA_STORAGE_ORIGINS, FREE_EXT_OUT
 */
import { build } from "esbuild";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseOriginList, planManifest } from "../../scripts/manifest-plan.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG = resolve(HERE, "..", "..");
const OUT = process.env.FREE_EXT_OUT ?? resolve(PKG, "..", "..", ".p7tmp", "ext-free-e2e");
const env = process.env;
const api = env.PROOVRA_API_ORIGIN;
if (!api) throw new Error("PROOVRA_API_ORIGIN is required");
const pkg = JSON.parse(readFileSync(join(PKG, "package.json"), "utf8"));

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
await build({
  entryPoints: {
    background: join(PKG, "src/background.ts"),
    content: join(PKG, "src/content.ts"),
    popup: join(PKG, "src/popup.ts"),
  },
  outdir: OUT,
  bundle: true,
  format: "esm",
  platform: "browser",
  target: ["chrome116"],
  sourcemap: false,
  legalComments: "none",
  define: {
    __PROOVRA_API_ORIGIN__: JSON.stringify(api),
    __PROOVRA_AUTH_AUTHORIZE_URL__: JSON.stringify(`${api}/v1/oauth/extension/authorize`),
    __PROOVRA_AUTH_TOKEN_URL__: JSON.stringify(`${api}/v1/oauth/extension/token`),
    __PROOVRA_OAUTH_CLIENT_ID__: JSON.stringify("proovra-extension"),
    __PROOVRA_EXTENSION_VERSION__: JSON.stringify(pkg.version),
    __PROOVRA_WEB_ORIGIN__: JSON.stringify(env.PROOVRA_WEB_ORIGIN ?? ""),
  },
});
cpSync(join(PKG, "public"), OUT, { recursive: true });
const source = JSON.parse(readFileSync(join(PKG, "public", "manifest.json"), "utf8"));
const manifest = planManifest(source, { apiOrigin: api, storageOrigins: parseOriginList(env.PROOVRA_STORAGE_ORIGINS), e2e: true });
writeFileSync(join(OUT, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`free-extension E2E test build -> ${OUT}`);
console.log(JSON.stringify({ host_permissions: manifest.host_permissions, name: manifest.name, version: manifest.version }));
