/**
 * A CONTROL CHARACTER IN A REGEX SILENTLY DISABLES THE CHECK.
 *
 * ===========================================================================
 * WHY THIS EXISTS
 * ===========================================================================
 * Twice in this work a `\b` written into a script through a shell heredoc
 * arrived as a literal BACKSPACE byte (0x08). The regex still parses. It still
 * runs. It simply never matches, because it is now looking for a control
 * character that appears in no source file.
 *
 * The first time, `admin-inventory.mjs` reported 41 of 47 admin mutations as
 * having no authorization beyond authentication — a security finding that
 * would have sent somebody auditing twenty pages of correct code.
 *
 * The second time, `admin-composition-contract.mjs` failed the runbook reader
 * for having no timestamps immediately after a timestamp was added to it. That
 * one cost six rounds of debugging in which every hypothesis was wrong,
 * because the source READS correctly — `cat -A` is the only thing that shows
 * the difference between `Utc\b` and `Utc^H`.
 *
 * A check that cannot fail is worse than no check. This makes the byte visible
 * at the only moment anybody would look: when the suite runs.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * Everything except tab, newline and carriage return.
 *
 * Tab and the newlines are legitimate whitespace. Every other C0 code point,
 * plus DEL, is either a mistake or something that has no business in source
 * this repository generates and edits by script.
 */
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;

const ROOTS = ["apps/web/scripts", "scripts", "services/api/scripts"];

function walk(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      // node_modules is not ours and .cache is build output.
      if (e.name === "node_modules" || e.name.startsWith(".")) continue;
      walk(p, out);
      continue;
    }
    if (/\.(mjs|cjs|js|ts)$/.test(e.name)) out.push(p);
  }
  return out;
}

test("no script carries a stray control character", () => {
  const offenders = [];

  for (const root of ROOTS) {
    for (const file of walk(root)) {
      let text;
      try {
        if (statSync(file).size > 4 * 1024 * 1024) continue;
        text = readFileSync(file, "utf8");
      } catch {
        continue;
      }
      const lines = text.split("\n");
      lines.forEach((line, i) => {
        const m = CONTROL.exec(line);
        if (!m) return;
        const code = m[0].charCodeAt(0).toString(16).padStart(2, "0");
        offenders.push(
          `${relative(process.cwd(), file).split("\\").join("/")}:${i + 1} ` +
            `contains 0x${code} — a \\b or \\t written through a shell heredoc ` +
            `arrives as the byte, and the regex around it then matches nothing`,
        );
      });
    }
  }

  assert.deepEqual(offenders, []);
});

test("the guard can actually see one", () => {
  // A guard for an invisible byte has to prove it is not itself blind.
  const withBackspace = "const RE = /Utc\u0008|<time\u0008/;";
  assert.ok(CONTROL.test(withBackspace), "0x08 must be detected");
  assert.ok(!CONTROL.test("const RE = /Utc\\b|<time/;"), "an escaped \\b is fine");
  assert.ok(!CONTROL.test("a\tb"), "a real tab is legitimate");
});
