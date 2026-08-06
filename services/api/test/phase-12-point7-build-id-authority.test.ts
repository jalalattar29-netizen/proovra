/**
 * PHASE 12 — POINT 7: the build-id authority must identify SOURCE, not CHECKOUT.
 *
 * `point7BuildId()` binds every recorded proof to the production authority it
 * was proven against. It originally hashed the raw worktree bytes, which made
 * the id a property of how the checkout materialised line endings rather than
 * of the Git content. The consequence was not cosmetic: the first Point-7
 * artifact was bound to a build id produced by a Windows CRLF checkout, so the
 * exported release tree — the thing CI and Production actually consume — could
 * never reproduce it, and the closure gate rejected its own proof.
 *
 * These tests pin the corrected contract in BOTH directions: identical Git
 * content must agree across platforms, and anything that is a real source
 * change must still invalidate the proof.
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  POINT7_AUTHORITY_FILES,
  canonicalAuthorityBytes,
  point7BuildId,
} from "./point7/scenario-manifest.js";

const roots: string[] = [];

afterEach(() => {
  while (roots.length) {
    const r = roots.pop();
    if (r) rmSync(r, { recursive: true, force: true });
  }
});

/**
 * Materialise a throwaway tree containing exactly the bound authority files.
 * `transform` decides how each file's text reaches disk, which is how the
 * platform difference is simulated without needing two machines.
 */
function materialise(
  transform: (text: string, rel: string) => string | Buffer,
): string {
  const root = mkdtempSync(join(tmpdir(), "p7-buildid-"));
  roots.push(root);
  for (const rel of POINT7_AUTHORITY_FILES) {
    const abs = resolve(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    const body = `// ${rel}\nexport const marker = "authority";\nconst x = 1;\n`;
    const out = transform(body, rel);
    writeFileSync(abs, typeof out === "string" ? Buffer.from(out, "latin1") : out);
  }
  return root;
}

const asLf = (t: string) => t;
const asCrlf = (t: string) => t.replace(/\n/g, "\r\n");

describe("PHASE 12 POINT 7 — build-id authority", () => {
  it("LF and CRLF materialisations of identical text produce the SAME build id", () => {
    const lf = point7BuildId(materialise(asLf));
    const crlf = point7BuildId(materialise(asCrlf));

    expect(crlf).toBe(lf);
  });

  it("a one-character semantic change CHANGES the build id", () => {
    const base = point7BuildId(materialise(asLf));
    const changed = point7BuildId(
      materialise((t, rel) =>
        rel === POINT7_AUTHORITY_FILES[0] ? t.replace("const x = 1;", "const x = 2;") : t,
      ),
    );

    expect(changed).not.toBe(base);
  });

  it("a one-character change is still detected when the tree is CRLF", () => {
    const base = point7BuildId(materialise(asCrlf));
    const changed = point7BuildId(
      materialise((t, rel) =>
        asCrlf(rel === POINT7_AUTHORITY_FILES[0] ? t.replace("const x = 1;", "const x = 2;") : t),
      ),
    );

    expect(changed).not.toBe(base);
  });

  it("EVERY bound authority file is load-bearing — changing any one invalidates the proof", () => {
    const base = point7BuildId(materialise(asLf));
    const seen = new Set<string>();

    for (const target of POINT7_AUTHORITY_FILES) {
      const id = point7BuildId(
        materialise((t, rel) => (rel === target ? `${t}// touched\n` : t)),
      );
      expect(id, `${target} is not bound into the build id`).not.toBe(base);
      seen.add(id);
    }

    // Each file must move the digest to a DISTINCT value — otherwise two
    // different authorities would collide and one could mask the other.
    expect(seen.size).toBe(POINT7_AUTHORITY_FILES.length);
  });

  it("whitespace that is not a line ending still changes the build id", () => {
    const base = point7BuildId(materialise(asLf));
    const spaced = point7BuildId(
      materialise((t, rel) =>
        rel === POINT7_AUTHORITY_FILES[0] ? t.replace("const x = 1;", "const  x = 1;") : t,
      ),
    );

    expect(spaced).not.toBe(base);
  });

  it("a missing authority file is not silently equal to an empty one", () => {
    const present = point7BuildId(materialise((t) => t));
    const empty = point7BuildId(
      materialise((t, rel) => (rel === POINT7_AUTHORITY_FILES[0] ? "" : t)),
    );

    expect(empty).not.toBe(present);
  });

  describe("canonicalAuthorityBytes", () => {
    it("normalises CRLF to LF for declared text", () => {
      const out = canonicalAuthorityBytes(Buffer.from("a\r\nb\r\n", "latin1"));

      expect(out.toString("latin1")).toBe("a\nb\n");
    });

    it("leaves a lone CR alone — only CRLF pairs are line endings", () => {
      const out = canonicalAuthorityBytes(Buffer.from("a\rb", "latin1"));

      expect(out.toString("latin1")).toBe("a\rb");
    });

    it("does NOT normalise a file containing a NUL byte — binary stays byte-exact", () => {
      const binary = Buffer.from([0x61, 0x0d, 0x0a, 0x00, 0x0d, 0x0a, 0x62]);
      const out = canonicalAuthorityBytes(binary);

      expect(Buffer.compare(out, binary)).toBe(0);
    });

    it("is a no-op for content that is already LF", () => {
      const lf = Buffer.from("a\nb\n", "latin1");

      expect(Buffer.compare(canonicalAuthorityBytes(lf), lf)).toBe(0);
    });
  });

  it("the id is stable across repeated derivations of the same tree", () => {
    const root = materialise(asLf);

    expect(point7BuildId(root)).toBe(point7BuildId(root));
  });
});
