/**
 * DOM-14 — ONE kind → legacy-scope mapper.
 *
 * The platform-context envelope (`legacyScopeFromKind`) and the per-workspace
 * capability resolver (`scopeFromKind`) each carried an identical copy. There
 * is now one, exported from workspace-capability.service.ts and imported by the
 * envelope builder. This drives it over every resolved workspace kind.
 */
import { describe, expect, it } from "vitest";

import { RESOLVED_WORKSPACE_KINDS } from "../src/services/platform-context/types.js";
import { legacyScopeFromKind } from "../src/services/platform-context/workspace-capability.service.js";
import * as envelopeModule from "../src/services/platform-context/platform-context.service.js";

describe("DOM-14 — the single legacy-scope mapper", () => {
  it("maps every resolved workspace kind", () => {
    const mapped = Object.fromEntries(
      RESOLVED_WORKSPACE_KINDS.map((kind) => [kind, legacyScopeFromKind(kind)]),
    );
    expect(mapped).toEqual({
      PERSONAL: "PERSONAL",
      OWNED: "TEAM",
      ORGANIZATION: "TEAM",
      // A kind that could not be proven is presented as neither scope.
      UNKNOWN: null,
    });
  });

  it("the enumeration it is tested over is the full kind set", () => {
    expect([...RESOLVED_WORKSPACE_KINDS].sort()).toEqual(
      ["ORGANIZATION", "OWNED", "PERSONAL", "UNKNOWN"],
    );
  });

  it("the envelope module exposes no second mapper", () => {
    expect(Object.keys(envelopeModule)).not.toContain("scopeFromKind");
    expect(Object.keys(envelopeModule)).not.toContain("legacyScopeFromKind");
  });
});
