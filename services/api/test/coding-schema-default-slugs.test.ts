/**
 * Team remediation stage F — T-134. The web page decides whether "Seed default
 * schemas" can change anything from the shared slug list; this pins that list
 * to the API catalog the seed actually installs.
 */
import { describe, expect, it } from "vitest";
import { CODING_SCHEMA_DEFAULT_SLUGS } from "@proovra/shared";

import { DEFAULT_SCHEMAS } from "../src/services/reviewer-workspace/coding-schema-defaults.js";

describe("coding schema defaults", () => {
  it("the shared default slug list is exactly the seed catalog", () => {
    expect([...CODING_SCHEMA_DEFAULT_SLUGS].sort()).toEqual(DEFAULT_SCHEMAS.map((s) => s.slug).sort());
  });
});
