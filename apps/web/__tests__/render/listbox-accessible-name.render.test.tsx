/**
 * PRO-076 (UI-05) and PRO-002 — every AppListbox has an accessible name.
 *
 * AppListbox renders a <button role="combobox">. With no `ariaLabel`, no
 * `ariaLabelledby`, no `id` that a <label htmlFor> points at, and no wrapping
 * <label>, a screen reader announces "combobox, All channels": the current
 * value, not what the control is. The audit found three such filters on
 * /communications and more on the investigation pages. This scans every call
 * site so a new unnamed one fails here instead of in an audit.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

import { describe, expect, it } from "vitest";

const WEB = resolve(__dirname, "../..");
const ROOTS = ["app", "components"];

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === "node_modules" ? [] : walk(path);
    return path.endsWith(".tsx") ? [path] : [];
  });
}

/** The JSX opening tag that starts at `start`, through its closing `>`. */
function openingTag(src: string, start: number): string {
  let k = start + "<AppListbox".length;
  if (src[k] === "<") {
    // generic argument: <AppListbox<Foo | "bar">
    let angle = 0;
    for (; k < src.length; k += 1) {
      if (src[k] === "<") angle += 1;
      else if (src[k] === ">") {
        angle -= 1;
        if (angle === 0) {
          k += 1;
          break;
        }
      }
    }
  }
  let depth = 0;
  let quote: string | null = null;
  for (; k < src.length; k += 1) {
    const c = src[k];
    if (quote) {
      if (c === quote) quote = null;
      continue;
    }
    if (depth === 0 && (c === '"' || c === "'")) quote = c;
    else if (c === "{") depth += 1;
    else if (c === "}") depth -= 1;
    else if (depth === 0 && c === ">") return src.slice(start, k + 1);
  }
  return src.slice(start);
}

/** Inside an unclosed <label> (or a local `Field` that renders one). */
function insideLabel(before: string): boolean {
  const open = Math.max(before.lastIndexOf("<label"), before.lastIndexOf("<Field "), before.lastIndexOf("<Field\n"));
  const close = Math.max(before.lastIndexOf("</label>"), before.lastIndexOf("</Field>"));
  return open > close;
}

function unnamedCallSites(): string[] {
  const out: string[] = [];
  for (const file of ROOTS.flatMap((root) => walk(join(WEB, root)))) {
    const src = readFileSync(file, "utf8");
    if (file.endsWith("AppListbox.tsx")) continue;
    let i = src.indexOf("<AppListbox");
    while (i >= 0) {
      const next = src[i + "<AppListbox".length];
      if (next === "<" || /\s/.test(next ?? "")) {
        const tag = openingTag(src, i);
        const named = /\bariaLabel=|\bariaLabelledby=|\bid=|\{\.\.\./.test(tag) || insideLabel(src.slice(0, i));
        if (!named) out.push(`${relative(WEB, file)}:${src.slice(0, i).split("\n").length}`);
      }
      i = src.indexOf("<AppListbox", i + 1);
    }
  }
  return out;
}

describe("every AppListbox is named", () => {
  it("scans the product's call sites", () => {
    const files = ROOTS.flatMap((root) => walk(join(WEB, root)));
    const sites = files.reduce((n, f) => n + (readFileSync(f, "utf8").match(/<AppListbox[<\s]/g)?.length ?? 0), 0);
    expect(sites).toBeGreaterThan(60);
  });

  it("no call site leaves its combobox without a name", () => {
    expect(unnamedCallSites()).toEqual([]);
  });

  it("a call site with an id is named only when a label points at it", () => {
    // `id` alone names nothing; the call sites that rely on it must have a
    // <label htmlFor> for that id in the same file.
    const missing: string[] = [];
    for (const file of ROOTS.flatMap((root) => walk(join(WEB, root)))) {
      if (file.endsWith("AppListbox.tsx")) continue;
      const src = readFileSync(file, "utf8");
      let i = src.indexOf("<AppListbox");
      while (i >= 0) {
        const tag = openingTag(src, i);
        const literalId = /\bid="([^"]+)"/.exec(tag)?.[1];
        if (literalId && !/\bariaLabel=|\bariaLabelledby=/.test(tag) && !insideLabel(src.slice(0, i))) {
          if (!src.includes(`htmlFor="${literalId}"`)) missing.push(`${relative(WEB, file)}:${literalId}`);
        }
        i = src.indexOf("<AppListbox", i + 1);
      }
    }
    expect(missing).toEqual([]);
  });
});
