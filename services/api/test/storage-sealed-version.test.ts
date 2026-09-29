/**
 * ET-SM-03 — every operation on a sealed original addresses the RECORDED
 * version, never "whatever is latest at the key".
 *
 * On a40ca76f the verify-content viewUrl, the retention write, the lock
 * snapshot (HEAD) and the archive-tier copy all addressed the key alone, so a
 * later PUT at the key would be what the page linked, what retention locked,
 * what the snapshot described and what was archived — while the page printed
 * the signed sha256 of the sealed version.
 *
 * The S3 client's `send` is replaced: what is captured is the command PROOVRA
 * builds, which is the thing under test.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { applyDefaultObjectRetention, copyObjectStorageClass, headObject, s3 } from "../src/storage.js";

let sent: Array<{ name: string; input: Record<string, unknown> }> = [];
const LOCK_ENV = ["S3_OBJECT_LOCK_ENABLED", "S3_OBJECT_LOCK_MODE", "S3_OBJECT_LOCK_RETAIN_DAYS"] as const;
let previousEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  sent = [];
  previousEnv = Object.fromEntries(LOCK_ENV.map((k) => [k, process.env[k]]));
  // Production's posture, stated rather than inherited.
  process.env.S3_OBJECT_LOCK_ENABLED = "true";
  process.env.S3_OBJECT_LOCK_MODE = "COMPLIANCE";
  process.env.S3_OBJECT_LOCK_RETAIN_DAYS = "2920";
  vi.spyOn(s3, "send").mockImplementation((async (command: unknown) => {
    const c = command as { constructor: { name: string }; input: Record<string, unknown> };
    sent.push({ name: c.constructor.name, input: c.input });
    return { ContentLength: 1, ContentType: "application/octet-stream" };
  }) as never);
});
afterEach(() => {
  vi.restoreAllMocks();
  for (const k of LOCK_ENV) {
    if (previousEnv[k] === undefined) delete process.env[k];
    else process.env[k] = previousEnv[k]!;
  }
});

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const cmd = (name: string) => sent.find((c) => c.name === name)?.input ?? {};

describe("sealed-version addressing (ET-SM-03)", () => {
  it("retention locks the sealed version", async () => {
    await applyDefaultObjectRetention({ bucket: "b", key: "evidence/x/original", versionId: "v-sealed" });
    expect(cmd("PutObjectRetentionCommand").VersionId).toBe("v-sealed");
  });

  it("the lock snapshot HEADs the sealed version", async () => {
    await headObject({ bucket: "b", key: "evidence/x/original", versionId: "v-sealed" }).catch(() => null);
    expect(cmd("HeadObjectCommand").VersionId).toBe("v-sealed");
  });

  it("the archive copy reads FROM the sealed version", async () => {
    await copyObjectStorageClass({ bucket: "b", key: "evidence/x/original", storageClass: "GLACIER_IR", sourceVersionId: "v/sealed" });
    expect(cmd("CopyObjectCommand").CopySource).toBe("b/evidence/x/original?versionId=v%2Fsealed");
  });

  it("the callers pass the recorded version", () => {
    const routes = read("../src/routes/evidence.routes.ts");
    expect(routes).toMatch(/presignGetObject\(\{\s*bucket: part\.storageBucket,\s*key: part\.storageKey,\s*versionId: sealedVersionId,/);
    const complete = read("../src/services/evidence-complete.service.ts");
    expect(complete).toMatch(/applyDefaultObjectRetention\(\{\s*bucket: target\.bucket,\s*key: target\.key,\s*versionId: target\.versionId \?\? null,/);
    expect(complete).toMatch(/key: primaryTarget\.key,\s*versionId: primaryTarget\.versionId \?\? null,/);
    expect((complete.match(/retentionTargets\.push\(\{[^}]*versionId:/g) ?? []).length).toBe(3);
    const archive = read("../src/services/lifecycle/archive-tier.service.ts");
    expect(archive).toContain("sourceVersionId: evidence.storageVersionId ?? null,");
  });
});
