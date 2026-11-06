/**
 * REPORT-009 — no certification mark or claim without a recorded certification.
 *
 * The home page showed SOC, ISO and NIST logos labelled "Security control
 * principles", "Aligned security controls" and "NIST-aligned controls", while
 * PROOVRA's own security policy says it claims no SOC 2, ISO 27001 or other
 * certification. A mark reads as a certification whatever the caption says.
 * This guard reads every public page and marketing component: a certification
 * logo or a "SOC 2 / ISO 27001 / NIST-aligned / certified" claim must be
 * backed by an entry in lib/marketing/certifications.ts.
 */
import { strict as assert } from "node:assert";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { RECORDED_CERTIFICATIONS } from "../lib/marketing/certifications";

const WEB = join(dirname(fileURLToPath(import.meta.url)), "..");

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === "node_modules" || name === "(app)" ? [] : walk(path);
    return /\.(tsx|ts)$/.test(name) ? [path] : [];
  });
}

/** Public pages (the authenticated app is out of scope) and marketing components. */
const PUBLIC_SOURCES = [...walk(join(WEB, "app")), ...walk(join(WEB, "components", "marketing"))];

const MARKS = ["/assets/logos/soc.svg", "/assets/logos/iso.svg", "/assets/logos/nist.svg"];
const CLAIMS = /\b(SOC ?2|ISO ?27001|ISO\/IEC ?27001|NIST[- ]aligned|SOC[- ]compliant|ISO[- ]certified)\b/i;

function code(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

describe("REPORT-009: certification marks and claims need a recorded certification", () => {
  it("scans the public pages", () => {
    assert.ok(PUBLIC_SOURCES.length > 50, `only ${PUBLIC_SOURCES.length} files scanned`);
  });

  it("no certification mark is shown that is not recorded", () => {
    const allowed = new Set(RECORDED_CERTIFICATIONS.map((c) => c.logo).filter(Boolean));
    const found = PUBLIC_SOURCES.flatMap((f) => {
      const src = code(readFileSync(f, "utf8"));
      return MARKS.filter((m) => src.includes(m) && !allowed.has(m)).map((m) => `${relative(WEB, f)}: ${m}`);
    });
    assert.deepEqual(found, []);
  });

  it("no certification is claimed in page copy while none is recorded", () => {
    if (RECORDED_CERTIFICATIONS.length > 0) return;
    const found = PUBLIC_SOURCES.filter((f) => CLAIMS.test(code(readFileSync(f, "utf8")))).map((f) => relative(WEB, f));
    assert.deepEqual(found, []);
  });

  it("control: the security policy still states that no certification is claimed", () => {
    const policy = readFileSync(join(WEB, "content", "legal", "en", "security.md"), "utf8");
    assert.match(policy, /does not claim SOC 2, ISO 27001/);
  });
});
