/**
 * D20 — cancel and close send the justification the dialog collected.
 *
 * The API requires a reviewer note for both transitions (Batch K3 made the
 * routes read it). The evidence page's request panel opened a note dialog
 * for each and then posted with no body, so every cancel and close was
 * refused with reviewer_note_required.
 */

import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { enclosingSource } from "../../../scripts/source-contract/index.mjs";

const WEB = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PANEL = readFileSync(
  resolve(WEB, "app/(app)/evidence/[id]/components/EvidenceRequestPanel.tsx"),
  "utf8",
);

for (const action of ["cancel", "close"]) {
  test(`${action} posts the collected note as reviewerNote`, () => {
    const call = enclosingSource(PANEL, `}/${action}\``, "call", {
      unique: true,
      fileName: "EvidenceRequestPanel.tsx",
    });
    assert.match(call, /method:\s*"POST"/);
    assert.match(call, /body:\s*JSON\.stringify\(\{\s*reviewerNote:\s*note\s*\}\)/);
  });
}
