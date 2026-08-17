#!/usr/bin/env node
/**
 * RETIRED AS AN AUTHORITY — this is now a thin wrapper.
 *
 * This script used to be a second, independent measurement of routes and
 * consumers, built out of text scanning. It found the real defect it was written
 * to find: `docs/architecture/current-runtime-capability-map.json` carried a
 * hand-maintained `classification` column that no generator produced and that
 * disagreed with the tree on 176 of 1083 routes.
 *
 * But it then became the second problem of the same shape. It needed five
 * separate repairs — nested template literals, apostrophes in prose, interpolated
 * parameters, query suffixes, literal-versus-parameter segments — and each one
 * had silently mis-stated the answer until somebody happened to look. A parser
 * that needs a repair per idiom is not converging on the truth; it is being
 * fitted to the last example. And while it existed alongside the map, the system
 * had TWO answers to "how many routes have a consumer" — 773 here, 785 there —
 * with no way to say which was measuring anything.
 *
 * There is now exactly one authority:
 *
 *     services/api/scripts/generate-runtime-capability-map.mjs
 *
 * It parses the real TypeScript with the compiler API, follows request wrappers
 * to a fixpoint, follows authorization guards to terminal markers, and refuses to
 * guess — publishing what it cannot resolve instead of quietly deciding.
 *
 * `pnpm --filter proovra-api verify:route-consumers` is kept as a name because
 * CI and several docs invoke it. It delegates, so the name cannot drift back
 * into a separate opinion.
 */

import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

const result = spawnSync(
  process.execPath,
  [path.join(HERE, "generate-runtime-capability-map.mjs"), "--check"],
  { stdio: "inherit" },
);

process.exit(result.status ?? 1);
