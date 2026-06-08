import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  hasAdvancedLiveAnchoring,
  shouldAutoPollPublicVerify,
} from "../app/verify/[token]/public-verify-consistency";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const VERIFY_PAGE_SOURCE = readFileSync(
  resolve(__dirname, "..", "app", "verify", "[token]", "page.tsx"),
  "utf8",
);

test("OTS pending alone does not start automatic polling", () => {
  assert.equal(
    shouldAutoPollPublicVerify({
      liveAnchoring: {
        currentOtsStatus: "PENDING",
        autoRefreshRecommended: false,
      },
    }),
    false,
  );

  assert.equal(
    shouldAutoPollPublicVerify({
      liveAnchoring: {
        currentOtsStatus: "PENDING",
      },
    }),
    false,
  );
});

test("polling only resumes when an explicit auto-refresh recommendation is present", () => {
  assert.equal(
    shouldAutoPollPublicVerify({
      liveAnchoring: {
        currentOtsStatus: "PENDING",
        autoRefreshRecommended: true,
      },
    }),
    true,
  );
});

test("live anchored plus snapshot pending is marked as advanced", () => {
  assert.equal(
    hasAdvancedLiveAnchoring({
      liveAnchoring: {
        hasAdvancedSinceSnapshot: true,
      },
    }),
    true,
  );
});

test("verify page exposes manual anchoring refresh and avoids reload loops", () => {
  assert.match(
    VERIFY_PAGE_SOURCE,
    /Check Latest Anchoring Status/,
    "verify page should expose a one-shot manual anchoring refresh action.",
  );
  assert.doesNotMatch(
    VERIFY_PAGE_SOURCE,
    /window\.location\.reload/,
    "verify page must not use window.location.reload for refresh.",
  );
  assert.doesNotMatch(
    VERIFY_PAGE_SOURCE,
    /setInterval\s*\(/,
    "verify page must not use an endless polling interval.",
  );
});

test("verify page labels snapshot and live anchoring separately", () => {
  assert.match(VERIFY_PAGE_SOURCE, /Verification package snapshot/);
  assert.match(VERIFY_PAGE_SOURCE, /Live anchoring status/);
  assert.match(
    VERIFY_PAGE_SOURCE,
    /Anchoring has advanced since this package was generated\. A newer report\/package may be available\./,
  );
  assert.match(
    VERIFY_PAGE_SOURCE,
    /OpenTimestamps public anchoring is pending\. This does not invalidate recorded integrity, TSA timestamping, signature, custody, or Object Lock\./,
  );
});
