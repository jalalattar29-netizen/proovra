/**
 * THE ACCEPTANCE VERSION — ONE DEFINITION, AND IT MATCHES THE DOCUMENT.
 *
 * ===========================================================================
 * WHAT WENT WRONG, AND WHY IT IS GATED HERE
 * ===========================================================================
 * The version a user must accept used to be a hand-written table of three
 * dates, and it existed in FOUR places: `services/api/src/legal/legal-versioning.ts`
 * and a local `const REQUIRED_LEGAL_VERSIONS` inside each of
 * `app/register/page.tsx`, `app/login/page.tsx` and
 * `app/auth/verify-email/page.tsx`.
 *
 * All four said `2026-04-06`. The documents themselves had said `2026-06-23`
 * and `2026-06-26` for months.
 *
 * So every acceptance record claimed the user had agreed to a revision of the
 * Terms that was NOT the revision they were shown — the single fact an
 * acceptance record exists to state correctly, recorded wrongly, four times
 * over, with no test that could notice.
 *
 * The requirement is now DERIVED from each document's own `Last Updated:` line
 * in `@proovra/shared/legal`. These two tests pin both halves: it agrees with
 * the document, and nobody has written a fifth copy.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..", "..");

const toPosix = (p: string) => p.split(sep).join("/");
const sep = process.platform === "win32" ? "\\" : "/";

test("the required acceptance version equals the document's own date", async () => {
  const legal = await import("@proovra/shared/legal");

  for (const key of legal.REQUIRED_LEGAL_POLICY_KEYS) {
    const doc = legal.getLegalDocument(key);
    assert.ok(doc, `${key} is acceptance-gated but has no document`);
    assert.equal(
      legal.REQUIRED_LEGAL_VERSIONS[key],
      doc.lastUpdated,
      `${key}: a user would accept "${legal.REQUIRED_LEGAL_VERSIONS[key]}" ` +
        `while reading a document dated "${doc.lastUpdated}"`,
    );
  }
});

test("every acceptance-gated policy is a real legal document", () => {
  // A key with no document would make the gate unsatisfiable: the user is
  // asked to accept something the product cannot show them.
  return import("@proovra/shared/legal").then((legal) => {
    for (const key of legal.REQUIRED_LEGAL_POLICY_KEYS) {
      assert.ok(
        legal.isLegalSlug(key),
        `${key} is required for acceptance but is not in LEGAL_SLUGS`,
      );
    }
  });
});

test("no surface declares its own acceptance version table", () => {
  const offenders: string[] = [];
  const skip = new Set(["node_modules", ".git", ".next", "dist", "build", "android", "ios"]);

  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (skip.has(entry.name)) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!/\.(ts|tsx)$/.test(entry.name)) continue;

      const src = readFileSync(full, "utf8");
      // A local DECLARATION, not an import and not a re-export.
      if (/^\s*(?:export\s+)?(?:const|let|var)\s+REQUIRED_LEGAL_VERSIONS\s*[:=]/m.test(src)) {
        offenders.push(toPosix(full.slice(REPO_ROOT.length + 1)));
      }
    }
  };

  for (const top of ["apps", "packages", "services"]) walk(join(REPO_ROOT, top));

  // Exactly one: the derived declaration in the shared legal module.
  assert.deepEqual(
    offenders,
    ["packages/shared/src/legal.ts"],
    "these declare their own acceptance versions instead of deriving them:\n  " +
      offenders.join("\n  "),
  );
});

test("the acceptance version is computed, never a literal date", () => {
  const src = readFileSync(
    join(REPO_ROOT, "packages", "shared", "src", "legal.ts"),
    "utf8",
  );
  const block = src.match(
    /export const REQUIRED_LEGAL_VERSIONS[\s\S]*?\n\);/,
  );
  assert.ok(block, "REQUIRED_LEGAL_VERSIONS declaration not found");

  // A hard-coded date here is the exact regression this whole change removes.
  assert.doesNotMatch(
    block[0],
    /\d{4}-\d{2}-\d{2}/,
    "a literal date was written back into the acceptance table",
  );
  assert.match(block[0], /LEGAL_CORPUS\[key\]\.lastUpdated/);
});
