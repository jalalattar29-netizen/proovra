/**
 * 2026-11-26 — a container created from a moving tag (IMAGE_TAG=latest by hand)
 * reports drift from its own immutable sha-<7>.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { imageReferenceDrift } from "../dist/index.js";

const REV = "85b77ddab0678517d2076faa68d7996691929fee";

test("latest (or any tag other than sha-<7> of the baked revision) is drift", () => {
  assert.deepEqual(imageReferenceDrift({ PROOVRA_IMAGE_TAG: "latest", APP_RELEASE_SHA: REV }), { imageTag: "latest", expectedTag: "sha-85b77dd" });
  assert.deepEqual(imageReferenceDrift({ PROOVRA_IMAGE_TAG: "sha-e91806e", APP_RELEASE_SHA: REV }), { imageTag: "sha-e91806e", expectedTag: "sha-85b77dd" });
});

test("the immutable tag of the process's own revision is not drift; nothing to compare is not drift", () => {
  assert.equal(imageReferenceDrift({ PROOVRA_IMAGE_TAG: "sha-85b77dd", APP_RELEASE_SHA: REV }), null);
  assert.equal(imageReferenceDrift({ APP_RELEASE_SHA: REV }), null);
  assert.equal(imageReferenceDrift({ PROOVRA_IMAGE_TAG: "latest" }), null);
  assert.equal(imageReferenceDrift({ PROOVRA_IMAGE_TAG: "latest", APP_RELEASE_SHA: "not-a-sha" }), null);
});
