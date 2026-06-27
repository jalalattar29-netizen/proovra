/**
 * PROOVRA Phase 2 — Public verify endpoint outputContext field.
 *
 * The public verify endpoint must emit a canonical `outputContext`
 * field so Phase 3 UI can render snapshot vs live cleanly without
 * re-deriving the semantics in the page. The field shape mirrors
 * `CanonicalOutputContext` from packages/shared.
 *
 * The full endpoint is 1500 lines and requires Prisma + many
 * services to invoke at runtime; Phase 2 testing pins the source so
 * Phase 3 cannot silently drop the field. Phase 3 will refactor the
 * route to build the full canonical materials bundle, then a
 * contract test on the runtime response will replace this pin.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const evidenceRoutesSrc = readFileSync(
  fileURLToPath(
    new URL("../src/routes/evidence.routes.ts", import.meta.url),
  ),
  "utf8",
);

describe("Phase 2 — public verify response includes canonical outputContext", () => {
  it("imports buildCanonicalLegalBoundaryMaterial + CanonicalOutputContext from @proovra/shared", () => {
    expect(evidenceRoutesSrc).toContain(
      "buildCanonicalLegalBoundaryMaterial,",
    );
    expect(evidenceRoutesSrc).toContain(
      "type CanonicalOutputContext,",
    );
  });

  it("emits an outputContext field shaped per CanonicalOutputContext", () => {
    expect(evidenceRoutesSrc).toContain('outputContext: ((): CanonicalOutputContext');
    expect(evidenceRoutesSrc).toContain('outputType: "PUBLIC_VERIFY_LIVE"');
    expect(evidenceRoutesSrc).toContain("isSnapshotOutput: false,");
    expect(evidenceRoutesSrc).toContain("isLiveOutput: true,");
    expect(evidenceRoutesSrc).toContain('liveDeltaMaterials: ["custodyChain", "otsAnchoring"]');
  });

  it("sources the legal boundary from the shared canonical helper, not a local string", () => {
    expect(evidenceRoutesSrc).toContain(
      "buildCanonicalLegalBoundaryMaterial()",
    );
    expect(evidenceRoutesSrc).toContain(".publicVerifyBoundary");
  });
});
