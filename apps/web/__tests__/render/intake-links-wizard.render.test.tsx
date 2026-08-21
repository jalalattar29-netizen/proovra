/**
 * /intake-links — the creation wizard, driven for real.
 *
 * The promises this file proves cannot be read out of source: that Back does
 * not discard what Continue accepted, that an invalid step focuses its own
 * first bad field, that the preview never sends, that a double-click produces
 * one link and not two, and that a failure leaves every entered value intact.
 */

import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  render,
  screen,
  within,
  waitFor,
  act,
  cleanup,
  fireEvent,
} from "@testing-library/react";

// ---------------------------------------------------------------------------
// Seams
// ---------------------------------------------------------------------------

type Transport = {
  email: { configured: boolean; fromName?: string; fromAddressPreview?: string };
  sms: { configured: boolean; fromNumberPreview?: string | null };
  whatsapp: { configured: boolean; fromNumberPreview?: string | null };
};

let requestLog: Array<{ path: string; method: string; body?: unknown }> = [];
let transport: Transport;
let createBehaviour: () => unknown = () => ({});
let createCalls = 0;

function apiFailure(statusCode: number, code?: string): Error {
  const err = new Error("request failed") as Error & {
    statusCode: number;
    code?: string;
  };
  err.statusCode = statusCode;
  if (code) err.code = code;
  return err;
}

vi.mock("../../lib/api", () => ({
  apiFetch: async (path: string, init?: { method?: string; body?: string }) => {
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(init.body) : undefined;
    requestLog.push({ path, method, body });
    if (method === "GET" && path.startsWith("/v1/workflow/intake-links?")) {
      return { items: [] };
    }
    if (path.startsWith("/v1/workflow/templates")) return { templates: [] };
    if (path.includes("/sender-identity")) return transport;
    if (path === "/v1/workflow/intake-links" && method === "POST") {
      createCalls += 1;
      const result = createBehaviour();
      if (result instanceof Error) throw result;
      return result;
    }
    return {};
  },
  readApiToken: () => null,
  apiBaseUrl: () => "https://api.test.invalid",
  ApiError: class ApiError extends Error {},
}));

vi.mock("../../lib/sentry", () => ({ captureException: () => {} }));

let currentSearch = "new=1";
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: () => {}, replace: () => {}, back: () => {} }),
  useSearchParams: () => new URLSearchParams(currentSearch),
  usePathname: () => "/intake-links",
  useParams: () => ({}),
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
import IntakeLinksPage from "../../app/(app)/intake-links/page";
import { FIELD_IDS } from "../../app/(app)/intake-links/_components/wizard/steps";
import { REQUEST_PURPOSES } from "../../lib/intake-links/catalog";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const WS = "11111111-1111-4111-8111-111111111111";

const ALL_CHANNELS: Transport = {
  email: {
    configured: true,
    fromName: "PROOVRA",
    fromAddressPreview: "no-reply@proovra.com",
  },
  sms: { configured: true, fromNumberPreview: "+1 ••• ••• 8084" },
  whatsapp: { configured: true, fromNumberPreview: "+1 ••• ••• 8084" },
};

function createdPayload(over: Record<string, unknown> = {}) {
  return {
    rawToken: "raw-token-value",
    link: {
      id: "new-link",
      teamId: WS,
      workflowTemplateSlug: "general-evidence-record",
      workflowTemplateVersion: 1,
      intakeMode: "EXTERNAL_ONE_TIME",
      caseId: null,
      recipientLabel: null,
      recipientEmail: null,
      recipientPhone: "+14155550123",
      maxUses: 1,
      usedCount: 0,
      maxFileCountPerSession: 10,
      maxBytesPerSession: null,
      allowedAcceptedKinds: ["PHOTO"],
      consentPolicyVersion: null,
      status: "ACTIVE",
      expiresAtUtc: "2099-01-01T00:00:00.000Z",
      revokedAtUtc: null,
      revokedReason: null,
      createdAt: "2026-08-20T00:00:00.000Z",
      updatedAt: "2026-08-20T00:00:00.000Z",
    },
    delivery: { method: "SMS", status: "sent", communicationMessageId: "m1" },
    ...over,
  };
}

function envelope() {
  return {
    authoritySchemaVersion: AUTHORITY_SCHEMA_VERSION,
    capabilitySchemaVersion: CAPABILITY_SCHEMA_VERSION,
    navigationSchemaVersion: NAVIGATION_SCHEMA_VERSION,
    capabilities: { INTAKE_LINKS_MANAGE: true },
    diagnostics: { requestId: "test" },
    workspace: { id: WS, name: "Acme Legal", status: "active", scope: "ORGANIZATION" },
    activeSpace: {
      type: "ORGANIZATION",
      id: WS,
      displayName: "Acme Legal",
      roleLabel: "Owner",
    },
    contextOptions: {
      personalSpace: null,
      ownedWorkspaces: [],
      organizations: [],
      activeContext: {
        workspaceId: WS,
        kind: "ORGANIZATION",
        organizationId: null,
        displayName: "Acme Legal",
      },
    },
    account: { accountPlan: "TEAM", accountStatus: "active" },
    flags: { isEnterpriseWorkspace: false },
    platform: { isPlatformAdmin: false },
    planFeatures: { intakeIncluded: true },
  };
}

async function settle() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function openWizard(over: Record<string, unknown> = {}) {
  cleanup();
  render(
    <PlatformContextProvider
      testEnvelope={{ ...envelope(), ...over } as never}
    >
      <ToastProvider>
        <ConfirmActionProvider>
          <IntakeLinksPage />
        </ConfirmActionProvider>
      </ToastProvider>
    </PlatformContextProvider>,
  );
  await settle();
  const dialog = document.querySelector(
    '[data-testid="intake-link-create-wizard"]',
  ) as HTMLElement;
  expect(dialog).toBeTruthy();
  return dialog;
}

function step(): string | null {
  return document
    .querySelector("[data-intake-link-wizard-step]")
    ?.getAttribute("data-intake-link-wizard-step") ?? null;
}

async function clickNext() {
  await act(async () => {
    fireEvent.click(
      document.querySelector("[data-intake-link-wizard-next]") as HTMLElement,
    );
  });
}

async function clickBack() {
  await act(async () => {
    fireEvent.click(
      document.querySelector("[data-intake-link-wizard-back]") as HTMLElement,
    );
  });
}

async function chooseChannel(value: string) {
  await act(async () => {
    fireEvent.click(
      document.querySelector(
        `[data-intake-link-delivery-method-input="${value}"]`,
      ) as HTMLElement,
    );
  });
}

async function type(selector: string, value: string) {
  await act(async () => {
    fireEvent.change(document.querySelector(selector) as HTMLInputElement, {
      target: { value },
    });
  });
}

/** Walk to review with a valid SMS request. */
async function walkToReview() {
  await clickNext(); // request → delivery
  await chooseChannel("SMS");
  await type("[data-intake-link-phone]", "+14155550123");
  await clickNext(); // delivery → rules
  await clickNext(); // rules → review
}

beforeEach(() => {
  requestLog = [];
  createCalls = 0;
  currentSearch = "new=1";
  transport = { ...ALL_CHANNELS };
  createBehaviour = () => createdPayload();
});

// ===========================================================================
// Shell
// ===========================================================================

describe("wizard shell", () => {
  it("is one accessible dialog with a stepper and a stable footer", async () => {
    const dialog = await openWizard();
    expect(dialog.getAttribute("role")).toBe("dialog");
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(dialog.getAttribute("aria-labelledby")).toBeTruthy();

    const stepper = dialog.querySelector("[data-intake-link-stepper]");
    expect(stepper).toBeTruthy();
    expect(
      stepper?.querySelectorAll("[data-intake-link-step]").length,
    ).toBe(4);
    expect(
      stepper?.querySelector('[aria-current="step"]')?.getAttribute(
        "data-intake-link-step",
      ),
    ).toBe("request");

    // Head, body and footer are siblings — only the body scrolls.
    expect(dialog.querySelector(".app-dialog__head")).toBeTruthy();
    expect(dialog.querySelector(".app-dialog__body")).toBeTruthy();
    expect(dialog.querySelector(".app-dialog__footer")).toBeTruthy();
  });

  it("advances and retreats through all four steps", async () => {
    await openWizard();
    expect(step()).toBe("request");
    await clickNext();
    expect(step()).toBe("delivery");
    await chooseChannel("MANUAL");
    await clickNext();
    expect(step()).toBe("rules");
    await clickNext();
    expect(step()).toBe("review");
    await clickBack();
    expect(step()).toBe("rules");
  });

  it("keeps every entered value across Back and Continue", async () => {
    await openWizard();
    await clickNext();
    await chooseChannel("EMAIL");
    await type("[data-intake-link-email]", "witness@example.com");
    await type("[data-intake-link-recipient-label]", "Claim 4842");
    await clickNext();
    await type("[data-intake-link-max-files]", "42");
    await clickNext();
    expect(step()).toBe("review");

    await clickBack();
    expect(
      (document.querySelector("[data-intake-link-max-files]") as HTMLInputElement)
        .value,
    ).toBe("42");
    await clickBack();
    expect(
      (document.querySelector("[data-intake-link-email]") as HTMLInputElement)
        .value,
    ).toBe("witness@example.com");
    expect(
      (
        document.querySelector(
          "[data-intake-link-recipient-label]",
        ) as HTMLInputElement
      ).value,
    ).toBe("Claim 4842");
  });

  it("asks before discarding entered data, and keeps it if you decline", async () => {
    await openWizard();
    await clickNext();
    await type("[data-intake-link-recipient-label]", "Jane");
    await act(async () => {
      fireEvent.click(
        document.querySelector("[data-intake-link-wizard-back]") as HTMLElement,
      );
    });
    // Step 2's Back is a real Back, not a dismiss — go to step 1 then Cancel.
    expect(step()).toBe("request");
    await act(async () => {
      fireEvent.click(
        document.querySelector("[data-intake-link-wizard-back]") as HTMLElement,
      );
    });
    const confirm = await screen.findByRole("dialog", { name: /discard/i });
    expect(confirm.textContent).toMatch(/nothing has been created or sent/i);
    await act(async () => {
      fireEvent.click(
        within(confirm).getByRole("button", { name: /keep editing/i }),
      );
    });
    expect(
      document.querySelector('[data-testid="intake-link-create-wizard"]'),
    ).toBeTruthy();
  });

  it("closes without asking when nothing was entered", async () => {
    await openWizard();
    await act(async () => {
      fireEvent.click(
        document.querySelector("[data-intake-link-wizard-back]") as HTMLElement,
      );
    });
    await waitFor(() =>
      expect(
        document.querySelector('[data-testid="intake-link-create-wizard"]'),
      ).toBeNull(),
    );
  });
});

// ===========================================================================
// Step 1 — request
// ===========================================================================

describe("step 1 — request", () => {
  it("offers the request purposes through a listbox, never a native select", async () => {
    const dialog = await openWizard();
    expect(dialog.querySelectorAll("select").length).toBe(0);
    const combo = dialog.querySelector('[role="combobox"]') as HTMLElement;
    await act(async () => {
      fireEvent.click(combo);
    });
    const listbox = document.querySelector('[role="listbox"]') as HTMLElement;
    const labels = within(listbox)
      .getAllByRole("option")
      .map((o) => o.textContent ?? "");
    for (const expected of [
      "General evidence request",
      "Photos & videos",
      "Documents",
      "Insurance claim evidence",
      "Legal document collection",
      "Property damage",
      "Incident investigation",
      "Compliance / audit submission",
      "Source / witness submission",
    ]) {
      expect(labels.some((l) => l.includes(expected))).toBe(true);
    }
    // No internal slug is exposed as a label.
    expect(labels.join(" ")).not.toContain("general-evidence-record");
  });

  it("changing purpose re-seeds the recommended file types until the operator chooses", async () => {
    await openWizard();
    const combo = document.querySelector('[role="combobox"]') as HTMLElement;
    await act(async () => {
      fireEvent.click(combo);
    });
    const option = within(
      document.querySelector('[role="listbox"]') as HTMLElement,
    )
      .getAllByRole("option")
      .find((o) => o.textContent?.includes("Compliance / audit")) as HTMLElement;
    await act(async () => {
      fireEvent.click(option);
    });

    // Compliance recommends documents only.
    await clickNext();
    await chooseChannel("MANUAL");
    await clickNext();
    const checked = Array.from(
      document.querySelectorAll<HTMLInputElement>(
        "[data-intake-link-accepted-kind-input]",
      ),
    )
      .filter((el) => el.checked)
      .map((el) => el.getAttribute("data-intake-link-accepted-kind-input"));
    expect(checked).toEqual(["DOCUMENT"]);
  });

  it("a deliberate file-type choice survives a later purpose change", async () => {
    async function pickPurpose(match: string) {
      await act(async () => {
        fireEvent.click(document.querySelector('[role="combobox"]') as HTMLElement);
      });
      const option = within(
        document.querySelector('[role="listbox"]') as HTMLElement,
      )
        .getAllByRole("option")
        .find((o) => o.textContent?.includes(match)) as HTMLElement;
      await act(async () => {
        fireEvent.click(option);
      });
    }
    function checkedKinds(): string[] {
      return Array.from(
        document.querySelectorAll<HTMLInputElement>(
          "[data-intake-link-accepted-kind-input]",
        ),
      )
        .filter((el) => el.checked)
        .map((el) => el.getAttribute("data-intake-link-accepted-kind-input") as string);
    }

    await openWizard();
    // Start from a purpose that recommends documents only.
    await pickPurpose("Compliance / audit");
    await clickNext();
    await chooseChannel("MANUAL");
    await clickNext();
    expect(checkedKinds()).toEqual(["DOCUMENT"]);

    // Deliberately add Audio — a witness statement recording.
    await act(async () => {
      fireEvent.click(
        document.querySelector(
          '[data-intake-link-accepted-kind-input="AUDIO"]',
        ) as HTMLElement,
      );
    });
    expect(checkedKinds()).toEqual(["AUDIO", "DOCUMENT"]);

    // Change the purpose to one whose recommendation is entirely different.
    await clickBack();
    await clickBack();
    await pickPurpose("Photos & videos");
    await clickNext();
    await clickNext();

    // The deliberate set survives untouched — a purpose change must never
    // silently overwrite a choice the operator actually made.
    expect(checkedKinds()).toEqual(["AUDIO", "DOCUMENT"]);
  });

  it("presents the four link types as one labelled radio group", async () => {
    await openWizard();
    const group = document.querySelector(
      '[data-intake-link-choice-group="intake-mode"]',
    ) as HTMLElement;
    expect(group.tagName).toBe("FIELDSET");
    expect(group.querySelector("legend")?.textContent).toMatch(/how should the link work/i);
    const radios = group.querySelectorAll<HTMLInputElement>('input[type="radio"]');
    expect(radios.length).toBe(4);
    for (const r of Array.from(radios)) {
      // No native circle survives, and every card is described.
      expect(r.className).toBe("ilk-choice__input");
      expect(r.getAttribute("aria-describedby")).toBeTruthy();
    }
    // Reuse and identity are ONE backend field, so they are ONE group and each
    // option states both consequences.
    expect(group.textContent).toMatch(/no contributor identity is requested/i);
    expect(group.textContent).toMatch(/several people can submit/i);
  });
});

// ===========================================================================
// Step 2 — delivery and sender
// ===========================================================================

describe("step 2 — delivery and sender", () => {
  it("asks only for the recipient field the chosen channel needs", async () => {
    await openWizard();
    await clickNext();

    await chooseChannel("SMS");
    expect(document.querySelector("[data-intake-link-phone]")).toBeTruthy();
    expect(document.querySelector("[data-intake-link-email]")).toBeNull();

    await chooseChannel("EMAIL");
    expect(document.querySelector("[data-intake-link-email]")).toBeTruthy();
    expect(document.querySelector("[data-intake-link-phone]")).toBeNull();

    await chooseChannel("WHATSAPP");
    expect(document.querySelector("[data-intake-link-phone]")).toBeTruthy();

    await chooseChannel("MANUAL");
    expect(document.querySelector("[data-intake-link-phone]")).toBeNull();
    expect(document.querySelector("[data-intake-link-email]")).toBeNull();
    expect(document.querySelector("[data-intake-link-manual-note]")).toBeTruthy();
  });

  it("blocks Continue and focuses the missing recipient field", async () => {
    await openWizard();
    await clickNext();
    await chooseChannel("EMAIL");
    await clickNext();
    expect(step()).toBe("delivery");
    const email = document.querySelector(
      "[data-intake-link-email]",
    ) as HTMLInputElement;
    expect(document.activeElement).toBe(email);
    expect(email.getAttribute("aria-invalid")).toBe("true");
    const errorId = email.getAttribute("aria-describedby");
    expect(document.getElementById(errorId as string)?.textContent).toMatch(
      /email address/i,
    );
  });

  it("rejects a national phone number and accepts an international one", async () => {
    await openWizard();
    await clickNext();
    await chooseChannel("SMS");
    await type("[data-intake-link-phone]", "415-555-0123");
    await clickNext();
    expect(step()).toBe("delivery");
    expect(document.body.textContent).toMatch(/country code/i);

    await type("[data-intake-link-phone]", "+14155550123");
    await clickNext();
    expect(step()).toBe("rules");
  });

  it("disables a channel the deployment cannot send on, with the reason", async () => {
    transport = { ...ALL_CHANNELS, whatsapp: { configured: false } };
    await openWizard();
    await clickNext();
    const wa = document.querySelector(
      '[data-intake-link-delivery-method-input="WHATSAPP"]',
    ) as HTMLInputElement;
    expect(wa.disabled).toBe(true);
    const card = wa.closest("[data-intake-link-delivery-method]") as HTMLElement;
    expect(card.textContent).toMatch(/not configured/i);
  });

  it("defaults to a channel the deployment can actually deliver on", async () => {
    transport = {
      email: { configured: true },
      sms: { configured: false },
      whatsapp: { configured: false },
    };
    await openWizard();
    await clickNext();
    const email = document.querySelector(
      '[data-intake-link-delivery-method-input="EMAIL"]',
    ) as HTMLInputElement;
    expect(email.checked).toBe(true);
  });

  it("falls all the way back to copy-link when no provider is configured", async () => {
    transport = {
      email: { configured: false },
      sms: { configured: false },
      whatsapp: { configured: false },
    };
    await openWizard();
    await clickNext();
    const manual = document.querySelector(
      '[data-intake-link-delivery-method-input="MANUAL"]',
    ) as HTMLInputElement;
    expect(manual.checked).toBe(true);
  });

  it("offers three sender identities and validates a custom name", async () => {
    await openWizard();
    await clickNext();
    const group = document.querySelector(
      '[data-intake-link-choice-group="sender-display-mode"]',
    ) as HTMLElement;
    const values = Array.from(
      group.querySelectorAll("[data-intake-link-sender-card]"),
    ).map((el) => el.getAttribute("data-intake-link-sender-card"));
    expect(values).toEqual(["PROOVRA", "WORKSPACE", "CUSTOM"]);
    // Workspace mode is the default when the workspace has a name.
    expect(
      (
        document.querySelector(
          '[data-intake-link-sender-card-input="WORKSPACE"]',
        ) as HTMLInputElement
      ).checked,
    ).toBe(true);

    await act(async () => {
      fireEvent.click(
        document.querySelector(
          '[data-intake-link-sender-card-input="CUSTOM"]',
        ) as HTMLElement,
      );
    });
    const name = document.querySelector(
      '[data-intake-link-sender-custom-name="true"]',
    ) as HTMLInputElement;
    expect(name).toBeTruthy();
    await act(async () => {
      fireEvent.change(name, { target: { value: "PROOVRA" } });
    });
    await chooseChannel("MANUAL");
    await clickNext();
    expect(step()).toBe("delivery");
    expect(document.body.textContent).toMatch(/PROOVRA is reserved/i);
  });
});

// ===========================================================================
// Step 3 — collection rules
// ===========================================================================

describe("step 3 — collection rules", () => {
  async function toRules() {
    await openWizard();
    await clickNext();
    await chooseChannel("MANUAL");
    await clickNext();
  }

  it("offers the three location policies with the truthful boundary stated", async () => {
    await toRules();
    const group = document.querySelector(
      '[data-intake-link-choice-group="location-policy"]',
    ) as HTMLElement;
    const values = Array.from(
      group.querySelectorAll("[data-intake-link-location-card]"),
    ).map((el) => el.getAttribute("data-intake-link-location-card"));
    expect(values).toEqual(["NONE", "OPTIONAL", "REQUIRED"]);
    expect(group.textContent).toMatch(/contributor's own browser/i);
    expect(group.textContent).toMatch(/not proof of where they were/i);
    // Required states its real fallback rather than over-promising.
    expect(group.textContent).toMatch(/if their device cannot provide it/i);
    // "Recommended" is a restrained note, not a competing status badge.
    const note = group.querySelector(".ilk-choice__note");
    expect(note?.textContent).toBe("Recommended");
    expect(note?.classList.contains("app-status-badge")).toBe(false);
  });

  it("rejects out-of-range limits at the step boundary", async () => {
    await toRules();
    await type("[data-intake-link-max-files]", "0");
    await clickNext();
    expect(step()).toBe("rules");
    expect(document.body.textContent).toMatch(/between 1 and 500/i);

    await type("[data-intake-link-max-files]", "10");
    await clickNext();
    expect(step()).toBe("review");
  });

  it("requires at least one accepted file type", async () => {
    await toRules();
    for (const kind of ["PHOTO", "VIDEO", "AUDIO", "DOCUMENT"]) {
      const el = document.querySelector(
        `[data-intake-link-accepted-kind-input="${kind}"]`,
      ) as HTMLInputElement;
      if (el.checked) {
        await act(async () => {
          fireEvent.click(el);
        });
      }
    }
    await clickNext();
    expect(step()).toBe("rules");
    expect(document.body.textContent).toMatch(/at least one type of file/i);
  });

  it("shows accepted types as human labels on canonical checkboxes", async () => {
    await toRules();
    const chips = Array.from(
      document.querySelectorAll("[data-intake-link-accepted-kind]"),
    );
    expect(chips.map((c) => c.querySelector(".ilk-kind__label")?.textContent)).toEqual(
      ["Photos", "Videos", "Audio", "Documents"],
    );
    for (const chip of chips) {
      const input = chip.querySelector("input") as HTMLInputElement;
      expect(input.type).toBe("checkbox");
      expect(input.className).toBe("app-checkbox");
    }
    // The raw enum is never printed at the operator.
    expect(
      chips.map((c) => c.textContent).join(" "),
    ).not.toMatch(/\bPHOTO\b|\bDOCUMENT\b/);
  });

  it("expiry is a preset listbox that reveals a bounded custom field", async () => {
    await toRules();
    const combos = document.querySelectorAll('[role="combobox"]');
    const expiry = combos[0] as HTMLElement;
    await act(async () => {
      fireEvent.click(expiry);
    });
    const custom = within(
      document.querySelector('[role="listbox"]') as HTMLElement,
    ).getByRole("option", { name: /custom/i });
    await act(async () => {
      fireEvent.click(custom);
    });
    const hours = document.querySelector(
      "[data-intake-link-expiry-hours]",
    ) as HTMLInputElement;
    expect(hours).toBeTruthy();
    await act(async () => {
      fireEvent.change(hours, { target: { value: "0" } });
    });
    await clickNext();
    expect(step()).toBe("rules");
    expect(document.body.textContent).toMatch(/between 1 and 8760 hours/i);
  });
});

// ===========================================================================
// Step 4 — review and create
// ===========================================================================

describe("step 4 — review and create", () => {
  it("summarises the request and previews the real message without sending", async () => {
    await openWizard();
    await walkToReview();

    const preview = document.querySelector(
      '[data-intake-link-preview-studio="true"]',
    ) as HTMLElement;
    expect(preview).toBeTruthy();
    expect(preview.getAttribute("data-intake-link-preview-channel")).toBe("SMS");
    expect(
      preview.querySelector('[data-intake-link-preview-sender-display="true"]')
        ?.textContent,
    ).toContain("Acme Legal");
    expect(
      preview.querySelector('[data-intake-link-preview-transport="true"]')
        ?.textContent,
    ).toContain("8084");
    const body = preview.querySelector(
      '[data-intake-link-preview-body="true"]',
    ) as HTMLElement;
    expect(body.textContent).toContain("[secure-link]");
    expect(body.tagName).toBe("PRE");
    expect(body.querySelectorAll("textarea,input").length).toBe(0);
    expect(preview.textContent).toMatch(/preview only/i);
    expect(preview.textContent).toMatch(/no account is required/i);
    expect(preview.textContent).toMatch(/not to forward/i);
    // SMS is the only channel that carries the carrier opt-out statement.
    expect(preview.textContent).toMatch(/STOP opt-out/i);

    // Nothing has been created or sent by reaching the review step.
    expect(createCalls).toBe(0);
    expect(requestLog.some((r) => r.method === "POST")).toBe(false);
  });

  it("the preview follows the wizard state", async () => {
    await openWizard();
    await clickNext();
    await chooseChannel("EMAIL");
    await type("[data-intake-link-email]", "witness@example.com");
    await clickNext();
    await clickNext();
    const preview = document.querySelector(
      '[data-intake-link-preview-studio="true"]',
    ) as HTMLElement;
    expect(preview.getAttribute("data-intake-link-preview-channel")).toBe("EMAIL");
    expect(
      preview.querySelector('[data-intake-link-preview-subject="true"]'),
    ).toBeTruthy();
    expect(preview.textContent).toContain("witness@example.com");
    // Email carries no carrier opt-out sentence.
    expect(preview.textContent).not.toMatch(/STOP opt-out/i);
  });

  it("copy-link shows no message preview at all", async () => {
    await openWizard();
    await clickNext();
    await chooseChannel("MANUAL");
    await clickNext();
    await clickNext();
    expect(
      document.querySelector('[data-intake-link-preview-studio="true"]'),
    ).toBeNull();
    expect(
      document.querySelector('[data-intake-link-preview-manual="true"]'),
    ).toBeTruthy();
    expect(
      document.querySelector("[data-intake-link-submit]")?.textContent,
    ).toMatch(/create secure link/i);
  });

  it("creates the link with the exact contract body and reveals it once", async () => {
    await openWizard();
    await walkToReview();
    await act(async () => {
      fireEvent.click(
        document.querySelector("[data-intake-link-submit]") as HTMLElement,
      );
    });
    await waitFor(() => expect(createCalls).toBe(1));

    const post = requestLog.find(
      (r) => r.path === "/v1/workflow/intake-links" && r.method === "POST",
    );
    const body = post?.body as Record<string, unknown>;
    expect(body.teamId).toBe(WS);
    expect(body.deliveryMethod).toBe("SMS");
    expect(body.recipientPhone).toBe("+14155550123");
    expect(body.intakeMode).toBe("EXTERNAL_ONE_TIME");
    expect(body.maxUses).toBe(1);
    expect(String(body.idempotencyKey)).toMatch(/^create:/);
    expect(typeof body.expiresAtUtc).toBe("string");
    expect(body.senderDisplayMode).toBe("WORKSPACE");
    expect(body.locationPolicy).toBe("OPTIONAL");
    expect(body.intakeUrlBase).toBeTruthy();

    await waitFor(() =>
      expect(
        document.querySelector('[data-testid="intake-link-created"]'),
      ).toBeTruthy(),
    );
    const reveal = document.querySelector(
      '[data-testid="intake-link-created"]',
    ) as HTMLElement;
    expect(
      (reveal.querySelector("[data-intake-link-url]") as HTMLInputElement).value,
    ).toContain("raw-token-value");
    expect(reveal.textContent).toMatch(/shown once/i);
    expect(
      reveal.querySelector('[data-intake-link-delivery-result="sent"]'),
    ).toBeTruthy();
  });

  it("a double-click creates exactly one link, on one idempotency key", async () => {
    await openWizard();
    await walkToReview();
    const submit = document.querySelector(
      "[data-intake-link-submit]",
    ) as HTMLElement;
    await act(async () => {
      fireEvent.click(submit);
      fireEvent.click(submit);
      fireEvent.click(submit);
    });
    await waitFor(() => expect(createCalls).toBe(1));
    const posts = requestLog.filter((r) => r.method === "POST");
    expect(posts.length).toBe(1);
  });

  it("marks the submit button busy while committing", async () => {
    let release: ((v: unknown) => void) | null = null;
    createBehaviour = () =>
      new Promise((resolve) => {
        release = resolve;
      });
    await openWizard();
    await walkToReview();
    await act(async () => {
      fireEvent.click(
        document.querySelector("[data-intake-link-submit]") as HTMLElement,
      );
    });
    const submit = document.querySelector(
      "[data-intake-link-submit]",
    ) as HTMLButtonElement;
    expect(submit.getAttribute("aria-busy")).toBe("true");
    expect(submit.disabled).toBe(true);
    expect(submit.textContent).toMatch(/creating/i);
    await act(async () => {
      release?.(createdPayload());
    });
  });

  it("a rejected create keeps every entered value and says why in English", async () => {
    createBehaviour = () =>
      apiFailure(409, "intake_mode_not_supported_by_template");
    await openWizard();
    await walkToReview();
    await act(async () => {
      fireEvent.click(
        document.querySelector("[data-intake-link-submit]") as HTMLElement,
      );
    });
    await waitFor(() =>
      expect(
        document.querySelector("[data-intake-link-create-error]"),
      ).toBeTruthy(),
    );
    const error = document.querySelector(
      "[data-intake-link-create-error]",
    ) as HTMLElement;
    expect(error.textContent).not.toContain("intake_mode_not_supported_by_template");
    expect(error.textContent).toMatch(/doesn't support the selected link type/i);

    // Still on review, still holding the phone number.
    expect(step()).toBe("review");
    await clickBack();
    await clickBack();
    expect(
      (document.querySelector("[data-intake-link-phone]") as HTMLInputElement)
        .value,
    ).toBe("+14155550123");
  });

  it("reports a partial result truthfully — link created, delivery failed", async () => {
    createBehaviour = () =>
      createdPayload({
        delivery: {
          method: "SMS",
          status: "failed",
          reason: "provider_unconfigured",
        },
      });
    await openWizard();
    await walkToReview();
    await act(async () => {
      fireEvent.click(
        document.querySelector("[data-intake-link-submit]") as HTMLElement,
      );
    });
    const failure = await waitFor(
      () =>
        document.querySelector(
          '[data-intake-link-delivery-result="failed"]',
        ) as HTMLElement,
    );
    expect(failure.textContent).toMatch(/messaging isn't configured/i);
    expect(failure.textContent).toMatch(/link itself was created/i);
    expect(failure.textContent).not.toContain("provider_unconfigured");
  });

  it("refreshes the list after a successful create", async () => {
    await openWizard();
    const readsBefore = requestLog.filter((r) =>
      r.path.startsWith("/v1/workflow/intake-links?"),
    ).length;
    await walkToReview();
    await act(async () => {
      fireEvent.click(
        document.querySelector("[data-intake-link-submit]") as HTMLElement,
      );
    });
    await waitFor(() => {
      const readsAfter = requestLog.filter((r) =>
        r.path.startsWith("/v1/workflow/intake-links?"),
      ).length;
      expect(readsAfter).toBeGreaterThan(readsBefore);
    });
  });
});

// ===========================================================================
// Exhaustive option sweep — every branch, and every branch canonical
// ===========================================================================

/** Every control the wizard mounts must belong to the canonical system. */
function assertCanonicalControls(scope: HTMLElement) {
  // No native option list, anywhere, at any step.
  expect(scope.querySelectorAll("select").length).toBe(0);
  expect(scope.querySelectorAll("optgroup").length).toBe(0);
  // No legacy form-control classes.
  for (const legacy of [".cases-form-input", ".cases-panel", ".cases-empty"]) {
    expect(scope.querySelector(legacy), `legacy ${legacy}`).toBeNull();
  }
  // Every radio is a choice card; every checkbox is the canonical one.
  for (const r of Array.from(
    scope.querySelectorAll<HTMLInputElement>('input[type="radio"]'),
  )) {
    expect(r.className).toBe("ilk-choice__input");
    expect(r.closest("label")).toBeTruthy();
    // A label-wrapped control must not contain a second interactive element.
    expect(
      r.closest("label")?.querySelectorAll("button, a[href], select").length,
    ).toBe(0);
  }
  for (const c of Array.from(
    scope.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'),
  )) {
    expect(c.className).toBe("app-checkbox");
  }
  // Text inputs and textareas use the canonical field class.
  for (const f of Array.from(
    scope.querySelectorAll<HTMLElement>(
      'input[type="text"], input[type="email"], input[type="tel"], input[type="number"], textarea',
    ),
  )) {
    expect(f.className.split(/\s+/)).toContain("app-form-input");
  }
  // Every dropdown is the canonical listbox trigger.
  for (const combo of Array.from(scope.querySelectorAll('[role="combobox"]'))) {
    expect(combo.classList.contains("app-listbox__trigger")).toBe(true);
    expect(combo.getAttribute("aria-haspopup")).toBe("listbox");
  }
  // Actions are the canonical buttons.
  const footer = scope.querySelector(".app-dialog__footer") as HTMLElement;
  for (const b of Array.from(footer.querySelectorAll("button"))) {
    const cls = b.className.split(/\s+/);
    expect(
      cls.includes("app-primary-action") || cls.includes("app-secondary-action"),
    ).toBe(true);
  }
}

function dialog(): HTMLElement {
  return document.querySelector(
    '[data-testid="intake-link-create-wizard"]',
  ) as HTMLElement;
}

async function openPurposeList() {
  await act(async () => {
    fireEvent.click(document.querySelector('[role="combobox"]') as HTMLElement);
  });
  return document.querySelector('[role="listbox"]') as HTMLElement;
}

/** Drive the wizard to Create with the current selections, copy-link channel. */
async function createWithCopyLink() {
  await clickNext();
  await chooseChannel("MANUAL");
  await clickNext();
  await clickNext();
  await act(async () => {
    fireEvent.click(
      document.querySelector("[data-intake-link-submit]") as HTMLElement,
    );
  });
  await waitFor(() => expect(createCalls).toBeGreaterThan(0));
  return requestLog.find((r) => r.method === "POST")?.body as Record<
    string,
    unknown
  >;
}

describe("every request purpose is selectable through the canonical listbox", () => {
  const PURPOSES = [
    "General evidence request",
    "Photos & videos",
    "Documents",
    "Insurance claim evidence",
    "Legal document collection",
    "Property damage",
    "Incident investigation",
    "Compliance / audit submission",
    "Source / witness submission",
  ];

  for (const label of PURPOSES) {
    it(`${label} selects, describes itself, and reaches the create body`, async () => {
      await openWizard();
      const list = await openPurposeList();
      const option = within(list)
        .getAllByRole("option")
        .find((o) => o.textContent?.includes(label)) as HTMLElement;
      expect(option, `no option for ${label}`).toBeTruthy();
      await act(async () => {
        fireEvent.click(option);
      });

      const combo = document.querySelector('[role="combobox"]') as HTMLElement;
      expect(combo.textContent).toContain(label);
      const help = dialog().querySelector(".app-field-help") as HTMLElement;
      expect((help.textContent ?? "").trim().length).toBeGreaterThan(10);
      assertCanonicalControls(dialog());

      const body = await createWithCopyLink();
      const slug = body.workflowTemplateSlug as string;
      expect(slug).toMatch(/^[a-z0-9-]+$/);
      // The operator never sees the slug; the server never sees the label.
      expect(slug).not.toBe(label);
    });
  }
});

describe("every link mode, sender identity and location policy", () => {
  const MODES: Array<[string, string]> = [
    ["EXTERNAL_ONE_TIME", "One-time link"],
    ["EXTERNAL_REUSABLE", "Reusable link"],
    ["EXTERNAL_ANONYMOUS", "Anonymous link"],
    ["EXTERNAL_PSEUDONYMOUS", "Display-name link"],
  ];

  for (const [wire, label] of MODES) {
    it(`${label} is one choice of ONE group and reaches the body as ${wire}`, async () => {
      await openWizard();
      // Reuse and contributor identity are a SINGLE backend field, so they are
      // a single group; splitting them would fabricate a contract.
      const groups = dialog().querySelectorAll(
        '[data-intake-link-choice-group="intake-mode"]',
      );
      expect(groups.length).toBe(1);
      const input = document.querySelector(
        `[data-intake-link-mode-input="${wire}"]`,
      ) as HTMLInputElement;
      expect(input).toBeTruthy();
      await act(async () => {
        fireEvent.click(input);
      });
      expect(input.checked).toBe(true);
      // Every radio in the group shares one name — a real single-choice group.
      const names = new Set(
        Array.from(
          groups[0].querySelectorAll<HTMLInputElement>('input[type="radio"]'),
        ).map((r) => r.name),
      );
      expect(names.size).toBe(1);

      const body = await createWithCopyLink();
      expect(body.intakeMode).toBe(wire);
      // Only a reusable link raises the usage ceiling.
      expect(body.maxUses).toBe(wire === "EXTERNAL_REUSABLE" ? 1000 : 1);
    });
  }

  it("a long custom sender name is accepted and bounded, an invalid one is refused", async () => {
    await openWizard();
    await clickNext();
    await chooseChannel("MANUAL");
    await act(async () => {
      fireEvent.click(
        document.querySelector(
          '[data-intake-link-sender-card-input="CUSTOM"]',
        ) as HTMLElement,
      );
    });
    const name = document.querySelector(
      '[data-intake-link-sender-custom-name="true"]',
    ) as HTMLInputElement;
    // The field enforces the API's own ceiling rather than letting the server
    // refuse a value the form happily accepted.
    expect(Number(name.getAttribute("maxLength"))).toBe(80);

    // Invalid: an address is refused with plain English, and the step holds.
    await act(async () => {
      fireEvent.change(name, { target: { value: "mail@example.com" } });
    });
    await clickNext();
    expect(step()).toBe("delivery");
    expect(document.body.textContent).toMatch(/email addresses/i);

    // A long-but-legal name passes and reaches the body trimmed.
    const long = "Fotheringay, Wallace & Associates International Legal Group";
    await act(async () => {
      fireEvent.change(name, { target: { value: `  ${long}  ` } });
    });
    await clickNext();
    expect(step()).toBe("rules");
    await clickNext();
    await act(async () => {
      fireEvent.click(
        document.querySelector("[data-intake-link-submit]") as HTMLElement,
      );
    });
    await waitFor(() => expect(createCalls).toBe(1));
    const body = requestLog.find((r) => r.method === "POST")?.body as Record<
      string,
      unknown
    >;
    expect(body.senderDisplayName).toBe(long);
    expect(body.senderDisplayMode).toBe("CUSTOM");
  });

  for (const policy of ["NONE", "OPTIONAL", "REQUIRED"] as const) {
    it(`location policy ${policy} selects and reaches the body`, async () => {
      await openWizard();
      await clickNext();
      await chooseChannel("MANUAL");
      await clickNext();
      const input = document.querySelector(
        `[data-intake-link-location-card-input="${policy}"]`,
      ) as HTMLInputElement;
      await act(async () => {
        fireEvent.click(input);
      });
      expect(input.checked).toBe(true);
      assertCanonicalControls(dialog());
      await clickNext();
      await act(async () => {
        fireEvent.click(
          document.querySelector("[data-intake-link-submit]") as HTMLElement,
        );
      });
      await waitFor(() => expect(createCalls).toBe(1));
      const body = requestLog.find((r) => r.method === "POST")?.body as Record<
        string,
        unknown
      >;
      expect(body.locationPolicy).toBe(policy);
    });
  }
});

describe("collection limits and accepted types", () => {
  async function toRules() {
    await openWizard();
    await clickNext();
    await chooseChannel("MANUAL");
    await clickNext();
  }

  it("every expiry preset selects and computes a real absolute expiry", async () => {
    for (const [label, hours] of [
      ["24 hours", 24],
      ["3 days", 72],
      ["7 days", 168],
      ["30 days", 720],
    ] as const) {
      await toRules();
      await act(async () => {
        fireEvent.click(
          document.querySelectorAll('[role="combobox"]')[0] as HTMLElement,
        );
      });
      const option = within(
        document.querySelector('[role="listbox"]') as HTMLElement,
      ).getByRole("option", { name: label });
      const before = Date.now();
      await act(async () => {
        fireEvent.click(option);
      });
      await clickNext();
      await act(async () => {
        fireEvent.click(
          document.querySelector("[data-intake-link-submit]") as HTMLElement,
        );
      });
      await waitFor(() => expect(createCalls).toBeGreaterThan(0));
      const body = requestLog.find((r) => r.method === "POST")?.body as Record<
        string,
        unknown
      >;
      const ms = Date.parse(body.expiresAtUtc as string) - before;
      // Within a minute of the requested duration — the units are HOURS and
      // the value is absolute UTC, exactly as the contract expects.
      expect(Math.abs(ms - hours * 3_600_000)).toBeLessThan(60_000);
      createCalls = 0;
      requestLog = [];
    }
  });

  it("the custom expiry field enforces both ends of the API range", async () => {
    await toRules();
    await act(async () => {
      fireEvent.click(
        document.querySelectorAll('[role="combobox"]')[0] as HTMLElement,
      );
    });
    await act(async () => {
      fireEvent.click(
        within(
          document.querySelector('[role="listbox"]') as HTMLElement,
        ).getByRole("option", { name: /custom/i }),
      );
    });
    const hours = document.querySelector(
      "[data-intake-link-expiry-hours]",
    ) as HTMLInputElement;
    expect(hours.getAttribute("min")).toBe("1");
    expect(hours.getAttribute("max")).toBe("8760");

    for (const bad of ["0", "8761"]) {
      await act(async () => {
        fireEvent.change(hours, { target: { value: bad } });
      });
      await clickNext();
      expect(step()).toBe("rules");
      expect(document.body.textContent).toMatch(/between 1 and 8760 hours/i);
    }
    await act(async () => {
      fireEvent.change(hours, { target: { value: "1" } });
    });
    await clickNext();
    expect(step()).toBe("review");
  });

  it("max files enforces both ends and accepts blank as no cap", async () => {
    await toRules();
    const field = () =>
      document.querySelector("[data-intake-link-max-files]") as HTMLInputElement;
    expect(field().getAttribute("min")).toBe("1");
    expect(field().getAttribute("max")).toBe("500");
    for (const bad of ["0", "501"]) {
      await act(async () => {
        fireEvent.change(field(), { target: { value: bad } });
      });
      await clickNext();
      expect(step()).toBe("rules");
    }
    await act(async () => {
      fireEvent.change(field(), { target: { value: "" } });
    });
    await clickNext();
    expect(step()).toBe("review");
    await act(async () => {
      fireEvent.click(
        document.querySelector("[data-intake-link-submit]") as HTMLElement,
      );
    });
    await waitFor(() => expect(createCalls).toBe(1));
    const body = requestLog.find((r) => r.method === "POST")?.body as Record<
      string,
      unknown
    >;
    expect(body.maxFileCountPerSession).toBeNull();
  });

  it("each single file type, and all four, reach the body as backend values", async () => {
    const ALL = ["PHOTO", "VIDEO", "AUDIO", "DOCUMENT"] as const;
    const setKinds = async (wanted: readonly string[]) => {
      for (const k of ALL) {
        const el = document.querySelector(
          `[data-intake-link-accepted-kind-input="${k}"]`,
        ) as HTMLInputElement;
        if (el.checked !== wanted.includes(k)) {
          await act(async () => {
            fireEvent.click(el);
          });
        }
      }
    };
    for (const wanted of [["PHOTO"], ["VIDEO"], ["AUDIO"], ["DOCUMENT"], ALL]) {
      await toRules();
      await setKinds(wanted as readonly string[]);
      await clickNext();
      expect(step()).toBe("review");
      await act(async () => {
        fireEvent.click(
          document.querySelector("[data-intake-link-submit]") as HTMLElement,
        );
      });
      await waitFor(() => expect(createCalls).toBeGreaterThan(0));
      const body = requestLog.find((r) => r.method === "POST")?.body as Record<
        string,
        unknown
      >;
      // Backend values, in the catalog's canonical order.
      expect(body.allowedAcceptedKinds).toEqual(
        ALL.filter((k) => (wanted as readonly string[]).includes(k)),
      );
      createCalls = 0;
      requestLog = [];
    }
  });

  it("consent text is optional, bounded, and trimmed onto the body", async () => {
    await toRules();
    const consent = document.querySelector(
      "[data-intake-link-consent]",
    ) as HTMLTextAreaElement;
    expect(Number(consent.getAttribute("maxLength"))).toBe(4000);
    const long = "I confirm these files are mine to share. ".repeat(90);
    await act(async () => {
      fireEvent.change(consent, { target: { value: `  ${long}  ` } });
    });
    // The field itself clamps to the API ceiling rather than letting the
    // server refuse a value the form accepted.
    expect(consent.value.length).toBeLessThanOrEqual(4000);
    await clickNext();
    expect(step()).toBe("review");
    await act(async () => {
      fireEvent.click(
        document.querySelector("[data-intake-link-submit]") as HTMLElement,
      );
    });
    await waitFor(() => expect(createCalls).toBe(1));
    const body = requestLog.find((r) => r.method === "POST")?.body as Record<
      string,
      unknown
    >;
    expect(String(body.consentDisclosureText).length).toBeLessThanOrEqual(4000);
    expect(String(body.consentDisclosureText).startsWith("I confirm")).toBe(true);
  });
});

describe("every step mounts canonical controls only", () => {
  it("request, delivery, rules and review each pass the canonical sweep", async () => {
    await openWizard();
    assertCanonicalControls(dialog());
    await clickNext();
    // Every channel variant, including the ones with a conditional field.
    for (const channel of ["SMS", "EMAIL", "WHATSAPP", "MANUAL"]) {
      await chooseChannel(channel);
      assertCanonicalControls(dialog());
    }
    await chooseChannel("MANUAL");
    await clickNext();
    assertCanonicalControls(dialog());
    await clickNext();
    assertCanonicalControls(dialog());
    // The review step's preview is a read-only region, not an editor.
    expect(
      document.querySelector('[data-intake-link-preview-manual="true"]'),
    ).toBeTruthy();
  });

  it("no provider configuration at all still mounts the canonical wizard", async () => {
    transport = {
      email: { configured: false },
      sms: { configured: false },
      whatsapp: { configured: false },
    };
    await openWizard();
    await clickNext();
    assertCanonicalControls(dialog());
    // Every sending channel is disabled; copy-link remains available and is
    // the default, so the wizard is never a dead end.
    for (const c of ["SMS", "EMAIL", "WHATSAPP"]) {
      expect(
        (
          document.querySelector(
            `[data-intake-link-delivery-method-input="${c}"]`,
          ) as HTMLInputElement
        ).disabled,
      ).toBe(true);
    }
    const manual = document.querySelector(
      '[data-intake-link-delivery-method-input="MANUAL"]',
    ) as HTMLInputElement;
    expect(manual.disabled).toBe(false);
    expect(manual.checked).toBe(true);
    await clickNext();
    await clickNext();
    expect(step()).toBe("review");
  });

  for (const only of ["sms", "email", "whatsapp"] as const) {
    it(`only ${only} configured leaves exactly that channel and copy-link open`, async () => {
      transport = {
        email: { configured: only === "email" },
        sms: {
          configured: only === "sms",
          fromNumberPreview: "+1 ••• ••• 8084",
        },
        whatsapp: {
          configured: only === "whatsapp",
          fromNumberPreview: "+1 ••• ••• 8084",
        },
      };
      await openWizard();
      await clickNext();
      const enabled = (c: string) =>
        !(
          document.querySelector(
            `[data-intake-link-delivery-method-input="${c}"]`,
          ) as HTMLInputElement
        ).disabled;
      expect(enabled(only.toUpperCase())).toBe(true);
      expect(enabled("MANUAL")).toBe(true);
      for (const other of ["SMS", "EMAIL", "WHATSAPP"].filter(
        (c) => c !== only.toUpperCase(),
      )) {
        expect(enabled(other)).toBe(false);
      }
      // The configured channel is the one the wizard defaults to.
      expect(
        (
          document.querySelector(
            `[data-intake-link-delivery-method-input="${only.toUpperCase()}"]`,
          ) as HTMLInputElement
        ).checked,
      ).toBe(true);
      assertCanonicalControls(dialog());
    });
  }
});

// ===========================================================================
// Label hierarchy — every branch, one authority
// ===========================================================================

/**
 * The label ELEMENTS this surface is allowed to render, and the class each is
 * allowed to carry. A label with any other class is a label styled ad hoc,
 * which is exactly how three of them drifted onto the description tier and
 * read as faint helper text on a translucent card.
 */
const LABEL_AUTHORITIES: Record<string, ReadonlyArray<string>> = {
  // A plain field label, and the two whole-card radio/checkbox anatomies.
  label: ["app-field-label", "ilk-choice", "ilk-kind"],
  legend: ["ilk-fieldset__legend"],
};

/** The two containers through which a bare <dt> reaches the authority. */
const FACT_KEY_CONTAINERS = [".ilk-facts", ".ilk-preview__meta"];

/** Tiers that sit BELOW a label. A label wearing one of these is the defect. */
const LOWER_TIERS = ["desc", "hint", "help", "note", "placeholder", "muted"];

function normalize(el: Element): string {
  return (el.textContent ?? "")
    .replace(/\s*\(required\)\s*/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Every visible label, legend and fact key inside a scope. */
function labelElements(scope: HTMLElement): HTMLElement[] {
  return Array.from(
    scope.querySelectorAll<HTMLElement>("label, legend, dt"),
  ).filter((el) => !el.classList.contains("app-visually-hidden"));
}

/**
 * Assert every visible label in `scope` resolves to the canonical authority —
 * either by carrying its class, or, for a bare <dt>, by sitting inside one of
 * the containers the authority names.
 */
function assertLabelAuthority(scope: HTMLElement, branch: string) {
  const elements = labelElements(scope);
  expect(elements.length, `${branch}: rendered no labels at all`).toBeGreaterThan(0);

  const offenders: string[] = [];
  for (const el of elements) {
    const tag = el.tagName.toLowerCase();
    const classes = el.className.split(/\s+/).filter(Boolean);
    if (tag === "dt") {
      if (!FACT_KEY_CONTAINERS.some((sel) => el.closest(sel))) {
        offenders.push(`${branch}: <dt>${normalize(el)}</dt> outside the authority`);
      }
      continue;
    }
    const allowed = LABEL_AUTHORITIES[tag] ?? [];
    if (!allowed.some((c) => classes.includes(c))) {
      offenders.push(
        `${branch}: <${tag} class="${el.className}"> ${normalize(el).slice(0, 48)}`,
      );
    }
    for (const lower of LOWER_TIERS) {
      if (classes.some((c) => c.includes(lower))) {
        offenders.push(`${branch}: <${tag}> wears the ${lower} tier`);
      }
    }
    // No inline colour escapes the stylesheet.
    expect(el.getAttribute("style"), `${branch}: inline style on a label`).toBeNull();
  }
  expect(offenders, branch).toEqual([]);
}

/** Visible label text, with the required marker folded out. */
function labelTexts(scope: HTMLElement): string[] {
  return labelElements(scope).map(normalize);
}

async function pickPurpose(label: string) {
  await act(async () => {
    fireEvent.click(document.getElementById(FIELD_IDS.purpose) as HTMLElement);
  });
  const listbox = document.querySelector('[role="listbox"]') as HTMLElement;
  // Match on the option LABEL, not its accessible name — the name also carries
  // the description line, which is exactly what the label tier must not be.
  const option = Array.from(
    listbox.querySelectorAll<HTMLElement>('[role="option"]'),
  ).find(
    (o) =>
      (o.querySelector("span > span")?.textContent ?? "").trim() === label,
  );
  expect(option, "no option labelled " + label).toBeTruthy();
  await act(async () => {
    fireEvent.click(option as HTMLElement);
  });
}

async function pickCard(attr: string, value: string) {
  await act(async () => {
    fireEvent.click(
      document.querySelector(`[data-${attr}-input="${value}"]`) as HTMLElement,
    );
  });
}

describe("wizard label hierarchy, in every branch", () => {
  it("every label of all four steps resolves to the one authority", async () => {
    const dialog = await openWizard();
    assertLabelAuthority(dialog, "step 1 request");
    expect(labelTexts(dialog)).toContain("What are you asking for?");
    expect(labelTexts(dialog)).toContain("How should the link work?");

    await clickNext();
    await chooseChannel("MANUAL");
    assertLabelAuthority(dialog, "step 2 delivery");
    for (const expected of [
      "How should the link reach them?",
      "Recipient label",
      "Request appears from",
    ]) {
      expect(labelTexts(dialog), `step 2 missing ${expected}`).toContain(expected);
    }

    await clickNext();
    assertLabelAuthority(dialog, "step 3 rules");
    for (const expected of [
      "Location collection",
      "Link expires in",
      "Maximum files per submission",
      "Accepted file types",
      "Consent or disclosure text",
    ]) {
      expect(labelTexts(dialog), `step 3 missing ${expected}`).toContain(expected);
    }

    await clickNext();
    assertLabelAuthority(dialog, "step 4 review");
  });

  it("every request purpose keeps its labels canonical", async () => {
    const dialog = await openWizard();
    for (const purpose of REQUEST_PURPOSES) {
      await pickPurpose(purpose.label);
      assertLabelAuthority(dialog, `purpose ${purpose.slug}`);
      // The purpose copy lands in the HELP tier under the label, never in the
      // label itself.
      const help = dialog.querySelector(".app-field-help") as HTMLElement;
      expect(help.textContent, purpose.slug).toBe(purpose.description);
      expect(labelTexts(dialog)).toContain("What are you asking for?");
    }
  });

  for (const mode of [
    "EXTERNAL_ONE_TIME",
    "EXTERNAL_REUSABLE",
    "EXTERNAL_ANONYMOUS",
    "EXTERNAL_PSEUDONYMOUS",
  ] as const) {
    it(`link type ${mode} keeps its labels canonical`, async () => {
      const dialog = await openWizard();
      await pickCard("intake-link-mode", mode);
      expect(
        (
          document.querySelector(
            `[data-intake-link-mode-input="${mode}"]`,
          ) as HTMLInputElement
        ).checked,
        `${mode} did not take`,
      ).toBe(true);
      assertLabelAuthority(dialog, `mode ${mode}`);
    });
  }

  for (const channel of ["MANUAL", "SMS", "EMAIL", "WHATSAPP"] as const) {
    it(`channel ${channel} shows exactly its own recipient label`, async () => {
      const dialog = await openWizard();
      await clickNext();
      await chooseChannel(channel);
      assertLabelAuthority(dialog, `channel ${channel}`);
      const texts = labelTexts(dialog);
      expect(texts).toContain("Recipient label");
      if (channel === "EMAIL") {
        expect(texts).toContain("Recipient email");
        expect(texts).not.toContain("Recipient phone");
      } else if (channel === "SMS" || channel === "WHATSAPP") {
        expect(texts).toContain("Recipient phone");
        expect(texts).not.toContain("Recipient email");
      } else {
        expect(texts).not.toContain("Recipient email");
        expect(texts).not.toContain("Recipient phone");
      }
    });
  }

  for (const sender of ["PROOVRA", "WORKSPACE", "CUSTOM"] as const) {
    it(`sender ${sender} keeps its conditional label canonical`, async () => {
      const dialog = await openWizard();
      await clickNext();
      await chooseChannel("EMAIL");
      await pickCard("intake-link-sender-card", sender);
      assertLabelAuthority(dialog, `sender ${sender}`);
      const texts = labelTexts(dialog);
      expect(texts).toContain("Request appears from");
      if (sender === "CUSTOM") {
        expect(texts).toContain("Display name");
      } else {
        expect(texts).not.toContain("Display name");
      }
    });
  }

  for (const policy of ["NONE", "OPTIONAL", "REQUIRED"] as const) {
    it(`location policy ${policy} keeps its labels canonical`, async () => {
      const dialog = await openWizard();
      await clickNext();
      await chooseChannel("MANUAL");
      await clickNext();
      await pickCard("intake-link-location-card", policy);
      assertLabelAuthority(dialog, `location ${policy}`);
      expect(labelTexts(dialog)).toContain("Location collection");
    });
  }

  it("the custom-expiry branch labels its extra field canonically", async () => {
    const dialog = await openWizard();
    await clickNext();
    await chooseChannel("MANUAL");
    await clickNext();
    expect(labelTexts(dialog)).not.toContain("Expires in (hours)");
    await act(async () => {
      fireEvent.click(document.getElementById(FIELD_IDS.expiry) as HTMLElement);
    });
    await act(async () => {
      fireEvent.click(
        within(document.querySelector('[role="listbox"]') as HTMLElement).getByRole(
          "option",
          { name: "Custom…" },
        ),
      );
    });
    assertLabelAuthority(dialog, "custom expiry");
    expect(labelTexts(dialog)).toContain("Expires in (hours)");
  });

  it("an unconfigured provider disables the CONTROL, never the label", async () => {
    transport = {
      email: { configured: true, fromName: "PROOVRA" },
      sms: { configured: false, fromNumberPreview: null },
      whatsapp: { configured: false, fromNumberPreview: null },
    };
    const dialog = await openWizard();
    await clickNext();
    assertLabelAuthority(dialog, "unconfigured providers");
    for (const value of ["SMS", "WHATSAPP"]) {
      const input = document.querySelector(
        `[data-intake-link-delivery-method-input="${value}"]`,
      ) as HTMLInputElement;
      expect(input.disabled, `${value} should be unavailable`).toBe(true);
      // The card is still a canonical choice label, and it says WHY.
      const card = input.closest("label") as HTMLElement;
      expect(card.classList.contains("ilk-choice")).toBe(true);
      expect(card.hasAttribute("disabled")).toBe(false);
      expect(card.textContent).toContain("Not configured on this deployment.");
    }
  });

  it("every review and preview fact key reaches the authority", async () => {
    const dialog = await openWizard();
    await walkToReview();
    assertLabelAuthority(dialog, "review");

    const keys = Array.from(dialog.querySelectorAll("dt"));
    expect(keys.length).toBeGreaterThan(8);
    for (const key of keys) {
      expect(
        FACT_KEY_CONTAINERS.some((sel) => key.closest(sel)),
        `${normalize(key)} is outside the label authority`,
      ).toBe(true);
    }
    const texts = keys.map(normalize);
    for (const expected of [
      "Asking for",
      "Link type",
      "Channel",
      "Appears from",
      "Expires",
      "Location",
      // A message preview key — the branch that exists only when something is
      // actually sent.
      "Sent via",
    ]) {
      expect(texts, `review missing ${expected}`).toContain(expected);
    }
  });

  it("the copy-link review branch keeps its labels canonical without a preview", async () => {
    const dialog = await openWizard();
    await clickNext();
    await chooseChannel("MANUAL");
    await clickNext();
    await clickNext();
    expect(step()).toBe("review");
    assertLabelAuthority(dialog, "review / copy link");
    expect(dialog.querySelector(".ilk-preview__meta")).toBeNull();
    expect(labelTexts(dialog)).toContain("Asking for");
  });

  it("the secure-link reveal labels its one field canonically", async () => {
    await openWizard();
    await walkToReview();
    await act(async () => {
      fireEvent.click(
        document.querySelector("[data-intake-link-submit]") as HTMLElement,
      );
    });
    await waitFor(() =>
      expect(document.querySelector('[data-testid="intake-link-created"]')).toBeTruthy(),
    );
    const reveal = document.querySelector(
      '[data-testid="intake-link-created"]',
    ) as HTMLElement;
    assertLabelAuthority(reveal, "secure link reveal");
    expect(labelTexts(reveal)).toContain("Secure link");
  });

  it("keeps the label authority in every workspace context", async () => {
    const contexts: Array<[string, Record<string, unknown>]> = [
      [
        "personal pro",
        {
          workspace: {
            id: WS,
            name: "Jordan Reyes",
            status: "active",
            scope: "PERSONAL",
          },
          activeSpace: {
            type: "PERSONAL",
            id: WS,
            displayName: "Jordan Reyes",
            roleLabel: "Owner",
          },
          account: { accountPlan: "PRO", accountStatus: "active" },
        },
      ],
      ["organization", {}],
      ["enterprise", { flags: { isEnterpriseWorkspace: true } }],
      ["platform admin", { platform: { isPlatformAdmin: true } }],
    ];
    for (const [name, over] of contexts) {
      const dialog = await openWizard(over);
      assertLabelAuthority(dialog, `${name} / step 1`);
      await clickNext();
      await chooseChannel("EMAIL");
      assertLabelAuthority(dialog, `${name} / step 2`);
      await clickNext();
      assertLabelAuthority(dialog, `${name} / step 3`);
    }
  });

  it("keeps label, helper, required, placeholder and error visibly distinct", async () => {
    await openWizard();
    await clickNext();
    await chooseChannel("SMS");

    const field = (
      document.querySelector("[data-intake-link-phone]") as HTMLElement
    ).closest(".ilk-field") as HTMLElement;

    // 1. The label — canonical authority, and its required marker is a CHILD
    //    of the label rather than a competing tier of its own.
    const label = field.querySelector("label") as HTMLElement;
    expect(label.className).toBe("app-field-label");
    const required = label.querySelector(".ilk-required") as HTMLElement;
    expect(required.textContent).toBe("(required)");

    // 2. The helper — its own element, below the control, never the label.
    const help = field.querySelector(".app-field-help") as HTMLElement;
    expect(help).toBeTruthy();
    expect(help.tagName).toBe("P");
    expect(help.contains(label)).toBe(false);

    // 3. The placeholder — an attribute on the control, never the label. It
    //    disappears the moment anything is typed, which is why a label may
    //    never be delegated to it.
    const input = document.querySelector(
      "[data-intake-link-phone]",
    ) as HTMLInputElement;
    expect(input.getAttribute("placeholder")).toBe("+14155550123");
    expect(input.value).toBe("");
    expect(label.textContent).not.toContain("+14155550123");

    // 4. The error — a fourth element, announced, and it displaces neither the
    //    label nor the helper.
    await clickNext();
    const error = field.querySelector(".ilk-error") as HTMLElement;
    expect(error).toBeTruthy();
    expect(error.getAttribute("role")).toBe("alert");
    expect(field.querySelector("label")).toBeTruthy();
    expect(field.querySelector(".app-field-help")).toBeTruthy();

    // Four tiers, four distinct classes — the hierarchy is structural.
    expect(
      new Set([
        label.className,
        required.className,
        help.className,
        error.className,
      ]).size,
    ).toBe(4);
  });
});
