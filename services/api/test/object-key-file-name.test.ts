/**
 * AUD-0054 — the file-name fragment in an evidence object key is bounded in
 * UTF-8 BYTES. A 180-character Arabic + Hebrew name (360 bytes) passed the
 * character check and failed at the storage PUT (`XMinioInvalidObjectName`),
 * leaving the record UPLOADING. Each key segment must stay within 255 bytes.
 */
import { describe, expect, it } from "vitest";

import {
  OBJECT_KEY_FILE_NAME_MAX_BYTES,
  objectKeyFileNameFragment,
} from "../src/services/storage/object-key-file-name.js";

const bytes = (s: string) => Buffer.byteLength(s, "utf8");

describe("objectKeyFileNameFragment (AUD-0054)", () => {
  it("keeps a short name unchanged", () => {
    expect(objectKeyFileNameFragment("audit-capture.txt")).toBe("audit-capture.txt");
    expect(objectKeyFileNameFragment("شهادة.pdf")).toBe("شهادة.pdf");
  });

  it("bounds the audit's 180-character Arabic + Hebrew name in bytes and keeps the extension", () => {
    const name = `${"ع".repeat(90)}${"ש".repeat(90)}.pdf`;
    expect(bytes(name)).toBeGreaterThan(255);
    const out = objectKeyFileNameFragment(name)!;
    expect(bytes(out)).toBeLessThanOrEqual(OBJECT_KEY_FILE_NAME_MAX_BYTES);
    expect(out.endsWith(".pdf")).toBe(true);
    // The key's last segment (`000-<name>` / `original-<name>`) fits the 255-byte limit.
    expect(bytes(`original-${out}`)).toBeLessThan(255);
  });

  it("never splits a 4-byte character (emoji) or a surrogate pair", () => {
    const out = objectKeyFileNameFragment(`${"📷".repeat(100)}.heic`)!;
    expect(bytes(out)).toBeLessThanOrEqual(OBJECT_KEY_FILE_NAME_MAX_BYTES);
    expect(out).toMatch(/^(?:📷)+\.heic$/u);
  });

  it("a name with no extension is cut at a character boundary", () => {
    const out = objectKeyFileNameFragment("ש".repeat(200))!;
    expect(bytes(out)).toBeLessThanOrEqual(OBJECT_KEY_FILE_NAME_MAX_BYTES);
    expect(out).toBe("ש".repeat(60));
  });

  it("nothing in, nothing out", () => {
    expect(objectKeyFileNameFragment(null)).toBeNull();
    expect(objectKeyFileNameFragment("")).toBeNull();
  });
});
