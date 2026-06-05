/**
 * Phase B — Workflow Templates Center regression pins.
 *
 * Phase 0 audit confirmed the /workflows page was an "operational
 * workflows" surface with Summary tiles (Total / In review / Approved /
 * Blocked) and an Instances list. Those tiles were guaranteed to
 * render "0 / 0 / 0 / 0" and the list was guaranteed to be empty
 * because no producer wired EvidenceWorkflowInstance creation in this
 * workspace. Phase B reframed the surface as the Workflow Templates
 * Center, backed by EvidenceWorkflowTemplate + the in-code seed
 * catalog via /v1/workflows/templates.
 *
 * These pins forbid the misleading "execution center" surface from
 * coming back:
 *
 *   - Summary tile markup ("In review", "Blocked", "Approved" counts)
 *   - the Instances list ("No workflows match the filters.", the
 *     status select, the /v1/workflows/instances fetch)
 *
 * And they assert the honest replacement is in place:
 *
 *   - title "Workflow Templates"
 *   - sector filter ("All sectors")
 *   - admin gate copy
 *   - templates fetch + render
 */

import { describe, expect, it } from "vitest";

const PAGE_REL = "../../../apps/web/app/(app)/workflows/page.tsx";

async function readPage(): Promise<string> {
  const { readFile } = await import("node:fs/promises");
  const { fileURLToPath } = await import("node:url");
  return readFile(
    fileURLToPath(new URL(PAGE_REL, import.meta.url)),
    "utf8",
  );
}

describe("Phase B — /workflows page is a Workflow Templates Center", () => {
  it("renders the canonical Workflow Templates title", async () => {
    const src = await readPage();
    expect(src).toMatch(/Workflow Templates/);
    // The page must explicitly redirect operators to Reviewer
    // Operations for execution; that copy is the contract.
    expect(src).toMatch(/Reviewer Operations/);
  });

  it("does NOT call /v1/workflows/instances", async () => {
    const src = await readPage();
    // The Instances surface was the misleading "execution center"
    // that always rendered empty. Phase B removed every reference.
    expect(src).not.toMatch(/\/v1\/workflows\/instances/);
  });

  it("fetches /v1/workflows/templates", async () => {
    const src = await readPage();
    expect(src).toMatch(/\/v1\/workflows\/templates/);
  });

  it("does NOT render the Summary tiles block", async () => {
    const src = await readPage();
    // The Phase 0 "0 / 0 / 0 / 0" tiles are gone. We check for the
    // literal labels that uniquely identified them.
    expect(src).not.toMatch(/>Summary</);
    expect(src).not.toMatch(/label="In review"/);
    expect(src).not.toMatch(/label="Blocked"/);
    // The <Stat /> mini-component that backed the tiles must also be
    // gone — its existence would suggest the tiles could come back.
    expect(src).not.toMatch(/function Stat\(/);
  });

  it("does NOT render the Instances section markup", async () => {
    const src = await readPage();
    // The section title.
    expect(src).not.toMatch(/>Instances</);
    // The empty-state copy.
    expect(src).not.toMatch(/No workflows match the filters\./);
    // The status select.
    expect(src).not.toMatch(/All statuses/);
    // The Instance type union — its presence would mean the page
    // still tries to render rows.
    expect(src).not.toMatch(/type Instance\s*=\s*\{/);
  });

  it("renders the sector filter", async () => {
    const src = await readPage();
    expect(src).toMatch(/All sectors/);
  });

  it("renders the templates list with the API-projected metadata", async () => {
    const src = await readPage();
    // The fields the /v1/workflows/templates projection actually
    // returns. We pin each one so a future refactor cannot quietly
    // drop a useful column from the admin view.
    expect(src).toMatch(/t\.slug/);
    expect(src).toMatch(/t\.version/);
    expect(src).toMatch(/t\.name/);
    expect(src).toMatch(/t\.description/);
    expect(src).toMatch(/t\.workspaceCategory/);
    expect(src).toMatch(/t\.intakeModes/);
    expect(src).toMatch(/t\.requiredStepCount/);
    expect(src).toMatch(/t\.stepCount/);
    expect(src).toMatch(/t\.source/);
  });

  it("gates the editor list behind an admin check with non-admin copy", async () => {
    const src = await readPage();
    // Same admin gate the integrations page uses (OWNER/ADMIN on org
    // spaces, single-occupant on personal spaces).
    expect(src).toMatch(/useActiveSpace/);
    expect(src).toMatch(/isAdmin/);
    // Non-admin explainer copy.
    expect(src).toMatch(
      /Workflow templates are managed by workspace administrators\./,
    );
  });

  it("renders the empty-state copy when the sector filter yields nothing", async () => {
    const src = await readPage();
    // JSX wraps the string across lines; collapse whitespace before
    // matching so an editor reflow does not silently break this pin.
    const normalised = src.replace(/\s+/g, " ");
    expect(normalised).toMatch(/No templates match this sector\./);
    expect(normalised).toMatch(/Templates are administered by platform owners/);
    expect(normalised).toMatch(
      /your workspace may not have local overrides yet\./,
    );
  });

  it("renders a non-blocking error banner instead of crashing on API failure", async () => {
    const src = await readPage();
    // The error path must NOT throw or unmount the page chrome — the
    // catch sets the error string and seeds an empty list so the
    // sector filter remains usable.
    expect(src).toMatch(/setError\(/);
    expect(src).toMatch(/setTemplates\(\[\]\)/);
    expect(src).toMatch(/errorBoxStyle/);
  });
});
