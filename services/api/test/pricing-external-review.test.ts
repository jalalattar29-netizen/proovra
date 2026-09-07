/**
 * PRICING — EXTERNAL REVIEW (2026-09-07).
 *
 * External Review became a plan capability
 * (`PlanCapabilities.externalReviewIncluded`: PRO and above, enforced by
 * `workspaceIncludesExternalReview`) while Pricing said nothing about it at
 * all. The page now states it where every comparable capability is stated,
 * and in exactly one place.
 *
 * These assert PRESENTATION ONLY. Pricing reports the server's decision; if
 * it ever resolved one, it would be a second entitlement authority.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const repo = path.resolve(__dirname, "../../..");
const read = (rel: string) => readFileSync(path.resolve(repo, rel), "utf8");

// Comments are stripped before a pin, so a match proves rendered copy and
// never a mention in a note.
function codeOnly(src: string): string {
  return src
    .split("\n")
    .filter((l) => {
      const t = l.trim();
      return !(t.startsWith("//") || t.startsWith("*") || t.startsWith("/*"));
    })
    .join("\n");
}

describe("pricing — External Review is stated once, and correctly", () => {
  const page = read("apps/web/app/pricing/page.tsx");

  it("the comparison matrix carries the row, in plan order", () => {
    const at = page.indexOf('label: "External review"');
    expect(at, "the capability must appear in the comparison matrix").toBeGreaterThan(-1);
    const row = page.slice(at, at + 260);
    const values = row
      .slice(row.indexOf("values: ["))
      .split("]")[0]
      .match(/"[^"]+"/g);
    expect(values).toEqual([
      '"Not included"',
      '"Not included"',
      '"Included"',
      '"Included"',
      '"Included"',
    ]);
  });

  it("it is stated in exactly ONE place on the page", () => {
    // A capability described twice is a capability that can disagree with
    // itself. The plan cards deliberately do not repeat it.
    const mentions = codeOnly(page).match(/External review/gi) ?? [];
    expect(mentions).toHaveLength(1);
  });

  it("no reviewer count, grant allowance or seat claim is invented", () => {
    const at = page.indexOf('label: "External review"');
    const row = page.slice(at, at + 260);
    expect(row).not.toMatch(/unlimited/i);
    expect(row).not.toMatch(/reviewers?\b/i);
    expect(row).not.toMatch(/seats?\b/i);
    expect(row).not.toMatch(/\d/);
  });

  it("the page reports the server's decision and does not make one", () => {
    // Pricing must not become a second entitlement authority: no plan-name
    // branch and no entitlement resolution on this surface.
    const code = codeOnly(page);
    expect(code).not.toContain("externalReviewIncluded");
    expect(code).not.toContain("FEATURE_EXTERNAL_PORTAL");
    expect(code).not.toContain("workspaceIncludesExternalReview");
  });
});
