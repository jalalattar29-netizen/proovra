/**
 * THE RUNBOOK RENDERER RENDERS THE PROCEDURE, NOT AN APPROXIMATION OF IT.
 *
 * A runbook is the text an incident's slug points at. If the renderer loses a
 * command, flattens a table, or drops a section, the operator reads a
 * DIFFERENT procedure from the one in the repository and has no way to know.
 * Nothing in a typecheck or a build catches that, and it is not the kind of
 * defect a screenshot of one runbook reveals about the other thirty-two.
 *
 * Phase 7 measured the whole corpus against its markdown source and found
 * three classes of loss. Each one is pinned here by the smallest input that
 * reproduces it, so the fix cannot be undone by a later edit that looks
 * harmless.
 *
 * The live sweep is `scripts/admin-ledger/visual/runbooks.mjs`, which walks
 * all 33 runbooks in the browser in both text directions. This file is the
 * unit-level floor under it.
 */

import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";

import { renderRunbookMarkdown } from "../../lib/runbooks/render";

function renderMd(md: string) {
  return render(<div data-testid="doc">{renderRunbookMarkdown(md)}</div>);
}

describe("runbook renderer — an indented fence is still a fence", () => {
  /**
   * The fence test was `line.startsWith("```")`, so a fence indented under a
   * numbered step — which is how a runbook writes the command for step 2 —
   * was not a fence at all. Ten blocks on five runbooks fell through to the
   * paragraph branch and rendered as one run-on sentence with the backticks
   * printed literally and every newline collapsed to a space.
   */
  const INDENTED = [
    "## First action",
    "",
    "1. Scale the worker to 0.",
    "2. Identify the first broken row:",
    "",
    "   ```sql",
    '   SELECT id FROM "AdminAuditLog"',
    "   ORDER BY id ASC",
    "   LIMIT 1;",
    "   ```",
    "",
    "   Then re-walk the chain.",
    "",
  ].join("\n");

  it("renders the command as a code block, not as prose", () => {
    const { container } = renderMd(INDENTED);
    const pres = container.querySelectorAll("pre");
    expect(pres.length).toBe(1);
    expect(pres[0].textContent).toContain('SELECT id FROM "AdminAuditLog"');
    expect(pres[0].textContent).toContain("LIMIT 1;");
  });

  it("does not leak the fence markers into the text", () => {
    const { container } = renderMd(INDENTED);
    // The whole document, minus the code block, must not mention a fence.
    const pre = container.querySelector("pre");
    pre?.remove();
    expect(container.textContent).not.toContain("```");
    expect(container.textContent).not.toContain("``sql");
  });

  it("dedents the body so the command keeps its own shape", () => {
    const { container } = renderMd(INDENTED);
    const text = container.querySelector("pre")?.textContent ?? "";
    // The list's three-space indent is gone; the SQL's own indentation is not
    // re-introduced, so the first line starts at column 0.
    expect(text.split("\n")[0]).toBe('SELECT id FROM "AdminAuditLog"');
  });

  it("still keeps the numbered steps around it", () => {
    renderMd(INDENTED);
    expect(screen.getByText(/Scale the worker to 0/)).toBeTruthy();
    expect(screen.getByText(/Identify the first broken row/)).toBeTruthy();
    expect(screen.getByText(/Then re-walk the chain/)).toBeTruthy();
  });
});

describe("runbook renderer — a table is a table", () => {
  const WITH_HEADER = [
    "| outcome | reason |",
    "| --- | --- |",
    "| `BLOCKED_BY_HOLD` | `active_legal_hold` |",
    "| `ALLOWED` | `ok` |",
  ].join("\n");

  it("renders a header row and one row per source row", () => {
    const { container } = renderMd(WITH_HEADER);
    expect(container.querySelectorAll("table").length).toBe(1);
    expect(container.querySelectorAll("thead th").length).toBe(2);
    expect(container.querySelectorAll("tbody tr").length).toBe(2);
  });

  /**
   * A table with NO blank line above it. The paragraph branch reached the
   * header row first and swallowed the whole table into one sentence — which
   * is what /admin/platform/runbooks/export-blocked rendered: a nine-row
   * outcome/reason table as a wall of pipes.
   */
  it("survives having prose immediately above it", () => {
    const { container } = renderMd(
      ["The response carries `outcome` and `reason`:", WITH_HEADER].join("\n"),
    );
    expect(container.querySelectorAll("table").length).toBe(1);
    expect(container.querySelectorAll("tbody tr").length).toBe(2);
  });

  /**
   * Four reviewer runbooks write an escalation path as pipe rows with no
   * header and no divider. That is not valid GFM, and the renderer's answer
   * was to let it fall through — so `## Escalation path` was followed
   * immediately by the next heading and the three rows naming who to wake up
   * were not on the page at all.
   */
  it("renders a headerless run of pipe rows, with no empty header band", () => {
    const { container } = renderMd(
      [
        "## Escalation path",
        "",
        "| 0-1 hour | Reviewer Ops on-call reassigns. |",
        "| 1-4 hours | Workspace admin assesses the account. |",
        "| 4+ hours | Operations lead reviews headcount. |",
      ].join("\n"),
    );
    expect(container.querySelectorAll("table").length).toBe(1);
    expect(container.querySelectorAll("thead").length).toBe(0);
    expect(container.querySelectorAll("tbody tr").length).toBe(3);
    expect(container.textContent).toContain("Reviewer Ops on-call reassigns.");
    expect(container.textContent).toContain("Operations lead reviews headcount.");
  });

  /**
   * The case the original comment was protecting, which must keep working: a
   * SINGLE stray pipe line is prose, not a one-row table.
   */
  it("leaves a single stray pipe line as prose", () => {
    const { container } = renderMd("Set the flag | and restart the worker.");
    expect(container.querySelectorAll("table").length).toBe(0);
    expect(container.textContent).toContain("Set the flag | and restart the worker.");
  });
});

describe("runbook renderer — nothing is silently dropped", () => {
  /**
   * The renderer's own contract: an unrecognised construct falls through as
   * literal text rather than disappearing. A step that vanishes is worse than
   * one that renders plainly, because the operator cannot tell it is missing.
   */
  it("keeps every non-blank source line's words somewhere on the page", () => {
    const md = [
      "# Runbook — Title",
      "",
      "## Section",
      "",
      "Prose line.",
      "",
      "- bullet one",
      "  continued on the next line",
      "",
      "1. step one",
      "",
      "   ```bash",
      "   echo hello",
      "   ```",
      "",
      "> a warning",
      "",
      "| a | b |",
      "| c | d |",
      "",
      "---",
      "",
      "Closing line.",
    ].join("\n");
    const { container } = renderMd(md);
    const text = (container.textContent ?? "").replace(/\s+/g, " ");
    for (const fragment of [
      "Section",
      "Prose line.",
      "bullet one",
      "continued on the next line",
      "step one",
      "echo hello",
      "a warning",
      "Closing line.",
    ]) {
      expect(text).toContain(fragment);
    }
  });
});
