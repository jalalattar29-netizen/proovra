/**
 * OPS-001 — the Library's "Public verification" row states what the page does,
 * from the record's access state. It read a removed external anchor, so it said
 * "Not configured for this record" of a record whose page answers.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";

import { publicVerificationPageState } from "../app/(app)/evidence/lib/evidence-library-helpers";

test("a sealed record's page is available, and states what it discloses", () => {
  const verification = publicVerificationPageState({ status: "SIGNED", verificationAccessState: "AVAILABLE", verificationDisclosureMode: "VERIFICATION_ONLY" });
  assert.equal(verification.state, "available");
  assert.match(verification.detail, /verification only/);
  assert.match(publicVerificationPageState({ status: "REPORTED", verificationDisclosureMode: "CONTENT_PREVIEW" }).detail, /content preview/);
});

test("a withdrawn or suspended page is not offered as available", () => {
  assert.equal(publicVerificationPageState({ status: "SIGNED", verificationAccessState: "WITHDRAWN" }).state, "restricted");
  assert.equal(publicVerificationPageState({ status: "SIGNED", verificationAccessState: "SUSPENDED" }).state, "restricted");
});

test("an unsealed record has no page yet", () => {
  assert.equal(publicVerificationPageState({ status: "UPLOADING" }).state, "pending");
});
