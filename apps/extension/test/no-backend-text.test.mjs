/**
 * THE POPUP MUST NEVER RENDER A BACKEND SENTENCE.
 *
 * `background.ts` answers a failed capture with
 * `error: err instanceof Error ? err.message : String(err)` — the SERVER's
 * message for an ApiError, and a raw JavaScript error string for anything
 * else. The popup used to display it:
 *
 *   setStatus(denialMessage ?? result.error ?? "Capture could not be completed.")
 *
 * so any refusal without written copy put internal wording — and whatever ids,
 * URLs or stack text happened to be in it — in front of a person. The web and
 * native clients both sanitise; this surface did not.
 *
 * A source-contract test rather than a DOM one: the popup has no testable
 * render here, and the property worth keeping is simply that the raw field
 * never reaches the status line.
 */
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const popup = readFileSync(resolve(HERE, "../src/popup.ts"), "utf8");

/** Every argument the popup passes to setStatus, with comments removed. */
function statusArguments() {
  const withoutComments = popup
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
  return [...withoutComments.matchAll(/setStatus\(([\s\S]*?)\);/g)].map((m) =>
    m[1].trim(),
  );
}

test("no status line is built from the server's error field", () => {
  const offenders = statusArguments().filter((a) => /\bresult\.error\b/.test(a));
  assert.deepEqual(
    offenders,
    [],
    "result.error carries the backend message straight from background.ts",
  );
});

test("no status line is built from a caught exception's message", () => {
  const offenders = statusArguments().filter((a) => /\berr(or)?\.message\b/.test(a));
  assert.deepEqual(
    offenders,
    [],
    "an exception message is not user copy — it is whatever threw",
  );
});

test("the generic capture failure says what happened to the work", () => {
  const m = popup.match(/const CAPTURE_FAILED\s*=\s*\n?\s*"([^"]+)"/);
  assert.ok(m, "CAPTURE_FAILED is not declared as a single literal");
  const copy = m[1];
  assert.match(
    copy,
    /nothing was saved/i,
    "a person whose capture failed needs to know whether a half-made record " +
      "is now sitting in their workspace",
  );
});
