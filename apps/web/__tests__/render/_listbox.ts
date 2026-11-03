import { fireEvent } from "@testing-library/react";
import { flushSync } from "react-dom";

function options(): Element[] {
  return Array.from(document.querySelectorAll('[role="option"]'));
}

/** Click and flush at once, so this also works inside a test's own act(). */
function click(element: Element): void {
  flushSync(() => {
    fireEvent.click(element);
  });
}

/**
 * Choose a value in an AppListbox the way a person does: open it, then click
 * the option. The popup is portaled, so the option is found in the document.
 */
export function chooseListbox(trigger: Element | null, value: string): void {
  if (!trigger) throw new Error("listbox trigger not found");
  click(trigger);
  const option = options().find((o) => o.getAttribute("data-value") === value);
  if (!option) throw new Error(`listbox has no option for ${value}`);
  click(option);
}

function readOptions<T>(trigger: Element, read: (option: Element) => T): T[] {
  click(trigger);
  const out = options().map(read);
  click(trigger);
  return out;
}

/** The labels an AppListbox offers. Opens it, reads, closes it. */
export function listboxLabels(trigger: Element): string[] {
  return readOptions(trigger, (o) => o.querySelector(".app-listbox__option-label")?.textContent ?? "");
}

/** The stored values an AppListbox offers. Opens it, reads, closes it. */
export function listboxValues(trigger: Element): string[] {
  return readOptions(trigger, (o) => o.getAttribute("data-value") ?? "");
}
