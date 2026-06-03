/**
 * Phase R9 — Worker → API import boundary regression (load-provenance-chain).
 *
 * The worker ships as a SEPARATE Docker image
 * (`services/worker/Dockerfile`). The API service's `src/` tree is NOT
 * copied into that image. Any worker file that imports from
 * `services/api/src/...` breaks the production Docker worker build at
 * runtime (the module cannot be resolved inside the worker image).
 *
 * The original Docker failure named exactly one file:
 *   services/worker/src/capture-trust/load-provenance-chain.ts
 *   → '../../../api/src/services/capture-trust/provenance-projection.service.js'
 *
 * This regression test scopes itself NARROWLY to that file (and its
 * sibling worker-local helper `./provenance-projection.ts`) — it
 * asserts neither imports from `services/api/src/...`. The broader
 * "no worker file anywhere may import services/api/src" check is
 * intentionally out of scope for this turn (the parent task forbade
 * touching unrelated worker files); other pre-existing cross-service
 * imports remain for a follow-up cleanup pass.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
const FILES_UNDER_CONTRACT = [
    resolve(__dirname, "../../worker/src/capture-trust/load-provenance-chain.ts"),
    resolve(__dirname, "../../worker/src/capture-trust/provenance-projection.ts"),
];
// Patterns that indicate a cross-service import into the API tree.
// Cover both static `from "..."` and dynamic `await import("...")`
// forms — the original violation used dynamic import.
const FORBIDDEN_PATTERNS = [
    /from\s+["'](?:\.\.\/)+api\/src\//,
    /import\s*\(\s*["'](?:\.\.\/)+api\/src\//,
    /from\s+["'][^"']*services\/api\/src\//,
    /import\s*\(\s*["'][^"']*services\/api\/src\//,
];
describe("Phase R9 — worker → API boundary (provenance-chain pipeline)", () => {
    it("load-provenance-chain.ts + provenance-projection.ts do NOT import services/api/src", () => {
        const violations = [];
        for (const file of FILES_UNDER_CONTRACT) {
            const src = readFileSync(file, "utf8");
            const lines = src.split(/\r?\n/);
            lines.forEach((line, idx) => {
                for (const pat of FORBIDDEN_PATTERNS) {
                    if (pat.test(line)) {
                        violations.push({ file, line: idx + 1, text: line.trim() });
                        break;
                    }
                }
            });
        }
        const report = violations
            .map((v) => `  ${v.file}:${v.line}  →  ${v.text}`)
            .join("\n");
        expect(violations, `Worker provenance-chain files importing services/api/src:\n${report}`).toEqual([]);
    });
    it("loader delegates to the worker-local projection", () => {
        const loader = readFileSync(FILES_UNDER_CONTRACT[0], "utf8");
        // Loader must call `projectProvenanceChain` and import it from a
        // sibling worker-local path (relative + ending in "./provenance-projection").
        expect(loader).toMatch(/projectProvenanceChain/);
        expect(loader).toMatch(/from\s+["']\.\/provenance-projection(?:\.js)?["']/);
    });
});
