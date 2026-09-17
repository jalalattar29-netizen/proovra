"use client";

/**
 * PHASE 13 — owned-workspace ownership transfer.
 *
 *   POST /v1/teams/:id/transfer-ownership
 *   (services/api/src/routes/teams.routes.ts:3111)
 *
 * The ORGANIZATION-level analogue has been wired since lifecycle Phase 6;
 * the WORKSPACE-level one — a different resource, with its own kind matrix
 * and its own membership legs — had no surface at all, so an owned
 * workspace could never change hands from the product.
 *
 * Contract:
 *
 *   body   { newOwnerUserId: uuid, stepUp?: { method, currentPassword, code } }
 *   200    { transfer: { teamId, fromUserId, toUserId } }
 *   401    STEP_UP_REQUIRED / STEP_UP_INVALID (account step-up)
 *   403    owner_required | NOT_WORKSPACE_OWNER
 *   404    TEAM_NOT_FOUND
 *   409    PERSONAL_WORKSPACE_NOT_TRANSFERABLE |
 *          ORG_WORKSPACE_OWNERSHIP_IS_ORG_GOVERNED | WORKSPACE_KIND_UNKNOWN |
 *          TRANSFER_TARGET_IS_OWNER | TRANSFER_TARGET_NOT_ACTIVE_MEMBER
 *
 * Ownership moves billing with it, so the control requires an explicit
 * confirmation step before the request leaves, and step-up on top of that.
 *
 * D46 — WHO CAN BE CHOSEN. The target list used to be built from the members
 * embedded in `GET /v1/teams/:id`, which is a bounded FIRST PAGE of 50, so on
 * a larger workspace everyone after the fiftieth could never be offered. The
 * picker now reads
 *
 *   GET /v1/teams/:id/members?eligible=ownership_transfer&q&cursor&limit
 *
 * — the server applies the transfer command's own eligibility (ACTIVE, not the
 * owner), runs the search, and pages with a cursor, so every eligible member
 * is reachable.
 */

import { useCallback, useEffect, useRef, useState } from "react";

import { Button } from "../../../../../components/ui/Button";
import { apiFetch } from "../../../../../lib/api";
import { toSafeUserError } from "../../../../../lib/feedback/toSafeUserError";
import {
  StepUpVerify,
  extractStepUp,
  type StepUpMethods,
  type StepUpProof,
} from "../../../security-center/components/PersonalSecuritySections";

export type TransferCandidate = { userId: string; label: string };

type EligibleMember = {
  userId: string;
  label?: string | null;
  user?: { displayName?: string | null; email?: string | null } | null;
};

type EligiblePage = {
  members?: EligibleMember[];
  nextCursor?: string | null;
  total?: number;
};

type CandidateList =
  | { kind: "loading" }
  | { kind: "ready"; rows: TransferCandidate[]; nextCursor: string | null; total: number }
  | { kind: "failed"; message: string };

const CANDIDATE_PAGE_SIZE = 50;
const CANDIDATE_SEARCH_DEBOUNCE_MS = 300;

function candidateOf(member: EligibleMember): TransferCandidate {
  return {
    userId: member.userId,
    label:
      member.user?.displayName?.trim() ||
      member.user?.email ||
      member.label ||
      "Workspace member",
  };
}

/**
 * The step-up denial body is `{ error: { code, methods, message } }`. The
 * canonical client keeps `code` but not `methods`, so `extractStepUp` is
 * tried first and a code-based read is the fallback. The server's own
 * wording distinguishes the reauth-only account (no password, no factor)
 * from an account that can prove itself in place; that distinction is read
 * from the code path, never rendered.
 */
function readStepUp(
  err: unknown,
): { methods: StepUpMethods; message: string } | null {
  const viaBody = extractStepUp(err);
  if (viaBody) return viaBody;
  const e = err as { code?: string; statusCode?: number };
  if (e.code !== "STEP_UP_REQUIRED" && e.code !== "STEP_UP_INVALID") return null;
  return {
    methods: ["password", "mfa"],
    message:
      e.code === "STEP_UP_INVALID"
        ? "That didn't verify. Try again."
        : "",
  };
}

function denialCopy(err: unknown): string {
  const e = err as { statusCode?: number };
  const status = typeof e.statusCode === "number" ? e.statusCode : 0;
  if (status === 403) {
    return "You don't have permission to transfer this workspace. Only its owner can.";
  }
  if (status === 404) {
    return "This workspace no longer exists.";
  }
  if (status === 409) {
    return "Ownership couldn't be transferred: a personal space can't change owners, an organization workspace is governed at the organization level, and the new owner must already be an active member of this workspace.";
  }
  if (status === 429) {
    return "Too many verification attempts. Wait a minute and try again.";
  }
  return toSafeUserError(err, {
    message: "Could not transfer ownership. Nothing was changed.",
  }).message;
}

export function WorkspaceOwnershipTransferCard({
  teamId,
  teamName,
  currentUserId,
  onTransferred,
}: {
  teamId: string;
  teamName: string;
  /**
   * The signed-in owner. The server already leaves the owner out of the
   * eligible list; this is excluded as well so the caller is never offered to
   * themselves while the page's identity and the team row disagree.
   */
  currentUserId?: string | null;
  /**
   * Called after a successful transfer, WITH the outcome sentence.
   *
   * The parent is expected to render it somewhere that survives this card
   * unmounting — which it will, because a transfer demotes the actor out of
   * the ownership the card is gated on. See NEW-049.
   */
  onTransferred: (notice: string) => void | Promise<void>;
}) {
  const [targetUserId, setTargetUserId] = useState("");
  // The chosen member's label is held on its own: a later search replaces the
  // loaded rows, and the confirmation must still name the person chosen.
  const [targetLabel, setTargetLabel] = useState("");
  const [searchInput, setSearchInput] = useState("");
  const [query, setQuery] = useState("");
  const [list, setList] = useState<CandidateList>({ kind: "loading" });
  const [loadingMore, setLoadingMore] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  // The picker (and its search box) stays mounted once a first page arrived,
  // so clearing a search does not blank the control under the cursor.
  const [hasLoaded, setHasLoaded] = useState(false);
  const listSeqRef = useRef(0);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [stepUpOpen, setStepUpOpen] = useState(false);
  const [stepUpMethods, setStepUpMethods] = useState<StepUpMethods>(["reauth"]);
  const [stepUpMsg, setStepUpMsg] = useState("");

  // Stale-response protection.
  const mountedRef = useRef(true);
  const seqRef = useRef(0);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Debounce the search box; the SERVER runs the search.
  useEffect(() => {
    const handle = setTimeout(
      () => setQuery(searchInput.trim()),
      CANDIDATE_SEARCH_DEBOUNCE_MS,
    );
    return () => clearTimeout(handle);
  }, [searchInput]);

  const candidatesUrl = useCallback(
    (cursor: string | null) => {
      const params = new URLSearchParams({
        eligible: "ownership_transfer",
        limit: String(CANDIDATE_PAGE_SIZE),
      });
      if (query) params.set("q", query);
      if (cursor) params.set("cursor", cursor);
      return `/v1/teams/${encodeURIComponent(teamId)}/members?${params.toString()}`;
    },
    [teamId, query],
  );

  const toRows = useCallback(
    (page: EligiblePage | null | undefined) =>
      (page?.members ?? [])
        .filter((m) => m.userId && m.userId !== currentUserId)
        .map(candidateOf),
    [currentUserId],
  );

  useEffect(() => {
    const mine = ++listSeqRef.current;
    setList({ kind: "loading" });
    void (async () => {
      try {
        const page = (await apiFetch(candidatesUrl(null))) as EligiblePage;
        if (!mountedRef.current || mine !== listSeqRef.current) return;
        const rows = toRows(page);
        setHasLoaded(true);
        setList({
          kind: "ready",
          rows,
          nextCursor: page?.nextCursor ?? null,
          total: typeof page?.total === "number" ? page.total : rows.length,
        });
      } catch (err) {
        if (!mountedRef.current || mine !== listSeqRef.current) return;
        setList({
          kind: "failed",
          message: toSafeUserError(err, {
            message: "The members who can take ownership could not be loaded.",
          }).message,
        });
      }
    })();
  }, [candidatesUrl, toRows, reloadKey]);

  const loadMoreCandidates = async () => {
    if (list.kind !== "ready" || !list.nextCursor || loadingMore) return;
    const mine = listSeqRef.current;
    setLoadingMore(true);
    try {
      const page = (await apiFetch(candidatesUrl(list.nextCursor))) as EligiblePage;
      if (!mountedRef.current || mine !== listSeqRef.current) return;
      setList((prev) =>
        prev.kind === "ready"
          ? {
              kind: "ready",
              rows: [...prev.rows, ...toRows(page)],
              nextCursor: page?.nextCursor ?? null,
              total: typeof page?.total === "number" ? page.total : prev.total,
            }
          : prev,
      );
    } catch (err) {
      if (!mountedRef.current || mine !== listSeqRef.current) return;
      setError(
        toSafeUserError(err, {
          message: "More members could not be loaded. Try again.",
        }).message,
      );
    } finally {
      if (mountedRef.current) setLoadingMore(false);
    }
  };

  const candidates: TransferCandidate[] = list.kind === "ready" ? list.rows : [];
  // Keep the chosen member selectable after a search that no longer lists them.
  const options: TransferCandidate[] =
    targetUserId && !candidates.some((c) => c.userId === targetUserId)
      ? [{ userId: targetUserId, label: targetLabel || "Selected member" }, ...candidates]
      : candidates;
  const nobodyEligible =
    list.kind === "ready" && list.total === 0 && query === "" && !targetUserId;

  const transfer = useCallback(
    async (proof?: StepUpProof) => {
      if (!targetUserId) {
        setValidationError("Choose the member who should own this workspace.");
        return;
      }
      setValidationError(null);
      setError(null);
      setNotice(null);
      setBusy(true);
      const seq = ++seqRef.current;

      try {
        await apiFetch(`/v1/teams/${teamId}/transfer-ownership`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            newOwnerUserId: targetUserId,
            ...(proof ? { stepUp: proof } : {}),
          }),
        });
        if (!mountedRef.current || seq !== seqRef.current) return;
        const label = targetLabel || "the new owner";
        setStepUpOpen(false);
        setConfirming(false);
        setTargetUserId("");
        setTargetLabel("");
        const outcome = `${label} now owns ${teamName}. Billing ownership moved with it; you remain a member.`;
        setNotice(outcome);
        /**
         * PHASE 13 (NEW-049) — the outcome is handed UPWARDS, not just shown.
         *
         * A successful transfer demotes the actor from OWNER to ADMIN, so the
         * refresh this triggers returns `canManageWorkspace: false` and the
         * page unmounts THIS ENTIRE CARD — including the live region that has
         * just been given something to say. The announcement therefore existed
         * for roughly one refresh, which is not an announcement.
         *
         * The parent keeps the message in a region that outlives the card,
         * because the outcome belongs to the page: it is the last thing this
         * component knows, and by design it is about to stop existing.
         */
        await onTransferred(outcome);
      } catch (err) {
        if (!mountedRef.current || seq !== seqRef.current) return;
        const su = readStepUp(err);
        if (su) {
          setStepUpOpen(true);
          setStepUpMethods(su.methods);
          setStepUpMsg(su.message);
          return;
        }
        setError(denialCopy(err));
      } finally {
        if (mountedRef.current && seq === seqRef.current) setBusy(false);
      }
    },
    [targetUserId, targetLabel, teamId, teamName, onTransferred],
  );

  /**
   * On the canonical `.app-panel` anatomy since the People redesign
   * (2026-09-07), which deleted the page-local stylesheet that defined
   * `.team-card` and the wrapper class its rules were scoped under. This card
   * renders inside that page, so those classes stopped resolving to anything.
   * Presentation only — every `data-*` hook and every branch is unchanged.
   */
  return (
    <div
      className="app-panel"
      data-workspace-ownership-transfer-card
      aria-busy={busy}
    >
      <div className="app-panel__head">
        <h3 className="app-panel__title">Transfer ownership</h3>
      </div>
      <div className="app-panel__body">
        <p className="app-table__muted" style={{ margin: "0 0 4px" }}>
          Hand this workspace to another active member. They become the owner
          and the billing owner; you stay a member. Evidence, cases and audit
          history are unaffected.
        </p>

      {list.kind === "loading" && !hasLoaded ? (
        <p
          data-state="candidates-loading"
          role="status"
          style={{ color: "#6a777b", fontSize: 13, marginTop: 10 }}
        >
          Loading the members who can take ownership…
        </p>
      ) : list.kind === "failed" ? (
        <div data-state="candidates-failed" role="alert" style={{ marginTop: 10, fontSize: 13, color: "#8f1d16" }}>
          <span>{list.message}</span>{" "}
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={busy}
            onClick={() => setReloadKey((k) => k + 1)}
            data-action="retry-workspace-transfer-candidates"
          >
            Try again
          </Button>
        </div>
      ) : nobodyEligible ? (
        <p
          data-state="no-candidates"
          style={{ color: "#6a777b", fontSize: 13, marginTop: 10 }}
        >
          Invite another member first — ownership can only move to someone who
          is already an active member of this workspace.
        </p>
      ) : (
        <div style={{ marginTop: 10 }}>
          <label
            htmlFor="workspace-transfer-search"
            style={{ display: "block", fontSize: 12.5, fontWeight: 600, color: "#475569" }}
          >
            Find a member
          </label>
          <input
            id="workspace-transfer-search"
            type="search"
            className="app-search-input"
            placeholder="Search by name or email"
            value={searchInput}
            disabled={busy}
            onChange={(e) => setSearchInput(e.target.value)}
            data-control="workspace-transfer-search"
            style={{ marginTop: 4, marginBottom: 8, minWidth: 240 }}
          />
          <label
            htmlFor="workspace-transfer-target"
            style={{ display: "block", fontSize: 12.5, fontWeight: 600, color: "#475569" }}
          >
            New owner
          </label>
          <select
            id="workspace-transfer-target"
            value={targetUserId}
            disabled={busy}
            aria-invalid={validationError ? true : undefined}
            onChange={(e) => {
              const next = e.target.value;
              setTargetUserId(next);
              setTargetLabel(
                options.find((c) => c.userId === next)?.label ?? "",
              );
              setConfirming(false);
              if (validationError) setValidationError(null);
            }}
            data-control="workspace-transfer-target"
            style={{
              marginTop: 4,
              fontSize: 13,
              padding: "6px 10px",
              borderRadius: 8,
              border: "1px solid rgba(15,23,42,0.15)",
              minWidth: 240,
            }}
          >
            <option value="">Select the new owner…</option>
            {options.map((c) => (
              <option key={c.userId} value={c.userId}>
                {c.label}
              </option>
            ))}
          </select>

          <p
            data-state="candidates-count"
            style={{ margin: "6px 0 0", fontSize: 12, color: "#6a777b" }}
          >
            {list.kind === "loading"
              ? "Searching…"
              : list.kind === "ready" && list.total === 0
                ? "No active member matches that search."
                : list.kind === "ready"
                  ? `Showing ${list.rows.length} of ${list.total} ${query ? "matching " : ""}member${list.total === 1 ? "" : "s"} who can take ownership`
                  : ""}
          </p>
          {list.kind === "ready" && list.nextCursor ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              loading={loadingMore}
              disabled={busy || loadingMore}
              onClick={() => void loadMoreCandidates()}
              data-action="workspace-transfer-load-more"
            >
              Show more members
            </Button>
          ) : null}

          {validationError ? (
            <p data-state="invalid" style={{ margin: "6px 0 0", fontSize: 12, color: "#991b1b" }}>
              {validationError}
            </p>
          ) : null}

          {!confirming ? (
            <div style={{ marginTop: 10 }}>
              <Button
                type="button"
                variant="secondary"
                size="sm"
                disabled={busy || !targetUserId}
                onClick={() => {
                  setError(null);
                  setNotice(null);
                  setConfirming(true);
                }}
                data-action="open-workspace-transfer-ownership"
              >
                Transfer ownership…
              </Button>
            </div>
          ) : (
            <div
              data-workspace-transfer-confirm
              style={{
                marginTop: 10,
                padding: "10px 12px",
                borderRadius: 10,
                border: "1px solid rgba(15,23,42,0.14)",
                maxWidth: 460,
              }}
            >
              <p style={{ margin: 0, fontSize: 12.5, color: "#475569" }}>
                Transfer <strong>{teamName}</strong> to{" "}
                <strong>
                  {targetLabel || "the selected member"}
                </strong>
                ? They gain owner-only controls, including closing this
                workspace, and billing ownership moves with them. You can only
                get it back if they transfer it to you.
              </p>
              <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
                <Button
                  type="button"
                  variant="destructive"
                  size="sm"
                  loading={busy}
                  disabled={busy || !targetUserId}
                  onClick={() => void transfer()}
                  data-action="transfer-workspace-ownership"
                >
                  Confirm transfer
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={busy}
                  onClick={() => setConfirming(false)}
                  data-action="cancel-workspace-transfer-ownership"
                >
                  Keep ownership
                </Button>
              </div>
            </div>
          )}
        </div>
      )}

      {stepUpOpen ? (
        <StepUpVerify
          title="Confirm transferring this workspace."
          methods={stepUpMethods}
          initialError={stepUpMsg}
          busy={busy}
          onSubmit={(proof) => void transfer(proof)}
          onCancel={() => {
            setStepUpOpen(false);
            setStepUpMsg("");
          }}
        />
      ) : null}

      <div
        role="status"
        aria-live="polite"
        data-workspace-transfer-status
        style={{ marginTop: 10, fontSize: 12, color: error ? "#8f1d16" : "#6a777b" }}
      >
        {busy ? "Transferring ownership…" : error ? error : notice ? notice : ""}
      </div>
      </div>
    </div>
  );
}

export default WorkspaceOwnershipTransferCard;
