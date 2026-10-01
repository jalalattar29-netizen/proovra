import { describe, it, expect, vi } from "vitest";
import { render as rtlRender, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";

/**
 * UC-ARCH-007 (web half) — no PROOVRA client registers capture devices or
 * submits platform attestation yet (no client calls POST /v1/capture/devices).
 * The Security Center section must say so, keep the list empty without
 * implying a missing registration, and never claim device-signed or attested
 * capture.
 */
vi.mock("../../lib/api", () => ({ apiFetch: async () => ({ devices: [] }), ApiError: class extends Error {} }));
vi.mock("../../lib/sentry", () => ({ captureException: () => {} }));

import { ConfirmActionProvider } from "../../components/ui/ConfirmActionModal";
import { CaptureDevicesSection } from "../../app/(app)/security-center/components/CaptureDevicesSection";

const render = (ui: ReactElement) => rtlRender(<ConfirmActionProvider>{ui}</ConfirmActionProvider>);

describe("CaptureDevicesSection copy", () => {
  it("states that no PROOVRA client registers capture devices or submits attestation yet", async () => {
    const { container } = render(<CaptureDevicesSection teamId="team-1" />);
    await waitFor(() => expect(container.textContent).toMatch(/No capture devices registered/));
    const text = container.textContent ?? "";
    expect(text).toMatch(/No PROOVRA app or extension registers capture devices or submits platform attestation yet/);
    expect(text).not.toMatch(/sign evidence at the moment of capture/i);
    expect(text).not.toMatch(/at-source signatures/i);
    expect(text).not.toMatch(/registered through the mobile capture flow/i);
    expect(text).not.toMatch(/device-signed|attested capture/i);
  });
});
