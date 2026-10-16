/**
 * THE Evidence page's verification link is the record's CANONICAL page.
 *
 * Production (2026-10-17): the hero read the historical publication summary
 * (`PUBLISHED` + `sharePath`, a record-id link inside its grace) while every
 * other surface had moved to the canonical `pvr_` page — and for records
 * outside that grace it had nothing to open. One resolver now decides it for
 * every owner surface: the canonical contract when the API sends it; only an
 * API that predates the contract falls back to the published link.
 */
import React from "react";
import { describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";

vi.mock("../../lib/api", () => ({ apiFetch: vi.fn(async () => ({})) }));
vi.mock("../../components/ui/ConfirmActionModal", () => ({ useConfirmAction: () => ({ confirm: vi.fn() }) }));

import {
  EvidenceHeroIconActions,
  resolveCanonicalVerificationLink,
} from "../../app/(app)/evidence/[id]/_tabs/_lib";

const REF = "pvr_AbCdEfGhIjKlMnOpQrStUvWxYz0";
const published = {
  state: "PUBLISHED",
  sharePath: "/verify/11111111-1111-4111-8111-111111111111",
} as never;
const unpublished = { state: "CONFIGURED_NOT_PUBLISHED", sharePath: null } as never;

const canonical = (over: Record<string, unknown> = {}) =>
  ({ status: "AVAILABLE", reference: REF, verifyPath: `/verify/${REF}`, issuedAtUtc: null, refusalReason: null, ...over }) as never;

describe("resolveCanonicalVerificationLink — one source for every owner surface", () => {
  it("an AVAILABLE canonical reference is THE link — independent of publication", () => {
    for (const summary of [published, unpublished]) {
      const r = resolveCanonicalVerificationLink({ publicVerificationSummary: summary, canonicalVerification: canonical() });
      expect(r.url).toMatch(new RegExp(`/verify/${REF}$`));
      expect(r.reason).toBeNull();
    }
  });

  it("REGRESSION: a historical PUBLISHED record-id link never stands in for a canonical link the API says is not available", () => {
    const r = resolveCanonicalVerificationLink({
      publicVerificationSummary: published,
      canonicalVerification: canonical({ status: "NOT_ISSUED", reference: null, verifyPath: null }),
    });
    expect(r.url).toBeNull();
    expect(r.reason).toMatch(/issued when the record is finalized/);
  });

  it("states why when there is no page to open", () => {
    const cases: Array<[Record<string, unknown>, RegExp]> = [
      [{ status: "WITHDRAWN" }, /withdrawn/],
      [{ status: "TEMPORARILY_UNAVAILABLE" }, /temporarily unavailable/],
      [{ status: "RETAINED" }, /retained/],
      [{ status: "NOT_ISSUED", reference: null, verifyPath: null, refusalReason: "DELETED" }, /deleted record/],
      [{ status: "NOT_ISSUED", reference: null, verifyPath: null, refusalReason: "INTEGRITY_FAILED" }, /integrity/],
    ];
    for (const [over, reason] of cases) {
      const r = resolveCanonicalVerificationLink({ publicVerificationSummary: published, canonicalVerification: canonical(over) });
      expect(r.url).toBeNull();
      expect(r.reason).toMatch(reason);
    }
  });

  it("only an API without the contract falls back to the published link", () => {
    const r = resolveCanonicalVerificationLink({ publicVerificationSummary: published });
    expect(r.url).toMatch(/\/verify\/11111111-1111-4111-8111-111111111111$/);
    expect(resolveCanonicalVerificationLink({ publicVerificationSummary: unpublished }).url).toBeNull();
  });
});

describe("the hero 'Verification link' opens the canonical page", () => {
  const props = {
    lockedAt: null,
    archivedAt: null,
    deleted: false,
    titles: { share: "Open the record's verification page (no login needed)", lock: "", unlock: "", archive: "", restore: "" },
    onUnlock: () => {},
    onLock: () => {},
    onRestoreArchived: () => {},
    onArchive: () => {},
    onMoveToTrash: () => {},
    trashDisabled: false,
    trashReason: null,
    onEditLabel: () => {},
  };

  it("is a real link to the canonical URL, in a new tab, with no opener", () => {
    const url = `https://app.proovra.com/verify/${REF}`;
    const { container } = render(<EvidenceHeroIconActions {...props} shareUrl={url} isIntegrityFailed={false} />);
    const a = container.querySelector('[data-evidence-action="open-verification-link"]') as HTMLAnchorElement;
    expect(a.tagName).toBe("A");
    expect(a.getAttribute("href")).toBe(url);
    expect(a.getAttribute("target")).toBe("_blank");
    expect(a.getAttribute("rel")).toContain("noopener");
    expect(a.textContent).toContain("Verification link");
  });

  it("without a page to open, or with failed integrity, it is a disabled control that says why", () => {
    for (const [shareUrl, isIntegrityFailed] of [[null, false], [`https://app.proovra.com/verify/${REF}`, true]] as const) {
      const { container, unmount } = render(
        <EvidenceHeroIconActions {...props} titles={{ ...props.titles, share: "why" }} shareUrl={shareUrl} isIntegrityFailed={isIntegrityFailed} />,
      );
      const b = container.querySelector('[data-evidence-action="open-verification-link"]') as HTMLButtonElement;
      expect(b.tagName).toBe("BUTTON");
      expect(b.disabled).toBe(true);
      expect(b.getAttribute("title")).toBe("why");
      unmount();
    }
  });
});
