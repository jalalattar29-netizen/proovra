/**
 * TESTS EXECUTE THE TYPESCRIPT SOURCE, NEVER A COMPILED SIBLING.
 *
 * Source imports use NodeNext specifiers (`./ots-state.js`) that name the
 * compiled file. Vite resolves such a specifier to a real `.js` file when one
 * exists on disk, and only falls back to `.ts` when it does not. A working copy
 * that still carries `.js` files emitted beside the sources by an old build
 * therefore ran THOSE files under test: a suite could pass against code that no
 * longer exists, and a `vi.mock("../src/x.js")` could miss the module the code
 * under test actually loaded.
 *
 * This plugin closes that hole at the resolver: a relative `.js`/`.mjs`
 * specifier imported from a TypeScript module resolves to its `.ts`/`.tsx`/
 * `.mts` sibling whenever that sibling exists. A specifier with no TypeScript
 * sibling (a real JavaScript module) is left to Vite unchanged.
 *
 * The repository gate `scripts/check-compiled-source-siblings.mjs` keeps such
 * files out of source directories in CI; this plugin keeps a local working copy
 * honest even when one is present.
 */
import { existsSync } from "node:fs";
import path from "node:path";

const TS_IMPORTER = /\.(c|m)?tsx?$/;
const JS_SPECIFIER = /\.(m?js)$/;

/** The TypeScript file a relative `.js` specifier names, or null. */
export function tsSourceFor(specifier, importer) {
  if (!importer || !specifier.startsWith(".")) return null;
  const importerPath = importer.split("?")[0];
  if (!TS_IMPORTER.test(importerPath)) return null;
  const match = JS_SPECIFIER.exec(specifier);
  if (!match) return null;
  const base = path.resolve(path.dirname(importerPath), specifier.slice(0, -match[0].length));
  const candidates = match[1] === "mjs" ? [".mts"] : [".ts", ".tsx"];
  for (const ext of candidates) {
    if (existsSync(base + ext)) return base + ext;
  }
  return null;
}

export function preferTsSource() {
  return {
    name: "proovra:prefer-ts-source",
    enforce: "pre",
    resolveId(specifier, importer) {
      return tsSourceFor(specifier, importer);
    },
  };
}
