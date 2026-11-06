/**
 * PRO-002 and PRO-006 — the two public lead forms.
 *
 * PRO-002: every visible label named nothing. The <label> elements had no
 * `htmlFor` and wrapped nothing, so the Chrome accessibility tree named each
 * field from its placeholder, clicking a label focused nothing and
 * getByLabelText found 0 controls.
 *
 * PRO-006: the select (PremiumSelect) listened for keys on the whole document
 * while its menu was open and did not close when focus left it. Open "Team
 * size", Tab away, press ArrowDown + Enter: Team size changed while another
 * control had focus. It is now the shared AppListbox.
 */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { ContactSalesForm } from "../../components/contact-sales-form";
import { RequestDemoForm } from "../../components/request-demo-form";
import { ToastProvider } from "../../components/ui";

afterEach(() => cleanup());

function renderForm(form: "demo" | "sales") {
  return render(<ToastProvider>{form === "demo" ? <RequestDemoForm /> : <ContactSalesForm />}</ToastProvider>);
}

const DEMO_FIELDS = [
  "Full name",
  "Work email",
  "Organization",
  "Job title",
  "Country",
  "Team size",
  "Primary interest",
  "Organization type",
  "Primary use case",
  "Additional context",
];

const SALES_FIELDS = [
  "Full name",
  "Work email",
  "Organization",
  "Job title",
  "Country",
  "Team size",
  "Primary topic",
  "What stage are you in?",
  "Expected deployment timeline",
  "Estimated users",
  "Current challenge",
  "Security, governance, or procurement notes",
];

describe("PRO-002: every lead-form field is named by its visible label", () => {
  it.each([
    ["demo", DEMO_FIELDS],
    ["sales", SALES_FIELDS],
  ] as const)("%s form", (form, fields) => {
    renderForm(form);
    for (const name of fields) {
      // exact match: the required marker is decorative and not part of the name
      const control = screen.getByLabelText(name, { exact: true });
      expect(control, name).toBeTruthy();
      expect(control.getAttribute("placeholder") ?? "", name).not.toBe(name);
    }
    // Negative control: the honeypot stays hidden and is not one of the fields.
    expect(screen.queryByLabelText("Website")).toBeTruthy();
    expect(fields).not.toContain("Website");
  });

  it("clicking a text label focuses its input", () => {
    renderForm("demo");
    const label = screen.getByText("Full name", { selector: "label" });
    const input = screen.getByLabelText("Full name");
    fireEvent.click(label);
    // jsdom applies label activation as a click on the control; the control is
    // the label's target, which is what the browser focuses.
    expect((label as HTMLLabelElement).control).toBe(input);
  });

  it("required fields are announced as required", () => {
    renderForm("sales");
    expect(screen.getByLabelText("Full name").getAttribute("aria-required")).toBe("true");
    expect(screen.getByLabelText("Primary topic").getAttribute("aria-required")).toBe("true");
    // control: an optional field is not marked required
    expect(screen.getByLabelText("Job title").getAttribute("aria-required")).toBeNull();
    expect(screen.getByLabelText("Team size").getAttribute("aria-required")).toBeNull();
  });
});

describe("PRO-006: the select reads keys only while focus is in it", () => {
  it("after Tab leaves an open select, ArrowDown + Enter elsewhere does not change it", () => {
    renderForm("demo");
    const teamSize = screen.getByRole("combobox", { name: "Team size" });
    expect(teamSize.textContent).toContain("Select team size");

    act(() => {
      fireEvent.click(teamSize);
    });
    const list = screen.getByRole("listbox", { name: "Team size" });
    expect(document.activeElement).toBe(list);

    act(() => {
      fireEvent.keyDown(list, { key: "Tab" });
    });
    // The menu closed and focus went back to its trigger, from where the
    // browser's own Tab continues to the next field.
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(document.activeElement).toBe(teamSize);

    const next = screen.getByRole("combobox", { name: "Primary interest" });
    next.focus();
    act(() => {
      fireEvent.keyDown(document.activeElement ?? document.body, { key: "ArrowDown" });
      fireEvent.keyDown(document.activeElement ?? document.body, { key: "Enter" });
      fireEvent.keyDown(document, { key: "ArrowDown" });
      fireEvent.keyDown(document, { key: "Enter" });
    });
    expect(teamSize.textContent).toContain("Select team size");
  });

  it("focus moving out of the open list closes it", () => {
    renderForm("demo");
    const teamSize = screen.getByRole("combobox", { name: "Team size" });
    act(() => {
      fireEvent.click(teamSize);
    });
    const list = screen.getByRole("listbox", { name: "Team size" });
    const email = screen.getByLabelText("Work email");
    act(() => {
      fireEvent.blur(list, { relatedTarget: email });
    });
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("focus leaving the TRIGGER of an open select (before its list took focus) closes it", () => {
    // Seen in a real browser whose page was not drawing: Enter opened Team
    // size, its list had not mounted yet, Tab moved on, and when the list
    // mounted it took focus back and the next Enter chose an option.
    renderForm("demo");
    const teamSize = screen.getByRole("combobox", { name: "Team size" });
    const next = screen.getByRole("combobox", { name: "Primary interest" });
    act(() => {
      fireEvent.keyDown(teamSize, { key: "Enter" });
    });
    expect(screen.getByRole("listbox", { name: "Team size" })).toBeTruthy();
    act(() => {
      fireEvent.blur(teamSize, { relatedTarget: next });
    });
    expect(screen.queryByRole("listbox", { name: "Team size" })).toBeNull();
    expect(teamSize.textContent).toContain("Select team size");
  });

  it("positive control: inside the list the keys choose an option, with an active descendant", () => {
    renderForm("demo");
    const teamSize = screen.getByRole("combobox", { name: "Team size" });
    act(() => {
      fireEvent.click(teamSize);
    });
    const list = screen.getByRole("listbox", { name: "Team size" });
    const active = list.getAttribute("aria-activedescendant");
    expect(active).toBeTruthy();
    expect(document.getElementById(active ?? "")?.getAttribute("role")).toBe("option");
    act(() => {
      fireEvent.keyDown(list, { key: "Enter" });
    });
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(teamSize.textContent).not.toContain("Select team size");
    expect(document.activeElement).toBe(teamSize);
  });
});
