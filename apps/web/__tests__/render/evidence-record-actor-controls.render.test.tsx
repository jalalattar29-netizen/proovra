/**
 * RECORD DETAIL — controls follow the caller's role and the canonical lifecycle.
 *
 * B5A-F-03 (A2-14)  A VIEWER was offered Lock, Archive, Move to trash, Edit name
 *                   and Restore; a MEMBER Archive and Move to trash. Every one
 *                   failed with the server's concealed "not found".
 * B5A-F-04          The header and the trash banner read timestamps, not the
 *                   projection: a locked or held record offered Archive (409),
 *                   and a destroyed tombstone (deletedAt kept) said "This record
 *                   is in trash" with a Restore the server refuses.
 *
 * The real components run inside the real platform-context provider; the
 * caller's role in the record's workspace comes from the envelope, the same
 * role matrix (`roleHasPermission`) the server enforces.
 */
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";

vi.mock("../../lib/api", () => ({
  apiFetch: vi.fn(async () => ({})),
  setActiveWorkspaceId: () => {},
  setApiToken: () => {},
}));
vi.mock("../../components/ui/ConfirmActionModal", () => ({ useConfirmAction: () => ({ confirm: vi.fn() }) }));

import {
  EvidenceHeroIconActions,
  EvidenceTrashBanner,
} from "../../app/(app)/evidence/[id]/_tabs/_lib";
import { PlatformContextProvider } from "../../lib/platform-context";
import {
  AUTHORITY_SCHEMA_VERSION,
  CAPABILITY_SCHEMA_VERSION,
  NAVIGATION_SCHEMA_VERSION,
} from "../../lib/platform-context/types";
import { resolveRecordActorCapabilities } from "../../lib/evidence/record-actor-capabilities";

const WS = "ws-paid";

function envelope(role: "OWNER" | "ADMIN" | "MEMBER" | "VIEWER") {
  return {
    authoritySchemaVersion: AUTHORITY_SCHEMA_VERSION,
    capabilitySchemaVersion: CAPABILITY_SCHEMA_VERSION,
    navigationSchemaVersion: NAVIGATION_SCHEMA_VERSION,
    workspace: {
      id: WS,
      name: "Paid workspace",
      status: "active",
      scope: "TEAM",
      membership: { role, isOwner: role === "OWNER", isAdmin: role === "ADMIN", memberCount: 3 },
    },
    activeSpace: { type: "ORGANIZATION", id: WS, displayName: "Paid workspace", roleLabel: role },
    capabilities: {},
    account: { accountPlan: "FREE", accountStatus: "active" },
    contextOptions: {
      personalSpace: null,
      ownedWorkspaces: [],
      organizations: [],
      activeContext: { workspaceId: WS, kind: "ORGANIZATION", organizationId: null, displayName: "Paid" },
    },
    diagnostics: { requestId: "t" },
  };
}

function lifecycle(over: Record<string, unknown> = {}) {
  return {
    productState: "ACTIVE",
    canArchive: true,
    canUnarchive: false,
    canTrash: true,
    canRestoreFromTrash: false,
    canRestoreFromArchive: false,
    trashBlockReason: null,
    archiveBlockReason: null,
    trashGraceUntilUtc: null,
    appRetentionUntilUtc: null,
    objectLockRetainUntilUtc: null,
    effectiveRetentionUntilUtc: null,
    objectLockCompliance: false,
    legalHold: false,
    legalHoldState: "NONE",
    destructionEligibleAtUtc: null,
    destructionBlockReason: null,
    ...over,
  };
}

const heroProps = {
  lockedAt: null,
  archivedAt: null,
  deleted: false,
  shareUrl: null,
  isIntegrityFailed: false,
  titles: { share: "", lock: "", unlock: "", archive: "", restore: "" },
  onUnlock: () => {},
  onLock: () => {},
  onRestoreArchived: () => {},
  onArchive: () => {},
  onMoveToTrash: () => {},
  trashDisabled: false,
  trashReason: null,
  onEditLabel: () => {},
};

function renderHero(
  role: "OWNER" | "ADMIN" | "MEMBER" | "VIEWER",
  record: Record<string, unknown>,
  over: Record<string, unknown> = {},
) {
  return render(
    <PlatformContextProvider testEnvelope={envelope(role) as never}>
      <EvidenceHeroIconActions {...heroProps} {...over} record={record as never} />
    </PlatformContextProvider>,
  );
}

const action = (name: string) => document.querySelector(`[data-evidence-action='${name}']`) as HTMLButtonElement | null;

afterEach(() => cleanup());

describe("B5A-F-03 — A2-14: the header offers only what the caller may do", () => {
  const record = { teamId: WS, lifecycle: lifecycle() };

  it("a VIEWER sees no Lock, Archive, Move to trash or Edit name", () => {
    renderHero("VIEWER", record);
    expect(action("lock-record")).toBeNull();
    expect(action("archive-evidence")).toBeNull();
    expect(action("header-trash")).toBeNull();
    expect(action("edit-label")).toBeNull();
    // The verification link stays: it is a read.
    expect(action("open-verification-link")).not.toBeNull();
  });

  it("a VIEWER sees no Unlock or Restore either", () => {
    renderHero("VIEWER", { teamId: WS, lifecycle: lifecycle({ productState: "ARCHIVED", canArchive: false, canUnarchive: true }) }, { lockedAt: "2026-01-01T00:00:00Z", archivedAt: "2026-01-01T00:00:00Z" });
    expect(action("unlock-record")).toBeNull();
    expect(action("restore-archived")).toBeNull();
  });

  it("a MEMBER keeps Lock and Edit name but sees no Archive or Move to trash", () => {
    renderHero("MEMBER", record);
    expect(action("lock-record")).not.toBeNull();
    expect(action("edit-label")).not.toBeNull();
    expect(action("archive-evidence")).toBeNull();
    expect(action("header-trash")).toBeNull();
  });

  it("an OWNER is unchanged", () => {
    renderHero("OWNER", record);
    for (const a of ["lock-record", "archive-evidence", "header-trash", "edit-label"]) {
      expect(action(a)).not.toBeNull();
    }
  });

  it("a personal record (no workspace) keeps every control for its owner", () => {
    renderHero("VIEWER", { teamId: null, lifecycle: lifecycle() });
    expect(action("archive-evidence")).not.toBeNull();
    expect(action("edit-label")).not.toBeNull();
  });

  it("a server-projected actorCapabilities wins over the derivation", () => {
    const caps = resolveRecordActorCapabilities({
      envelope: envelope("OWNER") as never,
      recordTeamId: WS,
      server: { updateMetadata: true, archive: false, delete: false, restoreFromTrash: false },
    });
    expect(caps).toMatchObject({ canEditMetadata: true, canArchive: false, canTrash: false, source: "server" });
  });
});

describe("B5A-F-04 — header actions and the banner read the canonical projection", () => {
  it("a held record offers no live Archive", () => {
    renderHero("OWNER", {
      teamId: WS,
      lifecycle: lifecycle({ canArchive: false, canTrash: false, legalHold: true, archiveBlockReason: "LEGAL_HOLD_ACTIVE" }),
    });
    expect(action("archive-evidence")!.disabled).toBe(true);
    expect(action("archive-evidence")!.title).toMatch(/legal hold/i);
  });

  it("a locked record offers no live Archive", () => {
    renderHero(
      "OWNER",
      { teamId: WS, lifecycle: lifecycle({ canArchive: false, canTrash: false, archiveBlockReason: "EVIDENCE_LOCKED" }) },
      { lockedAt: "2026-01-01T00:00:00Z" },
    );
    expect(action("archive-evidence")!.disabled).toBe(true);
  });

  it("a destroyed tombstone (deletedAt kept) shows no trash banner and no Lock", () => {
    render(
      <PlatformContextProvider testEnvelope={envelope("OWNER") as never}>
        <EvidenceTrashBanner
          record={{ teamId: WS, deletedAt: "2026-01-01T00:00:00Z", lifecycle: lifecycle({ productState: "DESTROYED", canArchive: false, canTrash: false }) as never }}
          busy={false}
          onRestore={() => {}}
        />
        <EvidenceHeroIconActions
          {...heroProps}
          record={{ teamId: WS, lifecycle: lifecycle({ productState: "DESTROYED", canArchive: false, canTrash: false }) } as never}
        />
      </PlatformContextProvider>,
    );
    expect(document.querySelector("[data-evidence-trash-banner]")).toBeNull();
    expect(action("lock-record")!.disabled).toBe(true);
  });

  it("a trashed record shows the banner; Restore only for a caller who may restore", () => {
    const trashed = { teamId: WS, deletedAt: "2026-01-01T00:00:00Z", lifecycle: lifecycle({ productState: "TRASHED", canArchive: false, canTrash: false, canRestoreFromTrash: true }) };
    const view = render(
      <PlatformContextProvider testEnvelope={envelope("OWNER") as never}>
        <EvidenceTrashBanner record={trashed as never} busy={false} onRestore={() => {}} />
      </PlatformContextProvider>,
    );
    expect(document.querySelector("[data-evidence-trash-banner]")).not.toBeNull();
    expect(document.querySelector("[data-evidence-trash-restore]")).not.toBeNull();
    view.unmount();
    render(
      <PlatformContextProvider testEnvelope={envelope("VIEWER") as never}>
        <EvidenceTrashBanner record={trashed as never} busy={false} onRestore={() => {}} />
      </PlatformContextProvider>,
    );
    expect(document.querySelector("[data-evidence-trash-banner]")).not.toBeNull();
    expect(document.querySelector("[data-evidence-trash-restore]")).toBeNull();
  });
});
