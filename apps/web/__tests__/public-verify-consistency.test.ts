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
        autoRefreshRecommended: false,
      },
    }),
    false,
  );

  assert.equal(
    shouldAutoPollPublicVerify({
      liveAnchoring: {
      },
    }),
    false,
  );
});

test("polling only resumes when an explicit auto-refresh recommendation is present", () => {
  assert.equal(
    shouldAutoPollPublicVerify({
      liveAnchoring: {
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

test("verify page states the anchoring now, at issue and its advance in ONE card (2026-10-18)", () => {
  const sections = readFileSync(
    resolve(__dirname, "..", "app", "verify", "[token]", "VerifyRecordSections.tsx"),
    "utf8",
  );
  // Now: the matrix row (status + statusLabel + qualifiers); at issue: the
  // issued artifact's snapshot; the advance sentence only for a real advance.
  assert.match(VERIFY_PAGE_SOURCE, /<OtsAnchoringCard\s+row=\{matrixRow\("ots_anchoring"\)\}/);
  assert.match(sections, /data-verify-ots-now/);
  assert.match(sections, /data-verify-ots-at-issue/);
  assert.match(sections, /liveAnchoring\?\.advance && liveAnchoring\.advance !== "NONE"/);
  assert.match(sections, /CHAIN_VERIFIED_SINCE_ISSUE: "Independently verified since the report was issued"/);
  assert.match(sections, /ATTESTATION_RECORDED_SINCE_ISSUE: "Bitcoin attestation recorded since the report was issued"/);
  // The old two-section wording is gone.
  assert.doesNotMatch(VERIFY_PAGE_SOURCE, /Live anchoring status|Anchoring has advanced since this package was generated/);
  assert.doesNotMatch(VERIFY_PAGE_SOURCE, /currentOtsStatus/);
});
