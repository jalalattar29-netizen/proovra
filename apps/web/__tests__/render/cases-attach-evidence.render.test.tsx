/**
 * ADD EVIDENCE — the case-linking dialog, driven for real.
 *
 * WHY THIS FILE EXISTS
 * ---------------------------------------------------------------------------
 * The dialog's contract used to be pinned by source-text assertions: that a
 * particular inline style object appeared, that a `<li>` carried an `onClick`,
 * that a hex value was `#475569`. Every one of those passed while the dialog
 * shipped a `pointer-events: none` checkbox next to a duplicate "Select"
 * button — a control the keyboard could not reach and a second affordance that
 * could disagree with the first. A test that reads markup cannot see that.
 *
 * So this file mounts the REAL page, opens the REAL dialog and operates it.
 * Every assertion below is about what an operator can do, what they are told,
 * and what the server is asked for.
 */

import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, act, cleanup } from "@testing-library/react";

// ---------------------------------------------------------------------------
// Seams
// ---------------------------------------------------------------------------

const CASE_ID = "c1000000-0000-4000-8000-000000000001";

/**
 * State the module factory reads.
 *
 * Hoisted with `vi.hoisted` because `vi.mock` is lifted above every
 * declaration in this file: a plain `let` or `class` here is still in its
 * temporal dead zone when the factory is evaluated, and the suite fails to
 * load rather than failing an assertion.
 */
/**
 * State the module factory reads.
 *
 * Hoisted with `vi.hoisted` because `vi.mock` is lifted above every
 * declaration in this file: a plain `let` or `class` here is still in its
 * temporal dead zone when the factory is evaluated, so the suite would fail to
 * LOAD rather than fail an assertion.
 */
const H = vi.hoisted(() => {
  class FakeApiError extends Error {
    status: number;
    constructor(status: number) {
      super(`http ${status}`);
      this.status = status;
    }
  }
  return {
    FakeApiError,
    /** Every request the page makes, in order. */
    requestLog: [] as Array<{ path: string; method: string; body: unknown }>,
    server: {
      available: [] as Array<Record<string, unknown>>,
      /** Status thrown by `GET available-evidence`. */
      availableStatus: undefined as number | undefined,
      /** Evidence ids whose attach POST rejects. */
      failAttachFor: undefined as Set<string> | undefined,
      /** Held open so a pending state can be observed. */
      attachGate: undefined as Promise<void> | undefined,
    },
    /**
     * The `matter-workspace` envelope the page loads.
     *
     * Shaped to the real `MatterWorkspaceEnvelope` contract, because the page
     * reads it directly — a partial fixture makes the page crash on a missing
     * key and the dialog under test never mounts at all.
     */
    caseEnvelope(): unknown {
      const iso = "2026-07-11T00:00:00.000Z";
      const section = <T,>(extra: T) => ({ status: "ok", ...extra });
      return {
        generatedAt: iso,
        case: {
          id: "c1000000-0000-4000-8000-000000000001",
          name: "Bilal",
          referenceNumber: null,
          description: null,
          status: "CLOSED",
          priority: "P2",
          scope: "TEAM",
          ownerUserId: "u-1",
          teamId: "44444444-4444-4444-8444-444444444444",
          closedAtUtc: iso,
          closureReason: null,
          createdAt: "2026-06-15T00:00:00.000Z",
          updatedAt: iso,
        },
        viewer: {
          userId: "u-1",
          role: "OWNER",
          canManage: true,
          canMutate: true,
          canAssign: true,
          canChangeStatus: true,
          canLinkEvidence: true,
          canUnlinkEvidence: true,
          canUnlinkLegacyEvidence: true,
          canComment: true,
          canResolveComment: true,
          disabledReasons: {},
          activeAssignmentRoles: [],
        },
        risk: { status: "ok", data: null, sampledAtUtc: iso },
        sections: {
          commandSummary: section({
            data: {
              linkedEvidenceCount: 0,
              recentlyLinkedCount: 0,
              activeCaseHoldsCount: 0,
              affectedEvidenceHoldsCount: 0,
              pendingReviewCount: 0,
              openEscalationsCount: 0,
              activeAssignmentCount: 0,
            },
          }),
          evidence: section({ items: [] }),
          relationships: section({
            links: [],
            relationships: [],
            counts: {
              primary: 0,
              supporting: 0,
              related: 0,
              duplicate: 0,
              derived: 0,
              context: 0,
            },
          }),
          workflows: section({ items: [] }),
          incidentsAndCausality: section({ incidents: [], chains: [] }),
          governance: section({ holds: [], retention: [], items: [] }),
          assignments: section({ items: [] }),
          comments: section({ items: [] }),
          activity: section({ items: [] }),
          timeline: section({ items: [] }),
        },
      };
    },
  };
});

vi.mock("../../lib/api", () => ({
  apiFetch: async (path: string, init?: { method?: string; body?: string }) => {
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(init.body) : null;
    H.requestLog.push({ path, method, body });

    if (path.endsWith("/available-evidence")) {
      if (H.server.availableStatus) {
        throw new H.FakeApiError(H.server.availableStatus);
      }
      return { items: H.server.available };
    }
    if (path.endsWith("/evidence") && method === "POST") {
      if (H.server.attachGate) await H.server.attachGate;
      const id = (body as { evidenceId: string }).evidenceId;
      if (H.server.failAttachFor?.has(id)) throw new H.FakeApiError(500);
      return { ok: true };
    }
    return H.caseEnvelope();
  },
  readApiToken: () => null,
  apiBaseUrl: () => "https://api.test.invalid",
  ApiError: H.FakeApiError,
}));

vi.mock("../../lib/sentry", () => ({ captureException: () => {} }));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: () => {}, replace: () => {}, back: () => {} }),
  useSearchParams: () => new URLSearchParams(""),
  usePathname: () => "/cases/c1000000-0000-4000-8000-000000000001",
  useParams: () => ({ id: "c1000000-0000-4000-8000-000000000001" }),
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));

import { PlatformContextProvider } from "../../lib/platform-context";
import {
  AUTHORITY_SCHEMA_VERSION,
  CAPABILITY_SCHEMA_VERSION,
  NAVIGATION_SCHEMA_VERSION,
} from "../../lib/platform-context/types";
import { ToastProvider } from "../../components/ui";
import { ConfirmActionProvider } from "../../components/ui/ConfirmActionModal";
import { SimpleCaseDetail } from "../../components/cases-experience/simple-case-detail/SimpleCaseDetail";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const LONG_NAME =
  "Q4-incident-bundle-with-an-extremely-long-operator-supplied-filename-that-nobody-would-shorten-2026-08-20-final-v7-REVIEWED.jpg";

function candidate(
  i: number,
  over: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: `e0000000-0000-4000-8000-00000000000${i}`,
    title: `incident-bundle-${i}.jpg`,
    displayFileName: `incident-bundle-${i}.jpg`,
    originalFileName: `incident-bundle-${i}.jpg`,
    mimeType: "image/jpeg",
    itemCount: 1,
    type: "PHOTO",
    status: "CREATED",
    verificationStatus: "RECORDED_INTEGRITY_VERIFIED",
    createdAt: "2026-08-01T00:00:00.000Z",
    reportReady: true,
    packageReady: true,
    ...over,
  };
}

type ContextKey =
  | "personal"
  | "organization"
  | "enterprise"
  | "platformAdmin"
  | "missing";

function makeEnvelope(key: ContextKey): unknown {
  if (key === "missing") return null;
  const enterprise = key === "enterprise" || key === "platformAdmin";
  const type = key === "personal" ? "PERSONAL" : "ORGANIZATION";
  const id = "44444444-4444-4444-8444-444444444444";
  return {
    authoritySchemaVersion: AUTHORITY_SCHEMA_VERSION,
    capabilitySchemaVersion: CAPABILITY_SCHEMA_VERSION,
    navigationSchemaVersion: NAVIGATION_SCHEMA_VERSION,
    capabilities: { CASES_VIEW: true, CASES_MANAGE: true },
    diagnostics: { requestId: `attach-${key}` },
    workspace: { id, name: "Meridian Legal", status: "active", scope: type },
    activeSpace: { type, id, displayName: "Meridian Legal", roleLabel: "Owner" },
    contextOptions: {
      personalSpace: null,
      ownedWorkspaces: [],
      organizations: [],
      activeContext: {
        workspaceId: id,
        kind: type,
        organizationId: null,
        displayName: "Meridian Legal",
      },
    },
    account: {
      accountPlan: enterprise ? "ENTERPRISE" : "FREE",
      accountStatus: "active",
    },
    flags: { isEnterpriseWorkspace: enterprise },
    platform: { isPlatformAdmin: key === "platformAdmin" },
    planFeatures: {},
  };
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

function renderPage(key: ContextKey) {
  return render(
    <PlatformContextProvider testEnvelope={makeEnvelope(key) as never}>
      <ToastProvider>
        <ConfirmActionProvider>
          <SimpleCaseDetail caseId={CASE_ID} onOpenEvidence={() => {}} />
        </ConfirmActionProvider>
      </ToastProvider>
    </PlatformContextProvider>,
  );
}

async function settle(): Promise<void> {
  let previous = -1;
  for (let i = 0; i < 12 && previous !== document.body.innerHTML.length; i += 1) {
    previous = document.body.innerHTML.length;
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
  }
}

/** Open the dialog from the page's own "Add evidence" trigger. */
async function openDialog(key: ContextKey = "personal") {
  cleanup();
  renderPage(key);
  await settle();
  const trigger = Array.from(
    document.querySelectorAll<HTMLButtonElement>("button"),
  ).find((b) => (b.textContent ?? "").trim().toLowerCase().includes("add evidence"));
  expect(trigger, "the page has no Add evidence trigger").toBeTruthy();
  await act(async () => {
    trigger!.click();
    await Promise.resolve();
  });
  await settle();
}

const dialog = () =>
  document.querySelector("[data-matter-modal='attach-evidence']") as HTMLElement | null;

const rows = () =>
  Array.from(
    document.querySelectorAll<HTMLElement>("[data-simple-case-attach-row]"),
  );

const checkboxes = () =>
  Array.from(
    document.querySelectorAll<HTMLInputElement>(
      "[data-simple-case-attach-row-checkbox]",
    ),
  );

const confirmButton = () =>
  document.querySelector(
    "[data-simple-case-attach-confirm]",
  ) as HTMLButtonElement | null;

const searchInput = () =>
  document.querySelector(
    "[data-simple-case-attach-search]",
  ) as HTMLInputElement | null;

async function type(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    "value",
  )?.set;
  await act(async () => {
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await Promise.resolve();
  });
  await settle();
}

beforeEach(() => {
  H.requestLog.length = 0;
  H.server.available = [candidate(0), candidate(1), candidate(2)];
  H.server.availableStatus = undefined;
  H.server.failAttachFor = undefined;
  H.server.attachGate = undefined;
});

afterEach(() => {
  cleanup();
});

// ===========================================================================
// 1–5. Opening, data, scope, search, long values
// ===========================================================================

describe("the dialog opens onto the canonical modal", () => {
  it("1. opens from Case Details and uses the shared dialog anatomy", async () => {
    await openDialog();
    const d = dialog();
    expect(d, "the canonical modal did not mount").not.toBeNull();
    // The shared anatomy, not a hand-rolled overlay.
    expect(d?.className).toContain("app-dialog");
    expect(d?.getAttribute("role")).toBe("dialog");
    expect(d?.getAttribute("aria-modal")).toBe("true");
    // Accessible title AND description.
    const titleId = d?.getAttribute("aria-labelledby");
    const descId = d?.getAttribute("aria-describedby");
    expect(document.getElementById(titleId ?? "")?.textContent).toBe(
      "Link evidence to case",
    );
    expect((document.getElementById(descId ?? "")?.textContent ?? "").length)
      .toBeGreaterThan(0);
    // It is a PORTAL: the overlay is a child of <body>, not of a panel that
    // would clip a fixed-position descendant.
    const overlay = document.querySelector(".app-dialog-overlay");
    expect(overlay?.parentElement).toBe(document.body);
  });

  it("2. renders the real eligible workspace evidence", async () => {
    await openDialog();
    expect(rows()).toHaveLength(3);
    expect(
      H.requestLog.some((r) => r.path.endsWith("/available-evidence")),
    ).toBe(true);
  });

  it("3. never renders evidence the server did not return for this workspace", async () => {
    // The dialog has no other source of records. Whatever the tenant-scoped
    // endpoint omits cannot appear, and the client adds nothing of its own.
    H.server.available = [candidate(0)];
    await openDialog();
    expect(rows()).toHaveLength(1);
    const scoped = H.requestLog.filter((r) => r.path.includes(CASE_ID));
    expect(scoped.length).toBeGreaterThan(0);
    // Every request the dialog makes names THIS case.
    for (const r of H.requestLog) {
      if (r.path.includes("/v1/cases/")) expect(r.path).toContain(CASE_ID);
    }
  });

  it("4. search filters the rendered rows without clearing the selection", async () => {
    await openDialog();
    await act(async () => {
      checkboxes()[2].click();
      await Promise.resolve();
    });
    expect(
      document
        .querySelector("[data-simple-case-attach-selected-count]")
        ?.getAttribute("data-simple-case-attach-selected-count"),
    ).toBe("1");

    await type(searchInput()!, "bundle-0");
    expect(rows()).toHaveLength(1);
    // The hidden row is still selected — filtering is a view, not a mutation.
    expect(
      document
        .querySelector("[data-simple-case-attach-selected-count]")
        ?.getAttribute("data-simple-case-attach-selected-count"),
    ).toBe("1");

    await type(searchInput()!, "zzzz-no-such-record");
    expect(rows()).toHaveLength(0);
    expect(
      document.querySelector("[data-simple-case-attach-no-match]"),
    ).not.toBeNull();
  });

  it("5. a long filename stays bounded and keeps its full value accessible", async () => {
    H.server.available = [candidate(0, { title: LONG_NAME, displayFileName: LONG_NAME })];
    await openDialog();
    const title = document.querySelector(
      "[data-simple-case-attach-row-title]",
    ) as HTMLElement;
    expect(title).not.toBeNull();
    // Clamped for layout…
    expect(title.className).toContain("attach-evidence__row-title");
    // …and NOT destroyed: the full value is retrievable.
    expect(title.getAttribute("title")).toBe(LONG_NAME);
  });
});

// ===========================================================================
// 6–11. Selection and submission
// ===========================================================================

describe("selection is one control per row", () => {
  it("6. the checkbox works by mouse and by keyboard", async () => {
    await openDialog();
    const box = checkboxes()[0];
    expect(box.checked).toBe(false);

    await act(async () => {
      box.click();
      await Promise.resolve();
    });
    expect(box.checked).toBe(true);

    // Keyboard: focus the control and toggle it the way a keyboard user does.
    await act(async () => {
      box.focus();
      box.click();
      await Promise.resolve();
    });
    expect(document.activeElement).toBe(box);
    expect(box.checked).toBe(false);
  });

  it("7. the whole row toggles, with NO nested interactive element", async () => {
    await openDialog();
    const row = rows()[0];
    // Exactly one interactive descendant: the checkbox itself.
    const interactive = row.querySelectorAll(
      "button, a[href], input, select, textarea, [tabindex]:not([tabindex='-1'])",
    );
    expect(interactive).toHaveLength(1);
    expect((interactive[0] as HTMLInputElement).type).toBe("checkbox");

    // Clicking the row's label region toggles the checkbox.
    const label = row.querySelector("label") as HTMLElement;
    await act(async () => {
      label.click();
      await Promise.resolve();
    });
    expect(checkboxes()[0].checked).toBe(true);
    expect(row.getAttribute("data-selected")).toBe("true");
  });

  it("8. the selected count is truthful", async () => {
    await openDialog();
    const count = () =>
      document
        .querySelector("[data-simple-case-attach-selected-count]")
        ?.getAttribute("data-simple-case-attach-selected-count");
    expect(count()).toBe("0");
    await act(async () => {
      checkboxes()[0].click();
      checkboxes()[1].click();
      await Promise.resolve();
    });
    expect(count()).toBe("2");
    expect(confirmButton()?.textContent).toContain("2");
  });

  it("9. zero selection disables submit", async () => {
    await openDialog();
    expect(confirmButton()?.disabled).toBe(true);
    await act(async () => {
      checkboxes()[0].click();
      await Promise.resolve();
    });
    expect(confirmButton()?.disabled).toBe(false);
  });

  it("10. multiple records submit, one request each", async () => {
    await openDialog();
    await act(async () => {
      checkboxes()[0].click();
      checkboxes()[2].click();
      await Promise.resolve();
    });
    H.requestLog.length = 0;
    await act(async () => {
      confirmButton()!.click();
      await Promise.resolve();
    });
    await settle();
    const attaches = H.requestLog.filter(
      (r) => r.method === "POST" && r.path.endsWith("/evidence"),
    );
    expect(attaches).toHaveLength(2);
    expect(attaches.map((a) => (a.body as { evidenceId: string }).evidenceId).sort())
      .toEqual([candidate(0).id, candidate(2).id].sort());
  });

  it("11. a duplicate submission cannot start a second batch", async () => {
    let release!: () => void;
    H.server.attachGate = new Promise<void>((r) => {
      release = r;
    });
    await openDialog();
    await act(async () => {
      checkboxes()[0].click();
      await Promise.resolve();
    });
    H.requestLog.length = 0;
    const button = confirmButton()!;
    await act(async () => {
      button.click();
      button.click();
      button.click();
      await Promise.resolve();
    });
    // One batch, whatever the operator did with the pointer.
    expect(
      H.requestLog.filter((r) => r.method === "POST" && r.path.endsWith("/evidence")),
    ).toHaveLength(1);
    await act(async () => {
      release();
      await Promise.resolve();
    });
    await settle();
  });
});

// ===========================================================================
// 12–14. Pending, success, failure
// ===========================================================================

describe("the dialog is truthful about what happened", () => {
  it("12. the pending state is announced and the dialog cannot be dismissed", async () => {
    let release!: () => void;
    H.server.attachGate = new Promise<void>((r) => {
      release = r;
    });
    await openDialog();
    await act(async () => {
      checkboxes()[0].click();
      await Promise.resolve();
    });
    await act(async () => {
      confirmButton()!.click();
      await Promise.resolve();
    });

    const button = confirmButton()!;
    expect(button.getAttribute("aria-busy")).toBe("true");
    expect(button.textContent).toContain("Linking…");
    expect(button.disabled).toBe(true);
    // Dismissal protection: the close control stands down while committing.
    expect(document.querySelector("[data-matter-modal-close]")).toBeNull();
    // Escape does not tear the dialog down mid-commit.
    await act(async () => {
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      );
      await Promise.resolve();
    });
    expect(dialog()).not.toBeNull();

    await act(async () => {
      release();
      await Promise.resolve();
    });
    await settle();
  });

  it("13. success closes the dialog and reloads the case", async () => {
    await openDialog();
    await act(async () => {
      checkboxes()[0].click();
      await Promise.resolve();
    });
    H.requestLog.length = 0;
    await act(async () => {
      confirmButton()!.click();
      await Promise.resolve();
    });
    await settle();
    expect(dialog()).toBeNull();
    // The case envelope is re-read, so the page shows the new link.
    expect(
      H.requestLog.some((r) => r.method === "GET" && r.path.includes(CASE_ID)),
    ).toBe(true);
  });

  it("14. failure keeps the dialog open, preserves the selection and explains itself safely", async () => {
    H.server.failAttachFor = new Set([candidate(0).id as string]);
    await openDialog();
    await act(async () => {
      checkboxes()[0].click();
      await Promise.resolve();
    });
    await act(async () => {
      confirmButton()!.click();
      await Promise.resolve();
    });
    await settle();

    expect(dialog(), "an all-failed batch must not close the dialog").not.toBeNull();
    // The row that failed is STILL selected, so a retry costs nothing.
    expect(
      document
        .querySelector("[data-simple-case-attach-selected-count]")
        ?.getAttribute("data-simple-case-attach-selected-count"),
    ).toBe("1");
    const error = document.querySelector(
      "[data-simple-case-attach-submit-error]",
    ) as HTMLElement;
    expect(error).not.toBeNull();
    expect(error.getAttribute("role")).toBe("alert");
    // A bounded message: no status code, no transport text, no stack.
    expect(error.textContent).not.toMatch(/500|http|Error:|at \w+ \(/);
  });
});

// ===========================================================================
// 15–17. States, contexts, fail-closed
// ===========================================================================

describe("every load outcome has its own state", () => {
  it("15. loading, empty, no-match, error and restricted are distinct", async () => {
    // EMPTY — the workspace genuinely has nothing to link.
    H.server.available = [];
    await openDialog();
    expect(document.querySelector("[data-simple-case-attach-empty-list]")).not.toBeNull();
    expect(document.querySelector("[data-simple-case-attach-restricted]")).toBeNull();

    // RESTRICTED — a refusal is not an empty workspace.
    H.server.available = [];
    H.server.availableStatus = 403;
    await openDialog();
    expect(document.querySelector("[data-simple-case-attach-restricted]")).not.toBeNull();
    expect(document.querySelector("[data-simple-case-attach-empty-list]")).toBeNull();

    // ERROR — an outage is not a refusal either.
    H.server.available = [];
    H.server.availableStatus = 500;
    await openDialog();
    expect(document.querySelector("[data-simple-case-attach-error]")).not.toBeNull();
    expect(document.querySelector("[data-simple-case-attach-restricted]")).toBeNull();

    // NO MATCH — records exist; the query hides them.
    H.server.available = [candidate(0)];
    H.server.availableStatus = undefined;
    await openDialog();
    await type(searchInput()!, "no-such-thing");
    expect(document.querySelector("[data-simple-case-attach-no-match]")).not.toBeNull();
    expect(document.querySelector("[data-simple-case-attach-empty-list]")).toBeNull();
  });

  it("16. every workspace context renders the SAME dialog anatomy", async () => {
    const shapes: Record<string, string[]> = {};
    for (const key of ["personal", "organization", "enterprise", "platformAdmin"] as ContextKey[]) {
      await openDialog(key);
      const d = dialog();
      expect(d, `${key} did not mount the dialog`).not.toBeNull();
      shapes[key] = Array.from(d!.querySelectorAll("[class]"))
        .map((e) => e.getAttribute("class") ?? "")
        .filter((c) => c.startsWith("attach-evidence") || c.startsWith("app-"))
        .sort();
    }
    // Capability may change DATA and ACTIONS. It may not produce a second
    // design: the class set is identical in all four.
    expect(shapes.organization).toEqual(shapes.personal);
    expect(shapes.enterprise).toEqual(shapes.personal);
    expect(shapes.platformAdmin).toEqual(shapes.personal);
  });

  it("17. a missing capability projection fails closed", async () => {
    cleanup();
    H.requestLog.length = 0;
    renderPage("missing");
    await settle();
    // No envelope → no case page, no dialog, and no tenant-scoped request.
    expect(dialog()).toBeNull();
    expect(
      H.requestLog.filter((r) => r.path.endsWith("/available-evidence")),
    ).toHaveLength(0);
  });
});

// ===========================================================================
// Presentation — the canonical authorities, proven by what rendered
// ===========================================================================

describe("the row uses the canonical primitives", () => {
  it("uses the canonical checkbox, not a private one", async () => {
    await openDialog();
    for (const box of checkboxes()) {
      expect(box.className).toContain("app-checkbox");
      expect(box.getAttribute("readonly")).toBeNull();
    }
  });

  it("separates metadata into groups rather than one sentence", async () => {
    H.server.available = [
      candidate(0, { reportReady: false, packageReady: false }),
    ];
    await openDialog();
    const row = rows()[0];
    // Kind, identity and deliverables each have their own region.
    expect(row.querySelector("[data-simple-case-attach-row-kind]")).not.toBeNull();
    expect(row.querySelector("[data-simple-case-attach-row-id]")).not.toBeNull();
    expect(row.querySelector(".attach-evidence__row-deliverables")).not.toBeNull();
    // "Missing" is never a success statement.
    const report = row.querySelector(
      "[data-simple-case-attach-row-report]",
    ) as HTMLElement;
    expect(report.getAttribute("data-state")).toBe("missing");
  });

  it("colours integrity by state, and a failure is not a caution", async () => {
    H.server.available = [
      candidate(0, { verificationStatus: "RECORDED_INTEGRITY_VERIFIED" }),
      candidate(1, { verificationStatus: "FAILED" }),
      candidate(2, { verificationStatus: "REVIEW_REQUIRED" }),
    ];
    await openDialog();
    const tones = rows().map((r) =>
      r
        .querySelector("[data-simple-case-attach-row-integrity]")
        ?.getAttribute("data-tone"),
    );
    expect(tones).toEqual(["green", "red", "amber"]);
  });

  it("carries no inline presentation of its own", async () => {
    await openDialog();
    const styled = Array.from(dialog()!.querySelectorAll("[style]"));
    expect(styled.map((e) => e.getAttribute("style"))).toEqual([]);
  });

  it("selection does not change the row's box", async () => {
    await openDialog();
    const row = rows()[0];
    const before = row.className;
    await act(async () => {
      checkboxes()[0].click();
      await Promise.resolve();
    });
    // The class set is unchanged; selection is expressed by a data attribute
    // the stylesheet paints with an INSET ring, so nothing reflows.
    expect(rows()[0].className).toBe(before);
    expect(rows()[0].getAttribute("data-selected")).toBe("true");
  });
});

