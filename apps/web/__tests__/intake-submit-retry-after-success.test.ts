/**
 * B3B-F-109 — a Submit retried after a lost success response lands on the
 * completed state, not on an error over the upload form.
 *
 * The page already renders a read-only "Already submitted" state for
 * LINK_ALREADY_SUBMITTED on load; the submit handler's catch routed the same
 * code to `setErrorMessage(...)` + `setPhase("upload")`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const WEB = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PAGE = readFileSync(resolve(WEB, "app/intake/[token]/page.tsx"), "utf8");

test("the submit catch routes LINK_ALREADY_SUBMITTED to the completed state before the upload fallback", () => {
  const submit = PAGE.indexOf("/submit`");
  assert.ok(submit > 0, "submit call not found");
  const catchAt = PAGE.indexOf("} catch (err) {", submit);
  const fallback = PAGE.indexOf('setPhase("upload");', catchAt);
  const body = PAGE.slice(catchAt, fallback);
  assert.match(
    body,
    /if \(e\?\.code === "LINK_ALREADY_SUBMITTED"\) \{[\s\S]*?setPhase\("already_submitted"\);\s*return;/,
    "a retry after success is shown as an error",
  );
});
