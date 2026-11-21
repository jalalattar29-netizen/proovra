/**
 * PRO-PW-09 (closure, owner decision J) — the CSP report intake is narrow:
 * only CSP report media types, a byte cap, a rate limit, and only sanitized
 * fields (no query, fragment, capability token, nonce, sample or referrer)
 * ever reach the log. Behavioural: real Request objects through the handler
 * and through the Next route.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { POST } from "../app/api/csp-report/route";
import {
  CSP_REPORT_FIELD_MAX,
  CSP_REPORT_MAX_BYTES,
  CSP_REPORT_MAX_PER_BATCH,
  createCspReportLimiter,
  handleCspReport,
  sanitizeReportUrl,
} from "../lib/security/csp-report";

function deps(overrides?: { allow?: (k: string) => boolean }) {
  const lines: string[] = [];
  return {
    lines,
    deps: {
      allow: overrides?.allow ?? (() => true),
      clientKey: () => "203.0.113.7",
      log: (line: string) => lines.push(line),
    },
  };
}

const URL_ = "https://app.proovra.test/api/csp-report";
const post = (body: BodyInit, contentType: string, extra?: Record<string, string>) =>
  new Request(URL_, { method: "POST", body, headers: { "content-type": contentType, ...extra } });

const SECRET_TOKEN = "vT0k3n9aZpQ2xY7wR4sL1mN8";
const NONCE = "bm9uY2UtdmFsdWUtc2VjcmV0";

const legacyReport = JSON.stringify({
  "csp-report": {
    "document-uri": `https://user:pw@app.proovra.test/verify/${SECRET_TOKEN}?code=123456#frag`,
    referrer: "https://mail.example/inbox?msg=private",
    "violated-directive": "connect-src",
    "effective-directive": "connect-src",
    "original-policy": `script-src 'self' 'nonce-${NONCE}'`,
    "blocked-uri": "https://collector.example/beacon?token=abcdef&session=xyz",
    "source-file": `https://app.proovra.test/_next/static/chunks/app.js?v=1`,
    "line-number": 12,
    "column-number": 34,
    "script-sample": "fetch('/secret-data')",
    disposition: "report",
    "status-code": 200,
  },
});

test("PRO-PW-09: a legacy application/csp-report is accepted and only sanitized fields are logged", async () => {
  const { lines, deps: d } = deps();
  const res = await handleCspReport(post(legacyReport, "application/csp-report"), d);
  assert.equal(res.status, 204);
  assert.equal(lines.length, 1);
  const logged = JSON.parse(lines[0]);
  assert.equal(logged.event, "csp_report");
  assert.equal(logged.documentUrl, "https://app.proovra.test/verify/:redacted");
  assert.equal(logged.blockedUrl, "https://collector.example/beacon");
  assert.equal(logged.effectiveDirective, "connect-src");
  assert.equal(logged.sourceFile, "https://app.proovra.test/_next/static/chunks/app.js");
  assert.equal(logged.lineNumber, 12);
  assert.equal(logged.disposition, "report");
  for (const leaked of [SECRET_TOKEN, NONCE, "code=", "token=", "abcdef", "#frag", "user:pw", "secret-data", "mail.example", "original"]) {
    assert.ok(!lines[0].includes(leaked), `log line leaks ${leaked}`);
  }
});

test("PRO-PW-09: application/reports+json batches keep only csp-violation entries, at most the batch cap", async () => {
  const entry = (i: number) => ({
    type: "csp-violation",
    age: 1,
    url: "https://app.proovra.test/home",
    user_agent: "UA-should-not-be-logged",
    body: {
      documentURL: `https://app.proovra.test/cases/0b9e8c1a-1234-4abc-9def-0123456789ab?x=${i}`,
      blockedURL: "inline",
      effectiveDirective: "script-src-elem",
      originalPolicy: `'nonce-${NONCE}'`,
      sample: "alert(1)",
      disposition: "report",
    },
  });
  const batch = [...Array.from({ length: 12 }, (_, i) => entry(i)), { type: "deprecation", body: { id: "x" } }];
  const { lines, deps: d } = deps();
  const res = await handleCspReport(post(JSON.stringify(batch), "application/reports+json"), d);
  assert.equal(res.status, 204);
  assert.equal(lines.length, CSP_REPORT_MAX_PER_BATCH);
  const logged = JSON.parse(lines[0]);
  assert.equal(logged.documentUrl, "https://app.proovra.test/cases/:redacted");
  assert.equal(logged.blockedUrl, "inline");
  assert.equal(logged.effectiveDirective, "script-src-elem");
  for (const leaked of ["UA-should", NONCE, "alert(1)", "x="]) assert.ok(!lines.join("\n").includes(leaked), leaked);
});

test("PRO-PW-09: any other content type is refused 415 and nothing is logged", async () => {
  for (const type of ["application/json", "text/plain", "application/x-www-form-urlencoded", "multipart/form-data"]) {
    const { lines, deps: d } = deps();
    const res = await handleCspReport(post(legacyReport, type), d);
    assert.equal(res.status, 415, type);
    assert.equal(lines.length, 0, type);
  }
  // A charset parameter on an accepted type is fine.
  const { deps: d } = deps();
  assert.equal((await handleCspReport(post(legacyReport, "application/csp-report; charset=utf-8"), d)).status, 204);
});

test("PRO-PW-09: an oversize report is refused 413 by declared length and by bytes actually read", async () => {
  const big = "x".repeat(CSP_REPORT_MAX_BYTES + 1);
  const declared = deps();
  const r1 = await handleCspReport(
    post(big, "application/csp-report", { "content-length": String(big.length) }),
    declared.deps,
  );
  assert.equal(r1.status, 413);
  assert.equal(declared.lines.length, 0);

  // A streamed body with no (or a lying) length is cut off at the cap.
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const chunk = new TextEncoder().encode("y".repeat(4096));
      for (let i = 0; i < 4; i++) controller.enqueue(chunk);
      controller.close();
    },
  });
  const streamed = deps();
  const req = new Request(URL_, {
    method: "POST",
    body: stream,
    headers: { "content-type": "application/csp-report" },
    // @ts-expect-error -- Node's fetch Request needs duplex for a stream body
    duplex: "half",
  });
  const r2 = await handleCspReport(req, streamed.deps);
  assert.equal(r2.status, 413);
  assert.equal(streamed.lines.length, 0);
});

test("PRO-PW-09: reports are rate-limited per client and globally", async () => {
  let now = 1_000;
  const allow = createCspReportLimiter({ perKey: 3, global: 5, windowMs: 60_000, now: () => now });
  assert.deepEqual([allow("a"), allow("a"), allow("a"), allow("a")], [true, true, true, false]);
  assert.equal(allow("b"), true);
  assert.equal(allow("c"), false, "global bucket exhausted");
  now += 60_001;
  assert.equal(allow("a"), true, "window resets");

  const { lines, deps: d } = deps({ allow: () => false });
  const res = await handleCspReport(post(legacyReport, "application/csp-report"), d);
  assert.equal(res.status, 429);
  assert.equal(lines.length, 0);
});

test("PRO-PW-09: report URLs are truncated and capability or token paths are redacted", () => {
  const long = `https://app.proovra.test/${"a".repeat(500)}`;
  assert.ok((sanitizeReportUrl(long) ?? "").length <= CSP_REPORT_FIELD_MAX + 1);
  assert.equal(sanitizeReportUrl(`https://app.proovra.test/share/abc?x=1`), "https://app.proovra.test/share/:redacted");
  assert.equal(sanitizeReportUrl(`https://app.proovra.test/evidence/${SECRET_TOKEN}/x`), "https://app.proovra.test/evidence/:redacted/x");
  assert.equal(sanitizeReportUrl("data:image/png;base64,AAAA"), "data");
  assert.equal(sanitizeReportUrl("'eval'"), "eval");
  assert.equal(sanitizeReportUrl("not a url"), null);
});

test("PRO-PW-09: the Next route answers through the same handler (204 for a valid report, 415 otherwise)", async () => {
  const ok = await POST(post(legacyReport, "application/csp-report"));
  assert.equal(ok.status, 204);
  const wrong = await POST(post(legacyReport, "application/json"));
  assert.equal(wrong.status, 415);
});
