/**
 * WS-FREG (remediation cdcb8ae) — Free row B5B-F-401, regression obligation.
 *
 * NEW_VERSION_NO_MATERIAL_CHANGE used to say every new verification fact
 * issues an updated report version automatically. Only the worker's
 * chain-verified (Bitcoin) version is automatic (`ots_upgrade_completed`);
 * other facts make an updated version AVAILABLE for the person to request.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { userFacingErrorFor } from "../dist/index.js";

test("B5B-F-401: the no-material-change copy names the one automatic producer and does not generalise it", () => {
  const copy = userFacingErrorFor("NEW_VERSION_NO_MATERIAL_CHANGE");
  assert.ok(copy, "the code has a user-facing entry");
  const text = `${copy.title} ${copy.message}`;
  assert.match(text, /becomes available when a new verification fact is recorded/i);
  assert.match(text, /only an independent bitcoin verification of its timestamp issues one automatically/i);
  assert.doesNotMatch(text, /(every|any) new (verification )?fact (automatically )?issues/i);
});
