/**
 * B5B-F-504 — /verify/demo depicts only what the real Verify page discloses.
 *
 * The public projection withholds identity by default and aggregates access
 * (public-verify-projection.ts: access aggregated, accessEvents []). The demo
 * listed reviewer emails, per-action events and a signer's name.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const WEB = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string) => readFileSync(resolve(WEB, rel), "utf8");
const DEMO = ["components/verify-demo/_shared.tsx", "components/verify-demo/Walkthrough.tsx", "components/verify-demo/WhatReviewerSees.tsx"];

test("no reviewer email or per-action access event in the demo", () => {
  for (const rel of DEMO) {
    const src = read(rel);
    assert.doesNotMatch(src, /[\w.+-]+@[\w-]+\.[\w.]+/, `${rel} shows an email address`);
    assert.doesNotMatch(src, /Opened Signatures tab|Downloaded sample report|Reviewer Access Log/, `${rel} lists per-action access`);
    assert.doesNotMatch(src, /who accessed the evidence and what they did/, rel);
  }
});

test("access is aggregated and identity withheld, as the public page shows it", () => {
  const shared = read("components/verify-demo/_shared.tsx");
  assert.match(shared, /signer: "Withheld by the record's disclosure policy"/);
  assert.match(shared, /accessEventCount: \d+/);
  assert.match(read("components/verify-demo/Walkthrough.tsx"), /data-demo-access-aggregated/);
});
