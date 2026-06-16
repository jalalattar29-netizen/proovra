/**
 * Forensic P0 — production 409 fix.
 *
 * Production request 0500d474-61e4-4453-a51f-ae0ae33f66ca hit
 * `POST /submit` with HTTP 409 because the session-status state
 * machine in @proovra/shared didn't allow `UPLOAD_STARTED → SUBMITTED`.
 *
 * Pins:
 *   1) The state machine now allows the transition (the shared
 *      package's own test file covers the enum-level proof; this
 *      contract proves the call-site that triggered the prod 409
 *      is unchanged otherwise).
 *   2) `transitionIntakeSession` now includes the from/to status
 *      in the WorkflowIntakeSessionError message so logs name the
 *      exact disallowed pair (never tokens, never PII).
 *   3) `friendlyPublicIntakeMessage` covers `TRANSITION_NOT_ALLOWED`
 *      so the recipient sees actionable copy, not the generic
 *      "Something went wrong" fallback.
 */

import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { describe, it } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = resolve(dirname(__filename), "..", "..", "..");
const ROUTES = resolve(
  REPO_ROOT,
  "services/api/src/routes/external-intake.routes.ts",
);
const SESSION_SERVICE = resolve(
  REPO_ROOT,
  "services/api/src/services/workflow-intake-session.service.ts",
);
const SHARED_STATE_MACHINE = resolve(
  REPO_ROOT,
  "packages/shared/src/workflow-intake-link.ts",
);
const ORCH_PATH = resolve(
  REPO_ROOT,
  "services/api/src/services/external-intake-orchestration.service.ts",
);

function read(p: string): string {
  return readFileSync(p, "utf8");
}

describe("State machine — UPLOAD_STARTED → SUBMITTED is allowed (prod 409 fix)", () => {
  it("the shared ALLOWED_TRANSITIONS map lists SUBMITTED under UPLOAD_STARTED", () => {
    const src = read(SHARED_STATE_MACHINE);
    const idx = src.indexOf("UPLOAD_STARTED: [");
    assert.ok(idx > 0, "UPLOAD_STARTED entry missing");
    const slice = src.slice(idx, src.indexOf("]", idx));
    assert.ok(
      slice.includes(`"SUBMITTED"`),
      "UPLOAD_STARTED must allow SUBMITTED — the public contributor flow never visits UPLOAD_COMPLETED",
    );
  });

  it("the public 'Add files' route still bumps OPENED → UPLOAD_STARTED only when needed", () => {
    // Pin the orchestrator's idempotent bump so a future refactor
    // can't accidentally double-transition or skip the bump.
    const src = read(ORCH_PATH);
    assert.match(
      src,
      /if \(input\.session\.status === "OPENED"\) \{\s*\n?\s*await transitionIntakeSession\(\{\s*\n?\s*sessionId: input\.session\.id,[\s\S]{0,200}to: "UPLOAD_STARTED",/,
    );
  });
});

describe("Diagnostic messages — transition errors carry from/to in the log line", () => {
  it("session_terminal error message includes from + to status enums", () => {
    const src = read(SESSION_SERVICE);
    // Comments may sit between the code literal and the message
    // template, so use a permissive [\s\S] span. The proof is that
    // the literal string contains `from=${session.status}` and
    // `to=${input.to}` — the diagnostic operators need.
    assert.match(
      src,
      /"session_terminal",[\s\S]{0,400}`Session already in terminal state: from=\$\{session\.status\} to=\$\{input\.to\}`/,
    );
  });

  it("transition_not_allowed error message includes from + to status enums", () => {
    const src = read(SESSION_SERVICE);
    assert.match(
      src,
      /"transition_not_allowed",[\s\S]{0,200}`Disallowed transition: from=\$\{session\.status\} to=\$\{input\.to\}`/,
    );
  });
});

describe("Friendly public copy — TRANSITION_NOT_ALLOWED no longer hits the generic fallback", () => {
  it("friendlyPublicIntakeMessage covers TRANSITION_NOT_ALLOWED with actionable copy", () => {
    const src = read(ROUTES);
    assert.match(src, /case "TRANSITION_NOT_ALLOWED":/);
    assert.match(
      src,
      /This step can't be completed right now\. Refresh the page and try again/,
    );
  });

  it("intakeErrorToReply maps transition_not_allowed → 409 TRANSITION_NOT_ALLOWED with friendly message", () => {
    const src = read(ROUTES);
    assert.match(
      src,
      /case "transition_not_allowed":\s*\n?\s*reply\.code\(409\)\.send\(\{\s*\n?\s*error: \{\s*\n?\s*code: "TRANSITION_NOT_ALLOWED",\s*\n?\s*message: friendly\("TRANSITION_NOT_ALLOWED"\)/,
    );
  });
});
