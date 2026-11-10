/**
 * AUD-0032 — Capture is offered exactly to the roles the create path admits.
 *
 * EVIDENCE_CAPTURE was in the universally-granted read set, so a VIEWER of an
 * organization workspace saw the Capture entry and the full upload wizard,
 * and every capture was refused with SHARED_WORKSPACE_FORBIDDEN (the create
 * path checks `evidence.create`, which a VIEWER does not hold). It now follows
 * that permission.
 */
import { describe, expect, it } from "vitest";

import { resolveCapabilities } from "../src/services/platform-context/capability-registry.js";

const capture = (input: Partial<Parameters<typeof resolveCapabilities>[0]>) =>
  resolveCapabilities({ scope: "TEAM", role: "MEMBER", plan: "ENTERPRISE", isPlatformAdmin: false, ...input } as never)
    .EVIDENCE_CAPTURE;

describe("EVIDENCE_CAPTURE follows evidence.create", () => {
  it("a VIEWER of an organization workspace is not offered Capture; it still reads evidence", () => {
    expect(capture({ role: "VIEWER", workspaceKind: "ORGANIZATION" } as never)).toBe(false);
    const caps = resolveCapabilities({ scope: "TEAM", role: "VIEWER", plan: "ENTERPRISE", isPlatformAdmin: false, workspaceKind: "ORGANIZATION" } as never);
    expect(caps.EVIDENCE_VIEW).toBe(true);
  });

  it("a VIEWER invited into a Pro Personal Workspace is not offered Capture", () => {
    expect(capture({ scope: "PERSONAL", role: "VIEWER", plan: "PRO", workspaceKind: "PERSONAL" } as never)).toBe(false);
  });

  it("controls: members, admins and owners capture; the owner of their own Personal Space captures", () => {
    for (const role of ["MEMBER", "ADMIN", "OWNER"] as const) {
      expect(capture({ role, workspaceKind: "ORGANIZATION" } as never), role).toBe(true);
    }
    expect(capture({ scope: "PERSONAL", role: "OWNER", plan: "FREE", workspaceKind: "PERSONAL" } as never)).toBe(true);
  });
});
