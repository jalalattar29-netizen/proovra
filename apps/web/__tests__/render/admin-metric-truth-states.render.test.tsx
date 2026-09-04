/**
 * THE READER, RENDERED IN EVERY STATE IT CLAIMS TO SUPPORT.
 *
 * `AdminMetric` is the one component that turns a `Metric<T>` into something an
 * operator reads, so its whole job is keeping seven different situations
 * visually distinct. Four of them can be produced on a live page and were
 * checked in a browser; the others cannot be forced from the outside today —
 * STALE in particular has no producer in the codebase yet — and an unexercised
 * branch in this component is exactly where a fabricated zero would reappear.
 *
 * The point of every assertion below is the same: a number is shown ONLY when
 * a number was measured, and every other state says so in words.
 */

import React from "react";
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";

import { AdminStat } from "../../components/admin/AdminMetric";

afterEach(cleanup);

describe("AdminMetric renders each truth state distinguishably", () => {
  it("shows a measured zero as a plain 0 — the one zero allowed to look like one", () => {
    const { container } = render(
      <AdminStat label="Open incidents" metric={{ state: "VALUE", value: 0 }} />,
    );
    expect(screen.getByText("0")).toBeTruthy();
    expect(container.querySelector('[data-state="VALUE"]')).toBeTruthy();
    // No hedging word next to a real measurement.
    expect(container.textContent).not.toMatch(/not measured|unavailable|stale|partial/i);
  });

  it("never prints a digit for NOT_MEASURED, UNKNOWN, ERROR or NOT_APPLICABLE", () => {
    const cases = [
      { state: "NOT_MEASURED" as const, reason: "no probe exists in this build" },
      { state: "UNKNOWN" as const, reason: "the source did not answer" },
      { state: "ERROR" as const, reason: "the read failed" },
      { state: "NOT_APPLICABLE" as const, reason: "not configured" },
    ];

    for (const c of cases) {
      cleanup();
      const { container } = render(
        <AdminStat label="Degraded services" metric={{ ...c, value: null }} />,
      );
      const text = container.textContent ?? "";
      // The defect this guards against is a zero appearing where a state should.
      expect(text, `${c.state} must not render a bare number`).not.toMatch(/\b\d+\b/);
      expect(container.querySelector(`[data-state="${c.state}"]`), c.state).toBeTruthy();
    }
  });

  it("keeps a STALE number visible and marks it stale rather than fresh", () => {
    const { container } = render(
      <AdminStat
        label="Queue backlog"
        metric={{
          state: "STALE",
          value: 42,
          reason: "the signal is older than its freshness rule",
        }}
      />,
    );
    const text = container.textContent ?? "";
    // The number is still useful — it is the all-clear that is refused.
    expect(text).toContain("42");
    expect(text.toLowerCase()).toContain("stale");
    expect(container.querySelector('[data-state="STALE"]')).toBeTruthy();
    expect(container.querySelector('[data-state="VALUE"]')).toBeNull();
  });

  it("keeps a PARTIAL number visible and marks it partial rather than total", () => {
    const { container } = render(
      <AdminStat
        label="Audit entries"
        metric={{
          state: "PARTIAL",
          value: 25,
          reason: "counted over the loaded window",
        }}
      />,
    );
    const text = container.textContent ?? "";
    expect(text).toContain("25");
    expect(text.toLowerCase()).toContain("partial");
    expect(container.querySelector('[data-state="PARTIAL"]')).toBeTruthy();
  });

  it("gives STALE and PARTIAL different markings from each other and from VALUE", () => {
    const seen = new Set<string>();
    for (const m of [
      { state: "VALUE" as const, value: 7 },
      { state: "STALE" as const, value: 7, reason: "old" },
      {
        state: "PARTIAL" as const,
        value: 7,
        reason: "capped",
      },
    ]) {
      cleanup();
      const { container } = render(<AdminStat label="Signal" metric={m} />);
      // Same number, three readings: if any two collapsed to the same text the
      // operator could not tell a live 7 from a stale or capped one.
      seen.add((container.textContent ?? "").replace(/\s+/g, " ").trim());
    }
    expect(seen.size).toBe(3);
  });
});
