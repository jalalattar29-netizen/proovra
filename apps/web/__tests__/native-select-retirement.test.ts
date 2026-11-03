/**
 * RT-008 — AppListbox "replaces native <select> everywhere in the authenticated
 * product". The audit found 134 native selects in 13 heights; the migration
 * finished, and this keeps it finished: no component or page renders one.
 * A deliberate exception goes in EXCEPTIONS with its reason.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const WEB = fileURLToPath(new URL("..", import.meta.url));
const ROOTS = ["app", "components"];
/** path (relative to apps/web) -> why a native select is right there. */
const EXCEPTIONS: Record<string, string> = {};

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === "node_modules" ? [] : walk(path);
    return path.endsWith(".tsx") ? [path] : [];
  });
}

/** Comments name the element they replaced; only code counts. */
function code(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

describe("no native select in the product", () => {
  const files = ROOTS.flatMap((root) => walk(join(WEB, root)));

  it("scans the product", () => {
    expect(files.length).toBeGreaterThan(100);
  });

  it("renders no <select> outside the recorded exceptions", () => {
    const found = files
      .filter((file) => /<select[\s>]/.test(code(readFileSync(file, "utf8"))))
      .map((file) => file.slice(WEB.length).split("\\").join("/").replace(/^\//, ""))
      .filter((rel) => !(rel in EXCEPTIONS));
    expect(found).toEqual([]);
  });
});
