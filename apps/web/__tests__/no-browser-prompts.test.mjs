/**
 * Reasons and confirmations go through the confirm dialog (askReason / confirm),
 * so every one is recorded the same way. A browser prompt cannot be styled,
 * tested or kept from an empty answer, so none may come back.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const web = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function files(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return e.name === "node_modules" || e.name.startsWith(".") ? [] : files(p);
    return /\.(ts|tsx)$/.test(e.name) ? [p] : [];
  });
}

test("no window.prompt or window.confirm call in the app", () => {
  const hits = [];
  for (const root of ["app", "components", "lib"]) {
    for (const f of files(path.join(web, root))) {
      const code = fs
        .readFileSync(f, "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/\/\/.*$/gm, "");
      if (/\bwindow\.(prompt|confirm)\s*\(/.test(code)) hits.push(path.relative(web, f));
    }
  }
  assert.deepEqual(hits, []);
});
