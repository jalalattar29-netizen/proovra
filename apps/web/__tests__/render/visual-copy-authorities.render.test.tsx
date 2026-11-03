/**
 * The authorities behind the second visual repair: stored identifiers read as
 * words, every option list goes through AppListbox, and the two public pages
 * that kept the retired dark wash use the sign-in treatment.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { identifierLabel, identifierTextLabel } from "@proovra/shared";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import * as React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AppListbox } from "../../components/app-primitives/AppListbox";
import { FilterBar } from "../../components/ui/FilterBar";
import { sourceTraceLabel } from "../../lib/labels/workspaceOpsLabels";
import { chooseListbox, listboxLabels } from "./_listbox";

afterEach(cleanup);

const WEB_ROOT = join(__dirname, "..", "..");

describe("identifierTextLabel: sentences the server composed around identifiers", () => {
  it("reads the graph labels stored by earlier builds", () => {
    expect(identifierTextLabel("Review workflow — NOT_STARTED (NORMAL)")).toBe(
      "Review workflow — Not started (normal)",
    );
    expect(identifierTextLabel("Incident — IDENTITY_SECURITY (WARNING/OPEN)")).toBe(
      "Incident — Identity security (warning, open)",
    );
    expect(identifierTextLabel("Evidence record has a workspace review task (APPROVED_INTERNAL).")).toBe(
      "Evidence record has a workspace review task (approved internal).",
    );
  });

  it("leaves ordinary text and acronyms alone", () => {
    expect(identifierTextLabel("MV Aurora hull claim")).toBe("MV Aurora hull claim");
    expect(identifierTextLabel("Report v1")).toBe("Report v1");
    expect(identifierTextLabel("OCR text from a PROOVRA package")).toBe("OCR text from a PROOVRA package");
    expect(identifierTextLabel("hull-damage.png")).toBe("hull-damage.png");
  });

  it("keeps acronyms inside a label", () => {
    expect(identifierLabel("AWS_REKOGNITION_FACES")).toBe("AWS rekognition faces");
    expect(identifierLabel("OCR_DOCUMENT")).toBe("OCR document");
  });
});

describe("sourceTraceLabel: provenance without code", () => {
  it("turns models, fields and filters into words", () => {
    expect(sourceTraceLabel("EvidenceReviewWorkflow(status=QUEUED)")).toBe("Evidence review workflow (queued)");
    expect(sourceTraceLabel("Evidence.verificationStatus")).toBe("Evidence verification status");
    expect(sourceTraceLabel("Evidence (verificationStatus + report/package relations)")).toBe(
      "Evidence (verification status, report/package relations)",
    );
  });

  it("drops internal phase names", () => {
    expect(sourceTraceLabel("AccessAnomaly (Phase 32.8C++++ — persisted classifier output)")).toBe("Access anomaly");
    expect(sourceTraceLabel("CaseComment(resolvedAtUtc IS NULL — Phase 32.8C+++++)")).toBe("Case comment");
  });
});

function productTsx(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name !== "node_modules") productTsx(full, out);
    } else if (name.endsWith(".tsx")) {
      out.push(full);
    }
  }
  return out;
}

describe("one select control", () => {
  it("no product file renders a native select", () => {
    const offenders = [...productTsx(join(WEB_ROOT, "app")), ...productTsx(join(WEB_ROOT, "components"))].filter(
      (file) => /^\s*<select\b/m.test(readFileSync(file, "utf8")),
    );
    expect(offenders).toEqual([]);
  });

  it("carries the label, description, disabled state and data hooks of the select it replaced", () => {
    const onChange = vi.fn();
    render(
      <>
        <label htmlFor="scope">Scope</label>
        <AppListbox
          id="scope"
          value="a"
          options={[
            { value: "a", label: "All" },
            { value: "b", label: "Bounded" },
          ]}
          onChange={onChange}
          triggerProps={{ "data-hook": "yes", "aria-describedby": "scope-hint" }}
        />
      </>,
    );
    const trigger = screen.getByLabelText("Scope");
    expect(trigger.getAttribute("role")).toBe("combobox");
    expect(trigger.getAttribute("data-hook")).toBe("yes");
    expect(trigger.getAttribute("aria-describedby")).toBe("scope-hint");
    chooseListbox(trigger, "b");
    expect(onChange).toHaveBeenCalledWith("b");
  });

  it("hands its trigger to a caller that manages focus, and keeps the caller's key handler", () => {
    const ref = React.createRef<HTMLButtonElement>();
    const onKeyDown = vi.fn();
    render(
      <AppListbox
        ariaLabel="Schema"
        value={null}
        options={[{ value: "a", label: "A" }]}
        onChange={() => undefined}
        triggerRef={ref}
        triggerProps={{ onKeyDown }}
      />,
    );
    expect(ref.current).toBe(screen.getByRole("combobox", { name: "Schema" }));
    fireEvent.keyDown(ref.current!, { key: "Escape" });
    expect(onKeyDown).toHaveBeenCalledTimes(1);
  });

  it("FilterBar.Select keeps its visible name and its data hook", () => {
    const onChange = vi.fn();
    render(
      <FilterBar.Select
        label="Status"
        value=""
        onChange={onChange}
        options={[
          { value: "", label: "All" },
          { value: "OPEN", label: "Open" },
        ]}
        data-filter="status"
      />,
    );
    const trigger = screen.getByLabelText("Status");
    expect(trigger.getAttribute("data-filter")).toBe("status");
    expect(listboxLabels(trigger)).toEqual(["All", "Open"]);
    chooseListbox(trigger, "OPEN");
    expect(onChange).toHaveBeenCalledWith("OPEN");
  });
});

describe("the retired dark wash", () => {
  it.each(["app/share/[id]/page.tsx", "app/auth/callback/ui/page.tsx"])("%s uses the sign-in surface", (file) => {
    const source = readFileSync(join(WEB_ROOT, file), "utf8");
    expect(source).not.toContain("rgba(8,18,22");
    expect(source).not.toContain("site-velvet-bg");
    expect(source).toContain("/assets/hero/register-logo...png");
  });

  it("the callback says what happened in words", () => {
    const source = readFileSync(join(WEB_ROOT, "app/auth/callback/ui/page.tsx"), "utf8");
    expect(source).not.toContain("Missing OAuth token");
  });
});
