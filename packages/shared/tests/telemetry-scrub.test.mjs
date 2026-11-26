/**
 * AUD-022 — the shared telemetry scrubber: every sensitive kind, in every event
 * location, is removed; scrubbing fails closed.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  scrubTelemetryBreadcrumb,
  scrubTelemetryEvent,
  scrubTelemetryText,
  scrubTelemetryUrl,
} from "../dist/index.js";
import { SENSITIVE_KINDS, eventsCarrying, leaks } from "./telemetry-scrub-fixtures.mjs";

for (const identifiers of [false, true]) {
  test(`no sensitive value escapes any event location (identifiers=${identifiers})`, () => {
    const failures = [];
    for (const { kind, text, needles } of SENSITIVE_KINDS) {
      for (const [location, event] of eventsCarrying(text)) {
        const out = scrubTelemetryEvent(structuredClone(event), { identifiers });
        if (out === null) failures.push(`${kind} @ ${location}: dropped (scrubber threw)`);
        const leaked = leaks(out, needles);
        if (leaked.length > 0) failures.push(`${kind} @ ${location}: ${leaked.join(", ")}`);
      }
    }
    assert.deepEqual(failures, []);
  });
}

test("scrubbing fails closed: an event that cannot be scrubbed is dropped", () => {
  const hostile = { message: "x" };
  Object.defineProperty(hostile, "extra", {
    enumerable: true,
    get() {
      throw new Error("boom");
    },
  });
  assert.equal(scrubTelemetryEvent(hostile), null);
  const crumb = {};
  Object.defineProperty(crumb, "message", { enumerable: true, get() { throw new Error("boom"); } });
  assert.equal(scrubTelemetryBreadcrumb(crumb), null);
});

test("useful diagnostics survive: route shape, error type, non-sensitive context", () => {
  const out = scrubTelemetryEvent({
    transaction: "GET /v1/evidence/:id",
    exception: { values: [{ type: "TypeError", value: "Cannot read properties of undefined (reading 'x')" }] },
    extra: { queueName: "report-generate", attempt: 3 },
    request: { url: "https://api.proovra.com/v1/evidence/abc/report", method: "POST" },
  });
  assert.equal(out.transaction, "GET /v1/evidence/:id");
  assert.equal(out.exception.values[0].value, "Cannot read properties of undefined (reading 'x')");
  assert.deepEqual(out.extra, { queueName: "report-generate", attempt: 3 });
  assert.equal(out.request.url, "https://api.proovra.com/v1/evidence/abc/report");
  assert.equal(out.request.method, "POST");
});

test("identifiers are redacted only on the client policy", () => {
  const id = "3f2c1a9e-1b2c-4d5e-8f90-1234567890ab";
  assert.match(scrubTelemetryText(`evidence ${id} failed`), new RegExp(id));
  assert.doesNotMatch(scrubTelemetryText(`evidence ${id} failed`, { identifiers: true }), new RegExp(id));
});

test("URLs lose query, fragment and userinfo; bearer path segments are redacted", () => {
  assert.equal(
    scrubTelemetryUrl("https://user:pw@app.proovra.com/share/abc123/view?t=1#frag"),
    "https://app.proovra.com/share/[redacted]/view?[redacted]",
  );
  assert.equal(scrubTelemetryUrl("/v1/org-invites/inviteTok/accept"), "/v1/org-invites/[redacted]/accept");
});

test("object keys keep the record id and lose the file name; payment ids go; API paths and status words stay (2026-11-26)", () => {
  const id = "0f5d2c1e-8a3b-4c2d-9e1f-6a7b8c9d0e1f";
  assert.equal(
    scrubTelemetryUrl(`https://bucket.s3.eu-central-1.amazonaws.com/evidence/${id}/original-Medical%20report.pdf`),
    `https://bucket.s3.eu-central-1.amazonaws.com/evidence/${id}/[object-key]`,
  );
  // A bucket-level call keeps its path.
  assert.equal(scrubTelemetryUrl("https://bucket.s3.eu-central-1.amazonaws.com/"), "https://bucket.s3.eu-central-1.amazonaws.com/");
  // The API's own routes are not object keys.
  assert.equal(scrubTelemetryUrl(`https://api.proovra.com/v1/evidence/${id}/report`), `https://api.proovra.com/v1/evidence/${id}/report`);
  assert.equal(
    scrubTelemetryUrl("https://api-m.paypal.com/v1/billing/subscriptions/I-BW452GLLEP1G"),
    "https://api-m.paypal.com/v1/billing/subscriptions/[id]",
  );
  assert.equal(scrubTelemetryText(`missing evidence/${id}/parts/003-anna.jpg`), `missing evidence/${id}/[object-key]`);
  assert.equal(scrubTelemetryText("status in_progress, queue P-QUEUED"), "status in_progress, queue P-QUEUED");
  // A breadcrumb's url is scrubbed the same way.
  const b = scrubTelemetryBreadcrumb({ category: "http", data: { url: `https://b.s3.eu-central-1.amazonaws.com/evidence/${id}/original-x.png`, method: "HEAD" } });
  assert.equal(b.data.url, `https://b.s3.eu-central-1.amazonaws.com/evidence/${id}/[object-key]`);
});
