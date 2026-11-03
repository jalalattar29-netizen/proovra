/**
 * CAP-9 — the pool ceiling is a setting whose default is the value every
 * deployment already ran with (the `pg` default of 10). A bad value stops the
 * process instead of being guessed at.
 */
import { describe, expect, it } from "vitest";

process.env.DATABASE_URL ??= "postgresql://local:local@127.0.0.1:5432/local_test";
const { databasePoolMax, DEFAULT_DATABASE_POOL_MAX } = await import("../src/db.js");

describe("DATABASE_POOL_MAX", () => {
  it("unset or blank keeps the pg default of 10", () => {
    expect(DEFAULT_DATABASE_POOL_MAX).toBe(10);
    expect(databasePoolMax(undefined)).toBe(10);
    expect(databasePoolMax("  ")).toBe(10);
  });

  it("a whole number from 1 to 500 is used as given", () => {
    expect(databasePoolMax("1")).toBe(1);
    expect(databasePoolMax(" 40 ")).toBe(40);
    expect(databasePoolMax("500")).toBe(500);
  });

  it("anything else is refused", () => {
    for (const bad of ["0", "-3", "2.5", "501", "ten", "1e2x"]) {
      expect(() => databasePoolMax(bad)).toThrow(/DATABASE_POOL_MAX/);
    }
  });
});
