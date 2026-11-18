/**
 * PRO-G2Z-01 (RG-20) — the canonical SECURITY / Trust Center seed text must
 * match what the storage layer does. Native S3 legal holds were removed
 * (storage.ts; s3-object-lock-commands.test.ts proves the command is never
 * sent); legal hold is enforced by the application. The seed is platform
 * text published to every workspace, so the claim is pinned here.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const SEED = readFileSync(
  resolve(__dirname, "..", "src", "services", "trust", "trust-center.service.ts"),
  "utf8",
);

describe("trust seed text — storage legal-hold claims (PRO-G2Z-01)", () => {
  it("never claims a storage-native legal hold", () => {
    expect(SEED).not.toContain("PutObjectLegalHoldCommand");
    expect(SEED).not.toContain("retention + legal-hold semantics");
  });

  it("states that legal hold is enforced by the application", () => {
    expect(SEED).toContain("Legal holds are NOT placed as storage-native S3 legal holds");
  });
});
