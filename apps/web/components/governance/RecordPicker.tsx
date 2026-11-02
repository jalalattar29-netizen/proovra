"use client";

/**
 * RT-012 — pick a record by what it is called. The destruction and legal-hold forms
 * asked for pasted UUIDs on an irreversible flow, so the only way to check the
 * right record was chosen was to open it in another tab.
 *
 * The server stays the authority: the lists come from the ordinary evidence and
 * case reads, scoped to the workspace, and every write re-checks what was picked.
 */

import { useEffect, useId, useState } from "react";

import { apiFetch } from "../../lib/api";

type Choice = { id: string; label: string };

type EvidenceRow = {
  id: string;
  title?: string | null;
  displayFileName?: string | null;
  originalFileName?: string | null;
};
type CaseRow = { id: string; name?: string | null; title?: string | null };

function evidenceLabel(row: EvidenceRow): string {
  return row.title || row.displayFileName || row.originalFileName || "Untitled record";
}

async function readChoices(
  kind: "evidence" | "case",
  evidenceScope: string,
  query: string,
): Promise<Choice[]> {
  if (kind === "evidence") {
    const params = new URLSearchParams({ scope: evidenceScope, limit: "10" });
    if (query) params.set("search", query);
    const res = (await apiFetch(`/v1/evidence?${params.toString()}`)) as { items?: EvidenceRow[] } | null;
    return (res?.items ?? []).map((row) => ({ id: row.id, label: evidenceLabel(row) }));
  }
  const res = (await apiFetch("/v1/cases")) as { items?: CaseRow[]; cases?: CaseRow[] } | null;
  const needle = query.toLowerCase();
  return (res?.items ?? res?.cases ?? [])
    .map((row) => ({ id: row.id, label: row.name || row.title || "Untitled case" }))
    .filter((c) => !needle || c.label.toLowerCase().includes(needle))
    .slice(0, 10);
}

export function RecordPicker({
  kind,
  label,
  value,
  onChange,
  evidenceScope = "active",
  disabled = false,
}: {
  kind: "evidence" | "case";
  label: string;
  /** The picked id, or empty. */
  value: string;
  onChange: (id: string) => void;
  /** Which shelf to list: a destruction request can only name a trashed record. */
  evidenceScope?: "active" | "trash" | "archived" | "all";
  disabled?: boolean;
}) {
  const uid = useId();
  const [query, setQuery] = useState("");
  const [choices, setChoices] = useState<Choice[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [picked, setPicked] = useState<Choice | null>(null);

  useEffect(() => {
    if (!value) setPicked(null);
  }, [value]);

  useEffect(() => {
    if (picked) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      readChoices(kind, evidenceScope, query.trim())
        .then((rows) => {
          if (cancelled) return;
          setChoices(rows);
          setFailed(false);
        })
        .catch(() => {
          if (cancelled) return;
          setChoices(null);
          setFailed(true);
        });
    }, 200);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [kind, evidenceScope, query, picked]);

  if (picked) {
    return (
      <div style={wrapStyle} data-record-picked={picked.id}>
        <span style={labelStyle}>{label}</span>
        <span style={{ fontSize: 13 }}>
          {picked.label}{" "}
          <button
            type="button"
            style={linkStyle}
            disabled={disabled}
            onClick={() => {
              setPicked(null);
              onChange("");
            }}
          >
            Change
          </button>
        </span>
      </div>
    );
  }

  return (
    <div style={wrapStyle} data-record-picker={kind}>
      <label htmlFor={uid} style={labelStyle}>
        {label}
      </label>
      <input
        id={uid}
        style={inputStyle}
        value={query}
        disabled={disabled}
        onChange={(e) => setQuery(e.target.value)}
        placeholder={kind === "evidence" ? "Search by name" : "Search cases by name"}
      />
      {failed ? (
        <span style={noteStyle}>This list could not be read. That does not mean there is nothing here.</span>
      ) : choices && choices.length === 0 ? (
        <span style={noteStyle}>Nothing matches.</span>
      ) : (
        <ul style={listStyle}>
          {(choices ?? []).map((choice) => (
            <li key={choice.id}>
              <button
                type="button"
                style={choiceStyle}
                disabled={disabled}
                onClick={() => {
                  setPicked(choice);
                  onChange(choice.id);
                }}
              >
                {choice.label}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

const wrapStyle = { display: "flex", flexDirection: "column" as const, gap: 2, minWidth: 220 };
const labelStyle = { fontSize: 11, fontWeight: 600 };
const noteStyle = { fontSize: 12, color: "#475569" };
const inputStyle = {
  fontSize: 12,
  padding: "4px 6px",
  border: "1px solid #cbd5e1",
  borderRadius: 6,
  background: "#fff",
} as const;
const listStyle = {
  listStyle: "none",
  margin: 0,
  padding: 0,
  maxHeight: 160,
  overflowY: "auto" as const,
};
const choiceStyle = {
  display: "block",
  width: "100%",
  textAlign: "left" as const,
  fontSize: 12,
  padding: "4px 6px",
  border: 0,
  background: "transparent",
  cursor: "pointer",
};
const linkStyle = {
  fontSize: 12,
  border: 0,
  padding: 0,
  background: "transparent",
  textDecoration: "underline",
  cursor: "pointer",
};
