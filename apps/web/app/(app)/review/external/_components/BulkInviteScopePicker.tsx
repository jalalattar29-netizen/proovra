"use client";

/**
 * D16 — the scope an external-review bulk invitation grants.
 *
 * `POST /v1/external-review/invitations/bulk` issues each grant against
 * ONE target: an evidence record, a matter (case) or a verification
 * package, and the grant service refuses a target outside the issuing
 * workspace. The console used to send `{ kind: "PACKAGE" }` with no id, so
 * every row came back refused and nothing was written. This picker makes
 * the target a required, explicit choice, listing only this workspace's
 * records from the routes the product already reads them from:
 *
 *   - evidence records: `GET /v1/evidence?scope=active&teamId=…&search=…`
 *     (the Evidence library list; `teamId` pins the workspace);
 *   - matters: `GET /v1/cases/matter-queue?teamId=…&search=…`
 *     (the Cases index; strictly scoped by `teamId`);
 *   - verification packages: pick the evidence record first, then its
 *     package versions from `GET /v1/evidence/:id/review-workspace`
 *     (`artifactVersions.history.verificationPackages`, the list the
 *     record's own Details page renders).
 *
 * A failed or refused list read is reported as such and blocks submit;
 * it is never shown as "no records".
 */

import { useEffect, useId, useRef, useState } from "react";

import { apiFetch } from "../../../../../lib/api";
import { formatUserDate } from "../../../../../lib/date";
import { toSafeUserError } from "../../../../../lib/feedback/toSafeUserError";

export type BulkInviteScopeKind = "EVIDENCE" | "CASE" | "PACKAGE";

export type BulkInviteScopeTarget = {
  kind: BulkInviteScopeKind;
  id: string;
  label: string;
};

export type BulkInviteDefaultScope =
  | { kind: "EVIDENCE"; evidenceId: string }
  | { kind: "CASE"; caseId: string }
  | { kind: "PACKAGE"; packageId: string };

/** The `defaultScope` body field for a chosen target. */
export function defaultScopeFor(target: BulkInviteScopeTarget): BulkInviteDefaultScope {
  switch (target.kind) {
    case "EVIDENCE":
      return { kind: "EVIDENCE", evidenceId: target.id };
    case "CASE":
      return { kind: "CASE", caseId: target.id };
    case "PACKAGE":
      return { kind: "PACKAGE", packageId: target.id };
  }
}

const KIND_OPTIONS: ReadonlyArray<{
  kind: BulkInviteScopeKind;
  label: string;
  hint: string;
}> = [
  {
    kind: "EVIDENCE",
    label: "Evidence record",
    hint: "One evidence record from this workspace.",
  },
  {
    kind: "CASE",
    label: "Matter (case)",
    hint: "One matter and the evidence linked to it.",
  },
  {
    kind: "PACKAGE",
    label: "Evidence package",
    hint: "One verification package generated for an evidence record.",
  },
];

type Option = { id: string; label: string; detail: string | null };

type ListState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; options: Option[] }
  | { status: "failed"; message: string };

type EvidenceListItem = {
  id: string;
  title?: string | null;
  displayFileName?: string | null;
  originalFileName?: string | null;
  createdAt?: string | null;
};

type MatterQueueItem = {
  id: string;
  name?: string | null;
  referenceNumber?: string | null;
};

type PackageVersion = {
  id: string;
  version: number;
  generatedAtUtc: string;
};

const LIST_LIMIT = 25;

function readStatus(err: unknown): number {
  const s = (err as { statusCode?: unknown; status?: unknown } | null) ?? null;
  if (typeof s?.statusCode === "number") return s.statusCode;
  if (typeof s?.status === "number") return s.status;
  return 0;
}

/** A refused or failed read, as a sentence. Never "no records". */
function listFailure(err: unknown, what: string): string {
  const status = readStatus(err);
  if (status === 401 || status === 403 || status === 404) {
    return `You don't have access to this workspace's ${what}, so no scope can be chosen. Ask a workspace administrator.`;
  }
  const safe = toSafeUserError(err, { message: "Try again." }).message;
  return `We couldn't load this workspace's ${what}. ${safe}`;
}

function evidenceLabel(item: EvidenceListItem): string {
  return (
    item.title?.trim() ||
    item.displayFileName?.trim() ||
    item.originalFileName?.trim() ||
    "Untitled evidence record"
  );
}

function useDebounced(value: string, ms = 300): string {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const next = value.trim();
    if (next === debounced) return;
    const t = setTimeout(() => setDebounced(next), ms);
    return () => clearTimeout(t);
  }, [value, ms, debounced]);
  return debounced;
}

/**
 * Loads one list and drops any response that arrives after its inputs
 * changed (search typed, workspace switched).
 */
function useOptionList(
  path: string | null,
  what: string,
  project: (res: unknown) => Option[],
): [ListState, () => void] {
  const [state, setState] = useState<ListState>({ status: "idle" });
  const [nonce, setNonce] = useState(0);
  const projectRef = useRef(project);
  projectRef.current = project;
  useEffect(() => {
    if (!path) {
      setState({ status: "idle" });
      return;
    }
    let live = true;
    setState({ status: "loading" });
    apiFetch(path, { method: "GET" })
      .then((res: unknown) => {
        if (live) setState({ status: "ready", options: projectRef.current(res) });
      })
      .catch((err: unknown) => {
        if (live) setState({ status: "failed", message: listFailure(err, what) });
      });
    return () => {
      live = false;
    };
  }, [path, what, nonce]);
  return [state, () => setNonce((n) => n + 1)];
}

function projectEvidence(res: unknown): Option[] {
  const items = ((res as { items?: EvidenceListItem[] } | null)?.items ?? []).filter(
    (i) => typeof i?.id === "string",
  );
  return items.map((i) => ({
    id: i.id,
    label: evidenceLabel(i),
    detail: i.createdAt ? `Added ${formatUserDate(i.createdAt)}` : null,
  }));
}

function projectMatters(res: unknown): Option[] {
  const items = ((res as { items?: MatterQueueItem[] } | null)?.items ?? []).filter(
    (i) => typeof i?.id === "string",
  );
  return items.map((i) => ({
    id: i.id,
    label: i.name?.trim() || "Untitled matter",
    detail: i.referenceNumber ? `Reference ${i.referenceNumber}` : null,
  }));
}

function projectPackages(res: unknown): Option[] {
  const history = (
    res as {
      artifactVersions?: { history?: { verificationPackages?: PackageVersion[] } };
    } | null
  )?.artifactVersions?.history;
  const versions = (history?.verificationPackages ?? []).filter(
    (p) => typeof p?.id === "string",
  );
  return versions.map((p) => ({
    id: p.id,
    label: `Verification package, version ${p.version}`,
    detail: `Generated ${formatUserDate(p.generatedAtUtc)}`,
  }));
}

export type BulkInviteScopeState = {
  target: BulkInviteScopeTarget | null;
  /** Why submit must stay disabled, or null when a target is chosen. */
  blockedReason: string | null;
};

export const SCOPE_REQUIRED_REASON =
  "Choose what these reviewers will see before issuing invitations.";

export function BulkInviteScopePicker({
  teamId,
  onChange,
}: {
  teamId: string | null;
  onChange: (state: BulkInviteScopeState) => void;
}) {
  const groupId = useId();
  const [kind, setKind] = useState<BulkInviteScopeKind | null>(null);
  const [search, setSearch] = useState("");
  const [evidence, setEvidence] = useState<Option | null>(null);
  const [target, setTarget] = useState<BulkInviteScopeTarget | null>(null);
  const applied = useDebounced(search);

  // A workspace switch invalidates every choice made in the old one.
  useEffect(() => {
    setKind(null);
    setSearch("");
    setEvidence(null);
    setTarget(null);
  }, [teamId]);

  const needsEvidence = kind === "EVIDENCE" || kind === "PACKAGE";
  const evidencePath =
    teamId && needsEvidence
      ? `/v1/evidence?${new URLSearchParams({
          scope: "active",
          limit: String(LIST_LIMIT),
          sort: "newest",
          teamId,
          ...(applied ? { search: applied } : {}),
        }).toString()}`
      : null;
  const matterPath =
    teamId && kind === "CASE"
      ? `/v1/cases/matter-queue?${new URLSearchParams({
          teamId,
          limit: String(LIST_LIMIT),
          ...(applied ? { search: applied } : {}),
        }).toString()}`
      : null;
  const packagePath =
    teamId && kind === "PACKAGE" && evidence
      ? `/v1/evidence/${encodeURIComponent(evidence.id)}/review-workspace`
      : null;

  const [evidenceList, retryEvidence] = useOptionList(
    evidencePath,
    "evidence records",
    projectEvidence,
  );
  const [matterList, retryMatters] = useOptionList(matterPath, "matters", projectMatters);
  const [packageList, retryPackages] = useOptionList(
    packagePath,
    "verification packages for this record",
    projectPackages,
  );

  const primaryList = kind === "CASE" ? matterList : evidenceList;
  const retryPrimary = kind === "CASE" ? retryMatters : retryEvidence;

  let blockedReason: string | null = null;
  if (!teamId) {
    blockedReason = "Your workspace is still loading.";
  } else if (primaryList.status === "failed") {
    blockedReason = primaryList.message;
  } else if (kind === "PACKAGE" && evidence && packageList.status === "failed") {
    blockedReason = packageList.message;
  } else if (!target) {
    blockedReason = SCOPE_REQUIRED_REASON;
  }

  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  useEffect(() => {
    onChangeRef.current({ target, blockedReason });
  }, [target, blockedReason]);

  const chooseKind = (next: BulkInviteScopeKind) => {
    if (next === kind) return;
    setKind(next);
    setSearch("");
    setEvidence(null);
    setTarget(null);
  };

  const choosePrimary = (option: Option) => {
    if (kind === "CASE") {
      setTarget({ kind: "CASE", id: option.id, label: option.label });
    } else if (kind === "EVIDENCE") {
      setTarget({ kind: "EVIDENCE", id: option.id, label: option.label });
    } else if (kind === "PACKAGE") {
      setEvidence(option);
      setTarget(null);
    }
  };

  const primaryNoun = kind === "CASE" ? "matters" : "evidence records";
  const primarySelectedId =
    kind === "PACKAGE" ? evidence?.id ?? null : target?.id ?? null;

  return (
    <fieldset data-bulk-scope-picker style={fieldsetStyle}>
      <legend style={legendStyle}>What will these reviewers see?</legend>
      <div role="radiogroup" aria-label="Scope type" style={kindRowStyle}>
        {KIND_OPTIONS.map((o) => (
          <label key={o.kind} style={kindOptionStyle} data-bulk-scope-kind={o.kind}>
            <input
              type="radio"
              name={`${groupId}-kind`}
              value={o.kind}
              checked={kind === o.kind}
              onChange={() => chooseKind(o.kind)}
            />
            <span>
              <span style={{ fontWeight: 600 }}>{o.label}</span>
              <small style={hintStyle}>{o.hint}</small>
            </span>
          </label>
        ))}
      </div>

      {kind ? (
        <div style={{ display: "grid", gap: 6 }}>
          <label style={{ display: "grid", gap: 4 }}>
            <small style={fieldLabelStyle}>
              {kind === "CASE"
                ? "Search matters"
                : kind === "PACKAGE"
                  ? "Search evidence records (then choose a package)"
                  : "Search evidence records"}
            </small>
            <input
              type="search"
              data-bulk-scope-search
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={kind === "CASE" ? "Matter name or reference" : "Title or file name"}
              style={inputStyle}
            />
          </label>
          <OptionList
            name={`${groupId}-primary`}
            legend={kind === "CASE" ? "Matters in this workspace" : "Evidence records in this workspace"}
            state={primaryList}
            noun={primaryNoun}
            searched={applied.length > 0}
            selectedId={primarySelectedId}
            onSelect={choosePrimary}
            onRetry={retryPrimary}
          />
          {kind === "PACKAGE" && evidence ? (
            <OptionList
              name={`${groupId}-package`}
              legend={`Verification packages for ${evidence.label}`}
              state={packageList}
              noun="verification packages"
              emptyText="This record has no verification package yet. Generate one from the record's page, or choose another record."
              searched={false}
              selectedId={target?.kind === "PACKAGE" ? target.id : null}
              onSelect={(o) =>
                setTarget({ kind: "PACKAGE", id: o.id, label: `${evidence.label} — ${o.label}` })
              }
              onRetry={retryPackages}
            />
          ) : null}
        </div>
      ) : null}

      <p data-bulk-scope-summary style={summaryStyle} aria-live="polite">
        {target ? (
          <>
            Reviewers will see: <strong>{target.label}</strong>{" "}
            <code data-identifier style={codeStyle}>
              {target.id}
            </code>
          </>
        ) : (
          (blockedReason ?? SCOPE_REQUIRED_REASON)
        )}
      </p>
    </fieldset>
  );
}

function OptionList({
  name,
  legend,
  state,
  noun,
  emptyText,
  searched,
  selectedId,
  onSelect,
  onRetry,
}: {
  name: string;
  legend: string;
  state: ListState;
  noun: string;
  emptyText?: string;
  searched: boolean;
  selectedId: string | null;
  onSelect: (option: Option) => void;
  onRetry: () => void;
}) {
  if (state.status === "idle") return null;
  if (state.status === "loading") {
    return (
      <p role="status" style={summaryStyle}>
        Loading {noun}…
      </p>
    );
  }
  if (state.status === "failed") {
    return (
      <div role="alert" data-bulk-scope-list-failed style={alertStyle}>
        <span>{state.message}</span>{" "}
        <button type="button" onClick={onRetry} style={linkButtonStyle}>
          Try again
        </button>
      </div>
    );
  }
  if (state.options.length === 0) {
    return (
      <p data-bulk-scope-empty style={summaryStyle}>
        {searched
          ? `No ${noun} in this workspace match that search.`
          : (emptyText ?? `This workspace has no ${noun} yet.`)}
      </p>
    );
  }
  return (
    <fieldset style={listStyle}>
      <legend style={fieldLabelStyle}>{legend}</legend>
      {state.options.map((o) => (
        <label key={o.id} style={optionStyle} data-bulk-scope-option={o.id}>
          <input
            type="radio"
            name={name}
            value={o.id}
            checked={selectedId === o.id}
            onChange={() => onSelect(o)}
          />
          <span style={{ minWidth: 0, overflowWrap: "anywhere" }}>
            <span>{o.label}</span>
            {o.detail ? <small style={hintStyle}>{o.detail}</small> : null}
            <code data-identifier style={codeStyle}>
              {o.id}
            </code>
          </span>
        </label>
      ))}
    </fieldset>
  );
}

// ---------------------------------------------------------------------------
// Styles — the surface's existing tokens only.
// ---------------------------------------------------------------------------

const fieldsetStyle = {
  border: "1px solid var(--border-default)",
  borderRadius: "var(--radius-md, 8px)",
  padding: 12,
  margin: 0,
  display: "grid",
  gap: 10,
  minWidth: 0,
} as const;
const legendStyle = {
  fontSize: 13,
  fontWeight: 650,
  color: "var(--ink-primary)",
  padding: "0 4px",
} as const;
const kindRowStyle = {
  display: "flex",
  flexWrap: "wrap" as const,
  gap: 8,
};
const kindOptionStyle = {
  display: "flex",
  alignItems: "flex-start",
  gap: 6,
  flex: "1 1 180px",
  fontSize: 12,
  color: "var(--ink-primary)",
  cursor: "pointer",
} as const;
const hintStyle = {
  display: "block",
  fontSize: 11,
  color: "var(--ink-secondary)",
} as const;
const fieldLabelStyle = {
  fontSize: 11,
  color: "var(--ink-secondary)",
  fontWeight: 600,
} as const;
const inputStyle = {
  width: "100%",
  padding: "6px 8px",
  border: "1px solid var(--border-default)",
  borderRadius: "var(--radius-sm, 6px)",
  fontSize: 12,
  background: "var(--surface-card)",
  color: "var(--ink-primary)",
  boxSizing: "border-box" as const,
};
const listStyle = {
  border: "1px solid var(--border-subtle)",
  borderRadius: "var(--radius-sm, 6px)",
  padding: 8,
  margin: 0,
  display: "grid",
  gap: 4,
  maxHeight: 260,
  overflowY: "auto" as const,
  minWidth: 0,
};
const optionStyle = {
  display: "flex",
  alignItems: "flex-start",
  gap: 6,
  fontSize: 12,
  color: "var(--ink-primary)",
  cursor: "pointer",
  padding: "4px 2px",
} as const;
const codeStyle = {
  display: "block",
  fontSize: 10.5,
  color: "var(--ink-muted)",
  overflowWrap: "anywhere" as const,
};
const summaryStyle = {
  margin: 0,
  fontSize: 12,
  color: "var(--ink-secondary)",
} as const;
const alertStyle = {
  fontSize: 12,
  color: "var(--status-risk-fg)",
  background: "var(--status-risk-bg)",
  border: "1px solid var(--status-risk-border)",
  borderRadius: "var(--radius-sm, 6px)",
  padding: "6px 8px",
} as const;
const linkButtonStyle = {
  background: "transparent",
  border: "none",
  padding: 0,
  color: "inherit",
  textDecoration: "underline",
  fontSize: 12,
  cursor: "pointer",
} as const;
