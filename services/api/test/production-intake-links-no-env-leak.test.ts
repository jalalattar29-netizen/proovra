/**
 * Production /intake-links feature-disabled panel — no env-var leak.
 *
 * Pins the fix for the production bug where the feature-disabled panel
 * rendered the literal env-var names
 * `WORKFLOW_INTAKE_LINKS_ENABLED` and `WORKFLOW_INTAKE_TOKEN_SECRET`
 * directly to operators. Env-var names are deployment-internal.
 *
 * Phase IA-self-serve-completion update: the panel was further
 * rewritten away from operator-facing infrastructure jargon
 * ("Configuration required", "platform administrator",
 * "deployment-level configuration", "deployment runbook") to plain-
 * language self-serve copy a lawyer / journalist can act on. The
 * underlying invariant — env-var names MUST NOT leak — is unchanged
 * and re-pinned below. The new self-serve copy is also pinned so any
 * regression that reintroduces the infrastructure jargon trips this
 * suite.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { intakeLinksSurface } from "./_helpers/intake-links-surface";

function readWeb(rel: string): string {
  return readFileSync(
    fileURLToPath(new URL(`../../../apps/web/${rel}`, import.meta.url)),
    "utf8",
  );
}
function readApi(rel: string): string {
  return readFileSync(
    fileURLToPath(new URL(`../${rel}`, import.meta.url)),
    "utf8",
  );
}

// The invariant is about the SURFACE, not one file: read the whole route so a
// future env name inlined into any of its modules is caught too.
const PAGE = intakeLinksSurface();
const ENV_EXAMPLE = readApi(".env.example");

// Strip /* … */ and // line comments so the user-facing-copy
// assertions look only at JSX, never at developer comments that
// document what was removed.
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

const PAGE_STRIPPED = stripComments(PAGE);

describe("Production fix — /intake-links feature-disabled panel never leaks env names", () => {
  // ---------------------------------------------------------------------
  // Original invariant — env-var names never appear in user-facing copy.
  // ---------------------------------------------------------------------
  it("page.tsx does NOT render literal WORKFLOW_INTAKE_LINKS_ENABLED in JSX", () => {
    expect(PAGE_STRIPPED).not.toMatch(/<code>\s*WORKFLOW_INTAKE_LINKS_ENABLED\s*<\/code>/);
    expect(PAGE_STRIPPED).not.toMatch(/<code>\s*WORKFLOW_INTAKE_TOKEN_SECRET\s*<\/code>/);
  });

  it("page.tsx never spells either env-var name in any user-facing text", () => {
    // Defense in depth — neither name should appear AT ALL in the
    // post-comment-strip source, regardless of whether it's wrapped in
    // <code>, <span>, or raw text.
    expect(PAGE_STRIPPED).not.toMatch(/WORKFLOW_INTAKE_LINKS_ENABLED/);
    expect(PAGE_STRIPPED).not.toMatch(/WORKFLOW_INTAKE_TOKEN_SECRET/);
  });

  it("no other obvious deployment-secret style ALL_CAPS names leak in JSX", () => {
    // Generic guard against future env names being inlined. We
    // accept that internal/source identifiers can be ALL_CAPS, but
    // they should not appear inside <code> blocks in the disabled
    // panel.
    const codeBlocks = Array.from(
      PAGE_STRIPPED.matchAll(/<code>([\s\S]*?)<\/code>/g),
    ).map((m) => m[1]);
    for (const block of codeBlocks) {
      // Ban "INTAKE" / "TOKEN" / "SECRET" inside <code> blocks for
      // the disabled-state region — those are the categories of
      // names that would indicate an env leak.
      expect(block).not.toMatch(/INTAKE|TOKEN|SECRET/);
    }
  });

  // ---------------------------------------------------------------------
  // Phase IA-self-serve-completion — new self-serve copy is pinned.
  // ---------------------------------------------------------------------
  it("page.tsx still tags the disabled-state container with the testid", () => {
    expect(PAGE).toMatch(/data-testid="intake-links-feature-disabled"/);
  });

  it("page.tsx renders the new self-serve 'Not enabled yet' heading", () => {
    expect(PAGE).toMatch(/<strong>Not enabled yet<\/strong>/);
  });

  it("page.tsx renders the plain-language body sentence", () => {
    // The body is a self-contained sentence describing the state in
    // words a lawyer or journalist can act on. We pin the canonical
    // opening phrase + the action-oriented second sentence.
    expect(PAGE).toMatch(
      /External intake links aren't turned on for your account yet/,
    );
    expect(PAGE).toMatch(/Contact your IT administrator/);
    expect(PAGE).toMatch(/PROOVRA support contact/);
  });

  it("page.tsx does NOT reintroduce the legacy operator-facing copy", () => {
    // These four phrases were intentionally removed for self-serve.
    // Pin that they do not come back. Comments are stripped first so
    // a docstring that explains the removal is not flagged.
    expect(PAGE_STRIPPED).not.toMatch(/Configuration required/);
    expect(PAGE_STRIPPED).not.toMatch(/deployment runbook/);
    expect(PAGE_STRIPPED).not.toMatch(/deployment-level configuration/);
    expect(PAGE_STRIPPED).not.toMatch(/platform administrator/);
  });

  // ---------------------------------------------------------------------
  // .env.example documentation is unchanged — keys still live there
  // so operators deploying the service can find them.
  // ---------------------------------------------------------------------
  it(".env.example documents the required intake-link env keys", () => {
    expect(ENV_EXAMPLE).toMatch(/WORKFLOW_INTAKE_LINKS_ENABLED\s*=/);
    expect(ENV_EXAMPLE).toMatch(/WORKFLOW_INTAKE_TOKEN_SECRET\s*=/);
  });
});
