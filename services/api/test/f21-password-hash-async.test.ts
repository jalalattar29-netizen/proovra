/**
 * F-21 — password hashing runs on the libuv pool (async `crypto.scrypt`), with
 * the exact parameters every stored hash was written with.
 *
 *   - a hash written by the previous synchronous implementation (reproduced
 *     here with `scryptSync`, N=16384 r=8 p=1, 16-byte salt, 32-byte key, hex)
 *     still verifies, and a wrong password still fails;
 *   - a new hash has the identical `scrypt$N$r$p$saltHex$hashHex` format and is
 *     byte-for-byte what `scryptSync` derives from its own salt;
 *   - malformed or unbounded stored hashes are refused, never thrown;
 *   - the derivation does not block the event loop.
 */
import { randomBytes, scryptSync } from "node:crypto";

import { describe, expect, it } from "vitest";

import { hashPassword, verifyPassword } from "../src/services/email-password-auth.service.js";

function legacyHash(password: string): string {
  const N = 16384;
  const r = 8;
  const p = 1;
  const salt = randomBytes(16);
  const key = scryptSync(password, salt, 32, { N, r, p });
  return `scrypt$${N}$${r}$${p}$${salt.toString("hex")}$${key.toString("hex")}`;
}

describe("F-21 async scrypt password hashing", () => {
  it("verifies a hash written by the previous synchronous implementation", async () => {
    const stored = legacyHash("Legacy-Password-1234");
    expect(await verifyPassword("Legacy-Password-1234", stored)).toBe(true);
    expect(await verifyPassword("legacy-password-1234", stored)).toBe(false);
  });

  it("writes the identical format and the bytes scryptSync derives from the same salt", async () => {
    const stored = await hashPassword("New-Password-5678");
    const match = /^scrypt\$16384\$8\$1\$([0-9a-f]{32})\$([0-9a-f]{64})$/.exec(stored);
    expect(match).not.toBeNull();
    const [, saltHex, keyHex] = match as RegExpExecArray;
    const recomputed = scryptSync("New-Password-5678", Buffer.from(saltHex, "hex"), 32, {
      N: 16384,
      r: 8,
      p: 1,
    });
    expect(recomputed.toString("hex")).toBe(keyHex);
    expect(await verifyPassword("New-Password-5678", stored)).toBe(true);
    expect(await verifyPassword("New-Password-5679", stored)).toBe(false);
  });

  it("refuses malformed and unbounded stored hashes without throwing", async () => {
    const salt = randomBytes(16).toString("hex");
    // Empty stored key: must not compare equal to an empty derivation.
    expect(await verifyPassword("anything", `scrypt$16384$8$1$${salt}$`)).toBe(false);
    // Parameters asking for far more memory than the ceiling.
    expect(
      await verifyPassword("anything", `scrypt$1048576$64$1$${salt}$${"ab".repeat(32)}`),
    ).toBe(false);
    // Not a power of two — scrypt refuses; we answer false.
    expect(await verifyPassword("anything", `scrypt$1000$8$1$${salt}$${"ab".repeat(32)}`)).toBe(false);
    expect(await verifyPassword("anything", "bcrypt$whatever")).toBe(false);
    expect(await verifyPassword("anything", `scrypt$x$8$1$${salt}$${"ab".repeat(32)}`)).toBe(false);
  });

  it("does not block the event loop while deriving", async () => {
    let ticks = 0;
    const timer = setInterval(() => {
      ticks += 1;
    }, 1);
    try {
      await Promise.all([
        hashPassword("Concurrent-Password-1"),
        hashPassword("Concurrent-Password-2"),
        hashPassword("Concurrent-Password-3"),
        hashPassword("Concurrent-Password-4"),
      ]);
    } finally {
      clearInterval(timer);
    }
    // With scryptSync the interval could not fire at all until every
    // derivation finished; on the pool it fires while they run.
    expect(ticks).toBeGreaterThan(0);
  });
});
