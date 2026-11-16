/**
 * R1-F-02 — record-detail linked requests, discussion and presence key on the
 * record's OWN workspace (`workspace.evidence.teamId`), as the discussion
 * capability and the Artifacts tab already do. `reviewWorkflow.teamId` exists
 * only when a reviewer workflow does, so a record without one showed no
 * requests (even to a credit-funded Free user) and a false "no workspace"
 * discussion notice.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const WEB = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string) => readFileSync(resolve(WEB, rel), "utf8");

test("EvidenceRequestPanel gets the record's own workspace first", () => {
  const src = read("app/(app)/evidence/[id]/_tabs/EvidenceOverviewTab.tsx");
  assert.match(src, /<EvidenceRequestPanel[\s\S]*?teamId=\{workspace\.evidence\.teamId \?\? workspace\.reviewWorkflow\?\.teamId \?\? null\}/);
});

test("EvidenceDiscussionPanel gets the record's own workspace first", () => {
  const src = read("app/(app)/evidence/[id]/_tabs/EvidenceDiscussionTab.tsx");
  assert.match(src, /<EvidenceDiscussionPanel[\s\S]*?teamId=\{workspace\.evidence\.teamId \?\? workspace\.reviewWorkflow\?\.teamId \?\? null\}/);
});

test("presence on the record page keys on the record's own workspace first", () => {
  const src = read("app/(app)/evidence/[id]/page.tsx");
  assert.match(src, /<PresenceIndicator\s+teamId=\{\(evidence\.teamId \?\? workspace\.reviewWorkflow\?\.teamId\)!\}/);
});
