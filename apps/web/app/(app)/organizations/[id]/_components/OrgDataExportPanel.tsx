"use client";

/**
 * PRO-CENZ-01 (owner decision K) — GOV-015, the organization owner's
 * offboarding data export. EP-0842 / EP-0843 / EP-0844.
 *
 * The API has served it since 29a7277d2 ("the owner now requests it…") and
 * the platform's contract panel promises "the window in which the owner can
 * export the organization's data", but no control reached it:
 *
 *   GET  /v1/orgs/:id/data-export                      request history
 *   POST /v1/orgs/:id/data-export                      request (step-up)
 *   POST /v1/orgs/:id/data-export/:requestId/manifest  the manifest file (step-up)
 *   POST /v1/orgs/:id/data-export/:requestId/links     a page of sealed-version
 *                                                      download links (step-up)
 *
 * Every route admits ONLY the owner of a customer organization (checkOrgAccess
 * roles ["ORG_OWNER"], CUSTOMER kind by default); the organization page mounts
 * this panel only for `callerRole === "ORG_OWNER"` on a customer organization,
 * both read from GET /v1/orgs/:id. Visibility is not authorization: a 403/404
 * here is said, never retried around. The step-up proof travels in the body.
 */
import { identifierLabel } from "@proovra/shared";
import { useCallback, useEffect, useState } from "react";

import { Button } from "../../../../../components/ui/Button";
import { apiFetch } from "../../../../../lib/api";
import { formatUserDateTime } from "../../../../../lib/date";
import { toSafeUserError } from "../../../../../lib/feedback/toSafeUserError";
import {
  StepUpVerify,
  extractStepUp,
  type StepUpMethods,
  type StepUpProof,
} from "../../../security-center/components/PersonalSecuritySections";

export type OrgDataExportRow = {
  id: string;
  status: string;
  requestedAtUtc: string;
  completedAtUtc: string | null;
  expiresAtUtc: string | null;
  failureCode: string | null;
  manifestSha256: string | null;
  recordCount: number | null;
  objectCount: number | null;
  heldRecordCount: number | null;
  missingObjectCount: number | null;
  downloadCount: number;
};

type OrgExportLink = {
  evidenceId: string;
  kind: string;
  key: string;
  versionId: string | null;
  sha256: string | null;
  sizeBytes: string | null;
  url: string;
};

type LinksPage = {
  links: OrgExportLink[];
  nextOffset: number | null;
  total: number;
  withheldByLegalHold: Array<{ evidenceId: string; workspaceId: string; reason: string }>;
};

const STATUS_LABEL: Record<string, string> = {
  REQUESTED: "Requested — waiting to be built",
  PROCESSING: "Being built",
  READY: "Ready to download",
  FAILED: "Failed",
  EXPIRED: "Expired",
};

const ACTIVE = new Set(["REQUESTED", "PROCESSING", "READY"]);

type StepUpFor =
  | { kind: "request" }
  | { kind: "manifest"; id: string }
  | { kind: "links"; id: string; offset: number };

type ListState =
  | { kind: "loading" }
  | { kind: "ready"; rows: OrgDataExportRow[] }
  | { kind: "error"; message: string };

function refusalCode(err: unknown): string | undefined {
  const e = err as { code?: string; body?: { error?: { code?: string } } };
  return e.body?.error?.code ?? e.code;
}

/** The POST body: the route's own fields, and the step-up proof when there is one. */
function body(proof?: StepUpProof, extra?: Record<string, unknown>): string {
  return JSON.stringify({ ...(extra ?? {}), ...(proof ? { stepUp: proof } : {}) });
}

function statusOf(err: unknown): number | undefined {
  return (err as { statusCode?: number }).statusCode;
}

/** The sentence for a refusal any of the four routes can give. */
function refusalMessage(err: unknown, fallback: string): string {
  const code = refusalCode(err);
  const status = statusOf(err);
  if (code === "export_request_active") {
    return "An export is already requested or ready. Download it, or wait for it to expire, before requesting another.";
  }
  if (code === "export_not_ready") return "This export is not available for download any more.";
  if (code === "export_not_found") return "This export no longer exists.";
  if (code === "session_quarantined") {
    return "This session is restricted after a security check. Sign in again, then retry.";
  }
  if (code === "forbidden" || status === 403) {
    return "Only the organization owner can export the organization's data.";
  }
  if (code === "not_found" || status === 404) return "This organization is not available to you any more.";
  return toSafeUserError(err, { message: fallback }).message;
}

export function OrgDataExportPanel({ orgId }: { orgId: string }) {
  const [list, setList] = useState<ListState>({ kind: "loading" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [links, setLinks] = useState<{ id: string; offset: number; page: LinksPage } | null>(null);
  const [stepUpFor, setStepUpFor] = useState<StepUpFor | null>(null);
  const [stepUpMethods, setStepUpMethods] = useState<StepUpMethods>(["reauth"]);
  const [stepUpMsg, setStepUpMsg] = useState("");

  const reload = useCallback(async () => {
    try {
      const res = (await apiFetch(`/v1/orgs/${orgId}/data-export`)) as { requests?: OrgDataExportRow[] };
      setList({ kind: "ready", rows: res.requests ?? [] });
    } catch (err) {
      // A failed read is not "no exports": it would hide a READY export and
      // offer a request the server refuses.
      setList({ kind: "error", message: refusalMessage(err, "The organization's exports could not be loaded.") });
    }
  }, [orgId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  /** True when the refusal was a step-up challenge (the prompt is now open). */
  const promptedForStepUp = useCallback((err: unknown, next: StepUpFor): boolean => {
    const su = extractStepUp(err);
    if (!su) return false;
    setStepUpFor(next);
    setStepUpMethods(su.methods);
    setStepUpMsg(su.message);
    return true;
  }, []);

  const requestExport = useCallback(
    async (proof?: StepUpProof) => {
      setBusy(true);
      setError(null);
      setNotice(null);
      try {
        await apiFetch(`/v1/orgs/${orgId}/data-export`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: body(proof),
        });
        setStepUpFor(null);
        setNotice(
          "Export requested. It is built in the background; come back here to download it. It stays available for 7 days.",
        );
        await reload();
      } catch (err) {
        if (promptedForStepUp(err, { kind: "request" })) return;
        setStepUpFor(null);
        setError(refusalMessage(err, "The export could not be requested."));
        if (refusalCode(err) === "export_request_active") await reload();
      } finally {
        setBusy(false);
      }
    },
    [orgId, reload, promptedForStepUp],
  );

  const downloadManifest = useCallback(
    async (id: string, proof?: StepUpProof) => {
      setBusy(true);
      setError(null);
      setNotice(null);
      try {
        // The saved file is the server's bytes, untouched, so its SHA-256 is
        // the checksum shown on the row.
        const text = (await apiFetch(
          `/v1/orgs/${orgId}/data-export/${id}/manifest`,
          { method: "POST", headers: { "content-type": "application/json" }, body: body(proof) },
          { rawText: true },
        )) as string;
        const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
        const a = document.createElement("a");
        a.href = url;
        a.download = `proovra-organization-export-${id}.json`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
        setStepUpFor(null);
        await reload();
      } catch (err) {
        if (promptedForStepUp(err, { kind: "manifest", id })) return;
        setStepUpFor(null);
        setError(refusalMessage(err, "The manifest could not be downloaded."));
      } finally {
        setBusy(false);
      }
    },
    [orgId, reload, promptedForStepUp],
  );

  const issueLinks = useCallback(
    async (id: string, offset: number, proof?: StepUpProof) => {
      setBusy(true);
      setError(null);
      setNotice(null);
      try {
        const page = (await apiFetch(`/v1/orgs/${orgId}/data-export/${id}/links`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: body(proof, { offset }),
        })) as LinksPage;
        setStepUpFor(null);
        setLinks({ id, offset, page });
      } catch (err) {
        if (promptedForStepUp(err, { kind: "links", id, offset })) return;
        setStepUpFor(null);
        setError(refusalMessage(err, "The download links could not be issued."));
      } finally {
        setBusy(false);
      }
    },
    [orgId, promptedForStepUp],
  );

  const rows = list.kind === "ready" ? list.rows : [];
  const active = rows.find((r) => ACTIVE.has(r.status));

  return (
    <div data-control="org-data-export" style={{ display: "grid", gap: 10, fontSize: 13 }}>
      <div>
        <strong>Export the organization&apos;s data.</strong>{" "}
        <span style={{ color: "var(--ink-secondary, #475569)" }}>
          A manifest of every record in every workspace of this organization,
          with the sealed version of each stored file, and download links you
          page through. Records under legal hold are listed as withheld unless
          their workspace releases held records. Each step asks you to verify
          it&apos;s you.
        </span>
      </div>

      {list.kind === "loading" ? (
        <p data-state="loading" style={{ margin: 0, color: "var(--ink-secondary, #475569)" }}>
          Loading exports…
        </p>
      ) : list.kind === "error" ? (
        <div role="alert" data-state="error" style={{ color: "#8f1d16" }}>
          {list.message}{" "}
          <Button variant="ghost" size="sm" onClick={() => void reload()} data-action="org-data-export-retry">
            Try again
          </Button>
        </div>
      ) : rows.length === 0 ? (
        <p data-state="empty" style={{ margin: 0, color: "var(--ink-secondary, #475569)" }}>
          No export has been requested for this organization.
        </p>
      ) : (
        <ul style={{ margin: 0, paddingLeft: 0, listStyle: "none", display: "grid", gap: 8 }}>
          {rows.map((r) => (
            <li
              key={r.id}
              data-org-export-row={r.status}
              style={{
                border: "1px solid var(--border-default, rgba(15,23,42,0.12))",
                borderRadius: 8,
                padding: "8px 10px",
              }}
            >
              <div>
                <strong>{STATUS_LABEL[r.status] ?? identifierLabel(r.status)}</strong>
                <span style={{ color: "var(--ink-secondary, #475569)" }}>
                  {" "}
                  · requested {formatUserDateTime(r.requestedAtUtc)}
                  {r.status === "READY" && r.expiresAtUtc ? ` · available until ${formatUserDateTime(r.expiresAtUtc)}` : ""}
                </span>
              </div>
              {r.status === "READY" ? (
                <div style={{ marginTop: 4, color: "var(--ink-secondary, #475569)" }}>
                  {r.recordCount ?? 0} record{r.recordCount === 1 ? "" : "s"} · {r.objectCount ?? 0} stored file
                  {r.objectCount === 1 ? "" : "s"}
                  {r.heldRecordCount ? ` · ${r.heldRecordCount} under legal hold` : ""}
                  {r.missingObjectCount ? ` · ${r.missingObjectCount} file${r.missingObjectCount === 1 ? "" : "s"} not found in storage` : ""}
                </div>
              ) : null}
              {r.status === "READY" && r.manifestSha256 ? (
                <div style={{ marginTop: 4, overflowWrap: "anywhere" }} data-org-export-checksum>
                  SHA-256 of the manifest file: <code>{r.manifestSha256}</code>
                </div>
              ) : null}
              {r.status === "FAILED" ? (
                <div style={{ marginTop: 4, color: "var(--ink-secondary, #475569)" }}>
                  {r.failureCode === "generation_stalled"
                    ? "The export stopped before it finished. You can request a new one."
                    : "The export could not be built. You can request a new one."}
                </div>
              ) : null}
              {r.status === "READY" ? (
                <div style={{ display: "flex", gap: 8, marginTop: 8, flexWrap: "wrap" }}>
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={busy}
                    onClick={() => void downloadManifest(r.id)}
                    data-action="org-data-export-manifest"
                  >
                    Download manifest
                  </Button>
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={busy}
                    onClick={() => void issueLinks(r.id, 0)}
                    data-action="org-data-export-links"
                  >
                    Get file download links
                  </Button>
                </div>
              ) : null}
              {links && links.id === r.id ? (
                <div data-org-export-links style={{ marginTop: 8 }}>
                  <p style={{ margin: "0 0 4px", color: "var(--ink-secondary, #475569)" }}>
                    {links.page.total === 0
                      ? "No stored files can be downloaded from this export."
                      : `Files ${links.offset + 1}–${links.offset + links.page.links.length} of ${links.page.total}. Each link works for 15 minutes.`}
                    {links.page.withheldByLegalHold.length > 0
                      ? ` ${links.page.withheldByLegalHold.length} record${links.page.withheldByLegalHold.length === 1 ? " is" : "s are"} withheld under legal hold.`
                      : ""}
                  </p>
                  <ul style={{ margin: 0, paddingLeft: 18 }}>
                    {links.page.links.map((l) => (
                      <li key={`${l.evidenceId}-${l.key}`}>
                        <a href={l.url} target="_blank" rel="noopener noreferrer" download>
                          {identifierLabel(l.kind)} · record {l.evidenceId.slice(0, 8)}
                        </a>
                        {l.sha256 ? (
                          <span style={{ color: "var(--ink-secondary, #475569)" }}> · SHA-256 {l.sha256.slice(0, 12)}…</span>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                  {links.page.nextOffset !== null ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={busy}
                      onClick={() => void issueLinks(r.id, links.page.nextOffset as number)}
                      data-action="org-data-export-links-next"
                    >
                      Next files
                    </Button>
                  ) : null}
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}

      {list.kind === "ready" && !active ? (
        <div>
          <Button
            variant="secondary"
            size="sm"
            loading={busy}
            disabled={busy}
            onClick={() => void requestExport()}
            data-action="org-data-export-request"
          >
            Request organization export
          </Button>
        </div>
      ) : null}

      {stepUpFor ? (
        <StepUpVerify
          title={
            stepUpFor.kind === "request"
              ? "Confirm requesting an export of this organization's data."
              : "Confirm downloading this organization's data."
          }
          methods={stepUpMethods}
          initialError={stepUpMsg}
          busy={busy}
          onSubmit={(proof) =>
            stepUpFor.kind === "request"
              ? void requestExport(proof)
              : stepUpFor.kind === "manifest"
                ? void downloadManifest(stepUpFor.id, proof)
                : void issueLinks(stepUpFor.id, stepUpFor.offset, proof)
          }
          onCancel={() => {
            setStepUpFor(null);
            setStepUpMsg("");
          }}
        />
      ) : null}

      {error ? (
        <div role="alert" data-org-export-error style={{ color: "#8f1d16", fontSize: 12.5 }}>
          {error}
        </div>
      ) : null}
      {notice ? (
        <div role="status" style={{ color: "#215e44", fontSize: 12.5 }}>
          {notice}
        </div>
      ) : null}
    </div>
  );
}
