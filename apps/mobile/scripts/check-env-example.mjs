/**
 * THE EXAMPLE FILE MUST DOCUMENT WHAT THE CODE READS — NOTHING ELSE, NOTHING
 * MISSING.
 *
 * On 2026-09-24 a real iPad failed Google sign-in with a configuration error.
 * The cause was not the code: `.env.example` documented
 * `EXPO_PUBLIC_GOOGLE_CLIENT_ID`, a name nothing had read since the move to
 * per-platform client ids, and omitted the three names that replaced it. A
 * `.env` copied from it produced `iosClientId === undefined` at runtime, and
 * `expo-auth-session` threw a message that named none of the above.
 *
 * A stale example file is not a documentation problem. It is a configuration
 * defect that reaches a device.
 *
 * Run by `pnpm --filter proovra-mobile check:env`.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = resolve(HERE, "..");

/** Variables the code actually reads, found in source rather than listed. */
function readByCode() {
  const found = new Set();
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
        walk(full);
        continue;
      }
      if (!/\.(ts|tsx|js|jsx|mjs|cjs)$/.test(entry.name)) continue;
      const src = readFileSync(full, "utf8");
      for (const m of src.matchAll(/process\.env\.(EXPO_PUBLIC_[A-Z0-9_]+)/g)) {
        found.add(m[1]);
      }
    }
  };
  for (const d of ["src", "app"]) {
    const p = join(APP, d);
    try {
      if (statSync(p).isDirectory()) walk(p);
    } catch {
      // A missing directory is not this check's business.
    }
  }
  return found;
}

/** Variables the example file declares. */
function declaredInExample() {
  const text = readFileSync(join(APP, ".env.example"), "utf8");
  const names = new Set();
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*(EXPO_PUBLIC_[A-Z0-9_]+)\s*=/);
    if (m) names.add(m[1]);
  }
  return names;
}

const used = readByCode();
const declared = declaredInExample();

const missing = [...used].filter((n) => !declared.has(n)).sort();
const stale = [...declared].filter((n) => !used.has(n)).sort();

if (missing.length === 0 && stale.length === 0) {
  console.log(`.env.example matches the ${used.size} variables the code reads`);
  process.exit(0);
}

if (missing.length > 0) {
  console.error(
    `.env.example is MISSING ${missing.length} variable(s) the code reads:\n  ` +
      missing.join("\n  ") +
      "\n\nA developer copying this file gets an app that reads `undefined` at " +
      "runtime, which is how Google sign-in failed on a device.",
  );
}
if (stale.length > 0) {
  console.error(
    `\n.env.example documents ${stale.length} variable(s) nothing reads:\n  ` +
      stale.join("\n  ") +
      "\n\nSetting one of these has no effect, which is worse than it being " +
      "absent: it looks configured.",
  );
}
process.exit(1);
