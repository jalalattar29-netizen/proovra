/**
 * AUD-44 (2026-10-20) — ONE storage rule. The run's storage snapshot says
 * immutable (and so Report.storageImmutableSnapshot and the package's
 * storageImmutable) only when the canonical classifier CONFIRMED the lock: an
 * authoritative read of an in-force COMPLIANCE lock. A lock merely RECORDED on
 * the row (no object to read, or the read failed) is never immutable.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

let calls = 0;
let impl: (...a: unknown[]) => Promise<unknown> = async () => ({});
const head = (...a: unknown[]) => {
  calls += 1;
  return impl(...a);
};
vi.mock("../src/db.js", () => ({ prisma: {} }));
vi.mock("../src/storage.js", async (orig) => ({ ...(await orig<Record<string, unknown>>()), headObject: (...a: unknown[]) => head(...a) }));

const { resolveEvidenceStorageSnapshot } = await import("../src/processor.js");

const FUTURE = new Date("2099-01-01T00:00:00.000Z");
const base = { storageBucket: "b", storageKey: "k", storageVersionId: "v1", storageObjectLockMode: "COMPLIANCE", storageObjectLockRetainUntilUtc: FUTURE };

describe("AUD-44 storage snapshot immutability follows the canonical classifier", () => {
  beforeEach(() => {
    calls = 0;
  });

  it("an observed in-force COMPLIANCE lock is immutable", async () => {
    impl = async () => ({ objectLockMode: "COMPLIANCE", objectLockRetainUntilDate: FUTURE });
    expect(await resolveEvidenceStorageSnapshot(base)).toMatchObject({ storageImmutable: true, storageProtectionSource: "OBSERVED" });
  });

  it("a recorded COMPLIANCE lock whose read failed is NOT immutable", async () => {
    impl = async () => {
      throw new Error("network");
    };
    expect(await resolveEvidenceStorageSnapshot(base)).toMatchObject({ storageImmutable: false, storageProtectionSource: "RECORDED", storageReadFailed: true });
  });

  it("a recorded COMPLIANCE lock with no object to read is NOT immutable", async () => {
    expect(await resolveEvidenceStorageSnapshot({ ...base, storageBucket: null, storageKey: null })).toMatchObject({ storageImmutable: false, storageProtectionSource: "RECORDED" });
    expect(calls).toBe(0);
  });

  it("an observed COMPLIANCE lock whose retention has passed is NOT immutable", async () => {
    impl = async () => ({ objectLockMode: "COMPLIANCE", objectLockRetainUntilDate: new Date("2020-01-01T00:00:00Z") });
    expect((await resolveEvidenceStorageSnapshot(base)).storageImmutable).toBe(false);
  });

  it("an observed GOVERNANCE lock is NOT immutable", async () => {
    impl = async () => ({ objectLockMode: "GOVERNANCE", objectLockRetainUntilDate: FUTURE });
    expect((await resolveEvidenceStorageSnapshot(base)).storageImmutable).toBe(false);
  });
});
