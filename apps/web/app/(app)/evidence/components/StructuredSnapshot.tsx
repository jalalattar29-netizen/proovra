"use client";

/**
 * StructuredSnapshot — the structured renderer for nested comparison payloads,
 * `trustDecisionSnapshot` above all.
 *
 * The comparison card used to render every value through a `renderValue` whose
 * last line was `JSON.stringify(value)`. A nested object therefore arrived as
 * one uninterrupted symbolic wall, and an object nested inside THAT arrived as
 * `[object Object]`. The data was right; only its presentation was unusable.
 *
 * Nothing is dropped or truncated here. Every key still renders — as a
 * labelled fact, a bounded section or a list — and the complete payload stays
 * reachable verbatim under `View raw snapshot`.
 *
 * This is the ONLY structured/diff renderer on the comparison surface; the
 * group cards, the nested sections and the raw disclosure all come from here
 * rather than from a parallel implementation.
 */

import { useMemo, useState } from "react";

/** Which side of a comparison a value fell on. */
export type ChangeKind = "added" | "removed" | "changed" | "unchanged";

/** `passedSignals` -> `Passed signals`; `maxScore` -> `Max score`. */
export function humaniseKey(key: string): string {
  const spaced = key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Za-z])(\d)/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim();
  if (!spaced) return key;
  // Known acronyms stay upper-cased rather than being title-cased into noise.
  const ACRONYM = /^(utc|id|ids|url|uri|sha|sha256|tsa|ots|ai|pdf|json|mime|api)$/i;
  return spaced
    .split(/\s+/)
    .map((word, index) => {
      if (ACRONYM.test(word)) return word.toUpperCase();
      return index === 0 ? word.charAt(0).toUpperCase() + word.slice(1) : word.toLowerCase();
    })
    .join(" ");
}

/**
 * Values that must read left-to-right whatever the surrounding direction.
 * A hash, an identifier or an ISO timestamp is not prose and is unreadable
 * once the bidi algorithm reorders it.
 */
const LTR_KEY = /(hash|sha|digest|id$|ids$|utc|time|date|version|score|token|key|uuid|url|uri)/i;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Structural comparison.
 *
 * Objects are compared KEY BY KEY and arrays element by element, so a payload
 * serialised with its keys in a different order is NOT reported as changed —
 * which comparing formatted strings would do.
 */
export function compareValues(a: unknown, b: unknown): ChangeKind {
  // `a` is what this artifact recorded, `b` what the counterpart recorded:
  // a field only this artifact carries was ADDED, one only the counterpart
  // carries was REMOVED.
  if (a !== undefined && b === undefined) return "added";
  if (a === undefined && b !== undefined) return "removed";
  if (isPlainObject(a) && isPlainObject(b)) {
    for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
      if (compareValues(a[key], b[key]) !== "unchanged") return "changed";
    }
    return "unchanged";
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return "changed";
    for (let index = 0; index < a.length; index += 1) {
      if (compareValues(a[index], b[index]) !== "unchanged") return "changed";
    }
    return "unchanged";
  }
  return Object.is(a, b) ? "unchanged" : "changed";
}

const MARK_LABEL: Record<Exclude<ChangeKind, "unchanged">, string> = {
  added: "Added",
  removed: "Removed",
  changed: "Changed",
};

/** Text AND tone — a difference is never signalled by colour alone. */
function ChangeMark({ kind }: { kind: ChangeKind | undefined }) {
  if (!kind || kind === "unchanged") return null;
  return (
    <span className="snap-mark" data-snap-mark={kind}>
      {MARK_LABEL[kind]}
    </span>
  );
}

/** Renders a scalar exactly as recorded; a missing value is stated, never invented. */
function formatScalar(value: unknown): string {
  if (value === null || value === undefined || value === "") return "Not recorded";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  return String(value);
}

/** One label/value row. */
function Fact({
  name,
  value,
  change,
}: {
  name: string;
  value: unknown;
  change?: ChangeKind;
}) {
  const ltr = LTR_KEY.test(name);
  return (
    <div
      className="snap-fact"
      data-snap-change={change && change !== "unchanged" ? change : undefined}
    >
      <dt className="snap-fact__label">{humaniseKey(name)}</dt>
      <dd className="snap-fact__value" dir={ltr ? "ltr" : undefined} data-snap-ltr={ltr || undefined}>
        <span className="snap-fact__text">{formatScalar(value)}</span>
        <ChangeMark kind={change} />
      </dd>
    </div>
  );
}

function Node({
  name,
  value,
  other,
  change,
  depth,
}: {
  name: string;
  value: unknown;
  other: unknown;
  /** Decided by the parent, which knows whether a counterpart exists at all. */
  change?: ChangeKind;
  depth: number;
}) {
  const mark = change && change !== "unchanged" ? change : undefined;

  if (Array.isArray(value)) {
    // An array of objects becomes a list of bounded sections; an array of
    // scalars becomes a plain list. Neither becomes `[object Object]`.
    const counterpart = Array.isArray(other) ? other : undefined;
    return (
      <section className="snap-section" data-snap-change={mark}>
        <h4 className="snap-section__title">
          <span className="snap-section__name">{humaniseKey(name)}</span>
          <span className="snap-section__count">
            {value.length} {value.length === 1 ? "entry" : "entries"}
          </span>
          <ChangeMark kind={change} />
        </h4>
        {value.length === 0 ? (
          <p className="snap-empty">Not recorded</p>
        ) : (
          <ol className="snap-list">
            {value.map((item, index) => (
              <li key={index} className="snap-list__item">
                {isPlainObject(item) ? (
                  <SnapshotBody
                    data={item}
                    other={
                      counterpart && isPlainObject(counterpart[index])
                        ? (counterpart[index] as Record<string, unknown>)
                        : undefined
                    }
                    strict={Boolean(counterpart)}
                    depth={depth + 1}
                  />
                ) : (
                  <span className="snap-fact__text">{formatScalar(item)}</span>
                )}
              </li>
            ))}
          </ol>
        )}
      </section>
    );
  }

  if (isPlainObject(value)) {
    return (
      <section className="snap-section" data-snap-change={mark}>
        <h4 className="snap-section__title">
          <span className="snap-section__name">{humaniseKey(name)}</span>
          <ChangeMark kind={change} />
        </h4>
        <SnapshotBody
          data={value}
          other={isPlainObject(other) ? other : undefined}
          strict={isPlainObject(other)}
          depth={depth + 1}
        />
      </section>
    );
  }

  return <Fact name={name} value={value} change={change} />;
}

function SnapshotBody({
  data,
  other,
  strict,
  depth,
}: {
  data: Record<string, unknown>;
  other?: Record<string, unknown>;
  /**
   * `strict` means `other` is a COMPLETE counterpart of `data`, so a key on
   * one side only is genuinely added or removed. When false, `other` carries
   * only the fields that have an equivalent worth aligning, and every other
   * key stays unmarked rather than being reported as a difference that does
   * not exist.
   */
  strict: boolean;
  depth: number;
}) {
  const entries = Object.entries(data);
  // Scalars first as a facts grid, then nested structures — so the readable
  // summary is not pushed below a long list.
  const scalars = entries.filter(([, value]) => !isPlainObject(value) && !Array.isArray(value));
  const nested = entries.filter(([, value]) => isPlainObject(value) || Array.isArray(value));
  const absent = other ? Object.keys(other).filter((key) => !(key in data)) : [];
  const comparable = (key: string) => Boolean(other && (strict || key in other));

  const absentScalars = absent.filter(
    (key) => !isPlainObject(other?.[key]) && !Array.isArray(other?.[key]),
  );
  const absentNested = absent.filter(
    (key) => isPlainObject(other?.[key]) || Array.isArray(other?.[key]),
  );

  return (
    <div className="snap-body" data-snap-depth={depth}>
      {scalars.length > 0 || absentScalars.length > 0 ? (
        <dl className="snap-facts">
          {scalars.map(([key, value]) => (
            <Fact
              key={key}
              name={key}
              value={value}
              change={comparable(key) ? compareValues(value, other?.[key]) : undefined}
            />
          ))}
          {absentScalars.map((key) => (
            <Fact key={`absent-${key}`} name={key} value={other?.[key]} change="removed" />
          ))}
        </dl>
      ) : null}
      {nested.map(([key, value]) => (
        <Node
          key={key}
          name={key}
          value={value}
          other={other?.[key]}
          change={comparable(key) ? compareValues(value, other?.[key]) : undefined}
          depth={depth}
        />
      ))}
      {/* Present on the counterpart and absent here: shown so the difference
          is visible, with the counterpart's own content. */}
      {absentNested.map((key) => (
        <Node
          key={`absent-${key}`}
          name={key}
          value={other?.[key]}
          other={undefined}
          change="removed"
          depth={depth}
        />
      ))}
    </div>
  );
}

/**
 * The complete payload, verbatim, behind a disclosure. Full fidelity is kept:
 * the structured view above is a presentation, never a replacement.
 */
function RawSnapshot({ data }: { data: unknown }) {
  const json = useMemo(() => JSON.stringify(data, null, 2), [data]);
  const [copied, setCopied] = useState(false);

  return (
    <details className="snap-raw" data-snapshot-raw>
      <summary className="evd-disclosure-summary">View raw snapshot</summary>
      <div className="snap-raw__body">
        <button
          type="button"
          className="app-secondary-action snap-raw__copy"
          data-snapshot-copy
          onClick={() => {
            void navigator.clipboard?.writeText(json).then(
              () => {
                setCopied(true);
                setTimeout(() => setCopied(false), 2000);
              },
              () => setCopied(false),
            );
          }}
        >
          {copied ? "Copied" : "Copy JSON"}
        </button>
        {/* Bounded region: the raw payload scrolls inside its own box instead
            of stretching the card to whatever length the backend sent. */}
        <pre className="snap-raw__pre" dir="ltr">
          <code>{json}</code>
        </pre>
      </div>
    </details>
  );
}

export function StructuredSnapshot({
  name,
  data,
  compareWith,
  compareLabel,
}: {
  /** Identifies this snapshot for tests and styling hooks. */
  name: string;
  data: unknown;
  /**
   * The equivalent fields recorded by the other artifact. Only the keys it
   * carries are aligned and marked; everything else renders unmarked.
   */
  compareWith?: Record<string, unknown>;
  /** Names the artifact `compareWith` came from, for the legend. */
  compareLabel?: string;
}) {
  if (data === null || data === undefined) {
    return <p className="snap-empty">Not recorded</p>;
  }
  if (!isPlainObject(data)) {
    return (
      <dl className="snap-facts">
        <Fact name={name} value={data} />
      </dl>
    );
  }
  return (
    <div className="snap" data-structured-snapshot={name}>
      {compareWith && compareLabel ? (
        <p className="snap-legend" data-snapshot-legend>
          Marked fields differ from {compareLabel}. Unmarked fields match, or have no
          equivalent to compare.
        </p>
      ) : null}
      <SnapshotBody data={data} other={compareWith} strict={false} depth={0} />
      <RawSnapshot data={data} />
    </div>
  );
}
