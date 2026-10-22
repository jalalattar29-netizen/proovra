/**
 * HERO V2 — THE HOMEPAGE'S ONE HERO, PINNED BY BEHAVIOUR.
 *
 * Hero V2 replaced `HeroSection` (and its `HeroTower3D`), which were deleted.
 * This holds what the approved hero promises a visitor, from the rendered DOM
 * rather than from its geometry:
 *
 *   * the homepage renders Hero V2, and nothing references the deleted hero;
 *   * the production copy and both CTAs, with their destinations;
 *   * all six industry cards, Corporate Security → the Government solution;
 *   * the record's per-signal status reads "Integrity verified" — never a bare
 *     overall "Verified" verdict — and the collaboration card says Workspace;
 *   * the illustrated product (stage + stacked fallback) is decorative: hidden
 *     from assistive technology and carrying nothing focusable;
 *   * every image the hero asks for exists under `public/`.
 */

import React from "react";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, it, expect } from "vitest";
import { render, within } from "@testing-library/react";

import { HeroV2 } from "../../components/marketing/hero-v2/HeroV2";

const WEB_ROOT = resolve(__dirname, "../..");

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === ".next" || entry.startsWith(".next")) continue;
    const abs = join(dir, entry);
    if (statSync(abs).isDirectory()) sourceFiles(abs, out);
    else if (/\.(ts|tsx|mjs|js)$/.test(entry)) out.push(abs);
  }
  return out;
}

function hero() {
  const view = render(<HeroV2 />);
  return within(view.container.querySelector("section") as HTMLElement);
}

describe("Hero V2 — the homepage hero", () => {
  it("is the hero the homepage renders, and the deleted hero is referenced nowhere", () => {
    const page = readFileSync(join(WEB_ROOT, "app/page.tsx"), "utf8");
    expect(page).toMatch(/import \{ HeroV2 \} from "\.\.\/components\/marketing\/hero-v2\/HeroV2"/);
    expect(page).toMatch(/<HeroV2 \/>/);

    expect(existsSync(join(WEB_ROOT, "components/marketing/HeroSection.tsx"))).toBe(false);
    expect(existsSync(join(WEB_ROOT, "components/marketing/HeroTower3D.tsx"))).toBe(false);
    // Imports of the deleted modules. (contact-sales and request-demo each
    // define an unrelated page-local `HeroSection` function; that is fine.)
    const stale = sourceFiles(WEB_ROOT).filter((f) =>
      /from\s+["'][^"']*marketing\/(HeroSection|HeroTower3D)["']|from\s+["']\.\/(HeroSection|HeroTower3D)["']/.test(
        readFileSync(f, "utf8"),
      ),
    );
    expect(stale).toEqual([]);
  });

  it("carries the production copy and its two CTAs", () => {
    const h = hero();
    const heading = h.getByRole("heading", { level: 1 });
    expect(heading.textContent).toContain("Evidence integrity.");
    expect(heading.textContent).toContain("Verifiable facts.");
    expect(heading.textContent).toContain("Operational trust.");
    expect(heading.textContent).toContain("Digital evidence infrastructure for high-trust operations.");

    const report = h.getByRole("link", { name: /View sample report/ });
    expect(report.getAttribute("href")).toBe("/brand/sample-report.pdf");
    expect(report.getAttribute("target")).toBe("_blank");
    expect(report.getAttribute("rel")).toContain("noopener");

    expect(h.getByRole("link", { name: "Request a demo" }).getAttribute("href")).toBe("/request-demo");
  });

  it("links all six industry cards to their solution pages", () => {
    const list = hero().getByRole("list", { name: "Industries" });
    const links = within(list).getAllByRole("link");
    const byTitle = Object.fromEntries(
      links.map((a) => [a.querySelector("span span span")?.textContent ?? "", a.getAttribute("href")]),
    );
    expect(byTitle).toEqual({
      "Insurance Claims": "/for-insurance",
      "Legal Matters": "/for-lawyers",
      Investigations: "/for-investigations",
      "Compliance & Audits": "/for-compliance",
      "Media & Journalism": "/for-journalism",
      "Corporate Security": "/for-government",
    });
  });

  it("states the record's integrity signal and uses Workspace vocabulary", () => {
    const { container } = render(<HeroV2 />);
    const text = container.textContent ?? "";
    expect(text).toContain("Integrity verified");
    expect(text).toContain("Workspace Collaboration");
    expect(text).not.toMatch(/Team Collaboration/);
    // No bare overall verdict: every status pill is the per-signal wording.
    const pills = [...container.querySelectorAll("span")].filter((s) => /^\s*Verified\s*$/.test(s.textContent ?? ""));
    expect(pills).toEqual([]);
  });

  it("keeps the illustrated product decorative and out of the focus order", () => {
    const { container } = render(<HeroV2 />);
    const hidden = [...container.querySelectorAll('[aria-hidden="true"]')];
    // The backdrop, the desktop stage and the stacked fallback.
    expect(hidden.length).toBeGreaterThanOrEqual(3);
    for (const layer of hidden) {
      expect(layer.querySelectorAll("a, button, input, select, textarea, [tabindex]").length).toBe(0);
    }
  });

  it("asks only for images that exist in public/", () => {
    const { container } = render(<HeroV2 />);
    const requested = new Set<string>();
    for (const img of container.querySelectorAll("img")) {
      const src = img.getAttribute("src") ?? "";
      const url = src.startsWith("/_next/image") ? new URL(src, "http://x").searchParams.get("url") : src;
      if (url) requested.add(decodeURIComponent(url));
    }
    expect(requested.size).toBeGreaterThan(0);
    const missing = [...requested].filter((u) => !existsSync(join(WEB_ROOT, "public", u)));
    expect(missing).toEqual([]);
  });
});
