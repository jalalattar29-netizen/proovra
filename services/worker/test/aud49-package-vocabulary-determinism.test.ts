/**
 * AUD-49 (2026-10-20) — the package's vocabulary and determinism.
 *
 *   * package-checksums.json lists files in code-point order — never the host
 *     locale, so the same package is byte-identical on every machine;
 *   * the README names each version label and what it versions (report,
 *     package format, signing key; a JSON file's own "version" is none of
 *     them);
 *   * the FULL package states that it carries internal identifiers and storage
 *     details by design, and for whom.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

vi.mock("../src/db.js", () => ({ prisma: {} }));

const { buildPackageChecksums } = await import("../src/verification-package.js");

const SRC = readFileSync(fileURLToPath(new URL("../src/verification-package.ts", import.meta.url)), "utf8");
const readme = SRC.slice(SRC.indexOf("function buildReadme("), SRC.indexOf("export function buildCourtReadinessChecklist("));

describe("AUD-49 package vocabulary and determinism", () => {
  it("checksums are listed in code-point order, not the locale's", () => {
    const entry = (name: string) => ({ name, buffer: Buffer.from(name) }) as never;
    const out = buildPackageChecksums([entry("b.json"), entry("a.json"), entry("Z.json"), entry("B.json"), entry("é.json")]);
    expect(out.files.map((f: { path: string }) => f.path)).toEqual(["B.json", "Z.json", "a.json", "b.json", "é.json"]);
  });

  it("the README names every version label and what it versions", () => {
    expect(readme).toContain("Package Format Version: ${PACKAGE_FORMAT_VERSION_SEALED} (the layout and seal format of this package)");
    expect(readme).toContain('"Report Version" is the version of the issued report this package certifies');
    expect(readme).toContain("is that file's own schema version and is none of these.");
  });

  it("the FULL package states what internal details it carries and for whom", () => {
    expect(readme).toContain("This FULL FORENSIC package carries internal PROOVRA account, workspace and\norganization identifiers and internal storage details");
    expect(readme).toContain("For anyone else, issue the External disclosure package");
  });
});
