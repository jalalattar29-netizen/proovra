/**
 * Bundles the pure, testable lib modules (with @proovra/shared inlined) into
 * test/dist/ so node:test can import them without a TS loader. Test-only output;
 * not shipped in the extension package.
 */
import { build } from "esbuild";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

await build({
  entryPoints: {
    "capture-plan": join(HERE, "src/lib/capture-plan.ts"),
    sanitizer: join(HERE, "src/lib/sanitizer.ts"),
    "manifest-builder": join(HERE, "src/lib/manifest-builder.ts"),
  },
  outdir: join(HERE, "test/dist"),
  bundle: true,
  format: "esm",
  platform: "neutral",
  target: ["node20"],
  define: {
    __PROOVRA_API_ORIGIN__: '""',
    __PROOVRA_AUTH_AUTHORIZE_URL__: '""',
    __PROOVRA_AUTH_TOKEN_URL__: '""',
    __PROOVRA_OAUTH_CLIENT_ID__: '""',
    __PROOVRA_EXTENSION_VERSION__: '"test"',
  },
});
console.log("test bundles built in test/dist/");
