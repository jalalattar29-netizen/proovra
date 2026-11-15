/**
 * CAP-9 — the pool ceiling is a setting whose default is the value every
 * deployment already ran with (the `pg` default of 10). A bad value stops the
 * process instead of being guessed at.
 */
import { describe, expect, it } from "vitest";

process.env.DATABASE_URL ??= "postgresql://local:local@127.0.0.1:5432/local_test";
const { databasePoolMax, DEFAULT_DATABASE_POOL_MAX, databasePoolConnectionTimeoutMs, DEFAULT_DATABASE_POOL_CONNECTION_TIMEOUT_MS } =
  await import("../src/db.js");

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

// F-08 (2026-11-15) — the pool wait is bounded by default; 0 is the explicit old behaviour.
describe("DATABASE_POOL_CONNECTION_TIMEOUT_MS", () => {
  it("unset or blank bounds the wait at 10 s", () => {
    expect(DEFAULT_DATABASE_POOL_CONNECTION_TIMEOUT_MS).toBe(10_000);
    expect(databasePoolConnectionTimeoutMs(undefined)).toBe(10_000);
    expect(databasePoolConnectionTimeoutMs(" ")).toBe(10_000);
  });

  it("a whole number from 0 to 600000 is used as given (0 = wait without bound)", () => {
    expect(databasePoolConnectionTimeoutMs("0")).toBe(0);
    expect(databasePoolConnectionTimeoutMs(" 2500 ")).toBe(2_500);
    expect(databasePoolConnectionTimeoutMs("600000")).toBe(600_000);
  });

  it("anything else is refused", () => {
    for (const bad of ["-1", "1.5", "600001", "soon"]) {
      expect(() => databasePoolConnectionTimeoutMs(bad)).toThrow(/DATABASE_POOL_CONNECTION_TIMEOUT_MS/);
    }
  });
});
