/**
 * RENDER-LEVEL proof for the `PageHeader` subtitle contract.
 *
 * DEFECT: `PageHeader` renders `subtitle` inside its own `<p>`. Two callers
 * (`CasesIndex`, `billing/page`) passed a `<p>` element, producing
 *
 *     <p><p class="cc-subtitle">…</p></p>
 *
 * which is invalid HTML. React logs `validateDOMNesting(...): <p> cannot be a
 * descendant of <p>` and warns that it "will cause a hydration error"; the
 * HTML parser resolves it by SPLITTING the outer paragraph, so the server and
 * client trees genuinely differ.
 *
 * These tests render the REAL component path (the real `PageShell` +
 * `PageHeader`, and the real `CasesIndex` subtitle node) under a
 * console.error spy and assert the three required outcomes:
 *
 *     NestedParagraphs         = 0
 *     HydrationWarningsOnCases = 0
 *     SubtitleTextPreserved    = true
 */

import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";

import { PageShell, PageHeader } from "../../components/ui/PageShell";

// ---------------------------------------------------------------------------
// console.error capture — React reports DOM-nesting violations through it.
// ---------------------------------------------------------------------------

let errors: string[] = [];
let spy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  errors = [];
  spy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    errors.push(args.map((a) => String(a)).join(" "));
  });
});

afterEach(() => {
  spy.mockRestore();
});

const nestingErrors = () =>
  errors.filter((e) =>
    /validateDOMNesting|cannot be a descendant|cannot contain a nested|hydration/i.test(e),
  );

// ---------------------------------------------------------------------------
// The exact subtitle nodes the two real call sites pass.
// ---------------------------------------------------------------------------

const CASES_SUBTITLE = (
  <span className="cc-subtitle" data-cases-subtitle>
    Group related evidence into simple workspaces for incidents, claims,
    projects, or reviews.
  </span>
);

const BILLING_SUBTITLE = (
  <span className="cc-subtitle" data-billing-subtitle>
    Review storage, members, subscriptions, add-ons, and payment history in one
    place.
  </span>
);

describe("PageHeader subtitle contract — no invalid paragraph nesting", () => {
  it("renders the /cases subtitle with zero nested <p> and zero nesting warnings", () => {
    const { container } = render(
      <PageShell
        header={<PageHeader title="Cases" subtitle={CASES_SUBTITLE} />}
      >
        <div />
      </PageShell>,
    );

    // NestedParagraphs = 0
    expect(container.querySelectorAll("p p").length).toBe(0);
    // HydrationWarningsOnCases = 0
    expect(nestingErrors()).toEqual([]);
    // SubtitleTextPreserved = true
    expect(
      screen.getByText(/Group related evidence into simple workspaces/i),
    ).toBeTruthy();

    // The subtitle still lives INSIDE the header's paragraph (we fixed the
    // nesting, we did not move the node out of the contract).
    const subtitle = container.querySelector("[data-cases-subtitle]");
    expect(subtitle).toBeTruthy();
    expect(subtitle!.tagName).toBe("SPAN");
    expect(subtitle!.closest("p")).toBeTruthy();
  });

  it("renders the /billing subtitle with zero nested <p> and zero nesting warnings", () => {
    const { container } = render(
      <PageShell
        header={<PageHeader title="Billing" subtitle={BILLING_SUBTITLE} />}
      >
        <div />
      </PageShell>,
    );

    expect(container.querySelectorAll("p p").length).toBe(0);
    expect(nestingErrors()).toEqual([]);
    expect(screen.getByText(/Review storage, members, subscriptions/i)).toBeTruthy();
    expect(container.querySelector("[data-billing-subtitle]")!.tagName).toBe("SPAN");
  });

  it("plain-string and fragment subtitles also stay valid", () => {
    const { container } = render(
      <PageShell header={<PageHeader title="T" subtitle="A plain string." />}>
        <div />
      </PageShell>,
    );
    expect(container.querySelectorAll("p p").length).toBe(0);
    expect(nestingErrors()).toEqual([]);
  });

  it("GUARD: the harness genuinely detects the defect it is protecting against", () => {
    // Feeding PageHeader the OLD block-element subtitle must reproduce both
    // the nested <p> and React's nesting error. Without this, the three tests
    // above could pass for the wrong reason (e.g. a silenced console).
    const { container } = render(
      <PageShell
        header={
          <PageHeader
            title="Cases"
            subtitle={<p className="cc-subtitle">Regression probe.</p>}
          />
        }
      >
        <div />
      </PageShell>,
    );
    expect(container.querySelectorAll("p p").length).toBeGreaterThan(0);
    expect(nestingErrors().length).toBeGreaterThan(0);
  });
});
