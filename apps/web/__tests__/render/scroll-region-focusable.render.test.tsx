/**
 * AUD-0061 (4) — horizontally scrolling tables and rails are reachable from
 * the keyboard.
 *
 * axe `scrollable-region-focusable` (WCAG 2.1.1) fired at phone width on 26
 * routes: the legal tables, the pricing comparison, the platform DataTables
 * and several marketing rails. Every such wrapper now spreads the ONE shared
 * `scrollRegionProps(label)` — `role="region"`, `tabIndex=0`, an
 * `aria-label` and the `data-scroll-region` hook the shared focus ring keys
 * on. The legal renderer and the shared helper are rendered; the page-local
 * wrappers are pinned at source, every `overflow-x-auto` box in each file.
 */
import React from "react";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { render, screen, within } from "@testing-library/react";

import { renderLegalMarkdown } from "../../app/legal/legal-content";
import { scrollRegionProps } from "../../lib/ui/scrollRegion";

const WEB = path.resolve(__dirname, "../..");
const read = (rel: string) => fs.readFileSync(path.join(WEB, rel), "utf8");

const LEGAL_MD = `# Data Retention Policy

Intro paragraph.

## Retention periods

| Record | Retention | Basis |
| --- | --- | --- |
| Evidence | 7 years | Contract |
| Logs | 90 days | Legitimate interest |
`;

describe("scrollRegionProps", () => {
  it("is a named, focusable region with the shared focus hook", () => {
    expect(scrollRegionProps("Billing history")).toEqual({
      role: "region",
      tabIndex: 0,
      "aria-label": "Billing history",
      "data-scroll-region": "",
    });
  });
});

describe("legal markdown tables", () => {
  it("wrap each table in a focusable region named after its section", () => {
    render(<article>{renderLegalMarkdown(LEGAL_MD)}</article>);
    const region = screen.getByRole("region", { name: "Retention periods (table)" });
    expect(region.className).toContain("legal-table-wrapper");
    expect(region.getAttribute("tabindex")).toBe("0");
    expect(region.hasAttribute("data-scroll-region")).toBe(true);
    expect(within(region).getByRole("table")).toBeTruthy();
  });

  it("fall back to the column headings when no heading precedes the table", () => {
    render(
      <article>
        {renderLegalMarkdown("| **Name** | Purpose |\n| --- | --- |\n| Stripe | Payments |\n")}
      </article>,
    );
    expect(
      screen.getByRole("region", { name: "Table: Name, Purpose" }).getAttribute("tabindex"),
    ).toBe("0");
  });
});

describe("the shared focus ring covers every scroll region", () => {
  it("globals.css gives [data-scroll-region] the canonical ring, drawn inside the box", () => {
    const css = read("app/globals.css");
    expect(css).toMatch(/\[role="listbox"\]:focus-visible,\s*\n\s*\[data-scroll-region\]:focus-visible \{/);
    expect(css).toMatch(/\[data-scroll-region\]:focus-visible \{\s*outline-offset: -2px;\s*\}/);
  });
});

/** Every opening tag in `src` whose className mentions `marker`. */
function openingTagsWith(src: string, marker: RegExp): string[] {
  const tags: string[] = [];
  const re = /<(div|section)\b[^>]*>/g;
  for (let m = re.exec(src); m; m = re.exec(src)) {
    if (marker.test(m[0])) tags.push(m[0]);
  }
  return tags;
}

describe("page-local scroll wrappers use the shared helper", () => {
  const MARKETING: ReadonlyArray<[file: string, count: number]> = [
    ["app/pricing/page.tsx", 1], // TableBlock, rendered twice (capacity + operations)
    ["app/platform/page.tsx", 1],
    ["app/support/page.tsx", 1],
    ["app/technology/page.tsx", 2],
    ["app/why-proovra/page.tsx", 1],
    ["components/marketing/EvidenceLifecycle.tsx", 1],
  ];
  it.each(MARKETING)("%s: every overflow-x-auto box is a named scroll region", (file, count) => {
    const tags = openingTagsWith(read(file), /overflow-x-auto/);
    expect(tags).toHaveLength(count);
    for (const tag of tags) expect(tag, tag).toMatch(/\{\.\.\.scrollRegionProps\(/);
  });

  it("pricing names both comparison tables", () => {
    const src = read("app/pricing/page.tsx");
    expect(src).toContain('<TableBlock rows={capacityRows} label="Plans and capacity comparison" />');
    expect(src).toContain(
      '<TableBlock rows={operationsRows} label="Operations and governance comparison" />',
    );
  });

  const APP: ReadonlyArray<[file: string, marker: RegExp]> = [
    ["app/(app)/trust-center/subprocessors/page.tsx", /legal-table-wrapper/],
    ["components/ai-copilot/AiCapabilityStatusTable.tsx", /legal-scroll/],
    ["app/(app)/operations/health/page.tsx", /app-table-surface--scroll/],
    ["app/(app)/billing/_sections/StorageAndHistory.tsx", /app-table-surface--scroll/],
    ["app/(app)/intake-links/_components/RecordsSurface.tsx", /app-table-surface--scroll/],
    ["components/search/SearchAuditLogPanel.tsx", /app-table-surface--scroll/],
  ];
  it.each(APP)("%s: the scroll wrapper is a named scroll region", (file, marker) => {
    const tags = openingTagsWith(read(file), marker);
    expect(tags.length).toBeGreaterThan(0);
    for (const tag of tags) expect(tag, tag).toMatch(/\{\.\.\.scrollRegionProps\(/);
  });
});
