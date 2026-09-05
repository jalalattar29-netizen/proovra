"use client";

/**
 * Platform Control Center (item I) — Global Search (/admin/search).
 *
 * READ-ONLY, platform-admin-only search across the core platform entities,
 * served by GET /v1/admin/search
 * (services/api/src/routes/admin-search.routes.ts).
 *
 * Honesty + safety rules enforced here:
 *   • Wrapped in <PageRouteGate routeId="platform.admin"> (belt-and-braces
 *     over the inherited admin/layout gate — this page must never render for
 *     a non-admin).
 *   • Min query length is enforced client-side (2 chars) — under that we
 *     render an honest "Enter at least 2 characters" prompt and make NO
 *     request. Zero matches render an honest "No matches" EmptyState.
 *   • Results are metadata/IDs/labels ONLY. The backend never returns a
 *     secret, token, password hash, evidence bytes, or hash-derived value;
 *     this page renders exactly what it receives (label/sublabel/href).
 *   • Errors flow ONLY through toSafeUserError. No raw error.message.
 *   • No legacy chrome (no app-hero / cc-page / btn- classes). Renders
 *     through the shared PageShell + AdminConsoleNav.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";

import {
  PageShell,
  PageHeader,
  FilterBar,
  useToast,
} from "../../../../components/ui";
import { Card } from "../../../../components/ui/Card";
import { Button } from "../../../../components/ui/Button";
import { Badge } from "../../../../components/ui/Badge";
import { EmptyState } from "../../../../components/ui/EmptyState";
import { PageRouteGate } from "../../../../components/navigation/PageRouteGate";
import { apiFetch } from "../../../../lib/api";
import { toSafeUserError } from "../../../../lib/feedback/toSafeUserError";

const MIN_QUERY_LENGTH = 2;

type SearchType =
  | "organization"
  | "user"
  | "team"
  | "demoRequest"
  | "contactSalesRequest"
  | "evidence"
  | "report"
  | "verificationPackage";

type SearchResult = {
  type: SearchType;
  id: string;
  label: string;
  sublabel: string | null;
  href: string;
};

type SearchGroup = {
  type: SearchType;
  results: SearchResult[];
};

type SearchResponse = {
  query: string;
  groups: SearchGroup[];
  /**
   * The SUM of the returned group lengths. Every group ran with its own
   * `take: perTypeLimit`, so when `truncated` is true this is a floor and
   * calling it "N matches" overstates what the server actually established.
   */
  total: number;
  perTypeLimit?: number;
  truncated?: boolean;
  truncatedGroups?: string[];
};

const TYPE_LABEL: Record<SearchType, string> = {
  organization: "Organization",
  user: "User",
  team: "Workspace",
  demoRequest: "Demo request",
  contactSalesRequest: "Contact sales",
  evidence: "Evidence",
  report: "Report",
  verificationPackage: "Verification package",
};

const TYPE_TONE: Record<
  SearchType,
  "verified" | "info" | "governance" | "pending" | "neutral"
> = {
  organization: "info",
  user: "governance",
  team: "info",
  demoRequest: "pending",
  contactSalesRequest: "pending",
  evidence: "verified",
  report: "neutral",
  verificationPackage: "neutral",
};

export default function AdminSearchPage() {
  const { addToast } = useToast();

  const [search, setSearch] = useState("");
  const [appliedSearch, setAppliedSearch] = useState("");
  const [loading, setLoading] = useState(false);
  const [groups, setGroups] = useState<SearchGroup[]>([]);
  const [total, setTotal] = useState(0);
  const [perTypeLimit, setPerTypeLimit] = useState<number | null>(null);
  /**
   * A REFUSED QUERY IS NOT AN EMPTY RESULT.
   *
   * A malformed identifier and a valid id that matches nothing produced the
   * same screen — "No results" — which told an operator who had pasted half
   * an id from a log that the record did not exist. The API now answers 400
   * INVALID_IDENTIFIER for the first case, and this state renders it as a
   * correction rather than as an absence.
   */
  const [validationMessage, setValidationMessage] = useState<string | null>(null);
  const [truncatedGroups, setTruncatedGroups] = useState<string[]>([]);
  const [hasSearched, setHasSearched] = useState(false);

  const tooShort = appliedSearch.trim().length < MIN_QUERY_LENGTH;

  const runSearch = useCallback(async () => {
    const q = appliedSearch.trim();
    if (q.length < MIN_QUERY_LENGTH) {
      setGroups([]);
      setTotal(0);
      setPerTypeLimit(null);
      setTruncatedGroups([]);
      return;
    }
    try {
      setLoading(true);
      setHasSearched(true);
      setValidationMessage(null);

      const params = new URLSearchParams();
      params.set("q", q);

      const data: SearchResponse = await apiFetch(
        `/v1/admin/search?${params.toString()}`,
      );

      const nextGroups = Array.isArray(data?.groups)
        ? data.groups.filter((g) => g.results.length > 0)
        : [];
      setGroups(nextGroups);
      setTotal(typeof data?.total === "number" ? data.total : 0);
      setPerTypeLimit(
        typeof data?.perTypeLimit === "number" ? data.perTypeLimit : null,
      );
      setTruncatedGroups(
        Array.isArray(data?.truncatedGroups) ? data.truncatedGroups : [],
      );
    } catch (err) {
      const code = (err as { code?: string } | null)?.code;
      const message = toSafeUserError(err, {
        message: "We couldn't run that search.",
      }).message;
      if (code === "INVALID_IDENTIFIER" || code === "validation_error") {
        /*
         * The query was understood and refused. Shown inline, next to the
         * box, rather than as a toast that disappears while the wrong term
         * stays on screen.
         *
         * The guidance is written HERE rather than passed through from the
         * server: `toSafeUserError` deliberately replaces server strings with
         * a generic line, and this client knows exactly what this code means.
         * Rendering "Please review your input and try again" for a truncated
         * id would tell the operator nothing they did not already know.
         */
        setValidationMessage(
          code === "INVALID_IDENTIFIER"
            ? "Identifier lookups need the complete value — there is no partial or prefix matching. Paste the whole id, or search by name or email instead."
            : message,
        );
      } else {
        addToast(message, "error");
      }
      setGroups([]);
      setTotal(0);
      setPerTypeLimit(null);
      setTruncatedGroups([]);
    } finally {
      setLoading(false);
    }
  }, [appliedSearch, addToast]);

  useEffect(() => {
    void runSearch();
  }, [runSearch]);

  const hasResults = useMemo(() => groups.length > 0, [groups]);

  return (
    <PageRouteGate routeId="platform.search">
      <PageShell
        header={
          <PageHeader
            eyebrow="Platform Control Center"
            title="Global search"
            subtitle="Read-only search across organizations, users, workspaces, demo & contact-sales requests, evidence, reports, and verification packages. Results are metadata and IDs only — no secrets, no evidence content."
          />
        }
          >

        <Card>
          <div
            data-testid="admin-search"
            style={{ display: "flex", flexDirection: "column", gap: 16 }}
          >
            <FilterBar
              actions={
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => setAppliedSearch(search)}
                  disabled={loading}
                >
                  {loading ? "Searching…" : "Search"}
                </Button>
              }
                >
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  setAppliedSearch(search);
                }}
                style={{ display: "contents" }}
              >
                <FilterBar.Search
                  label="Search platform entities"
                  value={search}
                  onChange={setSearch}
                  placeholder="Search by name, email, or a complete ID…"
                  onKeyDown={(e) => {
                    if (e.key === "Enter") setAppliedSearch(search);
                  }}
                />
              </form>
            </FilterBar>

            {tooShort ? (
              <EmptyState variant="inline"
                title="Enter at least 2 characters"
                purpose="Type a name, email, or a complete ID (minimum 2 characters) to search across platform entities. Only exact identifiers are matched — there is no partial or prefix matching. This search is read-only."
              />
            ) : validationMessage ? (
              /*
                A REFUSED QUERY, RENDERED AS A CORRECTION.

                Deliberately NOT the "No matches" state below: that one says
                the platform looked and found nothing, and this one says the
                platform did not look. An operator who pasted a truncated id
                needs to be told to paste the whole one, not to conclude the
                record is gone.
              */
              <EmptyState variant="inline"
                data-search-validation
                title="That is not a complete identifier"
                purpose={validationMessage}
              />
            ) : loading ? (
              <EmptyState variant="inline"
                title="Searching…"
                purpose="Running a bounded, read-only search across platform entities."
              />
            ) : !hasResults ? (
              <EmptyState variant="inline"
                title="No matches"
                purpose={
                  hasSearched
                    ? "No platform entities match this search. Try a different name or email; identifiers must be complete, and only exact matches are returned."
                    : "Enter a search above to begin."
                }
              />
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
                <div
                  style={{
                    fontSize: 13,
                    color: "var(--ink-secondary)",
                  }}
                >
                  {truncatedGroups.length > 0 ? "At least " : ""}
                  {total} match{total === 1 ? "" : "es"} across {groups.length}{" "}
                  categor{groups.length === 1 ? "y" : "ies"}
                  {truncatedGroups.length > 0 && perTypeLimit !== null ? (
                    <>
                      {" "}
                      — each category returns at most {perTypeLimit}, and{" "}
                      {truncatedGroups.length === 1
                        ? "one category"
                        : `${truncatedGroups.length} categories`}{" "}
                      hit that limit. Narrow the term to see the rest.
                    </>
                  ) : null}
                </div>

                {groups.map((group) => (
                  <section
                    key={group.type}
                    style={{ display: "flex", flexDirection: "column", gap: 8 }}
                  >
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 8,
                      }}
                    >
                      <Badge tone={TYPE_TONE[group.type]}>
                        {TYPE_LABEL[group.type]}
                      </Badge>
                      <span
                        style={{
                          fontSize: 12,
                          color: "var(--ink-muted)",
                        }}
                      >
                        {group.results.length} result
                        {group.results.length === 1 ? "" : "s"}
                        {truncatedGroups.includes(group.type) ? " (capped)" : ""}
                      </span>
                    </div>

                    <ul
                      style={{
                        listStyle: "none",
                        margin: 0,
                        padding: 0,
                        display: "flex",
                        flexDirection: "column",
                        gap: 6,
                      }}
                    >
                      {group.results.map((result) => (
                        <li key={`${result.type}:${result.id}`}>
                          <Link
                            href={result.href}
                            style={{
                              display: "flex",
                              alignItems: "center",
                              justifyContent: "space-between",
                              gap: 12,
                              padding: "10px 12px",
                              borderRadius: "var(--radius-md)",
                              border:
                                "1px solid var(--border-default)",
                              textDecoration: "none",
                              color: "var(--ink-primary)",
                            }}
                          >
                            <span style={{ minWidth: 0 }}>
                              <span
                                style={{
                                  display: "block",
                                  fontWeight: 600,
                                  overflow: "hidden",
                                  textOverflow: "ellipsis",
                                  whiteSpace: "nowrap",
                                }}
                              >
                                {result.label}
                              </span>
                              {result.sublabel ? (
                                <span
                                  style={{
                                    display: "block",
                                    fontSize: 12,
                                    color: "var(--ink-muted)",
                                    marginTop: 2,
                                  }}
                                >
                                  {result.sublabel}
                                </span>
                              ) : null}
                            </span>
                            <span
                              style={{
                                fontSize: 11,
                                fontFamily: "var(--font-mono)",
                                color: "var(--ink-muted)",
                                whiteSpace: "nowrap",
                              }}
                            >
                              {result.id}
                            </span>
                          </Link>
                        </li>
                      ))}
                    </ul>
                  </section>
                ))}
              </div>
            )}
          </div>
        </Card>
      </PageShell>
    </PageRouteGate>
  );
}
