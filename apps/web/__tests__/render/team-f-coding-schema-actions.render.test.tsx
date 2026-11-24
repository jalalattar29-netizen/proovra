/**
 * Team remediation stage F — T-134 (audit PRD-08 / O-06): the coding-schema
 * page offers only valid actions. The REAL apiFetch over a stubbed `fetch`.
 *
 * Production showed "Seed 6 default schemas" while the six defaults were
 * listed, and "Archive" next to "This schema is already archived."
 */
import React from "react";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CODING_SCHEMA_DEFAULT_SLUGS } from "@proovra/shared";

vi.mock("../../lib/sentry", () => ({ captureException: () => {} }));
vi.mock("../../lib/platform-context", () => ({ useActiveSpaceId: () => "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }));
vi.mock("../../components/ui/ConfirmActionModal", () => ({ useConfirmAction: () => ({ confirm: async () => true }) }));
vi.mock("../../components/navigation/PageRouteGate", () => ({
  PageRouteGate: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

import CodingSchemasPage from "../../app/(app)/review/schemas/page";

let schemas: Array<Record<string, unknown>>;
let seedPosts: number;

function schema(slug: string, status = "PUBLISHED", i = 0) {
  return { id: `00000000-0000-4000-8000-00000000000${i}`, slug, label: `Schema ${slug}`, category: "GENERAL", version: 1, status, description: null, fields: [] };
}

beforeEach(() => {
  seedPosts = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input).replace(/^https?:\/\/[^/]+/, "");
      let body: unknown = {};
      if (path.startsWith("/v1/reviewer/workspace")) body = { workspace: { capabilities: ["review.schema.author"] } };
      else if (path.startsWith("/v1/coding/schemas/seed") || (init?.method === "POST" && path.includes("seed"))) {
        seedPosts += 1;
        body = { created: 0, updated: 6, existing: 6, failed: 0 };
      } else if (path.startsWith("/v1/coding/schemas")) body = { schemas };
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const flush = async () => {
  for (let i = 0; i < 8; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
};
const seedButton = () => document.querySelector("[data-coding-seed-defaults]") as HTMLButtonElement;

describe("T-134 — coding schema actions", () => {
  it("with all six defaults present (one archived) Seed is disabled with a reason, and archived rows offer no Archive", async () => {
    schemas = CODING_SCHEMA_DEFAULT_SLUGS.map((slug, i) => schema(slug, i === 5 ? "ARCHIVED" : "PUBLISHED", i));
    render(<CodingSchemasPage />);
    await flush();
    expect(seedButton().disabled).toBe(true);
    expect(seedButton().getAttribute("data-disabled-reason")).toBe("All six default schemas are already in this workspace.");
    const archivedId = schemas[5]!.id as string;
    expect(document.querySelector(`[data-coding-schema-archive="${archivedId}"]`)).toBeNull();
    expect(document.querySelector(`[data-coding-schema-archived="${archivedId}"]`)).not.toBeNull();
    // A published row still offers Archive.
    expect(document.querySelector(`[data-coding-schema-archive="${schemas[0]!.id as string}"]`)).not.toBeNull();
    await act(async () => {
      seedButton().click();
    });
    expect(seedPosts).toBe(0);
  });

  it("with some defaults missing, Seed says how many it will add (control)", async () => {
    schemas = CODING_SCHEMA_DEFAULT_SLUGS.slice(0, 4).map((slug, i) => schema(slug, "PUBLISHED", i));
    render(<CodingSchemasPage />);
    await flush();
    expect(seedButton().disabled).toBe(false);
    expect(seedButton().textContent).toContain("Add 2 missing default schemas");
  });
});
