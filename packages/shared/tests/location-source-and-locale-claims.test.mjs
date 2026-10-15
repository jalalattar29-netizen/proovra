/**
 * A null location source is "not recorded", never "browser"; app and screen
 * captures name the app's device. No locale carries "Signed. Verified. Trusted."
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  EVIDENCE_LOCATION_SOURCES,
  dict,
  evidenceLocationSourceForAcquisition,
  evidenceLocationSourceLabel,
  supportedLocales,
} from "../dist/index.js";

const CLIENT_DECLARED = [
  "PROOVRA_MOBILE_APP",
  "DIRECT_SCREEN_CAPTURE_ANDROID",
  "DIRECT_SCREEN_CAPTURE_ANDROID_CONTINUOUS",
  "DIRECT_SCREEN_CAPTURE_IOS",
];

// ---------------------------------------------------------------- location / i18n

test("location: a null source is not recorded; app and screen captures name the app's device", () => {
  assert.equal(evidenceLocationSourceLabel(null), "Location source not recorded");
  assert.equal(evidenceLocationSourceLabel("SOMETHING_ELSE"), "Location source not recorded");
  assert.ok(EVIDENCE_LOCATION_SOURCES.includes("CLIENT_APP_DEVICE_LOCATION"));
  for (const mode of CLIENT_DECLARED) {
    assert.equal(evidenceLocationSourceForAcquisition(mode), "CLIENT_APP_DEVICE_LOCATION", mode);
  }
  assert.equal(evidenceLocationSourceForAcquisition("PROOVRA_WEB_UPLOAD"), "CAPTURE_BROWSER_GEOLOCATION");
  assert.equal(evidenceLocationSourceForAcquisition("DIRECT_WEB_CAPTURE_EXTENSION"), "CAPTURE_BROWSER_GEOLOCATION");
  assert.doesNotMatch(evidenceLocationSourceLabel("CLIENT_APP_DEVICE_LOCATION"), /browser/i);
});

test("i18n: no locale carries the unqualified 'Signed. Verified. Trusted.' claim", () => {
  for (const loc of supportedLocales) {
    assert.equal("bullets" in dict[loc], false, loc);
    for (const v of Object.values(dict[loc])) assert.doesNotMatch(String(v), /Verified\. Trusted\./, loc);
  }
});
