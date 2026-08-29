/**
 * PAGE HEADING STRUCTURE — one <h1> per page, and never one inside another.
 *
 * WHAT THIS EXISTS TO STOP HAPPENING AGAIN
 * ---------------------------------------------------------------------------
 * `PageHeader` renders its own `<h1>` around whatever `title` it is given — its
 * own contract says so. Billing and Cases each passed an `<h1>` into it, so the
 * rendered document contained:
 *
 *     <h1><h1 class="cc-title" data-billing-title>Billing</h1></h1>
 *
 * which is invalid HTML, logged a React `validateDOMNesting` error on every
 * load ("In HTML, <h1> cannot be a child of <h1>" / "<h1> cannot contain a
 * nested h1"), and gave the page two level-1 headings for anyone navigating by
 * heading.
 *
 * These assert the RENDERED DOM, not the source. A source scan cannot tell the
 * difference between a heading that is nested and one that merely appears near
 * a heading in the file — and it was a source scan pinning the literal
 * `<h1 className="cc-title" …>` that kept the defect in place through two
 * reviews.
 */

import React from "react";
import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";

import { PageHeader, PageShell, PageSection } from "../../components/ui/PageShell";

/** Every heading in the tree that has a heading ancestor. */
function nestedHeadings(root: HTMLElement): string[] {
  const out: string[] = [];
  for (const h of Array.from(root.querySelectorAll("h1,h2,h3,h4,h5,h6"))) {
    const ancestor = h.parentElement?.closest("h1,h2,h3,h4,h5,h6");
    if (ancestor) out.push(`${ancestor.tagName} > ${h.tagName}`);
  }
  return out;
}

// ===========================================================================
// 1. The shell owns the one <h1>
// ===========================================================================

describe("PageHeader", () => {
  it("renders exactly one <h1>, and the title inside it", () => {
    const { container } = render(<PageHeader title="Billing" />);
    const h1s = container.querySelectorAll("h1");
    expect(h1s).toHaveLength(1);
    expect(h1s[0]!.textContent).toBe("Billing");
  });

  it("keeps ONE <h1> when the title is a composed inline row", () => {
    // The sanctioned way to put an icon beside a title: phrasing content, no
    // second heading to hang the styling on.
    const { container } = render(
      <PageHeader
        title={
          <span className="app-title-row">
            <span aria-hidden className="app-title-icon" />
            <span className="cc-title" data-billing-title>
              Billing
            </span>
          </span>
        }
      />,
    );

    expect(container.querySelectorAll("h1")).toHaveLength(1);
    expect(nestedHeadings(container)).toEqual([]);
    // The probe attribute survives, and is NOT a heading.
    const probe = container.querySelector("[data-billing-title]")!;
    expect(probe).not.toBeNull();
    expect(probe.tagName).toBe("SPAN");
    // It is inside the canonical heading, so the heading still names the page.
    expect(probe.closest("h1")).not.toBeNull();
    expect(container.querySelector("h1")!.textContent).toContain("Billing");
  });

  it("would produce the defect if a heading were passed — which is why it must not be", () => {
    /*
     * The regression itself, rendered deliberately so the assertion above is
     * known to be capable of failing. Without this, "no nested headings" could
     * pass because the helper never finds anything.
     */
    const { container } = render(
      <PageHeader title={<h1 className="cc-title">Billing</h1>} />,
    );
    expect(container.querySelectorAll("h1")).toHaveLength(2);
    expect(nestedHeadings(container)).toEqual(["H1 > H1"]);
  });
});

// ===========================================================================
// 2. A whole page composes to a valid hierarchy
// ===========================================================================

describe("a page composed the canonical way", () => {
  const page = (title: React.ReactNode) => (
    <PageShell
      header={<PageHeader title={title} subtitle="Your plan, what you have used." />}
    >
      <PageSection title="Billing history">
        <p>rows</p>
      </PageSection>
    </PageShell>
  );

  it("has exactly one <h1>, and its sections sit beneath it as <h2>", () => {
    const { container } = render(
      page(
        <span className="cc-title" data-billing-title>
          Billing
        </span>,
      ),
    );

    const h1s = container.querySelectorAll("h1");
    expect(h1s).toHaveLength(1);
    expect(h1s[0]!.textContent).toContain("Billing");

    // A logical hierarchy beneath it: the section heading is one level down.
    const h2s = container.querySelectorAll("h2");
    expect(h2s).toHaveLength(1);
    expect(h2s[0]!.textContent).toBe("Billing history");
    // ...and it is a SIBLING of the h1's subtree, never inside it.
    expect(h2s[0]!.closest("h1")).toBeNull();

    expect(nestedHeadings(container)).toEqual([]);
  });

  it("nests no heading inside any other heading", () => {
    const { container } = render(page("Billing"));
    for (const h of Array.from(container.querySelectorAll("h1,h2,h3,h4,h5,h6"))) {
      expect(h.querySelector("h1,h2,h3,h4,h5,h6")).toBeNull();
    }
  });
});

// ===========================================================================
// 3. The real consumers, as they are written today
// ===========================================================================

describe("the shipped page titles", () => {
  /*
   * The exact nodes `app/(app)/billing/page.tsx` and
   * `components/cases-experience/CasesIndex.tsx` hand to `PageHeader`. Kept in
   * step with those files by the source contracts in
   * `billing-redesign.test.ts` and `cases-personal-ux.test.ts`, which pin the
   * tag and the attribute; what THIS proves is that the resulting DOM is
   * valid, which those cannot.
   */
  const TITLES: Array<[string, React.ReactNode, string]> = [
    [
      "Billing",
      <span className="cc-title" data-billing-title key="b">
        Billing
      </span>,
      "data-billing-title",
    ],
    [
      "Cases",
      <span className="cases-page-heading app-title-row" key="c">
        <span aria-hidden className="app-title-icon" />
        <span className="cc-title" data-cases-title>
          Cases
        </span>
      </span>,
      "data-cases-title",
    ],
  ];

  for (const [name, title, probe] of TITLES) {
    it(`${name} renders one <h1> containing its title, and no nested heading`, () => {
      const { container } = render(<PageHeader title={title} />);

      expect(container.querySelectorAll("h1")).toHaveLength(1);
      expect(container.querySelector("h1")!.textContent).toContain(name);
      expect(nestedHeadings(container)).toEqual([]);

      const el = container.querySelector(`[${probe}]`)!;
      expect(el).not.toBeNull();
      expect(el.tagName).toBe("SPAN");
      expect(el.closest("h1")).not.toBeNull();
    });
  }
});
