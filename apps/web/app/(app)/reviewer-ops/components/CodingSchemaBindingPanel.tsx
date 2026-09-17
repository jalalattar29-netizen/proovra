"use client";

/**
 * Batch J — bind a published coding schema to a review.
 *
 *   GET  /v1/reviewer/work/:workflowId/coding?teamId=       schemaBinding (reread)
 *   GET  /v1/coding/schemas?teamId=&status=PUBLISHED        the choices
 *   POST /v1/reviewer/work/:workflowId/bind-schema?teamId=  { schemaId }  (review.assign)
 *     409 SCHEMA_NOT_FOUND | WORKFLOW_NOT_FOUND, 403 NOT_PERMITTED
 *
 * Coding fields only appear in the Reviewer Workspace once a review is bound
 * to a schema, and nothing in the product bound one, so the coding feature
 * was unreachable. Whether the caller may bind comes from the server's
 * reviewer projection (capabilities), never from a role string. Success is
 * announced only after the binding is reread from the server.
 *
 * Schema authoring and publishing are deliberately out of scope here.
 */

import Link from "next/link";
import { useCallback, useEffect, useId, useRef, useState } from "react";

import type { ReviewerCapability } from "@proovra/shared";

import { apiFetch } from "../../../../lib/api";
import { toSafeUserError } from "../../../../lib/feedback/toSafeUserError";
import { fetchReviewerWorkspace } from "../../../../lib/reviewer-workspace/reviewer-api";
import { Button } from "../../../../components/ui/Button";
import { Card } from "../../../../components/ui/Card";
import { useConfirmAction } from "../../../../components/ui/ConfirmActionModal";

export type SchemaBinding = {
  id: string;
  label: string;
  version: number;
  status: string;
} | null;

type Load<T> =
  | { kind: "loading" }
  | { kind: "ready"; value: T }
  | { kind: "denied" }
  | { kind: "failed"; message: string };

type PublishedSchema = { id: string; label: string; version: number };

function statusOf(err: unknown): number {
  const s = (err as { statusCode?: unknown } | null)?.statusCode;
  return typeof s === "number" ? s : 0;
}
function codeOf(err: unknown): string {
  const c = (err as { code?: unknown } | null)?.code;
  return typeof c === "string" ? c : "";
}

export function CodingSchemaBindingPanel({
  teamId,
  workflowId,
}: {
  teamId: string;
  workflowId: string;
}) {
  // Keyed so a workspace or review switch drops every pending response.
  return <BindingWorkspace key={`${teamId}:${workflowId}`} teamId={teamId} workflowId={workflowId} />;
}

function BindingWorkspace({ teamId, workflowId }: { teamId: string; workflowId: string }) {
  const { confirm } = useConfirmAction();
  const formId = useId();
  const q = `teamId=${encodeURIComponent(teamId)}`;
  const codingUrl = `/v1/reviewer/work/${encodeURIComponent(workflowId)}/coding?${q}`;
  const [binding, setBinding] = useState<Load<SchemaBinding>>({ kind: "loading" });
  const [caps, setCaps] = useState<ReadonlyArray<ReviewerCapability> | "loading" | "failed">("loading");
  const [open, setOpen] = useState(false);
  const [choices, setChoices] = useState<Load<PublishedSchema[]>>({ kind: "loading" });
  const [selected, setSelected] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [failure, setFailure] = useState("");
  const alive = useRef(true);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const selectRef = useRef<HTMLSelectElement>(null);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const readBinding = useCallback(async (): Promise<SchemaBinding | undefined> => {
    try {
      const res = await apiFetch(codingUrl, { method: "GET" });
      const value = (res?.schemaBinding ?? null) as SchemaBinding;
      if (alive.current) setBinding({ kind: "ready", value });
      return value;
    } catch (err) {
      if (alive.current) {
        const status = statusOf(err);
        setBinding(
          status === 403 || status === 404
            ? { kind: "denied" }
            : {
                kind: "failed",
                message: toSafeUserError(err, {
                  message: "The coding schema for this review could not be loaded.",
                }).message,
              },
        );
      }
      return undefined;
    }
  }, [codingUrl]);

  useEffect(() => {
    void readBinding();
    fetchReviewerWorkspace(teamId)
      .then((ws) => {
        if (alive.current) setCaps(ws ? ws.capabilities : "failed");
      })
      .catch(() => {
        if (alive.current) setCaps("failed");
      });
  }, [readBinding, teamId]);

  useEffect(() => {
    if (!open) return;
    let current = true;
    setChoices({ kind: "loading" });
    apiFetch(`/v1/coding/schemas?${q}&status=PUBLISHED`, { method: "GET" })
      .then((res: { schemas?: PublishedSchema[] } | null) => {
        if (!current || !alive.current) return;
        setChoices({ kind: "ready", value: Array.isArray(res?.schemas) ? res.schemas : [] });
      })
      .catch((err: unknown) => {
        if (!current || !alive.current) return;
        setChoices(
          statusOf(err) === 403
            ? { kind: "denied" }
            : {
                kind: "failed",
                message: toSafeUserError(err, {
                  message: "Published schemas could not be loaded. Try again.",
                }).message,
              },
        );
      });
    return () => {
      current = false;
    };
  }, [open, q]);

  useEffect(() => {
    if (open && choices.kind === "ready") selectRef.current?.focus();
  }, [open, choices.kind]);

  const canBind = Array.isArray(caps) && caps.includes("review.assign");
  const permissionReason =
    caps === "loading"
      ? "Checking your reviewer permissions…"
      : caps === "failed"
        ? "Your reviewer permissions could not be loaded. Refresh the page to try again."
        : !canBind
          ? "Only reviewers who can assign reviews can change the coding schema."
          : undefined;
  const current = binding.kind === "ready" ? binding.value : null;
  const toggleReason =
    permissionReason ??
    (binding.kind !== "ready" ? "Load the current coding schema first." : undefined);
  const submitReason = busy
    ? undefined
    : choices.kind !== "ready"
      ? "Load the published schemas first."
      : !selected
        ? "Choose a published schema."
        : current?.id === selected
          ? "This review already uses that schema."
          : permissionReason;

  function close() {
    setOpen(false);
    setSelected("");
    toggleRef.current?.focus();
  }

  async function bind() {
    if (busy || submitReason || choices.kind !== "ready") return;
    const schema = choices.value.find((s) => s.id === selected);
    if (!schema) return;
    setBusy(true);
    setNotice("");
    setFailure("");
    try {
      const ok = await confirm({
        title: current ? "Change this review's coding schema?" : "Bind a coding schema to this review?",
        description: current
          ? `Reviewers will code against "${schema.label}" instead of "${current.label}". The fields they see change; values already coded are kept.`
          : `Reviewers will see the coding fields of "${schema.label}" for this review.`,
        confirmLabel: current ? "Change schema" : "Bind schema",
        tone: current ? "warning" : "neutral",
      });
      if (!ok || !alive.current) return;
      try {
        await apiFetch(
          `/v1/reviewer/work/${encodeURIComponent(workflowId)}/bind-schema?${q}`,
          { method: "POST", body: JSON.stringify({ schemaId: schema.id }) },
        );
      } catch (err) {
        if (!alive.current) return;
        const code = codeOf(err);
        const status = statusOf(err);
        setFailure(
          code === "SCHEMA_NOT_FOUND"
            ? "That schema is no longer published in this workspace. Choose another."
            : code === "WORKFLOW_NOT_FOUND"
              ? "This review no longer exists in this workspace."
              : status === 403
                ? "Only reviewers who can assign reviews can change the coding schema."
                : toSafeUserError(err, {
                    message: "The coding schema could not be bound. Nothing was changed.",
                  }).message,
        );
        return;
      }
      const reread = await readBinding();
      if (!alive.current) return;
      if (reread?.id === schema.id) {
        setNotice(`Coding schema set to "${reread.label}". Reviewers now see its coding fields.`);
        setOpen(false);
        setSelected("");
        toggleRef.current?.focus();
      } else {
        setFailure(
          reread === undefined
            ? "The schema was sent, but this review could not be reloaded to confirm it. Refresh before continuing."
            : "The schema was sent, but this review does not show it yet. Refresh before continuing.",
        );
      }
    } finally {
      if (alive.current) setBusy(false);
    }
  }

  return (
    <Card padding="comfortable">
      <section aria-labelledby={`${formId}-title`} data-coding-schema-binding style={{ minWidth: 0, overflowWrap: "anywhere" }}>
        <h3 id={`${formId}-title`} className="app-panel__title">Coding schema</h3>
        {binding.kind === "loading" ? <p role="status">Loading the coding schema…</p> : null}
        {binding.kind === "denied" ? (
          <p role="alert">This review&apos;s coding schema is not available to you in this workspace.</p>
        ) : null}
        {binding.kind === "failed" ? <p role="alert">{binding.message}</p> : null}
        {binding.kind === "ready" ? (
          <p data-coding-schema-current>
            {current
              ? `${current.label} (version ${current.version})`
              : "No coding schema is bound, so reviewers see no coding fields for this review."}
          </p>
        ) : null}
        <Button
          ref={toggleRef}
          size="sm"
          aria-expanded={open}
          aria-controls={`${formId}-form`}
          disabled={Boolean(toggleReason) || busy}
          disabledReason={toggleReason}
          onClick={() => (open ? close() : setOpen(true))}
          data-coding-schema-binding-toggle
        >
          {current ? "Change coding schema" : "Choose coding schema"}
        </Button>
        {open ? (
          <form
            id={`${formId}-form`}
            aria-busy={busy}
            onSubmit={(e) => {
              e.preventDefault();
              void bind();
            }}
            style={{ display: "grid", gap: 8, marginTop: 8, minWidth: 0 }}
          >
            {choices.kind === "loading" ? <p role="status">Loading published schemas…</p> : null}
            {choices.kind === "denied" ? (
              <p role="alert">You do not have access to this workspace&apos;s coding schemas.</p>
            ) : null}
            {choices.kind === "failed" ? <p role="alert">{choices.message}</p> : null}
            {choices.kind === "ready" && choices.value.length === 0 ? (
              <p>
                No schema is published in this workspace yet. Install the defaults on{" "}
                <Link href="/review/schemas">Coding schemas</Link>.
              </p>
            ) : null}
            {choices.kind === "ready" && choices.value.length > 0 ? (
              <>
                <label htmlFor={`${formId}-schema`}>Published schema</label>
                <select
                  id={`${formId}-schema`}
                  ref={selectRef}
                  value={selected}
                  disabled={busy}
                  onChange={(e) => setSelected(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Escape") close();
                  }}
                  style={{ maxWidth: "100%" }}
                >
                  <option value="">Choose a schema…</option>
                  {choices.value.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.label} (version {s.version})
                    </option>
                  ))}
                </select>
              </>
            ) : null}
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <Button
                type="submit"
                size="sm"
                variant="primary"
                loading={busy}
                disabled={Boolean(submitReason)}
                disabledReason={submitReason}
                data-coding-schema-binding-submit
              >
                Bind schema
              </Button>
              <Button size="sm" onClick={close} disabled={busy}>
                Cancel
              </Button>
            </div>
          </form>
        ) : null}
        {notice ? <p role="status">{notice}</p> : null}
        {failure ? <p role="alert">{failure}</p> : null}
      </section>
    </Card>
  );
}
