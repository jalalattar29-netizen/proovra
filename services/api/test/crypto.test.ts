import { describe, expect, it } from "vitest";
import { canonicalJson, sha256Hex } from "../src/crypto";

describe("crypto helpers", () => {
  it("sha256Hex is deterministic", () => {
    expect(sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    );
  });

  it("canonicalJson orders keys", () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });
});
