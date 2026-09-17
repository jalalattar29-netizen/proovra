/**
 * UC-0 — the zero-legacy-acquisition-authority gate.
 *
 * Acquisition truth has ONE authority: `Evidence.acquisitionMode`, resolved by
 * `resolveEvidenceAcquisition`. This gate stops a future change from quietly
 * reintroducing acquisition inference from a deprecated field — the exact
 * regressions UC-0 closed:
 *
 *   - executive metrics counting a non-existent `captureMethod: "MOBILE_NATIVE"`
 *     (a competing, always-throwing vocabulary) and labelling it "high trust";
 *   - the Evidence Copilot being shown the structure enum `captureMethod`
 *     instead of the canonical acquisition;
 *   - a customer surface rendering the retired public Class A/B/C labels.
 *
 * It is a SOURCE-CONTRACT scan: prose that NAMES a retired term (a comment
 * explaining why it is gone) is not the term, so comments are stripped first.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../../..");

function read(rel: string): string {
  return readFileSync(resolve(REPO, rel), "utf8");
}

/** Source with block and line comments removed (and string-literal-safe enough
 *  for token scanning): prose that names a retired term is not the term. */
function code(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .split("\n")
    .map((line) => line.replace(/(^|[^:])\/\/.*$/, "$1"))
    .join("\n");
}

/** Recursively list *.ts / *.tsx under a root, excluding tests and node_modules. */
function sourceFiles(rootRel: string): string[] {
  const out: string[] = [];
  const root = resolve(REPO, rootRel);
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (entry === "node_modules" || entry === "dist" || entry === ".next") continue;
      const st = statSync(full);
      if (st.isDirectory()) {
        walk(full);
        continue;
      }
      if (!/\.(ts|tsx)$/.test(entry)) continue;
      if (/\.(test|spec)\.(ts|tsx)$/.test(entry)) continue;
      if (entry.endsWith(".d.ts")) continue;
      out.push(full);
    }
  };
  walk(root);
  return out;
}

// Files allowed to name a retired term because they ARE the authority that
// retires it (the resolver, the claims blocklist, the capture-trust vocabulary
// that documents the retired labels, and the acquisition display mapper).
const ALLOW = [
  "packages/shared/src/evidence-acquisition.ts",
  "packages/shared-evidence-presentation/src/claims-matrix.ts",
  "packages/shared/src/capture-trust.ts",
  "packages/shared-runtime/src/capture-trust/provenance-chain.ts",
  "packages/shared-runtime/src/technical-metadata/display-helpers.ts",
  "packages/shared-runtime/src/technical-metadata/acquisition.ts",
].map((p) => resolve(REPO, p));

describe("UC-0 — one acquisition authority (zero legacy inference)", () => {
  it("no production source counts or labels acquisition by captureMethod: \"MOBILE_NATIVE\"", () => {
    const roots = ["services/api/src", "services/worker/src", "apps/web/app", "apps/web/components"];
    const offenders: string[] = [];
    for (const rootRel of roots) {
      for (const full of sourceFiles(rootRel)) {
        if (ALLOW.includes(full)) continue;
        const src = code(readFileSync(full, "utf8"));
        // The competing vocabulary token, in any position.
        if (/\bMOBILE_NATIVE\b/.test(src)) {
          offenders.push(`${full.slice(REPO.length + 1)}: names MOBILE_NATIVE`);
        }
        // A captureMethod EQUALITY used as an acquisition selector.
        if (/captureMethod\s*:\s*["'](MOBILE_NATIVE|SECURE_CAMERA)["']/.test(src)) {
          offenders.push(`${full.slice(REPO.length + 1)}: queries acquisition by captureMethod`);
        }
      }
    }
    expect(offenders, offenders.join("\n")).toEqual([]);
  });

  it("executive metrics count the mobile channel by the canonical acquisition mode", () => {
    const src = read("services/api/src/services/intelligence/executive-metrics.service.ts");
    expect(src).toMatch(/acquisitionMode:\s*"PROOVRA_MOBILE_APP"/);
    expect(code(src)).not.toMatch(/MOBILE_NATIVE/);
    // No tile claims a trust level from a channel.
    expect(code(read("apps/web/app/(app)/executive/page.tsx"))).not.toMatch(/High-trust/i);
  });

  it("the Evidence Copilot is shown the canonical acquisition, never the structure enum", () => {
    const routes = code(read("services/api/src/routes/ai-evidence.routes.ts"));
    // The model-facing allowlist names acquisition, not captureMethod.
    expect(routes).toMatch(/"acquisition"/);
    expect(routes).not.toMatch(/"captureMethod"/);
    const snapshot = code(read("services/api/src/services/ai/evidence-analysis-snapshot.service.ts"));
    expect(snapshot).toMatch(/resolveEvidenceAcquisition/);
    expect(snapshot).not.toMatch(/captureMethod/);
  });

  it("the evidence-detail provenance section renders the acquisition authority, not retired Class copy", () => {
    const section = code(
      read("apps/web/app/(app)/evidence/[id]/_tabs/EvidenceProvenanceChainSection.tsx"),
    );
    expect(section).toMatch(/chain\.acquisition\.label/);
    expect(section).not.toMatch(/CAPTURE_CLASS_COPY/);
    expect(section).not.toMatch(/verified device check/);
  });
});
