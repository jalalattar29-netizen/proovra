"use client";

/**
 * PHASE 13 — create an owned workspace.
 *
 *   POST /v1/teams   (services/api/src/routes/teams.routes.ts:374)
 *
 * Three surfaces told people to "switch or create a workspace" and linked
 * to this page, where no create control existed. There is no
 * POST /v1/orgs/:id/workspaces alternative — this route is the only way an
 * account creates a workspace it owns.
 *
 * Contract:
 *
 *   body   { name: string(1..120) }
 *   201    the created Team row ({ id, name, … })
 *   409    { message, code: "SHARED_WORKSPACE_LIMIT_REACHED",
 *            details: { plan, maxOwnedTeams, ownedTeamCount } }
 *   400    zod rejection of the name
 *
 * On success the platform envelope is refreshed rather than the local list
 * being patched: the envelope is the authority for which spaces exist.
 */

import { useCallback, useEffect, useRef, useState } from "react";

import { apiFetch } from "../../lib/api";
import { toSafeUserError } from "../../lib/feedback/toSafeUserError";
import { usePlatformContext } from "../../lib/platform-context";

const MAX_NAME = 120;

type CreatedTeam = { id?: string; name?: string | null };

export function CreateWorkspaceCard() {
  const platformCtx = usePlatformContext();
  const refresh = platformCtx.refresh;

  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Stale-response protection.
  const mountedRef = useRef(true);
  const seqRef = useRef(0);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const submit = useCallback(async () => {
    const trimmed = name.trim();
    if (trimmed.length === 0) {
      setValidationError("Give the workspace a name.");
      return;
    }
    if (trimmed.length > MAX_NAME) {
      setValidationError(`Keep the name under ${MAX_NAME} characters.`);
      return;
    }
    setValidationError(null);
    setError(null);
    setNotice(null);
    setBusy(true);
    const seq = ++seqRef.current;

    try {
      const created = (await apiFetch("/v1/teams", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: trimmed }),
      })) as CreatedTeam | null;
      if (!mountedRef.current || seq !== seqRef.current) return;
      setName("");
      setOpen(false);
      setNotice(`Workspace “${created?.name ?? trimmed}” created. You own it.`);
      // The spaces list is server state — re-read it, never patch it locally.
      await refresh();
    } catch (err) {
      if (!mountedRef.current || seq !== seqRef.current) return;
      const e = err as {
        statusCode?: number;
        code?: string;
        details?: Record<string, unknown>;
      };
      const status = typeof e.statusCode === "number" ? e.statusCode : 0;
      if (e.code === "SHARED_WORKSPACE_LIMIT_REACHED") {
        const max = e.details?.["maxOwnedTeams"];
        setError(
          typeof max === "number"
            ? `Your plan includes ${max} owned workspace${max === 1 ? "" : "s"}. Upgrade, or close a workspace you no longer need, to create another.`
            : "Your plan's workspace limit is reached. Upgrade, or close a workspace you no longer need, to create another.",
        );
      } else if (status === 403) {
        setError(
          "You don't have permission to create a workspace on this account.",
        );
      } else if (status === 400) {
        setError("That name wasn't accepted. Use 1 to 120 characters.");
      } else {
        setError(
          toSafeUserError(err, {
            message: "Could not create the workspace. Nothing was created.",
          }).message,
        );
      }
    } finally {
      if (mountedRef.current && seq === seqRef.current) setBusy(false);
    }
  }, [name, refresh]);

  return (
    <div
      data-create-workspace-card
      aria-busy={busy}
      style={{ display: "flex", flexDirection: "column", gap: 8 }}
    >
      {!open ? (
        <div>
          <button
            type="button"
            className="cc-quick-action"
            data-workspace-action="create_workspace"
            data-action="open-create-workspace"
            onClick={() => {
              setError(null);
              setNotice(null);
              setValidationError(null);
              setOpen(true);
            }}
          >
            Create a workspace
          </button>
        </div>
      ) : (
        <form
          data-create-workspace-form
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
          style={{ display: "flex", gap: 8, alignItems: "flex-end", flexWrap: "wrap" }}
        >
          <label
            htmlFor="create-workspace-name"
            style={{ fontSize: 12.5, fontWeight: 600, color: "#475569" }}
          >
            Workspace name
            <input
              id="create-workspace-name"
              type="text"
              value={name}
              maxLength={MAX_NAME}
              autoComplete="off"
              disabled={busy}
              aria-invalid={validationError ? true : undefined}
              onChange={(e) => {
                setName(e.target.value);
                if (validationError) setValidationError(null);
              }}
              data-testid="create-workspace-name"
              style={{
                display: "block",
                marginTop: 4,
                minWidth: 260,
                minHeight: 34,
                padding: "0 10px",
                fontSize: 13,
                borderRadius: 8,
                border: "1px solid rgba(15,23,42,0.15)",
              }}
            />
          </label>
          <button
            type="submit"
            className="cc-quick-action"
            disabled={busy || name.trim().length === 0}
            aria-busy={busy || undefined}
            data-action="create-workspace"
            data-testid="create-workspace-submit"
          >
            {busy ? "Creating…" : "Create workspace"}
          </button>
          <button
            type="button"
            className="cc-quick-action"
            disabled={busy}
            data-action="cancel-create-workspace"
            onClick={() => {
              setOpen(false);
              setName("");
              setValidationError(null);
            }}
          >
            Cancel
          </button>
        </form>
      )}

      {validationError ? (
        <p
          data-state="invalid"
          style={{ margin: 0, fontSize: 12, color: "#991b1b" }}
        >
          {validationError}
        </p>
      ) : null}

      <div
        role="status"
        aria-live="polite"
        data-create-workspace-status
        style={{ fontSize: 12, color: error ? "#991b1b" : "#475569" }}
      >
        {busy ? "Creating workspace…" : error ? error : notice ? notice : ""}
      </div>
    </div>
  );
}

export default CreateWorkspaceCard;
