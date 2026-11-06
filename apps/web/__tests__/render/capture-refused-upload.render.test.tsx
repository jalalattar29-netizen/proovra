/**
 * PRO-078 (UI-07) — the capture page reads a refused upload truthfully.
 *
 * POST /v1/evidence/:id/parts answers 415 { message, code:
 * "FILE_VALIDATION_BLOCKED", reservationReleased } (the API releases an empty
 * record's reservation at once). Read through the REAL apiFetch: the capture
 * hook must see the release, so its next Finish starts a new record instead
 * of resuming into a released one, and the person is told what happened in
 * product copy, not "File validation blocked".
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { apiFetch } from "../../lib/api";
import { toSafeUserError } from "../../lib/feedback/toSafeUserError";
import { refusedUploadReleasedReservation } from "../../app/(app)/capture/_hooks/capture-refusal";

function answer(status: number, body: unknown) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })),
  );
}

async function refusal(body: unknown, status = 415): Promise<unknown> {
  answer(status, body);
  try {
    await apiFetch("/v1/evidence/11111111-1111-4111-8111-111111111111/parts", { method: "POST", body: "{}" });
  } catch (err) {
    return err;
  }
  throw new Error("expected a refusal");
}

afterEach(() => vi.unstubAllGlobals());

describe("PRO-078: a refused upload on the capture page", () => {
  it("sees the released reservation and explains the refusal in product copy", async () => {
    const err = await refusal({ message: "File validation blocked", code: "FILE_VALIDATION_BLOCKED", reservationReleased: true });
    expect(refusedUploadReleasedReservation(err)).toBe(true);
    const safe = toSafeUserError(err);
    expect(safe.message).not.toMatch(/File validation blocked/);
    expect(safe.message).toMatch(/does not record this kind of file/);
  });

  it("control: a refusal that kept the record (another file is in it) keeps the reservation", async () => {
    const err = await refusal({ message: "File validation blocked", code: "FILE_VALIDATION_BLOCKED", reservationReleased: false });
    expect(refusedUploadReleasedReservation(err)).toBe(false);
  });

  it("control: any other failure keeps the reservation", async () => {
    const err = await refusal({ message: "Too many upload requests. Try again later.", code: "RATE_LIMITED" }, 429);
    expect(refusedUploadReleasedReservation(err)).toBe(false);
  });
});
