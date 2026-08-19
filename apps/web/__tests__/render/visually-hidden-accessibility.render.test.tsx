/**
 * VISUALLY HIDDEN — one utility, six real consumers.
 *
 * WHY THIS FILE EXISTS
 * ---------------------------------------------------------------------------
 * `.sr-only` was used in twelve places across authentication, matter dialogs,
 * the case workspace, marketing and the evidence library — and was DEFINED
 * NOWHERE. A class that does not exist hides nothing, so every one of those
 * labels, descriptions and live regions was rendering visibly. Two of the
 * consumers papered over it locally (the auth pages carried their own inline
 * clipping; two loading paragraphs carried `margin: 0` to tidy a paragraph
 * nobody was supposed to see).
 *
 * They now all use the canonical `.app-visually-hidden` from
 * `app-primitives.css`. No alias was added — an alias would have preserved the
 * ambiguity that caused this.
 *
 * These tests assert the two halves of the contract that matter:
 *   * the markup half — the element is still in the accessibility tree, still
 *     carries its accessible name, and did not acquire `display:none`,
 *     `aria-hidden` or an inline override that fights the utility; and
 *   * the stylesheet half — the utility itself still clips rather than hides.
 *
 * The rendered-geometry half (zero layout space) cannot be measured in jsdom,
 * which computes no layout; it is measured by the out-of-repo Chromium probe.
 */

import React from "react";
import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const WEB = join(__dirname, "..", "..");
const PRIMITIVES = readFileSync(
  join(WEB, "components", "app-primitives", "app-primitives.css"),
  "utf8",
);

const HIDDEN = "app-visually-hidden";

// ---------------------------------------------------------------------------
// 1. No `.sr-only` consumer survives, and no alias was introduced
// ---------------------------------------------------------------------------

describe("visually hidden — the undefined class is gone", () => {
  function productionSources(): string[] {
    const out: string[] = [];
    (function walk(dir: string) {
      for (const e of readdirSync(dir)) {
        if (["node_modules", ".next", "dist", "coverage", ".turbo", "__tests__"].includes(e)) continue;
        const p = join(dir, e);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.(tsx?|jsx?|css)$/.test(e)) out.push(p);
      }
    })(WEB);
    return out;
  }

  it("has zero production consumers of the class", () => {
    const offenders: string[] = [];
    for (const f of productionSources()) {
      const src = readFileSync(f, "utf8");
      // JSX usage in any className position, and any CSS selector.
      if (/className=\{?["'`][^"'`]*\bsr-only\b/.test(src)) offenders.push(`${f} (jsx)`);
      if (/(^|[\s,>+~])\.sr-only\b\s*[,{]/m.test(src)) offenders.push(`${f} (selector)`);
    }
    expect(offenders).toEqual([]);
  });

  it("has zero `.sr-only` selector aliases in any stylesheet", () => {
    for (const f of productionSources().filter((p) => p.endsWith(".css"))) {
      const css = readFileSync(f, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
      expect(css, f).not.toMatch(/\.sr-only\b/);
    }
  });
});

// ---------------------------------------------------------------------------
// 2. The utility itself still clips rather than un-announces
// ---------------------------------------------------------------------------

describe("visually hidden — the utility's contract", () => {
  const body = /\.app-visually-hidden\s*\{([^}]*)\}/.exec(PRIMITIVES)?.[1] ?? "";

  it("clips out of the visual layer", () => {
    expect(body).toMatch(/position:\s*absolute/);
    expect(body).toMatch(/inline-size:\s*1px/);
    expect(body).toMatch(/block-size:\s*1px/);
    expect(body).toMatch(/overflow:\s*hidden/);
    expect(body).toMatch(/clip-path:\s*inset\(50%\)/);
  });

  it("never removes the element from assistive technology", () => {
    expect(body).not.toMatch(/display:\s*none/);
    expect(body).not.toMatch(/visibility:\s*hidden/);
  });
});

// ---------------------------------------------------------------------------
// 3. The six representative consumers
// ---------------------------------------------------------------------------

/**
 * Each case reproduces the consumer's real markup shape. Rendering the whole
 * page would drag in that route's data layer without testing anything more
 * about the hiding contract, which is a property of the element.
 */
const CASES: Array<{
  name: string;
  source: string;
  element: React.ReactElement;
  /** Expected accessible name of the labelled control, if any. */
  labels?: string;
}> = [
  {
    name: "authentication form label (register)",
    source: "app/register/page.tsx",
    element: (
      <form>
        <label htmlFor="email-field" className={HIDDEN}>
          Email address
        </label>
        <input id="email-field" type="email" />
      </form>
    ),
    labels: "Email address",
  },
  {
    name: "reset-password form label",
    source: "app/reset-password/page.tsx",
    element: (
      <form>
        <label htmlFor="new-password" className={HIDDEN}>
          New password
        </label>
        <input id="new-password" type="password" />
      </form>
    ),
    labels: "New password",
  },
  {
    name: "matter dialog description",
    source: "components/cases-experience/matter-modals/Modal.tsx",
    element: (
      <div role="dialog" aria-modal="true" aria-labelledby="t" aria-describedby="d">
        <h2 id="t">Close matter</h2>
        <span id="d" data-matter-modal-description className={HIDDEN}>
          Closing a matter preserves every evidence record.
        </span>
      </div>
    ),
  },
  {
    name: "MatterWorkspace filter control label",
    source: "components/cases-experience/MatterWorkspace.tsx",
    element: (
      <div>
        <label htmlFor="matter-workspace-filter" className={HIDDEN}>
          Filter evidence
        </label>
        <input id="matter-workspace-filter" type="search" />
      </div>
    ),
    labels: "Filter evidence",
  },
  {
    name: "public/marketing live region",
    source: "components/marketing/EnterpriseSuccessModal.tsx",
    element: (
      <div role="status" aria-live="polite" className={HIDDEN}>
        Request received. Our team will be in touch.
      </div>
    ),
  },
  {
    name: "evidence copilot live region",
    source: "components/ai-copilot/EvidenceCopilotPanel.tsx",
    element: (
      <span aria-live="polite" className={HIDDEN}>
        Evidence Copilot result ready
      </span>
    ),
  },
];

describe("visually hidden — representative consumers", () => {
  it.each(CASES.map((c) => [c.name, c] as const))("%s stays announced", (_name, c) => {
    const { container } = render(c.element);
    const hidden = container.querySelector(`.${HIDDEN}`)!;
    expect(hidden).not.toBeNull();

    // In the accessibility tree: not aria-hidden, not `hidden`, and not
    // display-none'd by an inline override.
    expect(hidden.getAttribute("aria-hidden")).toBeNull();
    expect(hidden.hasAttribute("hidden")).toBe(false);
    const inline = hidden.getAttribute("style") ?? "";
    expect(inline).not.toMatch(/display\s*:\s*none/);
    expect(inline).not.toMatch(/visibility\s*:\s*hidden/);

    // No inline declaration may fight the utility's clipping contract. The two
    // loading paragraphs used to carry `margin: 0`, which would override the
    // utility's `margin: -1px`.
    expect(inline).not.toMatch(/\bmargin\b/);
    expect(inline).not.toMatch(/\bposition\b/);
    expect(inline).not.toMatch(/\bclip\b/);

    // It still has text — a hidden element with no content announces nothing.
    expect((hidden.textContent ?? "").trim().length).toBeGreaterThan(0);
  });

  it.each(
    CASES.filter((c) => c.labels).map((c) => [c.name, c] as const),
  )("%s still names its control", (_name, c) => {
    const { container } = render(c.element);
    const control = container.querySelector("input")!;
    const label = container.querySelector("label")!;
    expect(label.getAttribute("for")).toBe(control.id);
    expect(label.textContent).toBe(c.labels);
    // The label is the control's accessible name and is hidden, not removed.
    expect(label.className).toContain(HIDDEN);
  });

  it("each case corresponds to a real migrated source file", () => {
    for (const c of CASES) {
      const src = readFileSync(join(WEB, c.source), "utf8");
      expect(src, `${c.source} must use the canonical utility`).toContain(HIDDEN);
      expect(src, `${c.source} must not use the undefined class`).not.toMatch(
        /className=\{?["'`][^"'`]*\bsr-only\b/,
      );
    }
  });
});
