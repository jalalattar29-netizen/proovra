// Team remediation T-164 — the session / revocation behaviour is documented
// for auditors and support, with the action-matrix entries the register names.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const doc = readFileSync(path.join(here, "../../../docs/security/session-and-revocation-model.md"), "utf8");

test("the action matrix states revoke needs no step-up and how row-less sessions are handled", () => {
  assert.match(doc, /revoke: no step-up \(protective\)/);
  assert.match(doc, /Row-less session: adopted or re-auth/);
});

test("the doc states the adoption rule, removal through membership and the kept self-serve rows", () => {
  assert.match(doc, /Adoption rule/);
  assert.match(doc, /ends their access to the workspace\s+through \*\*membership\*\*/);
  assert.match(doc, /self-serve session rows are \*\*kept\*\* by design/);
});
