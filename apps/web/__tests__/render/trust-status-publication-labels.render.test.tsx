/**
 * AUD-0061 (1) — every status-page authoring field on the organization Trust
 * admin has an accessible name.
 *
 * axe `label` (critical) found 12 nodes on /organizations/:id/admin/trust: the
 * incident and maintenance composers rendered a sibling `<label>` with no
 * `htmlFor` above each input, so none of them was named (6 fields x 2
 * viewports). The fields now use the governance field primitive, a real
 * `<label htmlFor>` bound to each control, and keep their `data-testid`s.
 */
import React from "react";
import { describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";

const STATUS = {
  status: {
    components: [
      { key: "api", label: "API", status: "OPERATIONAL" },
      { key: "web", label: "Web app", status: "OPERATIONAL" },
    ],
    activeIncidents: [
      {
        id: "inc-1",
        title: "Uploads are slow",
        severity: "MAJOR",
        state: "INVESTIGATING",
        startedAtUtc: "2026-11-10T08:00:00.000Z",
      },
    ],
  },
};

vi.mock("../../lib/api", () => ({
  apiFetch: vi.fn(async () => STATUS),
}));

vi.mock("../../lib/platform-context", () => {
  const guard = { stamp: () => 0, isStale: () => false };
  return { useTenantGuard: () => guard };
});

vi.mock("../../components/identity-security/StepUpModal", () => {
  const control = {
    state: { kind: "idle" },
    runStepUpAction: async (fn: (h?: Record<string, string>) => Promise<unknown>) => fn({}),
    cancel: () => {},
    closeIdle: () => {},
    startChallenge: async () => {},
    verifyAndRetry: async () => {},
  };
  return {
    useStepUpAction: () => control,
    StepUpModal: () => null,
    StepUpModalProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  };
});

import { ConfirmActionProvider } from "../../components/ui/ConfirmActionModal";
import { StatusPublicationSection } from "../../app/(app)/organizations/[id]/admin/trust/_sections/StatusPublicationSection";

const FIELDS: ReadonlyArray<[testId: string, name: string, tag: "INPUT" | "TEXTAREA"]> = [
  ["status-incident-title", "What is happening", "INPUT"],
  ["status-incident-body", "First update (optional)", "TEXTAREA"],
  ["status-maintenance-title", "Title", "INPUT"],
  ["status-maintenance-description", "What customers should expect", "TEXTAREA"],
  ["status-maintenance-start", "Starts", "INPUT"],
  ["status-maintenance-end", "Ends", "INPUT"],
  ["status-incident-update-body-inc-1", "What changed?", "INPUT"],
];

async function mount() {
  render(
    <ConfirmActionProvider>
      <StatusPublicationSection teamId="11111111-1111-4111-8111-111111111111" />
    </ConfirmActionProvider>,
  );
  await screen.findByTestId("status-incident-title");
}

describe("AUD-0061 — Trust admin status fields are labelled", () => {
  it.each(FIELDS)("%s is named %j by a bound <label>", async (testId, name, tag) => {
    await mount();
    const control = screen.getByTestId(testId);
    expect(control.tagName).toBe(tag);
    expect(screen.getByLabelText(name, { selector: tag.toLowerCase() })).toBe(control);
    const label = document.querySelector(`label[for="${control.id}"]`);
    expect(label?.textContent).toBe(name);
  });

  it("leaves no input or textarea in the section without an accessible name", async () => {
    await mount();
    const unnamed = Array.from(
      document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>(
        'input:not([type="hidden"]), textarea',
      ),
    ).filter((el) => {
      const byFor = el.id ? document.querySelector(`label[for="${el.id}"]`) : null;
      return !byFor && !el.closest("label") && !el.getAttribute("aria-label") && !el.getAttribute("aria-labelledby");
    });
    expect(unnamed.map((el) => el.outerHTML)).toEqual([]);
  });

  it("labels the severity and next-state pickers too, keeping their test ids", async () => {
    await mount();
    const severity = screen.getByTestId("status-incident-severity");
    expect(document.querySelector(`label[for="${severity.id}"]`)?.textContent).toBe("How bad is it");
    const next = screen.getByTestId("status-incident-next-state-inc-1");
    expect(document.querySelector(`label[for="${next.id}"]`)?.textContent).toBe("Next state");
    const row = document.querySelector('[data-status-incident-row="inc-1"]') as HTMLElement;
    expect(within(row).getByRole("button", { name: "Post update" })).toBeTruthy();
  });
});
