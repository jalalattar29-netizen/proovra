"use client";

/**
 * BATCH J — automation webhook DESTINATIONS (docs/product/PHASE_E3_2_WEBHOOK_DELIVERY.md §9).
 *
 * A rule's "internal webhook delivery" action targets an already-registered
 * destination, and before this panel nothing in the product could register,
 * edit, enable, disable or re-key one. Routes (services/api/src/routes/
 * automation-webhooks.routes.ts):
 *
 *   GET   /v1/automation/webhooks?teamId=            list (never a secret)
 *   POST  /v1/automation/webhooks                    { teamId, name, url } — returns the signing secret ONCE
 *   PATCH /v1/automation/webhooks/:id                { name?, url? }
 *   POST  /v1/automation/webhooks/:id/enable         resumes deliveries
 *   POST  /v1/automation/webhooks/:id/disable        stops deliveries
 *   POST  /v1/automation/webhooks/:id/rotate-secret  returns the new secret ONCE
 *
 * Every mutation is announced only after the list is reread and shows the
 * change. A signing secret lives only in this component's state until the
 * operator dismisses it; it is never stored, logged or re-fetchable.
 */

import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from "react";

import { apiFetch } from "../../lib/api";
import { formatUserDateTime } from "../../lib/date";
import { toSafeUserError } from "../../lib/feedback/toSafeUserError";
import { Button } from "../ui/Button";
import { useConfirmAction } from "../ui/ConfirmActionModal";

export type AutomationWebhookDestination = {
  id: string;
  teamId: string;
  name: string;
  url: string;
  urlOrigin: string;
  secretFingerprint: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
  disabledAt: string | null;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  failureCount: number;
};

type ListEnvelope = {
  destinations: AutomationWebhookDestination[];
  limits?: { maxDestinationsPerTeam?: number };
};

type ListState =
  | { status: "loading" }
  | { status: "ready"; value: ListEnvelope }
  | { status: "failed"; message: string };

type Secret = { destinationName: string; value: string; rotated: boolean };

const ROOT = "/v1/automation/webhooks";

/** The two delivery switches; `DestinationSwitch` names every route this reaches. */
type DestinationSwitch = "enable" | "disable";

function switchDestination(destinationId: string, action: DestinationSwitch) {
  return apiFetch(`${ROOT}/${encodeURIComponent(destinationId)}/${action}`, {
    method: "POST",
    body: JSON.stringify({}),
  });
}

export const MANAGE_REASON =
  "Only a workspace owner or admin can change webhook destinations.";

/** Why the server refused a destination URL, as operator words. */
const URL_REJECTION: Readonly<Record<string, string>> = {
  invalid_url: "it is not a valid web address",
  non_https_scheme: "it must start with https://",
  credentials_in_url: "it must not contain a user name or password",
  non_default_port: "it must use the standard HTTPS port",
  localhost: "it points at this machine",
  dns_resolution_failed: "its host name could not be resolved",
};

function urlRejectionMessage(reason: unknown): string {
  const why =
    typeof reason === "string" && URL_REJECTION[reason]
      ? URL_REJECTION[reason]
      : "it points at a private or reserved network address";
  return `This URL was rejected: ${why}. Use a public HTTPS address.`;
}

/**
 * The operator sentence for a refused or failed destination mutation. The
 * field-level URL rejection is returned separately so the form can place it
 * beside the URL input.
 */
export function destinationFailure(err: unknown): { field: string | null; message: string } {
  const e = err as {
    statusCode?: number;
    code?: string;
    details?: Record<string, unknown>;
    body?: { error?: { code?: string; reason?: string; details?: { reason?: string } } };
  } | null;
  const code = e?.code ?? e?.body?.error?.code;
  if (code === "url_rejected") {
    const reason = e?.details?.reason ?? e?.body?.error?.reason ?? e?.body?.error?.details?.reason;
    return { field: urlRejectionMessage(reason), message: "Fix the destination URL and try again." };
  }
  if (code === "destination_limit") {
    return { field: null, message: "This workspace has reached its limit of webhook destinations. Remove or reuse one first." };
  }
  if (code === "destination_origin_conflict") {
    return { field: "A destination for this host already exists in this workspace. Edit that one instead.", message: "Fix the destination URL and try again." };
  }
  if (e?.statusCode === 400) {
    return { field: null, message: "The destination was rejected. Check the name (1 to 120 characters) and the URL." };
  }
  if (e?.statusCode === 404) {
    return { field: null, message: "This destination no longer exists in this workspace. Refresh the list." };
  }
  if (e?.statusCode === 403) {
    return { field: null, message: MANAGE_REASON };
  }
  return {
    field: null,
    message: toSafeUserError(err, { message: "The destination could not be changed. Refresh the list and try again." }).message,
  };
}

function listFailure(err: unknown): string {
  const status = (err as { statusCode?: number } | null)?.statusCode;
  if (status === 403 || status === 404) {
    return "You do not have access to this workspace's webhook destinations. This is not an empty list.";
  }
  return `Webhook destinations could not be loaded, so this is not an empty list. ${
    toSafeUserError(err, { message: "Refresh to try again." }).message
  }`;
}

export function AutomationWebhookDestinationsPanel({
  teamId,
  canManage,
  onDestinationsChange,
}: {
  teamId: string;
  canManage: boolean;
  /** The last list the server returned; null while unknown or unreadable. */
  onDestinationsChange?: (destinations: AutomationWebhookDestination[] | null) => void;
}) {
  return (
    <DestinationsWorkspace
      key={teamId}
      teamId={teamId}
      canManage={canManage}
      onDestinationsChange={onDestinationsChange}
    />
  );
}

function DestinationsWorkspace({
  teamId,
  canManage,
  onDestinationsChange,
}: {
  teamId: string;
  canManage: boolean;
  onDestinationsChange?: (destinations: AutomationWebhookDestination[] | null) => void;
}) {
  const { confirm } = useConfirmAction();
  const [list, setList] = useState<ListState>({ status: "loading" });
  const [busyId, setBusyId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [secret, setSecret] = useState<Secret | null>(null);
  const [formMode, setFormMode] = useState<{ kind: "closed" } | { kind: "create" } | { kind: "edit"; id: string }>({ kind: "closed" });
  const alive = useRef(true);
  const changed = useRef(onDestinationsChange);
  changed.current = onDestinationsChange;
  const formId = useId();
  const addButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const listUrl = `${ROOT}?teamId=${encodeURIComponent(teamId)}`;

  /** Reads the list; resolves with it, or null when the read failed. */
  const load = useCallback(async (): Promise<ListEnvelope | null> => {
    try {
      const value = (await apiFetch(listUrl, { method: "GET" })) as ListEnvelope;
      if (!alive.current) return null;
      const safe = { ...value, destinations: Array.isArray(value?.destinations) ? value.destinations : [] };
      setList({ status: "ready", value: safe });
      changed.current?.(safe.destinations);
      return safe;
    } catch (err) {
      if (!alive.current) return null;
      setList({ status: "failed", message: listFailure(err) });
      changed.current?.(null);
      return null;
    }
  }, [listUrl]);

  useEffect(() => {
    setList({ status: "loading" });
    void load();
  }, [load]);

  function begin() {
    setNotice(null);
    setError(null);
  }

  /**
   * Runs one mutation, then rereads and checks `confirmed` against the
   * reread row. The notice is shown only when the check passes.
   */
  async function mutate(
    id: string,
    write: () => Promise<unknown>,
    confirmed: (row: AutomationWebhookDestination | undefined, response: unknown) => boolean,
    success: string,
  ): Promise<{ ok: boolean; response?: unknown; error?: unknown }> {
    setBusyId(id);
    let response: unknown;
    let written = false;
    try {
      response = await write();
      written = true;
      const reread = await load();
      if (!alive.current) return { ok: false };
      if (reread === null) {
        setError("The change was sent, but the destination list could not be reloaded to confirm it. Refresh before relying on it.");
        return { ok: false, response };
      }
      const rowId = id === "new" ? (response as { id?: string } | null)?.id : id;
      const row = reread.destinations.find((d) => d.id === rowId);
      if (!confirmed(row, response)) {
        setError("The change was sent, but the reloaded destination does not show it. Refresh and check again.");
        return { ok: false, response };
      }
      setNotice(success);
      return { ok: true, response };
    } catch (err) {
      if (!alive.current) return { ok: false };
      if (written) {
        setError("The change was sent, but the destination list could not be reloaded to confirm it. Refresh before relying on it.");
        return { ok: false, response };
      }
      return { ok: false, error: err };
    } finally {
      if (alive.current) setBusyId(null);
    }
  }

  async function setEnabled(destination: AutomationWebhookDestination, enabled: boolean) {
    begin();
    const ok = await confirm(
      enabled
        ? {
            title: `Enable "${destination.name}"?`,
            description: `Rules that target this destination will send events to ${destination.urlOrigin} from now on. Events from while it was disabled are not re-sent.`,
            confirmLabel: "Enable destination",
            tone: "warning",
            testId: "automation-webhook-enable",
          }
        : {
            title: `Disable "${destination.name}"?`,
            description: `Nothing more is sent to ${destination.urlOrigin}. Rules that target this destination keep running, but their webhook deliveries will fail until it is enabled again.`,
            confirmLabel: "Disable destination",
            tone: "danger",
            testId: "automation-webhook-disable",
          },
    );
    if (!alive.current || !ok) return;
    const result = await mutate(
      destination.id,
      () => switchDestination(destination.id, enabled ? "enable" : "disable"),
      (row) => row?.enabled === enabled,
      enabled
        ? `"${destination.name}" is enabled and confirmed from the saved record. Deliveries resume from now.`
        : `"${destination.name}" is disabled and confirmed from the saved record. No further events will be sent to it.`,
    );
    if (result.error) setError(destinationFailure(result.error).message);
  }

  async function rotate(destination: AutomationWebhookDestination) {
    begin();
    setSecret(null);
    const ok = await confirm({
      title: `Rotate the signing secret of "${destination.name}"?`,
      description:
        "The current secret stops working immediately: deliveries signed from now on use the new one, and your receiver will reject them until it is updated. The new secret is shown once.",
      confirmLabel: "Rotate secret",
      tone: "danger",
      testId: "automation-webhook-rotate",
    });
    if (!alive.current || !ok) return;
    const result = await mutate(
      destination.id,
      () =>
        apiFetch(`${ROOT}/${encodeURIComponent(destination.id)}/rotate-secret`, {
          method: "POST",
          body: JSON.stringify({}),
        }),
      (row, response) =>
        Boolean(row) &&
        row?.secretFingerprint === (response as { secretFingerprint?: string } | null)?.secretFingerprint &&
        row?.secretFingerprint !== destination.secretFingerprint,
      `The signing secret of "${destination.name}" was rotated and confirmed from the saved record. Copy the new secret below.`,
    );
    const value = (result.response as { revealedSecret?: string } | null)?.revealedSecret;
    // A secret the server did issue is shown even when the reread failed:
    // it cannot be fetched again, and the old one no longer works.
    if (typeof value === "string" && value) {
      setSecret({ destinationName: destination.name, value, rotated: true });
    }
    if (result.error) setError(destinationFailure(result.error).message);
  }

  const destinations = list.status === "ready" ? list.value.destinations : [];
  const max = list.status === "ready" ? list.value.limits?.maxDestinationsPerTeam : undefined;
  const atLimit = typeof max === "number" && destinations.length >= max;
  const addReason = !canManage
    ? MANAGE_REASON
    : list.status !== "ready"
      ? "Load the destination list first."
      : atLimit
        ? `This workspace already has the maximum of ${max} destinations.`
        : busyId !== null
          ? "Wait for the current change to finish."
          : undefined;

  return (
    <section className="apf-section" aria-labelledby={`${formId}-title`} data-automation-webhook-destinations>
      <header className="apf-section-head" style={{ flexWrap: "wrap", gap: 8 }}>
        <h2 className="apf-section-title" id={`${formId}-title`}>Webhook destinations</h2>
        <span className="apf-section-note">
          Where the internal webhook delivery action sends events. A destination starts disabled and receives
          nothing until it is enabled.
        </span>
        <Button
          ref={addButton}
          variant="secondary"
          size="sm"
          aria-expanded={formMode.kind === "create"}
          aria-controls={`${formId}-create`}
          disabled={Boolean(addReason)}
          disabledReason={addReason}
          onClick={() => {
            begin();
            setFormMode((mode) => (mode.kind === "create" ? { kind: "closed" } : { kind: "create" }));
          }}
        >
          Add destination
        </Button>
        <Button variant="ghost" size="sm" onClick={() => { begin(); setList({ status: "loading" }); void load(); }}>
          Refresh destinations
        </Button>
      </header>

      {notice ? (
        <p role="status" style={{ margin: "0 0 8px", fontSize: 13 }}>
          {notice}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="apf-note" data-tone="warning" style={{ margin: "0 0 8px" }}>
          {error}
        </p>
      ) : null}
      {secret ? <OneTimeSecret secret={secret} onDismiss={() => setSecret(null)} /> : null}

      {formMode.kind === "create" ? (
        <div id={`${formId}-create`}>
          <DestinationForm
            title="Add a webhook destination"
            submitLabel="Add destination"
            busy={busyId === "new"}
            onCancel={() => {
              setFormMode({ kind: "closed" });
              addButton.current?.focus();
            }}
            onSubmit={async (values) => {
              begin();
              setSecret(null);
              const result = await mutate(
                "new",
                () => apiFetch(ROOT, { method: "POST", body: JSON.stringify({ teamId, name: values.name, url: values.url }) }),
                (row) => Boolean(row) && row?.enabled === false,
                `"${values.name}" was added and confirmed from the saved record. It starts disabled — enable it when your receiver is ready.`,
              );
              const value = (result.response as { revealedSecret?: string } | null)?.revealedSecret;
              if (typeof value === "string" && value) {
                setSecret({ destinationName: values.name, value, rotated: false });
              }
              if (result.response !== undefined) setFormMode({ kind: "closed" });
              return result.error ? destinationFailure(result.error) : null;
            }}
          />
        </div>
      ) : null}

      {list.status === "loading" ? (
        <p role="status" style={{ fontSize: 13 }}>Loading webhook destinations…</p>
      ) : list.status === "failed" ? (
        <p role="alert" className="apf-note" data-tone="warning" data-automation-destinations-unreadable>
          {list.message}
        </p>
      ) : destinations.length === 0 ? (
        <div className="apf-empty">
          <p>No webhook destinations registered yet.</p>
          <p style={{ fontSize: 12, color: "var(--ink-muted)" }}>
            Add one before creating a rule that uses the internal webhook delivery action.
          </p>
        </div>
      ) : (
        <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 12 }}>
          {destinations.map((d) => {
            const editing = formMode.kind === "edit" && formMode.id === d.id;
            const rowBusy = busyId !== null;
            const reason = !canManage ? MANAGE_REASON : rowBusy && busyId !== d.id ? "Wait for the current change to finish." : undefined;
            return (
              <li
                key={d.id}
                data-automation-destination-id={d.id}
                data-automation-destination-enabled={String(d.enabled)}
                style={{ border: "1px solid var(--border-default)", borderRadius: 10, padding: 12, overflowWrap: "anywhere" }}
              >
                <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "baseline", justifyContent: "space-between" }}>
                  <strong>{d.name}</strong>
                  <span>{d.enabled ? "Enabled" : d.disabledAt ? "Disabled" : "Not yet enabled"}</span>
                </div>
                <dl style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 180px), 1fr))", gap: 8, margin: "8px 0", fontSize: 12.5 }}>
                  <div><dt style={{ color: "var(--ink-muted)" }}>Host</dt><dd style={{ margin: 0 }}>{d.urlOrigin}</dd></div>
                  <div><dt style={{ color: "var(--ink-muted)" }}>Consecutive failures</dt><dd style={{ margin: 0 }}>{d.failureCount}</dd></div>
                  <div><dt style={{ color: "var(--ink-muted)" }}>Last success</dt><dd style={{ margin: 0 }}>{d.lastSuccessAt ? formatUserDateTime(d.lastSuccessAt) : "Never"}</dd></div>
                  <div><dt style={{ color: "var(--ink-muted)" }}>Last failure</dt><dd style={{ margin: 0 }}>{d.lastFailureAt ? formatUserDateTime(d.lastFailureAt) : "Never"}</dd></div>
                </dl>
                <small style={{ color: "var(--ink-muted)" }}>
                  Destination ID <code data-identifier>{d.id}</code> · secret fingerprint{" "}
                  <code data-identifier>{d.secretFingerprint}</code>
                </small>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 8 }}>
                  <Button
                    size="sm"
                    aria-label={`${d.enabled ? "Disable" : "Enable"} destination ${d.name}`}
                    variant={d.enabled ? "destructive" : "secondary"}
                    loading={busyId === d.id}
                    disabled={!canManage || rowBusy}
                    disabledReason={reason}
                    onClick={() => void setEnabled(d, !d.enabled)}
                  >
                    {d.enabled ? "Disable" : "Enable"}
                  </Button>
                  <Button
                    size="sm"
                    aria-label={`Edit destination ${d.name}`}
                    data-automation-destination-edit={d.id}
                    aria-expanded={editing}
                    aria-controls={`${formId}-edit-${d.id}`}
                    disabled={!canManage || rowBusy || editing}
                    disabledReason={reason}
                    onClick={() => {
                      begin();
                      setFormMode({ kind: "edit", id: d.id });
                    }}
                  >
                    Edit
                  </Button>
                  <Button
                    size="sm"
                    aria-label={`Rotate signing secret of ${d.name}`}
                    disabled={!canManage || rowBusy}
                    disabledReason={reason}
                    onClick={() => void rotate(d)}
                  >
                    Rotate secret
                  </Button>
                </div>
                {editing ? (
                  <div id={`${formId}-edit-${d.id}`}>
                    <DestinationForm
                      title={`Edit "${d.name}"`}
                      submitLabel="Save changes"
                      initial={{ name: d.name, url: d.url }}
                      busy={busyId === d.id}
                      onCancel={() => {
                        setFormMode({ kind: "closed" });
                        setTimeout(() => {
                          document
                            .querySelector<HTMLButtonElement>(`[data-automation-destination-edit="${d.id}"]`)
                            ?.focus();
                        }, 0);
                      }}
                      onSubmit={async (values) => {
                        begin();
                        const body: Record<string, string> = {};
                        if (values.name !== d.name) body.name = values.name;
                        if (values.url !== d.url) body.url = values.url;
                        if (body.url) {
                          const ok = await confirm({
                            title: `Send "${d.name}" events to a new address?`,
                            description: `Future deliveries go to ${values.url} instead of ${d.urlOrigin}. The signing secret does not change.`,
                            confirmLabel: "Change address",
                            tone: "warning",
                            testId: "automation-webhook-url-change",
                          });
                          if (!alive.current || !ok) return null;
                        }
                        const result = await mutate(
                          d.id,
                          () => apiFetch(`${ROOT}/${encodeURIComponent(d.id)}`, { method: "PATCH", body: JSON.stringify(body) }),
                          (row) => row?.name === values.name && row?.url === values.url,
                          `"${values.name}" was saved and confirmed from the saved record.`,
                        );
                        if (result.response !== undefined) setFormMode({ kind: "closed" });
                        return result.error ? destinationFailure(result.error) : null;
                      }}
                    />
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function DestinationForm({
  title,
  submitLabel,
  initial,
  busy,
  onSubmit,
  onCancel,
}: {
  title: string;
  submitLabel: string;
  initial?: { name: string; url: string };
  busy: boolean;
  /** Resolves with a failure to show, or null. */
  onSubmit: (values: { name: string; url: string }) => Promise<{ field: string | null; message: string } | null>;
  onCancel: () => void;
}) {
  const id = useId();
  const nameRef = useRef<HTMLInputElement>(null);
  const [name, setName] = useState(initial?.name ?? "");
  const [url, setUrl] = useState(initial?.url ?? "");
  const [failure, setFailure] = useState<{ field: string | null; message: string } | null>(null);
  useEffect(() => {
    nameRef.current?.focus();
  }, []);
  const trimmedName = name.trim();
  const trimmedUrl = url.trim();
  const reason = busy
    ? undefined
    : trimmedName.length === 0 || trimmedName.length > 120
      ? "Enter a name of 1 to 120 characters."
      : !/^https:\/\/\S+$/i.test(trimmedUrl) || trimmedUrl.length > 600
        ? "Enter an https:// address of up to 600 characters."
        : initial && trimmedName === initial.name && trimmedUrl === initial.url
          ? "Change the name or the address to save."
          : undefined;

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy || reason) return;
    setFailure(null);
    const result = await onSubmit({ name: trimmedName, url: trimmedUrl });
    setFailure(result);
  }

  return (
    <form
      onSubmit={submit}
      aria-label={title}
      style={{ display: "grid", gap: 10, margin: "10px 0", padding: 12, border: "1px solid var(--border-default)", borderRadius: 10 }}
    >
      <strong>{title}</strong>
      <label style={{ display: "grid", gap: 4, fontSize: 12.5, minWidth: 0 }}>
        Name
        <input ref={nameRef} value={name} maxLength={120} onChange={(e) => setName(e.target.value)} />
      </label>
      <label style={{ display: "grid", gap: 4, fontSize: 12.5, minWidth: 0 }}>
        Destination URL
        <input
          value={url}
          type="url"
          inputMode="url"
          maxLength={600}
          aria-invalid={failure?.field ? true : undefined}
          aria-describedby={failure?.field ? `${id}-url-error` : `${id}-url-help`}
          onChange={(e) => setUrl(e.target.value)}
        />
      </label>
      {failure?.field ? (
        <span id={`${id}-url-error`} role="alert" style={{ fontSize: 12.5 }}>
          {failure.field}
        </span>
      ) : (
        <span id={`${id}-url-help`} style={{ fontSize: 12, color: "var(--ink-muted)" }}>
          HTTPS only. Private, reserved and local network addresses are refused.
        </span>
      )}
      {failure && !failure.field ? (
        <span role="alert" style={{ fontSize: 12.5 }}>
          {failure.message}
        </span>
      ) : null}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
        <Button type="submit" variant="primary" size="sm" loading={busy} disabled={busy || Boolean(reason)} disabledReason={reason}>
          {submitLabel}
        </Button>
        <Button type="button" size="sm" disabled={busy} onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

function OneTimeSecret({ secret, onDismiss }: { secret: Secret; onDismiss: () => void }) {
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  const headingRef = useRef<HTMLElement>(null);
  const id = useId();
  useEffect(() => {
    headingRef.current?.focus();
  }, []);
  async function copy() {
    try {
      if (!navigator.clipboard) throw new Error("clipboard unavailable");
      await navigator.clipboard.writeText(secret.value);
      setCopyState("copied");
    } catch {
      setCopyState("failed");
    }
  }
  return (
    <div className="apf-note" data-tone="warning" role="region" aria-labelledby={`${id}-title`} data-automation-one-time-secret style={{ margin: "0 0 12px" }}>
      <strong id={`${id}-title`} ref={headingRef} tabIndex={-1} style={{ display: "block" }}>
        {secret.rotated ? "New signing secret" : "Signing secret"} for &ldquo;{secret.destinationName}&rdquo;
      </strong>
      <p style={{ margin: "4px 0" }}>
        Copy it into your receiver now. You will not see this secret again — if it is lost, rotate it.
      </p>
      <code data-identifier style={{ display: "block", overflowWrap: "anywhere", userSelect: "all", margin: "6px 0" }}>
        {secret.value}
      </code>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
        <Button size="sm" onClick={() => void copy()}>
          Copy secret
        </Button>
        <Button size="sm" variant="ghost" onClick={onDismiss}>
          I have stored it — hide
        </Button>
        <span role="status" style={{ fontSize: 12.5 }}>
          {copyState === "copied" ? "Copied to the clipboard." : copyState === "failed" ? "Copy failed — select the secret and copy it manually." : ""}
        </span>
      </div>
    </div>
  );
}
