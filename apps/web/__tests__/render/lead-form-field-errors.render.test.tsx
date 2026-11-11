/**
 * AUD-0059 — the lead forms' field errors were only visual.
 *
 * After an empty submit every required field turned red, but no control had
 * aria-invalid or an aria-describedby naming its error, focus stayed on the
 * submit button, and the only announcement was the "Please fix the
 * highlighted fields." toast. A screen-reader user heard that something was
 * wrong and could not find what.
 *
 * Now: each invalid control (text input, textarea, listbox trigger) carries
 * aria-invalid="true" and an aria-describedby that names its visible
 * `.input-error` text; a failed submit moves focus to the first invalid
 * control. The success path is unchanged: a valid submit still opens the
 * in-place success dialog.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ContactSalesForm } from "../../components/contact-sales-form";
import { RequestDemoForm } from "../../components/request-demo-form";
import { ToastProvider } from "../../components/ui";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function renderForm(form: "demo" | "sales") {
  return render(
    <ToastProvider>{form === "demo" ? <RequestDemoForm /> : <ContactSalesForm />}</ToastProvider>,
  );
}

const SUBMIT = { demo: "Submit demo request", sales: "Contact sales" } as const;

// [accessible name, expected error text] for every field an empty submit fails.
const DEMO_INVALID: ReadonlyArray<[string, string]> = [
  ["Full name", "Full name is required."],
  ["Work email", ""],
  ["Primary interest", "Select a primary interest."],
  ["Organization type", "Select an organization type."],
  ["Primary use case", "Please provide a bit more detail."],
];
const SALES_INVALID: ReadonlyArray<[string, string]> = [
  ["Full name", "Full name is required."],
  ["Work email", ""],
  ["Organization", "Organization is required."],
  ["Primary topic", "Select a primary topic."],
  ["What stage are you in?", "Select your current stage."],
  ["Current challenge", "Please describe your challenge in a bit more detail."],
];
const DEMO_VALID_OPTIONAL = ["Organization", "Job title", "Country", "Team size", "Additional context"];
const SALES_VALID_OPTIONAL = ["Job title", "Country", "Team size", "Estimated users"];

function submit(form: "demo" | "sales") {
  act(() => {
    fireEvent.click(screen.getByRole("button", { name: SUBMIT[form] }));
  });
}

/** The text of the elements an aria-describedby names, joined. */
function describedText(el: HTMLElement): string {
  return (el.getAttribute("aria-describedby") ?? "")
    .split(/\s+/)
    .filter(Boolean)
    .map((id) => {
      const target = document.getElementById(id);
      expect(target, `aria-describedby id "${id}" resolves`).toBeTruthy();
      return target?.textContent ?? "";
    })
    .join(" ");
}

describe("AUD-0059: an empty submit announces each field's error", () => {
  it.each([
    ["demo", DEMO_INVALID, DEMO_VALID_OPTIONAL],
    ["sales", SALES_INVALID, SALES_VALID_OPTIONAL],
  ] as const)("%s form", (form, invalid, optional) => {
    renderForm(form);
    // Negative control: nothing is invalid before a submit.
    for (const [name] of invalid) {
      expect(screen.getByLabelText(name, { exact: true }).getAttribute("aria-invalid"), name).toBeNull();
    }

    submit(form);

    for (const [name, message] of invalid) {
      const control = screen.getByLabelText(name, { exact: true });
      expect(control.getAttribute("aria-invalid"), name).toBe("true");
      const text = describedText(control);
      expect(text, name).not.toBe("");
      if (message) expect(text, name).toContain(message);
      // the description IS the visible error line
      const errorEl = document.getElementById(
        (control.getAttribute("aria-describedby") ?? "").split(/\s+/).pop() ?? "",
      );
      expect(errorEl?.classList.contains("input-error"), name).toBe(true);
    }
    // Optional fields that passed validation are not marked invalid.
    for (const name of optional) {
      const control = screen.getByLabelText(name, { exact: true });
      expect(control.getAttribute("aria-invalid"), name).toBeNull();
      expect(control.getAttribute("aria-describedby"), name).toBeNull();
    }
  });
});

describe("AUD-0059: a failed submit moves focus to the first invalid field", () => {
  it.each(["demo", "sales"] as const)("%s form", (form) => {
    renderForm(form);
    const button = screen.getByRole("button", { name: SUBMIT[form] });
    button.focus();
    submit(form);
    expect(document.activeElement).toBe(screen.getByLabelText("Full name", { exact: true }));

    // Fix the first field: the next failed submit lands on the next invalid one.
    act(() => {
      fireEvent.change(screen.getByLabelText("Full name", { exact: true }), {
        target: { value: "Jane Doe" },
      });
    });
    button.focus();
    submit(form);
    expect(screen.getByLabelText("Full name", { exact: true }).getAttribute("aria-invalid")).toBeNull();
    expect(document.activeElement).toBe(screen.getByLabelText("Work email", { exact: true }));
  });

  it("the first invalid field can be a listbox trigger", () => {
    renderForm("demo");
    const fill = (name: string, value: string) =>
      act(() => {
        fireEvent.change(screen.getByLabelText(name, { exact: true }), { target: { value } });
      });
    fill("Full name", "Jane Doe");
    fill("Work email", "jane@company.com");
    submit("demo");
    const trigger = screen.getByRole("combobox", { name: "Primary interest" });
    expect(trigger.getAttribute("aria-invalid")).toBe("true");
    expect(document.activeElement).toBe(trigger);
    // focusing the trigger does not open its list
    expect(screen.queryByRole("listbox")).toBeNull();
  });
});

describe("AUD-0059: the success path is unchanged", () => {
  function choose(name: string) {
    const trigger = screen.getByRole("combobox", { name });
    act(() => {
      fireEvent.click(trigger);
    });
    const list = screen.getByRole("listbox", { name });
    act(() => {
      fireEvent.keyDown(list, { key: "Enter" });
    });
  }
  function fill(name: string, value: string) {
    act(() => {
      fireEvent.change(screen.getByLabelText(name, { exact: true }), { target: { value } });
    });
  }

  it.each(["demo", "sales"] as const)("%s form: a valid submit opens the in-place success dialog", async (form) => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    renderForm(form);
    fill("Full name", "Jane Doe");
    fill("Work email", "jane@company.com");
    if (form === "demo") {
      choose("Primary interest");
      choose("Organization type");
      fill("Primary use case", "Claims review across several regional teams.");
    } else {
      fill("Organization", "Acme");
      choose("Primary topic");
      choose("What stage are you in?");
      fill("Current challenge", "Evidence intake from external parties is slow.");
    }
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: SUBMIT[form] }));
    });
    await waitFor(() => expect(screen.getByRole("dialog")).toBeTruthy());
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(document.querySelectorAll('[aria-invalid="true"]').length).toBe(0);
  });
});
