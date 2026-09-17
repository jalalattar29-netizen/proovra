/**
 * D63 — a destruction request refusal reads as a decision about that request,
 * not as "Could not load this section".
 *
 * apiFetch surfaces a `{ denial }` body as an error whose `details` carry the
 * denial (loose shape) — the lifecycle pages then resolve it here.
 */
import React from "react";
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";

import {
  DenialBanner,
  resolveLifecycleError,
} from "../../app/(app)/evidence-lifecycle/_shared";

const loose = (statusCode: number, denial: string) =>
  Object.assign(new Error(`HTTP ${statusCode}`), { statusCode, code: denial, details: { denial } });

describe("lifecycle action refusals (D63)", () => {
  it.each([
    [404, "DESTRUCTION_REQUEST_NOT_FOUND", "That destruction request no longer exists"],
    [409, "DESTRUCTION_REQUEST_NOT_APPROVED", "Not approved yet"],
    [409, "DESTRUCTION_BLOCKED_BY_LEGAL_HOLD", "Blocked by a legal hold"],
    [409, "DESTRUCTION_REQUEST_NOT_EXECUTED", "Not executed yet"],
  ])("%i %s renders its own words, never the code", (status, denial, title) => {
    const resolved = resolveLifecycleError(loose(status, denial));
    expect(resolved).toMatchObject({ denial: "ACTION_REFUSED", title });
    render(<DenialBanner denial={resolved!} />);
    expect(screen.getByRole("alert").textContent).toContain(title);
    expect(screen.getByRole("alert").textContent).not.toContain(denial);
  });

  it("an unknown 409 denial still falls back to the generic state", () => {
    expect(resolveLifecycleError(loose(409, "SOMETHING_ELSE"))).toMatchObject({ denial: "UNKNOWN_ERROR" });
  });
});
